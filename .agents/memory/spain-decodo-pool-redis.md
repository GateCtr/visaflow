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
- Verify the persisted pool fingerprint before restoring allocation state after a pool composition change.

## Shared failure policy
Reserve warm-up and background replenishment must share the same proxy-exclusion policy. Warm-up must have a bounded solve budget rather than trying the entire configured proxy pool.

**Why:** Failed reserve initialization previously did not flag the proxy during warm-up, allowing later reuse and long runs of paid solves that never produced a usable session.

**How to apply:** Flag failed reserve initialization consistently in both paths. Restore legacy URL-shaped blacklist keys into the same host:port identity used by current lookups. Host:port exclusion is an allocation rule, not proof that two provider ports have distinct real exit IPs.
