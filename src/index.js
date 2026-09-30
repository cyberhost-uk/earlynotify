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
//   parent   ~5 KV/D1 + 6 queries + 31 children + 2 writes   = 44
//   refresh  ~6 KV/D1 + 30 ipsw fetches + 3 writes           = 39
//
// Throughput: one child in flight, pacing 6 sends/sec. Children are reached via
// the SELF service binding, and service-bound invocations share the top-level
// request's 6-connection cap — a second concurrent child would not double the
// rate, its waves would just queue behind the first's. 6/sec is also well under
// SES's 14/sec, so a send is never throttled (a throttled send looks like a
// failure, gets retried next run, and turns into a duplicate email). At 6/sec
// the 150 s deadline covers ~900 emails per run; the rest go on the next tick.
// ---------------------------------------------------------------------------
const EMAILS_PER_CHILD     = 36;       // 6 waves of 6
// 31, not 32: a request chain is capped at 32 Worker invocations and the
// coordinator is one of them, so the 32nd child call would throw.
const MAX_CHILDREN_PER_RUN = 31;
const CHILD_CONCURRENCY    = 1;
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

// Double opt-in. One confirmation covers every device a destination signs up
// for within the resend window, which also caps how often a stream of captcha
// solves can make us message the same inbox or channel.
const CONFIRM_TTL_MS      = 48 * 3_600_000;
const CONFIRM_RESEND_MS   = 15 * 60_000;

// A webhook that hangs holds up its whole wave, and so every other subscriber
// in the batch, so each delivery gets a hard ceiling.
const DELIVERY_TIMEOUT_MS = 5_000;

// A non-email destination that fails this many sends in a row — timeouts, 5xx,
// refused connections — is switched off like a deleted one. A failed send
// clears its device's flag like any other attempt, so the retries after the
// first come from the hourly sweep: 30 is roughly a day and a half of the
// endpoint failing every time. Email is exempt, since its failures are our
// Lambda or SES, not the subscriber; bounces cover bad addresses.
const MAX_CONSECUTIVE_FAILURES = 30;

// /internal/send is only ever reached through the SELF binding, whose requests
// carry this made-up hostname. Public traffic arrives on the Worker's real
// hostnames, so checking it shuts the endpoint to the internet even if
// INTERNAL_SECRET leaks. /internal/bounce can't do the same — the Lambda calls
// it over the public URL.
const INTERNAL_HOST = 'internal';

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
//
// Values are escaped: device names and versions come from ipsw.me, which is not
// ours to trust with markup in our emails.
function compileTemplate(raw) {
  const parts = raw.split(/\$\{(device|version|unsubscribeUrl|confirmUrl)\}/);
  return vars => {
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      out += (i % 2 === 0) ? parts[i] : escapeHtml(vars[parts[i]] ?? '');
    }
    return out;
  };
}

async function loadTemplate(env, key) {
  const raw = await env.NOTIFY.get(key);
  if (!raw) throw new Error(`Template ${key} not found`);
  return compileTemplate(raw);
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

// Slim { [deviceId]: friendlyName } map, rather than parsing device_list.
async function deviceNames(env) {
  return (await env.NOTIFY.get('device_names', { type: 'json' })) ?? {};
}

// ---------------------------------------------------------------------------
// Channels
//
// A subscription's destination is an email address, a webhook URL, or for
// Pushover `userKey:appToken`, depending on its channel. Chat webhook URLs and
// Pushover app tokens are credentials, so they never reach the logs; see
// describeDestination.
// ---------------------------------------------------------------------------
const CHANNELS = ['email', 'discord', 'slack', 'teams', 'pushover', 'webhook'];

// Channels that skip double opt-in. Each destination is itself a credential:
// whoever holds a chat webhook URL can already post to that channel, and
// whoever holds a Pushover app token can already message any user key, so a
// confirmation step would prove nothing they couldn't do without us. Email and
// generic webhooks name a destination anyone can type, so they still confirm.
const INSTANT_CHANNELS = new Set(['discord', 'slack', 'teams', 'pushover']);

const CHAT_WEBHOOKS = {
  discord: {
    host: h => ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(h),
    path: '/api/webhooks/',
  },
  slack: {
    host: h => h === 'hooks.slack.com',
    path: '/services/',
  },
  // Legacy Office 365 connectors, and the Power Automate "Workflows" webhooks
  // Microsoft is replacing them with. Both accept an Adaptive Card message.
  teams: {
    host: h => ['.webhook.office.com', '.logic.azure.com', '.powerplatform.com'].some(s => h.endsWith(s)),
    path: '/',
  },
};

const DESTINATION_ERROR = {
  email:    'Invalid email address',
  discord:  'That is not a Discord webhook URL',
  slack:    'That is not a Slack incoming webhook URL',
  teams:    'That is not a Microsoft Teams webhook URL',
  pushover: 'Invalid Pushover user key or application token',
  webhook:  'Webhook URL must be a public https:// address',
};

// Returned whatever actually happened — see /subscribe.
const ACCEPTED_MESSAGE = {
  email:    'Check your inbox for a confirmation link.',
  discord:  'Subscribed! The current version will be posted to your channel shortly.',
  slack:    'Subscribed! The current version will be posted to your channel shortly.',
  teams:    'Subscribed! The current version will be posted to your channel shortly.',
  pushover: 'Subscribed! The current version will be sent to your devices shortly.',
  webhook:  'We sent a subscription.confirm event with a confirmation link to your endpoint.',
};

// Returns the canonical destination, or null if it isn't valid for the channel.
function normalizeDestination(channel, raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();

  if (channel === 'email') {
    const email = value.toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }
  if (channel === 'pushover') {
    return /^[A-Za-z0-9]{30}:[A-Za-z0-9]{30}$/.test(value) ? value : null;
  }

  if (value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  // Default port only: a URL that names a port is a probe, not a webhook.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (channel === 'webhook') return isPublicHostname(host) ? url.toString() : null;

  const rule = CHAT_WEBHOOKS[channel];
  return rule && rule.host(host) && url.pathname.startsWith(rule.path) ? url.toString() : null;
}

// Keeps IP literals and internal-looking names out of generic webhooks. Paired
// with redirect: 'manual' on delivery, so an accepted URL can't bounce the
// request somewhere this check would have refused.
function isPublicHostname(host) {
  if (!host.includes('.') || host.startsWith('[') || /^[\d.]+$/.test(host)) return false;
  return !/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host);
}

function describeDestination(sub) {
  if (sub.channel === 'email') return sub.destination;
  if (sub.channel === 'pushover') return `pushover:${sub.destination.slice(0, 4)}…`; // user key prefix only
  try { return `${sub.channel}:${new URL(sub.destination).hostname}`; } catch { return sub.channel; }
}

// ---------------------------------------------------------------------------
// Messages — channel-neutral; deliver() renders them per channel.
// ---------------------------------------------------------------------------
const unsubscribeLink = (env, token) => `${env.API_SITE_URL}/unsubscribe?token=${token}`;

function releaseMessage(env, n) {
  return {
    event:          'firmware.released',
    deviceId:       n.deviceId,
    device:         n.friendlyName,
    version:        n.version,
    title:          `Software Version ${n.version} now available for ${n.friendlyName}`,
    text:           `Software version ${n.version} is available for your ${n.friendlyName}.`,
    unsubscribeUrl: unsubscribeLink(env, n.unsubscribeToken),
  };
}

function confirmMessage(env, deviceId, friendlyName, confirmToken, signingSecret) {
  return {
    event:         'subscription.confirm',
    deviceId,
    device:        friendlyName,
    title:         'Confirm your EarlyNotify subscription',
    text:          `Confirm to start receiving update alerts for your ${friendlyName}. ` +
                   `If you didn't ask for this, ignore it and nothing more will be sent.`,
    confirmUrl:    `${env.API_SITE_URL}/confirm?token=${confirmToken}`,
    signingSecret, // generic webhooks only; see genericPayload
  };
}

function subscribedMessage(env, deviceId, friendlyName, unsubscribeToken) {
  return {
    event:          'subscription.created',
    deviceId,
    device:         friendlyName,
    title:          'Subscribed to EarlyNotify',
    text:           `You'll get an alert here whenever a new software version is released for your ` +
                    `${friendlyName}. The current version follows in a few minutes.`,
    unsubscribeUrl: unsubscribeLink(env, unsubscribeToken),
  };
}

function cancelledMessage(deviceId, friendlyName) {
  return {
    event:    'subscription.cancelled',
    deviceId,
    device:   friendlyName,
    title:    'You have unsubscribed',
    text:     `You will no longer receive update notifications for your ${friendlyName}.`,
  };
}

// Shared by /confirm and instant-channel signups. No welcome notification is
// sent from here: last_notified_version is NULL, so flagging the devices has
// the next dispatch tick (≤2 min) send the current version through the same
// paced, per-channel path as every other notification.
async function subscriptionsActivated(env, deviceIds) {
  await appendPendingDevices(env, deviceIds);

  // First subscriber for a device — drop the cached list so the refresher
  // starts polling it rather than waiting out the hour TTL.
  const knownDevices = await env.NOTIFY.get('subscribed_devices', { type: 'json' });
  if (knownDevices && deviceIds.some(id => !knownDevices.includes(id))) {
    await env.NOTIFY.delete('subscribed_devices');
  }
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
          status: 400, headers: HTML_HEADERS,
        });
      }

      const { results } = await env.DB.prepare(
        'SELECT device_id FROM subscriptions WHERE unsubscribe_token = ? AND active = 1'
      ).bind(token).all();

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'),
          { status: 404, headers: HTML_HEADERS }
        );
      }

      const deviceId = results[0].device_id;
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
      const friendlyName = parsed.devices.find(d => d.identifier === deviceId)?.name ?? deviceId;

      return new Response(unsubscribeConfirmPage(token, friendlyName, env.SITE_URL), {
        headers: HTML_HEADERS,
      });
    }

    // -----------------------------------------------------------------------
    // POST /unsubscribe
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const token = await formField(request, 'token');
      if (!token) {
        return new Response(unsubscribeErrorPage('No unsubscribe token provided.'), {
          status: 400, headers: HTML_HEADERS,
        });
      }

      const { results } = await env.DB.prepare(`
        UPDATE subscriptions SET active = 0, unsubscribe_token = NULL
        WHERE unsubscribe_token = ? AND active = 1
        RETURNING destination, channel, device_id, signing_secret
      `).bind(token).all();

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'),
          { status: 404, headers: HTML_HEADERS }
        );
      }

      const row = results[0];
      const sub = { destination: row.destination, channel: row.channel, signingSecret: row.signing_secret };
      const friendlyName = (await deviceNames(env))[row.device_id] ?? row.device_id;

      try {
        await deliver(env, sub, cancelledMessage(row.device_id, friendlyName));
      } catch (err) {
        console.error(`Unsubscribe confirmation failed for ${describeDestination(sub)}: ${err?.message ?? err}`);
      }

      return new Response(unsubscribeSuccessPage(friendlyName, env.SITE_URL), {
        headers: HTML_HEADERS,
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
      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://earlynotify.com',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST',
      };
      const fail = (error, status = 400) =>
        new Response(JSON.stringify({ error }), { status, headers });

      let formData;
      try { formData = await request.formData(); } catch { return fail('Invalid form submission'); }
      const field = name => { const v = formData.get(name); return typeof v === 'string' ? v : null; };

      // A bare `email` field, with no channel, is what the site sent before
      // channels existed.
      const channel = field('channel') ?? 'email';
      const device = field('device');
      const hcaptchaToken = field('h-captcha-response');

      if (!CHANNELS.includes(channel)) return fail('Unknown channel');
      const destination = normalizeDestination(channel, channel === 'pushover'
        ? `${field('destination') ?? ''}:${field('pushover_token') ?? ''}`
        : field('destination') ?? field('email'));
      if (!destination) return fail(DESTINATION_ERROR[channel]);
      if (!device) return fail('Missing device');
      if (!hcaptchaToken) return fail('Captcha token missing');

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
      if (!hcaptchaRes.success) return fail('Captcha verification failed', 403);

      const deviceList = deviceListRaw ? JSON.parse(deviceListRaw).devices : [];
      const knownDevice = deviceList.find(d => d.identifier === device);
      if (!knownDevice) return fail('Unknown device');

      const friendlyName = knownDevice.name || device;
      const now = Date.now();

      // Every row this destination has, across all devices: whether it was
      // suppressed, whether a confirmation went out recently, its signing key.
      const { results: existing } = await env.DB.prepare(`
        SELECT device_id, active, confirm_token, confirm_sent_at, signing_secret, deactivated_reason
        FROM subscriptions WHERE destination = ?
      `).bind(destination).all();

      // The same answer whatever happens below, so the form can't be used to
      // learn whether a destination is subscribed, pending or suppressed.
      const accepted = new Response(JSON.stringify({ message: ACCEPTED_MESSAGE[channel] }), { headers });

      // Bounced, complained or dead destinations are never revived from here —
      // doing so is what lets anyone re-enrol an address SES told us to stop
      // mailing. Already-active rows keep their unsubscribe token: rotating it
      // would break the links in every email the subscriber already has.
      // Suppressed means a reason and nothing live: a bounce switches off every
      // row for the address at once. Email only — re-mailing a bounced or
      // complaining address is what costs SES standing. Other channels are
      // gated by delivery instead (the welcome post, or the confirmation), so a
      // dead endpoint can't get back in and a repaired one can.
      const suppressed = channel === 'email'
        && existing.some(r => r.deactivated_reason) && !existing.some(r => r.active === 1);
      if (suppressed) return accepted;
      if (existing.some(r => r.device_id === device && r.active === 1)) return accepted;

      if (INSTANT_CHANNELS.has(channel)) {
        // The welcome post doubles as a check that the destination works: if it
        // fails, nothing is stored and the form says so.
        const unsubscribeToken = nanoid();
        const sub = { destination, channel };
        try {
          await deliver(env, sub, subscribedMessage(env, device, friendlyName, unsubscribeToken));
        } catch (err) {
          console.error(`Welcome failed for ${describeDestination(sub)}: ${err?.message ?? err}`);
          return fail('Could not deliver to that destination — check it and try again', 502);
        }

        await env.DB.prepare(`
          INSERT INTO subscriptions
            (destination, channel, device_id, subscribed_at, active, unsubscribe_token)
          VALUES (?, ?, ?, datetime('now'), 1, ?)
          ON CONFLICT(destination, device_id) DO UPDATE SET
            channel               = excluded.channel,
            active                = 1,
            unsubscribe_token     = excluded.unsubscribe_token,
            confirm_token         = NULL,
            confirm_sent_at       = NULL,
            last_notified_version = NULL,
            deactivated_reason    = NULL,
            consecutive_failures  = 0
          WHERE active = 0
        `).bind(destination, channel, device, unsubscribeToken).run();

        await subscriptionsActivated(env, [device]);
        return accepted;
      }

      const recent = existing.find(r =>
        r.active === 0 && r.confirm_token && now - r.confirm_sent_at < CONFIRM_RESEND_MS
      );
      const confirmToken  = recent?.confirm_token ?? nanoid();
      const signingSecret = channel === 'webhook'
        ? (existing.find(r => r.signing_secret)?.signing_secret ?? nanoid(48))
        : null;

      // Inserted inactive. Only POST /confirm turns a row on, and the WHERE
      // keeps a racing request from touching a row that is already live.
      // Suppression was decided above, per destination; a stale reason left on
      // this one row must not block the write, or the confirmation we are
      // about to send would carry a token nothing holds.
      await env.DB.prepare(`
        INSERT INTO subscriptions
          (destination, channel, device_id, subscribed_at, active, unsubscribe_token, confirm_token, confirm_sent_at, signing_secret)
        VALUES (?, ?, ?, datetime('now'), 0, ?, ?, ?, ?)
        ON CONFLICT(destination, device_id) DO UPDATE SET
          channel           = excluded.channel,
          unsubscribe_token = excluded.unsubscribe_token,
          confirm_token     = excluded.confirm_token,
          confirm_sent_at   = excluded.confirm_sent_at,
          signing_secret    = excluded.signing_secret,
          deactivated_reason = NULL,
          consecutive_failures = 0
        WHERE active = 0
      `).bind(destination, channel, device, nanoid(), confirmToken, recent?.confirm_sent_at ?? now, signingSecret).run();

      // Joining a confirmation already sent: the confirm page lists every
      // device the token covers, so this one is included without another send.
      if (recent) return accepted;

      const sub = { destination, channel, signingSecret };
      try {
        await deliver(env, sub, confirmMessage(env, device, friendlyName, confirmToken, signingSecret));
      } catch (err) {
        console.error(`Confirmation failed for ${describeDestination(sub)}: ${err?.message ?? err}`);
        // Otherwise the next attempt would join a confirmation that never arrived.
        await env.DB.prepare('UPDATE subscriptions SET confirm_sent_at = 0 WHERE confirm_token = ?')
          .bind(confirmToken).run();
        return fail(channel === 'email'
          ? 'Could not send the confirmation email, please try again later'
          : 'Could not deliver the confirmation to that destination', 502);
      }

      return accepted;
    }

    // -----------------------------------------------------------------------
    // GET /confirm  (confirmation page)
    //
    // Never confirms by itself: mail scanners and chat link-unfurlers fetch
    // every link they see, and a GET that activated would let them opt people
    // in. The page's button POSTs, as with /unsubscribe.
    // -----------------------------------------------------------------------
    if (request.method === 'GET' && url.pathname === '/confirm') {
      const token = url.searchParams.get('token');
      const { results } = token
        ? await env.DB.prepare(
            'SELECT device_id FROM subscriptions WHERE confirm_token = ? AND active = 0 AND confirm_sent_at > ?'
          ).bind(token, Date.now() - CONFIRM_TTL_MS).all()
        : { results: [] };

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This confirmation link is invalid or has expired. Please sign up again.'),
          { status: 404, headers: HTML_HEADERS }
        );
      }

      const names = await deviceNames(env);
      return new Response(
        confirmPage(token, results.map(r => names[r.device_id] ?? r.device_id), env.SITE_URL),
        { headers: HTML_HEADERS }
      );
    }

    // -----------------------------------------------------------------------
    // POST /confirm
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/confirm') {
      const token = await formField(request, 'token');
      const { results } = token
        ? await env.DB.prepare(`
            UPDATE subscriptions
            SET active = 1, confirm_token = NULL, confirm_sent_at = NULL, last_notified_version = NULL
            WHERE confirm_token = ? AND active = 0 AND confirm_sent_at > ?
            RETURNING device_id
          `).bind(token, Date.now() - CONFIRM_TTL_MS).all()
        : { results: [] };

      if (results.length === 0) {
        return new Response(
          unsubscribeErrorPage('This confirmation link is invalid or has expired. Please sign up again.'),
          { status: 404, headers: HTML_HEADERS }
        );
      }

      const deviceIds = results.map(r => r.device_id);
      await subscriptionsActivated(env, deviceIds);

      const names = await deviceNames(env);
      return new Response(
        confirmSuccessPage(deviceIds.map(id => names[id] ?? id), env.SITE_URL),
        { headers: HTML_HEADERS }
      );
    }

    // -----------------------------------------------------------------------
    // POST /internal/send  (fan-out target — called only by dispatch)
    //
    // The point of this endpoint is the fresh invocation: its own 10 ms CPU and
    // its own 50 subrequests, so the coordinator is no longer capped at what a
    // single invocation can send.
    // -----------------------------------------------------------------------
    if (request.method === 'POST' && url.pathname === '/internal/send') {
      if (url.hostname !== INTERNAL_HOST || !authorizeInternal(request, env)) {
        return new Response('Forbidden', { status: 403 });
      }

      const { batch } = await request.json();
      if (!Array.isArray(batch) || batch.length === 0) {
        return new Response(JSON.stringify({ sent: 0 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (batch.length > EMAILS_PER_CHILD) {
        return new Response('Batch too large', { status: 400 });
      }

      // One compiled template per batch, and only if the batch has email in it.
      // A missing template fails the whole child up front rather than as 36
      // separate send errors.
      const templates = {};
      if (batch.some(n => n.channel === 'email')) {
        try {
          await (templates.email_version = loadTemplate(env, 'email_version'));
        } catch (err) {
          return new Response(err.message, { status: 500 });
        }
      }

      let sent = 0;

      // Waves of 6 because that is the free tier's simultaneous-connection cap;
      // anything above it queues rather than parallelises. The floor on wave
      // duration is what holds us at 6 sends/sec/child. A webhook or Pushover
      // post is one subrequest, same as an email, so the budget is unchanged.
      for (let i = 0; i < batch.length; i += SEND_WAVE_SIZE) {
        const wave      = batch.slice(i, i + SEND_WAVE_SIZE);
        const waveStart = Date.now();

        const results = await Promise.allSettled(
          wave.map(n => deliver(env, n, releaseMessage(env, n), templates))
        );

        // Successes and dead-destination suppressions go in one D1 batch, so
        // the child still spends one subrequest per wave on writes.
        const writes = [];
        results.forEach((r, j) => {
          const n = wave[j];
          if (r.status === 'fulfilled') {
            writes.push(env.DB.prepare(`
              UPDATE subscriptions SET last_notified_version = ?, consecutive_failures = 0
              WHERE destination = ? AND device_id = ?
            `).bind(n.version, n.destination, n.deviceId));
            sent++;
            return;
          }
          console.error(`Failed to send to ${describeDestination(n)}: ${r.reason?.message ?? r.reason}`);
          // The webhook's equivalent of a hard bounce: deleted, or the
          // receiver said to stop. Retrying it every sweep forever helps nobody.
          if (r.reason?.permanent) {
            writes.push(env.DB.prepare(`
              UPDATE subscriptions SET active = 0, unsubscribe_token = NULL, deactivated_reason = 'gone'
              WHERE destination = ? AND active = 1
            `).bind(n.destination));
          } else if (n.channel !== 'email') {
            // D1 runs a batch in order, so the second statement sees the first's
            // increment. It switches off every row for the destination, as the
            // endpoint is what's dead, not the one device.
            writes.push(
              env.DB.prepare(`
                UPDATE subscriptions SET consecutive_failures = consecutive_failures + 1
                WHERE destination = ? AND device_id = ?
              `).bind(n.destination, n.deviceId),
              env.DB.prepare(`
                UPDATE subscriptions SET active = 0, unsubscribe_token = NULL, deactivated_reason = 'unresponsive'
                WHERE destination = ?1 AND active = 1 AND EXISTS (
                  SELECT 1 FROM subscriptions WHERE destination = ?1 AND consecutive_failures >= ?2
                )
              `).bind(n.destination, MAX_CONSECUTIVE_FAILURES),
            );
          }
        });

        // Committed per wave, not once at the end: these messages have already
        // been delivered, so if the child dies before recording them the sweep
        // resends every uncommitted one. Per-wave bounds that blast radius to 6.
        if (writes.length > 0) await env.DB.batch(writes);

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
      if (typeof email !== 'string' || !email) return new Response('Missing email', { status: 400 });

      // Pending and already-unsubscribed rows are marked too, not just live
      // ones: deactivated_reason is what stops /subscribe re-enrolling the
      // address, and a confirmation email is as able to bounce as any other.
      const { meta } = await env.DB.prepare(`
        UPDATE subscriptions
        SET active = 0, unsubscribe_token = NULL, confirm_token = NULL, deactivated_reason = ?
        WHERE destination = ? AND channel = 'email' AND (deactivated_reason IS NULL OR active = 1)
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
  if (!env.SELF) {
    console.error('SELF service binding missing — add it to wrangler.toml (see wrangler.toml.example)');
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
      SELECT destination, channel, device_id, unsubscribe_token, signing_secret
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
    destination:      row.destination,
    channel:          row.channel,
    signingSecret:    row.signing_secret,
    deviceId:         row.device_id,
    friendlyName:     nameMap[row.device_id] ?? row.device_id,
    version:          versionFor[row.device_id],
    unsubscribeToken: row.unsubscribe_token,
  }));

  // Generic webhooks go last. They are the one destination a subscriber can
  // make slow on purpose — an endpoint that never answers turns its 1 s wave
  // into a DELIVERY_TIMEOUT_MS one — so they must not share waves with, or
  // queue ahead of, anyone else. Whatever the deadline cuts off is still
  // flagged and goes out next tick.
  const DISPATCH_ORDER = { email: 0, webhook: 2 };
  pending.sort((a, b) => (DISPATCH_ORDER[a.channel] ?? 1) - (DISPATCH_ORDER[b.channel] ?? 1));

  const chunks = [];
  for (let i = 0; i < pending.length; i += EMAILS_PER_CHILD) {
    chunks.push(pending.slice(i, i + EMAILS_PER_CHILD));
  }

  console.log(`Dispatching ${pending.length} notifications across ${chunks.length} batches`);

  let sent = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length && Date.now() - startedAt < DISPATCH_DEADLINE_MS) {
      const chunk = chunks[next++];
      try {
        // Through the SELF service binding, never the public URL: a global
        // fetch() to a Worker on its own zone fails, so every batch errored
        // out and the run sent 0 emails.
        const res = await env.SELF.fetch(`https://${INTERNAL_HOST}/internal/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-internal-key': env.INTERNAL_SECRET },
          body: JSON.stringify({ batch: chunk }),
        });
        if (!res.ok) throw new Error(`child returned ${res.status}: ${await res.text()}`);
        sent += (await res.json()).sent ?? 0;
      } catch (err) {
        // Log the message explicitly — the dashboard showed only the stack.
        console.error(`Send batch failed: ${err?.message ?? err}`);
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
// Delivery
//
// deliver() sends one channel-neutral message (see releaseMessage and friends)
// to one subscription, rendered for its channel. It throws DeliveryError, with
// `permanent` set when the destination is gone for good.
// -----------------------------------------------------------------------------
class DeliveryError extends Error {
  constructor(message, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

const EMAIL_TEMPLATE = {
  'firmware.released':      'email_version',
  'subscription.confirm':   'email_confirm',
  'subscription.cancelled': 'email_unsubscribe',
};

const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

// `templates` caches compiled templates across a batch. It holds the promise,
// not the result, so a wave of six parallel sends shares one KV read.
async function deliver(env, sub, msg, templates = {}) {
  if (sub.channel === 'email') {
    const key = EMAIL_TEMPLATE[msg.event];
    const render = await (templates[key] ??= loadTemplate(env, key));
    return sendEmail(env, sub.destination, msg.title, render(msg));
  }

  let target = sub.destination;
  let body;
  let contentType = 'application/json';
  const headers = { 'User-Agent': IPSW_USER_AGENT };

  switch (sub.channel) {
    case 'discord': body = JSON.stringify(discordPayload(msg)); break;
    case 'slack':   body = JSON.stringify(slackPayload(msg));   break;
    case 'teams':   body = JSON.stringify(teamsPayload(msg));   break;
    case 'pushover':
      target      = PUSHOVER_URL;
      body        = new URLSearchParams(pushoverPayload(sub, msg)).toString();
      contentType = 'application/x-www-form-urlencoded';
      break;
    case 'webhook':
      body = JSON.stringify(genericPayload(msg));
      Object.assign(headers, await signatureHeaders(sub.signingSecret, msg.event, body));
      break;
    default:
      throw new DeliveryError(`Unknown channel ${sub.channel}`);
  }

  const res = await fetch(target, {
    method:   'POST',
    headers:  { ...headers, 'Content-Type': contentType },
    body,
    redirect: 'manual',
    signal:   AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  if (res.ok) return discard(res);

  // Chat services answer 404 for a deleted webhook. A generic receiver only
  // counts as gone on an explicit 410, so a server having a bad day isn't
  // unsubscribed for it. Pushover's endpoint is fixed, so it reports a bad
  // user key or app token in the body instead.
  let permanent = false;
  if (sub.channel === 'pushover') {
    const data = res.status === 400 ? await res.json().catch(() => ({})) : (await discard(res), {});
    permanent = data.user === 'invalid' || data.token === 'invalid';
  } else {
    permanent = res.status === 410 || (res.status === 404 && sub.channel !== 'webhook');
    await discard(res);
  }
  throw new DeliveryError(`${describeDestination(sub)} returned ${res.status}`, permanent);
}

// Unread bodies hold a connection open, and the free tier only has six.
function discard(res) {
  return res.body?.cancel().catch(() => {});
}

// The action link (if any) first, then unsubscribe.
function messageLinks(msg) {
  const out = [];
  if (msg.confirmUrl)     out.push({ label: 'Confirm subscription', url: msg.confirmUrl });
  if (msg.unsubscribeUrl) out.push({ label: 'Unsubscribe', url: msg.unsubscribeUrl });
  return out;
}

function discordPayload(msg) {
  return {
    username: 'EarlyNotify',
    embeds: [{
      title:       msg.title,
      description: [msg.text, ...messageLinks(msg).map(l => `[${l.label}](${l.url})`)].join('\n\n'),
      color:       0x06b6d4,
    }],
    allowed_mentions: { parse: [] },
  };
}

function slackPayload(msg) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    text: [
      `*${esc(msg.title)}*`,
      esc(msg.text),
      ...messageLinks(msg).map(l => `<${l.url}|${esc(l.label)}>`),
    ].join('\n'),
    unfurl_links: false,
  };
}

function teamsPayload(msg) {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true },
          { type: 'TextBlock', text: msg.text, wrap: true },
        ],
        actions: messageLinks(msg).map(l => ({ type: 'Action.OpenUrl', title: l.label, url: l.url })),
      },
    }],
  };
}

// The subscriber's own Pushover application sends, so its monthly quota is
// theirs, not ours.
function pushoverPayload(sub, msg) {
  const [user, token] = sub.destination.split(':');
  const [primary, ...rest] = messageLinks(msg);
  const payload = {
    token,
    user,
    title:   msg.title.slice(0, 250),
    message: [msg.text, ...rest.map(l => `${l.label}: ${l.url}`)].join('\n\n').slice(0, 1024),
  };
  if (primary) Object.assign(payload, { url: primary.url, url_title: primary.label });
  return payload;
}

// The signing secret travels only in subscription.confirm, i.e. only to the
// endpoint itself. Returning it from /subscribe would hand it to whoever filled
// in the form — who need not own the endpoint — letting them forge our
// signatures to it.
function genericPayload(msg) {
  return {
    event:           msg.event,
    device:          { id: msg.deviceId, name: msg.device },
    version:         msg.version ?? null,
    confirm_url:     msg.confirmUrl,
    signing_secret:  msg.signingSecret ?? undefined,
    unsubscribe_url: msg.unsubscribeUrl,
    sent_at:         new Date().toISOString(),
  };
}

// Signature is HMAC-SHA256 over `${timestamp}.${body}`, hex, so receivers can
// both verify the sender and reject replays outside a time window.
async function signatureHeaders(secret, event, body) {
  const enc       = new TextEncoder();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return {
    'X-EarlyNotify-Event':     event,
    'X-EarlyNotify-Timestamp': timestamp,
    'X-EarlyNotify-Signature': `sha256=${hex}`,
  };
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
// HTML helpers
// -----------------------------------------------------------------------------

// These pages carry tokens in their URL and forms: no-referrer keeps the token
// out of the Referer sent to earlynotify.com, and frame-ancestors stops the
// buttons being clickjacked.
const HTML_HEADERS = {
  'Content-Type':            'text/html; charset=utf-8',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy':         'no-referrer',
  'X-Content-Type-Options':  'nosniff',
};

// A single string field from a form body, or null — also when the body isn't
// a form at all, rather than letting formData() throw a 500.
async function formField(request, name) {
  try {
    const value = (await request.formData()).get(name);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}
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

function deviceListHtml(names) {
  return names.map(n => `<span class="device">${escapeHtml(n)}</span>`).join(', ');
}

function confirmPage(token, deviceNames, siteUrl) {
  const body = `
    <div class="icon" style="background: rgba(6,182,212,0.1);">🔔</div>
    <h1>Confirm your subscription</h1>
    <p>You'll get an alert when a new software version is released for your ${deviceListHtml(deviceNames)}.</p>
    <p>If you didn't sign up for this, just close this page — nothing will be sent.</p>
    <form method="POST" action="/confirm">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit" class="btn btn-primary">Confirm subscription</button>
    </form>
  `;
  return unsubscribeShell('Confirm Subscription', body, siteUrl);
}

function confirmSuccessPage(deviceNames, siteUrl) {
  const body = `
    <div class="icon" style="background: rgba(74,222,128,0.1);">✓</div>
    <h1>You're subscribed</h1>
    <p>You'll be notified of new releases for your ${deviceListHtml(deviceNames)}, starting with the current version in the next few minutes.</p>
    <a href="${siteUrl || 'https://earlynotify.com'}" class="btn btn-primary">Back to EarlyNotify</a>
  `;
  return unsubscribeShell('Subscribed', body, siteUrl);
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
