# 🇪🇸 Spain Watcher — Architecture Complète

## Vue d'ensemble

Le Spain Watcher surveille les créneaux de rendez-vous consulaires espagnols via le widget Bookitit
hébergé sur `citaconsular.es`. Il fonctionne en **deux modes** et gère le flow complet :
détection → alerte → (optionnel) auto-booking.

---

## Modes de fonctionnement

| Mode | Env var | Intervalle | Coût | RAM |
|------|---------|-----------|------|-----|
| **HTTP-ONLY** (actif) | `SPAIN_HTTP_MODE=1` | 30s | ~$0.005/2h (1 CF solve) | 0 |
| Playwright (legacy) | `SPAIN_HTTP_MODE=0` | 3-5min | gratuit (stealth) | ~500MB |

---

## Flow Actuel — Mode HTTP-ONLY 🚀

```
┌─────────────────────────────────────────────────────────────────┐
│                    startSpainWatcherLoop()                        │
│                  spain-watcher-loop.ts                            │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  1. initSpainRedis()  →  Restaurer session CF si encore valide   │
│  2. restoreSpainSoaxStateFromRedis()  →  Rotation counter        │
│  3. getSpainWatcherConfig()  →  portalUrl depuis Convex          │
│  4. ensureSpainCfSession(portalUrl)  →  Solve CF si nécessaire   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼  (toutes les 30s)
┌─────────────────────────────────────────────────────────────────┐
│               runSpainHttpProbe(portalUrl)                        │
│               spain-http-scanner.ts                               │
│                                                                   │
│  1. ensureSpainCfSession(portalUrl)                              │
│     → mémoire > Redis > CapSolver AntiCloudflareTask + SOAX     │
│                                                                   │
│  2. scanViaMainEndpoint(session, portalUrl)                      │
│     a) GET portalUrl  →  Token CSRF + PHPSESSID                  │
│     b) POST token     →  Widget Bookitit initialisé              │
│     c) GET /onlinebookings/main/?publickey=...&callback=...      │
│        → Retourne ~116K HTML avec le DOM pré-rendu               │
│                                                                   │
│  3. Parse HTML :                                                  │
│     • <div style='text-align:center'>No hay horas</div>         │
│       → VISIBLE = pas de créneau (not_found)                     │
│     • <div style='display:none'>No hay horas</div>              │
│       → MASQUÉ = créneaux disponibles ! (found)                  │
│     • #selectservice/ID rendus = services avec créneaux          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│           reportSpainWatcherScan(status, slotInfo)                │
│           → POST /hunter/spain-watcher/scan-result               │
│                                                                   │
│  Convex :                                                         │
│    • Insert dans spainWatcherScans (historique)                   │
│    • Patch spainWatcher singleton (lastResult)                   │
│    • SI status=found → scheduler internalSendWatcherAlert        │
│      → Resend API → Email HTML à adminEmail                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Flow Booking Playwright (spainPortal.ts)

Quand un créneau est détecté, le booking utilise Playwright :

```
Créneau détecté (date, time, agendaId)
    │
    ▼
runSpainSession(job) / tryAutoBookSpainSlot(page, job, slot)
    │
    ├─ 1. Navigate → #selecttime/{date}/{time}/{agendaId}
    │     Le router Bookitit redirige vers #signin ou #signup
    │
    ├─ 2. SIGNIN (compte existant) :
    │     • Fill #idIptBktSignInlogin (email)
    │     • Fill #idIptBktSignInpassword
    │     • Attendre CF Turnstile (14s max)
    │     • Click #idBktDefaultSignInConfirmButton
    │
    ├─ 2b. SIGNUP (nouveau compte) :
    │     • Fill #idIptBktname, #idIptBktemail
    │     • Check #idIptBktAcceptCondtions
    │     • Click #idBktDefaultSignUpConfirmButton
    │
    ├─ 3. POST-LOGIN : attendre hash stabilisation (20s)
    │     → #confirmclient | #creditcardcapture | #summary
    │
    ├─ 4. OTP (si #confirmclient + champ validate visible) :
    │     • requestOtpChallenge() → Convex
    │     • Poll consumeOtpCode() pendant 90s
    │     • Fill #idIptBktValidateCode + confirm
    │
    ├─ 5. PAYMENT (si #creditcardcapture) :
    │     → Pour RDV gratuits : auto-redirect vers #summary
    │     → Pour RDV payants : "payment_required"
    │
    └─ 6. CONFIRMATION (#summary) :
          • waitForSummaryReady()
          • extractLocatorFromSummary() → code 5-12 digits
          • Screenshot + PDF capture
          • reportSlotFound() → Convex + email admin
```

---

## Structure du Widget Bookitit

### Quand PAS de créneaux (état normal) :

```html
<div id="idDivBktServicesContainer">
  <!-- Placeholder (toujours présent) -->
  <div style='display: none; text-align: center; font-size: 1.5em;'>
    No hay horas disponibles.
  </div>
  <!-- VISIBLE = pas de créneau -->
  <div style='text-align: center; font-size: 1.5em; font-weight: bold;'>
    No hay horas disponibles.<br>Inténtelo de nuevo dentro de unos días.
  </div>
  <div id='idListServices'></div>  <!-- VIDE -->
</div>
```

### Quand créneaux DISPONIBLES :

```html
<div id="idDivBktServicesContainer">
  <!-- Les DEUX divs passent en display:none -->
  <div style='display: none;...'>No hay horas disponibles.</div>
  <div style='display: none;...'>No hay horas disponibles.</div>
  <!-- Services rendus avec liens cliquables -->
  <div id='idListServices'>
    <a href='#selectservice/123'>
      <div class="clsBktServiceDataContainer clsBktServiceAtt">
        <div class="clsBktServiceDataName">Visa Court Séjour Schengen</div>
        <div class="clsBktServiceDataDuration">30 min</div>
      </div>
    </a>
    <a href='#selectservice/456'>
      <div class="clsBktServiceDataContainer clsBktServiceAtt">
        <div class="clsBktServiceDataName">Visa National</div>
      </div>
    </a>
  </div>
</div>
```

---

## Templates Underscore.js (43 templates = flow complet)

Le widget charge les templates pour le booking côté client :

| # | Template ID | Rôle |
|---|------------|------|
| 1 | `idTemSelectServices` | Liste des services disponibles |
| 2 | `idTemSelectAgendas` | Sélection d'un agenda (lieu) |
| 3 | `idTemAvailableTime` | Grille de créneaux horaires |
| 4 | `idTemSignupInputFields*` | Formulaire inscription (nom, email, passport) |
| 5 | `idTemSignInInputFields*` | Formulaire connexion (email, mot de passe) |
| 6 | `idTemSummaryAppointment` | Résumé avant confirmation |
| 7 | `idTemTicketAppointment` | Ticket de confirmation final |

---

## Endpoints JSONP Bookitit (pour booking HTTP-only)

Base URL : `https://www.citaconsular.es/onlinebookings/`

| Endpoint | Params | Retour |
|----------|--------|--------|
| `main/` | publickey, lang, type, version, src | HTML widget complet (116K) |
| `getwidgetconfigurations/` | publickey, lang | Config widget (styles, options) |
| `getservices/` | publickey, selectedPeople | Liste services [{id, name, duration}] |
| `getagendas/` | publickey, services | Liste agendas [{id, name}] |
| `datetime/` | publickey, services, agendas, month | Slots [{date, times: {freeSlots, totalSlots}}] |
| `signup/` | name, email, fields... | Créer compte client |
| `signin/` | login, password | Authentifier client existant |
| `confirmclient/` | validateCode (OTP) | Valider le client |
| `confirmbooking/` | selectedTime, selectedDate... | Confirmer le RDV |

---

## Persistance Redis

| Clé | TTL | Contenu |
|-----|-----|---------|
| `visaflow:spain-cf:session` | ~2h (dynamique) | cf_clearance + proxy Espagne + UA + cookies |
| `visaflow:spain-soax:rotation` | 12h | Compteur rotation IP SOAX |
| `visaflow:spain-bookitit:{url}` | 30min | Config widget extraite |

---

## Configuration Convex

Table `spainWatcher` (singleton, key="default") :
- `isActive` : boolean — activer/désactiver le watcher
- `portalUrl` : URL complète du widget (avec publickey)
- `adminEmail` : email pour les alertes
- `intervalMin` : ignoré en mode HTTP (forcé à 30s)

Table `spainWatcherScans` : historique des 20 derniers scans

---

## Ce qui manque pour l'auto-booking HTTP-only

Le watcher actuel est en **détection + alerte**. Pour un booking complet sans Playwright :

1. ✅ Détection créneaux (fait — scan /main/ toutes les 30s)
2. ⏳ Extraction serviceId depuis le HTML rendu (quand "found")
3. ⏳ Appel `getservices/` → `getagendas/` → `datetime/` pour confirmer le slot exact
4. ⏳ Appel `signin/` (HTTP POST avec credentials)
5. ⏳ Gestion OTP (`confirmclient/` + poll Convex)
6. ⏳ Appel `confirmbooking/` pour finaliser

**Blocage principal** : l'étape signin peut nécessiter un CF Turnstile côté serveur,
et confirmclient nécessite un OTP (email/SMS) qui doit être injecté manuellement ou
via interception email (IMAP).

---

## Variables d'environnement

| Var | Rôle |
|-----|------|
| `SPAIN_HTTP_MODE=1` | Active le mode HTTP-only (pas de Playwright) |
| `DECODO_PROXY_URL` | Proxy ISP Decodo prioritaire pour le scan HTTP |
| `SPAIN_SOAX_COUNTRY=es` | Pays du proxy SOAX pour le CF solve |
| `SOAX_PROXY_URL` | URL base du proxy SOAX |
| `CAPSOLVER_API_KEY` | Clé API CapSolver (AntiCloudflareTask) |
| `SPAIN_HTTP_SESSION_MODE=playwright` | Diagnostic explicite uniquement ; le mode HTTP-only utilise CapSolver par défaut |
| `REDIS_HOST/PORT/PASSWORD` | Redis pour persistance |
| `RESEND_API_KEY` | Envoi emails d'alerte |
| `CONVEX_SITE_URL` | URL du backend Convex |
