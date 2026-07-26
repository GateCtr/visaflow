# Joventy — Plateforme de gestion visa + Agent Victor

## Vue d'ensemble

Joventy est une plateforme de gestion de dossiers visa (RDC → monde entier) composée de 4 services :

| Service | Port | Description |
|---------|------|-------------|
| `artifacts/joventy` | 5000 | Frontend React + Vite (dashboard clients/admin) |
| `artifacts/slot-hunter` | — | Bot d'automatisation des rendez-vous consulaires |
| `artifacts/captcha-service` | 3001 | Microservice résolution captcha (Anti-Captcha, CapSolver, 2Captcha) |
| `artifacts/proxy-service` | 3002 | Microservice gestion pool de proxies (BrightData, IPRoyal) |

## Stack technique

- **Frontend** : React 19, Vite, Tailwind CSS, Radix UI, TanStack Query, Wouter
- **Backend** : Convex (base de données + fonctions serverless + HTTP actions)
- **Auth** : Clerk
- **Automation** : Playwright, Puppeteer-extra stealth, Redis
- **Agent IA** : AWS Bedrock (amazon.nova-lite-v2:0)

## Démarrer les services

Tous les services se lancent automatiquement via les workflows Replit. Le bouton Run démarre tout en parallèle.

Pour démarrer uniquement l'interface web dans le workspace :

```bash
pnpm install --frozen-lockfile
cd artifacts/joventy
PORT=5000 BASE_PATH=/ pnpm run dev
```

Le workflow principal Replit `artifacts/joventy: web` exécute déjà cette commande et expose l'interface sur le port 5000. Le contrôle TypeScript se lance avec `pnpm --filter @workspace/joventy run typecheck`; le build de production se lance avec `pnpm --filter @workspace/joventy run build:vite`.

### Authentification dans l'aperçu Replit

La clé Clerk de production configurée pour le site fonctionne sur `joventy.cd`, mais Clerk refuse les requêtes provenant du domaine de prévisualisation Replit. La page publique reste consultable, mais la connexion et l'inscription nécessitent soit un domaine autorisé par Clerk, soit une clé Clerk de développement dédiée à l'aperçu.

### Dépendances pré-installées
- `artifacts/joventy` → `pnpm install` ✓
- `artifacts/slot-hunter` → `npm install` ✓ + Chromium téléchargé
- `artifacts/captcha-service` → `npm install` ✓
- `artifacts/proxy-service` → `npm install --ignore-scripts` ✓
- Redis installé système (démarré automatiquement par le slot-hunter)

## Backend Convex

- **Cloud URL** : `https://famous-albatross-420.convex.cloud`
- **Site URL (HTTP actions)** : `https://famous-albatross-420.convex.site`
- Fonctions locales dans `artifacts/joventy/convex/`
- Déployer : `cd artifacts/joventy && npx convex deploy --yes`
- Variables d'environnement Convex : `cd artifacts/joventy && npx convex env set KEY=VALUE`

⚠️ Les fichiers convex sont aussi présents dans `./convex/` (racine) — source of truth. Après toute modification dans `./convex/`, copier vers `artifacts/joventy/convex/` et redéployer.

## Agent Victor IA

Victor est l'agent commercial IA de Joventy, intégré dans le frontend :

- **Widget** : `artifacts/joventy/src/components/VictorWidget.tsx`
- **Backend** : `artifacts/joventy/convex/chat.ts` (HTTP action `/api/chat`)
- **Admin stats** : `artifacts/joventy/src/pages/admin/VictorAnalytics.tsx` → `/admin/victor`
- **Modèle** : Amazon Nova Lite v2 via AWS Bedrock
- **Fonctionnalités** :
  - Page-aware (adapte son discours selon la page visitée)
  - Toujours en français
  - Rate limiting : 5 msg/min, 30 msg/h par session
  - CTA cliquables dans les réponses
  - Tracking des "utilisateurs convaincus" dans `victorConversations`
  - Dashboard admin avec stats de conversion

## Variables d'environnement requises

### Partagées (déjà configurées)
- `VITE_CONVEX_URL` : URL Convex cloud
- `CONVEX_SITE_URL` : URL Convex site (HTTP actions)
- `HUNTER_API_KEY` : Clé auth pour le slot-hunter
- `VITE_CLERK_PUBLISHABLE_KEY` : Clé publique Clerk
- `REDIS_URL` : redis://localhost:6379
- `PROXY_SERVICE_API_KEY` : Clé interne pour le proxy-service
- `CAPTCHA_SERVICE_API_KEY` : Clé interne pour le captcha-service

### Secrets (configurés)
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` + `BEDROCK_REGION` : Pour Victor/Bedrock
- `CONVEX_DEPLOY_KEY` : Pour `npx convex deploy`
- `SESSION_SECRET` : Secret de session

### Secrets optionnels (services dégradés sans eux)
- `ANTICAPTCHA_API_KEY` / `CAPSOLVER_API_KEY` / `TWOCAPTCHA_API_KEY` : Fournisseurs captcha
- `BRIGHTDATA_PROXY_URL` / `IPROYAL_PROXY_URL` : Fournisseurs proxy
- `CLERK_SECRET_KEY` : Pour le webhook Clerk
- `CLERK_WEBHOOK_SECRET` : Pour la vérification des webhooks Clerk

## Structure des fichiers clés

```
artifacts/
├── joventy/
│   ├── convex/           # Fonctions Convex (déployées sur cloud)
│   │   ├── schema.ts     # Schéma complet (tables existantes + Victor)
│   │   ├── http.ts       # Router HTTP (routes hunter + /api/chat Victor)
│   │   ├── victor.ts     # Logique Victor (rate limiting, tracking)
│   │   ├── chat.ts       # HTTP action /api/chat (Bedrock)
│   │   └── ...           # Autres modules (admin, messages, traffic...)
│   └── src/
│       ├── components/VictorWidget.tsx   # Widget chat Victor
│       └── pages/admin/VictorAnalytics.tsx  # Dashboard Victor
├── slot-hunter/          # Bot automation rendez-vous
├── captcha-service/      # Microservice captcha
└── proxy-service/        # Microservice proxies
convex/                   # Source of truth des fonctions Convex (root)
```

## User preferences

- Interface et agents toujours en français
- L'agent Victor ne doit jamais mentionner "bot", "IA" ou "automatisation"
- Pour un humain qui prend le relais : "assistant validateur avec un niveau de validation élevé"
- Les prompts Victor doivent être calibrés selon la page courante
