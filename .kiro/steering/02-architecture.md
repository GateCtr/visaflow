# Architecture du monorepo VisaFlow

## Vue d'ensemble

Système de chasse aux créneaux de rendez-vous visa qui automatise la détection et la réservation de slots sur les portails officiels (USA, Espagne, Canada, Suisse, etc.).

## Structure du monorepo (pnpm workspaces)

```
visaflow/
├── artifacts/           # Applications déployables
│   ├── slot-hunter/     # Hunter principal (coeur du système)
│   ├── captcha-service/ # Service de résolution captcha
│   ├── proxy-service/   # Gestion des proxies
│   ├── joventy/         # Frontend de gestion
│   └── mockup-sandbox/  # Environnement de test
├── lib/                 # Bibliothèques partagées
│   ├── api-spec/        # Spécifications API (OpenAPI/Zod)
│   ├── api-zod/         # Schémas de validation Zod
│   ├── api-client-react/# Client API pour le frontend
│   └── db/              # Schéma et accès base de données
├── scripts/             # Scripts utilitaires
├── convex/              # Backend Convex (temps réel)
└── cloudflare-worker/   # Worker Cloudflare
```

## Portails supportés (dans `artifacts/slot-hunter/src/`)

| Portail | Fichier | Description |
|---------|---------|-------------|
| USA (AIS) | `usaPortal.ts` | Portail USVisaScheduling |
| Espagne | `spainPortal.ts`, `src/spain/` | CitaConsular.es |
| Canada (CEV) | `cevPortal.ts`, `cevBooking.ts` | Système CEV |
| Suisse | `src/vowint-reverse/` | Portail VFS Suisse |

## Communication avec les APIs

- Chaque portail a son propre **fetch wrapper** (`usaFetch`, `spainFetch`)
- Headers standardisés mimant un navigateur réel
- Gestion automatique des retries avec backoff exponentiel
- Validation systématique des réponses JSON avant traitement
- Cookies et sessions isolés par utilisateur

## Gestion des sessions

- Sessions isolées par utilisateur (pas de partage de tokens)
- Tokens stockés via variables d'environnement (jamais en dur)
- Refresh automatique avant expiration
- Cookies persistés dans `cookies/` pour le debug uniquement

## Stack technique

| Couche | Technologie |
|--------|------------|
| Runtime | Node.js + tsx (exécution directe TS) |
| Navigateur | Playwright + stealth plugin |
| HTTP | undici / node-fetch |
| Captcha | Capsolver, Anticaptcha |
| Proxy | BrightData, IPRoyal (rotation + ISP) |
| Backend temps réel | Convex |
| Auth | Clerk |
| Deploy | Railway, Vercel, Cloudflare Workers |

## Références

- #[[file:pnpm-workspace.yaml]]
- #[[file:artifacts/slot-hunter/package.json]]
- #[[file:artifacts/slot-hunter/src/index.ts]]
