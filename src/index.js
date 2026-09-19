function nanoid(size = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  const array = new Uint8Array(size);
  crypto.getRandomValues(array);
  for (let i = 0; i < size; i++) {
    id += chars[array[i] % chars.length];
  }
  return id;
}

function formatFileSize(bytes) {
  if (!bytes) return 'N/A';
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)}GB`;
}

const IPSW_USER_AGENT = 'EarlyNotify/1.0 (+https://earlynotify.com)';

// ---------------------------------------------------------------------------
// Scaling constants
//
// Sized against the Workers free tier (50 subrequests per invocation, 6
// simultaneous outgoing connections, 10 ms CPU) and the SES ceiling of 14
// emails/sec. Subrequest budgets, worst case:
//
//   child    1 KV read + 36 Lambda sends + 6 D1 batches      = 43
//   parent   ~5 KV/D1 + 6 queries + 32 children + 2 writes   = 45
//   refresh  ~6 KV/D1 + 30 ipsw fetches + 3 writes           = 39
//
// Throughput: 2 children in flight, each pacing 6 sends/sec, is 12/sec — held
// deliberately under 14/sec so SES never throttles us (a throttled send looks
// like a failure, gets retried next run, and turns into a duplicate email).
// ---------------------------------------------------------------------------
const EMAILS_PER_CHILD     = 36;       // 6 waves of 6
const MAX_CHILDREN_PER_RUN = 32;
const CHILD_CONCURRENCY    = 2;
const SEND_WAVE_SIZE       = 6;        // == free-tier concurrent connection cap
const SEND_WAVE_MIN_MS     = 1000;     // 6 sends/sec/child
const DISPATCH_DEADLINE_MS = 150_000;
const DISPATCH_LOCK_MS     = 300_000;
const SWEEP_INTERVAL_MS    = 3_600_000;
const MAX_FIRMWARE_FETCHES = 30;

// D1 allows 100 bound parameters per query and each device costs two (its id
// and its version), so the dispatch query is split into groups rather than
// built as one giant WHERE. At 50+ subscribed devices a single query throws,
// and because the throw unwinds before pending_devices is cleared, every
// subsequent tick would re-throw — a silent, permanent outage.
const DEVICES_PER_QUERY    = 40;       // 40*2 + 1 LIMIT = 81 bound params
const MAX_DEVICE_QUERIES   = 6;

const REFRESH_CRON  = '* * * * *';
const DISPATCH_CRON = '*/2 * * * *';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorizeInternal(request, env) {
  return Boolean(env.INTERNAL_SECRET)
    && timingSafeEqual(request.headers.get('x-internal-key') ?? '', env.INTERNAL_SECRET);
}

// Splitting the template once turns per-email rendering into string
// concatenation. replaceAll over a ~15 KB template 40 times was the only part
// of the child's work with a real claim on the 10 ms CPU budget.
function compileTemplate(raw) {
  const parts = raw.split(/\$\{(device|version|unsubscribeUrl)\}/);
  return vars => {
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      out += (i % 2 === 0) ? parts[i] : (vars[parts[i]] ?? '');
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Subscribed-device list  (NOTIFY KV key: 'subscribed_devices')
//
// SELECT DISTINCT device_id used to run every 60 s, scanning every active row —
// ~1.4M D1 row reads/day at 1,000 subscribers, and the single largest line item
// against D1's free read ceiling. The answer changes when someone subscribes to
// a device nobody had before, which is rare, so it caches for an hour and
// /subscribe invalidates it on a genuinely new device.
// ---------------------------------------------------------------------------
async function getSubscribedDevices(env) {
  const cached = await env.NOTIFY.get('subscribed_devices', { type: 'json' });
  if (cached) return cached;

  const { results } = await env.DB.prepare(
    'SELECT DISTINCT device_id FROM subscriptions WHERE active = 1'
  ).all();

  const ids = results.map(r => r.device_id);
  await env.NOTIFY.put('subscribed_devices', JSON.stringify(ids), { expirationTtl: 3600 });
  return ids;
}

// pending_devices lives in D1 rather than KV because KV is eventually
// consistent: a flag written by the refresher and read by dispatch seconds
// later can still read stale, and a missed read means a missed release. These
// are single-row reads/writes, so the D1 cost is negligible.
//
// Space-delimited, NOT comma-delimited: every Apple device identifier contains
// a comma (iPhone17,3 / Watch7,1), so a comma separator splits each id in half.
const PENDING_SEP = ' ';
const isValidDeviceId = id => typeof id === 'string' && id.length > 0 && !id.includes(PENDING_SEP);

function splitPending(raw) {
  return raw ? raw.split(PENDING_SEP).filter(Boolean) : [];
}

function appendPendingDevices(env, deviceIds) {
  const ids = deviceIds.filter(isValidDeviceId);
  if (ids.length === 0) return Promise.resolve();
  return env.DB.batch(ids.map(id =>
    env.DB.prepare(`
      UPDATE dispatch_state SET pending_devices = CASE
        WHEN pending_devices = '' THEN ?1
        WHEN ' ' || pending_devices || ' ' LIKE '% ' || ?1 || ' %' THEN pending_devices
        ELSE pending_devices || ' ' || ?1
      END WHERE id = 1
    `).bind(id)
  ));
}

// Subtractive so it cannot clobber a device the refresher appended mid-run.
function clearPendingDevices(env, deviceIds) {
  const ids = deviceIds.filter(isValidDeviceId);
  if (ids.length === 0) return Promise.resolve();
  return env.DB.batch(ids.map(id =>
    env.DB.prepare(`
      UPDATE dispatch_state
      SET pending_devices = TRIM(REPLACE(' ' || pending_devices || ' ', ' ' || ?1 || ' ', ' '))
      WHERE id = 1
    `).bind(id)
  ));
}

// ---------------------------------------------------------------------------
// Firmware cache  (D1 table: firmware_cache)
//
// Lives in D1 rather than KV because the free KV plan allows only 1,000 writes
// per day. Rewriting a single blob whenever any device went stale cost ~1,440
// writes/day on its own. Per-row upserts write only what actually changed, and
// D1's ceiling is 100,000 row-writes/day. See migrations/003_firmware_d1.sql.
// ---------------------------------------------------------------------------

function extractSlimEntry(ipswData) {
  const fw = ipswData?.firmwares?.[0] ?? {};
  return {
    fetchedAt:   Date.now(),
    version:     fw.version     ?? null,
    buildid:     fw.buildid     ?? null,
    releasedate: fw.releasedate ?? null,
    filesize:    fw.filesize    ?? null,
  };
}

async function fetchSlimFirmware(deviceId) {
  const data = await fetch(`https://api.ipsw.me/v4/device/${deviceId}?type=ipsw`, {
    headers: { 'User-Agent': IPSW_USER_AGENT },
  }).then(r => r.json());
  return extractSlimEntry(data);
}

// Whole table keyed by device id. At ~45 devices this is a trivial read, and it
// keeps callers working with the same shape the KV blob used to provide.
async function loadFirmwareCache(env) {
  const { results } = await env.DB.prepare(
    'SELECT device_id, fetched_at, version, buildid, releasedate, filesize FROM firmware_cache'
  ).all();

  const cache = {};
  for (const r of results) {
    cache[r.device_id] = {
      fetchedAt:   r.fetched_at,
      version:     r.version,
      buildid:     r.buildid,
      releasedate: r.releasedate,
      filesize:    r.filesize,
    };
  }
  return cache;
}

function saveFirmwareEntries(env, entries) {
  if (entries.length === 0) return Promise.resolve();
  return env.DB.batch(entries.map(([deviceId, e]) =>
    env.DB.prepare(`
      INSERT INTO firmware_cache (device_id, fetched_at, version, buildid, releasedate, filesize)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        fetched_at  = excluded.fetched_at,
        version     = excluded.version,
        buildid     = excluded.buildid,
        releasedate = excluded.releasedate,
        filesize    = excluded.filesize
    `).bind(deviceId, e.fetchedAt, e.version, e.buildid, e.releasedate, e.filesize)
  ));
}

// Returns one device's entry, fetching fresh if stale or absent. Read-only:
// only refreshFirmware persists, so request paths never write.
async function readFirmware(env, deviceId, ttlMs) {
  const row = await env.DB.prepare(
    'SELECT fetched_at, version, buildid, releasedate, filesize FROM firmware_cache WHERE device_id = ?'
  ).bind(deviceId).first();

  if (row && Date.now() - row.fetched_at < ttlMs) {
    return {
      fetchedAt:   row.fetched_at,
      version:     row.version,
      buildid:     row.buildid,
      releasedate: row.releasedate,
      filesize:    row.filesize,
    };
  }
  return fetchSlimFirmware(deviceId);
}

// ---------------------------------------------------------------------------
// Device name map  (NOTIFY KV key: 'device_names')
//
// dispatchNotifications only needs { [deviceId]: friendlyName }.
// Storing a slim name map avoids parsing the large device_list blob (~200 KB)
// on every 2-minute cron run. Refreshed at the same cadence as device_list
// (~1 write/day), so no meaningful impact on the KV write budget.
// ---------------------------------------------------------------------------

async function refreshDeviceNames(env) {
  const devices = await fetch('https://api.ipsw.me/v4/devices', {
    headers: { 'User-Agent': IPSW_USER_AGENT },
  }).then(r => r.json());

  const expirationTtl = env.DEVICE_LIST_CACHE * 60;
  const now = new Date().toISOString();

  // Ordered, not parallel. refreshFirmware retriggers this whenever
  // device_names is absent, so device_names must be written last — writing it
  // first would mark the refresh done even if device_list failed, and an empty
  // device_list makes /subscribe reject every signup until the TTL expires.
  await env.NOTIFY.put('device_list',
    JSON.stringify({ fetchedAt: now, devices }),
    { expirationTtl }
  );
  await env.NOTIFY.put('device_names',
    JSON.stringify(Object.fromEntries(devices.map(d => [d.identifier, d.name]))),
    { expirationTtl }
  );

  return devices;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -----------------------------------------------------------------------
    // GET /newest_ios
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/newest_ios') {
      const TARGET_DEVICE = 'iPhone17,3'; // iPhone 16
      const jsonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://earlynotify.com',
        'Cache-Control': 'public, max-age=300',
      };

      try {
        const entry = await readFirmware(env, TARGET_DEVICE, env.KV_CACHE_INVALID * 60 * 1000);

        if (!entry?.version) {
          return new Response(
            JSON.stringify({ error: 'No firmware data available', ios: 'N/A', build: 'N/A', size: 'N/A' }),
            { headers: jsonHeaders, status: 404 }
          );
        }

        return new Response(JSON.stringify({
          ios:         entry.version,
          build:       entry.buildid     ?? 'N/A',
          releasedate: entry.releasedate ?? 'N/A',
          size:        formatFileSize(entry.filesize),
        }), { headers: jsonHeaders });

      } catch (error) {
        console.error('Error in /newest_ios:', error);
        return new Response(
          JSON.stringify({ error: 'Internal server error', ios: 'N/A', build: 'N/A', size: 'N/A' }),
          { headers: jsonHeaders, status: 500 }
        );
      }
    }

    // -----------------------------------------------------------------------
    // GET /
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/') {
      return Response.redirect(env.SITE_URL, 301);
    }

    // -----------------------------------------------------------------------
    // GET /stats
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/stats') {
      const jsonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://earlynotify.com',
        'Cache-Control': 'public, max-age=900',
      };

      try {
        const cached = await env.NOTIFY.get('stats_cache', { type: 'json' });
        if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < 15 * 60 * 1000) {
          return new Response(JSON.stringify({ subscribers: cached.count }), { headers: jsonHeaders });
        }

        const { results } = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM subscriptions WHERE active = 1'
        ).all();

        const count = results[0]?.count ?? 0;
        await env.NOTIFY.put('stats_cache',
          JSON.stringify({ count, fetchedAt: new Date().toISOString() }),
          { expirationTtl: 1800 }
        );

        return new Response(JSON.stringify({ subscribers: count }), { headers: jsonHeaders });
      } catch (error) {
        console.error('Error in /stats:', error);
        return new Response(
          JSON.stringify({ error: 'Unable to fetch stats' }),
          { headers: jsonHeaders, status: 500 }
        );
      }
    }

    // -----------------------------------------------------------------------
    // GET /devices
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/devices') {
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };

      const grouped = {};
      for (const d of parsed.devices) {
        let type = d.identifier.split(',')[0]
          .replace(/\d+/g, '')
          .replace('Watch', 'Apple Watch')
          .replace('AudioAccessory', 'HomePod')
          .replace('RealityDevice', 'Vision Pro');

        if (['Macmini', 'iMac', 'VirtualMac', 'MacBookAir', 'MacBookPro'].includes(type)) {
          type = 'Mac';
        }

        if (!grouped[type]) grouped[type] = [];
        grouped[type].push({ name: d.name, id: d.identifier });
      }

      return new Response(JSON.stringify(grouped), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://earlynotify.com',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    // -----------------------------------------------------------------------
    // GET /unsubscribe  (confirmation page)
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/unsubscribe') {
      const token = url.searchParams.get('token');
      if (!token) {
        return new Response(unsubscribeErrorPage('No unsubscribe token provided.'), {
          status: 400, headers: { 'Content-Type': 'text/html' },
        });
      }

      const { results } = await env.DB.prepare(
        'SELECT device_id FROM subscriptions WHERE unsubscribe_token = ? AND active = 1'
      ).bind(token).all();

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'),
          { status: 404, headers: { 'Content-Type': 'text/html' } }
        );
      }

      const deviceId = results[0].device_id;
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
      const friendlyName = parsed.devices.find(d => d.identifier === deviceId)?.name ?? deviceId;

      return new Response(unsubscribeConfirmPage(token, friendlyName, env.SITE_URL), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // -----------------------------------------------------------------------
    // POST /unsubscribe
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const formData = await request.formData();
      const token = formData.get('token');
      if (!token) {
        return new Response(unsubscribeErrorPage('No unsubscribe token provided.'), {
          status: 400, headers: { 'Content-Type': 'text/html' },
        });
      }

      const { results } = await env.DB.prepare(`
        UPDATE subscriptions SET active = 0, unsubscribe_token = NULL
        WHERE unsubscribe_token = ? AND active = 1
        RETURNING email, device_id
      `).bind(token).all();

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'),
          { status: 404, headers: { 'Content-Type': 'text/html' } }
        );
      }

      const { email, device_id: deviceId } = results[0];

      if (email && deviceId) {
        const deviceData = await env.NOTIFY.get('device_list');
        const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
        const friendlyName = parsed.devices.find(d => d.identifier === deviceId)?.name ?? deviceId;

        try {
          await sendEmailLambda(env, email, friendlyName, 'N/A', token, 'unsubscribe');
        } catch (err) {
          console.error(`Unsubscribe confirmation email failed for ${email}:`, err);
        }

        return new Response(unsubscribeSuccessPage(friendlyName, env.SITE_URL), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return new Response(unsubscribeSuccessPage('your device', env.SITE_URL), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // -----------------------------------------------------------------------
    // OPTIONS /subscribe  (CORS preflight)
    // -----------------------------------------------------------------------
    if (request.method === 'OPTIONS' && url.pathname === '/subscribe') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': 'https://earlynotify.com',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // -----------------------------------------------------------------------
    // POST /subscribe
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const formData = await request.formData();
      const email = formData.get('email')?.toLowerCase().trim();
      const device = formData.get('device');
      const hcaptchaToken = formData.get('h-captcha-response');

      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://earlynotify.com',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST',
      };

      if (!email || !device) {
        return new Response(JSON.stringify({ error: 'Missing email or device' }), { status: 400, headers });
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ error: 'Invalid email format' }), { status: 400, headers });
      }
      if (!hcaptchaToken) {
        return new Response(JSON.stringify({ error: 'Captcha token missing' }), { status: 400, headers });
      }

      // Run independent I/O in parallel: device list and captcha
      const [deviceListRaw, hcaptchaRes] = await Promise.all([
        env.NOTIFY.get('device_list'),
        fetch('https://hcaptcha.com/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: env.HCAPTCHA_SECRET, response: hcaptchaToken }),
        }).then(r => r.json()),
      ]);

      // Captcha first: rejecting on device before verifying the captcha turns
      // /subscribe into a free oracle for which device identifiers are valid.
      if (!hcaptchaRes.success) {
        return new Response(JSON.stringify({ error: 'Captcha verification failed' }), { status: 403, headers });
      }

      const deviceList = deviceListRaw ? JSON.parse(deviceListRaw).devices : [];
      const knownDevice = deviceList.find(d => d.identifier === device);
      if (!knownDevice) {
        return new Response(JSON.stringify({ error: 'Unknown device' }), { status: 400, headers });
      }

      const entry = await readFirmware(env, device, env.KV_CACHE_INVALID * 60 * 1000);

      const latestVersion = entry?.version ?? null;
      const unsubscribeToken = nanoid();
      const friendlyName = knownDevice.name || device;

      await env.DB.prepare(`
        INSERT INTO subscriptions (email, device_id, subscribed_at, active, unsubscribe_token, last_notified_version)
        VALUES (?, ?, datetime('now'), 1, ?, ?)
        ON CONFLICT(email, device_id) DO UPDATE SET
          active = 1,
          unsubscribe_token = excluded.unsubscribe_token,
          last_notified_version = excluded.last_notified_version;
      `).bind(email, device, unsubscribeToken, latestVersion).run();

      if (latestVersion) {
        try {
          await sendEmailLambda(env, email, friendlyName, latestVersion, unsubscribeToken, 'version');
        } catch (err) {
          console.error(`Welcome email failed for ${email}:`, err);
          await env.DB.prepare(
            'UPDATE subscriptions SET last_notified_version = NULL WHERE email = ? AND device_id = ?'
          ).bind(email, device).run();
        }
      }

      // First subscriber for this device — drop the cached list so the
      // refresher starts polling it rather than waiting out the hour TTL.
      const knownDevices = await env.NOTIFY.get('subscribed_devices', { type: 'json' });
      if (knownDevices && !knownDevices.includes(device)) {
        await env.NOTIFY.delete('subscribed_devices');
      }

      return new Response(JSON.stringify({ message: 'Subscription successful!' }), { headers });
    }

    // -----------------------------------------------------------------------
    // POST /internal/send  (fan-out target — called only by dispatch)
    //
    // The point of this endpoint is the fresh invocation: its own 10 ms CPU and
    // its own 50 subrequests, so the coordinator is no longer capped at what a
    // single invocation can send.
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/internal/send') {
      if (!authorizeInternal(request, env)) return new Response('Forbidden', { status: 403 });

      const { batch } = await request.json();
      if (!Array.isArray(batch) || batch.length === 0) {
        return new Response(JSON.stringify({ sent: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (batch.length > EMAILS_PER_CHILD) {
        return new Response('Batch too large', { status: 400 });
      }

      const rawTemplate = await env.NOTIFY.get('email_version');
      if (!rawTemplate) return new Response('Template email_version not found', { status: 500 });
      const render = compileTemplate(rawTemplate);

      let sent = 0;

      // Waves of 6 because that is the free tier's simultaneous-connection cap;
      // anything above it queues rather than parallelises. The floor on wave
      // duration is what holds us at 6 sends/sec/child.
      for (let i = 0; i < batch.length; i += SEND_WAVE_SIZE) {
        const wave      = batch.slice(i, i + SEND_WAVE_SIZE);
        const waveStart = Date.now();

        const results = await Promise.allSettled(wave.map(n => sendEmail(
          env,
          n.email,
          `Software Version ${n.version} now available for ${n.friendlyName}`,
          render({
            device:         n.friendlyName,
            version:        n.version,
            unsubscribeUrl: `${env.API_SITE_URL}/unsubscribe?token=${n.unsubscribeToken}`,
          })
        )));

        const succeeded = [];
        results.forEach((r, j) => {
          if (r.status === 'fulfilled') succeeded.push(wave[j]);
          else console.error(`Failed to send to ${wave[j].email}:`, r.reason);
        });

        // Committed per wave, not once at the end: these messages have already
        // left SES, so if the child dies before recording them the sweep resends
        // every uncommitted one. Per-wave bounds that blast radius to 6.
        if (succeeded.length > 0) {
          await env.DB.batch(succeeded.map(n =>
            env.DB.prepare(
              'UPDATE subscriptions SET last_notified_version = ? WHERE email = ? AND device_id = ?'
            ).bind(n.version, n.email, n.deviceId)
          ));
          sent += succeeded.length;
        }

        // Every wave is floored, including the last. Skipping the final sleep
        // looks like a harmless optimisation but it is not: the parent starts
        // the next child the instant this one returns, so a child that returns
        // early raises the aggregate rate. With the floor applied uniformly a
        // child takes batch.length/6 seconds, pinning it to 6 sends/sec.
        const elapsed = Date.now() - waveStart;
        if (elapsed < SEND_WAVE_MIN_MS) await sleep(SEND_WAVE_MIN_MS - elapsed);
      }

      return new Response(JSON.stringify({ sent, total: batch.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // -----------------------------------------------------------------------
    // POST /internal/bounce
    //
    // Call this from the Lambda side, subscribed to the SES bounce/complaint
    // SNS topic. Without suppression a typo'd address hard-bounces on every
    // release forever; SES puts an account under review past ~5% bounce rate.
    //
    // Deliberately not wired straight to SNS: verifying an SNS signature needs
    // cert fetch plus RSA verify, and an unverified endpoint that can
    // deactivate arbitrary subscribers is worse than the extra hop.
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/internal/bounce') {
      if (!authorizeInternal(request, env)) return new Response('Forbidden', { status: 403 });

      const { email, reason } = await request.json();
      if (!email) return new Response('Missing email', { status: 400 });

      const { meta } = await env.DB.prepare(`
        UPDATE subscriptions SET active = 0, unsubscribe_token = NULL, deactivated_reason = ?
        WHERE email = ? AND active = 1
      `).bind(String(reason ?? 'bounce').slice(0, 100), email.toLowerCase().trim()).run();

      console.log(`Suppressed ${meta?.changes ?? 0} subscription(s) for ${email}: ${reason}`);
      return new Response(JSON.stringify({ suppressed: meta?.changes ?? 0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  // -------------------------------------------------------------------------
  // Scheduled handlers
  // ctx.waitUntil() tells the runtime to keep the isolate alive for the full
  // async chain — without it, the invocation can be cut short before awaits
  // beyond the first one complete.
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx) {
    if (event.cron === REFRESH_CRON) {
      ctx.waitUntil(refreshFirmware(env));
    } else if (event.cron === DISPATCH_CRON) {
      ctx.waitUntil(dispatchNotifications(env));
    } else {
      // Refresh and dispatch cannot share one invocation — their subrequest
      // budgets add up to well over the free tier's 50 — so an unrecognised
      // trigger is a misconfiguration, not something to guess at.
      console.error(
        `Unrecognised cron "${event.cron}". Configure exactly: ` +
        `"${REFRESH_CRON}" (poll firmware) and "${DISPATCH_CRON}" (send). Nothing ran.`
      );
    }
  },
};

// -----------------------------------------------------------------------------
// refreshFirmware — runs every 1 min (`* * * * *`)
//
// Keeps firmware_cache warm and device_names fresh, and records which devices
// changed version so dispatch has something to act on. Writes only the rows it
// actually refetched — roughly 3 a minute, against D1's 100k/day ceiling.
// -----------------------------------------------------------------------------
async function refreshFirmware(env) {
  const [cache, deviceNamesRaw, subscribedDevices] = await Promise.all([
    loadFirmwareCache(env),
    env.NOTIFY.get('device_names'),
    getSubscribedDevices(env),
  ]);

  const ttlMs = env.KV_CACHE_INVALID * 60 * 1000;
  const now   = Date.now();

  // device_names uses KV TTL for expiry — if the key is missing it has expired.
  // Refresh it here (2 KV writes, ~1/day) rather than in the hot dispatch path.
  if (!deviceNamesRaw) {
    await refreshDeviceNames(env).catch(err =>
      console.error('Failed to refresh device names:', err)
    );
  }

  const staleDevices = subscribedDevices
    .filter(id => {
      const e = cache[id];
      return !e || now - e.fetchedAt >= ttlMs;
    })
    .sort((a, b) => (cache[a]?.fetchedAt ?? 0) - (cache[b]?.fetchedAt ?? 0))
    .slice(0, MAX_FIRMWARE_FETCHES);

  if (staleDevices.length === 0) return;

  const results = await Promise.allSettled(staleDevices.map(id => fetchSlimFirmware(id)));

  const fetched = [];
  const changed = [];

  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') {
      console.error(`Failed to fetch firmware for ${staleDevices[i]}:`, r.reason);
      return;
    }
    const id   = staleDevices[i];
    const prev = cache[id]?.version ?? null;
    fetched.push([id, r.value]);

    // Flagging a cold entry (prev === null) as changed is safe: dispatch still
    // gates every send on last_notified_version, so an already-current
    // subscriber gets nothing. It just costs one query, and it means a cache
    // that expired during an outage still catches up.
    if (r.value.version && r.value.version !== prev) changed.push(id);
  });

  await saveFirmwareEntries(env, fetched);

  if (changed.length > 0) {
    console.log(`Firmware changed for: ${changed.join(', ')}`);
    await appendPendingDevices(env, changed);
  }
}

// -----------------------------------------------------------------------------
// dispatchNotifications — runs every 2 min (`*/2 * * * *`)
//
// Acts as a coordinator: it works out who needs an email, then hands batches to
// /internal/send. Each of those is a fresh invocation with its own 10 ms CPU and
// 50-subrequest budget, which is what lifts the old 35-emails-per-run ceiling.
//
// On a quiet tick — which is almost all of them — this costs exactly one
// single-row D1 read and returns. The old version read every active row every
// two minutes just to discover nothing had changed.
// -----------------------------------------------------------------------------
async function dispatchNotifications(env) {
  const now = Date.now();

  const state = await env.DB.prepare(
    'SELECT locked_until, pending_devices, last_sweep_at FROM dispatch_state WHERE id = 1'
  ).first();

  if (!state) {
    console.error('dispatch_state row missing — run migrations/002_scale.sql');
    return;
  }
  if (!env.INTERNAL_SECRET) {
    console.error('INTERNAL_SECRET not set — cannot fan out; run `wrangler secret put INTERNAL_SECRET`');
    return;
  }
  if (state.locked_until > now) return; // a previous run is still going

  const sweepDue = now - state.last_sweep_at >= SWEEP_INTERVAL_MS;
  const flagged  = splitPending(state.pending_devices);

  // The sweep is not optional housekeeping — it is the backstop for anything
  // the change-detection path misses: a welcome email that failed at signup
  // (which resets last_notified_version to NULL), a refresher that died between
  // writing firmware_cache and recording the change, a bad deploy.
  const devices = sweepDue
    ? [...new Set([...flagged, ...await getSubscribedDevices(env)])]
    : flagged;
  if (devices.length === 0) return;

  // Claim the run. Single statement, so it is atomic even if the 1-min and
  // 2-min crons land on the same second.
  const claimed = await env.DB.prepare(
    'UPDATE dispatch_state SET locked_until = ?1 WHERE id = 1 AND locked_until < ?2 RETURNING id'
  ).bind(now + DISPATCH_LOCK_MS, now).first();
  if (!claimed) return;

  try {
    await runDispatch(env, devices, flagged, now);
  } finally {
    await (sweepDue
      ? env.DB.prepare('UPDATE dispatch_state SET locked_until = 0, last_sweep_at = ?1 WHERE id = 1').bind(now)
      : env.DB.prepare('UPDATE dispatch_state SET locked_until = 0 WHERE id = 1')
    ).run();
  }
}

async function runDispatch(env, devices, flagged, startedAt) {
  const [cache, deviceNamesRaw] = await Promise.all([
    loadFirmwareCache(env),
    env.NOTIFY.get('device_names'),
  ]);

  const nameMap = deviceNamesRaw ? JSON.parse(deviceNamesRaw) : {};

  const targets = devices
    .map(id => ({ deviceId: id, version: cache[id]?.version }))
    .filter(t => t.version);
  if (targets.length === 0) {
    await clearPendingDevices(env, flagged);
    return;
  }

  // Filtering on version in SQL rather than JS matters on the second and later
  // ticks of a large release: without it every tick re-reads the whole set and
  // discards the ones already sent.
  const rowCap = EMAILS_PER_CHILD * MAX_CHILDREN_PER_RUN;
  const groups = [];
  for (let i = 0; i < targets.length; i += DEVICES_PER_QUERY) {
    groups.push(targets.slice(i, i + DEVICES_PER_QUERY));
  }
  const queried = groups.slice(0, MAX_DEVICE_QUERIES);

  const rows = [];
  for (const group of queried) {
    if (rows.length >= rowCap) break;
    const clauses = [];
    const binds   = [];
    for (const t of group) {
      clauses.push('(device_id = ? AND (last_notified_version IS NULL OR last_notified_version <> ?))');
      binds.push(t.deviceId, t.version);
    }
    binds.push(rowCap - rows.length);

    const { results } = await env.DB.prepare(`
      SELECT email, device_id, unsubscribe_token
      FROM subscriptions
      WHERE active = 1 AND (${clauses.join(' OR ')})
      LIMIT ?
    `).bind(...binds).all();
    rows.push(...results);
  }

  // False if we stopped early on either cap, in which case the flag must
  // survive so the next tick finishes the job.
  const sawEverything = queried.length === groups.length && rows.length < rowCap;

  if (rows.length === 0) {
    if (sawEverything) await clearPendingDevices(env, flagged);
    return;
  }

  const versionFor = Object.fromEntries(targets.map(t => [t.deviceId, t.version]));
  const pending = rows.map(row => ({
    email:            row.email,
    deviceId:         row.device_id,
    friendlyName:     nameMap[row.device_id] ?? row.device_id,
    version:          versionFor[row.device_id],
    unsubscribeToken: row.unsubscribe_token,
  }));

  const chunks = [];
  for (let i = 0; i < pending.length; i += EMAILS_PER_CHILD) {
    chunks.push(pending.slice(i, i + EMAILS_PER_CHILD));
  }

  console.log(`Dispatching ${pending.length} emails across ${chunks.length} batches`);

  let sent = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length && Date.now() - startedAt < DISPATCH_DEADLINE_MS) {
      const chunk = chunks[next++];
      try {
        const res = await fetch(`${env.API_SITE_URL}/internal/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-key': env.INTERNAL_SECRET },
          body: JSON.stringify({ batch: chunk }),
        });
        if (!res.ok) throw new Error(`child returned ${res.status}: ${await res.text()}`);
        sent += (await res.json()).sent ?? 0;
      } catch (err) {
        console.error('Send batch failed:', err);
      }
    }
  };
  await Promise.all(Array.from({ length: CHILD_CONCURRENCY }, worker));

  const drained = next >= chunks.length && sawEverything;
  console.log(`Dispatch sent ${sent}/${pending.length}${drained ? '' : ' (more queued for next run)'}`);

  // Clearing is keyed on every chunk having been *attempted*, not on every send
  // having succeeded. Individual failures keep their old last_notified_version
  // and get picked up by the hourly sweep. Retrying them on the next 2-minute
  // tick instead would mean hammering a permanently-failing address 30x an
  // hour, which is exactly how a sender reputation gets destroyed.
  if (drained) await clearPendingDevices(env, flagged);
}

// -----------------------------------------------------------------------------
// Email
// -----------------------------------------------------------------------------
async function sendEmailLambda(env, to, device, version, unsubscribeToken, messageType, templates = {}) {
  const unsubscribeUrl = `${env.API_SITE_URL}/unsubscribe?token=${unsubscribeToken}`;

  let subject, templateKey;
  switch (messageType) {
    case 'version':
      subject     = `Software Version ${version} now available for ${device}`;
      templateKey = 'email_version';
      break;
    case 'unsubscribe':
      subject     = 'You have unsubscribed';
      templateKey = 'email_unsubscribe';
      break;
    default:
      subject     = 'iOS Update Notification';
      templateKey = 'email_version';
  }

  const rawTemplate = templates[templateKey] ?? await env.NOTIFY.get(templateKey);
  if (!rawTemplate) throw new Error(`Template ${templateKey} not found`);

  const emailBody = rawTemplate
    .replaceAll('${device}', device)
    .replaceAll('${version}', version)
    .replaceAll('${unsubscribeUrl}', unsubscribeUrl);

  await sendEmail(env, to, subject, emailBody);
}

async function sendEmail(env, to, subject, body) {
  const res = await fetch(env.LAMBDA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.LAMBDA_API_KEY },
    body: JSON.stringify({ to, subject, message: body }),
  });

  if (!res.ok) throw new Error(`Lambda returned ${res.status}: ${await res.text()}`);
}

// -----------------------------------------------------------------------------
// HTML helpers (unchanged)
// -----------------------------------------------------------------------------
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unsubscribeShell(title, bodyHtml, siteUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} – EarlyNotify</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 50%, #bae6fd 100%);
      background-attachment: fixed;
      color: #0f172a;
    }
    .card {
      background: rgba(255,255,255,0.75);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(6,182,212,0.2);
      border-radius: 24px;
      padding: 3rem 2.5rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0,0,0,0.08), 0 0 0 1px rgba(255,255,255,0.5);
    }
    .icon {
      width: 64px; height: 64px;
      border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.5rem;
      font-size: 2rem;
    }
    h1 { font-size: 1.6rem; font-weight: 700; margin-bottom: 0.75rem; }
    p { color: #475569; line-height: 1.6; margin-bottom: 1rem; }
    .device { font-weight: 600; color: #0f172a; }
    .btn {
      display: inline-block;
      padding: 0.875rem 2rem;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: all 0.2s ease;
      border: none;
      width: 100%;
      margin-top: 0.5rem;
    }
    .btn-danger {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: white;
      box-shadow: 0 4px 15px rgba(239,68,68,0.3);
    }
    .btn-danger:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(239,68,68,0.35); }
    .btn-ghost {
      background: rgba(255,255,255,0.6);
      color: #475569;
      border: 1px solid rgba(6,182,212,0.25);
      margin-top: 0.75rem;
    }
    .btn-ghost:hover { background: rgba(255,255,255,0.9); color: #0f172a; }
    .btn-primary {
      background: linear-gradient(135deg, #06B6D4, #0891B2);
      color: white;
      box-shadow: 0 4px 15px rgba(6,182,212,0.3);
    }
    .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 8px 25px rgba(6,182,212,0.35); }
    .logo { font-size: 1rem; font-weight: 700; color: #94a3b8; margin-bottom: 2rem; display: block; }
  </style>
</head>
<body>
  <div class="card">
    <a href="${siteUrl || 'https://earlynotify.com'}" class="logo">EarlyNotify</a>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function unsubscribeConfirmPage(token, deviceName, siteUrl) {
  const safe      = escapeHtml(deviceName);
  const safeToken = escapeHtml(token);
  const body = `
    <div class="icon" style="background: rgba(239,68,68,0.1);">🔕</div>
    <h1>Unsubscribe?</h1>
    <p>You're about to stop receiving update alerts for your <span class="device">${safe}</span>.</p>
    <p>If you clicked this link by accident, just close this page — nothing has changed.</p>
    <form method="POST" action="/unsubscribe">
      <input type="hidden" name="token" value="${safeToken}">
      <button type="submit" class="btn btn-danger">Yes, unsubscribe me</button>
    </form>
    <a href="${siteUrl || 'https://earlynotify.com'}" class="btn btn-ghost">Keep my subscription</a>
  `;
  return unsubscribeShell('Confirm Unsubscribe', body, siteUrl);
}

function unsubscribeSuccessPage(deviceName, siteUrl) {
  const safe = escapeHtml(deviceName);
  const body = `
    <div class="icon" style="background: rgba(74,222,128,0.1);">✓</div>
    <h1>You're unsubscribed</h1>
    <p>You'll no longer receive update alerts for your <span class="device">${safe}</span>.</p>
    <p>Changed your mind? You can always re-subscribe on the homepage.</p>
    <a href="${siteUrl || 'https://earlynotify.com'}" class="btn btn-primary">Back to EarlyNotify</a>
  `;
  return unsubscribeShell('Unsubscribed', body, siteUrl);
}

function unsubscribeErrorPage(message) {
  const body = `
    <div class="icon" style="background: rgba(251,191,36,0.1);">⚠️</div>
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
    <a href="https://earlynotify.com" class="btn btn-primary">Back to EarlyNotify</a>
  `;
  return unsubscribeShell('Error', body, 'https://earlynotify.com');
}
