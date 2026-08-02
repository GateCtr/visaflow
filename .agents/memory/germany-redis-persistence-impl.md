---
name: Germany proxy rotation + Redis persistence
description: ConnectTimeoutError fix via Decodo rotation + Redis state persistence for germany-loop.
---

## Proxy rotation fix
- `rktermin-session.ts` imports `hasDecodoProxy / rotateDecodoUrl / getCurrentDecodoUrl` from spain-decodo-pool.ts
- `getRKDispatcher()` rebuilds ProxyAgent whenever the proxy URL changes (tracks `rkDispatcherProxyUrl`)
- Priority: GERMANY_PROXY_URL → RKTERMIN_PROXY_URL → Decodo CSV pool → direct (WARN if direct)
- `rotateRKProxy()` exported — advances pool index, nulls cached dispatcher
- Called at start of every `processGermanyJob()` — new IP per scan

**Why:** service2.diplo.de throttles/blocks datacenter IPs (Railway). The old dispatcher was a forever-singleton → same blocked IP on every retry.

## Redis persistence (germany-redis-persistence.ts)
- Same pattern as spain-redis-persistence.ts / cev-redis-persistence.ts
- Persists: `completedJobs` (TTL 7d), `pausedJobs` (TTL 24h, expired pauses filtered on restore)
- Distributed lock: `SET NX EX 120` — prevents Railway+Replit double-scan
- Graceful degradation: if Redis absent/down → in-memory only, no crash
- Instance ID: RAILWAY_REPLICA_ID → RAILWAY_SERVICE_ID → INSTANCE_ID → `local-<pid>`

## germany-loop.ts wiring points
- `startGermanyLoop()`: initGermanyRedis() → restore completedJobs + pausedJobs
- `runGermanyCycle()`: acquire lock (SET NX) → scan → release lock (finally block)
- `syncGermanyStateToRedis()` called after: booking confirmed, any `pauseJob()` call (network + business errors), config invalid

**Note:** REDIS_URL=redis://localhost:6379 fails on Replit (no local Redis) — graceful fallback kicks in with "Redis non disponible" log. Works fully when Redis is reachable (Railway with Redis addon).
