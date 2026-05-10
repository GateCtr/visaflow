# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Project: Joventy.cd

Premium visa assistance SaaS for the Democratic Republic of Congo (RDC/DRC).

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + TailwindCSS + shadcn/ui
- **Auth**: Clerk (email, phone, Google, Apple, Facebook OAuth)
- **Real-time DB**: Convex (queries, mutations, real-time subscriptions)
- **Forms**: react-hook-form + @hookform/resolvers + zod
- **Charts**: recharts
- **Routing**: Wouter (SPA)

## USA Portal — Anti-restriction (2026-05-10)

### 4 correctifs anti-ban account-level (restriction 15-30 min)

**Problème racine** : restriction account-level sur le portail USA — une restriction sur un compte persiste même en changeant d'IP (iProyal). La boucle mortelle : 401 "restricted" → `TokenExpiredError` → cache supprimé → re-login → login aussi 401 → loop toutes les 3-5 min → restriction prolongée.

**Fix 1 — `AccountRestrictedError` + `accountRestrictedUntil` map**
- Nouvelle classe `AccountRestrictedError` (≠ `TokenExpiredError`) : lève quand 401 body contient "temporarily", "restricted", "too many", "rate limit"
- Map `accountRestrictedUntil: Map<username, timestamp>` : quand restriction détectée, NE PAS vider le cache — enregistrer fin de restriction (now + 25 min)
- `isAccountRestricted(username)` : guard vérifié **avant tout appel API** dans `getUsaSession`
- `markAccountRestricted(username)` : fonction partagée entre tous les sites de détection

**Fix 2 — Distinction "restricted" vs "token expiré"**
- `isRestrictedBody(body)` : détecte le corpus 401 dans login, appointment status, et **toutes** les fonctions de scan (getTransformData, getOfcList, getFirstAvailableMonth, getSlotDates, getSlotTime, bookUsaSlot, rescheduleUsaSlot)
- `checkSlotResponse` rendue `async` pour lire le body 401
- En cas de restriction → `markAccountRestricted()` + `return "not_found"` (pas d'effacement cache)
- En cas de vrai token expiré → `tokenCache.delete()` + reconnexion (comportement original)
- `runUsaApiSession` : quand `getUsaSession` retourne `null` → distinction "restreint" (not_found, pas de panique) vs "credentials incorrects" (login_failed, pause)

**Fix 3 — Warm-up throttle (max 1×/8 min)**
- `WARMUP_INTERVAL_MS = 8 min`, map `warmupLastCalledAt: Map<applicationId, timestamp>`
- Sans throttle en tier tres_urgent (3-5 min) = 36-60 appels warm-up/heure (landingPage + sanityCheck + checkFcs)
- Avec throttle : 7-8 appels warm-up/heure — économie 85%
- Le warm-up reste effectif : effectué au 1er cycle puis toutes les ~8 min pour maintenir le pattern de navigation

**Fix 4 — OFC round-robin (1 OFC par cycle)**
- `ofcCursor: Map<applicationId, index>` : scan 1 seule OFC par cycle, rotation circulaire
- Avec 3 OFCs en tres_urgent (3-5 min) : sans round-robin = 9 appels slot/cycle, avec = 3 appels — économie 66%
- Chaque OFC vérifiée toutes les N×(3-5) min — acceptable (créneaux n'apparaissent pas à la seconde)
- Avec 1 OFC unique : comportement identique à l'ancien (ofcToScan = ofcList entier)

**Résultat** : en tier tres_urgent, de ~85-200 appels/heure → ~30-50 appels/heure. Probabilité de restriction divisée par ~3-4.

## USA Portal — Reschedule API-first (2026-05-10)

### Rebooking Christian BUKELA (pendingAppoStatus=0, cancellable=true)
- **Cas "cancellable"** : `fetchCancellableSessionIds()` remplace Playwright — appels API directs Bearer :
  1. `GET /appointments/scheduledappointmentInfo` → applicationId + appointmentId existant
  2. `GET /appointments/getLandingPageDeatils` (fallback avec `LanguageId: 1`)
  3. `POST /appointments/search` → détails complets (applicantId, applicantUUID)
- **Reschedule endpoint** : `PUT /appointments/reschedule` (vs `/schedule` pour nouveaux RDV)
  - Payload = TABLEAU `[{...10 champs + rescheduleType:"POST"}]`
  - `rescheduleType` = type de localisation du RDV EXISTANT (`"POST"` = ambassade)
  - `appointmentId` dans le payload = ID du RDV existant à annuler/reporter
- **Sélection automatique** : `session.isReschedule=true` (cas cancellable) **ou** `hunterConfig.rescheduleMode=true` (cas scheduled) → `rescheduleUsaSlot()` utilisé à la place de `bookUsaSlot()`
- **URL corrigée** : `USA_LANDING_PAGE_URL` = `/appointments/getLandingPageDeatils` (pas `/appointment/...`)
- Nouvelles constantes : `USA_RESCHEDULE_URL`, `USA_SEARCH_URL`, `USA_SCHEDULED_INFO_URL`
- Nouvelle fonction `corrId()` (15-char alphanumeric, partagée entre `fetchCancellableSessionIds` et `test-new-endpoints.ts`)

## Architecture Captcha & Proxy (décision 2026-05-10)

`captcha-service` et `proxy-service` sont des **librairies locales**, pas des services HTTP séparés sur Railway. Le bot `slot-hunter` importe directement leurs modules TypeScript via les dépendances workspace pnpm :

- `captcha.ts` dans slot-hunter → remplacé par import de `@workspace/captcha-service/src/resolver` (appel direct, pas HTTP)
- `ProxyPool` dans `browser.ts` → remplacé par import de `@workspace/proxy-service/src/pool`

**Pas de déploiement séparé Railway** pour ces deux packages — un seul service bot, zéro latence réseau inter-service.

Les workflows Replit `captcha-service` et `proxy-service` restent présents pour développement/test local uniquement.

## CEV Bot — Anti-détection (dernière mise à jour 2026-05-05)

### Problèmes corrigés
1. **3 sessions Playwright** (`runCevBookingSession`, `establishCevSessionOnly`, `runCevDirectSessionSetup`) passées de `chromium.launch()` brut → `launchBrowser()` (StealthPlugin, proxy résidentiel, UA rotation, fingerprint masqué).
2. **Login VOWINT humanisé** : `page.fill()` → `humanType()`, `page.click()` → `humanClick()`, délais aléatoires entre chaque champ.
3. **Clic bouton RDV humanisé** : pause aléatoire 1-2.5s + `humanScroll()` avant le clic.
4. **Clics date/heure/confirm** : `el.click()` → `humanClick(page, sel)`.
5. **Délais fixes** : tous les `setTimeout(r, N)` → `randomDelay(min, max)`.
6. **`cevPolling.ts`** : UA Android+Chrome147 → `randomUserAgent()` (desktop Chrome/Edge/Safari/Firefox).
7. **`cevPortal.ts`** : UA statique → `randomUserAgent()` dans tous les fetch HTTP.
8. **Capture URL d'intégration** : `/Integration/VOW/...` capturée automatiquement depuis les requêtes de navigation du nouvel onglet.

### Migration CEV Sessions — VOWINT credentials
- `convex/schema.ts` : ajout `vowintEmail`, `vowintPassword`, `vowintAppUrl` (optional) à `cevSessions`.
- `convex/cevSessions.ts` : `upsertSession` supporte credentials VOWINT OU URL legacy ; `internalClaimNeedsSetup` retourne les credentials ; `internalActivateSession` accepte `integrationUrl`.
- `convex/http.ts` : endpoint activate accepte `integrationUrl`.
- `convexClient.ts` : `CevSetupTask` + `activateCevSession` étendus.
- `CevSessions.tsx` : formulaire email VOWINT + mot de passe + URL dossier optionnelle + bouton "relancer config auto".
- `cevBooking.ts` : `runCevDirectSessionSetup` accepte credentials OU URL (backward compat) ; en mode credentials, réutilise `establishCevSession()`.
- `index.ts` : boucle setup détecte automatiquement le mode.

## Architecture

```text
workspace/
├── artifacts/
│   ├── joventy/              # Frontend React + Vite (main app)
│   └── slot-hunter/          # Autonomous Playwright bot (run on Railway)
│       ├── src/
│       │   ├── index.ts          # Main loop (priority queue, jitter intervals)
│       │   ├── convexClient.ts   # HTTP client → Convex endpoints
│       │   ├── browser.ts        # Playwright + stealth, humanType/Click/Scroll
│       │   ├── captcha.ts        # 2captcha integration
│       │   └── navigator.ts      # Login, slot scan, logout, 5min timeout
│       ├── .env.example
│       └── README.md
├── convex/                   # Convex backend (realtime functions)
│   ├── schema.ts             # Database schema
│   ├── auth.config.ts        # Clerk JWT configuration
│   ├── applications.ts       # CRUD for visa applications
│   ├── messages.ts           # Client-admin chat
│   ├── admin.ts              # Admin stats & client listing
│   ├── hunter.ts             # Robot job queue, heartbeat, slot-found logic
│   ├── slotFoundHelper.ts    # Shared coreMarkSlotFound helper
│   └── _generated/           # Auto-generated by Convex CLI
├── CLERK_SETUP.md            # Guide for Clerk + Convex configuration
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## Joventy.cd Features

### Authentication (Clerk)
- Email/password
- Phone (SMS OTP)
- Google OAuth
- Apple OAuth
- Facebook OAuth
- Admin role: set via `publicMetadata.role = "admin"` in Clerk dashboard

### Roles
- `client` — can manage their own visa applications, chat with admin
- `admin` — can see all applications, update statuses, chat with clients

### Pages

**Public:**
- `/` — Landing page (French, premium institutional design)
- `/login` — Clerk `<SignIn>` component
- `/register` — Clerk `<SignUp>` component
- `/sso-callback` — Clerk OAuth redirect handler

**Client (`/dashboard/*`):**
- `/dashboard` — Overview with active applications
- `/dashboard/applications` — List of applications
- `/dashboard/applications/new` — Multi-step application form (3 steps)
- `/dashboard/applications/:id` — Application detail + real-time chat

**Admin (`/admin/*`):**
- `/admin` — Stats dashboard (recharts: bar chart by destination)
- `/admin/applications` — All applications with status filter + search
- `/admin/applications/:id` — Detail, status update, price, RDV, real-time chat
- `/admin/clients` — Client list derived from applications

### Destinations & Visa Types
- **USA**: B1/B2, F1, K1, H1B, J1
- **Dubaï**: Touriste 30j, Touriste 60j, Résidence, Affaires
- **Turquie**: Touriste, Affaires, Étudiant
- **Inde**: e-Visa Touriste, Affaires, Médical

### Application Status Flow
`awaiting_engagement_payment` → `documents_pending` → `in_review` | `slot_hunting` → `slot_found_awaiting_success_fee` → `completed` | `rejected`

### Pricing & Payments
- **Engagement fee**: Paid upfront per destination (50–150 USD); receipt uploaded as Mobile Money screenshot
- **Prime de succès**: Paid after slot is found (50–450 USD); server-side paywall hides appointment details
- Admin validates both payments via `validateEngagementPayment` / `validateSuccessFee` mutations
- `markSlotFound` sets 48h countdown timer (`slotExpiresAt`) and appointment details (date, time, location, code)

## Convex Data Model

### `applications` table
- userId, userFirstName, userLastName, userEmail, userPhone
- destination, visaType, applicantName, passportNumber
- travelDate, returnDate, purpose, notes
- status, appointmentDate, adminNotes, price, isPaid
- priceDetails: { engagementFee, successFee, paidAmount, isEngagementPaid, isSuccessFeePaid }
- logs: [{ msg, time, author }]
- paymentProofUrl, successFeeProofUrl (Convex storageIds)
- appointmentDetails: { date, time, location, confirmationCode, notes }
- rejectionReason, slotExpiresAt
- updatedAt

Indexes: `by_user`, `by_status`, `by_updated`

### `messages` table
- applicationId (ref), senderId, senderName, content, isFromAdmin

Index: `by_application`

### `documents` table (coffre-fort)
- applicationId (ref), docKey, label
- storageId (Convex file storage)
- uploadedBy (userId), uploadedAt
- verifiedByAdmin (bool), isAdminUpload (bool), adminNote

Indexes: `by_application`, `by_application_key`

## Slot Hunter — CEV/Schengen Flow (Belgique via VOWINT)

### Architecture VOWINT → CEV (confirmé par inspection live)

```
visaonweb.diplomatie.be  →  appointment.cloud.diplomatie.be
     (VOWINT)                         (CEV)
```

**Flux complet vérifié :**
1. `GET https://visaonweb.diplomatie.be` → redirige vers login
2. `POST` formulaire : `input#UserName`, `input#Password`, `button[type="submit"]`
3. `GET /en/VisaApplication/IndexByUserId` → tableau AngularJS avec les dossiers
4. Clic `[ng-click*="groupVAEapp"]` → nouvel onglet vers `appointment.cloud.diplomatie.be/Captcha`
5. Cookie `ASP.NET_SessionId` extrait via `context.cookies()` (jar navigateur, pas headers)
6. hCaptcha sitekey : `5f64399c-14a8-415e-ad1a-7ebccdc4943a`
7. POST `appointment.cloud.diplomatie.be/Captcha/SetCaptchaToken` avec token 2captcha
8. Réponse : `{ validUntil, redirectUrl }` → redirectUrl = page des créneaux

**CEV API endpoints (confirmés par discovery live 2026-05-10) :**
- `POST /Captcha/SetCaptchaToken` — body: `captcha=<token>` (form-encoded, pas de CSRF requis)
  - Réponse: `{ captchaSolved: bool, validUntil: string|null, redirectUrl: string|null, defaultTimeout: 15 }`
  - `captchaSolved: false` si token invalide ; `true` + redirectUrl si OK
  - `redirectUrl` = `Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}` — le dernier GUID change à chaque session
  - ⚠️ `redirectUrl` NE contient PAS "NoAvailability" directement — il faut naviguer vers cette URL pour savoir
- `GET {redirectUrl}` → 302 → `GET /Integration/VOW/SelectSlot`
  - → 302 → `GET /Integration/Error/NoAvailability` si pas de créneaux
  - → 200 sur page calendrier si créneaux disponibles
  - `completeCevCaptcha()` suit les redirects via fetch pour lire l'URL finale (corrigé 2026-05-10)
- `POST /Home/AvailableTimeSlots` — body: `{ month: N, year: YYYY }` — polling créneaux depuis page calendrier
- `POST /Shared/DoCancelRequestAppointment` — body: `{ uniqueToken, cultureCode }` — annuler RDV
- `ajaxUrl` = `https://appointment.cloud.diplomatie.be/` (base de tous les appels AJAX)

**hCaptcha — statut résolution (confirmé 2026-05-10) :**
- Sitekey : `5f64399c-14a8-415e-ad1a-7ebccdc4943a`
- **Anti-Captcha** ✅ : `HCaptchaTaskProxyless` — résolu en 10s (workers libres) à 200s+ (workers occupés)
- **CapSolver** : blackliste cette sitekey gov depuis 2026-04 — inutilisable
- **2captcha** : `HCaptchaTaskProxyless` NON disponible sur ce compte (plan actuel = reCAPTCHA v2 seulement)

**Données test :**
- Compte VOWINT : `screentapinc@gmail.com` (VOWINT secret Replit)
- Application : VOWINT5903406 — NGOBI ESTHER (ID Convex : `e978b2fd-472f-f111-a3ae-00505691de06`)
- Org ID CEV (fixe) : `df171b6f-871b-48d2-b6ac-7352d37cd13b`
- Session GUID (fixe par app) : `59eba882-4cc3-4ede-ba31-935d81f9393c`
- Token GUID (change chaque session) : ex. `b2f37202-726d-4e0f-910a-e02a108c61b1`

**Fichiers clés :**
- `artifacts/slot-hunter/src/cevBooking.ts` — `establishCevSession()` + `runCevCheck()` + `runCevBookingSession()` + `solveHcaptchaViaCapsolver()`
- `artifacts/slot-hunter/src/cevPortal.ts` — `completeCevCaptcha()` + `pollCevSlots()`
- `convex/hunter.ts` — `recordCevClick` (rate limit 4 clics/h), `recordHeartbeat`, `markSlotFoundByHunter`
- `convex/http.ts` — `/hunter/cev-click`, `/hunter/heartbeat`, `/hunter/slot-found`, `/hunter/log`

**Envvars requises pour le bot :**
- `VOWINT_TEST_PASSWORD` — mot de passe compte screentapinc@gmail.com
- `TWOCAPTCHA_API_KEY` — clé API 2captcha (reCAPTCHA v2 uniquement sur ce compte)
- `CAPSOLVER_API_KEY` — **À AJOUTER** — clé CapSolver pour résoudre hCaptcha CEV
- `CONVEX_SITE_URL` — URL site actions Convex (e.g. `https://famous-albatross-420.convex.site`)
- `HUNTER_API_KEY` — clé secrète pour l'endpoint `/hunter/*`

**Rate limit CEV :** 4 clics/heure par application, suivi dans `hunterConfig.cevClickCount` + `cevClickWindowStart`

## Environment Variables Required

| Variable | Description |
|----------|-------------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (`pk_...`) |
| `VITE_CONVEX_URL` | Convex deployment URL |
| `CONVEX_DEPLOY_KEY` | Convex deploy key (for CLI) |
| `SESSION_SECRET` | Express session secret |

## Convex Deployment

Deploy Convex functions with:
```bash
CONVEX_DEPLOY_KEY=$CONVEX_DEPLOY_KEY npx convex deploy --yes --preview-create=joventy-dev
```

The deployment URL changes per session. Update `VITE_CONVEX_URL` to match the printed URL.

## Clerk Configuration Required

See `CLERK_SETUP.md` for detailed instructions including:
- OAuth provider setup (Google, Apple, Facebook)
- JWT Template "convex" with `role` claim
- Admin role assignment via publicMetadata

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json`. The root `tsconfig.json` lists packages as project references. Convex types are in `convex/_generated/` (auto-generated, `.d.ts` + `.js`).

## Root Scripts

- `pnpm run build` — typechecks + builds all packages
- `pnpm run typecheck` — runs TypeScript project reference check
