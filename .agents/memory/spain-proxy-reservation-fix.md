---
name: Spain proxy reservation key normalization + sticky strip
description: Root cause and fix for shared-IP and cfCached=false bugs in per-dossier worker assignment.
---

## Root Cause (two bugs, one origin)

`saveLastProxyForDossier` received the STICKY URL (proxyUrl = stickyProxy after line 594),
not the base URL as its comment stated. This caused:

1. **Shared port bug**: `reserveWorkerIp` used `encodeURIComponent(proxyUrl)` as key.
   - Round-robin path passes BASE URL → key A
   - `lastProxy` path passes STICKY URL → key B (≠ A, different credentials string)
   - Two workers reserve the same port with different Redis keys → both succeed → port collision.

2. **cfCached always false**: Two workers on port 10005 with different stickyIds have different
   exit IPs, but both save/load CF clearance under the SAME key (`es.decodo.com_10005`).
   Second solve overwrites first → first worker loads wrong clearance → portail rejects →
   re-solve → cfFromCache=false.

## Fixes Applied

**`spain-redis-persistence.ts`**: `proxyToReserveKey(url)` normalizes to `host:port` only.
`reserveWorkerIp`, `isIpReservedByOther`, `releaseWorkerIp` all use `proxyToReserveKey`
instead of `encodeURIComponent(proxyUrl)`. Same port = same Redis key regardless of sticky.

**`spain-dossier-worker.ts`**: `stripStickySession(url)` removes `-session-{id}-` from username.
`finally` block: `saveLastProxyForDossier(config.id, stripStickySession(proxyUrl))`.
Ensures `lastProxy` in Redis is always BASE URL → consistent with round-robin path.

## How to apply
- Never save a sticky URL to `lastProxy` — always strip sticky before persisting.
- Reservation keys must be port-based (host:port), not credential-based.
- CF clearance key (`proxyToWorkerKey`) correctly uses host:port — no change needed there.

## Expected result after fix
- Each port exclusively assigned to one dossier per window.
- Next window: same port reused → same exit IP → `loadWorkerCfClearance` hits → cfFromCache=true (~0.5s vs ~20s solve).
