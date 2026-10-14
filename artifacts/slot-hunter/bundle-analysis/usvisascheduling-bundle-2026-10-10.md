# Analyse bundle — usvisascheduling.com (2026-10-10)

**Cible :** https://www.usvisascheduling.com/
**Méthode :** HTTP pur (impit Chrome TLS) + CapSolver `AntiCloudflareTask` (html + userAgent), proxy ISP Decodo (CSV `decodo-proxies.csv`).
**Script :** `bundle-analysis/download-usvisascheduling-bundle.ts` + `extract-usvs-inline.mjs`
**Sortie :** `bundle-analysis/usvisascheduling/2026-10-10/`

---

## 1. Protection

- **Cloudflare Managed Challenge** (`Cf-Mitigated: challenge`, CSP vers `challenges.cloudflare.com`, cookie `__cf_bm`).
- Sitekey Turnstile observée : `0x4AAAAAAAAjq6WYeRDKmebM`.
- **Résolu via CapSolver** `AntiCloudflareTask` en ~14 s, avec `html` du challenge + `userAgent` passés (cf_clearance lié à la TLS impit → réutilisable en HTTP direct).
- `cf_clearance` obtenu (len=597). GET post-clearance → **HTTP 200, HTML 215 KB**.

## 2. Stack identifiée

> ⚠️ La page capturée est la **page de connexion Microsoft Azure AD B2C**, PAS encore le portail de prise de RDV.

Preuves dans `inline-03.js` (203 KB, le bundle principal inline) et `inline-01.js` :
- `SA_FIELDS` avec champs `signInName` (Username) + `Password` → formulaire *self-asserted* B2C.
- `t.hosts.tenant+"/api/"+t.api+"/..."`, `csrf_token`, `X-CSRF-TOKEN`, `t.transId`, headers `x-ms-*` → runtime d'authentification Microsoft (B2C `/SelfAsserted`, `/api/CombinedSigninAndSignup`, etc.).
- Moteur de rendu : **Handlebars** (54 occurrences) + **Ember** (bootstrap). JSONP (13).

Le JS applicatif est **entièrement inline** dans la page (pas de `vendor.js`/`app.js` externe) — tout est dans `index.html` → extrait en `inline-01..04.js`.

## 3. Fichiers capturés

| Fichier | Contenu |
|---------|---------|
| `index.html` (215 KB) | Page de login B2C complète (challenge CF franchi) |
| `challenge.html` (6 KB) | Page de challenge Cloudflare initiale (403) |
| `inline-03.js` (203 KB) | Runtime B2C self-asserted (handlebars, api, csrf) |
| `inline-01.js` (5.5 KB) | `SA_FIELDS` — définition des champs du formulaire login |
| `inline-02/04.js` | Petits bootstraps |
| `cf-session.json` | cf_clearance + UA + cookies (proxy masqué) |
| `manifest.json`, `scripts-index.json`, `extracted-urls.txt` | Métadonnées de capture |

## 4. Comparaison avec le portail USA existant (usvisaappt.com)

| Aspect | usvisaappt.com (bundle existant) | usvisascheduling.com (nouveau) |
|--------|----------------------------------|--------------------------------|
| Protection | — | Cloudflare Managed Challenge |
| Auth | login applicatif AIS | **Microsoft Azure AD B2C** |
| Front | Angular (SPA) | Ember + Handlebars (login B2C) |
| Bundle | fichiers JS externes | **inline dans le HTML** |

→ C'est un portail **distinct**. L'analyse doit repartir de zéro après authentification.

## 5. Prochaines étapes (à valider avec le propriétaire)

1. **Obtenir des identifiants de test** pour ce portail (B2C) — le bundle du système de RDV n'est accessible **qu'après login**.
2. Étendre `download-usvisascheduling-bundle.ts` pour : POST du formulaire B2C self-asserted (signInName/password + csrf_token + transId) → suivre la redirection vers le portail de scheduling → capturer SON bundle.
3. Documenter le flux B2C (`/SelfAsserted`, `/api/CombinedSigninAndSignup/confirmed`, policy name, tenant host) depuis `inline-03.js`.
4. Reverse des endpoints de RDV réels (une fois le portail post-login capturé).

**Statut : capture pré-login OK. Bundle RDV = bloqué sur authentification (attente credentials).**
