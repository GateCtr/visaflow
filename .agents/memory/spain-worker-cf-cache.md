---
name: Spain worker CF cache reuse
description: Why cfCached=false at every window start, and how the stickyId + timing fixes work.
---

## Rule
The CF clearance (cf_clearance) is bound to the **real exit IP**, not to the Decodo host:port.
Even with the same port, a new stickyId → new exit IP → cached clearance is invalid.

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
