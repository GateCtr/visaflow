---
name: Joventy project setup
description: Architecture, structure et pièges du projet Joventy importé de GitHub
---

# Structure du projet Joventy

## Répertoires critiques
- `./convex/` (racine) — source of truth des fonctions Convex. Toujours éditer ici, puis copier dans `artifacts/joventy/convex/` avant de déployer.
- `artifacts/joventy/convex/` — copie déployée. Doit rester synchronisée avec `./convex/`.
- `artifacts/joventy/src/` — frontend React/Vite.

## Architecture 4 services
- `artifacts/joventy` (port 5000) — Frontend React + Vite + Convex
- `artifacts/slot-hunter` (pas de port) — Bot automation rendez-vous consulaires
- `artifacts/captcha-service` (port 3001) — Microservice captcha
- `artifacts/proxy-service` (port 3002) — Microservice proxies

## Convex : règles absolues
- Déployer : `cd artifacts/joventy && npx convex deploy --yes`
- Env vars Convex (pas Replit) : `cd artifacts/joventy && npx convex env set KEY=VALUE`
- Les secrets Replit ne sont PAS disponibles dans les Convex HTTP actions — les pousser explicitement via `npx convex env set`
- AWS Bedrock pour Victor : AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION dans Convex env (pas Replit)

## Agent Victor IA
- Widget : `artifacts/joventy/src/components/VictorWidget.tsx`
- Backend HTTP action : `artifacts/joventy/convex/chat.ts` → `/api/chat`
- Modèle : amazon.nova-lite-v2:0 via AWS Bedrock avec Sig V4 fait en Web Crypto (pas SDK)
- Tables : `chatSessions` (rate limiting), `victorConversations` (historique + stats)
- Admin : `/admin/victor` → `VictorAnalytics.tsx`
- Règle : jamais "bot"/"IA"/"automatisation" — "assistant validateur avec niveau de validation élevé"

## Pièges identifiés
- **Svix requis** : http.ts utilise `import { Webhook } from 'svix'` pour le webhook Clerk — installer dans artifacts/joventy
- **Redis** : installé comme dépendance système (nix), démarré dans le workflow slot-hunter (`redis-server --daemonize yes`)
- **proxy-service** : npm install doit utiliser `--ignore-scripts` (husky/undici conflict)
- **Convex deploy sans http.ts** = supprime TOUS les routes HTTP hunter. Toujours inclure le http.ts complet.
- **schemaValidation: false** dans defineSchema si on ne connaît pas tous les champs existants

## État actuel des services
- Joventy frontend : ✅ tourne (port 5000)
- Slot-hunter : ✅ tourne, charge les dossiers CEV, scanne
- Captcha-service : ⚠️ tourne mais sans fournisseur (besoin ANTICAPTCHA/CAPSOLVER/TWOCAPTCHA)
- Proxy-service : ✅ tourne, mode "no proxy" (besoin BRIGHTDATA_PROXY_URL ou IPROYAL_PROXY_URL)

**Why:** Éviter de re-déployer Convex sans le http.ts complet (catastrophique pour le slot-hunter).
**How to apply:** Avant tout `npx convex deploy`, vérifier que `artifacts/joventy/convex/http.ts` contient toutes les routes `/hunter/*`.
