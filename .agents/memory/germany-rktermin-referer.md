---
name: Germany RK-Termin booking — root causes + confirmed fixes
description: Three root causes of session_error on RK-Termin booking; session reuse to cut captcha cost; success detection via thanx.do URL.
---

## Root causes of `session_error` — ALL THREE confirmed e2e

### 1. Wrong Referer on GET showForm
`service2.diplo.de` validates navigation coherence via the `Referer` header.
- `GET appointment_showForm.do?...` must have `Referer: .../appointment_showDay.do?...`
- Without it the server stores "no referer" → later POST triggers "address changed manually"

**Fix:** `bookSlot` constructs the showDay URL and passes it as referer to `fetchForm` via `rkGet(..., { referer: showDayUrl })`.

### 2. Wrong POST endpoint
The form's `action` attribute is `/appointment_showForm.do`, NOT `/appointment_addAppointment.do`.
Spring WebWork routes to the `addAppointment` method via the **button name** `action:appointment_addAppointment` in the body. The URL must be `showForm.do`.

**Fix:** `bookSlot` POSTs to `RKTERMIN_ENDPOINTS.appointmentShowForm`, not `appointmentAddAppointment`.
The key `"action:appointment_addAppointment": "Submit"` stays in the POST body — that's how Spring picks the method.

### 3. Wrong `definitionId` values in POST body
Config had hardcoded `dynamicFields[].definitionId = 14389/14390` (for realmId=731 national visa).
The Kinshasa Schengen realm (realmId=1276) returns `definitionId=11598/11599` in the form's hidden fields.
We were overwriting the form's correct values with the config's stale ones → server rejected.

**Fix:** `bookSlot` now spreads `hiddenFields` (extracted from the form HTML) into `formData` FIRST,
then only sets `fields[N].content` from config's `dynamicFields` — never overwrites `definitionId` or `index`.

## Success detection — `appointment_thanx.do` redirect

The RK-Termin confirmation page (`appointment_thanx.do`) renders its content via JavaScript.
The static HTML has empty `<div>`s — no text to pattern-match. No confirmation number in the URL or HTML.

**Fix:** `rkPost` now returns `finalUrl` (the URL after all redirects, via `res.url`).
`bookSlot` checks `finalUrl.includes("appointment_thanx")` first, before calling `parseBookingResponse`.
On match: returns `status: "booked"` with `confirmationNumber: "voir email"` (number is in the confirmation email).

**Why:** Spring does a POST → redirect → GET to `appointment_thanx.do?categoryId=...`. That redirect is
the canonical success signal on this portal; text patterns are unreliable because the page is JS-rendered.

## Session captcha reuse (10 min window)

JSESSIONID lifetime: **10 minutes** (`sessionMaxAgeMs: 10 * 60_000`). Scan interval: 1 min.

Before: every `runGermanyScan` called `scanMonth` → `initSession` → fresh JSESSIONID → new captcha. ~60 captchas/hour per dossier.

After: `germany-loop.ts` keeps `sessionCache: Map<jobId, RKTerminSession>`. Each scan:
1. If cached session is locally valid → call `scanNextMonth` (GET showMonth with existing JSESSIONID) → no captcha
2. If `scanNextMonth` returns error (server showed captcha) → fall back to full `scanMonth` + new captcha
3. On booking error or completion → `sessionCache.delete(jobId)` to force fresh session next cycle

`runGermanyScan` returns `{ ...RKTerminScanResult, updatedSession?: RKTerminSession }`.
- `updatedSession` present: not_found, slot_found (detected/slot_taken) — session still valid
- `updatedSession` absent: booking error, booking success, crash — session should be discarded

## `definitionId` values by realm (Kinshasa service2.diplo.de)
- realmId=1276 (Schengen) → `definitionId` 11598 (Nationality), 11599 (Passport number)
- realmId=731 (national) → `definitionId` 14389/14390 (stale config — NOT used anymore)

**Why:** Always read `definitionId` from the form HTML hidden fields, never trust config values for this portal.
