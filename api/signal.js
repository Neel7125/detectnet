// ─────────────────────────────────────────────────────────────────
//  /api/signal.js  — Vercel Serverless Signaling
//
//  Storage strategy (pick ONE by setting env vars):
//
//  Option A — Upstash Redis (recommended, free tier, works globally)
//    Set in Vercel dashboard:
//      UPSTASH_REDIS_REST_URL  = https://xxx.upstash.io
//      UPSTASH_REDIS_REST_TOKEN = xxxxx
//
//  Option B — No env vars set → falls back to global in-memory
//    Works on a single Vercel instance (good enough for demos
//    where host + clients hit the same region/instance).
//    Sessions expire after 30 min of inactivity.
// ─────────────────────────────────────────────────────────────────

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const USE_REDIS   = !!(REDIS_URL && REDIS_TOKEN);
const TTL         = 1800; // 30 min session lifetime

// ── In-memory fallback ────────────────────────────────────────────
if (!global._dn_sessions) global._dn_sessions = new Map();
const MEM = global._dn_sessions;

// ── Upstash Redis helpers (pure fetch, no SDK) ────────────────────
async function redisCmd(...args) {
  const res = await fetch(`${REDIS_URL}/${args.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const j = await res.json();
  return j.result;
}
async function redisGet(key)          { return USE_REDIS ? JSON.parse(await redisCmd('GET', key) || 'null') : MEM.get(key) || null; }
async function redisSet(key, val)     { const s=JSON.stringify(val); if(USE_REDIS) await redisCmd('SET',key,s,'EX',TTL); else { MEM.set(key,val); setTimeout(()=>MEM.delete(key),TTL*1000); } }
async function redisDel(key)          { if(USE_REDIS) await redisCmd('DEL',key); else MEM.delete(key); }
async function redisExpire(key)       { if(USE_REDIS) await redisCmd('EXPIRE',key,TTL); }

// ── Cleanup stale sessions from in-memory (every 10 min) ─────────
if (!USE_REDIS && !global._dn_cleanup) {
  global._dn_cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k,v] of MEM.entries()) {
      if (now - (v.ts||0) > TTL*1000) MEM.delete(k);
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
    // Vercel sometimes needs manual JSON parse
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e) {} }
  } else {
    body = req.query || {};
  }

  const { action, code, clientId, data } = body;
  if (!action || !code) { res.status(400).json({ ok:false, error:'Missing action or code' }); return; }

  const KEY = `dn:${code}`;

  // ── CREATE (host registers session) ──────────────────────────────
  if (action === 'create') {
    await redisSet(KEY, { hostId: clientId, msgs: [], ts: Date.now() });
    res.json({ ok: true });
    return;
  }

  // ── JOIN (client joins, notifies host) ───────────────────────────
  if (action === 'join') {
    const sess = await redisGet(KEY);
    if (!sess) { res.json({ ok: false, error: 'Session not found. Check the code.' }); return; }
    // Push join message for host to pick up
    sess.msgs.push({ to: sess.hostId, from: clientId, type: 'join', ts: Date.now() });
    if (sess.msgs.length > 300) sess.msgs = sess.msgs.slice(-300);
    sess.ts = Date.now();
    await redisSet(KEY, sess);
    if (USE_REDIS) await redisExpire(KEY);
    res.json({ ok: true, hostId: sess.hostId });
    return;
  }

  // ── POST (send a signaling message: offer / answer / ice) ────────
  if (action === 'post') {
    const sess = await redisGet(KEY);
    if (!sess) { res.json({ ok: false }); return; }
    if (!data || !data.to || !data.type) { res.json({ ok: false, error: 'Bad data' }); return; }
    sess.msgs.push({ to: data.to, from: clientId, type: data.type, payload: data.payload, ts: Date.now() });
    if (sess.msgs.length > 300) sess.msgs = sess.msgs.slice(-300);
    sess.ts = Date.now();
    await redisSet(KEY, sess);
    res.json({ ok: true });
    return;
  }

  // ── POLL (get messages for this clientId since timestamp) ────────
  if (action === 'poll') {
    const sess = await redisGet(KEY);
    if (!sess) { res.json({ ok: false, msgs: [] }); return; }
    const since = parseInt(body.since || '0');
    const msgs  = sess.msgs.filter(m => m.ts > since && (m.to === clientId || m.to === '*'));
    const now   = Date.now();
    res.json({ ok: true, msgs, ts: now });
    return;
  }

  // ── DESTROY (host ends session) ───────────────────────────────────
  if (action === 'destroy') {
    await redisDel(KEY);
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ ok: false, error: 'Unknown action: ' + action });
}
