---
name: Spain Bookitit dossier session isolation
description: Rules for multi-dossier session isolation in Spain capsolver mode — PHPSESSID constraint, sequential booking, _ownImpit pool.
---

# Spain Bookitit dossier session isolation

## Rule
In capsolver mode, all dossiers share the **same PHPSESSID** (bound to the CF challenge solve). Each booking session gets a fresh `_ownImpit` instance (TLS isolation) but cannot get a distinct PHPSESSID without re-running the full CF challenge.

## Confirmed behavior (tested 2026-08-12)
- `createIsolatedBookingSession` in capsolver mode: returns the existing PHPSESSID (lié au solve CF), attaches a fresh `_ownImpit` instance per session.
- Calling `/main/` without PHPSESSID does NOT generate a new PHP session — the server requires the full widget initialization flow (GET widget → POST token → /main/).
- Parallel bookings (Promise.all) with shared PHPSESSID: N-1 dossiers receive 0B from `getsigninfields/` → only 1 booking succeeds.
- Sequential bookings (for...of): works correctly. Occasional 0B on `getsigninfields/` for the 2nd dossier is intermittent (server resets state briefly) — resolved by retries in `executeHttpBooking`.

## Architecture
```
1 CF solve  →  1 PHPSESSID  →  sequential booking mandatory
                                (getsigninfields/ is stateful per PHPSESSID)

_ownImpit: fresh Impit instance per createIsolatedBookingSession()
           → TLS isolation without conflict (even if PHPSESSID is shared)
           → useful for non-capsolver modes where PHPSESSID can differ
```

## Why parallel is not viable in capsolver mode
True parallel = 1 CF solve per dossier (~20s + ~$0.01/dossier). Counterproductive vs sequential (~5s/dossier, no extra cost).

## How to apply
- `spain-watcher-loop.ts`: always use `for (const dossier of dossiers) await bookDossier(dossier)` — never `Promise.all` in capsolver mode.
- `createIsolatedBookingSession`: capsolver path returns `{ ...cfSession, _ownImpit: createFreshSpainImpit(cfSession) }` — do NOT delete PHPSESSID or call /main/ to get a new one.
- `freeslots` skip: if `bookedCountBySlot[slot] >= freeslots`, skip subsequent dossiers on that slot — avoids wasted requests when capacity is known.
