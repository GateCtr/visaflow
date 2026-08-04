# VisaFlow — Replit Project Overview

## What this is
VisaFlow is a visa appointment booking automation monorepo. It monitors and auto-books appointment slots across multiple consular portals (USA, Spain, Belgium/CEV, Germany) on behalf of clients.

## Architecture (4 services)

| Service | Location | Port | Purpose |
|---|---|---|---|
| **Joventy** | `artifacts/joventy/` | 5000 | React/Vite frontend — admin dashboard & client portal |
| **Slot Hunter** | `artifacts/slot-hunter/` | — | Puppeteer bot — scans & books visa slots |
| **Captcha Service** | `artifacts/captcha-service/` | 3001 | AntiCaptcha / CapSolver proxy |
| **Proxy Service** | `artifacts/proxy-service/` | 3002 | Proxy pool management |

Backend is **Convex** (hosted at `https://famous-albatross-420.convex.cloud`).

## How to run

All 4 workflows are pre-configured. Start them from the Replit workflow panel:

- `artifacts/joventy: web` → Vite dev server on port 5000
- `artifacts/captcha-service: Captcha Service` → Express on port 3001
- `artifacts/proxy-service: Proxy Service` → Express on port 3002
- `artifacts/slot-hunter: Slot Hunter` → Bot process (no HTTP port)

## Environment secrets (already configured)

| Secret | Used by |
|---|---|
| `ANTICAPTCHA_API_KEY` | captcha-service, slot-hunter |
| `CAPSOLVER_API_KEY` | captcha-service, slot-hunter |
| `CONVEX_DEPLOY_KEY` | Convex deployments |
| `DECODO_PROXY_URL` | slot-hunter (Spain HTTP mode) |
| `DECODO_UNLOCKER_TOKEN` | slot-hunter |
| `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` | slot-hunter |
| `SESSION_SECRET` | app sessions |

## Non-secret env vars (set in Replit shared env)

| Key | Value |
|---|---|
| `CAPTCHA_SERVICE_API_KEY` | Auto-generated internal service key |
| `PROXY_SERVICE_API_KEY` | Auto-generated internal service key |
| `CONVEX_SITE_URL` | `https://famous-albatross-420.convex.site` |
| `HUNTER_API_KEY` | Bot auth key for Convex HTTP API |

## Known limitations on Replit dev domain

- **Clerk auth** is bound to `joventy.cd` (production domain). Login/signup won't work on the `.replit.dev` preview URL. Public-facing pages render fine. To test auth, deploy to the production domain or add a Clerk dev-instance key (`VITE_CLERK_PUBLISHABLE_KEY_DEV`).

## Convex deployments

Schema/function changes require an explicit deploy — `npx convex deploy` with `CONVEX_DEPLOY_KEY`. There is no local `convex dev` sync. See `.agents/memory/convex-prod-deploy-flow.md`.

## User preferences
