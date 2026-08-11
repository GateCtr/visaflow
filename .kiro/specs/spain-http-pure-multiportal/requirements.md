# Requirements Document

## Introduction

Migration du scanner de créneaux Espagne (citaconsular.es / Bookitit) depuis une architecture hybride browser+HTTP vers une architecture 100% HTTP-pure multi-portail. Le système actuel utilise un Chromium persistant pour résoudre les challenges Cloudflare et précharger les données widget. La nouvelle architecture élimine Chromium du chemin de scan, utilise Capsolver pour la résolution CF, un proxy résidentiel rotatif pour contourner les bans IP, et supporte la surveillance simultanée de N portails Bookitit.

## Glossary

- **Scanner**: Module qui détecte la disponibilité de créneaux de rendez-vous sur un portail Bookitit
- **Portal**: Instance Bookitit identifiée par une publickey unique (ex: `2d01502f...` = São Paulo)
- **CF_Session**: Session Cloudflare composée d'un cookie `cf_clearance` + `PHPSESSID`, liée à une IP proxy, valide ~2h
- **Capsolver**: Service tiers de résolution de challenges Cloudflare via AntiCloudflareTask (~15s, $0.003/solve)
- **Impit**: Client HTTP Node.js avec fingerprint TLS Chrome (JA3/JA4), remplace Playwright pour les requêtes HTTP
- **Bookitit**: Système de réservation en ligne utilisé par citaconsular.es, exposant une API JSONP
- **Residential_Proxy**: Proxy rotatif Decodo (`gate.decodo.com`) utilisant des IPs de foyers réels, impossible à bannir par range
- **ISP_Proxy**: Proxy dédié Decodo (`isp.decodo.com`) utilisant des IPs de datacenter/ISP, actuellement grillé
- **maxDays**: Champ retourné par l'API `datetime/` indiquant la date maximale de disponibilité des créneaux pour un portail
- **Widget_Key**: Clé publique Bookitit (32+ hex chars) identifiant un portail dans l'URL widget
- **Watcher_Loop**: Boucle principale d'orchestration (`spain-watcher-loop.ts`) qui coordonne les scans et les bookings
- **JSONP_Chain**: Séquence d'appels API Bookitit : `getservices/` → `getagendas/` → `datetime/`
- **Dossier**: Demande de visa d'un client, stockée dans Convex, contenant credentials et préférences de créneau

## Requirements

### Requirement 1: Résolution CF via Capsolver (mode HTTP-pure)

**User Story:** As a system operator, I want the scanner to resolve Cloudflare challenges via Capsolver without Chromium, so that I eliminate browser overhead and support headless deployment.

#### Acceptance Criteria

1. WHEN `SPAIN_SESSION_MODE` is set to `capsolver-residential`, THE Scanner SHALL resolve Cloudflare challenges using Capsolver AntiCloudflareTask with the HTML body and proxy forwarded to the API
2. WHEN a CF challenge is detected (HTTP 403 + "Just a moment" body), THE Scanner SHALL submit the challenge HTML and proxy URL to Capsolver and poll for the `cf_clearance` cookie with a timeout of 120 seconds
3. WHEN Capsolver returns a `cf_clearance` cookie, THE Scanner SHALL store it in the CF_Session alongside the proxy URL and a creation timestamp
4. IF Capsolver returns an error or times out, THEN THE Scanner SHALL log the error with `[spain-soax]` prefix, mark the session as failed, and retry after a backoff of 60 seconds
5. THE Scanner SHALL reuse an existing CF_Session if its age is less than 105 minutes (leaving 15 minutes of margin before the 2h expiry)
6. WHEN the CF_Session age exceeds 105 minutes, THE Scanner SHALL proactively trigger a new Capsolver solve before the session expires

---

### Requirement 2: Proxy résidentiel rotatif comme source principale

**User Story:** As a system operator, I want the scanner to use residential proxy pools instead of burned ISP proxies, so that scans are not blocked by Cloudflare IP range bans.

#### Acceptance Criteria

1. WHEN `SPAIN_SESSION_MODE` is `capsolver-residential`, THE Scanner SHALL use the proxy URL from `SPAIN_RESIDENTIAL_PROXY_URL` environment variable (format: `http://user:pass@gate.decodo.com:port`)
2. IF `SPAIN_RESIDENTIAL_PROXY_URL` is not set, THEN THE Scanner SHALL fall back to `DECODO_PROXY_URL`, then to `SOAX_PROXY_URL`, in priority order
3. THE Scanner SHALL use the same proxy IP for all requests within a single CF_Session (sticky session via proxy connection reuse or session ID parameter)
4. WHEN a scan returns 0 bytes on `/main/` or any Bookitit endpoint, THE Scanner SHALL flag the current proxy IP as potentially burned and rotate to a different residential IP on the next CF solve
5. THE Scanner SHALL log the proxy URL (with password masked) at session creation time for debugging

---

### Requirement 3: Multi-portail — scan de N portails en parallèle

**User Story:** As a system operator, I want to scan multiple Bookitit portals simultaneously in a single watcher loop, so that all active dossiers across different consulates are covered.

#### Acceptance Criteria

1. THE Watcher_Loop SHALL group active dossiers by their `portalUrl` and scan each unique portal per cycle
2. WHEN multiple dossiers share the same `portalUrl`, THE Scanner SHALL perform a single scan and distribute the results to all matching dossiers
3. THE Scanner SHALL maintain a separate Bookitit session state (PHPSESSID, jQuery callback, services/agendas cache) per portal
4. WHEN all portals share the same domain (`citaconsular.es`), THE Scanner SHALL share a single CF_Session across all portals (the `cf_clearance` cookie covers the entire domain)
5. THE Watcher_Loop SHALL scan portals sequentially within a cycle (not concurrently) to avoid rate-limiting, with a configurable inter-portal delay (default 2 seconds with ±500ms jitter)
6. IF a portal scan returns `getagendas/` with 0 bytes, THEN THE Scanner SHALL mark that portal as "closed" for the current cycle and skip datetime/ without failing the entire scan
7. THE Watcher_Loop SHALL report per-portal scan results to Convex, including portal URL, scan duration, and slot count

---

### Requirement 4: Navigation multi-mois dynamique (maxDays)

**User Story:** As a system operator, I want the scanner to discover all available months dynamically based on `maxDays`, so that slots in M+2/M+3 are not missed.

#### Acceptance Criteria

1. THE Scanner SHALL always scan at minimum 2 months (current month M and M+1) regardless of the `maxDays` value returned for the current month
2. WHEN `datetime/` returns a `maxDays` field, THE Scanner SHALL parse it and continue scanning subsequent months until the first day of the next month exceeds the highest `maxDays` observed across all responses
3. THE Scanner SHALL stop scanning after a maximum of 12 months for safety
4. IF 3 consecutive months return zero slots and no `maxDays` is present, THEN THE Scanner SHALL stop scanning additional months for that portal
5. WHEN a slot is found in month M+N (N > 0), THE Scanner SHALL include the slot date, time, freeSlots count, and agenda ID in the scan result regardless of which month it was discovered in
6. THE Scanner SHALL not hardcode the number of months to scan (the current `for i < 9` and `[0, 1, 2]` patterns must be replaced)

---

### Requirement 5: Initialisation session Bookitit HTTP-pure

**User Story:** As a system operator, I want the Bookitit session to be established via pure HTTP requests (no browser), so that scans work without Chromium in memory.

#### Acceptance Criteria

1. WHEN establishing a new Bookitit session for a portal, THE Scanner SHALL execute the 3-step init: GET widget URL → POST token → GET `/main/`
2. WHEN the GET widget response contains a `name="token" value="..."` input field, THE Scanner SHALL extract the token and POST it as `application/x-www-form-urlencoded` to the same widget URL
3. WHEN the POST response contains `srvsrc` and `loadermaec.js?v=N`, THE Scanner SHALL extract these values and use them as `srvsrc` and `version` parameters for all subsequent Bookitit API calls
4. THE Scanner SHALL generate a single jQuery callback string (`jQuery21109{timestamp}_{random9digits}`) per session and reuse it for all JSONP requests within that session
5. THE Scanner SHALL increment the `_` parameter (cache buster) on every request within the session
6. IF the GET widget or POST token returns an empty body or HTTP error, THEN THE Scanner SHALL invalidate the session and retry with a fresh CF solve

---

### Requirement 6: Auto-découverte services et agendas

**User Story:** As a system operator, I want the scanner to auto-discover services and agendas for each portal dynamically, so that new services added to a portal are detected without code changes.

#### Acceptance Criteria

1. WHEN a Bookitit session is initialized for a portal, THE Scanner SHALL call `getservices/` to retrieve the list of available services
2. WHEN services are discovered, THE Scanner SHALL call `getagendas/` once per session for the target service (matched via `spain-service-mapping` for the dossier's visaType)
3. THE Scanner SHALL call `getagendas/` only once per PHPSESSID (Bookitit rejects subsequent calls with 0B response)
4. IF `getservices/` returns `AllowAppointment: false`, THEN THE Scanner SHALL still attempt `getagendas/` (the flag may be stale while slots exist)
5. THE Scanner SHALL cache the discovered services and agendas with a TTL of 30 minutes (aligned with PHPSESSID lifetime)
6. WHEN the cache expires, THE Scanner SHALL re-initialize the full Bookitit session (new PHPSESSID + fresh discovery)

---

### Requirement 7: Réduction de la bande passante résidentielle

**User Story:** As a system operator, I want to minimize residential proxy bandwidth consumption, so that the limited 3GB monthly allocation lasts for continuous scanning.

#### Acceptance Criteria

1. THE Scanner SHALL skip the GET `/main/` (128KB) on subsequent scans within the same session, reusing the cached services and agendas from the initial call
2. WHEN only `datetime/` needs refreshing, THE Scanner SHALL call only `datetime/` (~10KB per month) without re-fetching `/main/`, `getservices/`, or `getagendas/`
3. THE Scanner SHALL estimate and log cumulative bandwidth usage per session (sum of response body sizes)
4. WHEN estimated daily bandwidth exceeds a configurable threshold (default 500MB), THE Scanner SHALL increase the scan interval by 2x and log a warning
5. THE Scanner SHALL use `Accept-Encoding: gzip, deflate, br` on all requests to minimize transfer size
6. WHEN a CF solve is triggered, THE Scanner SHALL count it toward the bandwidth budget (~50KB per solve roundtrip)

---

### Requirement 8: Intégration dans spain-watcher-loop existant

**User Story:** As a developer, I want the HTTP-pure multi-portal scanner to integrate into the existing watcher loop architecture, so that Convex reporting, booking, and Redis coordination continue working.

#### Acceptance Criteria

1. THE Watcher_Loop SHALL support a new mode `SPAIN_SESSION_MODE=capsolver-residential` alongside the existing `persistent-browser` and HTTP/Playwright modes
2. WHEN `capsolver-residential` mode is active, THE Watcher_Loop SHALL use the new multi-portal scanner instead of `runSpainHttpProbe()` or `runSpainWatcherProbe()`
3. THE Scanner SHALL return results compatible with the existing `SpainHttpScanResult` interface (including `_allSlots`, `_exploration`, `_widgetConfig`, `_mainHtml`, `_services`)
4. WHEN a slot is found, THE Watcher_Loop SHALL continue using `executeHttpBooking()` with the existing booking path (signin/ → summary/)
5. THE Scanner SHALL emit the same Convex events (`reportSpainWatcherScan`, `reportSlotFound`, `reportSlotDiscoveryBatch`) as the current system
6. THE Scanner SHALL acquire and release the Redis scanner lock (`acquireSpainScannerLock` / `releaseSpainScannerLock`) to prevent duplicate scans across instances
7. THE Scanner SHALL send heartbeats to Convex at the same frequency as the current system

---

### Requirement 9: Fallback browser pour booking registration_type=2

**User Story:** As a system operator, I want the booking to fall back to browser-based signin when a portal's `registration_type=2` causes HTTP signin/ to return 0B, so that bookings succeed on all portal types.

#### Acceptance Criteria

1. WHEN `_widgetConfig.registration_type` is `"2"` (registration required), THE Scanner SHALL flag the portal as requiring browser-based booking
2. WHEN a slot is found on a registration_type=2 portal, THE Watcher_Loop SHALL launch a Chromium instance specifically for booking (not for scanning)
3. WHEN booking via HTTP (signin/) returns 0 bytes or an empty `Client` object, THE Watcher_Loop SHALL retry via `submitSigninFormViaDOM()` using the persistent browser
4. THE Scanner SHALL never use Chromium for the scan phase regardless of registration_type
5. IF no browser fallback is available (Chromium not installed or crashed), THEN THE Watcher_Loop SHALL log a critical error and alert via Convex without blocking subsequent scan cycles

---

### Requirement 10: Observabilité et diagnostics

**User Story:** As a system operator, I want detailed logging and metrics for the multi-portal HTTP-pure scanner, so that I can diagnose failures and monitor performance.

#### Acceptance Criteria

1. THE Scanner SHALL log each portal scan with prefix `[SPAIN-HTTP-MULTI]` including: portal name, scan duration, month range scanned, and total slots found
2. WHEN a CF solve is performed, THE Scanner SHALL log the solve duration and cost ($0.003) with timestamp
3. THE Scanner SHALL log bandwidth consumption per scan cycle (total bytes received across all portals)
4. IF a portal returns unexpected results (0B on an endpoint that previously worked), THEN THE Scanner SHALL log the full response status, headers, and body length for debugging
5. WHEN the watcher loop starts, THE Scanner SHALL log the complete configuration: mode, proxy type, number of portals, scan interval, and bandwidth threshold
6. THE Scanner SHALL track and log the number of consecutive failed scans per portal and emit a Convex alert if a portal fails 5 times in a row


---

### Requirement 11: Séquence exacte des requêtes JSONP (contraintes Bookitit)

**User Story:** As a developer, I want the exact request sequence and parameter ordering to be specified, so that the implementation reproduces the validated test script behavior without triggering Bookitit 0B responses.

#### Acceptance Criteria

1. THE Scanner SHALL construct JSONP URLs with parameters in this exact order: `callback` → `type` → `publickey` → `lang` → `services[]` → `agendas[]` → `version` → `src` → `srvsrc` → remaining extras (`selectedPeople`, `start`, `end`) → `_` (cache buster). Bookitit may return 0B if the parameter order deviates.
2. THE Scanner SHALL include the `srvsrc` parameter (value: `https://www.citaconsular.es`) on ALL endpoints EXCEPT `/main/` — `/main/` must NOT include `srvsrc`
3. THE Scanner SHALL use a single jQuery callback string per PHPSESSID session (format: `jQuery21109{13-digit-timestamp}_{9-digit-random}`), reused identically across ALL JSONP calls within that session. A different callback per request causes 0B responses.
4. THE Scanner SHALL call `getagendas/` exactly ONCE per PHPSESSID. The second call within the same session returns 0B regardless of parameters.
5. WHEN selecting the target service from `getservices/` response, THE Scanner SHALL pick the first service whose `name` field is non-empty after stripping HTML tags. Services with empty names are placeholder/disabled entries.
6. THE Scanner SHALL execute the JSONP chain in strict order: `getwidgetconfigurations/` → `getservices/` → `getagendas/` (for target service) → `datetime/` (per month). Any call made before its predecessor completes may receive 0B (server-side state machine).
7. WHEN constructing `datetime/` requests, THE Scanner SHALL use `start=YYYY-MM-01` and `end=YYYY-MM-{lastDay}` (NOT `month` and `year` parameters) with `selectedPeople=1`
8. THE Scanner SHALL include the `services[]=bktXXXXXX` parameter using PHP array notation (bracket suffix) on `getagendas/` and `datetime/` calls
9. THE Scanner SHALL set these HTTP headers on all Bookitit requests: `Accept: text/javascript, application/javascript, */*; q=0.01`, `X-Requested-With: XMLHttpRequest`, `Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest: empty`, `Referer: {widget_url}`
10. THE Scanner SHALL reference `src/scripts/test-bookitit-dynamic.ts` as the canonical implementation of this sequence — any deviation from that script's behavior must be explicitly justified

---

### Requirement 12: Gestion des réponses JSONP et parsing

**User Story:** As a developer, I want robust JSONP response parsing that handles all Bookitit response patterns, so that the scanner correctly interprets both valid data and error conditions.

#### Acceptance Criteria

1. THE Scanner SHALL parse JSONP responses by stripping the callback wrapper (`callbackName({...});` → JSON payload) before JSON.parse
2. WHEN `datetime/` returns a `Slots` array, THE Scanner SHALL iterate each day and check the `times` object: keys are numeric IDs, values contain `freeSlots` (number of available places) and `time` (human-readable "HH:MM")
3. A slot is considered available WHEN `freeSlots > 0` within a `times` entry
4. WHEN `datetime/` returns `Slots` with all days having empty `times` objects (`{}`), THE Scanner SHALL interpret this as "no slots available for this month" (not an error)
5. WHEN any Bookitit endpoint returns an empty body (0 bytes with HTTP 200), THE Scanner SHALL distinguish between: (a) proxy/CF issue if it's `/main/` → rotate proxy, (b) portal closed if it's `getagendas/` → mark portal closed, (c) session expired if it's `getservices/` or `datetime/` → reinitialize session
6. WHEN `getservices/` returns an `AllowAppointment` field set to `false`, THE Scanner SHALL log this but continue the chain (the field may be stale)
7. THE Scanner SHALL extract `maxDays` from each `datetime/` response using the pattern `"maxDays":"YYYY-MM-DD"` and track the highest value seen across all months for the stop condition
