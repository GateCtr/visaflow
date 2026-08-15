---
name: Spain per-dossier worker TLS rule
description: Impit must probe the portal BEFORE CapSolver solve; the SAME impit instance must be reused as _ownImpit — creating a new one after solve breaks TLS coherence.
---

# Spain per-dossier worker TLS rule

## Rule
When a worker solves CF via CapSolver (AntiCloudflareTask with HTML):
1. Create the impit instance FIRST with `createImpitWithProxy(proxyUrl)`.
2. GET the portal via that impit → capture challenge HTML + UA.
3. Call `solveSpainCloudflare(url, key, proxy, html, ua)` with the captured HTML.
4. Assign `session._ownImpit = probeImpit` — the SAME instance that did the probe.

**Never** call `createFreshSpainImpit(session)` or `createImpitWithProxy()` AFTER the solve step. The resulting cf_clearance is cryptographically tied to the TLS session of the impit that captured the challenge HTML. A new impit has a different TLS session → CF returns 403/0B.

## Why
`solveSpainCloudflare` without HTML: CapSolver uses its own internal Chrome → cf_clearance tied to CapSolver's Chrome TLS fingerprint → impit (different fingerprint) gets 403.

With HTML: CapSolver solves the challenge that was served to THIS impit instance → cf_clearance tied to the TLS session of this specific impit → subsequent requests from the same impit get 200.

Documented explicitly in `solveSpainCloudflare` source comments (lines 417-430 of spain-soax-solver.ts).

## How to apply
- `spain-dossier-worker.ts` `runDossierWorker()`: probe step happens before solve, impit reused.
- `createImpitWithProxy(proxyUrl)` exported from `spain-soax-solver.ts` for pre-session impit creation.
- If impit must be recreated (IP change, etc.), a full re-solve cycle must follow immediately.
