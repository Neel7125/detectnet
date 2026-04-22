// ═══════════════════════════════════════════════════════════════
//  DetectNet Pro — WebSocket SFU/Relay Server
//  Deploy on Railway / Render / any Node host (free tier works)
//  All signaling + frame relay goes through this server.
//  No WebRTC P2P needed — pure WebSocket, works on any network.
// ═══════════════════════════════════════════════════════════════
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const PORT = process.env.PORT || 3001;

// ── Session store ─────────────────────────────────────────────
// sessions[code] = { hostWs, clients: Map<clientId, ws> }
const sessions = new Map();

const httpServer = createServer((req, res) => {
  // Health check endpoint
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DetectNet WS Server OK');
});

const wss = new WebSocketServer({ server: httpServer });

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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    const { type, code, clientId, data } = msg;

    // ── HOST: create session ──────────────────────────────────
    if (type === 'host-create') {
      ws._id = clientId;
      ws._code = code;
      ws._role = 'host';
      sessions.set(code, { hostWs: ws, hostId: clientId, clients: new Map() });
      send(ws, { type: 'host-ready', code });
      console.log(`[+] Session created: ${code} by ${clientId}`);
      return;
    }

    // ── CLIENT: join session ──────────────────────────────────
    if (type === 'client-join') {
      const session = sessions.get(code);
      if (!session) { send(ws, { type: 'error', msg: 'Session not found. Check the code.' }); return; }
      ws._id = clientId;
      ws._code = code;
      ws._role = 'client';
      session.clients.set(clientId, ws);
      send(ws, { type: 'joined', hostId: session.hostId });
      // Notify host
      send(session.hostWs, { type: 'client-joined', clientId });
      console.log(`[+] Client ${clientId} joined session ${code}`);
      return;
    }

    // ── RELAY: any message to a specific target ───────────────
    if (type === 'relay') {
      const session = sessions.get(ws._code);
      if (!session) return;
      const { to, payload } = data;
      // Find target ws
      let targetWs = null;
      if (session.hostId === to) targetWs = session.hostWs;
      else targetWs = session.clients.get(to);
      if (targetWs) send(targetWs, { type: 'relay', from: ws._id, payload });
      return;
    }

    // ── FRAME: host → specific client (SFU relay) ────────────
    if (type === 'frame') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      const targetWs = session.clients.get(data.to);
      if (targetWs) send(targetWs, { type: 'frame', ts: data.ts, jpg: data.jpg, fw: data.fw, fh: data.fh });
      return;
    }

    // ── RESULT: client → host ─────────────────────────────────
    if (type === 'result') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'client') return;
      send(session.hostWs, { type: 'result', from: ws._id, ts: data.ts, dets: data.dets, fw: data.fw, fh: data.fh });
      return;
    }

    // ── HEALTH: client → host ─────────────────────────────────
    if (type === 'health') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'client') return;
      send(session.hostWs, { type: 'health', from: ws._id, h: data.h });
      return;
    }

    // ── STATS: host → all clients ─────────────────────────────
    if (type === 'stats') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      for (const cws of session.clients.values()) send(cws, { type: 'stats', stats: data.stats });
      return;
    }

    // ── CFG: host → specific client ───────────────────────────
    if (type === 'cfg') {
      const session = sessions.get(ws._code);
      if (!session || ws._role !== 'host') return;
      const targetWs = session.clients.get(data.to);
      if (targetWs) send(targetWs, { type: 'cfg', sched: data.sched });
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
      sessions.delete(ws._code);
      console.log(`[-] Session destroyed: ${ws._code}`);
    } else if (ws._role === 'client') {
      session.clients.delete(ws._id);
      send(session.hostWs, { type: 'client-left', clientId: ws._id });
      console.log(`[-] Client ${ws._id} left session ${ws._code}`);
    }
  });

  ws.on('error', (e) => console.error('[ws error]', e.message));
});

httpServer.listen(PORT, () => console.log(`DetectNet WS server running on port ${PORT}`));
