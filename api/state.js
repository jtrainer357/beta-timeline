const STATE_PREFIX = 'state/';
const VALID_KEY = /^gantt-state-[a-z0-9-]+$/;
const READ_CACHE_TTL_MS = 15000;
const readCache = new Map();

function getCachedRecord(key) {
  const cached = readCache.get(key);
  if (!cached || Date.now() - cached.cachedAt > READ_CACHE_TTL_MS) return null;
  return cached.record;
}

function setCachedRecord(key, record) {
  readCache.set(key, { record, cachedAt: Date.now() });
  return record;
}

function gistFileName(key) {
  return `${key}.json`;
}

function hasGistStore() {
  return Boolean(process.env.GANTT_GIST_ID && process.env.GANTT_GITHUB_TOKEN);
}

async function requestGist(path = '', init = {}) {
  const res = await fetch(`https://api.github.com/gists/${process.env.GANTT_GIST_ID}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GANTT_GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {})
    }
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub state store failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

async function readGistJson(key, options = {}) {
  const cached = options.bypassCache ? null : getCachedRecord(key);
  if (cached) return cached;
  const gist = await requestGist();
  const file = gist.files?.[gistFileName(key)];
  if (!file) return null;
  const content = file.truncated
    ? await (await fetch(file.raw_url, { cache: 'no-store' })).text()
    : file.content;
  return content ? setCachedRecord(key, JSON.parse(content)) : null;
}

async function writeGistJson(key, payload) {
  await requestGist('', {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [gistFileName(key)]: {
          content: JSON.stringify(payload, null, 2)
        }
      }
    })
  });
  return setCachedRecord(key, payload);
}

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

async function readBlobJson(pathname, options = {}) {
  const cached = options.bypassCache ? null : getCachedRecord(pathname);
  if (cached) return cached;
  const { get } = await import('@vercel/blob');
  const result = await get(pathname, { access: 'private', useCache: false });
  if (!result || result.statusCode === 304 || !result.stream) return null;
  const text = await new Response(result.stream).text();
  return text ? setCachedRecord(pathname, JSON.parse(text)) : null;
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
      const url = new URL(req.url, `https://${req.headers.host || 'nitro-gantt.vercel.app'}`);
      const bypassCache = url.searchParams.get('fresh') === '1';
      if (hasGistStore()) {
        const record = await readGistJson(key, { bypassCache });
        res.statusCode = 200;
        res.end(JSON.stringify(record || { key, state: null, updatedAt: null }));
        return;
      }
      const record = await readBlobJson(`${STATE_PREFIX}${key}.json`, { bypassCache });
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
      if (hasGistStore()) {
        await writeGistJson(key, record);
        res.statusCode = 200;
        res.end(JSON.stringify(record));
        return;
      }
      await writeBlobJson(`${STATE_PREFIX}${key}.json`, record);
      setCachedRecord(`${STATE_PREFIX}${key}.json`, record);
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
