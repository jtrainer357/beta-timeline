const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  // CORS — allows local file:// version to call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const tab = req.query.tab || 'syd';
  const key = `gantt:${tab}`;

  if (req.method === 'GET') {
    try {
      const state = await kv.get(key);
      if (state) {
        return res.status(200).json(state);
      }
      return res.status(204).end();
    } catch (e) {
      return res.status(500).json({ error: 'Failed to read state' });
    }
  }

  if (req.method === 'POST') {
    try {
      await kv.set(key, req.body);
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to save state' });
    }
  }

  return res.status(405).end();
};
