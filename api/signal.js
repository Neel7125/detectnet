// ─────────────────────────────────────────────────────────────────
//  /api/signal.js  — Vercel Serverless Signaling (LEGACY)
//
//  The main DetectNet app uses WebSocket relay (server.js on
//  Railway/Render). This HTTP poll endpoint is a legacy fallback.
//
//  Redis is REQUIRED — no in-memory fallback. Vercel serverless
//  instances do not share memory; without Redis, host and clients
//  on different instances silently never see each other's messages.
//
//  Set in Vercel dashboard → Environment Variables:
//    UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
//    UPSTASH_REDIS_REST_TOKEN = xxxxx
// ─────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);
const TTL         = 3600; // 1 hour — orphaned sessions auto-expire

// ── Upstash Redis helpers — uses POST JSON body (correct REST API) ─
async function redisExec(command) {
  // command is an array e.g. ['SET', 'key', 'value', 'EX', '3600']
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
  const raw = await redisExec(['GET', key]);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch(e) { return null; }
}

async function redisSet(key, val) {
  // Always set EX TTL so ghost sessions never linger past 1 hour
  await redisExec(['SET', key, JSON.stringify(val), 'EX', String(TTL)]);
}

async function redisDel(key) {
  await redisExec(['DEL', key]);
}

// ── Main handler ──────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Fail hard without Redis — in-memory fallback is broken on Vercel
  // (host/client land on different instances and never exchange msgs).
  if (!USE_REDIS) {
    res.status(503).json({
      ok: false,
      error: 'Signaling requires Upstash Redis. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, or use the WebSocket server (server.js) instead.',
    });
    return;
  }

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
