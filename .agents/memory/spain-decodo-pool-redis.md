---
name: Spain Decodo pool Redis persistence
description: Redis persistence for Decodo rotation index and IP blacklist; init call order and key design.
---

# Spain Decodo Pool — Redis Persistence

## Rule
`initDecodoPool()` must be called after `initSpainRedis()` in `spain-watcher-loop.ts`. It restores the rotation index (+1 from last saved = next-after-restart) and the IP blacklist from Redis, with random-index fallback when Redis is empty.

**Why:** Without persistence, every restart begins at index 0, concentrating all early traffic on the first proxy IP and accelerating its flagging. Without a blacklist, failed IPs are retried immediately on the next scan cycle.

## How to apply
- `flagDecodoIp(url, reason)` — call BEFORE `rotateDecodoUrl()` at every /main/ 0B or `closeAndInvalidate()` failure point (done in `rotateSpainCfIpAfterMainFailure` and `closeAndInvalidate`).
- `rotateDecodoUrl()` — already saves index to Redis (fire-and-forget) and skips blacklisted IPs automatically.
- Blacklist TTL: `SPAIN_DECODO_BLACKLIST_TTL_MIN` env var (default 45 min).
- Redis key: `visaflow:spain-decodo:pool-state` — stores `{ rotationIndex, blacklistedIps, savedAt }`.
- Pool-exhausted guard: when all IPs are blacklisted, falls back to round-robin (never blocks scan) with a `⚠️ POOL ÉPUISÉ` warning log.
- Pool fingerprint (size/URL hash) is NOT persisted — stale index on pool change is a known gap (Task #8).
