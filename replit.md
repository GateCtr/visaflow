# Joventy — Slot Hunter Platform

Visa appointment slot-hunting platform for clients in Kinshasa, DRC. Monitors embassy portals (Spain, France/CEV, Canada, USA) and auto-books available slots.

## Architecture

Four services run in parallel:

| Service | Port | Description |
|---|---|---|
| **Joventy** (frontend) | 5000 | React + Vite web app (Clerk auth, Convex backend) |
| **Slot Hunter** | — | Core booking engine: Spain, CEV, Canada, USA portals + Redis scheduler |
| **Captcha Service** | 3001 | Captcha solver proxy (2captcha / AntiCaptcha / CapSolver) |
| **Proxy Service** | 3002 | Residential proxy pool manager (Decodo / SOAX) |

Redis runs daemonized on localhost:6379, started by the Slot Hunter workflow.

## Running

All four workflows start automatically. Run them individually from the Workflows panel or click **Run** to start all at once.

- Joventy web app: http://localhost:5000
- Captcha service: http://localhost:3001
- Proxy service: http://localhost:3002

## Environment Variables (configured in Replit)

| Key | Purpose |
|---|---|
| `VITE_CONVEX_URL` | Convex deployment URL |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (prod — works only on joventy.cd) |
| `REDIS_URL` | Redis connection string (default: redis://localhost:6379) |
| `CAPTCHA_SERVICE_API_KEY` | Internal auth key for captcha service |
| `PROXY_SERVICE_API_KEY` | Internal auth key for proxy service |
| `HUNTER_API_KEY` | Internal auth key for slot-hunter API |
| `SPAIN_HTTP_MODE` | Use HTTP mode for Spain portal |
| `SPAIN_SESSION_MODE` | Spain session strategy (`persistent-browser`) |
| `SPAIN_SCAN_DISABLED` | Set to `1` to disable Spain scanning (prevents collision with Railway instance) |
| `SESSION_SECRET` | Secret for session signing |

### Captcha service needs at least one of:
- `TWOCAPTCHA_API_KEY`
- `ANTICAPTCHA_API_KEY`
- `CAPSOLVER_API_KEY`

### Proxy service needs at least one of:
- `DECODO_*` variables
- `SOAX_*` variables

## Notes

- Clerk production keys only work on `joventy.cd`; auth errors in Replit dev preview are expected.
- Spain scanning is disabled (`SPAIN_SCAN_DISABLED=1`) to avoid collision with the Railway production instance.
- Redis is installed via `nix-env`; the Slot Hunter workflow adds `~/.nix-profile/bin` to PATH before starting it.
- Convex schema/function changes require `npx convex deploy` with `CONVEX_DEPLOY_KEY`; `convex dev` sync alone is not enough.

## User Preferences

- Keep existing project structure and stack.
