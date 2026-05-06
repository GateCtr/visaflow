# Joventy OTP Email Router — Cloudflare Worker

Cloudflare Email Worker qui intercepte les emails OTP du portail citaconsular.es
et les transmet à l'endpoint Convex de Joventy.

## Flux

```
Gmail client → filtre → otp+{appId}@otp.joventy.cd
                              ↓
                  Cloudflare Email Routing
                              ↓
              Worker joventy-otp-router (ce fichier)
                              ↓
         POST {CONVEX_SITE_URL}/hunter/otp/ingest
                              ↓
                     Bot lit le code ✅
```

## Déploiement

### Prérequis
- Node.js ≥ 18
- `npm install -g wrangler` (CLI Cloudflare)
- Compte Cloudflare avec `joventy.cd` configuré comme zone

### 1. Déployer le Worker

```bash
cd cloudflare-worker/otp-email-router
wrangler login
wrangler deploy
```

### 2. Configurer les secrets

```bash
wrangler secret put CONVEX_SITE_URL
# → Saisir : https://famous-albatross-420.convex.site

wrangler secret put OTP_INGEST_SECRET
# → Saisir : (même valeur que OTP_INGEST_SECRET dans Convex)
```

### 3. Configurer Cloudflare Email Routing

Dans le dashboard Cloudflare → `joventy.cd` → **Email** → **Email Routing** :

1. Activer Email Routing (ajouter les MX records suggérés)
2. Onglet **Routing rules** → **Custom addresses** → Add :
   - **From** : `otp+*@otp.joventy.cd` (ou catch-all `*@otp.joventy.cd`)
   - **Action** : Send to a Worker → `joventy-otp-router`
3. Sauvegarder

### 4. DNS à ajouter dans Cloudflare pour otp.joventy.cd

Cloudflare Email Routing ajoute automatiquement les MX records nécessaires
quand vous activez Email Routing. Vérifiez qu'ils existent pour `otp.joventy.cd` :

```
MX  otp.joventy.cd  route1.mx.cloudflare.net   priority 13
MX  otp.joventy.cd  route2.mx.cloudflare.net   priority 28
MX  otp.joventy.cd  route3.mx.cloudflare.net   priority 55
TXT otp.joventy.cd  "v=spf1 include:_spf.mx.cloudflare.net ~all"
```

## Migration DNS — joventy.cd vers Cloudflare

### Records à recréer dans Cloudflare après migration des nameservers

| Type | Nom | Valeur | Notes |
|------|-----|--------|-------|
| A / CNAME | `@` | Vercel IP ou `cname.vercel-dns.com` | Site web |
| CNAME | `www` | `cname.vercel-dns.com` | Redirection www |
| MX | `@` | Serveurs Zoho | Emails business |
| TXT | `@` | SPF Zoho | Anti-spam |
| TXT | `@` | DKIM Zoho | Anti-spam |
| TXT | `@` | Vérification Clerk / Resend | Selon config |
| MX | `otp` | Cloudflare Email Routing | OTP bot (auto) |

**Étapes :**
1. Ajouter `joventy.cd` dans Cloudflare → il importe automatiquement les DNS existants
2. Vérifier que tous les records sont bien importés
3. Changer les nameservers chez votre registrar → nameservers Cloudflare
4. Attendre propagation (5 min à 48h)
5. Activer Email Routing dans Cloudflare → configurer la règle otp.*
6. Déployer ce Worker

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `CONVEX_SITE_URL` | URL du site Convex (ex: `https://xxx.convex.site`) |
| `OTP_INGEST_SECRET` | Secret partagé avec l'endpoint `/hunter/otp/ingest` |
