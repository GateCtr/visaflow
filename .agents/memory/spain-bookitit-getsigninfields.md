---
name: Spain Bookitit getsigninfields 0B root cause
description: Why getsigninfields/ returns 0B after N scan cycles, and the correct fix sequence confirmed by real browser traffic + dynamic test.
---

## Rule
getsigninfields/ → 0B after many scan cycles = PHP session exhaustion + missing PHP state context. Fix: refresh PHPSESSID + full re-init sequence BEFORE getsigninfields/.

## Root bug in callBookititEndpoint (confirmed 2026-08-15)
`callBookititEndpoint` builds params inline. `version`, `src`, `srvsrc` all fall back to `state?.xxx` when absent from `params`. But `publickey` had NO fallback — `params["publickey"] ?? ""`. Any call with `{}` or partial params sent `publickey=""` → server silently returned 0B → PHP state never initialized. Fixed: `params["publickey"] ?? state?.publickey ?? ""`.

## Why getsigninfields/ → 0B after many cycles
The worker reuses the same PHPSESSID across N scan cycles. Each cycle makes:
- getwidgetconfigurations/ + getservices/ + getagendas/ + datetime/ × 2 = ~5 calls minimum
- If vue-jour fires: +2-3 more datetime/ calls per cycle

After many cycles (observed: Cycle 23-28), PHP state is exhausted → getsigninfields/ → 0B.

The dynamic test (test-bookitit-dynamic.ts) works because it starts with a fresh PHPSESSID and makes only 2 datetime/ calls total.

## Real browser sequence (confirmed Burp 2026-08-15)
1. Two datetime/ calls fired **simultaneously** (parallel), start=YYYY-MM-01 for each month
2. Monthly scan response has `times:{...}` (populated dict) for available dates — real freeslots
   - Keys are MINUTES from midnight ("540"=09:00, "800"=13:20), value has `time` and `freeSlots` fields
   - `time` field has the actual HH:MM string ("09:00", "13:20"); key is just sort/ID
3. Some dates have `times:[], state:1` (phantom) — only resolved by vue-jour on user calendar click
4. Browser goes DIRECTLY from datetime/ to getsigninfields/ — **no vue-jour before booking**
5. After PHPSESSID refresh, PHP state machine requires full re-init before getsigninfields/

## Fix (all applied 2026-08-15)

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

**4. Full re-init sequence after refreshPhpsessidForCapsolver** (`spain-dossier-worker.ts`)
After refresh (new PHPSESSID + /main/), the PHP state machine is blank. MUST call:
`getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/ (slot's month) → getsigninfields/`
"Nothing between datetime and getsigninfields/" = true, but ALL these calls happen BEFORE the final datetime/ → getsigninfields/ chain. Same sequence as dynamic test on its fresh run.

**5. refreshPhpsessidForCapsolver before getsigninfields/** (`spain-dossier-worker.ts`)
- Safety net: GET widget + POST token + /main/ → fresh PHPSESSID on same impit
- Handles residual exhaustion from N cycles of scanning on the same session

**6. publickey fallback in callBookititEndpoint** (`spain-http-booking.ts`)
- `params["publickey"] ?? state?.publickey ?? ""`
- Calls with `{}` now correctly use session publickey instead of empty string

## How to apply
- Never add intermediate calls between the last datetime/ and getsigninfields/
- After refresh: getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/ → getsigninfields/ (all on new PHPSESSID)
- vue-jour gate: `const realSlotsInMonthly = allSlots.slice(svcSlotsStart).some(s => s.freeslots > 0)`
- eligible filter: `scan.slots.filter(s => isSlotInDateWindow(s.date, config, tag) && s.freeslots > 0)`
- refreshPhpsessidForCapsolver imported from spain-http-booking.ts

## Validation status
Fixes confirmed logically correct. Cuba portal rate-limited 3 simultaneous workers during testing (getwidgetconfigurations/ → 0B on all workers). Cannot validate end-to-end until portal available. Test: `PORTAL_KEY=28db94e270580be60f6e00285a7d8141f node_modules/.bin/tsx scripts/test-parallel-workers.ts`
Expected: `getsigninfields/ → 200 | 13793B` (not 0B).
