---
name: Spain Bookitit getsigninfields 0B root cause
description: Why getsigninfields/ returns 0B after N scan cycles, and the correct fix sequence confirmed by real browser traffic + dynamic test.
---

## Rule
The Spain flow must keep one PHPSESSID from scan through booking. A `getsigninfields/` or `signin/` 0B response is not proof that repeated `datetime/` calls expired PHP; the root cause remains unconfirmed and must be diagnosed without rotating PHPSESSID.

## Root bug in callBookititEndpoint (confirmed 2026-08-15)
`callBookititEndpoint` builds params inline. `version`, `src`, `srvsrc` all fall back to `state?.xxx` when absent from `params`. But `publickey` had NO fallback — `params["publickey"] ?? ""`. Any call with `{}` or partial params sent `publickey=""` → server silently returned 0B → PHP state never initialized. Fixed: `params["publickey"] ?? state?.publickey ?? ""`.

## Previous hypothesis — not confirmed
The worker reuses the same PHPSESSID across N scan cycles. Each cycle makes:
- getwidgetconfigurations/ + getservices/ + getagendas/ + datetime/ × 2 = ~5 calls minimum
- If vue-jour fires: +2-3 more datetime/ calls per cycle

After many cycles (observed: Cycle 23-28), `getsigninfields/` sometimes returned 0B. This correlation does not establish PHP expiration or permit replacing the session.

The dynamic test (test-bookitit-dynamic.ts) works because it starts with a fresh PHPSESSID and makes only 2 datetime/ calls total.

## Real browser sequence (confirmed Burp 2026-08-15)
1. Two datetime/ calls fired **simultaneously** (parallel), start=YYYY-MM-01 for each month
2. Monthly scan response has `times:{...}` (populated dict) for available dates — real freeslots
   - Keys are MINUTES from midnight ("540"=09:00, "800"=13:20), value has `time` and `freeSlots` fields
   - `time` field has the actual HH:MM string ("09:00", "13:20"); key is just sort/ID
3. Some dates have `times:[], state:1` (phantom) — only resolved by vue-jour on user calendar click
4. Browser goes DIRECTLY from datetime/ to getsigninfields/ — **no vue-jour before booking**
5. After PHPSESSID refresh, PHP state machine requires full re-init before getsigninfields/

## Confirmed request-flow constraints

**1. start=YYYY-MM-01 for all months** (`spain-http-scanner.ts`)
- Real browser always uses YYYY-MM-01, never start=today
- Using start=today returned `times:[]` for all dates → extra vue-jour calls needed

**2. freeslots > 0 filter in worker eligible** (`spain-dossier-worker.ts`)
- Phantom slots (freeslots=-1, from state=1 times=[]) must not be used for getsigninfields/
- Server rejects getsigninfields/ with phantom date → 0B
- Only use slots where freeslots > 0 (real times from times:{} dict in monthly scan)

**3. Gate vue-jour on "no real slots in monthly scan"** (`spain-http-scanner.ts`)
- If monthly scan already has freeslots>0 slots → skip vue-jour entirely (same as browser)
- Vue-jour only runs if ALL dates are phantom (times=[]) — max 3 dates
- This eliminates the main source of extra datetime/ calls that exhaust PHP

**4. publickey fallback in callBookititEndpoint** (`spain-http-booking.ts`)
- `params["publickey"] ?? state?.publickey ?? ""`
- Calls with `{}` now correctly use session publickey instead of empty string

## How to apply
- Never add intermediate calls between the last datetime/ and getsigninfields/
- Preserve the same PHPSESSID from the scan through getsigninfields/, signin/, and summary/
- vue-jour gate: `const realSlotsInMonthly = allSlots.slice(svcSlotsStart).some(s => s.freeslots > 0)`
- eligible filter: `scan.slots.filter(s => isSlotInDateWindow(s.date, config, tag) && s.freeslots > 0)`

## Validation status
Fixes confirmed logically correct. Cuba portal rate-limited 3 simultaneous workers during testing (getwidgetconfigurations/ → 0B on all workers). Cannot validate end-to-end until portal available. Test: `PORTAL_KEY=28db94e270580be60f6e00285a7d8141f node_modules/.bin/tsx scripts/test-parallel-workers.ts`
Expected: `getsigninfields/ → 200 | 13793B` (not 0B).
