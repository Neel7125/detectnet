# DetectNet Pro

A distributed, real-time object detection system that splits AI inference work across multiple devices using a WebSocket relay server and four task-scheduling algorithms running simultaneously.

---

## What it does

One device acts as the **Host** — it streams a live camera feed, uploads a video, or records a clip. Connected **Client** devices receive frames over WebSocket, run on-device COCO-SSD object detection (via TensorFlow.js), and report results back. The host aggregates detections and compares the performance of all four schedulers side-by-side.

```
Host Device                  WS Server (Railway/Render)         Client Devices
(camera / video)             ─────────────────────────          (any phone/browser)
      │                               │                                │
      ├── host-create ───────────────►│                                │
      │                               │◄─── client-join ──────────────┤
      │                               ├─── joined ────────────────────►│
      │◄── client-joined ─────────────┤                                │
      │                               │                                │
      ├── frame (jpg + sched) ────────►│─── frame ─────────────────────►│
      │                               │◄── result (dets + metrics) ────┤
      │◄── result ────────────────────┤                                │
      │                               │◄── sched-result (per-sched) ───┤
      └──────────── Scheduler Results Table ──────────────────────────┘
```

---

## Architecture

### Transport
All communication goes through a **WebSocket relay server** (`server.js`) hosted on Railway. No WebRTC or P2P — pure WebSocket, works across any network (4G, different WiFi, different countries).

### Schedulers
All four schedulers run **simultaneously** on every frame batch. Each one independently decides which client gets which frame based on device health scores.

| Scheduler | Strategy |
|-----------|----------|
| Greedy | Picks the client with the best health score right now |
| PSO | Particle Swarm Optimization — swarm-based load balancing |
| MOMPSO | Multi-Objective PSO — balances latency, energy, and CPU |
| MOMPSO-GA | PSO + Genetic Algorithm crossover for adaptive scheduling |

### Health Metrics (reported by each client)

| Metric | Source | Fallback |
|--------|--------|----------|
| Battery | Battery Status API (Android Chrome) | N/A on iOS |
| CPU free | requestAnimationFrame jank detector | Works everywhere |
| Network | `navigator.connection.downlink` (Mbps) | Latency-derived |
| FPS | Detection frames / elapsed seconds | Real data always |
| Mem free | `performance.memory` heap ratio | Fixed 50% on iOS |

---

## File Structure

```
detectnet-pro/
├── public/
│   ├── index.html      ← Full frontend (HTML + CSS + JS, single file)
│   └── results.js      ← Scheduler result tracking & rendering module
├── api/
│   └── signal.js       ← Vercel serverless signaling (in-memory fallback)
├── server.js           ← WebSocket SFU relay server (Railway / Render)
├── vercel.json         ← Vercel routing, headers, function config
├── Procfile            ← For Railway / Render deployment
├── package.json
└── README.md
```

---

## Deployment

### Frontend → Vercel

1. Push to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo
3. Click **Deploy** — no config needed

### WebSocket Server → Railway

The `server.js` relay needs a persistent Node.js host. Vercel serverless doesn't support WebSockets.

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Railway auto-detects the `Procfile` and runs `node server.js`
3. Once deployed, copy the Railway public URL
4. Update the WebSocket URL in `public/index.html` to point to your Railway server

---

## How to Use

### Host a Session
1. Open the app → tap **Host Session**
2. Choose a video source:
   - **Live** — streams your camera in real time
   - **Upload** — pick a video file (MP4, MOV, WebM)
   - **Record** — record a clip then send it
3. Share the 6-character session code with clients
4. Watch detections and scheduler results come in

### Join a Session
1. Open the app on another device → tap **Join Session**
2. Wait for the COCO-SSD model to load (~5–10s on first load)
3. Enter the 6-character code → tap **Connect to Session**
4. The device will start receiving and processing frames automatically

---

## Tech Stack

- **Frontend** — Vanilla JS, HTML5, CSS (no framework)
- **AI Model** — TensorFlow.js + COCO-SSD (80 object classes, runs fully on-device)
- **Transport** — WebSocket (`ws` library)
- **Signaling** — Vercel Serverless Functions + Upstash Redis
- **Hosting** — Vercel (frontend/API) + Railway or Render (WS server)
- **Node.js** — v18+

---

## Requirements

- Node.js 18+
- A modern browser with WebSocket support (Chrome on Android recommended for full health metrics)
- Camera permission for live streaming
