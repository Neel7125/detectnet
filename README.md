# DetectNet Pro — Vercel Deployment Guide

## Deploy in 5 minutes

### Step 1 — Push to GitHub
```bash
cd detectnet
git init
git add .
git commit -m "init"
git remote add origin https://github.com/YOUR_USERNAME/detectnet.git
git push -u origin main
```

### Step 2 — Import to Vercel
1. Go to https://vercel.com/new
2. Import your GitHub repo
3. Click **Deploy** (no config needed for basic demo)

### Step 3 (Optional but recommended) — Add Upstash Redis
Without Redis, signaling uses in-memory storage which can fail when
Vercel routes host and client to different serverless instances.

**Free setup (~2 min):**
1. Go to https://upstash.com → create free account
2. Create a Redis database (free tier: 10k req/day)
3. Copy **REST URL** and **REST Token**
4. In Vercel dashboard → your project → Settings → Environment Variables:
   ```
   UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
   UPSTASH_REDIS_REST_TOKEN = AxxxxxxxxxxxxxxxxxxxxxxxxxxxA
   ```
5. Redeploy

---

## How it works

```
Any network (4G, WiFi, different countries)
─────────────────────────────────────────────────────────────

Phone A                   Vercel Edge              Phone B
(Host Session)            ───────────              (Join Session)
      │                        │                        │
      ├── POST /api/signal ────►│ create session         │
      │   action=create         │ store in Redis/memory  │
      │                        │                        │
      │                        │◄── POST action=join ───┤
      │                        │    store join msg      │
      │                        │                        │
      ├── poll /api/signal ────►│ get join msg           │
      │   see "join" from B     │                        │
      │                        │                        │
      ├── POST action=post ────►│ store WebRTC offer     │
      │   offer SDP             │                        │
      │                        │◄── poll ───────────────┤
      │                        │    get offer            │
      │                        │                        │
      │                        │◄── POST action=post ───┤
      │                        │    answer SDP + ICE     │
      ├── poll ────────────────►│ get answer + ICE        │
      │                        │                        │
      └────── WebRTC DataChannel (direct or TURN-relayed) ──────┘
                    frames / detections / health data
```

**Signaling** (session setup): Vercel serverless + Upstash Redis  
**Data** (frames + results): WebRTC DataChannel — direct P2P or free TURN relay  
**Works across**: different WiFi, 4G, different countries

---

## Health Metrics

| Metric     | How measured                              | Fallback          |
|------------|-------------------------------------------|-------------------|
| Battery    | Battery Status API (Android Chrome only)  | Shows N/A on iOS  |
| CPU free   | requestAnimationFrame jank detector       | Works everywhere  |
| Network    | navigator.connection.downlink (Mbps)      | Latency-derived   |
| FPS        | Detection frames / elapsed seconds        | Real data always  |
| Mem free   | performance.memory heap ratio             | Fixed 50% on iOS  |

---

## File structure

```
detectnet/
├── public/
│   └── index.html      ← full frontend app (HTML+CSS+JS, ~55KB)
├── api/
│   └── signal.js       ← serverless signaling (Upstash Redis or in-memory)
├── vercel.json         ← routing + headers + function config
├── package.json
└── README.md
```
