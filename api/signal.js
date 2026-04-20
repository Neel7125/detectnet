// ─────────────────────────────────────────────────────────────────
//  /api/signal.js  — Vercel Serverless Signaling
//
//  Storage: Upstash Redis (recommended) OR in-memory fallback
//
//  Set in Vercel dashboard → Environment Variables:
//    UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
//    UPSTASH_REDIS_REST_TOKEN = xxxxx
// ─────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);
const TTL         = 1800; // 30 min

// ── In-memory fallback ────────────────────────────────────────────
if (!global._dn_sessions) global._dn_sessions = new Map();
const MEM = global._dn_sessions;

// ── Upstash Redis helpers — uses POST JSON body (correct REST API) ─
async function redisExec(command) {
  // command is an array e.g. ['SET', 'key', 'value', 'EX', '1800']
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Redis error ${res.status}: ${txt}`);
  }
  const j = await res.json();
  return j.result;
}

async function redisGet(key) {
  if (!USE_REDIS) return MEM.get(key) || null;
  const raw = await redisExec(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

async function redisSet(key, val) {
  const s = JSON.stringify(val);
  if (USE_REDIS) {
    await redisExec(['SET', key, s, 'EX', String(TTL)]);
  } else {
    MEM.set(key, val);
    setTimeout(() => MEM.delete(key), TTL * 1000);
  }
}

async function redisDel(key) {
  if (USE_REDIS) await redisExec(['DEL', key]);
  else MEM.delete(key);
}

// ── Cleanup stale in-memory sessions ─────────────────────────────
if (!USE_REDIS && !global._dn_cleanup) {
  global._dn_cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of MEM.entries()) {
      if (now - (v.ts || 0) > TTL * 1000) MEM.delete(k);
    }
  }, 600_000);
}

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Parse body or query
  let body = {};
  if (req.method === 'POST') {
    body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch(e) {}
    }
  } else {
    body = req.query || {};
  }

  const { action, code, clientId, data } = body;
  if (!action || !code) {
    res.status(400).json({ ok: false, error: 'Missing action or code' });
    return;
  }

  const KEY = `dn:${code}`;

  try {

    // ── CREATE ──────────────────────────────────────────────────────
    if (action === 'create') {
      await redisSet(KEY, { hostId: clientId, msgs: [], ts: Date.now() });
      res.json({ ok: true });
      return;
    }

    // ── JOIN ────────────────────────────────────────────────────────
    if (action === 'join') {
      const sess = await redisGet(KEY);
      if (!sess) {
        res.json({ ok: false, error: 'Session not found. Check the code.' });
        return;
      }
      sess.msgs.push({ to: sess.hostId, from: clientId, type: 'join', ts: Date.now() });
      if (sess.msgs.length > 300) sess.msgs = sess.msgs.slice(-300);
      sess.ts = Date.now();
      await redisSet(KEY, sess);
      res.json({ ok: true, hostId: sess.hostId });
      return;
    }

    // ── POST (offer / answer / ice) ─────────────────────────────────
    if (action === 'post') {
      const sess = await redisGet(KEY);
      if (!sess) { res.json({ ok: false, error: 'Session not found' }); return; }
      if (!data || !data.to || !data.type) {
        res.json({ ok: false, error: 'Bad data' });
        return;
      }
      sess.msgs.push({
        to: data.to,
        from: clientId,
        type: data.type,
        payload: data.payload,
        ts: Date.now(),
      });
      if (sess.msgs.length > 300) sess.msgs = sess.msgs.slice(-300);
      sess.ts = Date.now();
      await redisSet(KEY, sess);
      res.json({ ok: true });
      return;
    }

    // ── POLL ────────────────────────────────────────────────────────
    if (action === 'poll') {
      const sess = await redisGet(KEY);
      if (!sess) { res.json({ ok: false, msgs: [] }); return; }
      const since = parseInt(body.since || '0', 10);
      const msgs  = sess.msgs.filter(
        m => m.ts > since && (m.to === clientId || m.to === '*')
      );
      res.json({ ok: true, msgs, ts: Date.now() });
      return;
    }

    // ── DESTROY ─────────────────────────────────────────────────────
    if (action === 'destroy') {
      await redisDel(KEY);
      res.json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'Unknown action: ' + action });

  } catch (err) {
    console.error('[signal] error:', err);
    res.status(500).json({ ok: false, error: 'Internal error: ' + err.message });
  }
}
