# Spain — Publication créneaux 2026-08-13 à 01h13 UTC

## Contexte

Publication de créneaux détectée à **2026-08-13 00:13 UTC** (01h13 heure locale).
Logs capturés AVANT correction des bugs. Corrections appliquées par l'utilisateur ensuite.
Nouvelle apparition des mêmes créneaux signalée à **12h13** — bugs différents (à diagnostiquer).

---

## Déroulement observé à 01h13

### Phase 1 — Détection widget
- `main/` retourne 120 647 chars
- Widget state détecté : `service-state` (services/accept flow visible)
- Signaux serveur : `isSpa=true | serviceContainer=true | dialogConfirm=true | serviceLinks=false | templates=true`
- Verdict : **SPA dialog-confirm dans `idBktDefaultServicesTextBeforeServicesList`** → créneaux potentiels, `datetime/` obligatoire

### Phase 2 — Vérification via datetime/ (custom-dialog Aceptar)
- Fallback `getservices/ JSONP` déclenché (aucun `#selectservice` rendu côté client)
- `getwidgetconfigurations/` → HTTP 200 | 364B | `captcha=0 reg_type=2 waiting=0`
- `getservices/` → **2 services** :
  - `bkt1181796` — `<span style='display:none'>` (service masqué)
  - `bkt1181774` — **"TRAMITACIÓN DE VISADOS"** ← service priorisé
- `getagendas/` → agenda **bkt391787**
- `datetime/` 2026-08-01→08-31 → HTTP 200 | 81B | `Slots:[] maxDays:2026-08-13` → ignoré (maxDays ≤ aujourd'hui)
- `datetime/` 2026-09-01→09-30 → HTTP 200 | **2036B** → **14 créneaux** :
  - Jours dispo: 01, 02, 07, 08, 09, 14, 15, 16, 21, 22, 23, 28, 29, 30 septembre
  - Heure affichée : `09:00` (times=[] state=1 — heure synthétisée côté bot)
  - maxDays extrait : 2026-09-18
- `datetime/` 2026-10-01 → stop (> maxDays 2026-09-18)

### Phase 3 — Résultat
- `confirmSlotsViaDatetime` → ✅ **"TRAMITACIÓN DE VISADOS" — 2026-09-01 09:00** (14 créneaux sur 2 mois)
- SPAIN-WATCHER rapporte : `found`

### Problème détecté dans ces logs
```
[SPAIN-WATCHER] ⚠️ FAUX POSITIF PROBABLE — 'No hay horas' masqué
MAIS aucun service rendu (0 liens #selectservice dans le HTML)
[SPAIN-WATCHER] ⏭️ MUNUA LUBUNGU SARDONYX: créneau 2026-09-23
avant slotDateFrom 2026-10-10 — skip
```
- Le watcher déclare un faux positif malgré `datetime/` confirmé → **bug de validation**
- Le créneau 2026-09-23 est skipé car avant `slotDateFrom 2026-10-10` → **filtre trop restrictif**

---

## Points techniques clés

| Élément | Valeur |
|---------|--------|
| Public key | `25028fcd7126544630b8da0c6e60722b5` |
| Service visas | `bkt1181774` |
| Agenda | `bkt391787` |
| jQuery callback | `jQuery211091786579821344_864785762` |
| maxDays septembre | `2026-09-18` |
| Créneaux septembre | 14 (state=1, times=[]) |
| Premier créneau | 2026-09-01 09:00 |

---

## Bugs identifiés (avant correction)

1. **Faux positif probe** : watcher rejette un `found` valide car `0 liens #selectservice` dans HTML — la validation SPA n'acceptait pas le chemin custom-dialog/datetime uniquement
2. **Filtre slotDateFrom trop strict** : les créneaux avant `slotDateFrom` étaient skippés même s'ils étaient réels

---

## Publication 12h13 — Diagnostic complet

### Symptôme résumé
Créneaux publiés, `getagendas/` retourne `bkt391787` (166B) dans certaines requêtes,
`datetime/` retourne **0B** (body vide) sur toutes les requêtes → système conclut `not_found`.

### Root cause identifiée : `getagendas/` retourne 0B → datetime/ appelé sans agenda

La séquence correcte est :
```
getservices/ → agenda depuis Agendas[] ou getagendas/ → datetime/?agendas[]=bkt391787
```

Quand `getagendas/` retourne **0B** (réponse vide), le code continue quand même et appelle
`datetime/` **sans le paramètre `agendas[]`**. On voit dans les logs :
```
datetime params → agenda=<none>   ← agenda absent de la requête
datetime/ → HTTP 200 | 0B         ← serveur renvoie vide sans agenda
```
Alors qu'avec agenda présent :
```
datetime params → agenda=bkt391787
datetime/ → HTTP 200 | 81B ou 2036B  ← réponse réelle
```

**Le serveur Bookitit requiert `agendas[]` pour retourner des données. Sans ce paramètre, il retourne 0B.**

### Cause secondaire : `getservices/` retourne 0B intermittent

Sur certains cycles (11:02:39), `getservices/` retourne HTTP 200 | 0B :
```
⚠️ getservices/ fallback → body vide (HTTP 200)
ℹ️ getservices/ vide (HTTP-ONLY) + signal négatif embarqué → not_found
```
Le système abandonne immédiatement sans retenter. `getservices/` peut être flaky sous charge
(publication de créneaux = serveur saturé). Il faudrait retenter au lieu d'abandonner.

### Problème de concurrence / désordre des logs

À 11:13:27, on voit clairement la séquence désordonnée :
1. `getwidgetconfigurations/` lancé (callback `_460571822`)
2. `main/` retourné → Phase 2 déclenchée
3. `getwidgetconfigurations/` retourné (résultat de l'appel précédent, callback `_460571822`)
4. `getservices/` → **0B** → abandon
5. Mais `getagendas/` retourne `bkt391787` (166B) — résultat d'un appel d'un cycle précédent
6. `datetime/` avec agenda → **81B** → mais logique déjà en `not_found` (Phase 3 déjà décidée)

Le warm cache est armé avec `bkt391787` mais **trop tard** — la décision `not_found` est déjà prise.

Ensuite le warm cache est réutilisé mais `datetime/` retourne 0B à chaud → cache invalidé → re-scan à froid → même problème.

### Séquence problématique détaillée

```
Cycle N-1 (11:02:39) :
  getservices/ → 0B → ABANDON IMMÉDIAT → not_found
  (getagendas/ pas appelé)

Cycle N (11:03:17) :
  getservices/ → OK (2 services)  
  getagendas/ → 0B  ← VIDE
  datetime/?agenda=<none> → 0B  ← serveur ne répond pas sans agenda
  → not_found

Cycle N+1 (11:03:27) :
  [getwidgetconfigurations lancé en parallèle ou avant main/]
  getservices/ → 0B → abandon
  [mais getagendas du cycle précédent retourne 166B = bkt391787]
  → datetime avec agenda → 81B MAIS Phase 3 déjà décidée
  → not_found

Cycle 11:13:29 (warm cache) :
  Cache bkt391787 → datetime/ → 0B (session périmée)
  Cache invalidé → re-scan à froid
  getservices/ → OK, getagendas → 0B → datetime sans agenda → 0B
  → not_found
```

### Fixes nécessaires

#### Fix 1 — `getagendas/ 0B` → ne pas appeler datetime/ sans agenda
```
Si getagendas/ retourne 0B ET que getservices/ ne contient pas d'Agendas[] :
  → RETRY getagendas/ (2-3 tentatives, backoff 500ms)
  → Si toujours 0B après retry → not_found (pas datetime/ sans agenda)
```
**Raisonnement** : `datetime/` sans `agendas[]` retourne toujours vide. C'est un appel inutile
qui consomme du budget CF et donne une fausse impression de "mois vide".

#### Fix 2 — `getservices/ 0B` → retry avant abandon
```
Si getservices/ retourne 0B :
  → RETRY 2-3x (backoff 300ms)
  → Si toujours vide → fallback Agendas[] depuis warm cache si disponible
  → Sinon not_found
```

#### Fix 3 — `AllowAppointment=false` ne doit pas bloquer
Dans les logs : `getservices/ AllowAppointment = false`.
Le système continue quand même (correct), mais vérifier que ce flag n'impacte pas
la logique en aval sur certains chemins de code.

#### Fix 4 — Désordre execution / logs entremêlés
Les logs montrent des callbacks différents (`_460571822` vs `_691172347`) entremêlés.
Cela indique que plusieurs invocations de `confirmSlotsViaDatetime` tournent en parallèle
ou que des Promises se résolvent dans le désordre. Il faut s'assurer que la logique
est **séquentielle** ou que les résultats tardifs (getagendas d'un cycle antérieur)
ne polluent pas le cycle courant.

### Comparaison 01h13 (succès) vs 12h13 (échec)

| Élément | 01h13 ✅ | 12h13 ❌ |
|---------|---------|---------|
| `getservices/` | OK | **0B intermittent** |
| `getagendas/` | 166B → bkt391787 | **0B intermittent** |
| `agendas[]` dans datetime/ | ✅ présent | ❌ absent (quand getagendas 0B) |
| `datetime/` response | 2036B (14 slots) | **0B** (sans agenda) |
| `dialogConfirm` dans main/ | `true` | `false` |
| `serviceContainer` | `true` | `false` |
| Résultat | `found` ✅ | `not_found` ❌ |

Note : `dialogConfirm=false` à 12h13 — le portail avait peut-être déjà traité certains users
(Aceptar cliqué côté serveur), ce qui change le rendu HTML de `/main/`.

### Conclusion corrigée (après analyse code)

Les créneaux de septembre étaient **réellement vides à 12h13** (`Slots:[]`) — pris depuis la publication de 01h13.
Le `⛔ datetime/ vide` à 11:13 est donc exact sur le fond : plus de créneaux disponibles.

**MAIS** les cycles de 11:02 et 11:03 ont gâché des secondes précieuses à cause de deux bugs :

### Bug A — `getagendas/ 0B` → `datetime/` sans `agendas[]` (ligne 1438 + 1530 de spain-http-scanner.ts)
```ts
if (agRaw.length > 0) {
  agendaId = ids[0] ?? "";  // ← reste "" si getagendas/ retourne 0B
}
// Ensuite :
if (agendaId) dtQ.append("agendas[]", agendaId);  // ← non ajouté → serveur retourne 0B
```
Pas de retry. Résultat : datetime/ appelé sans agenda → 0B → 3 mois vides → `not_found`.
Le serveur requiert `agendas[]` pour répondre. Sans ce paramètre, il retourne toujours 0B.
→ **Fix : retry getagendas/ 2-3x avec backoff 500ms si 0B.**

### Bug B — `getservices/ 0B` → `not_found` immédiat (ligne 1256)
Sur le cycle 11:02:39, `getservices/` retourne 0B ET le HTML contient `bkt_init_widget.dates=[]`
ou `hidden NoSlots` → `return null` immédiat. Pas de retry.
→ **Fix : retry getservices/ 2-3x avant de conclure not_found.**

### Bug C — Companions fire-and-forget interférant avec le cycle suivant (~ligne 2770)
Des appels `getwidgetconfigurations/ + getservices/` lancés en arrière-plan après le probe
utilisent le même PHPSESSID et peuvent "consommer" la session avant le cycle suivant.
→ **Fix : attendre la completion des companions OU ne pas les lancer si un créneau est en cours de traitement.**

### Impact réel
Les créneaux étaient déjà épuisés à 12h13 — le système aurait quand même conclu `not_found`.
Mais les bugs A et B ont retardé le constat d'environ 2-3 cycles × 6s = ~12-18 secondes
pendant la fenêtre critique (11:02–11:03). Si des créneaux avaient encore été disponibles
à ce moment, ces secondes perdues auraient pu coûter le booking.

### Fichiers concernés
- `src/spain-http-scanner.ts` : lignes ~1231-1258 (Bug B), ~1435-1441 (Bug A), ~1530 (Bug A)
- `src/spain-http-scanner.ts` : ~ligne 2770 (Bug C companions)
