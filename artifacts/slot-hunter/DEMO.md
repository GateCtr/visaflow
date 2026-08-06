# 🟢 Joventy Slot Hunter — Guide démo locale

Cloner le projet et lancer le scanner Espagne (Saopola/citaconsular.es) avec un
**navigateur Chrome visible**, pour voir le bot fonctionner en temps réel.

---

## Prérequis

| Outil | Version minimum | Vérification |
|---|---|---|
| Node.js | 20+ | `node -v` |
| pnpm | 9+ | `pnpm -v` (ou `npm i -g pnpm`) |
| Git | any | `git --version` |

Tu as aussi besoin de **deux clés API** (les mêmes que le serveur de prod) :

| Variable | Où l'obtenir | Rôle |
|---|---|---|
| `DECODO_PROXY_URL` | Panel Decodo → Proxies ISP → "Connection String" | Proxy résidentiel pour contourner le blocage IP de citaconsular.es |
| `CAPSOLVER_API_KEY` | [capsolver.com](https://capsolver.com) → Dashboard | Résout le Turnstile Cloudflare automatiquement |

---

## Installation

```bash
# 1. Cloner le dépôt
git clone <url-du-repo>
cd <repo>/artifacts/slot-hunter

# 2. Installer les dépendances
pnpm install

# 3. Télécharger Chrome (Puppeteer le fait automatiquement)
node_modules/.bin/puppeteer browsers install chrome
```

---

## Configuration

Crée un fichier `.env` dans `artifacts/slot-hunter/` :

```env
# Obligatoire
DECODO_PROXY_URL=http://user:pass@dc.decodo.com:10000
CAPSOLVER_API_KEY=CAP-xxxxxxxxxxxxxxxxxxxx

# Optionnel — Redis pour persister la session CF entre deux runs
# REDIS_URL=redis://localhost:6379
```

> **Astuce** : sans Redis, la session Cloudflare est résolue à chaque run
> (ça prend ~15-30s). Avec Redis, les runs suivants sont instantanés.

---

## Lancer le test

### Mode standard (headless — terminal uniquement)

```bash
npx tsx src/scripts/test-saopola-live.ts
```

### Mode démo — navigateur visible 👁️

```bash
npx tsx src/scripts/test-saopola-live.ts --headed
```

Chrome s'ouvre et tu vois le bot naviguer sur le portail citaconsular.es
en temps réel : résolution Cloudflare, appels API Bookitit, détection des créneaux.

### Options du mode headed

| Flag | Effet |
|---|---|
| `--headed` | Ouvre Chrome en mode visible |
| `--slow-mo=150` | Ralentit les interactions à 150ms (défaut : 60ms) |
| `--devtools` | Ouvre les DevTools Chrome automatiquement |

Exemple avec tout :
```bash
npx tsx src/scripts/test-saopola-live.ts --headed --slow-mo=120 --devtools
```

---

## Ce que tu vas voir

Le test exécute 5 étapes sur le vrai portail :

```
Étape 0  — Connexion Redis (optionnel)
Étape 0b — Reset session (solve frais)
Étape 1  — Résolution session Cloudflare via CapSolver + Decodo
             → Chrome navigue sur citaconsular.es, résout le captcha invisible
Étape 2  — Probe HTTP complet (runSpainHttpProbe)
             → Résultat : found / not_found / error
Étape 3  — Appels API Bookitit individuels :
    3a. getwidgetconfigurations/  → captcha requis ? registration_type ?
    3b. getservices/              → liste des services (visa, passeport…)
    3c. getagendas/               → agendas disponibles
    3d. datetime/                 → créneaux sur 3 mois
```

Si des créneaux sont disponibles, tu les vois listés avec dates, heures et
nombre de places libres.

---

## Résultats attendus

| Résultat | Signification |
|---|---|
| `not_found` | Portail opérationnel, aucun créneau libre en ce moment |
| `found` | 🎉 Créneau détecté — le bot aurait booké |
| `cf_blocked` | Session CF expirée ou IP bannie — relancer |
| `error` | Vérifier `DECODO_PROXY_URL` et `CAPSOLVER_API_KEY` |

---

## Dépannage

**"Cannot find Chrome"**
```bash
node_modules/.bin/puppeteer browsers install chrome
```

**"DECODO_PROXY_URL absent"**
→ Crée le fichier `.env` dans `artifacts/slot-hunter/` (voir section Configuration)

**"ERR_PROXY_CONNECTION_FAILED"**
→ Vérifier que l'URL Decodo est correcte et que le compte a du crédit

**Le navigateur se ferme immédiatement**
→ Ajouter `--devtools` pour lire l'erreur dans la console Chrome

---

## Architecture rapide

```
artifacts/slot-hunter/src/
  spain-persistent-browser.ts   ← Puppeteer (navigation + résolution CF)
  spain-soax-solver.ts          ← CapSolver + gestion session Cloudflare
  spain-http-scanner.ts         ← Scan HTTP des créneaux Bookitit
  spain-http-booking.ts         ← Booking HTTP (signin → selectslot)
  scripts/
    test-saopola-live.ts        ← Ce script de démo
```
