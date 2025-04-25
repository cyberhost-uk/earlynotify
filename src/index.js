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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      const deviceData = await env.NOTIFY.get('device_list');
      const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
      const deviceJson = parsed.devices;
      return new Response(await getFormPage(deviceJson, env), {
        headers: {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        },
      });
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
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/unsubscribe')) {
      const token = url.searchParams.get('token');
      if (!token) return new Response('Invalid unsubscribe token', { status: 400 });

      const { results } = await env.DB.prepare(`
        SELECT email, device_id FROM subscriptions WHERE unsubscribe_token = ? AND active = 1
      `).bind(token).all();

      if (results.length === 0) {
        return new Response('No active subscription found for the provided token.', { status: 404 });
      }

      const email = results[0]?.email;
      const deviceId = results[0]?.device_id;

      await env.DB.prepare(`
        UPDATE subscriptions SET active = 0, unsubscribe_token = NULL WHERE unsubscribe_token = ?
      `).bind(token).run();

      if (email && deviceId) {
        const deviceData = await env.NOTIFY.get('device_list');
        const parsed = deviceData ? JSON.parse(deviceData) : { devices: [] };
        const deviceJson = parsed.devices;
        const friendlyName = deviceJson.find(d => d.identifier === deviceId)?.name || deviceId;

        await sendEmailLambda(env, email, friendlyName, 'N/A', token, 'unsubscribe');
      }

      return new Response('You have been unsubscribed.', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/subscribe') {
      const formData = await request.formData();
      const email = formData.get('email');
      const device = formData.get('device');
      const hcaptchaToken = formData.get('h-captcha-response');

      const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
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

      await env.RELEASES.put('firmware_cache', JSON.stringify(firmwareCache), { expirationTtl: env.KV_CACHE_AUTOREMOVE });

      return new Response(JSON.stringify({ message: 'Subscription successful!' }), { headers });
    }
  },

  async scheduled(event, env, ctx) {
    let deviceData = await env.NOTIFY.get('device_list');
    let shouldFetchDevices = true;

    if (deviceData) {
      const parsed = JSON.parse(deviceData);
      const fetchedAt = new Date(parsed.fetchedAt);
      if ((Date.now() - fetchedAt.getTime()) < env.DEVICE_LIST_CACHE) shouldFetchDevices = false;
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

      if (entry && (now - new Date(entry.fetchedAt).getTime()) < env.KV_CACHE_INVALID) {
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
      await env.RELEASES.put('firmware_cache', JSON.stringify(firmwareCache), { expirationTtl: env.KV_CACHE_AUTOREMOVE });
    }
  },
};

async function fetchFirmwareAndUpdateCache(deviceId, firmwareCache, env) {
  const entry = firmwareCache[deviceId];
  const now = Date.now();

  if (entry && (now - new Date(entry.fetchedAt).getTime()) < env.KV_CACHE_INVALID) {
    return entry.data;
  }

  const data = await fetch(`https://api.ipsw.me/v4/device/${deviceId}?type=ipsw`).then(res => res.json());
  firmwareCache[deviceId] = {
    fetchedAt: new Date().toISOString(),
    data,
  };
  return data;
}

// sendEmailLambda and getFormPage remain unchanged from your original code.
async function sendEmailLambda(env, to, device, version, unsubscribeToken, messageType) {
  const unsubscribeUrl = `${env.API_SITE_URL}/unsubscribe?token=${unsubscribeToken}`;

  let subject = '';
  let templateKey = '';

  switch (messageType) {
    case 'version':
      subject = `Software Version ${version} now avalible ${device}`;
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
    .replace('${device}', device)
    .replace('${version}', version)
    .replace('${unsubscribeUrl}', unsubscribeUrl);

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
