---
name: Spain worker CF cache reuse
description: Why cfCached=false at every window start, and how the stickyId + timing fixes work.
---

## Rule
The CF clearance (cf_clearance) is bound to the **real exit IP**, not to the Decodo host:port.
Even with the same port, a new stickyId → new exit IP → cached clearance is invalid.

Do not force a fresh IP or a new CF solve at HH:10. A healthy worker session established
at the start of the HH:03–HH:25 window must keep the same base proxy, sticky ID, exit IP,
clearance, Impit instance, and PHP state through HH:13. Rotate only after a real
`proxy_error`/`cf_expired` signal.

**Why:** The former per-worker HH:10 refresh ran `rotateWorkerIp` and PHP initialization
inline. Slow solves crossed HH:13, making some apparent scan cycles exceed 120 seconds
while workers whose solve completed quickly still scanned in 2–3 seconds.

**How to apply:** Preparation belongs before the publication front. Never add scheduled
rotation or solve work inside the active worker loop immediately before HH:13.

The inter-window source of truth must be one atomic per-dossier proxy identity containing
the base proxy and sticky ID together. Keep-alive, pre-warm, and the next worker must all
consume that exact pair and use the same worker User-Agent. Publish a new identity only
after the portal and `/main/` validate successfully.

**Why:** Separate proxy/sticky keys can mix generations, and a different keep-alive UA can
validate a clearance under a fingerprint the worker does not use. An uncancelled delayed
keep-alive timer can also start a competing pre-warm after the worker has resumed.

**How to apply:** Cancel both initial and interval keep-alive timers at worker handoff.
Keep the global preflight pool for recovery reserves only; it must not independently
re-solve per-dossier sessions that are not transferred to the worker.

## Root cause of cfCached=false
`runDossierWorker` was generating `stickyId = Math.random()` on every window start.
The Redis key for the CF cache (`proxyToWorkerKey`) is stable by host:port — but the
clearance saved under that key was valid for the OLD exit IP (old stickyId). With a new
stickyId, the new exit IP rejects the clearance → `deleteWorkerCfClearance` → re-solve.

## Fix applied
- `saveLastStickyForDossier` / `getLastStickyForDossier` already existed (TTL 2h).
- On attempt 0: use `lastStickyId` from Redis instead of random.
- After successful session: `saveLastStickyForDossier(config.id, stickyId)`.
- On retry (attempt > 0): new random stickyId as before.

**Why:** Same stickyId → same exit IP → same TLS session → cf_clearance still valid →
`loadWorkerCfClearance` returns a hit → CapSolver skipped (~20s + $0.04 saved per window).

## Timing bug (worker not starting at HH:05)
`harvestFinishedWorkers` could not distinguish a real "exited" worker from a cooldown
placeholder (`sleep(msUntilNextWindow).then(→"exited")`). When the placeholder resolved
at HH:05, it was treated as "window finished" → new 60min cooldown → window missed.

**Fix:** Added `isCooldownPlaceholder?: boolean` to `RunningWorker`. Placeholders are
removed from the map without applying a new cooldown — the orchestrator launches the real
worker on the next iteration when `isInScanWindow()` is true.
