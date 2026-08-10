---
name: CapSolver Decodo CF solve
description: CapSolver AntiCloudflareTask fonctionne pour citaconsular.es AVEC le champ html — résultat vérifié empiriquement.
---

## Résultat confirmé

`AntiCloudflareTask` + champ `html` (HTML du challenge CF, tronqué à 32KB) → `cf_clearance` accepté par impit sur la même IP Decodo proxy.

**Pourquoi le champ `html` est obligatoire :** Le challenge est `cType: interactive` (pas JSD/Turnstile). CapSolver a besoin du HTML complet du challenge pour simuler la résolution. Sans `html`, CapSolver ne peut pas résoudre le challenge interactif.

## Ancienne note incorrecte corrigée

L'ancienne note "⚠️ NE PAS envoyer html → ERROR_INVALID_TASK_DATA" était FAUSSE. C'était un test antérieur avec des params incorrects. Avec les bons params + `html`, ça fonctionne.

## Paramètres corrects

```typescript
{
  type: "AntiCloudflareTask",
  websiteURL: portalUrl,
  proxy: "http://user:pass@host:port",   // même proxy Decodo que l'impit probe
  userAgent: UA,                          // même UA que l'impit probe
  html: challengeHtml.slice(0, 32_000),  // HTML de la page 403
}
```

## Temps de solve

~30-40s (1-2 polls à 5s chacun) pour citaconsular.es en pratique.

## Utilisation optimale avec Puppeteer

1. Probe impit → CF HTML
2. CapSolver solve → cf_clearance (~30s)
3. Puppeteer.launch() avec --proxy-server=decodo (en parallèle du solve)
4. Après solve : page.setCookie(cf_clearance pour .citaconsular.es)
5. page.reload() → CF bypassé immédiatement
6. → Réduit le temps total CF de ~130s (JSD naturel) à ~40s

**Why:** Le cf_clearance CapSolver est lié à l'IP du proxy. Puppeteer DOIT utiliser le même proxy Decodo pour que le cookie soit accepté.
