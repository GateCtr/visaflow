---
name: Spain Bookitit dossier session isolation
description: Rules for multi-dossier session isolation in Spain capsolver mode — PHPSESSID constraint, sequential booking, PHP state machine limits.
---

# Spain Bookitit dossier session isolation

## Rule
In capsolver mode, all dossiers share the **same PHPSESSID** (bound to the CF challenge solve). Sequential booking is mandatory.

## PHP session state machine — confirmed limits (2026-08-15)

Bookitit maintains a server-side PHP widget state keyed by PHPSESSID, advancing strictly:
```
/main/ → getservices/ → getagendas/ → datetime/ → getsigninfields/ → signin/
```

**After the scan's multi-month datetime/ sequence, the PHP state is consumed.**
- `getagendas/` → 0B in booking (state already past step 3)
- `datetime/` → 0B in booking (state consumed by scan)
- `getsigninfields/` → 0B (nonce not re-activated)
- `signin/` → ~2.3s response but unexpected format (PHP session-state error, not Bookitit JSON)

**Why datetime/ 0B does NOT activate the nonce:**  
The comment "even if 0B, server updates PHP session" was an INCORRECT assumption.  
`datetime/` only activates the nonce when it returns actual slot data. 0B = no nonce.

## Attempts to get a fresh PHPSESSID per dossier — all failed (2026-08-15)

| Attempt | Result |
|---|---|
| `/main/` with same PHPSESSID | 0B — PHP server-side state not reset (keyed by PHPSESSID) |
| `/main/` WITHOUT PHPSESSID | 0B — Bookitit requires PHPSESSID from the CF solve flow |
| `createFreshSpainImpit` in capsolver path | Wrong — fresh impit has different TLS fingerprint → CF incoherence |

**Conclusion:** A new PHPSESSID requires a full CF re-solve (~20s + ~$0.003). Not viable per dossier.

## Retained fix (2026-08-15)

`createIsolatedBookingSession` capsolver path: removed `createFreshSpainImpit`.  
Now leaves `_ownImpit` absent → `spainCfFetch` falls back to `getSpainImpit()` = singleton impit  
(same TLS fingerprint as the solve → CF coherent).

## Production decision

**Option B accepted**: multi-dossier booking with shared PHPSESSID is a known limitation.  
In production (Saopola), slots are booked one dossier at a time per scan cycle.  
Multi-dossier simultaneous booking is rare and acceptable as best-effort.

## Rule #9: getagendas/ only responds ONCE per PHPSESSID

The first call returns data; all subsequent calls return 0B.  
Fix: pass `agendaId` in `SpainBookingConfig` from the watcher; use it as fallback in `executeHttpBooking`.

## Architecture

```
1 CF solve  →  1 PHPSESSID  →  sequential booking mandatory

Per dossier in executeHttpBooking (capsolver HTTP-only path):
  1. getagendas/ + getwidgetconfigurations/ (parallel) — agendaId from config if 0B
  2. datetime/ (slot month) — re-prime attempt; 0B after scan = nonce NOT activated
  3. getsigninfields/ → 0B if datetime/ was 0B
  4. signin/ → server responds (~2.3s) but unexpected format if getsigninfields/ was 0B

For SINGLE dossier per cycle (production norm): PHP state not yet consumed → all steps work.
For 2+ dossiers: getsigninfields/ 0B for dossier #2+ → signin/ fails gracefully.
```

## How to apply
- `spain-watcher-loop.ts`: `for (const dossier of dossiers) await bookDossier(dossier)` — never `Promise.all`.
- `bookingConfig`: include `agendaId: assignedSlot?.agendaId` so fallback is correct.
- `createIsolatedBookingSession` capsolver path: NO `_ownImpit` — use singleton impit.
- Do NOT attempt `/main/` reset with same or stripped PHPSESSID — both return 0B.
