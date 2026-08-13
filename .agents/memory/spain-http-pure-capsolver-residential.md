---
name: Spain HTTP-pur capsolver-residential
description: Mode capsolver-residential pour Spain — Impit + CapSolver + gate.decodo.com — implémenté 2026-08-11.
---

## Règle
`SPAIN_SESSION_MODE=capsolver-residential` + `SPAIN_RESIDENTIAL_PROXY_URL=http://user:pass@gate.decodo.com:10001`
= flow HTTP-pur reproduisant exactement test-bookitit-dynamic.ts.

## Séquence d'init de session (ensureSpainCfSession)
1. GET widget → détecter CF challenge
2. CapSolver AntiCloudflareTask (avec `html:` prefix) → cf_clearance
3. GET widget avec cf_clearance → token + PHPSESSID
4. POST token → srvsrc + version (regex `srvsrc:\s*'([^']+)'` et `loadermaec\.js\?v=(\d+)`)
5. GET /main/ via makeResidentialUrl → valider >1000B
6. Retry sur port différent (10001-10010) si /main/ < 1000B

## Champs bookititState dans SpainCfSession
Session.bookititState = { jqCallback, reqCounter (mutable), srvsrc, version, widgetUrl, publickey, bookititBase }
Généré dans ensureSpainCfSession (capsolver-residential) ; utilisé par makeBookititUrl().
⚠️ Ne pas sérialiser reqCounter dans Redis (mutable).

## makeBookititUrl (exporté depuis spain-soax-solver.ts)
Ordre de paramètres strict (Cuba/São Paulo exigent cet ordre) :
callback → type → publickey → lang → [services[]] → [agendas[]] → version → src → srvsrc → [extras] → _

**Why:** Cuba (bkt897578) retourne 0B si services[] est après version.

## Dynamic maxDays dans confirmSlotsViaDatetime (spain-http-scanner.ts)
- Remplacé `for (let mo = 0; mo < 3; mo++)` par `while (mo < 12)` avec globalMaxDays.
- globalMaxDays = MAX de tous les maxDays vus dans les réponses datetime/.
- Condition d'arrêt : minimum 2 mois scannés, puis firstOfNextMonth > globalMaxDays.
- Sécurité : 3 mois vides consécutifs sans maxDays → break.

## getagendas/ param order (aussi fixé dans confirmSlotsViaDatetime)
services[] doit être avant version.
Ajout de selectedPeople=1 (manquait).

## spainPortal.ts loops
Les deux loops `for (let i = 0; i < 9; i++)` remplacées par boucle dynamique (max 12).

## Portails et proxy
- São Paulo + Cuba LMD → RESIDENTIAL_PROXY_PORTALS (gate.decodo.com)
- Kinshasa / Cameroun → ISP Decodo
- CUBA_LMD_PORTAL_URL = https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/

## Smoke test
src/scripts/test-spain-http-pure-multiportal.ts — teste les 3 portails avec invalidation inter-portail.
