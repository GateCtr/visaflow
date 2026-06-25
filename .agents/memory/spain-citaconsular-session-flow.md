---
name: Spain citaconsular.es session flow
description: Exact HTTP flow for citaconsular.es confirmed by Burp Chrome 146 capture — cookies, JSD oneshot, double widget POST sequence.
---

## Confirmed flow (Burp 2026-06-25)

Row 1  → GET  `/es/hosteds/widgetdefault/<pk>/`              → 403 CF challenge  
Row 2  → GET  CF orchestrate chl_page                        → 200  
Row 4  → POST CF flow (citaconsular.es)                      → 200  
Row 5  → GET  Turnstile (challenges.cloudflare.com)          → 200  
Row 8  → POST CF flow (challenges.cloudflare.com)            → 200  
Row 14 → POST CF flow (citaconsular.es) → **sets cf_clearance #1** + new PHPSESSID  
Row 15 → POST `/es/hosteds/widgetdefault/<pk>/` (token submit) → 200 widget HTML  
Row 21 → POST `/cdn-cgi/rum?`  (~5s after row 15)            → 204  
Row 22 → POST `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/<siteKey>/<nonce>/<rayId>` → **sets cf_clearance #2**  
Row 23 → POST `/es/hosteds/widgetdefault/<pk>/` (same token) → 200 widget HTML  
Row 24 → POST `/cdn-cgi/rum?`  (~402ms after row 23)         → 204  
Row 26 → GET  `/onlinebookings/main/?callback=...`           → 200 (JSONP, 124KB)  
Row 28 → POST `/cdn-cgi/rum?`  (~3ms after row 26)           → 204  
Row 103→ GET  `/onlinebookings/getwidgetconfigurations/?...`  → 200  
Row 107→ GET  `/onlinebookings/getservices/?...`              → 200  

## Cookie header order (EVERY request)
`_ga=GA1.1.<rnd>.<ts>; _ga_F3TYSDL945=GS2.1.s<ts>$o1...; PHPSESSID=<id>; cf_clearance=<token>`

**Why:** CF behavioral scoring uses all cookies. PHPSESSID absence = no session correlation = bot signal.

**How to apply:** In `scanViaMainEndpoint`, build `buildCookieStr()` locally and pass it as explicit `Cookie` header override in every `spainCfFetch` call (the base function builds Cookie from session.cfClearance only — must override).

## PHPSESSID capture
- Server sets PHPSESSID in Set-Cookie on the GET entry page (row 1, after CF challenge resolved).
- Must extract from `res.headers.getSetCookie()`, look for `PHPSESSID=` prefix.
- Forward in ALL subsequent requests on the session.

## JSD Oneshot (row 22)
- URL pattern: `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/<12hex>/<nonce>/<16hex>`
- URL is embedded in the widget HTML response (row 15) by CF's inline script.
- Extract via regex: `/\/cdn-cgi\/challenge-platform\/h\/b\/jsd\/oneshot\/([a-f0-9]{10,14})\/([^'"<\s]{10,})\/([a-f0-9]{14,18})/`
- Body is JS-computed telemetry — cannot reproduce in HTTP-only mode.
- Fire best-effort with CSRF token as body; capture Set-Cookie if CF returns new cf_clearance.
- Non-fatal if it fails — continue with existing cf_clearance.

## Second widget POST (row 23)
- After JSD oneshot, browser re-POSTs the widget with the same token + new cf_clearance.
- This is the POST whose Referer the JSONP calls use.
- Must use `widgetReferer` (URL with trailing slash) as both target and Referer.

## Accept-Language
Confirmed by Burp: `fr-FR,fr;q=0.9` (not es-ES). Use this everywhere in the scanner.

## Priority header
Navigation requests: `Priority: u=0, i`
JSONP/XHR requests: `Priority: u=1, i`

## GA cookies format
`_ga=GA1.1.<9-digit-random>.<unix-ts-minus-rand-days>`
`_ga_F3TYSDL945=GS2.1.s<unix-ts>$o1$g0$t<unix-ts>$j60$l0$h0`
Generate once per `scanViaMainEndpoint` call (not per-session singleton — varies per browser visit).
