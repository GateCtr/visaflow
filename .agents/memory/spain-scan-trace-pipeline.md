---
name: Spain scan trace pipeline fix
description: scanTrace was silently dropped at 3 layers between the bot and the frontend; all 3 required simultaneous fixes.
---

# Spain scan trace — 3-layer fix required

## The rule
When adding any new optional field to `spainWatcherScans`, you MUST fix ALL THREE layers or the data is silently dropped:

1. **`convex/schema.ts`** — add `v.optional(v.string())` to `spainWatcherScans` table definition.
2. **`convex/spainWatcher.ts` `internalRecordScan`** — add the field to both `args` validator AND the `ctx.db.insert()` call.
3. **`convex/http.ts` `/hunter/spain-watcher/scan-result`** — add the field to the `body` TypeScript type AND forward it in the `ctx.runMutation(internal.spainWatcher.internalRecordScan, {...})` call.

**Why:** The bot sends JSON to the HTTP endpoint. If the endpoint's body type doesn't include the field it is ignored in the destructuring. Even if args + insert are fixed, a missing body forward means the mutation gets `undefined`. Convex doesn't error on unknown body fields — it just ignores them.

## Applied to: scanTrace
- `scanTrace?: string` — JSON-serialized `SpainScanTrace` (main/initConfig/service/agenda/datetime/booking steps built by `spain-scan-trace.ts`, serialized in spain-watcher-loop.ts, sent via `reportSpainWatcherScan` in convexClient.ts).
- Before fix: all scans showed only "Aucun créneau" with no step detail — scanTrace was always dropped.
- After fix: each scan shows the full `SpainCycleSteps` pipeline inline (main→cfg→svc→agenda→datetime→booking), visible without expanding.

## Frontend: SpainCycleSteps component
Replaced the old `SpainScanTraceSummary` badges with `SpainCycleSteps` — a horizontal step pipeline showing each step as a colored pill with key metrics and boolean badges. Visible for ALL scan statuses (found / not_found / error). No React import needed — uses `<span key={i}>` wrapper instead of `React.Fragment`.

## CEV captcha fix (same session)
`cevBooking.ts` `solveHcaptcha()` read `process.env.ANTICAPTCHA_API_KEY` directly — misses keys stored only in Convex botConfig. Fixed to use `resolveAnticaptchaKey()` from `cevHttpSetup.ts` (checks env + botConfig). Added `import { resolveAnticaptchaKey } from './cevHttpSetup.js'` at top of `cevBooking.ts`.
