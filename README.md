# DetectNet Pro

A distributed, real-time object detection system that splits AI inference work across multiple devices using a WebSocket relay server and four task-scheduling algorithms running simultaneously.

---

## What it does

One device acts as the **Host** — it streams a live camera feed, uploads a video, or records a clip. Connected **Client** devices receive frames over WebSocket, run on-device COCO-SSD object detection (via TensorFlow.js), and report results back. The host aggregates detections and compares the performance of all four schedulers side-by-side.

<img width="1280" height="853" alt="image" src="https://github.com/user-attachments/assets/98a4791f-6968-4285-af0f-7416135e822c" />



---

## Architecture

### Transport
All communication goes through a **WebSocket relay server** (`server.js`) hosted on Railway. No WebRTC or P2P — pure WebSocket, works across any network (4G, different WiFi, different countries).

### Logging & Analytics
All frames, packets, and energy consumption are logged with Wireshark-style precision:
- **Frame Event Log**: Tracks every frame lifecycle (dispatch → relay → detect → result)
- **Network Override**: Full packet capture (TX/RX) with success/fail status for every WebSocket message
- **Energy (KJ)**: Per-device × per-scheduler energy consumption matrix

Export buttons generate `.txt` reports with complete analytics:
- Success rates (global, per-scheduler, per-device)
- CPU utilization patterns (which schedulers picked high-load vs low-load devices)
- Energy consumption matrix (device × scheduler in Kilojoules) — E_total, compute, and network separately
- Full packet log (seq#, timestamp, direction, type, bytes, scheduler, device, status)

Methodology for energy: [ENERGY_MODEL.md](ENERGY_MODEL.md).

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
| Battery | Battery Status API (Android Chrome) | N/A on iOS (no calibration) |
| CPU free | requestAnimationFrame jank detector | Works everywhere |
| Network | Measured frame RTT (score) + `effectiveType` | Coarse `downlink` shown as estimate only |
| FPS | Detection frames / elapsed seconds | Real data always |
| Mem free | `performance.memory` heap ratio | Fixed 50% on iOS |
| Energy | Hybrid: Fan linear compute + tail-energy network (battery-calibrated when available) | See ENERGY_MODEL.md |

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
├── ENERGY_MODEL.md     ← Hybrid energy methodology & citations
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
- **Signaling** — WebSocket relay (`server.js`). Legacy HTTP `/api/signal` requires Upstash Redis (no in-memory fallback).
- **Hosting** — Vercel (frontend) + Railway or Render (WS server)
- **Node.js** — v18+

---

## Requirements

- Node.js 18+
- A modern browser with WebSocket support (Chrome on Android recommended for full health metrics)
- Camera permission for live streaming
