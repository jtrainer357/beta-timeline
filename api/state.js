const STATE_PREFIX = 'state/';
const VALID_KEY = /^gantt-state-[a-z0-9-]+$/;

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function readBlobJson(pathname) {
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private', useCache: false });
  if (!result || result.statusCode === 304 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return text ? JSON.parse(text) : null;
}

async function writeBlobJson(pathname, payload) {
  const { put } = await import('@vercel/blob');
  return put(pathname, JSON.stringify(payload), {
    access: 'private',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function getKey(req, body = {}) {
  const url = new URL(req.url, `https://${req.headers.host || 'nitro-gantt.vercel.app'}`);
  const key = body.key || url.searchParams.get('key');
  if (!key || !VALID_KEY.test(key)) {
    const err = new Error('Invalid timeline key.');
    err.statusCode = 400;
    throw err;
  }
  return key;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET') {
      const key = getKey(req);
      const record = await readBlobJson(`${STATE_PREFIX}${key}.json`);
      res.statusCode = 200;
      res.end(JSON.stringify(record || { key, state: null, updatedAt: null }));
      return;
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await readJsonBody(req);
      const key = getKey(req, body);
      if (!body.state || typeof body.state !== 'object') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing timeline state.' }));
        return;
      }

      const updatedAt = new Date().toISOString();
      const record = {
        key,
        state: {
          ...body.state,
          saved: body.state.saved || updatedAt
        },
        updatedAt
      };
      await writeBlobJson(`${STATE_PREFIX}${key}.json`, record);
      res.statusCode = 200;
      res.end(JSON.stringify(record));
      return;
    }

    res.setHeader('Allow', 'GET, PUT, POST');
    res.statusCode = 405;
    res.end(JSON.stringify({ error: 'Method not allowed.' }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.end(JSON.stringify({ error: err.message || 'Timeline state API failed.' }));
  }
};
