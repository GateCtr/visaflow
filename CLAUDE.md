# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VisaFlow is a visa-appointment booking automation system for applicants in Kinshasa, DRC. It monitors and auto-books appointment slots across multiple official visa portals (USA/AIS, Spain/CitaConsular, Belgium-Schengen/CEV, Germany, Switzerland). The bulk of the value and complexity lives in the **slot-hunter** bot, which reverse-engineers each portal's client bundle and drives it via pure HTTP where possible, falling back to Playwright.

## Monorepo layout (pnpm workspaces)

`pnpm-workspace.yaml` globs `artifacts/*`, `lib/*`, `lib/integrations/*`, and `scripts`.

| Path | Package | Role |
|------|---------|------|
| `artifacts/slot-hunter/` | `@workspace/slot-hunter` | The bot. Portal handlers, captcha/proxy/cookie logic, background loops. **Core of the system.** |
| `artifacts/joventy/` | `@workspace/joventy` | React + Vite frontend (admin dashboard + client portal). Port 5000. |
| `artifacts/captcha-service/` | `@workspace/captcha-service` | Express captcha-solving microservice (2Captcha / CapSolver / Anti-Captcha). Port 3001. |
| `artifacts/proxy-service/` | `@workspace/proxy-service` | Express residential-proxy / IP-rotation service. Port 3002. |
| `artifacts/joventy/convex/` | — | **Canonical Convex backend** (DB schema + serverless functions). Joventy's Vite config aliases `@convex` → `artifacts/joventy/convex`. |
| `lib/db/` | `@workspace/db` | Drizzle ORM schema (Postgres). Separate from Convex. |
| `lib/api-spec/`, `lib/api-zod/`, `lib/api-client-react/` | — | OpenAPI spec, generated Zod schemas, React API client. |
| `cloudflare-worker/` | — | Edge worker for OTP email routing / webhooks. |

Note: the former root `convex/` duplicate was removed (2026-08-15). `artifacts/joventy/convex/` is the single source of truth for both frontend (`@convex` alias) and the deployed backend. Make all backend changes there.

Runtime is **tsx** (direct TypeScript execution, no build step) for all backend services; only Joventy is bundled (Vite).

## Commands

Package manager is **pnpm** (enforced by a `preinstall` guard — `npm`/`yarn` will fail). Run from workspace root unless noted.

```bash
pnpm install                      # install all workspace packages
pnpm run typecheck                # typecheck libs + artifacts + scripts (run before committing)
pnpm run build                    # typecheck, then build every package with a build script

# Per-service dev (each watches and restarts via tsx)
cd artifacts/slot-hunter   && pnpm run dev     # the bot (needs Redis + Chromium; see below)
cd artifacts/captcha-service && PORT=3001 pnpm run dev
cd artifacts/proxy-service && PORT=3002 pnpm run dev
cd artifacts/joventy       && pnpm run dev     # Vite dev server on :5000

# Typecheck a single package (this is the closest thing to a "lint")
cd artifacts/slot-hunter && npx tsc --noEmit
```

### Tests

Tests are plain **`node:test`** files (`*.test.ts`) run through tsx — there is **no** vitest/jest and no `test` npm script. Run one directly:

```bash
cd artifacts/slot-hunter && npx tsx --test src/spain-bookitit-params.test.ts
```

Many `test-*.ts` files at the slot-hunter root and `src/` are **live integration probes** (they hit real portals/proxies), not unit tests — exposed as named scripts (`pnpm run spain:test:...`, `pnpm run cev:capture`, etc.). Check `artifacts/slot-hunter/package.json` scripts before running; they consume captcha/proxy credits and can trip portal defenses.

### Convex backend

After changing anything under `artifacts/joventy/convex/`, deploy it (from `artifacts/joventy/`) (functions are not picked up automatically):

```bash
npx convex deploy --prod          # requires CONVEX_DEPLOY_KEY
```

### Deployment targets

Joventy → Vercel · slot-hunter → Railway/Docker (`Dockerfile`, based on `mcr.microsoft.com/playwright`) · Convex → Convex Cloud · OTP worker → Cloudflare. The Replit `Project` workflow (`.replit`) starts all four services in parallel and boots a local Redis for slot-hunter.

## slot-hunter architecture

`src/index.ts` is the entry point and job dispatcher. It polls Convex for due hunter jobs and routes by `job.destination`:

- `"schengen"` → `runCevCheck` (`cevBooking.ts`) — Belgium/CEV
- `"spain" | "espagne" | "es"` → `runSpainSession` (`spainPortal.ts`)
- `"germany"` → Germany dossier flow
- everything else (incl. `"usa"`) → `runHunterSession` (`navigator.ts`)

Alongside per-job dispatch, `index.ts` starts long-running **background loops** in `src/loops/` (`cev-setup-loop`, `cev-polling-loop`, `cev-dossier-loop`, `spain-watcher-loop`, `germany-loop`, `v3-loop`, `parallel-loop`). Each loop atomically claims work from Convex so multiple bot instances don't collide.

Cross-cutting modules: `browser.ts` (Playwright contexts + proxy wiring), `captcha.ts`/`capsolver.ts` (captcha), `proxyPool.ts` (rotation), `cookie-manager.ts` + `cev-f5-cookie-manager.ts` (WAF cookies), `convexClient.ts` (backend RPC), `humanBehavior.ts` (anti-detection timing).

### Portal-specific knowledge (read before touching a portal)

Each portal has distinct defenses and a documented reverse-engineered flow. The detailed reference is `.kiro/steering/06-european-portals.md`; key facts:

- **CEV/Belgium** (`cevPortal.ts`, `cevHttpSetup.ts`, `cevPolling.ts`, `cevHttpBooking.ts`): F5 BIG-IP + hCaptcha. Flow is VOWINT login → integration URL → `ASP.NET_SessionId` cookie → solve hCaptcha via **Anti-Captcha** (CapSolver blacklists the sitekey `5f64399c-14a8-415e-ad1a-7ebccdc4943a`) → poll `POST /Home/AvailableTimeSlots`. Hard limit: **≤5 VOWINT clicks/hour per AppId** (bot keeps 1 in reserve → max 4). Session valid ~15–20 min.
- **Spain** (`spainPortal.ts`, `spain/`, `citaconsularBookitit.ts`, `cloudflare-solver.ts`): CitaConsular/Bookitit behind Cloudflare Managed Challenge (Turnstile). Needs `cf_clearance` (CapSolver or manual capture, expires ~30 min), residential/ISP proxy with a France/Spain IP, and `Europe/Madrid` + `es-ES` locale. `SPAIN_HTTP_MODE` / `SPAIN_SESSION_MODE=persistent-browser` env vars select the strategy.
- **Switzerland** (`vowint-reverse/`, `swiss_bundle/ANALYSE_CH.md`): Angular + image captcha; XSRF + `Token` headers. The **server auto-assigns** the slot — there is no user selection.
- **USA/AIS**: `usaPortal/`, `navigator.ts`. Cancellable-appointment logic derives from `pendingAppoStatus` in the AIS bundle.

## Project conventions

Full detail in `.kiro/steering/` (comments and standards are in **French** — match the surrounding language when editing there and in commit messages).

- **TypeScript strict, never `any`** — use `unknown` + type guards. Explicit return types on exported functions. `try/catch` with contextual messages around every network call.
- **Naming**: module files `kebab-case.ts`, component files `PascalCase.tsx`, constants `UPPER_SNAKE_CASE`.
- **Logging**: prefix every log with the module name in brackets — `console.log("[usaPortal] ...")`. Don't leave unprefixed debug logs in a commit.
- **Golden rule for portal changes** (`.kiro/steering/03-bundle-analysis.md`): **never modify a portal's logic without first analysing its current JS bundle.** Portals change client logic silently; existing comments/code may be stale. Bundle-analysis tooling and dated notes live in `artifacts/slot-hunter/bundle-analysis/`.
- **Anti-detection** (`.kiro/steering/05-security-performance.md`): behave like a human — randomized delays with jitter (never fixed intervals), realistic/consistent headers, keep one IP per session, reuse `cf_clearance`/`__cf_bm` rather than re-solving.
- **Commits**: Conventional Commits in French, `type(scope): description` — scopes include `usa`, `spain`, `canada`, `hunter`, `captcha`, `proxy`, `api`, `db`, `infra`, `shared`. Typecheck clean and no secrets in the diff before committing.

## Secrets & env

Secrets go in `.env` (never in source). Non-secret shared env for the Replit workflow lives under `[userenv.shared]` in `.replit`. Required across services: `CONVEX_DEPLOY_KEY`, `HUNTER_API_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`/Clerk secret, `CAPSOLVER_API_KEY`, `ANTICAPTCHA_API_KEY`, proxy creds (`DECODO_*`, `OXYLABS_*`, `IPROYAL_*`, `BRIGHTDATA_*`), `SESSION_SECRET`. Auth is **Clerk** (production keys locked to `joventy.cd`; use Clerk dev keys locally). See `CLERK_SETUP.md`.
