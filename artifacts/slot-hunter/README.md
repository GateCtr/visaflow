# Joventy Hunter — Robot Playwright Anti-Ban

Service Node.js autonome qui scanne les portails de rendez-vous consulaires
et capture les créneaux disponibles pour les clients Joventy.

## Architecture

```
src/
  index.ts          → Boucle principale (file prioritaire, jitter intervals)
  convexClient.ts   → Client HTTP vers les endpoints Convex (getJobs, slotFound, heartbeat)
  browser.ts        → Playwright + stealth, helpers humanType/humanClick/humanScroll
  captcha.ts        → Intégration 2captcha (détection reCAPTCHA, soumission, injection)
  navigator.ts      → Logique de session : login, scan créneaux, logout, timeout 5min
```

## Variables d'environnement

Copiez `.env.example` vers `.env` et remplissez :

| Variable | Requis | Description |
|---|---|---|
| `CONVEX_SITE_URL` | ✅ | URL de base Convex HTTP (ex: `https://xxx.convex.site`) |
| `HUNTER_API_KEY` | ✅ | Clé API définie dans Convex (`npx convex env set HUNTER_API_KEY ...`) |
| `PROXY_URL` | ❌ | Proxy résidentiel (Bright Data / Smartproxy) |
| `DRY_RUN` | ❌ | `true` pour simuler sans réserver |

## Lancement local

```bash
cp .env.example .env
# Éditez .env avec vos vraies valeurs
pnpm install
pnpm dev
```

## Déploiement Railway

1. Créer un nouveau service Railway depuis ce repo (dossier `artifacts/slot-hunter/`)
2. Ajouter les variables d'environnement dans Railway Dashboard
3. Commande de démarrage : `pnpm start`
4. Railway redémarre automatiquement le service en cas de crash

## Comportement anti-ban

- **Stealth plugin** : masque `navigator.webdriver`, falsifie `navigator.plugins`
- **User-Agent rotation** : 12 profils Chrome/Edge/Safari/Firefox (Windows/Mac/Linux/Mobile)
- **Frappe humaine** : 80–250ms par caractère, pauses aléatoires
- **Mouvement souris** : trajectoire naturelle avant chaque clic
- **Jitter intervals** : 8–22 min selon urgence (non-répétitifs)
- **Sessions courtes** : max 5 min, fermeture forcée si dépassé
- **2captcha** : résolution automatique des reCAPTCHA si clé configurée
- **Seuil d'échecs** : 3 échecs consécutifs → pause automatique du dossier

## File d'attente prioritaire

```
tres_urgent  → vérification toutes les  8–10 min
urgent       → vérification toutes les 11–14 min
prioritaire  → vérification toutes les 15–18 min
standard     → vérification toutes les 19–22 min
```
