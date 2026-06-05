# VisaFlow Architecture Diagram

## Overview
VisaFlow is a monorepo-based visa appointment booking automation system that monitors and books appointment slots across multiple visa portals (USA, Spain, Belgium/CEV, Germany). The system uses Convex as a backend database, Playwright for browser automation, and multiple specialized services for captcha solving, proxy management, and slot hunting.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              VisaFlow Monorepo                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐      │
│  │   Joventy (Web)  │    │   Convex Backend │    │  Slot Hunter Bot │      │
│  │   (React + Vite)  │◄──►│   (Database +    │◄──►│  (Playwright +   │      │
│  │   - Admin UI      │    │    API Server)   │    │   Automation)    │      │
│  │   - Client Portal │    │                  │    │                  │      │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘      │
│           │                       │                       │                  │
│           │                       │                       │                  │
│           ▼                       ▼                       ▼                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐      │
│  │  Clerk Auth      │    │  External APIs   │    │  Captcha Service │      │
│  │  (Authentication)│    │  - Visa Portals  │    │  - 2Captcha      │      │
│  │                  │    │  - Email/SMS     │    │  - CapSolver     │      │
│  └──────────────────┘    └──────────────────┘    └──────────────────┘      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Joventy (Frontend Web Application)
**Location:** `artifacts/joventy/`
**Tech Stack:** React, Vite, Radix UI, Tailwind CSS, Clerk Auth

**Features:**
- Admin dashboard for managing visa applications
- Client portal for tracking application status
- CEV session management interface
- Bot configuration and monitoring
- Document upload and management
- Real-time notifications

**Key Files:**
- `src/` - React components and pages
- `package.json` - Dependencies (React, Convex client, Clerk)

### 2. Convex Backend
**Location:** `convex/`
**Tech Stack:** Convex (Database + Serverless Functions)

**Core Tables:**
- `applications` - Visa application records with hunter config
- `users` - User accounts (admin/client roles via Clerk)
- `cevSessions` - Belgian visa appointment sessions
- `botLogs` - Bot activity logs
- `slotDiscoveries` - Slot availability tracking
- `slotBroadcasts` - Multi-account slot sharing (V3)
- `otpChallenges` - OTP handling for Spain/other flows
- `notifications` - User notifications

**Key Modules:**
- `schema.ts` - Database schema definitions
- `hunter.ts` - Hunter bot configuration and management
- `cevSessions.ts` - CEV session lifecycle management
- `http.ts` - HTTP endpoints for bot communication
- `applications.ts` - Application CRUD operations
- `emails.ts` - Email notifications
- `crons.ts` - Scheduled tasks

### 3. Slot Hunter Bot
**Location:** `artifacts/slot-hunter/`
**Tech Stack:** TypeScript, Playwright, Puppeteer, Redis (optional)

**Core Modules:**

#### Browser Automation
- `browser.ts` - Browser context and proxy management
- `navigator.ts` - Main navigation orchestrator
- `securityCheck.ts` - Anti-detection measures

#### Portal Handlers
- `usaPortal.ts` - USA visa portal automation
- `spainPortal.ts` - Spain visa portal automation
- `cevBooking.ts` - Belgian (CEV) visa portal automation
- `germanyPortal/` - Germany visa portal handlers

#### Captcha Solvers
- `captcha.ts` - Unified captcha interface
- `capsolver.ts` - CapSolver integration
- `cloudflare-solver.ts` - Cloudflare challenge handling
- `cev-f5-cookie-manager.ts` - F5 WAF cookie management

#### Session Management
- `cevPolling.ts` - CEV slot polling (API-based)
- `cevHttpSetup.ts` - CEV session establishment
- `sessionWorker.ts` - F5 cookie siphoning from real browsers
- `cookie-manager.ts` - Cookie lifecycle management

#### Background Loops
- `loops/cev-setup-loop.ts` - CEV session establishment
- `loops/cev-polling-loop.ts` - CEV slot availability polling
- `loops/cev-dossier-loop.ts` - CEV dossier scanning (V3)
- `loops/cev-stealth-loop.ts` - CEV stealth mode (V2)
- `loops/spain-watcher-loop.ts` - Spain slot watching
- `loops/v3-loop.ts` - V3 multi-account coordination
- `loops/parallel-loop.ts` - Parallel account management

#### Utilities
- `convexClient.ts` - Convex API client
- `proxyPool.ts` - Proxy rotation and management
- `scheduler-utils.ts` - Job scheduling utilities
- `daily-report.ts` - Daily reporting

### 4. Supporting Services

#### Captcha Service
**Location:** `artifacts/captcha-service/`
- Captcha solving microservice
- Supports 2Captcha, CapSolver, Anti-Captcha

#### Proxy Service
**Location:** `artifacts/proxy-service/`
- Residential proxy management
- IP rotation and whitelisting
- Fixed IP solutions for rate-limited portals

#### Cloudflare Worker
**Location:** `cloudflare-worker/`
- OTP email routing
- Webhook handling

## Data Flow

### Visa Application Flow

```
1. Client submits application via Joventy UI
   ↓
2. Application stored in Convex (applications table)
   ↓
3. Admin configures hunter settings (credentials, schedule, dates)
   ↓
4. Hunter bot picks up active jobs via Convex API
   ↓
5. Bot logs into visa portal (solves captcha if needed)
   ↓
6. Bot polls for available slots
   ↓
7. When slot found → book it OR notify admin
   ↓
8. Update application status in Convex
   ↓
9. Notify client via email/UI
```

### CEV (Belgian Visa) Flow

```
1. Admin creates CEV session (VOWINT credentials or integration URL)
   ↓
2. Session status = "needs_setup"
   ↓
3. CEV Setup Loop claims session
   ↓
4. Bot logs into VOWINT, solves hCaptcha via CapSolver
   ↓
5. Bot extracts ASP.NET_SessionId cookie
   ↓
6. Session status = "active", cookie stored in Convex
   ↓
7. CEV Polling Loop claims active sessions
   ↓
8. Bot calls POST /Home/AvailableTimeSlots (API, no browser)
   ↓
9. If slot found → notify admin, pause session
   ↓
10. If cookie expired → status = "needs_setup" (auto-renewal)
```

### V3 Multi-Account Coordination

```
1. Accounts grouped by broadcastVisaClass (e.g., "F1", "B1/B2")
   ↓
2. Each account has role: "eclaireur" (scout) or "confine" (confined)
   ↓
3. Éclaireur scans calendar, broadcasts slots via slotBroadcasts table
   ↓
4. Confinés listen to broadcasts, attempt blind booking
   ↓
5. Relay system auto-switches roles when limits hit
   ↓
6. Rush windows configured for high-availability periods
```

## Key Technologies

### Frontend
- **React** - UI framework
- **Vite** - Build tool
- **Radix UI** - Component library
- **Tailwind CSS** - Styling
- **Clerk** - Authentication
- **Convex** - Database client
- **React Query** - Data fetching

### Backend
- **Convex** - Serverless database + functions
- **Svix** - Webhook handling (Clerk integration)

### Bot/Automation
- **Playwright** - Browser automation
- **Puppeteer** - Alternative browser automation
- **impit** - TLS fingerprinting for anti-detection
- **Redis** - Optional persistence layer
- **Node.js** - Runtime

### External Services
- **2Captcha** - Captcha solving
- **CapSolver** - Preferred captcha solver (hCaptcha)
- **Anti-Captcha** - Alternative captcha solver
- **Resend** - Email service
- **BrightData/IPRoyal** - Residential proxies

## Deployment

### Hosting
- **Convex** - Backend hosting
- **Vercel** - Frontend hosting (Joventy)
- **Railway** - Bot hosting (Slot Hunter)
- **Cloudflare** - Edge functions (OTP routing)

### Environment Variables
Key configuration via `.env` files:
- `CONVEX_SITE_URL` - Convex backend URL
- `HUNTER_API_KEY` - Bot authentication
- `CLERK_SECRET_KEY` - Clerk auth
- `CAPSOLVER_API_KEY` - Captcha solving
- `TWOCAPTCHA_API_KEY` - Alternative captcha
- `OTP_INGEST_SECRET` - OTP webhook security

## Security Features

1. **Role-based access** - Admin vs Client roles via Clerk
2. **API key authentication** - Hunter bot communication
3. **TLS fingerprinting** - impit for anti-detection
4. **Proxy rotation** - IP whitelisting and residential proxies
5. **Rate limiting** - Built-in delays and radio silence
6. **Cookie siphoning** - F5 WAF bypass via real browser cookies
7. **Session locking** - Atomic claims to prevent duplicate work

## Monitoring & Logging

- **botLogs table** - Detailed bot activity logs
- **slotDiscoveries table** - Slot availability analytics
- **Daily reports** - Automated daily summaries
- **Admin notifications** - Real-time alerts via Convex
- **HTTP logs** - Request/response tracking in slot-hunter

## Scaling Strategy

1. **Multi-account coordination** - V3 broadcast system
2. **Parallel processing** - Multiple bot instances
3. **Proxy pools** - IP diversity
4. **Session persistence** - Survive restarts via Convex
5. **Atomic locking** - Prevent duplicate work across instances
