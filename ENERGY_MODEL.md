# DetectNet Energy Model

How DetectNet estimates per-frame and per-scheduler energy for mobile/edge clients, and why the numbers are reported the way they are.

This document is the methodological companion to the implementation in `public/index.html` (`ENERGY` object) and the export matrices in the experiment log.

---

## The three families used in the literature

Research on energy consumption in mobile / edge / cloud systems splits into three approaches, in increasing order of “properness” and decreasing order of practicality for a browser app like DetectNet:

### 1. Direct hardware measurement (ground truth)

An external power meter (e.g. Monsoon Power Monitor) wired to the device, or on-device fuel-gauge / battery-voltage sampling calibrated against known loads.

This is the ground truth, but needs physical instrumentation you cannot get from a browser tab.

A closely related *software* approach constructs a model by measuring OS-provided utilization statistics while running sample applications and measuring the corresponding power consumption — the **PowerBooter / PowerTutor** line of work:

> Zhang, Tiwana, Dick, Qian, Mao, Wang & Yang, *Accurate Online Power Estimation and Automatic Battery Behavior Based Power Model Generation for Smartphones*, CODES+ISSS 2010.

It builds a per-device power model from real battery drain, then uses that model for cheap online estimation afterward. That is the credible middle ground DetectNet reaches for via Battery Status API calibration.

### 2. Utilization-based linear power model (field standard for simulators)

The model PureEdgeSim, CloudSim, and GreenCloud all use. It traces back to:

> Fan, Weber & Barroso, *Power Provisioning for a Warehouse-Sized Computer*, ISCA 2007.

They showed real servers’ power draw is well approximated as linear in CPU utilization:

```
P(u) = P_idle + (P_max − P_idle) × u
```

where `u ∈ [0, 1]` is CPU utilization.

PureEdgeSim (Mechalikh, Taktak & Moussa, 2019) reports idle, workload-caused, and backhaul energy separately as telemetry. DetectNet’s **compute** term ports this exact model so energy figures stay methodologically consistent with PureEdgeSim-style evaluation.

### 3. Mobile-specific compute-vs-communication models

DetectNet is a browser client that receives frames and returns detections over WebSocket (WebRTC-style offload architecture). The matching literature:

> Miettinen & Nurminen, *Energy Efficiency of Mobile Clients in Cloud Computing*, HotCloud 2010.

Offloading only saves energy if the savings from moving computation off-device exceed the energy cost of the additional communication. Scheduler comparison (Greedy / PSO / MOMPSO / MOMPSO-GA) should therefore be judged on **compute energy saved minus radio energy spent**, not compute alone.

> Balasubramanian, Balasubramanian & Venkataramani, *Energy Consumption in Mobile Phones: A Measurement Study and Implications for Network Applications*, ACM IMC 2009.

In 3G networks roughly **60% of network energy is wasted as “tail energy”** — high-power radio states that persist after a transfer completes, not proportional to bytes sent. For frequent small messages (per-frame WebSocket traffic), treating network time as free CPU-watt-seconds underestimates the dominant non-linear cost.

---

## What DetectNet implements (hybrid)

Combine #1 (calibration) with #2/#3 (linear compute + tail-energy network). This is standard practice in the literature (e.g. PowerTutor calibrates a linear utilization model against real battery drain rather than trusting either alone).

```
E_total = E_compute + E_network
```

Reported per device × per scheduler in the experiment export, with clear labels:

| Export section | Meaning |
|----------------|---------|
| **E_TOTAL** | `E_compute + E_network` — the number that answers “which scheduler is more energy-efficient” |
| **MODELED COMPUTE ENERGY** | Linear-utilization, optionally calibrated — Fan et al. |
| **MODELED NETWORK ENERGY** | Tail-energy proxy — Balasubramanian et al. |

### Compute energy — Fan linear model over `detectMs`

```
P(u) = P_idle + (P_max − P_idle) × u
E_compute = P(u) × (detectMs / 1000)     // Joules → reported as KJ
```

- `detectMs` is already isolated in `handleFrame` (inference window only — not full RTT).
- `u` comes from the existing rAF / sync jank-detector (`HD.cpu` → utilization in `[0,1]`).
- `P_idle` / `P_max` start as device-class priors (`DEVICE_POWER_TABLE`), then may be scaled by calibration.

### Network energy — simplified tail-energy state machine

Per WebSocket message involved in a frame (client **RX frame** + **TX result** → two charges):

| Radio state | Cost charged |
|-------------|--------------|
| Idle / tail expired | `rampJ + xferJ + tailJ` (new high-power cycle) |
| Still inside tail window | `xferJ` only (extends the tail) |

Coefficients are profiled by connection class (`wifi` / `cell` / `other`), following the IMC 2009 observation that **tail dominates** for small frequent transfers. This is intentionally **not** `bytes × constant`.

### Calibration — Battery Status API (PowerTutor-style)

When Android Chrome exposes `navigator.getBattery()`:

1. Sample `battery.level` at experiment / session start.
2. When drain reaches ≥ 1%, compute measured average watts:

   ```
   ΔenergyWh = ΔbatteryPercent × ratedCapacityWh
   P_avg_measured = ΔenergyWh / Δt_hours
   ```

3. Compare against the model’s predicted average at observed mean `u`, and scale both `P_idle` and `P_max` by `P_avg_measured / P_avg_predicted` (clamped to a safe range).

`ratedCapacityWh` comes from the device-class table, or override with `S.batteryCapacityWh` if you know the pack rating.

Without Battery API (iOS Safari, desktop without the API), priors remain uncalibrated — still the Fan linear model, clearly labeled as modeled.

---

## What changed vs the old flat lookup

| Before | After |
|--------|-------|
| Single UA → active-wattage table | `idleW` / `maxW` / `capacityWh` priors |
| `Energy = W_active × RTT_s` | Compute over **`detectMs`** only; network separate |
| Network folded into latency | Tail-energy state machine per WS message |
| No battery use for power | Battery drain **calibrates** `P_idle`/`P_max` when available |
| One energy matrix in export | Three matrices: total / compute / network |

Relative scheduler rankings that used to reward “pick the fastest device” now also penalize chatty radio behavior — aligning with Miettinen & Nurminen’s offload criterion.

---

## How to read the UI and logs

- Client **E_total (KJ)** — running average of hybrid energy per processed frame.
- Host results table **E_total (KJ)** — hover for compute vs network split; subtitle notes `E_total = compute + network`.
- Per-frame `DETECT_DONE` / `RESULT_OK` log fields: `energyKJ`, `computeKJ`, `networkKJ`, `cpuUtil`, `pIdle`, `pMax`, `calibrated`, `radio`.
- Export `.txt` — three labeled matrices under the experiment summary.

---

## Limitations (honest scope)

- **Not lab calorimetry.** Without a Monsoon-class meter, numbers are modeled (and optionally battery-anchored), not absolute device Watts.
- **Battery API** is coarse (%), unavailable on iOS, and unreliable while charging — calibration only runs on meaningful discharge.
- **Tail coefficients** are literature-inspired proxies, not per-modem measurements for every SoC / carrier.
- **CPU util** is a browser jank proxy, not OS `/proc` accounting — appropriate for relative comparisons inside the same experiment, not cross-paper absolute claims without stating the proxy.

For papers: cite Fan et al. for the compute term, Balasubramanian et al. for the network term, Zhang et al. for battery-anchored calibration, and PureEdgeSim for simulator consistency. State clearly that DetectNet reports *modeled* compute and *modeled* network energy under this hybrid.

---

## Key references

1. Fan, Weber & Barroso — *Power Provisioning for a Warehouse-Sized Computer*, ISCA 2007.
2. Zhang et al. — *Accurate Online Power Estimation… (PowerTutor)*, CODES+ISSS 2010.
3. Balasubramanian et al. — *Energy Consumption in Mobile Phones…*, ACM IMC 2009.
4. Miettinen & Nurminen — *Energy Efficiency of Mobile Clients in Cloud Computing*, HotCloud 2010.
5. Mechalikh, Taktak & Moussa — *PureEdgeSim…*, 2019 (linear utilization telemetry in edge simulators).
