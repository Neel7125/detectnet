# DetectNet Pro — Network Override & Energy Logging

## Summary of Changes

All changes made to `public/index.html` (single-file architecture).

---

## 1. Network Override — Wireshark-Style Packet Capture

### NET Module (lines ~947-1074)
A full packet-capture logging system that tracks **every WebSocket message** transmitted in the DetectNet cluster.

**Capabilities:**
- Logs all TX (outgoing) and RX (incoming) packets
- Records: sequence number, timestamp, direction, message type, payload size, scheduler, device, status (OK/SENT/RECV/FAIL/DROP/TIMEOUT)
- Provides real-time in-page panel showing last 200 packets
- Export full packet log as `.txt` file with Wireshark-style table
- Auto-resets on experiment reset

**Instrumentation Points:**
- `wsSend()` — logs every TX packet with size, scheduler, device, success/fail
- `connectWS().onmessage` — logs every RX packet
- `connectWS().onclose` — logs connection drops
- `connectWS().onerror` — logs WS errors

**UI Elements:**
- **Server Screen**: "Network Override" card with toggle button → `netPanel` → `netList`
- **Client Screen**: "Network Override" card with toggle button → `cNetPanel` → `cNetList`
- Export button: downloads full packet log with stats summary (TX/RX counts, success rates, per-scheduler breakdown)

**Download Format:**
```
═══════════════════════════════════════════════════════════════
  DETECTNET PRO — NETWORK OVERRIDE / FULL PACKET CAPTURE
  Generated : 2026-07-08T...
  Device    : Device Name
  Packets   : 482
═══════════════════════════════════════════════════════════════

  ┌─ PACKET STATISTICS ──────────────────────────────────────
  │  Total packets captured  : 482
  │  TX (sent)    OK/FAIL    : 240 / 2  (1245678 bytes)
  │  RX (recv)    OK/FAIL    : 238 / 2  (956432 bytes)
  │  Dropped / Lost          : 4
  │  Success Rate            : 99.2%
  │
  │  Packet type breakdown:
  │    frame                 120 pkts
  │    result                120 pkts
  │    health                 80 pkts
  │    ping                   40 pkts
  └──────────────────────────────────────────────────────────

  ┌─ PACKETS BY SCHEDULER ───────────────────────────────────
  │  Scheduler      TX      RX      FAIL/DROP   Bytes       Success%
  │  ────────────────────────────────────────────────────────
  │  Greedy         60      60      1           312456      99.2%
  │  PSO            60      59      1           298234      98.3%
  │  MOMPSO         60      60      0           306789      100.0%
  │  MOMPSO-GA      60      59      1           301245      98.3%
  └──────────────────────────────────────────────────────────

  ┌─ FULL PACKET LOG (Wireshark-style) ─────────────────────
  │  No.   Time            +ms      DIR  Type                  Bytes   Sched          Device                Status     Extra
  │  ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  │  1     14:23:05.123    +0ms     TX   host-create           45B     -              -                     SENT       
  │  2     14:23:05.156    +33ms    RX   host-ready            28B     -              -                     RECV       
  │  3     14:23:08.234    +3111ms  RX   client-joined         98B     -              Android 14·Chrome     RECV       ip=192.168.1.5
  │  4     14:23:12.456    +7333ms  TX   frame                 23456B  greedy         Android 14·Chrome     SENT       fw=854 fh=480 ts=1720102992456
  │  5     14:23:12.689    +7566ms  RX   result                245B    greedy         Android 14·Chrome     RECV       dets=3 ts=1720102992456
  │  ...
  └──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

---

## 2. Energy Consumption (KJ) — Per Device × Scheduler

### Extended LOG Module Analytics

**New field in `_stats` object:**
```javascript
energyKJ: { greedy:0, pso:0, mompso:0, 'mompso-ga':0 }
```

**New function:**
```javascript
LOG.trackEnergy(deviceId, name, sched, energyKJ)
```

**Called from:**
- `handleFrame()` on CLIENT after every detection:
  ```javascript
  const frameEnergy = (POWER_W * frameTime) / 1000;  // KJ
  LOG.trackEnergy(S.myId, S.deviceName, sched, frameEnergy);
  ```

**Export format (added to LOG.download()):**
```
  ┌─ ENERGY CONSUMPTION (KJ) — PER DEVICE × SCHEDULER ──────────
  │  (Energy ≈ POWER_W × latency_s / 1000 · per frame processed)
  │  Device                Greedy          PSO             MOMPSO          MOMPSO-GA       TOTAL
  │  ────────────────────────────────────────────────────────────────────────────────────────
  │  Android 14·Chrome    0.012456 KJ     0.013234 KJ     0.011987 KJ     0.012678 KJ     0.050355 KJ
  │  iPhone 13·Safari     0.009876 KJ     0.010234 KJ     0.009456 KJ     0.010123 KJ     0.039689 KJ
  │  ────────────────────────────────────────────────────────────────────────────────────────
  │  TOTAL (all devices)  0.022332 KJ     0.023468 KJ     0.021443 KJ     0.022801 KJ     0.090044 KJ
  └──────────────────────────────────────────────────────────────────────────────────────────
```

**Calculation:**
- `frameTime = latency_ms / 1000` (seconds)
- `energyKJ = (15 watts × frameTime) / 1000`
- Accumulated per device per scheduler
- Exported as matrix: rows=devices, columns=schedulers

**Note on Energy Accuracy:**
Energy values are **approximate** — based on fixed 15W assumption. Actual device power varies by hardware, screen, network activity, CPU load.

---

## 3. Integration with Existing LOG Export

**Enhanced `LOG.download()`** now includes:
1. Original analytics summary (success rates, CPU utilization, per-device stats)
2. **NEW: Energy consumption matrix** (device × scheduler)
3. **NEW: Network packet summary** (TX/RX counts, success rates, type breakdown)
4. Frame event log (DISPATCH, RESULT_OK, DETECT_DONE, etc.)

**File naming:**
- `detectnet_log_2026-07-08_14-23-05_42frames.txt` — original event log
- `detectnet_network_2026-07-08_14-23-05_482pkts.txt` — full packet capture

---

## 4. UI Additions

### Server (Host) Screen:
- **Experiment Log** card (existing, enhanced)
  - `📋 Event Log` button → shows/hides frame lifecycle events
  - `⬇ Export` button → downloads enhanced log with energy matrix + network summary
  - `✕ Clear` button
  - `↺ Reset Experiment` button → resets LOG + NET counters

- **NEW: Network Override** card
  - `📡 Network Override` button → shows/hides packet log (last 200 packets)
  - `⬇ Export Packets` button → downloads full Wireshark-style packet table
  - `✕ Clear` button
  - Real-time packet list: seq#, timestamp, direction (TX/RX), type, scheduler, device, bytes, status

### Client (Worker) Screen:
- **NEW: Network Override** card (same structure)
  - Shows packets from this client's perspective
  - TX = messages sent to host (results, health, sched-result)
  - RX = messages received from host (frames, exp-reset)

---

## 5. Test Scenarios

### Scenario 1: Single Client, 10 frames, all 4 schedulers
**Expected packet count:**
- Host creates session: 2 pkts (host-create TX, host-ready RX)
- Client joins: 2 pkts (client-join TX, joined RX)
- 10 video frames × 4 schedulers = 40 frame TX
- 40 result RX (if all succeed)
- Health reports every 3s × ~30s = ~10 health TX from client
- **Total: ~54-60 packets**

### Scenario 2: Packet Loss
- If a client disconnects mid-frame, the host will log a `frame` TX with `SENT` but never receive a matching `result` RX.
- The packet log will show:
  - `TX frame ... to=clientX SENT`
  - No corresponding `RX result` from clientX
  - Eventually `RX ws-close ... clientX DROP`

### Scenario 3: Energy Calculation
- Frame takes 230ms to process → `frameTime = 0.23s`
- Energy = `(15W × 0.23s) / 1000 = 0.00345 KJ`
- If Greedy scheduler dispatches 100 frames to Device A with avg latency 230ms:
  - Total energy ≈ `0.00345 × 100 = 0.345 KJ` for Greedy on Device A

---

## 6. Implementation Notes

**Why Wireshark-style?**
- Researchers studying distributed systems need packet-level visibility
- Success/fail/drop status reveals network reliability
- Per-scheduler stats show which algorithms communicate most efficiently

**Why Energy in KJ?**
- Standard SI unit for energy (Joules)
- Research papers use KJ/MJ for energy consumption comparisons
- Allows fair comparison across schedulers: energy = power × time

**Why Track Per Device × Scheduler?**
- Different schedulers may pick different devices with different latencies
- A fast scheduler that picks slow devices consumes more total energy
- The matrix reveals which scheduler + device pairing is most efficient

**Limitations:**
- Energy is approximate (fixed 15W, actual varies)
- Packet capture adds minimal overhead (~5-10 bytes per packet logged)
- No server-side packet log (server.js logs to stdout, not this module)

---

## 7. Code Locations

| Feature | Lines | Module |
|---------|-------|--------|
| NET module | ~947-1074 | `var NET = (function(){...})()` |
| LOG.trackEnergy() | ~586-591 | LOG module extension |
| Energy matrix export | ~688-717 | LOG._buildSummary() |
| Network summary export | ~725-753 | LOG.download() |
| wsSend instrumentation | ~1438-1458 | wsSend() |
| connectWS instrumentation | ~1460-1485 | connectWS() |
| Client energy tracking | ~2042 | handleFrame() |
| experimentReset NET call | ~1173 | experimentReset() |
| Server Network UI | HTML card | server screen body |
| Client Network UI | HTML card | client screen body |

---

## 8. Export Button Locations

| Button | Location | Action |
|--------|----------|--------|
| Experiment Log → ⬇ Export | Server screen | Downloads `detectnet_log_...txt` with energy matrix + network summary |
| Network Override → ⬇ Export Packets | Server & Client screens | Downloads `detectnet_network_...txt` full packet table |

Both files are plain text, monospace-formatted, designed for researcher review and publication appendix inclusion.

---

## Done! 🎉

All devices and schedulers now log:
1. **Frame lifecycle events** (dispatch, relay, detect, result)
2. **Network packets** (TX/RX, success/fail/drop)
3. **Energy consumption** (KJ per device per scheduler)

The DetectNet cluster is now fully observable — every packet, every joule, every frame.
