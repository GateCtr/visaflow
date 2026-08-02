---
name: CEV HTTP booking e2e fixes
description: Fixes applied to reach first confirmed booking via HTTP; CEV AvailableSlotForPublic format; slot selection logic; anti-CSRF cookie fix.
---

# CEV HTTP booking e2e — fixes & discoveries

## Confirmed endpoint
`POST /Integration/VOW/SelectSlot` → on success redirects to `/Integration/VOW/Booked`

**Why:** confirmed by live test run (2026-08-02), HTTP 200 + finalUrl ending in `/Booked`.
First successful booking: VOWINT6323902, 2026-12-24 14:20.

## Anti-CSRF cookie (CRITICAL — confirmed 2026-08-02)
ASP.NET MVC uses double-submit CSRF: the server requires **both**:
1. A hidden form field `__RequestVerificationToken` (extracted from HTML ✓)
2. A **cookie** `__RequestVerificationToken` emitted via `Set-Cookie` during the GET SelectSlot

Without the cookie → server returns HTTP 500 "The required anti-forgery cookie is not present."

**Fix:** `setupCevSessionHttp()` now returns `selectSlotCookies` = the full `fullCevCookie` string accumulated across the entire redirect chain (includes the anti-forgery cookie). This is passed to `bookCevViaHttp()` → `submitSlotSelection()` and used as the `Cookie:` header on the POST.

For call sites without a preloaded HTML (no setup cookies available), `fetchFollowRedirects()` now accumulates `Set-Cookie` from each hop via `accumulateCookies()` and returns `accumulatedCookies`, used as automatic fallback in `bookCevViaHttp` and `bookCevSelectedSlotViaHttp`.

**How to apply:** Always pass `session.selectSlotCookies` when calling `bookCevViaHttp`. Every loop (dossier, polling, extension, stealth) must propagate this value from the setup result.

## hCaptcha race logic fix (2026-08-02)
`HCaptchaEnterpriseTaskProxyless` → Anti-Captcha returns `ERROR_TASK_NOT_SUPPORTED` immediately.
Previous race logic resolved the promise with `null` before the regular task finished.

**Fix:** use a `settledCount` counter; only resolve with `null` when **both** tasks have finished.
`HCaptchaEnterpriseTaskProxyless` is now safely ignored as unsupported; `HCaptchaTaskProxyless` continues uninterrupted.

## AvailableSlotForPublic format (confirmed 2026-08-01)
```json
{
  "$type": "FPSFA.Population.eAppointment.ApiModel.AvailableSlotForPublic, ...",
  "fromTime": "1900-01-01T13:30:00",   ← placeholder date, ignore it
  "untilTime": "1900-01-01T14:30:00",  ← placeholder date, ignore it
  "planningType": "PreciseSlot",
  "scheduleLineId": "uuid",            ← booking key, 1 per available place
  "timeSlot": "2026-12-22T14:20:00",  ← REAL appointment time (use this)
  "datePart": "2026-12-22T00:00:00"   ← REAL date (use this)
}
```

**Why:** `fromTime` always uses `1900-01-01` as a fixed placeholder. The actual date/time is in `datePart` + `timeSlot`.

**How to apply:** In `extractInlineSlotsFromHtml`, read `datePart` for date and `timeSlot` for time. Fall back to `fromTime` only if both are absent, and ignore `1900-01-01` placeholder.

## Free count logic
Each entry in `availability[]` = 1 available place. Multiple entries with same `(datePart, timeSlot)` = multiple places.
Group by `(datePart, timeSlot)`, count = `free`. Prefer `free ≥ 3` (less contention).

## getCevCapacitySnapshot is broken
Returns `rawJson: null` because `/Home/AvailableTimeSlots` returns HTTP 302 when called post-setup. The inline HTML slots (`availability[]`) are the reliable source — use those directly.

## Files modified (2026-08-02 anti-CSRF fix)
- `cevHttpSetup.ts` — added `selectSlotCookies` to `CevHttpSetupResult`; returns `fullCevCookie`
- `cevHttpBooking.ts` — `bookCevViaHttp` + `bookCevSelectedSlotViaHttp` accept `selectSlotCookies`; `fetchFollowRedirects` accumulates cookies via `accumulateCookies()`
- `loops/cev-dossier-loop.ts` — `ScanResult` + `handleSlotFound` propagate `selectSlotCookies`
- `scripts/cev-e2e-test.ts` — `phaseBookingWithPreload` passes `selectSlotCookies`
