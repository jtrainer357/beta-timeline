const ACTIVE_WINDOW_MS = 25000;
const VALID_ID = /^[a-zA-Z0-9_-]{8,100}$/;
const PRESENCE_CACHE_KEY = 'nitro-presence-v2';
const PRESENCE_CACHE_TTL_SECONDS = 60;
const LOCAL_PRESENCE_FILE = '/tmp/nitro-gantt-presence.json';

globalThis.__nitroPresenceSessions ||= {};
let runtimeCacheFailed = false;

function sessions() {
  return globalThis.__nitroPresenceSessions;
}

async function runtimeCache() {
  if (runtimeCacheFailed || !process.env.RUNTIME_CACHE_ENDPOINT || !process.env.RUNTIME_CACHE_HEADERS) return null;
  try {
    const { getCache } = await import('@vercel/functions');
    return getCache();
  } catch {
    runtimeCacheFailed = true;
    return null;
  }
}

async function readLocalPresence() {
  try {
    const fs = require('fs/promises');
    const raw = await fs.readFile(LOCAL_PRESENCE_FILE, 'utf8');
    return normalizePresence(JSON.parse(raw));
  } catch {
    return { sessions: sessions() };
  }
}

async function writeLocalPresence(presence) {
  const normalized = normalizePresence(presence);
  globalThis.__nitroPresenceSessions = normalized.sessions;
  try {
    const fs = require('fs/promises');
    await fs.writeFile(LOCAL_PRESENCE_FILE, JSON.stringify(normalized), 'utf8');
  } catch {}
  return normalized;
}

function normalizePresence(presence) {
  return presence?.sessions && typeof presence.sessions === 'object'
    ? presence
    : { sessions: presence && typeof presence === 'object' ? presence : {} };
}

async function readPresence() {
  const cache = await runtimeCache();
  if (!cache) return readLocalPresence();
  try {
    return normalizePresence(await cache.get(PRESENCE_CACHE_KEY));
  } catch {
    runtimeCacheFailed = true;
    return readLocalPresence();
  }
}

async function writePresence(presence) {
  const normalized = normalizePresence(presence);
  globalThis.__nitroPresenceSessions = normalized.sessions;
  const cache = await runtimeCache();
  if (!cache) return writeLocalPresence(normalized);
  try {
    await cache.set(PRESENCE_CACHE_KEY, normalized, {
      ttl: PRESENCE_CACHE_TTL_SECONDS,
      tags: ['nitro-presence']
    });
  } catch {
    runtimeCacheFailed = true;
    await writeLocalPresence(normalized);
  }
  return normalized;
}

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function prune(now = Date.now()) {
  const active = sessions();
  for (const [sessionId, entry] of Object.entries(active)) {
    if (!entry?.lastSeen || now - Date.parse(entry.lastSeen) > ACTIVE_WINDOW_MS) {
      delete active[sessionId];
    }
  }
  return active;
}

function activeUserIds(now = Date.now()) {
  return [...new Set(Object.values(prune(now)).map(entry => entry.userId).filter(Boolean))];
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.statusCode = 405;
      res.end(JSON.stringify({ error: 'Method not allowed.' }));
      return;
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const url = new URL(req.url, `https://${req.headers.host || 'nitro-gantt.vercel.app'}`);
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const userId = body.userId || body.clientId || url.searchParams.get('userId') || url.searchParams.get('clientId');
    const sessionId = body.sessionId || body.clientId || url.searchParams.get('sessionId') || userId;

    if (userId && !VALID_ID.test(userId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid presence user.' }));
      return;
    }
    if (sessionId && !VALID_ID.test(sessionId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid presence session.' }));
      return;
    }

    const presence = await readPresence();
    globalThis.__nitroPresenceSessions = normalizePresence(presence).sessions;
    const active = prune(now);
    if (req.method === 'POST' && userId && sessionId) {
      if (body.action === 'leave') {
        delete active[sessionId];
      } else {
        active[sessionId] = {
          userId,
          tab: typeof body.tab === 'string' ? body.tab.slice(0, 40) : null,
          lastSeen: nowIso
        };
      }
      await writePresence({ sessions: active });
    }

    const users = activeUserIds(now);
    const others = userId ? users.filter(id => id !== userId) : users;
    res.statusCode = 200;
    res.end(JSON.stringify({
      count: others.length,
      active: users.length,
      updatedAt: nowIso
    }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.end(JSON.stringify({ error: err.message || 'Presence API failed.' }));
  }
};
