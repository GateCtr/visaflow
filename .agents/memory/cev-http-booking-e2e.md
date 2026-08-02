---
name: CEV HTTP booking e2e fixes
description: Fixes applied to reach first confirmed booking via HTTP; CEV AvailableSlotForPublic format; slot selection logic; cancel flow.
---

# CEV HTTP booking e2e — fixes & discoveries

## Confirmed endpoint
`POST /Integration/VOW/SelectSlot` → on success redirects to `/Integration/VOW/Booked`

**Why:** confirmed by live test run (2026-08-01), HTTP 200 + finalUrl ending in `/Booked`.

## AvailableSlotForPublic format (confirmed 2026-08-01)
```json
{
  "fromTime": "1900-01-01T13:30:00",   ← placeholder date, ignore it
  "planningType": "PreciseSlot",
  "scheduleLineId": "uuid",            ← booking key, 1 per available place
  "timeSlot": "2026-12-22T14:20:00",  ← REAL appointment time (use this)
  "datePart": "2026-12-22T00:00:00"   ← REAL date (use this)
}
```

**Why:** `fromTime` always uses `1900-01-01` as a fixed placeholder. The actual date/time is in `datePart` + `timeSlot`.

**How to apply:** In `extractInlineSlotsFromHtml`, read `datePart` for date and `timeSlot` for time.

## Free count logic
Each entry in `availability[]` = 1 available place. Group by `(datePart, timeSlot)`, count = `free`. In practice most slots have `free=1`.

**Preference rule:** prefer `free ≥ 3` (less contention). Fall back to any slot if none qualify.

## getCevCapacitySnapshot is broken
Returns `rawJson: null` because `/Home/AvailableTimeSlots` returns HTTP 302. Use inline HTML slots (`availability[]`) instead.

## isLimitReached / Overview verdict (confirmed 2026-08-02)
When a dossier already has a booked appointment, the setup redirects to `/Integration/VOW/Overview` instead of SelectSlot. `setupCevSessionHttp` now returns:
- `isLimitReached: true`
- `overviewHtml`: HTML of Overview page
- `overviewCookies`: cookies for the cancel POST

## CEV Cancellation flow (confirmed 2026-08-02)
The Overview page shows booked appointments as:
```html
<button class="btnSendCancellationLink" data-id="<uuid>">
  mardi 22 décembre 2026 (14:20)
  <span class="additionalData">visa ... - VOWINT6321793 - ...</span>
</button>
```

The AJAX endpoint (discovered from `/bundles/scripts/sharedScripts`):
```
POST https://appointment.cloud.diplomatie.be/Shared/DoCancelRequestAppointment
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-Requested-With: XMLHttpRequest

uniqueToken=<uuid>&cultureCode=fr-BE
```

Response: `{ succeeded: true, message: "Vous avez reçu un e-mail avec un lien pour annuler votre rendez-vous." }`

**IMPORTANT:** This only sends the cancellation email. The user must click the link in the email to finalize. Full automation requires IMAP access.

**Headers:** Must use AJAX mode (`xRequestedWith: true, contentType: "application/x-www-form-urlencoded"`) — NOT `isFormPost: true`. The server validates `X-Requested-With: XMLHttpRequest`.

## 3 bugs fixed to reach /Booked
1. `bookCevSelectedSlotViaHttp` missing `selectSlotCookies` param → added
2. Test not passing `setup.selectSlotCookies/Html/Url` to booking functions → fixed
3. `TimeSlotNoLongerAvailable` triggering `needsPlaywright: true` → now returns `SLOT_TAKEN, needsPlaywright: false`
