---
name: Spain Bookitit dossier session isolation
description: Rules for multi-dossier session isolation in Spain capsolver mode — PHPSESSID constraint, sequential booking, datetime/ reset, agendaId propagation.
---

# Spain Bookitit dossier session isolation

## Rule
In capsolver mode, all dossiers share the **same PHPSESSID** (bound to the CF challenge solve). Sequential booking is mandatory.

## PHP session state machine (confirmed 2026-08-12)

After each dossier's `signin/` call (even with wrong credentials), the "slot selected" PHP state is consumed. The next dossier's `getsigninfields/` returns 0B unless the state is re-primed.

**Fix: call `datetime/` for the slot's month before each dossier's `getsigninfields/`.** This re-initialises the PHP session state even if the response is 0B (the server updates the session independently of the response body).

Confirmed flow per dossier (HTTP-only mode):
```
datetime/ (slot month reset)  →  getsigninfields/ → 13816B  →  signin/ → 236B
```

## Rule #9: getagendas/ only responds ONCE per PHPSESSID
The first call returns data; all subsequent calls return 0B.  
Fix: pass `agendaId` in `SpainBookingConfig` from the watcher, and use it as the initial value in `executeHttpBooking` before the `getagendas/` call. Added `agendaId?: string` to `SpainBookingConfig` (2026-08-12).

## Architecture
```
1 CF solve  →  1 PHPSESSID  →  sequential booking mandatory
                                (getsigninfields/ stateful per PHPSESSID)

Per dossier in executeHttpBooking (HTTP-only path):
  1. getwidgetconfigurations/ + getagendas/ (parallel) — agendaId from config if getagendas/ returns 0B
  2. datetime/ reset (slot month) — re-primes PHP nonce even if 0B
  3. getsigninfields/ → 13816B ✅
  4. signin/ → 236B ✅

_ownImpit: fresh Impit instance per createIsolatedBookingSession()
           → TLS isolation (even with shared PHPSESSID)
```

## Why parallel is not viable in capsolver mode
True parallel = 1 CF solve per dossier (~20s + ~$0.01/dossier). Counterproductive vs sequential (~10s/dossier with datetime/ reset, no extra cost).

## How to apply
- `spain-watcher-loop.ts`: `for (const dossier of dossiers) await bookDossier(dossier)` — never `Promise.all`.
- `bookingConfig`: include `agendaId: assignedSlot?.agendaId` so dossier #2+ have the correct agendaId.
- `executeHttpBooking` HTTP-only path: call `datetime/` (slot month) BEFORE `getsigninfields/`.
- `createIsolatedBookingSession` capsolver path: return `{ ...cfSession, _ownImpit: createFreshSpainImpit(cfSession) }` — do NOT delete PHPSESSID.
