---
name: CEV HTTP booking e2e fixes
description: Fixes applied to reach first confirmed booking via HTTP; CEV AvailableSlotForPublic format; slot selection logic.
---

# CEV HTTP booking e2e — fixes & discoveries

## Confirmed endpoint
`POST /Integration/VOW/SelectSlot` → on success redirects to `/Integration/VOW/Booked`

**Why:** confirmed by live test run (2026-08-01), HTTP 200 + finalUrl ending in `/Booked`.

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

**Why:** `fromTime` always uses `1900-01-01` as a fixed placeholder regardless of the real appointment date. The actual date/time is in `datePart` + `timeSlot`.

**How to apply:** In `extractInlineSlotsFromHtml`, read `datePart` for date and `timeSlot` for time. Fall back to `fromTime` only if both are absent, and ignore `1900-01-01` placeholder.

## Free count logic
Each entry in `availability[]` = 1 available place. Multiple entries with the same `(datePart, timeSlot)` = multiple places for that slot.

Group by `(datePart, timeSlot)`, count = `free`. In practice most slots have `free=1` for standard accounts.

**Preference rule:** prefer `free ≥ 3` (less contention). Fall back to any slot if none qualify.

## 3 bugs fixed to reach /Booked
1. `bookCevSelectedSlotViaHttp` missing `selectSlotCookies` param → added + passed to `submitSlotSelection`
2. Test not passing `setup.selectSlotCookies/Html/Url` to booking functions → fixed
3. `TimeSlotNoLongerAvailable` triggering `needsPlaywright: true` → now returns `SLOT_TAKEN, needsPlaywright: false`

## getCevCapacitySnapshot is broken
Returns `rawJson: null` because `/Home/AvailableTimeSlots` returns HTTP 302 when called post-setup. The inline HTML slots (`availability[]`) are the reliable source — use those directly.
