// ═══════════════════════════════════════════════════════════════
//  DetectNet Pro — WebSocket SFU/Relay Server
//  Deploy on Render / Fly.io / Koyeb / any Node host (free tier)
//  All signaling + frame relay goes through this server.
//  No WebRTC P2P needed — pure WebSocket, works on any network.
//
//  Environment variables:
//    PORT  — set automatically by the hosting platform (default 3001)
// ═══════════════════════════════════════════════════════════════
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 3001;

// ── Session store ─────────────────────────────────────────────
// sessions[code] = { hostWs, clients: Map<clientId, ws>, stats: {...} }
const sessions = new Map();

// ── Structured logger ─────────────────────────────────────────
// Every line: ISO_TIMESTAMP  [ROLE/code]  EVENT  key=value ...
function log(role, code, event, data) {
  const ts   = new Date().toISOString();
  const ctx  = `[${role}/${code||'?'}]`;
  const kv   = data ? Object.entries(data).map(([k,v])=>`${k}=${v}`).join(' ') : '';
  const line = `${ts}  ${ctx}  ${event.padEnd(20)}  ${kv}`;
  console.log(line);
}

const httpServer = createServer((req, res) => {
  // Health check endpoint
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DetectNet WS Server OK');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 10 * 1024 * 1024 }); // 10MB max

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }
}

function broadcast(session, obj, excludeWs = null) {
  if (!session) return;
  if (session.hostWs && session.hostWs !== excludeWs) send(session.hostWs, obj);
  for (const ws of session.clients.values()) {
    if (ws !== excludeWs) send(ws, obj);
  }
}

wss.on('connection', (ws) => {
  ws._id = null;
  ws._code = null;
  ws._role = null; // 'host' | 'client'
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    const { type, code, clientId, data } = msg;

    // ── HOST: create session ──────────────────────────────────
    if (type === 'host-create') {
      ws._id = clientId;
      ws._code = code;
      ws._role = 'host';
      sessions.set(code, {
        hostWs: ws,
        hostId: clientId,
        clients: new Map(),
        stats: { framesSent: 0, resultsReceived: 0, expResets: 0, createdAt: Date.now() }
      });
      send(ws, { type: 'host-ready', code });
      log('HOST', code, 'SESSION_CREATED', { hostId: clientId });
      return;
    }

    // ── CLIENT: join session ──────────────────────────────────
    if (type === 'client-join') {
      const session = sessions.get(code);
      if (!session) {
        send(ws, { type: 'error', msg: 'Session not found. Check the code.' });
        log('CLIENT', code, 'JOIN_FAILED', { clientId, reason: 'session_not_found' });
        return;
      }
      ws._id = clientId;
      ws._code = code;
      ws._role = 'client';
      session.clients.set(clientId, ws);

      // Extract real IP — handle reverse-proxy X-Forwarded-For (Render, Railway, etc.)
      const forwarded = ws._socket && ws._socket._httpMessage && ws._socket._httpMessage.headers
        ? ws._socket._httpMessage.headers['x-forwarded-for']
        : null;
      // ws.upgradeReq is available in some versions; fall back to _socket
      const upgradeHeaders = ws.upgradeReq ? ws.upgradeReq.headers : {};
      const xfwd = upgradeHeaders['x-forwarded-for'] || forwarded || '';
      const rawIp = ws._socket ? ws._socket.remoteAddress : '';
      const ip = (xfwd ? xfwd.split(',')[0].trim() : rawIp)
                   .replace(/^::ffff:/, ''); // strip IPv4-mapped IPv6 prefix

      send(ws, { type: 'joined', hostId: session.hostId });
      // Notify host — include ip and device info from the join message
      send(session.hostWs, {
        type: 'client-joined',
        clientId,
        ip,
        deviceInfo: (data && data.deviceInfo) || ''
      });
      log('CLIENT', code, 'CLIENT_JOINED', { clientId, ip, totalClients: session.clients.size });
      console.log(`\n>>> CLIENT JOINED  code=${code}  id=${clientId}  ip=${ip}  total=${session.clients.size}\n`);
      return;
    }

    // ── RELAY: any message to a specific target ───────────────
    if (type === 'relay') {
      const session = sessions.get(ws._code);
      if (!session) return;
      const { to, payload } = data;
      let targetWs = null;
      if (session.hostId === to) targetWs = session.hostWs;
      else targetWs = session.clients.get(to);
      if (targetWs) send(targetWs, { type: 'relay', from: ws._id, payload });
      return;
    }

    // ── FRAME: host → specific client (SFU relay) ────────────
    if (type === 'frame') {
      const sessionCode = ws._code || code;
      const session = sessions.get(sessionCode);
      if (!session) { log('HOST', sessionCode, 'FRAME_DROP', { reason: 'no_session' }); return; }
      if (ws._role !== 'host') { log('?', sessionCode, 'FRAME_DROP', { reason: 'not_host', role: ws._role }); return; }
      const d = data || {};
      const targetWs = session.clients.get(d.to);
      if (!targetWs) {
        log('HOST', sessionCode, 'FRAME_DROP', { reason: 'client_not_found', to: d.to, sched: d.sched });
        return;
      }
      send(targetWs, { type: 'frame', ts: d.ts, jpg: d.jpg, fw: d.fw, fh: d.fh, sched: d.sched });
      if (session.stats) session.stats.framesSent++;
      log('HOST', sessionCode, 'FRAME_RELAYED', {
        sched:   d.sched,
        to:      d.to,
        ts:      d.ts,
        total:   session.stats ? session.stats.framesSent : '?'
      });
      return;
    }

    // ── RESULT: client → host ─────────────────────────────────
    if (type === 'result') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'client') return;
      const d = data || {};
      send(session.hostWs, { type: 'result', from: ws._id, ts: d.ts, dets: d.dets, fw: d.fw, fh: d.fh, sched: d.sched });
      if (session.stats) session.stats.resultsReceived++;
      log('CLIENT', ws._code, 'RESULT_RELAYED', {
        from:    ws._id,
        sched:   d.sched,
        dets:    (d.dets || []).length,
        ts:      d.ts,
        total:   session.stats ? session.stats.resultsReceived : '?'
      });
      return;
    }

    // ── SCHED-RESULT: client sends per-scheduler averages → host ─
    if (type === 'sched-result') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'client') return;
      const d = data || {};
      send(session.hostWs, { type: 'sched-result', from: ws._id, data: d });
      return;
    }

    // ── EXP-RESET: host broadcasts experiment reset to all clients ─
    if (type === 'exp-reset') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      const d = data || {};
      if (session.stats) session.stats.expResets++;
      // Reset server-side session stats too
      if (session.stats) { session.stats.framesSent = 0; session.stats.resultsReceived = 0; }
      for (const cws of session.clients.values()) {
        send(cws, { type: 'exp-reset', data: d });
      }
      log('HOST', ws._code, 'EXP_RESET', {
        expId:   d.expId,
        resets:  session.stats ? session.stats.expResets : '?',
        clients: session.clients.size
      });
      return;
    }

    // ── HEALTH: client → host ─────────────────────────────────
    if (type === 'health') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'client') return;
      const d = data || {};
      send(session.hostWs, { type: 'health', from: ws._id, h: d.h });
      return;
    }

    // ── STATS: host → all clients ─────────────────────────────
    if (type === 'stats') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      const d = data || {};
      for (const cws of session.clients.values()) send(cws, { type: 'stats', stats: d.stats });
      return;
    }

    // ── CFG: host → specific client ───────────────────────────
    if (type === 'cfg') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      const d = data || {};
      const targetWs = session.clients.get(d.to);
      if (targetWs) send(targetWs, { type: 'cfg', sched: d.sched });
      return;
    }

    // ── PING: keepalive ───────────────────────────────────────
    if (type === 'ping') {
      send(ws, { type: 'pong' });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws._code) return;
    const session = sessions.get(ws._code);
    if (!session) return;

    if (ws._role === 'host') {
      // Host left — notify all clients and destroy session
      for (const cws of session.clients.values()) send(cws, { type: 'host-left' });
      log('HOST', ws._code, 'SESSION_DESTROYED', {
        hostId:          ws._id,
        framesSent:      session.stats ? session.stats.framesSent : '?',
        resultsReceived: session.stats ? session.stats.resultsReceived : '?',
        expResets:       session.stats ? session.stats.expResets : '?',
        uptimeSec:       session.stats ? Math.round((Date.now()-session.stats.createdAt)/1000) : '?'
      });
      sessions.delete(ws._code);
    } else if (ws._role === 'client') {
      session.clients.delete(ws._id);
      send(session.hostWs, { type: 'client-left', clientId: ws._id });
      log('CLIENT', ws._code, 'CLIENT_LEFT', { clientId: ws._id, remaining: session.clients.size });
      console.log(`\n>>> CLIENT LEFT    code=${ws._code}  id=${ws._id}  remaining=${session.clients.size}\n`);
    }
  });

  ws.on('error', (e) => log('?', ws._code||'?', 'WS_ERROR', { msg: e.message }));
});

httpServer.listen(PORT, () => log('SERVER', '-', 'LISTENING', { port: PORT }));

// Heartbeat — ping all clients every 25s, drop dead connections
// Also prevents Railway/Render from sleeping the server
const heartbeat = setInterval(() => {
  let alive = 0, dead = 0;
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); dead++; return; }
    ws.isAlive = false;
    ws.ping();
    alive++;
  });
  if (dead > 0) log('SERVER', '-', 'HEARTBEAT', { alive, dead });
}, 25000);
