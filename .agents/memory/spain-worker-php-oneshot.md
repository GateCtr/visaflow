---
name: Spain worker PHP one-shot init
description: initPhpState + scanDatetimeDirect pattern — init PHP once per PHPSESSID then loop datetime/ only; avoids rate-limit 0B on cycle 2+.
---

## Rule
`runDossierWorker` calls `initPhpState()` once after session init, then loops `scanDatetimeDirect()` — never reinit PHP inside the loop unless `session_dead` fires.

**Why:** Bookitit §9 rule — `getagendas/` once per PHPSESSID. Calling getwidget/getservices/getagendas on every cycle triggers server-side rate-limiting (0B responses from cycle 2 onward). Confirmed by `test-bookitit-dynamic.ts` A-to-Z proof.

## How to apply
- `initPhpState(session, config, tag)` → calls getwidgetconfigurations/ + getservices/ + getagendas/ once → returns `WorkerPhpState | null`.
- `scanDatetimeDirect(session, phpState, config, tag)` → calls ONLY datetime/ month-by-month → returns `WorkerScanResult | "session_dead"`.
- On `session_dead`: rotate IP via `rotateWorkerIp()` → call `initPhpState()` again → if null, exit worker.
- The `phpState` variable must be guarded with `if (!phpState) break;` at the start of each loop iteration (TypeScript cannot narrow it across loop boundaries).
- `reportSpainWatcherScan` is called fire-and-forget per cycle with `applicationId` + `dossierName` for per-dossier Convex logs.

## Schema change (deployed)
`spainWatcherScans` now has `applicationId: v.optional(v.string())` + `dossierName: v.optional(v.string())` + index `by_application`.

## UI change
- `FlowTab` type extended to `"spain"`.
- 🇪🇸 Espagne tab merged into BotLogsTab flow tabs (alongside USA/CEV/Germany).
- When Spain tab active: renders SpainWatcherTab inline; filter bar + log table hidden.
- SpainWatcherTab dossier selector: `getDossierList` query → dropdown → `applicationId` filter passed to `getWatcherPaginated`.
- Top-level "Espagne" switcher removed from AdminBotLogs.
