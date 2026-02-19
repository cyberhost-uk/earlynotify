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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/newest_ios') {
      const TARGET_DEVICE = 'iPhone17,3'; // iPhone 16
      const jsonHeaders = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'https://earlynotify.com' };

      try {
        const firmwareCacheJson = await env.RELEASES.get('firmware_cache');
        const firmwareCache = firmwareCacheJson ? JSON.parse(firmwareCacheJson) : {};

        let deviceData = firmwareCache[TARGET_DEVICE];
        const cacheAge = deviceData ? Date.now() - new Date(deviceData.fetchedAt).getTime() : Infinity;
        const cacheExpired = cacheAge > env.KV_CACHE_INVALID * 60 * 1000;

        if (!deviceData || cacheExpired) {
          const fetched = await fetch(`https://api.ipsw.me/v4/device/${TARGET_DEVICE}?type=ipsw`).then(r => r.json());
          firmwareCache[TARGET_DEVICE] = { fetchedAt: new Date().toISOString(), data: fetched };
          await env.RELEASES.put('firmware_cache', JSON.stringify(firmwareCache), { expirationTtl: env.KV_CACHE_AUTOREMOVE * 60 });
          deviceData = firmwareCache[TARGET_DEVICE];
        }

        const firmwares = deviceData?.data?.firmwares;
        if (!firmwares || firmwares.length === 0) {
          return new Response(JSON.stringify({ error: 'No firmware data available', ios: 'N/A', build: 'N/A', size: 'N/A' }), { headers: jsonHeaders, status: 404 });
        }

        const latestFirmware = firmwares[0];
        return new Response(JSON.stringify({
          ios: latestFirmware.version || 'N/A',
          build: latestFirmware.buildid || 'N/A',
          releasedate: latestFirmware.releasedate || 'N/A',
          size: formatFileSize(latestFirmware.filesize),
        }), { headers: jsonHeaders });

      } catch (error) {
        console.error('Error in /newest_ios endpoint:', error);
        return new Response(JSON.stringify({ error: 'Internal server error', ios: 'N/A', build: 'N/A', size: 'N/A' }), { headers: jsonHeaders, status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return Response.redirect(env.SITE_URL, 301);
    }

    if (request.method === 'GET' && url.pathname === '/stats') {
      const jsonHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': 'https://earlynotify.com',
        'Cache-Control': 'public, max-age=900',
      };

      try {
        const cached = await env.NOTIFY.get('stats_cache', { type: 'json' });
        if (cached && (Date.now() - new Date(cached.fetchedAt).getTime()) < 15 * 60 * 1000) {
          return new Response(JSON.stringify({ subscribers: cached.count }), { headers: jsonHeaders });
        }

        const { results } = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM subscriptions WHERE active = 1'
        ).all();

        const count = results[0]?.count ?? 0;
        await env.NOTIFY.put('stats_cache', JSON.stringify({ count, fetchedAt: new Date().toISOString() }), { expirationTtl: 1800 });

        return new Response(JSON.stringify({ subscribers: count }), { headers: jsonHeaders });
      } catch (error) {
        console.error('Error in /stats endpoint:', error);
        return new Response(JSON.stringify({ error: 'Unable to fetch stats' }), { headers: jsonHeaders, status: 500 });
      }
    }

    if (request.method === 'GET' && url.pathname === '/devices') {
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
      const deviceList = parsed.devices;

      const grouped = {};
      for (const d of deviceList) {
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
        },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/unsubscribe')) {
      const token = url.searchParams.get('token');
      if (!token) return new Response(unsubscribeErrorPage('No unsubscribe token provided.'), { status: 400, headers: { 'Content-Type': 'text/html' } });

      const { results } = await env.DB.prepare(`
        SELECT device_id FROM subscriptions WHERE unsubscribe_token = ? AND active = 1
      `).bind(token).all();

      if (results.length === 0) {
        return new Response(unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'), { status: 404, headers: { 'Content-Type': 'text/html' } });
      }

      const deviceId = results[0]?.device_id;
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
      const friendlyName = parsed.devices.find(d => d.identifier === deviceId)?.name || deviceId;

      return new Response(unsubscribeConfirmPage(token, friendlyName, env.SITE_URL), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/unsubscribe') {
      const formData = await request.formData();
      const token = formData.get('token');
      if (!token) return new Response(unsubscribeErrorPage('No unsubscribe token provided.'), { status: 400, headers: { 'Content-Type': 'text/html' } });

      const { results } = await env.DB.prepare(`
        SELECT email, device_id FROM subscriptions WHERE unsubscribe_token = ? AND active = 1
      `).bind(token).all();

      if (results.length === 0) {
        return new Response(unsubscribeErrorPage('This unsubscribe link is invalid or has already been used.'), { status: 404, headers: { 'Content-Type': 'text/html' } });
      }

      const email = results[0]?.email;
      const deviceId = results[0]?.device_id;

      await env.DB.prepare(`
        UPDATE subscriptions SET active = 0, unsubscribe_token = NULL WHERE unsubscribe_token = ?
      `).bind(token).run();

      if (email && deviceId) {
        const deviceData = await env.NOTIFY.get('device_list');
        const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
        const friendlyName = parsed.devices.find(d => d.identifier === deviceId)?.name || deviceId;
        await sendEmailLambda(env, email, friendlyName, 'N/A', token, 'unsubscribe');
        return new Response(unsubscribeSuccessPage(friendlyName, env.SITE_URL), {
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return new Response(unsubscribeSuccessPage('your device', env.SITE_URL), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const formData = await request.formData();
      const email = formData.get('email');
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

      if (!hcaptchaToken) {
        return new Response(JSON.stringify({ error: 'Captcha token missing' }), { status: 400, headers });
      }

      const hcaptchaRes = await fetch('https://hcaptcha.com/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.HCAPTCHA_SECRET,
          response: hcaptchaToken,
        }),
      }).then(r => r.json());

      if (!hcaptchaRes.success) {
        return new Response(JSON.stringify({ error: 'Captcha verification failed' }), { status: 403, headers });
      }

      const firmwareCacheJson = await env.RELEASES.get('firmware_cache');
      const firmwareCache = firmwareCacheJson ? JSON.parse(firmwareCacheJson) : {};

      const firmwareData = await fetchFirmwareAndUpdateCache(device, firmwareCache, env);

      const latestVersion = firmwareData?.firmwares?.[0]?.version;
      const unsubscribeToken = nanoid();

      await env.DB.prepare(`
        INSERT INTO subscriptions (email, device_id, subscribed_at, active, unsubscribe_token)
        VALUES (?, ?, datetime('now'), 1, ?)
        ON CONFLICT(email, device_id) DO UPDATE SET active = 1, unsubscribe_token = excluded.unsubscribe_token;
      `).bind(email, device, unsubscribeToken).run();

      if (latestVersion) {
        const deviceData = await env.NOTIFY.get('device_list');
        const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
        const deviceJson = parsed.devices;
        const friendlyName = deviceJson.find(d => d.identifier === device)?.name || device;

        await sendEmailLambda(env, email, friendlyName, latestVersion, unsubscribeToken, 'version');

        await env.DB.prepare(`
          UPDATE subscriptions SET last_notified_version = ? WHERE email = ? AND device_id = ?
        `).bind(latestVersion, email, device).run();
      }

      await env.RELEASES.put('firmware_cache', JSON.stringify(firmwareCache), { expirationTtl: env.KV_CACHE_AUTOREMOVE * 60 });

      return new Response(JSON.stringify({ message: 'Subscription successful!' }), { headers });
    }

    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    let deviceData = await env.NOTIFY.get('device_list');
    let shouldFetchDevices = true;

    if (deviceData) {
      const parsed = JSON.parse(deviceData);
      const fetchedAt = new Date(parsed.fetchedAt);
      if ((Date.now() - fetchedAt.getTime()) < env.DEVICE_LIST_CACHE * 60 * 1000) shouldFetchDevices = false;
    }

    if (shouldFetchDevices) {
      const devices = await fetch('https://api.ipsw.me/v4/devices').then(res => res.json());
      await env.NOTIFY.put('device_list', JSON.stringify({ fetchedAt: new Date().toISOString(), devices }), { expirationTtl: 86400 });
      deviceData = JSON.stringify({ fetchedAt: new Date().toISOString(), devices });
    }

    const deviceJson = JSON.parse(deviceData).devices;

    const { results: subscribedDevices } = await env.DB.prepare(`
      SELECT DISTINCT device_id FROM subscriptions WHERE active = 1
    `).all();

    const firmwareCacheJson = await env.RELEASES.get('firmware_cache');
    const firmwareCache = firmwareCacheJson ? JSON.parse(firmwareCacheJson) : {};
    let firmwareUpdated = false;

    async function fetchFirmware(deviceId) {
      const entry = firmwareCache[deviceId];
      const now = Date.now();

      if (entry && (now - new Date(entry.fetchedAt).getTime()) < env.KV_CACHE_INVALID * 60 * 1000) {
        return entry.data;
      }

      const data = await fetch(`https://api.ipsw.me/v4/device/${deviceId}?type=ipsw`).then(res => res.json());
      firmwareCache[deviceId] = {
        fetchedAt: new Date().toISOString(),
        data,
      };
      firmwareUpdated = true;
      return data;
    }

    for (const { device_id: deviceId } of subscribedDevices) {
      const firmwareData = await fetchFirmware(deviceId);
      const latestVersion = firmwareData?.firmwares?.[0]?.version;
      if (!latestVersion) continue;

      const { results } = await env.DB.prepare(`
        SELECT email, last_notified_version, unsubscribe_token FROM subscriptions
        WHERE device_id = ? AND active = 1
      `).bind(deviceId).all();

      const friendlyName = deviceJson.find(d => d.identifier === deviceId)?.name || deviceId;

      for (const row of results) {
        if (row.last_notified_version !== latestVersion) {
          await sendEmailLambda(env, row.email, friendlyName, latestVersion, row.unsubscribe_token, 'version');
          await env.DB.prepare(`
            UPDATE subscriptions SET last_notified_version = ? WHERE email = ? AND device_id = ?
          `).bind(latestVersion, row.email, deviceId).run();
        }
      }
    }

    if (firmwareUpdated) {
      await env.RELEASES.put('firmware_cache', JSON.stringify(firmwareCache), { expirationTtl: env.KV_CACHE_AUTOREMOVE * 60 });
    }
  },
};

async function fetchFirmwareAndUpdateCache(deviceId, firmwareCache, env) {
  const entry = firmwareCache[deviceId];
  const now = Date.now();

  if (entry && (now - new Date(entry.fetchedAt).getTime()) < env.KV_CACHE_INVALID * 60 * 1000) {
    return entry.data;
  }

  const data = await fetch(`https://api.ipsw.me/v4/device/${deviceId}?type=ipsw`).then(res => res.json());
  firmwareCache[deviceId] = {
    fetchedAt: new Date().toISOString(),
    data,
  };
  return data;
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
  const safe = escapeHtml(deviceName);
  const body = `
    <div class="icon" style="background: rgba(239,68,68,0.1);">🔕</div>
    <h1>Unsubscribe?</h1>
    <p>You're about to stop receiving update alerts for your <span class="device">${safe}</span>.</p>
    <p>If you clicked this link by accident, just close this page — nothing has changed.</p>
    <form method="POST" action="/unsubscribe">
      <input type="hidden" name="token" value="${token}">
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
    <p>${message}</p>
    <a href="https://earlynotify.com" class="btn btn-primary">Back to EarlyNotify</a>
  `;
  return unsubscribeShell('Error', body, 'https://earlynotify.com');
}


async function sendEmailLambda(env, to, device, version, unsubscribeToken, messageType) {
  const unsubscribeUrl = `${env.API_SITE_URL}/unsubscribe?token=${unsubscribeToken}`;

  let subject = '';
  let templateKey = '';

  switch (messageType) {
    case 'version':
      subject = `Software Version ${version} now available for ${device}`;
      templateKey = 'email_version';
      break;
    case 'unsubscribe':
      subject = 'You have unsubscribed';
      templateKey = 'email_unsubscribe';
      break;
    default:
      subject = 'iOS Update Notification';
      templateKey = 'email_version';
  }

  const rawTemplate = await env.NOTIFY.get(templateKey);
  if (!rawTemplate) throw new Error(`Template ${templateKey} not found`);

  let emailTemplate = rawTemplate
    .replaceAll('${device}', device)
    .replaceAll('${version}', version)
    .replaceAll('${unsubscribeUrl}', unsubscribeUrl);

  const res = await fetch(env.LAMBDA_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.LAMBDA_API_KEY,
    },
    body: JSON.stringify({
      to,
      subject,
      message: emailTemplate,
    }),
  });

  const debug = await res.text();
  console.log(`Lambda email status: ${res.status} - ${debug}`);
}
