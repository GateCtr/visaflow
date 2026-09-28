# Logs prod Spain meute — burst 2026-11-03 (capturés 2026-09-28 07:13–07:16 UTC)

Portail : citaconsular.es (services bkt1181774 / agenda bkt391787) — Kinshasa.
Mode : meute (1 éclaireur + 2 meute), fenêtre publication -12min.
Snapshot burst : **13 créneaux 2026-11-03 (08:30 → …), 25 places, freeSlots=2/créneau**.

## 1. Résumé exécutif

Le burst 07:13 a été détecté par l'éclaireur **Global Vas VIP 1** (Cycle 101, scan=found,
2026-11 = 13 créneaux, maxDays=2026-11-03) et publié en snapshot Redis. Réveil BURST pubsub
(~3.9s) des 3 workers meute.

**3 bookings réussis** (state=1, locator absent = comportement Kinshasa) :

| Dossier (worker)        | Créneau        | Client                | Durée détection→booked |
|-------------------------|----------------|-----------------------|------------------------|
| Global Vas VIP 1 (j5733c3g) | 2026-11-03 08:30 | NGANGA MOSANDA RALLY  | ~12s (07:13:15 → 07:13:26) |
| Global VAS VIP 2 (j57ac4kv)  | 2026-11-03 09:15 | MUNDONGI SALY RODIN   | ~11s (07:13:15 → 07:13:27) |
| Global vas vip 7 (j575r67v)  | 2026-11-03 09:00 | ATOLAKI LODI ANTHO    | ~12s (07:13:15 → 07:13:27) |

**1 dossier en ÉCHEC RÉPÉTÉ** : **Christian madada** (j57459fnnd9sxcg4efedbmfzzn8dyb97).

## 2. Anomalie principale — Christian madada : signin/ → réponse vide (0B) en boucle

### Chronologie
- 07:13:12 Cycle 103 : snapshot vide → not_found (attente burst).
- 07:13:15.940 réveil BURST → snapshot lu 13 créneaux.
- 07:13:17.003 **🐺 GET widget → CF challenge (HTTP 403) → abandon meute → repli scan normal**.
- 07:13:17.271 **shortscan GET widget → CF challenge (HTTP 403) → cf_expired**.
- 07:13:17–07:13:54 **re-solve CF via CapSolver (37s !)** — cf_clearance restaurée depuis Redis
  d'abord (mais invalide HTTP 403), puis re-solve CapSolver complet (`/main/` → 126294B session prête).
- 07:13:54.342 CF re-résolu (37069ms) → reprise scan.
- À partir de 07:13:58 (Cycle 105) et **jusqu'à 07:16:11+ (Cycle 125)** :
  boucle identique répétée ~20 fois :
  1. snapshot lu 13 créneaux → SAUT datetime/
  2. `getsigninfields/ (armement) → 0B` (normal en meute, pas de datetime/)
  3. signin/ tenté directement sur le créneau du snapshot (08:45)
  4. **`RESPONSE signin/ HTTP=200 raw=0B shape=empty` → `❌ signin/ échoué: réponse vide`**
  5. `Booking: signin_failed` → refresh + rescan immédiat nouveau PHPSESSID
  6. retour étape 1 (boucle infinie tant que le snapshot reste chaud)

### Observations clés
- Le créneau visé par Christian madada est **toujours 2026-11-03 08:45** (le premier libre
  du snapshot après que 08:30/09:00/09:15 aient été pris par les 3 autres).
- `getsigninfields/` renvoie **0B** systématiquement (contentType text/html, shape=empty),
  alors que pour VIP 1 (qui a réussi) `getsigninfields/` a renvoyé **13785B** (parsed, CustomFields).
- `signin/` renvoie **0B** systématiquement → jamais de bktToken → jamais de summary/.
- Les 3 workers qui ont RÉUSSI : leur `getsigninfields/` était aussi 0B (VIP 2, vip 7) SAUF
  VIP 1 (13785B). Mais leur `signin/` a renvoyé un **Client{bktToken}** valide (168B),
  PUIS summary/ → Event state=1. → Le 0B sur getsigninfields n'est PAS bloquant en soi.
- Différence Christian madada : **signin/ 0B** (pas juste getsigninfields 0B).

### Hypothèses de cause racine (à confirmer)
1. **Créneau 08:45 déjà consommé / capacité épuisée côté serveur** : les 3 premiers ont pris
   08:30/09:00/09:15 ; 08:45 pourrait être verrouillé/plein alors que le snapshot Redis
   (âge 0-37s) l'affiche encore comme freeSlots=2. → signin/ 0B = rejet silencieux du serveur.
2. **Le worker retente toujours le MÊME horaire (08:45)** au lieu de tourner sur un autre
   créneau du snapshot → si 08:45 est mort, il boucle indéfiniment.
3. **CF/PHPSESSID désynchronisé après le re-solve de 37s** : le cf_clearance re-résolu
   (fp=1db58b7e) pourrait être lié à une TLS/UA différente de celle du booking → signin rejeté.
4. **gct (hCaptcha token) consommé mais session booking déjà brûlée** : le log dit
   « session booking consommée » à chaque signin vide → chaque tentative crame un PHPSESSID
   + potentiellement un token hCaptcha (gaspillage prewarm visible : réserve 1→2→3).

### Coût observé (gaspillage)
- ~20 cycles signin vides entre 07:13:58 et 07:16:11 (2min13).
- Multiples solves hCaptcha NoneCap consommés (prewarm réserve montée jusqu'à 3) pour un dossier
  qui n'aboutit jamais.
- 1 re-solve CapSolver CF complet de 37s.

## 3. Points positifs confirmés

- **Réveil BURST pubsub fonctionne** : 3.9s entre publication éclaireur et lecture snapshot meute.
- **RACE par capacité** : 25 places ≥ 5 → bypass sémaphore → booking immédiat sans collision.
- **3/4 dossiers bookés en ~12s** chacun.
- **Gagnants enregistrés Redis** (`🏆 Gagnant booking enregistré`) pour les 3 réussis.
- **Report Convex OK** pour les 3 (`✅ Booking reporté Convex`).
- **Orchestrateur** : workers bookés retirés de Convex + cooldown 5min, meute recomptée
  (2→1→0 meute à mesure des succès).

## 4. Questions ouvertes pour l'analyse

1. Pourquoi Christian madada reste bloqué sur 08:45 et ne tente pas 08:30/09:00/09:15/autres ?
   (Est-ce parce que ceux-ci sont pris et 08:45 est le "premier libre" recalculé à chaque rescan ?)
2. `signin/ 0B` = faut-il traiter ce cas comme « créneau mort » et **exclure cet horaire**
   du snapshot local pour passer au suivant, plutôt que rescan → même horaire ?
3. Le re-solve CF de 37s a-t-il fait rater à Christian madada la fenêtre où d'autres créneaux
   étaient encore libres (il n'a repris qu'à 07:13:54, après que les 3 autres aient booké) ?
4. Faut-il un **compteur d'échecs signin/ 0B consécutifs** par worker → abandon/backoff au lieu
   de boucle serrée (économie captcha + PHPSESSID) ?

---
*Fichier généré pour analyse. Logs bruts fournis par l'utilisateur (session prod Railway).*
