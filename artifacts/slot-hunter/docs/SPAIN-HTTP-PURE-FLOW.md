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
