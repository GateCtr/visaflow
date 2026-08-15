---
name: Redis scanner lock renewal rule
description: SET NX always fails when the key already exists, even if this instance owns it. Use renewSpainScannerLock() (Lua GET+EXPIRE) for TTL renewal, not acquireSpainScannerLock().
---

# Redis scanner lock renewal rule

## Rule
- **Acquire** (first time): `acquireSpainScannerLock()` — `SET key value NX EX ttl`. Returns `"OK"` only if key did not exist.
- **Renew** (while running): `renewSpainScannerLock()` — Lua: `if GET(key)==instanceId then EXPIRE(key,ttl)`. Returns 1 only if THIS instance owns the key.
- **Release** (shutdown): `releaseSpainScannerLock()` — Lua: `if GET(key)==instanceId then DEL(key)`. Already safe.

## Why
`SET NX` always returns `null` when the key exists — it does not distinguish "I own it" from "another instance owns it". Calling `acquireSpainScannerLock()` in a renewal timer immediately marks `lockHeld = false` (lock "lost") because the key is already there. When the TTL then expires (~50s), a second instance grabs it and runs concurrent workers alongside the first.

## How to apply
- `spain-worker-orchestrator.ts`: `setInterval` calls `renewSpainScannerLock()`; sets `lockLost = true` on failure.
- Main loop checks `lockLost` at top of each iteration; if true → waits for existing workers to finish → breaks.
- Workers are NOT cancelled on lock loss (to avoid aborting a booking in progress). Only new spawning is blocked.
- `renewSpainScannerLock` is exported from `spain-redis-persistence.ts`.
