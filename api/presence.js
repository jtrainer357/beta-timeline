const PRESENCE_FILE = 'presence.json';
const ACTIVE_WINDOW_MS = 45000;
const VALID_CLIENT_ID = /^[a-zA-Z0-9_-]{8,80}$/;

let memoryPresence = {};

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
    throw new Error(`GitHub presence store failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json();
}

async function readPresence() {
  if (!hasGistStore()) return memoryPresence;
  const gist = await requestGist();
  const file = gist.files?.[PRESENCE_FILE];
  if (!file) return {};
  const content = file.truncated
    ? await (await fetch(file.raw_url, { cache: 'no-store' })).text()
    : file.content;
  return content ? JSON.parse(content) : {};
}

async function writePresence(presence) {
  if (!hasGistStore()) {
    memoryPresence = presence;
    return presence;
  }
  await requestGist('', {
    method: 'PATCH',
    body: JSON.stringify({
      files: {
        [PRESENCE_FILE]: {
          content: JSON.stringify(presence, null, 2)
        }
      }
    })
  });
  return presence;
}

async function readJsonBody(req) {
  if (req.body) {
    return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function activeEntries(presence, now) {
  return Object.entries(presence)
    .filter(([, entry]) => entry?.lastSeen && now - Date.parse(entry.lastSeen) <= ACTIVE_WINDOW_MS);
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

    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    let body = {};
    if (req.method === 'POST') body = await readJsonBody(req);
    const clientId = body.clientId || new URL(req.url, `https://${req.headers.host || 'nitro-gantt.vercel.app'}`).searchParams.get('clientId');
    if (clientId && !VALID_CLIENT_ID.test(clientId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid presence client.' }));
      return;
    }

    const presence = Object.fromEntries(activeEntries(await readPresence(), now));
    if (req.method === 'POST' && clientId) {
      presence[clientId] = {
        lastSeen: nowIso,
        tab: typeof body.tab === 'string' ? body.tab.slice(0, 40) : null
      };
      await writePresence(presence);
    }

    const activeIds = activeEntries(presence, now).map(([id]) => id);
    const others = clientId ? activeIds.filter(id => id !== clientId) : activeIds;
    res.statusCode = 200;
    res.end(JSON.stringify({
      count: others.length,
      active: activeIds.length,
      updatedAt: nowIso
    }));
  } catch (err) {
    res.statusCode = err.statusCode || 500;
    res.end(JSON.stringify({ error: err.message || 'Presence API failed.' }));
  }
};
