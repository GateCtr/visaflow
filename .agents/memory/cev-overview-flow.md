---
name: CEV Overview page flow
description: Mechanism of /Integration/VOW/Overview — when another dossier of same passport type already has an appointment; Cas 1 (new appointment available) and Cas 2 (limit reached).
---

## Context

The CEV portal redirects to `/Integration/VOW/Overview` (instead of `SelectSlot` or `NoAvailability`) when a different dossier of the same passport type on the same account already has an appointment scheduled.

## Two cases

**Cas 1 — different dossier, same passport type already booked:**
- Page shows: "Vous avez déjà planifié le rendez-vous suivant... Nouveau rendez-vous"
- HTML contains: `<a href="/Integration/VOW/SelectSlot">Nouveau rendez-vous</a>`
- **The href is literally `/Integration/VOW/SelectSlot`** — same as a direct booking flow
- Following it (GET with same session cookies) gives the SelectSlot calendar for the current dossier
- Confirmed empirically: VOWINT6323902 → slots in December 2026 (24/12, 28/12, 29/12, 30/12)

**Cas 2 — same dossier already at limit:**
- Page shows: "Vous ne pouvez pas prendre un nouveau rendez-vous... Vous avez atteint le nombre maximum..."
- Only "Annuler" button — no "Nouveau rendez-vous" link
- `extractNouveauRdvLink()` returns null

## Implementation in cevHttpSetup.ts

New verdict case **"Cas 3 Overview"** inserted before SessionExpired check:
- Detects `chainPassedThrough("VOW/Overview")`
- Calls `extractNouveauRdvLink(probeBodyRaw)` — 4 regex patterns covering `<a href>Nouveau rendez-vous` variants
- **Cas 1**: href found → GET `/Integration/VOW/SelectSlot` → returns `slotsAvailable: true, overviewState: 'new_appointment_available', selectSlotUrl, selectSlotHtml, selectSlotCookies`
- **Cas 2**: href absent → returns `slotsAvailable: false, overviewState: 'limit_reached'`
- Full HTML dump in botLog step `cev_http_verdict_overview_detected`

## New interface field

`CevHttpSetupResult.overviewState?: 'new_appointment_available' | 'limit_reached'`

## Test script

`scripts/test-overview-probe.ts` — takes `CEV_TEST_VOWINT_REF` env var (default VOWINT6323902), uses `CEV_EMAIL`/`CEV_PASSWORD`.

**Why:** The `cev_use_proxy=0` botConfig does NOT block captcha resolution — the token works proxyless. Captcha rejection on first try was flaky, second try succeeded in 61.7s.
