# CEV Dossier Loop — Retry immédiat sur timeout/503/504

## Date : 2026-08-11

## Tickets à traiter

### 1. Retry immédiat sur timeout/503/504
**Problème** : Quand la `redirectProbe` échoue avec un timeout ou 503/504,
le système attend le prochain cycle (120s) au lieu de retenter immédiatement.

**Fix** : Au lieu d'abandonner, passer immédiatement au dossier suivant du pool
et ajuster le timing du cycle.

### 2. Supprimer Capsolver du fallback hCaptcha CEV
**Problème** : Capsolver ne supporte PAS le hCaptcha CEV (sitekey `5f64399c-14a8-415e-ad1a-7ebccdc4943a` blacklistée).
L'erreur `ERROR_INVALID_TASK_DATA: We don't support this service` est attendue et gaspille du temps.

**Fix** : Dans le code de résolution hCaptcha CEV, ne PAS appeler Capsolver comme fallback.
Utiliser UNIQUEMENT AntiCaptcha (qui fonctionne pour cette sitekey).
Si AntiCaptcha timeout → retenter AntiCaptcha, pas Capsolver.

## Problème
Quand la `redirectProbe` dans `cevHttpSetup.ts` échoue avec un timeout ou un code 503/504,
le système attend le prochain cycle de polling (120s) au lieu de retenter immédiatement.

## Fix demandé
Au lieu d'abandonner et attendre le prochain cycle :
1. Retenter **immédiatement** avec le **dossier suivant** du pool (round-robin)
2. Ajuster le timing du cycle suivant pour compenser le décalage

## Fichiers à modifier
- `src/loops/cev-dossier-loop.ts` — boucle principale round-robin
- `src/cevHttpSetup.ts` — catch de la probe (ligne ~1184)

## Logique actuelle (dans cevHttpSetup.ts ligne ~1184)
```typescript
} catch (probeErr) {
  // En cas d'échec réseau, retourner la session brute — le polling déterminera l'état
  return {
    success: true,
    sessionCookie: cevSessionCookie,
    slotsAvailable: false,  // ← le polling conclut "pas de slots" et attend
  };
}
```

## Fix proposé
Dans `cev-dossier-loop.ts`, après le check d'un dossier qui retourne une erreur timeout/503/504 :
1. Ne PAS sleep le `cev_dossier_interval_sec` normal
2. Passer IMMÉDIATEMENT au dossier suivant du pool
3. Après le retry réussi, recalculer le sleep pour re-synchroniser le cycle

## Comment détecter le timeout/503/504
- La probe retourne `success: true` mais `slotsAvailable: false` ET le log contient `cev_http_redirect_probe_error`
- OU la probe throw une erreur (catch dans le loop)
- OU le résultat a `error` contenant "TIMEOUT" / "aborted" / "504" / "503"

## Comportement attendu
```
Cycle normal : Dossier A → (120s) → Dossier B → (120s) → Dossier C
Avec retry   : Dossier A → TIMEOUT → Dossier B (immédiat) → (ajuster sleep) → Dossier C
```
