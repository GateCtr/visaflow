# VisaFlow

Visa appointment booking automation system for applicants based in Kinshasa, DRC. Monitors and auto-books appointment slots across multiple visa portals (USA, Spain, Belgium/CEV, Germany).

## Architecture

Monorepo with 4 services under `artifacts/`:

| Service | Port | Workflow name |
|---------|------|---------------|
| **Joventy** (React frontend) | 5000 | `artifacts/joventy: web` |
| **Captcha Service** | 3001 | `artifacts/captcha-service: Captcha Service` |
| **Proxy Service** | 3002 | `artifacts/proxy-service: Proxy Service` |
| **Slot Hunter bot** | — | `artifacts/slot-hunter: Slot Hunter` |

Backend: **Convex** (database + serverless functions) — `artifacts/joventy/convex/`

## Running the project

All 4 workflows are configured and start automatically. To restart any service individually, use the workflow panel or `WorkflowsRestart`.

**Install dependencies** (first time or after cloning):
```bash
cd artifacts/joventy && pnpm install
cd artifacts/captcha-service && npm install
cd artifacts/proxy-service && npm install
cd artifacts/slot-hunter && npm install
```

## Environment secrets required

| Secret | Used by |
|--------|---------|
| `ANTICAPTCHA_API_KEY` | Captcha Service |
| `CAPSOLVER_API_KEY` | Captcha Service |
| `CONVEX_DEPLOY_KEY` | Convex backend deploy |
| `DECODO_PROXY_URL` | Slot Hunter / Spain portal |
| `DECODO_UNLOCKER_TOKEN` | Slot Hunter / Spain portal |
| `OXYLABS_USERNAME` / `OXYLABS_PASSWORD` | Slot Hunter |
| `SESSION_SECRET` | Joventy |

External services also needed: **Clerk** (auth), **Convex** (backend), **2Captcha / CapSolver** (captcha solving), **Decodo / Oxylabs** (proxies).

## Known dev-environment limitations

- **Clerk auth** will show a domain error on the Replit dev domain — production keys are locked to `joventy.cd`. Use Clerk development keys for local testing.
- **Convex** functions must be deployed with `npx convex deploy --prod` (requires `CONVEX_DEPLOY_KEY`) after any schema/function changes.
- **Proxy Service** starts in "no proxy configured" mode if `DECODO_PROXY_URL` is not set — this is non-fatal.

## Key docs

- `ARCHITECTURE_DIAGRAM.md` — full system architecture
- `CEV_BOT_IMPLEMENTATION_PLAN.md` — CEV (Belgium) bot implementation details
- `artifacts/slot-hunter/SPAIN-FLOW.md` — Spain appointment flow
- `CLERK_SETUP.md` — Clerk auth configuration guide

## User preferences
