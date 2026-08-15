---
name: Spain services plumbing bug
description: Why "aucun service connu" recurs and kills bookings despite the scanner finding services; what really proves a slot exists on SPA Bookitit portals.
---

# Le bug récurrent "services" (logs jeudi 2026-08-13 + vendredi 2026-08-14)

**Rule:** any wrapper that repackages the scanner result MUST forward `_services` (and `_widgetConfig`). `runSpainHttpProbe()` in `spain-http-scanner.ts` dropped them → watcher saw 0 services → `availableServices: []` → `executeHttpBooking()` fell back to `extractServicesFromHtml()` → 0 `#selectservice` links (normal on SPA) → instant `no_slots` for every dossier while 7 confirmed slots existed.

**Why:** Saopola/Kinshasa portals are Backbone SPAs whose services route is blocked by a custom (legal-notice) view — `#selectservice` links are NEVER in server HTML. Absence of HTML links is NOT a false positive and NOT "no services".

**How to apply:**
- The only true proof of availability = `datetime/` returning days with `state=1` or non-empty `Slots`. Never log "FAUX POSITIF" after a datetime/ confirmation.
- `state=1` + `times=[]` = day open, real hour unknown; the "09:00" is a hardcoded default — label it as unconfirmed.
- If `targetServiceId` is known (mono-service portal, bkt1181774 Kinshasa), booking must proceed without requiring the service in HTML or in a list.
- Thursday logs (getservices/ JSONP fallback → 2 services, datetime/ confirmed 14 slots Sept) proved the scanner side is correct; only the probe wrapper lost the data.
- Fix verified live on Saopola 2026-08-15 (test-saopola-live.ts, full scan→booking): _services propagated, service stage passed with 0 HTML links, flow reached signin/. Remaining blocker is signin (getsigninfields 0B in pure HTTP → hash-nav/browser path needed).
