---
name: Bookitit HTTP endpoint blocking
description: Tous les endpoints citaconsular.es/onlinebookings/* retournent "Contact with your technical support" depuis des clients HTTP non-browser — cause, preuve, contournement.
---

## Fait confirmé

`/onlinebookings/main/`, `/getwidgetconfigurations/`, `/getservices/`, `/getagendas/` retournent TOUS
`{"Exception":{"errors":[{"type":"system","message":"Contact with your technical support."}]}}` depuis n'importe quel client HTTP non-browser :

- impit avec proxy Decodo ISP
- native Node.js fetch (IP Replit directe, aucun proxy)
- curl depuis le terminal Replit
- avec ou sans cf_clearance valide
- avec ou sans PHPSESSID valide (avant ou après POST Continuar)
- avec ou sans tous les headers Sec-Fetch/Referer/Accept-Language

## loadermaec.js (6414B) — analysé complet

Flux : `start()` → `loadJquery()` → `$.getJSON('/onlinebookings/main/?callback=?', bkt_init_widget, cb)`. **Aucun appel d'initialisation ou d'auth avant /main/**. Les empty arrays (services/agendas/dates) ne génèrent aucun param jQuery — notre construction URL était correcte.

## Comportement `src` param

- **Avec `src=PORTAL_URL`** : HTTP 200 | 0B | content-type: text/html — Bookitit retourne du HTML vide (mode iframe) car le backend PHP ne trouve pas la session Bookitit initialisée.
- **Sans `src`** : HTTP 200 | 124B | application/javascript — JSONP avec l'erreur Bookitit.

## Cause probable

citaconsular.es agit comme reverse proxy côté serveur vers Bookitit. Bookitit bloque les IPs datacenter/proxy via `X-Forwarded-For` ou une validation IP-list. Replit (GCP/AWS datacenter) et Decodo ISP sont tous les deux bloqués. La requête navigateur passe parce que le navigateur exécute via l'IP Decodo ET a les bons fingerprints TLS + headers JSD.

## Preuve production

`spain-http-scanner.ts` ne réussit JAMAIS à appeler ces endpoints via HTTP direct. La ligne `callBookititEndpointViaBrowser(url)` est le seul chemin qui fonctionne. Le scanner HTTP est donc mal nommé — il utilise le browser (Puppeteer) pour tous les endpoints Bookitit.

**Why:** Ne pas perdre de temps à debugger les appels HTTP directs vers citaconsular.es/onlinebookings/* — c'est une limitation fondamentale, pas un bug de configuration.

**How to apply:** Pour tout travail sur le scanner Espagne, les endpoints Bookitit exigent le browser Puppeteer (callBookititEndpointViaBrowser). CapSolver reste utile pour accélérer le solve CF côté Puppeteer (~40s vs ~130s JSD naturel) : probe avec impit → solve CapSolver → injecter cf_clearance dans Puppeteer → reload → bypass CF immédiat.
