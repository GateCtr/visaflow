# Spain/Saopolo — Flow HTTP Pur (100% sans browser)

## Date de validation : 2026-08-11

## Vue d'ensemble

Le portail citaconsular.es (Bookitit) peut être entièrement piloté en HTTP pur via Impit + Capsolver.
Pas de browser, pas de Puppeteer, pas de Playwright nécessaire pour la détection de créneaux.

## Stack validée

| Composant | Rôle | Détail |
|-----------|------|--------|
| **Capsolver** | Résout le challenge CF interactif (Turnstile) | `AntiCloudflareTask`, ~15s, $0.003/solve |
| **Impit** | Client HTTP avec TLS fingerprint Chrome | `browser: "chrome"` |
| **Proxy ISP Decodo port 10003** | IP rotative fraîche | ⚠️ Port 10001 GRILLÉ sur citaconsular.es |

## Leçons apprises (erreurs à NE PAS répéter)

### 1. Le proxy était le problème principal
- **Port 10001** (IP fixe 50.118.216.122 ou pool 10001) → **GRILLÉ** sur citaconsular.es
- **Port 10003** (IP rotative) → fonctionne parfaitement
- Symptôme : HTTP 200 avec body 0B sur `/onlinebookings/*`
- Piège : on a accusé le TLS, le JSD oneshot, la session PHP, fetch vs JSONP — c'était le proxy

### 2. Le callback jQuery doit être identique pour toute la session
- Bookitit valide que le même `callback=jQuery21109...` est utilisé pour TOUTES les requêtes
- Si on génère un callback différent par requête → `getservices/` retourne 0B
- Format : `jQuery21109{timestamp}_{random9digits}`
- Le compteur `_=` s'incrémente à chaque requête (comme jQuery le fait)

### 3. Le paramètre `srvsrc` est requis
- `srvsrc=https://www.citaconsular.es` doit être inclus dans `getwidgetconfigurations/`, `getservices/`, `getagendas/`, `datetime/`
- Il n'est PAS inclus dans `/main/` (le loader le supprime pour /main/ uniquement)

### 4. `datetime/` utilise `start` et `end`, pas `month` et `year`
- Format : `start=2026-09-01&end=2026-09-30`
- Le widget appelle datetime/ deux fois : mois courant + mois suivant (si maxDays ≤ aujourd'hui)

### 5. `fetch()` vs JSONP vs XHR
- `page.evaluate(fetch(...))` dans un browser → retourne 0B sur `/onlinebookings/`
- Les appels directs Impit (HTTP pur, sans browser) → fonctionnent normalement
- Le vrai widget utilise jQuery JSONP (`dataType: "jsonp"`) mais Impit envoie un GET normal avec le bon callback et ça passe aussi

### 6. CF "Extension de navigateur incompatible"
- Causé par la fuite `Runtime.Enable` de Puppeteer/Playwright
- Fix : `rebrowser-puppeteer-core` (patch la fuite)
- Ou : ne pas utiliser de browser du tout (approche HTTP pure)

### 8. `AllowAppointment` dans getservices/
- Si `getservices/` retourne `"AllowAppointment":false` → portail probablement fermé
- MAIS on ne skip PAS `getagendas/` — on le tente TOUJOURS (prudence : le flag pourrait rester même avec des créneaux)
- Si `getagendas/` retourne 0B → log "refusé", retry prochain cycle
- Si `getagendas/` retourne `{"Agendas":[]}` → pas de créneaux confirmé
- Si `getagendas/` retourne des agendas → continuer datetime/
- `AllowAppointment` absent = portail ouvert (confirmé sur São Paulo + Cuba)

### 9. Un seul `getagendas/` par session PHP
- Bookitit n'autorise qu'UN appel `getagendas/` par PHPSESSID
- Le premier appel passe, les suivants retournent 0B
- Solution : appeler `getagendas/` UNE SEULE FOIS pour le service cible
- Ne PAS boucler sur tous les services avec la même session

### 10. Validation en production (circuit de sécurité)
- `getagendas/` → 0B → "refusé/fermé", retry au prochain cycle de polling normal
- `getagendas/` → `{"Agendas":[]}` → pas de créneaux, retry au prochain cycle
- `getagendas/` → agendas + `datetime/` → `Slots` avec `freeSlots > 0` → **ALERTER + RÉSERVER**
- 0B inattendu après un `AllowAppointment` absent → investiguer (nouveau pattern ?)

## Flow HTTP complet (validé)

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 1 : Résolution Cloudflare (~15s, une fois toutes les 2h) │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Impit GET portail → page 403 "Just a moment..." (6209B)     │
│  2. Capsolver AntiCloudflareTask (html + proxy ISP port 10003)   │
│     → cf_clearance cookie (~15s)                                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PHASE 2 : Initialisation session (~5s)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  3. Impit GET widget (avec cf_clearance) → HTML + token + PHPSESSID │
│  4. Impit POST token → session Bookitit initialisée (2502B)      │
│  5. Impit GET /main/ → HTML widget complet (128 632B)            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  PHASE 3 : Détection créneaux (~3s par check)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  6. GET /getwidgetconfigurations/ → config widget (364B)         │
│  7. GET /getservices/ → liste services (846B, 2 services)        │
│  8. GET /getagendas/?services[]=bkt853215 → agendas (169B)       │
│  9. GET /datetime/?services[]=bkt853215&agendas[]=bkt301070      │
│     &start=YYYY-MM-01&end=YYYY-MM-30 → créneaux (10 648B)       │
│                                                                  │
│  Si Slots[].times contient des entrées avec freeSlots > 0        │
│  → CRÉNEAUX DISPONIBLES → ALERTER !                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Paramètres des requêtes

### Headers communs (toutes les requêtes Bookitit)
```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36
Accept: text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01
X-Requested-With: XMLHttpRequest
Sec-Fetch-Site: same-origin
Sec-Fetch-Mode: cors
Sec-Fetch-Dest: empty
Sec-Ch-Ua: "Not;A=Brand";v="8", "Chromium";v="151"
Sec-Ch-Ua-Platform: "Windows"
Sec-Ch-Ua-Mobile: ?0
Referer: https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/
Cookie: PHPSESSID={session}; cf_clearance={token}
```

### Query params communs
```
callback=jQuery21109{timestamp}_{random9digits}  ← MÊME pour toute la session
type=default
publickey=2d01502f12dc08400e22aea87fb00ae34
lang=es
version=4
src=https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/
srvsrc=https://www.citaconsular.es  ← PAS dans /main/, PRÉSENT partout ailleurs
_={counter++}  ← incrémental
```

### Params spécifiques par endpoint

| Endpoint | Params supplémentaires |
|----------|----------------------|
| `/main/` | PAS de `srvsrc` |
| `/getwidgetconfigurations/` | (aucun) |
| `/getservices/` | (aucun) |
| `/getagendas/` | `services[]=bkt853215`, `selectedPeople=1` |
| `/datetime/` | `services[]=bkt853215`, `agendas[]=bkt301070`, `start=YYYY-MM-DD`, `end=YYYY-MM-DD`, `selectedPeople=1` |

## IDs spécifiques São Paulo

| Élément | ID |
|---------|-----|
| Widget publickey | `2d01502f12dc08400e22aea87fb00ae34` |
| Service Pasaportes | `bkt853215` |
| Agenda Pasaportes | `bkt301070` |

## Structure réponse datetime/

```json
{
  "Slots": [
    {
      "agenda": "bkt301070",
      "date": "2026-09-16",
      "times": {
        "550": { "time": "09:10", "freeSlots": 2 },
        "590": { "time": "09:50", "freeSlots": 2 },
        ...
      },
      "state": 1
    },
    {
      "agenda": "bkt301070",
      "date": "2026-09-17",
      "times": {},  // vide = pas de créneau ce jour
      "state": 1
    }
  ],
  "maxDays": "2026-09-30"
}
```

- `times` = objet vide → pas de créneau ce jour
- `times` = objet avec des clés → créneaux disponibles
- `freeSlots` > 0 → places libres
- `state: 1` = jour ouvert, `state: 0` = jour fermé

## Proxy

| Port | Type | Status citaconsular.es |
|------|------|----------------------|
| 10001 | Pool grillé | ❌ BLOQUÉ (0B sur /onlinebookings/) |
| 10002 | ISP stable | ✅ FONCTIONNE (recommandé) |
| 10003 | IP rotative instable | ⚠️ Aléatoire (parfois OK, parfois 0B) |

⚠️ Le port 10003 donne une IP par session TCP. Impit ouvre potentiellement une nouvelle connexion par requête mais ça fonctionne car le cf_clearance couvre toutes les IPs du pool ISP Decodo pour ce domaine.

## Flow de réservation complet

```
┌─────────────────────────────────────────────────────────────────┐
│  PHASE 4 : Réservation (~3s)                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  10. GET /getsigninfields/?services[]=bkt853215                  │
│      → champs requis pour le login (13 815B)                     │
│                                                                  │
│  11. GET /signin/?...&date=YYYY-MM-DD&time=HH:MM                 │
│      &logintype=document&login={matricula}&password={pass}        │
│      → Si succès : { "Client": { "bktToken": "xyz123" } }       │
│      → Si échec : { "Client": { "errors": [...] } }             │
│      ⚠️ Le créneau est BLOQUÉ dès que bktToken est retourné     │
│                                                                  │
│  12. GET /summary/?...&bktToken={token}&services[]=...           │
│      &agendas[]=...&date=...&time=...&login=...&password=...     │
│      → { "Event": { date, time, localizador, ... } }            │
│      → Confirmation finale avec détails du RDV                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### signin/ — paramètres

| Param | Valeur |
|-------|--------|
| `services[]` | `bkt853215` |
| `agendas[]` | `bkt301070` |
| `date` | `2026-09-16` (YYYY-MM-DD) |
| `time` | `09:10` (HH:MM) |
| `selectedPeople` | `1` |
| `logintype` | `document` |
| `login` | Nº de Matrícula (campo 11 du passeport) |
| `password` | Initiales + date de naissance |
| `comments` | (vide ou message) |

### summary/ — paramètres

| Param | Valeur |
|-------|--------|
| `services[]` | `bkt853215` |
| `agendas[]` | `bkt301070` |
| `date` | date du créneau |
| `time` | heure du créneau |
| `bktToken` | token reçu de signin/ |
| `login` | même que signin/ |
| `password` | même que signin/ |
| + autres champs client | name, document, address... |

### Réponse signin/ (succès)
```json
{ "Client": { "bktToken": "abc123...", "Prices": { ... } } }
```

### Réponse signin/ (échec)
```json
{ "Client": { "errors": [{ "message": "Usuario o contraseña incorrectos", "field": "login", "type": "data" }] } }
```

### Réponse summary/ (succès)
```json
{ "Event": { "date": "...", "time": "...", "localizador": "...", "service": "...", "agenda": "..." } }
```

| Composant | Fréquence | Coût |
|-----------|-----------|------|
| Capsolver | 1x / 2h | ~$0.003 |
| Proxy ISP Decodo | ~8 requêtes / scan | bande passante (inclus dans l'abonnement) |
| **Total par scan** | | **~$0.003** |
| **Total par jour (scan toutes les 30s)** | 2880 scans, 1 solve CF/2h = 12 solves | **~$0.04/jour** |

## Script de test

```bash
cd artifacts/slot-hunter
npx tsx src/scripts/test-saopolo-capsolver-impit.ts
```

## Fichiers de référence

- `src/scripts/test-saopolo-capsolver-impit.ts` — Script de test validé
- `dump/capture/2026-07-28T11-01-12-js/js-02-loadermaec.js.js` — Loader widget Bookitit
- `dump/capture/2026-07-28T11-01-12-js/js-85-router.js.js` — Router Backbone Bookitit
- `dump/capture/2026-07-28T11-01-12-js/js-50-services.js.js` — Collection Services (URL getservices/)
- `dump/capture/2026-07-28T11-01-12-js/js-38-serviceslist.js.js` — Vue ServicesList (fetch pattern)
- `saopolo-main-response.html` — Capture du /main/ (128KB)


---

## Mise à jour 2026-08-11 — Proxy résidentiel + Navigation multi-mois

### Problème : ISP dédié grillé

Les proxies ISP Decodo (`isp.decodo.com`) sont **tous grillés** sur citaconsular.es pour São Paulo :

| Port ISP | Status | Symptôme |
|----------|--------|----------|
| 10001 | ❌ GRILLÉ | /main/ → 0B |
| 10002 | ❌ GRILLÉ | /main/ → 0B |
| 10003 | ❌ GRILLÉ | /main/ → 0B |
| 10004 | ❌ GRILLÉ | /main/ → 0B |
| 10005 | ❌ GRILLÉ | /main/ → 0B |

**Cause** : tout le range ISP Decodo est sur le même subnet, CF a banni le range entier.

### Solution : Proxy résidentiel rotatif Decodo (`gate.decodo.com`)

Pool 115M+ IPs résidentielles, chaque connexion = IP de foyer réel. Impossible pour CF de bannir un range.

| Port résidentiel | Status | /main/ |
|------------------|--------|--------|
| 10001 | ✅ OK | 128 629B |
| 10002 | ✅ OK | 128 629B |
| 10003 | ✅ OK | 128 630B |

**Config proxy résidentiel :**
```
http://sp4e4cx19x:{password}@gate.decodo.com:10001
```
(10 ports disponibles : 10001-10010)

**Coût** : ~$2/GB résidentiel (data non illimitée, contrairement à l'ISP).
Consommation : ~1.2 MB/scan → 3 GB = ~2500 scans = ~3.5 jours de scan continu.

### Navigation multi-mois (maxDays)

**Problème initial** : le script ne scannait que le mois courant. `maxDays=2026-08-11` (= aujourd'hui) était interprété comme "arrêter de scanner" → les créneaux de septembre étaient invisibles.

**Le vrai comportement Bookitit** : `maxDays` est retourné **par réponse datetime/**. Pour le mois courant il indique "pas de créneaux au-delà d'aujourd'hui". Pour septembre, il retourne `maxDays=2026-09-30` = "créneaux disponibles jusqu'à fin septembre".

**Règle correcte** :
1. Toujours scanner au minimum M + M+1 (2 mois)
2. `maxDays` du mois courant ≠ limite globale du serveur
3. S'arrêter quand le 1er jour du mois suivant > `maxDays` de la DERNIÈRE réponse positive
4. Si 3 mois vides consécutifs sans maxDays → arrêt sécurité

**Résultat validé São Paulo (2026-08-11) :**
- Août : 0 créneaux (maxDays=2026-08-11 = aujourd'hui)
- Septembre : **331 créneaux** (maxDays=2026-09-30)

### Tableau des créneaux São Paulo — Septembre 2026

| Date | Places libres | Créneaux horaires | Heures |
|------|:---:|:---:|------|
| 16 sept | 3 | 3 | 12:10, 12:50, 13:00 |
| 17 sept | 28 | 20 | 08:40 → 13:10 |
| 21 sept | 28 | 20 | 08:50 → 13:00 |
| 22 sept | 39 | 27 | 08:30 → 13:20 |
| 23 sept | 37 | 25 | 08:20 → 13:20 |
| 24 sept | 44 | 30 | 08:20 → 13:20 |
| 25 sept | 11 | 5 | 09:00 → 10:40 |
| 28 sept | 44 | 28 | 08:20 → 13:20 |
| 29 sept | 48 | 31 | 08:20 → 13:20 |
| 30 sept | 49 | 32 | 08:20 → 13:30 |

**Total : 331 places sur 221 créneaux horaires, répartis sur 10 jours.**

### Test multi-portail validé (même session)

| Portail | Proxy | /main/ | getagendas/ | datetime/ | Créneaux |
|---------|-------|--------|-------------|-----------|----------|
| São Paulo (2d01502f) | gate:10003 ✅ | 128KB | 169B | 2 mois | 331 |
| Cameroun (2c735928) | isp:10002 ✅ | 128KB | 212B | 1 mois | 0 (maxDays=aujourd'hui) |
| Kinshasa (25028fcd) | isp:10002 | — | 0B | — | Portail fermé |

### Script de test

```bash
# Usage avec proxy en argument
npx tsx src/scripts/test-bookitit-dynamic.ts <URL_WIDGET> [URL_PROXY]

# Exemple São Paulo avec proxy résidentiel
npx tsx src/scripts/test-bookitit-dynamic.ts \
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/" \
  "http://sp4e4cx19x:{password}@gate.decodo.com:10001"

# Exemple Cameroun (ISP suffit, portail pas sensible)
npx tsx src/scripts/test-bookitit-dynamic.ts \
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2c7359283dfa615bb8bf086b630561d9d/"
```

### TODO production

- [ ] Migrer `spain-persistent-browser.ts` vers proxy résidentiel `gate.decodo.com` pour São Paulo
- [ ] Implémenter la navigation multi-mois dans `_prefetchBookititApis` (même logique que le script de test)
- [ ] Implémenter la navigation multi-mois dans `spainPortal.ts` (HTTP-pure path, remplacer le hardcode 9 mois)
- [ ] CSV `decodo-proxies-spain-residential.csv` pour rotation par portail
- [ ] Logique fallback : si ISP donne 0B → switch automatique résidentiel


---

## Résultat test Cuba (La Habana) — 2026-08-11

| Portail | PublicKey | maxDays | Mois scannés | Créneaux |
|---------|-----------|---------|:---:|:---:|
| Cuba (LMD) | `28330379fc95acafd31ee9e8938c278ff` | 2026-10-07 | 3 (août→oct) | **4193** |

### Résumé par date Cuba

| Date | Places | Créneaux horaires | Horaires |
|------|:---:|:---:|------|
| 14 sept | 51 | 8 | 12:50 → 14:00 |
| 15 sept | 161 | 15 | 11:40 → 14:00 |
| 16 sept | 143 | 16 | 11:30 → 14:00 |
| 17 sept | 186 | 21 | 10:40 → 14:00 |
| 18 sept | 96 | 12 | 10:10 → 12:00 |
| 21 sept | 260 | 28 | 09:30 → 14:00 |
| 22 sept | 310 | 29 | 09:20 → 14:00 |
| 23 sept | 238 | 27 | 09:30 → 14:00 |
| 24 sept | 240 | 29 | 09:20 → 14:00 |
| 25 sept | 161 | 18 | 09:10 → 12:00 |
| 28 sept | 286 | 31 | 09:00 → 14:00 |
| 29 sept | 335 | 31 | 09:00 → 14:00 |
| 30 sept | 278 | 30 | 09:00 → 14:00 |
| 1 oct | 295 | 31 | 09:00 → 14:00 |
| 2 oct | 175 | 19 | 09:00 → 12:00 |
| 5 oct | 304 | 31 | 09:00 → 14:00 |
| 6 oct | 364 | 31 | 09:00 → 14:00 |
| 7 oct | 310 | 31 | 09:00 → 14:00 |

---

## Plan de migration : Persistent-Browser → HTTP Pur (Impit + Capsolver)

### Architecture actuelle (ce qu'on remplace)

```
┌─────────────────────────────────────────────────────────────────┐
│  spain-watcher-loop.ts (boucle principale — toutes les 10s)      │
│                                                                  │
│  Mode persistent-browser :                                       │
│    ensureSpainPersistentBrowserSession(portalUrl)                 │
│      → lance Chromium + Decodo ISP + JSD natif                   │
│      → capture /main/ prefetchedMainHtml (128KB)                 │
│      → prefetch getwidgetconfigurations + getservices             │
│                                                                  │
│  Probe :                                                         │
│    runSpainHttpProbe(portalUrl)                                   │
│      → scanSpainHttp(portalUrl) → scanViaMainEndpoint()          │
│      → utilise prefetchedMainHtml OU spainCfFetch /main/         │
│      → confirmSlotsViaDatetime() [JSONP chain: svc→ag→dt]        │
│                                                                  │
│  Si slot trouvé :                                                │
│    executeHttpBooking(session, portalUrl, mainHtml, config)       │
│      → callBookititEndpointViaBrowser (DOM mode)                 │
│      → OU callBookititEndpoint (HTTP isolé via spainCfFetch)     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Ce qu'on garde INTACT (ne PAS toucher)

| Fichier | Raison |
|---------|--------|
| `spain-watcher-loop.ts` | Orchestrateur — déjà compatible HTTP-pure via `runSpainHttpProbe()` |
| `spain-http-booking.ts` | Booking HTTP-pure fonctionne déjà quand `source !== "playwright"` |
| `spain-http-scanner.ts` → `scanSpainHttp()` | Le flow JSONP (getservices→getagendas→datetime) est déjà correct |
| `convexClient.ts` | Reporting Convex inchangé |
| `spain-service-mapping.ts` | Matching visa→service inchangé |
| `spain-slot-explorer.ts` | Exploration détaillée inchangée |

### Ce qu'on modifie

#### 1. Session CF : migrer vers Capsolver + proxy résidentiel

**Fichier :** `src/spain-soax-solver.ts` → `ensureSpainCfSession()`

**Modification :** Ajouter un mode `"capsolver-residential"` qui :
- Utilise `gate.decodo.com` (résidentiel rotatif) au lieu de `isp.decodo.com` (ISP dédié grillé)
- Résout CF via `AntiCloudflareTask` de Capsolver (~15s, $0.003/solve)
- Retourne un `SpainCfSession` avec `source: "capsolver"` (pas "playwright")
- Le `cf_clearance` + `PHPSESSID` sont obtenus via Impit (comme dans le script de test)

**Où exactement :**
- Fonction `getSpainProxyUrl()` (ligne ~97) : ajouter `gate.decodo.com` comme source prioritaire
- Bloc `ensureSpainCfSession()` (ligne ~651) : nouveau chemin quand `SPAIN_SESSION_MODE=capsolver-residential`
- Ou plus simplement : changer `DECODO_PROXY_URL` dans `.env` de `isp.decodo.com` vers `gate.decodo.com`

**Impact :** Aucun changement d'interface. Le `SpainCfSession` retourné est identique.

#### 2. Navigation multi-mois dans le scan datetime/

**Fichier :** `src/spain-http-scanner.ts` → `confirmSlotsViaDatetime()` (appelée par `scanViaMainEndpoint`)

**Modification :** Remplacer le scan `[0, 1, 2]` mois par la logique dynamique du script de test :
- Toujours scanner minimum 2 mois (M + M+1)
- Parser `maxDays` de chaque réponse
- S'arrêter quand le 1er jour du mois suivant > maxDays global
- Sécurité : max 12 mois, 3 mois vides consécutifs → stop

**Fichier secondaire :** `src/spainPortal.ts` → `tryApiFirstWithCachedSession()` (ligne ~870)
- Même modification : remplacer le `for (let i = 0; i < 9; i++)` par la logique dynamique

**Impact :** Les créneaux en M+1/M+2 seront détectés au lieu d'être ignorés.

#### 3. Proxy résidentiel dans la config

**Fichier :** `.env` (production Railway)

**Modification :**
```bash
# AVANT (ISP dédié — grillé)
DECODO_PROXY_URL=http://splrk8evhp:79lYel_2zl4RVoQnvn@isp.decodo.com:10002

# APRÈS (résidentiel rotatif)
DECODO_PROXY_URL=http://sp4e4cx19x:{password}@gate.decodo.com:10001
```

OU garder les deux et ajouter une logique fallback :
```bash
SPAIN_RESIDENTIAL_PROXY_URL=http://sp4e4cx19x:{password}@gate.decodo.com:10001
DECODO_PROXY_URL=http://splrk8evhp:79lYel_2zl4RVoQnvn@isp.decodo.com:10002  # fallback
```

#### 4. Supprimer la dépendance Chromium pour le scan (optionnel phase 2)

**Fichier :** `src/spain-persistent-browser.ts` → `_prefetchBookititApis()`

**Modification :** Remplacer le prefetch via `fetchBookititRawFromPage(page, url)` (Puppeteer) par des appels HTTP directs via `spainCfFetch()` — identique au pattern du script de test.

**Impact :** Plus besoin de Chromium en mémoire pour le scan. Le browser ne serait requis que pour le booking (si `signin/` retourne 0B en HTTP).

### Ordre d'implémentation (sans casser le code)

| Phase | Modification | Risque | Temps |
|:---:|------|:---:|:---:|
| 1 | Changer `DECODO_PROXY_URL` → `gate.decodo.com` dans `.env` Railway | Nul (env var) | 1 min |
| 2 | Navigation multi-mois dans `confirmSlotsViaDatetime()` | Faible (logique additive) | 30 min |
| 3 | Navigation multi-mois dans `tryApiFirstWithCachedSession()` | Faible (même logique) | 15 min |
| 4 | Mode `capsolver-residential` dans `ensureSpainCfSession()` | Moyen (nouveau path) | 1h |
| 5 | Supprimer Chromium du scan (HTTP-only complet) | Élevé (booking affecté) | 2h+ |

### Variables d'environnement finales (config production cible)

```bash
# Mode HTTP-only (pas de browser pour le scan)
SPAIN_HTTP_MODE=1
SPAIN_SESSION_MODE=capsolver-residential

# Proxy résidentiel Decodo (rotatif, pas ISP)
DECODO_PROXY_URL=http://sp4e4cx19x:{password}@gate.decodo.com:10001

# Capsolver pour le solve CF (~15s, $0.003/solve)
CAPSOLVER_API_KEY=CAP-...

# Intervalle de scan (secondes)
SPAIN_HTTP_SCAN_INTERVAL_SEC=30
```

### Portails validés (HTTP-pur + proxy résidentiel)

| Portail | PublicKey | Proxy | Résultat |
|---------|-----------|-------|----------|
| São Paulo | `2d01502f12dc08400e22aea87fb00ae34` | gate:10001-10003 ✅ | 331 créneaux sept |
| Cuba (LMD) | `28330379fc95acafd31ee9e8938c278ff` | gate:10006 ✅ | 4193 créneaux sept-oct |
| Cameroun | `2c7359283dfa615bb8bf086b630561d9d` | isp:10002 ✅ | 0 (maxDays=aujourd'hui) |
| Kinshasa | `25028fcd7126544630b8da0c6e60722b5` | gate:10005 ✅ | getagendas 0B = fermé |
