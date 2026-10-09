# São Paulo (Spain) HTTP-pure: Decodo ES does NOT bypass CF chl_page

Date: 2026-10-08
Portal (São Paulo): https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/
PUBLICKEY: 28330379fc95acafd31ee9e8938c278ff

## What was tested
Replaced `artifacts/slot-hunter/decodo-proxies.csv` with a real **Decodo ES residential/ISP pool**
(`es.decodo.com:10001-19999`, user `user-Visaflow-sessionduration-60`). Backup of the old
thordata pool kept at `decodo-proxies.thordata.bak`.

Verified the Decodo ES proxies are genuinely good:
- HTTP 200 to ipinfo.io, geo = ES, distinct exit IP per sessid/port.
- Exit IPs are Spanish ISPs: AS29119 AIRE NETWORKS, AS56909 TD PR ARLU (NOT datacenter).

## Result: raw GET of the São Paulo portal through 4 different Decodo ES IPs
ALL returned:
- `HTTP/2 403` + `cf-mitigated: challenge`
- `server: cloudflare`, `cf-ray: ...-MAD` (routed via Madrid)
- "Just a moment..." interstitial, ~5975 bytes

So the hypothesis from `spain-http-proxy-binding.md` (a trusted ISP ES IP lets the GET
through without a challenge) is **FALSE for this portal today**. Proxy quality was never
the blocker.

## Challenge fingerprint (from window._cf_chl_opt in the 403 body)
- cType: 'interactive'   <- interactive MANAGED challenge
- cFPWv: 'g'
- orchestrate path: /cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=...
- NO `__CF$cv$params`  -> legacy JSD-oneshot path (jsd-solver.ts / test-cuba-jsd-flow.ts) does NOT apply
- NO Turnstile sitekey -> solveViaImpit Turnstile branch cannot engage

## Conclusion
Cloudflare now serves an **interactive managed `chl_page`** on every GET regardless of IP
reputation. This requires real browser JS execution to clear. A raw HTTP client (impit, Go
uTLS/curl) cannot pass the GET. CapSolver AntiCloudflareTask returns a cf_clearance bound to
its own TLS/JS context that our HTTP client cannot replay (confirmed earlier: 0 pass across
impit TLS 131/136/142 and Go uTLS chrome_131/133).

Browser (persistent-browser) mode is the ONLY path that clears this challenge today, but it
is excluded by the <40s slot-timing constraint.

## Implication for prod
`initWorkerSession` + AntiCloudflareTask is structurally unable to clear an interactive
chl_page via a raw HTTP client. The fix is NOT a better proxy and NOT a different TLS
fingerprint — it is either (a) a solver that returns a clearance usable by our client for an
interactive chl_page, or (b) a headless-browser clearance step whose cookies are then handed
to the fast HTTP scan loop.


---

## Test 2026-10-08 (suite) — Go uTLS aligné Chrome/151 + flux prod : les deux échouent

### Test 1 — CapSolver + Go uTLS, empreinte TLS ALIGNÉE sur Chrome/151
Variable enfin contrôlée : le profil TLS Go = version Chrome que CapSolver utilise (151),
avec `sec-ch-ua` dérivé dynamiquement de l'UA (fin du décalage UA/CH-UA).
Ajout des profils Chrome_144/146/150/152 au serveur Go (`tls-proxy-go/main.go`).
Script : `src/scripts/debug-go-tls-aligned.ts` (URL São Paulo 2d01502f..., IPs START=8888).

Résultat :
  chrome_152 (le + proche de 151) → 0/2 PASS | CF solved 2/2
  chrome_150                      → 0/2 PASS | CF solved 1/2
  chrome_146                      → 0/2 PASS | CF solved 2/2
GET2 post-clearance = 403, encoreCF=OUI, token ✗, PHPSESSID ✗ sur TOUS.

CONCLUSION : aligner l'empreinte TLS sur la version Chrome exacte de CapSolver NE SUFFIT PAS.
Le cf_clearance d'un chl_page interactif n'est pas rejouable par un client HTTP tiers, même
TLS-identique à Chrome. La piste uTLS est définitivement close.

### Test 2 — Flux prod réel (runDossierWorker → initWorkerSession + CapSolver, impit)
Harness existant `src/scripts/test-worker-single-dossier.ts saopolo`, IPs forcées autour de
8888 via nouvel override `SPAIN_DECODO_START_INDEX` (ajouté à initDecodoPool, test-only).
Résultat : CF solved OK (917-959B) sur chaque IP, GET post-solve = 403 token absent,
rotation+blacklist 8889→8892, puis Status: error "Impossible d'établir session".

### Sweep large (contrôle, GET brut, 17 IPs sur tout le pool 10001→19999)
PASS=0, CHALLENGE=17. Aucune IP ne franchit le GET brut.

## Verdict consolidé
HTTP-pur (impit OU Go uTLS) + CapSolver AntiCloudflareTask NE PEUT PAS franchir le chl_page
interactif actuel du portail São Paulo, quelle que soit l'IP (9999 Decodo ES testées en
sweep) et quelle que soit l'empreinte TLS (impit 131/136/142 + Go 146/150/152). La « réussite
sur certaines IPs » d'avant correspondait à un challenge passif (JSD) que CF a remplacé par un
chl_page interactif. Options restantes : (A) browser-one-shot qui alimente la boucle HTTP, ou
(B) un service type cloud-browser/web-unlocker qui exécute le JS. Pas de voie HTTP-pure pure.
