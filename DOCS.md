# DetectNet Pro — Documentation

## Table of Contents

1. [What is DetectNet Pro](#what-is-detectnet-pro)
2. [How It Works](#how-it-works)
3. [Architecture](#architecture)
4. [File Structure](#file-structure)
5. [Deployment](#deployment)
6. [Using the App](#using-the-app)
7. [Schedulers](#schedulers)
8. [Health Metrics](#health-metrics)
9. [Video Source Modes](#video-source-modes)
10. [Results Table](#results-table)
11. [WebSocket Message Protocol](#websocket-message-protocol)
12. [Configuration](#configuration)
13. [Tech Stack](#tech-stack)
14. [Known Limitations](#known-limitations)

---

## What is DetectNet Pro

DetectNet Pro is a distributed real-time object detection system that runs entirely in the browser. One device (the **Host**) streams or uploads video and distributes frames to connected devices (the **Clients**) over WebSocket. Each client runs on-device AI inference using TensorFlow.js + COCO-SSD and reports results back. The host aggregates detections and benchmarks four task-scheduling algorithms side by side.

No installation. No native app. No WebRTC. Works across any network — 4G, different WiFi, different countries.

---

## How It Works

```
Host Device                  WS Server (Railway)              Client Devices
(camera / video)             ─────────────────────            (any phone/browser)
      │                               │                                │
      ├── host-create ───────────────►│                                │
      │                               │◄─── client-join ──────────────┤
      │                               ├─── joined ────────────────────►│
      │◄── client-joined ─────────────┤                                │
      │                               │                                │
      ├── frame (jpg + sched) ────────►│─── frame ─────────────────────►│
      │                               │◄── result (dets + metrics) ────┤
      │◄── result ────────────────────┤                                │
      └──────────── Scheduler Results Table ──────────────────────────┘
```

1. Host creates a session → gets a 6-character code
2. Clients enter the code → join the session
3. Host captures frames from camera/video → dispatches each frame 4 times, once per scheduler
4. Each client receives frames, runs COCO-SSD detection, sends results + latency back
5. Host aggregates results and renders the scheduler comparison table live

---

## Architecture

### Transport

All communication goes through a **WebSocket relay server** (`server.js`) hosted on Render (or Fly.io / Koyeb). The server is a pure message broker — it never processes video or runs inference. It only routes messages between the host and clients.

The server maintains a session store (`Map`) where each session holds:
- `hostWs` — the host's WebSocket connection
- `clients` — a Map of `clientId → WebSocket`

A heartbeat runs every 25 seconds to ping all connections and drop dead ones. This also prevents Render from sleeping the server (on paid tiers; free tier still sleeps after 15min).

### Frontend

The entire frontend is a single `index.html` file (1,443 lines). All CSS, HTML, and JavaScript are inlined — this is intentional because Vercel's serverless rewrites block external `.js` files.

Three screens exist, toggled by a CSS class:
- `#home` — landing page
- `#srvScr` — host dashboard
- `#cliScr` — client worker

All runtime state lives in a single global object `S`.

### Signaling Fallback

`api/signal.js` is a legacy Vercel serverless HTTP poll endpoint. It **requires** Upstash Redis (`EX 3600` TTL on every write). There is no in-memory fallback — without Redis it returns 503. The main app uses the WebSocket server directly and should not depend on this endpoint.

---

## File Structure

```
detectnet-pro/
├── public/
│   ├── index.html      ← Full frontend (HTML + CSS + JS, single file)
│   └── results.js      ← Scheduler result tracking module (reference copy)
├── api/
│   └── signal.js       ← Vercel serverless signaling endpoint
├── server.js           ← WebSocket relay server (Railway / Render)
├── vercel.json         ← Vercel routing + security headers
├── Procfile            ← Railway / Render process definition
├── package.json        ← Node.js manifest (only dependency: ws)
└── README.md
```

---

## Deployment

### Frontend → Vercel

1. Push the repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) and import the repo
3. Click **Deploy** — no build config needed

`vercel.json` handles routing (all paths → `index.html`) and sets security headers:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Permissions-Policy: camera=*, microphone=()`

### WebSocket Server → Render (recommended free option)

Vercel serverless does not support persistent WebSocket connections. The relay server needs a separate persistent host.

1. Go to [render.com](https://render.com) → New → **Web Service**
2. Connect your GitHub repo
3. Set the following:
   - **Environment**: `Node`
   - **Build Command**: *(leave blank)*
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
4. Click **Create Web Service** — Render detects the `Procfile` automatically
5. Wait for the deploy to finish, then copy your service URL (e.g. `your-app-name.onrender.com`)
6. Update `WS_URL` in `public/index.html`:

```js
const WS_URL = 'wss://your-app-name.onrender.com';
```

7. Redeploy the Vercel frontend (or just push to GitHub if auto-deploy is on)

> **Note:** Render free tier spins down after 15 minutes of inactivity. The first connection after sleep takes ~30 seconds. If this is a problem, use Fly.io or Koyeb (both have always-on free tiers).

### Alternative: Fly.io (always-on free tier)

1. Install the Fly CLI: `npm install -g flyctl`
2. Run `flyctl auth login`
3. From the `detectnet/` folder: `flyctl launch` — accept defaults, choose a region
4. Deploy: `flyctl deploy`
5. Your URL will be `wss://your-app-name.fly.dev`
6. Update `WS_URL` in `public/index.html` to that URL

### Alternative: Koyeb (always-on free tier)

1. Go to [koyeb.com](https://koyeb.com) → Create App → GitHub
2. Select the repo, set **Run command** to `node server.js`
3. Your URL will be `wss://your-app-name.koyeb.app`
4. Update `WS_URL` in `public/index.html` to that URL

### Optional: Upstash Redis (legacy HTTP signaling only)

The main app uses WebSocket (`server.js`) and does **not** need Redis. If you still use the legacy `/api/signal` HTTP poll endpoint:

1. Create a free database at [upstash.com](https://upstash.com)
2. Add to Vercel environment variables:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

Redis is **required** for that endpoint — there is no in-memory fallback (silent failure across Vercel instances). Session keys expire after **1 hour** (`EX 3600`).

---

## Using the App

### Host a Session

1. Open the app → tap **Host Session**
2. Wait for the session code to appear (connects to the relay server)
3. Choose a video source — Live, Upload, or Record
4. Share the 6-character code with clients
5. Watch detections and scheduler results populate in real time

### Join a Session

1. Open the app on another device → tap **Join Session**
2. Wait for the COCO-SSD model to finish loading (~5–10s on first load)
3. Enter the 6-character code → tap **Connect to Session**
4. The device starts receiving and processing frames automatically

### Session Codes

Codes are 6 characters, uppercase alphanumeric. Visually ambiguous characters (O, 0, I, 1) are excluded so codes are easy to read and share verbally.

---

## Schedulers

All four schedulers run **simultaneously** on every frame. Each frame is dispatched four times — once per scheduler — each tagged with the scheduler name. This lets the host measure and compare all four algorithms on identical workloads.

### Greedy

Picks the client with the highest health score at the current moment. Simple, fast, locally optimal. Serves as the baseline.

```
winner = argmax(hScore(client)) over all clients
```

### PSO — Particle Swarm Optimization

Runs a lightweight PSO with 8 particles and 6 iterations. Each particle is a weight vector over client health scores. Uses standard PSO update equations:

```
v = 0.72*v + 1.49*rand*(pbest - x) + 1.49*rand*(gbest - x)
```

The particle with the highest global best position selects the client.

### MOMPSO — Multi-Objective PSO

Balances three competing objectives:

| Objective | Weight | Direction |
|-----------|--------|-----------|
| Health score | 0.5 | maximize |
| Recent avg latency (last 5 frames) | 0.3 | minimize |
| Pending frame queue depth | 0.2 | minimize |

Picks the client maximizing the composite score.

### MOMPSO-GA — PSO + Genetic Algorithm

Adds a genetic crossover step. Scores all clients, blends the top two with a 70/30 ratio, adds a small random mutation (±0.04), and picks the client closest to the blended value. Introduces controlled stochasticity to avoid local optima.

---

## Health Metrics

Clients measure and report five metrics every **2 seconds** (fixed interval, decoupled from frame throughput). The host uses these to drive scheduler decisions.

| Metric | Source | iOS Support |
|--------|--------|-------------|
| Battery | Battery Status API | ✗ N/A |
| CPU free | rAF jank detector + sync benchmark | ✓ |
| Network | RTT-derived score (scheduling); `effectiveType` + coarse downlink (display) | Partial |
| FPS | frames processed / elapsed time | ✓ |
| Memory free | `performance.memory` heap ratio | ✗ Fixed 50% |

### Health Score Formula

```
score = battery*0.20 + cpuFree*0.28 + throughput*0.32 + fps*0.22 + 1/(1+pending)*0.18
```

Battery weight (0.20) is redistributed proportionally to the other metrics when unavailable (iOS).

The score is displayed as a 0–100 point value on the client screen and used by all schedulers to rank clients.

### CPU Measurement

Two methods run in parallel:
- **Async (rAF)**: measures the gap between animation frames — a gap larger than 16ms indicates CPU pressure
- **Sync benchmark**: runs 8,000 `Math.sqrt()` calls and measures execution time

### Network Measurement

Scheduling uses **measured frame RTT** for the throughput score. `navigator.connection.downlink` is shown in the UI as a coarse estimate only (browser buckets: 0.5/1/2/10 Mbps) and is not used as a research bandwidth metric.

---

## Video Source Modes

### Live Camera

Streams the rear-facing camera using `getUserMedia`. Frames are captured every 220ms via `setInterval` and JPEG-encoded at 50% quality before dispatch.

Resolution options:
- 240p (426×240)
- 480p (854×480) — default
- 720p (1280×720)

Changing resolution while streaming stops and restarts the camera automatically.

### Upload

Accepts MP4, MOV, and WebM files. After loading:
1. The video duration is read and total frames estimated at 30fps
2. User selects how many frames to extract (default: min(100, total))
3. Frames are extracted at evenly-spaced timestamps using a hidden off-screen video element
4. Each frame is captured at 854×480 at 70% JPEG quality
5. Frames are dispatched with a 30ms delay between each

Frame extraction uses `requestVideoFrameCallback` on Chrome/Android for precise timing, falling back to double `requestAnimationFrame` after each seek on other browsers. A 6-second timeout per frame prevents hangs on problematic video files.

### Record

Records a clip using the MediaRecorder API (WebM format), then extracts 60 frames from the recording and dispatches them with a 45ms inter-frame delay. The recording can also be saved locally as a `.webm` file.

---

## Results Table

After frames are processed, the host renders a comparison table:

| Column | Description |
|--------|-------------|
| Scheduler | Algorithm name |
| Compl. Time (s) | Average completion time = avg latency / 1000 |
| Latency (ms) | Average round-trip latency across all clients |
| Energy (KJ) | Device power-model W × completion time / 1000 |

A TOTAL row sums all schedulers. A per-client frame distribution bar shows how many frames each client processed.

The table updates live as results arrive. Energy uses a per-device active-wattage lookup (not the Battery API).

> **Note:** The `results.js` file and the `RES` module are present in the codebase but the host currently ignores `sched-result` messages from clients and recomputes everything from raw `result` latency data directly.

---

## WebSocket Message Protocol

All messages are JSON. The server routes them based on `type`.

### Host → Server

| Type | Fields | Description |
|------|--------|-------------|
| `host-create` | `code`, `clientId` | Create a new session |
| `frame` | `code`, `data.to`, `data.jpg`, `data.fw`, `data.fh`, `data.ts`, `data.sched` | Send a frame to a specific client |
| `cfg` | `data.to`, `data.sched` | Send config to a client |
| `stats` | `data.stats` | Broadcast stats to all clients |
| `ping` | — | Keepalive |

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `client-join` | `code`, `clientId` | Join a session |
| `result` | `data.ts`, `data.dets`, `data.fw`, `data.fh`, `data.sched` | Send detection results to host |
| `sched-result` | `data` | Send per-scheduler averages to host |
| `health` | `data.h` | Send health metrics to host |
| `ping` | — | Keepalive |

### Server → Client/Host

| Type | Fields | Description |
|------|--------|-------------|
| `host-ready` | `code` | Session created successfully |
| `joined` | `hostId` | Client joined successfully |
| `client-joined` | `clientId` | Notifies host a client connected |
| `client-reconnected` | `clientId` | Notifies host a prior client rejoined (same clientId) |
| `client-left` | `clientId` | Notifies host a client disconnected |
| `host-left` | — | Notifies clients the host ended the session |
| `frame` | `jpg`, `ts`, `fw`, `fh`, `sched` | Frame delivered to client |
| `result` | `from`, `ts`, `dets`, `fw`, `fh`, `sched` | Result delivered to host |
| `error` | `msg` | Error message |

---

## Configuration

Constants in `public/index.html`:

| Constant | Default | Description |
|----------|---------|-------------|
| `WS_URL` | Render/Fly.io URL | WebSocket relay server address |
| `DEVICE_POWER_TABLE` | UA/name lookups | Active wattage per device class for energy (KJ) |
| `DEFAULT_PHONE_W` | `4.0` | Fallback active watts when device is unknown |
| `HEALTH_MS` | `2000` | Fixed health + sched-result interval (decoupled from frames) |
| `CAPTURE_MS` | `220` | Frame capture interval in milliseconds (~4.5 fps) |
| `RESMAP` | 240/480/720p | Resolution presets for live camera |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS, HTML5, CSS — no framework, no build step |
| AI Model | TensorFlow.js 4.10.0 + COCO-SSD 2.2.2 (80 classes, on-device) |
| Transport | WebSocket (`ws` v8.17.1) |
| Signaling | Vercel Serverless + Upstash Redis (optional) |
| Frontend host | Vercel |
| WS server host | Render / Fly.io / Koyeb |
| Runtime | Node.js 18+ |

---

## Known Limitations

**Energy is model-based.** Wattage comes from a device lookup table (name/UA → active W), not from the Battery Status API (which has no power reading). Values are defensible for relative scheduler comparisons but are not lab-grade calorimetry.

**Battery unavailable on iOS.** The Battery Status API is not supported on iOS Safari. Battery is excluded from health scoring on those devices.

**`navigator.connection.downlink` is coarse.** It returns rounded buckets (0.5/1/2/10 Mbps) and is labeled as an estimate. Scheduling uses RTT-derived throughput instead.

**`performance.memory` is Chrome-only.** Memory metrics fall back to a fixed 50% on Firefox and Safari.

**PSO convergence.** The PSO runs only 6 iterations with 8 particles for real-time performance. It is a heuristic approximation, not a converged solution.

**Single relay server.** All traffic routes through one WebSocket server. There is no horizontal scaling or failover. For high client counts or high frame rates, the relay server becomes the bottleneck.

**Frame counter display.** The client displays `frDone / 4` because each video frame is sent four times (once per scheduler). The raw internal counter is 4× the actual unique video frames processed.

**`results.js` is not loaded.** The `public/results.js` file exists as a reference/development copy but is not included by `index.html`. The inline `RES` module inside the HTML is what actually runs.
