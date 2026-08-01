---
name: Germany RK-Termin booking Referer fix + session reuse
description: Root cause of session_error on booking; how to fix Referer headers; session cache to avoid per-scan captcha.
---

## session_error root cause

`service2.diplo.de` validates navigation coherence via the `Referer` header. A real browser sends:
1. `GET appointment_showForm.do?...` with `Referer: .../appointment_showDay.do?...`
2. `POST appointment_addAppointment.do` with `Referer: .../appointment_showForm.do?...`

Without the Referer on the GET, the server stores "no referer" internally. When the POST arrives with a Referer pointing to showForm, the server sees inconsistency → "address changed manually" → session_error.

**Fix applied:**
- `rkGet` now accepts `options?: { referer?: string }` and adds the header
- `bookSlot` constructs the showDay URL and passes it as referer to `fetchForm`
- `rkPost` already had the showForm referer fix from a prior session

## Session captcha reuse (10 min window)

JSESSIONID lifetime: **10 minutes** (`sessionMaxAgeMs: 10 * 60_000`). Scan interval: 1 min.

Before: every `runGermanyScan` called `scanMonth` → `initSession` → fresh JSESSIONID → new captcha. ~60 captchas/hour per dossier.

After: `germany-loop.ts` keeps `sessionCache: Map<jobId, RKTerminSession>`. Each scan:
1. If cached session is locally valid → call `scanNextMonth` with current month dateStr → GET calendar, no captcha
2. If `scanNextMonth` returns status=error (server showed captcha) → fall through to full `scanMonth` init
3. On booking error or completion → `sessionCache.delete(jobId)` to force fresh session next cycle

**Why:** `scanNextMonth` (GET showMonth with existing session) works because the server remembers the captcha was solved for this JSESSIONID. It does NOT re-show the captcha unless the session expired.

## How `currentMonthDateStr()` works

Returns `"MM.YYYY"` (e.g. `"08.2026"`) — the dateStr format used by `appointment_showMonth.do?dateStr=...` navigation links. Computed from `new Date()` at scan time.

## Return value change in orchestrator

`runGermanyScan` now returns `{ ...RKTerminScanResult, updatedSession?: RKTerminSession }`.
- `updatedSession` present on: not_found, slot_found (detected/slot_taken), 
- `updatedSession` absent on: booking error (session_error), booking success (job done), crash
- The loop uses presence/absence to decide whether to cache or invalidate.
