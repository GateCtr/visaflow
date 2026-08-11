---
name: Spain impit TLS session reuse
description: Diagnostic et fix du 0B citaconsular.es — architecture CapSolver+impit validée.
---

## Conclusion (confirmée par test live 2026-08-10)

**CF lie `cf_clearance` à l'IP proxy, PAS au fingerprint TLS.** Une nouvelle instance impit
avec le même proxy IP + cf_clearance CapSolver → 200 JSONP (817 chars, pas 0B).
La "TLS mismatch" était une fausse piste.

## Vraie cause du 0B

Le champ `html` envoyé à `AntiCloudflareTask` causait `ERROR_INVALID_TASK_DATA`
→ CapSolver ne retournait jamais de cookie → cf_clearance absent → 0B.

**Fix appliqué :** supprimer `html` + `userAgent` du payload `createTask`.
CapSolver fetche la page lui-même via notre proxy et exécute le JS du challenge
interactif (`cType: 'interactive'`) dans son propre Chrome. Résolution en ~17s.

## Architecture validée (hybride CapSolver + impit)

1. Probe impit direct → si IP de confiance CF → session directe, probeImpit stocké dans `_spainImpit`
2. Si CF challenge `cType: 'interactive'` → `AntiCloudflareTask` SANS champ `html` → cf_clearance ~17s
3. impit (n'importe quelle instance) + même proxy IP + cf_clearance → JSONP OK

**Why:** CF valide sur l'IP (+ cookie), pas sur le fingerprint TLS de la connexion.
N'importe quelle instance impit avec le même proxy passe.

## Ce que `solveViaImpit` couvre (et ne couvre PAS)

- JSD challenge (`__CF$cv$params`) → JSDSolver ✅
- Turnstile Managed (sitekey extractable) → AntiTurnstileTaskProxyLess + POST via impit ✅
- `cType: 'interactive'` sans sitekey Turnstile → **ne peut pas** (aucun widget à résoudre)
  → utiliser `AntiCloudflareTask` à la place

## Fichiers concernés

- `spain-soax-solver.ts` : `solveSpainCloudflare()` (pas de champ `html`),
  `ensureSpainCfSession()` (probeImpit stocké après accès direct)
- `spain-impit-session.ts` : `solveViaImpit()` pour JSD/Turnstile uniquement
- `scripts/test-spain-impit-tls.ts` : script de diagnostic complet (probe → CapSolver → JSONP)
