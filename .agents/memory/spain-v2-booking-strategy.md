# Spain V2 Booking Strategy — "Bataillon organisé"

## Contexte
- 1 publication par jour (heure non fixe, observé parfois à 1h ou 12h mais rare)
- Durée de vie des slots : ~66s (bots concurrents)
- 13 workers, mais max 4-5 signin/ simultanés avant rate-limit (0B)
- Bookitit rate-limite au-delà de 5 requêtes signin/ simultanées
- Pas besoin de tout booker le même jour : 5/jour × 7j = 35 bookings/semaine

## Architecture

### Principe fondamental : sémaphore Redis
- `spain:booking:armed_count` = nombre de workers en booking RIGHT NOW
- Constante `MAX_CONCURRENT_BOOKERS = 5`
- Un worker ne tente le booking QUE SI `armed_count < MAX_CONCURRENT_BOOKERS`
- Après booking (succès ou échec credentials) → `armed_count--`

### Rôles dynamiques (pas d'attribution statique)
- **Armé** : worker qui a détecté des slots ET `armed_count < 5` → tente le booking
- **En attente** : worker qui a détecté des slots MAIS `armed_count >= 5` → scan rapide 2-3s
- La transition est AUTOMATIQUE : dès qu'une place se libère, le prochain qui scanne entre

### Phases

1. **Scan normal** (cycle 10s) : tous les workers scannent en continu
   - CF cache chaud (pre-pub refresh min 11)
   - Tous ont leur datetime/ frais

2. **Détection** : un worker voit des slots dans datetime/
   - Check Redis : `armed_count < 5` ?
   - OUI → `armed_count++`, tente le booking
   - NON → passe en scan rapide (2-3s) — cycle complet (main → cfg → svc → ag → datetime/) mais intervalle réduit

3. **Scan rapide** (cycle 2-3s) pour les workers en attente :
   - Cycle complet refreshSessionAndScan (GET widget → POST → main → cfg → svc → ag → datetime/)
   - Objectif : maintenir datetime/ frais (savoir quels slots restent)
   - Check `armed_count < 5` à chaque cycle → si oui, entre en booking
   - Ne fait PAS getsigninfields/signin/ → pas de surcharge serveur sur l'endpoint rate-limité

4. **Remplacement naturel** :
   - Worker A booke → `armed_count--` → Worker B (en scan rapide) voit la place libre → entre en booking
   - Worker C credentials mort → `armed_count--` → même chose
   - Temps de remplacement : 2-3s (le scan rapide du worker en attente)
   - **Toujours 5 en booking, la file se vide au fur et à mesure**

5. **Fin** : un worker détecte datetime/ VIDE après avoir précédemment vu des slots
   - C'est le signal que les créneaux sont partis (bookés par nous ou les concurrents)
   - Signal Redis `spain:slots_found_today` = timestamp
   - Tous les workers passent en repos journalier (jusqu'au lendemain)

## Rythme de scan adaptatif (fenêtre HH:05 → HH:20)

### Fréquence par phase (dans chaque fenêtre horaire)
```
HH:05 → HH:10 : 60s/scan   (warm-up, init PHP, CF cache chaud)
HH:10 → détection : 10s/scan (scan normal, détection active)
Détection slots dans datetime/ :
  - Workers armés (≤5) : booking immédiat (getsigninfields/ → signin/ → summary/)
  - Workers en attente : 2-3s/scan (cycle complet sans booking, attente de place libre)
Premier datetime/ VIDE après détection : FIN → repos journalier
```

### Le 2-3s ne se déclenche PAS à une heure fixe
- Il est déclenché par la **détection de slots dans datetime/** (événement)
- Seuls les workers en attente (armed >= 5) passent en 2-3s
- Les workers armés ne scannent pas — ils bookent directement

### Repos après détection

Le cycle de scan est continu : chaque heure, fenêtre HH:05 → HH:20.
Il n'y a pas de "fin de journée" — les workers scannent 24h/24 tant qu'aucun slot n'est détecté.

La seule règle de sommeil prolongé :
- **Slots détectés AVANT 22:05 UTC** (ex: 05:13, 12:05, 15:10…) :
  → Finir le booking en cours → datetime/ vide
  → **Sommeil jusqu'à 22:05 UTC** (la publication du jour a eu lieu)
  → À 22:05, le cycle normal reprend (22:05 scan, 23:05 scan, 00:05 scan…)

- **Slots détectés À PARTIR DE 22:05 UTC** (ex: 22:12, 23:08…) :
  → Finir le booking en cours → datetime/ vide
  → **Sommeil normal** jusqu'au prochain cycle (= comportement actuel)
  → Le prochain cycle est HH+1:05 (ex: 22:12 → dort → 23:05)

- **Aucun slot détecté** :
  → Continuer le cycle normal indéfiniment (HH:05 → HH:20 chaque heure)

### Signaux Redis
- `spain:booking:armed_count` → INCR/DECR atomique (sémaphore, TTL 90s auto-reset si crash)
- `spain:slots_found_today` → timestamp de la détection (posé quand datetime/ vide après booking)
  - Si posé ET heure UTC actuelle < 22:05 → sommeil jusqu'à 22:05
  - Si posé ET heure UTC actuelle >= 22:05 → sommeil normal (prochain cycle HH+1:05)
  - Pas de reset explicite : le sommeil "avant 22:05" suffit car les cycles reprennent naturellement à 22:05

### Calcul optimal
```
CF cache = 2s pour init (pas de solve)
Booking complet = gsf(1.5s) + signin(2s) + summary(2s) = 5.5s

5 workers en booking parallèle, remplacement en 2-3s :
- Worker 1 booke à T+5.5s → sort → remplacé à T+8s
- Worker 6 (remplaçant) booke à T+13.5s → sort → remplacé à T+16s
- etc.

En 66s avec remplacement continu :
  ~10 bookings séquentiels par "slot" de sémaphore
  × 5 slots parallèles = 50 tentatives
  Rendement réaliste : 5-10 bookings/jour (selon concurrence)
```

### Changements requis pour implémentation
1. `spain-redis-persistence.ts` :
   - `tryAcquireBookingSlot(dossierId)` → INCR + check < 5
   - `releaseBookingSlot(dossierId)` → DECR
   - `setSlotFoundToday()` → posé quand datetime/ vide après détection
   - `shouldSleepUntil2205()` → true si posé ET heure UTC < 22:05
   
2. `spain-dossier-worker.ts` :
   - Rythme adaptatif : 60s (HH:05→HH:10), 10s (HH:10→détection), 2-3s (après détection, workers en attente)
   - Avant booking : `if (!await tryAcquireBookingSlot(id)) { scanRapide 2-3s; continue; }`
   - Après booking (succès/échec) : `releaseBookingSlot(id)`
   - Détection datetime/ vide après avoir vu des slots → `setSlotFoundToday()`
   - Si heure < 22:05 → sommeil prolongé jusqu'à 22:05
   - Si heure >= 22:05 → sommeil normal (prochain cycle HH+1:05, comportement actuel)

3. Pas de changement à l'orchestrateur — la coordination est 100% Redis + worker-level

### Avantages vs V1
| | V1 (actuel) | V2 (sémaphore) |
|---|---|---|
| Workers en booking | tous (13) | max 5 |
| Surcharge serveur | 0B fréquents | rare (5 signin/ max) |
| Temps de remplacement | N/A (pas de remplacement) | 2-3s |
| Bookings/jour | 0-5 (variable) | 5-10 (stable) |
| Credentials mort | bloque 1 slot 9s+ | libère en 2s |
| Scan hors détection | 10s fixe | 60s warm-up → 10s → 2-3s réactif |
| Repos après booking | continue de scanner inutilement | sommeil jusqu'à 22:05 (journée) ou continu (nuit) |
