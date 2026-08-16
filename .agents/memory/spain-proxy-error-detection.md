---
name: Spain proxy_error detection in scanDatetimeDirect
description: How ProxyTunnelError/Timeout is distinguished from a legitimate 0B response in the datetime/ scan loop, and what triggers IP rotation.
---

## Rule
`callDirect()` returns `CALL_DIRECT_NETWORK_ERROR` (unique symbol) on thrown network exception (ProxyTunnelError, TimeoutError). A legitimate empty HTTP response returns `null` from `parseDirectJsonp`.

## Why
When a proxy rejects HTTPS CONNECT tunnels (502), `callDirect` was catching the exception and returning `null` — indistinguishable from a normal 0B server response (no slots, no agenda). Workers silently scanned at 1.8s/cycle instead of 4-6s, appearing healthy while never finding slots.

## How to apply
In `scanDatetimeDirect`: count `CALL_DIRECT_NETWORK_ERROR` returns across months. If ALL checked months returned the sentinel (≥2 months) → return `"proxy_error"`. Caller (`runDossierWorker` scan loop) handles `proxy_error` by calling `rotateWorkerIp` + reiniting `phpState`.

**False-positive guard**: agenda absent → server returns HTTP 0B → `null` (not sentinel) → no false proxy_error triggered.

**Logging**: `callDirect` now accepts optional `tag` param → logs `[bookitit-direct] [WORKER:xxx] endpoint → erreur réseau: ...` instead of anonymous `[bookitit-direct] endpoint → erreur: ...`.

## Files
- `spain-bookitit-direct.ts`: `callDirect` signature + `CALL_DIRECT_NETWORK_ERROR` export
- `spain-dossier-worker.ts`: `WorkerScanResult` type includes `"proxy_error"`, `scanDatetimeDirect` sentinel logic, scan loop `proxy_error` handler
