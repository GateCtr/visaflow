# Logs prod Spain — mode meute/éclaireur — 2026-09-27 ~19:13 UTC

Portail : Kinshasa (service bkt1181774, agenda bkt391787). 7 dossiers Convex,
mode meute actif (`SPAIN_MEUTE_MODE=1`, `SPAIN_ECLAIREUR_SHORTSCAN=1`), Redis ok.
Rôles : 1 éclaireur (**Global Vas VIP 1**) + 6 meute (Christian madada, Enock NTETE
MBUNGU, Global vas vip 3/5/7, Global VAS VIP 2).

Fenêtre observée : `-12min` → `-11min` (avant l'heure de publication). Un burst de
**2 créneaux** (2026-11-02 08:45 et 10:45, freeSlots=1 chacun) apparaît vers 19:13:08.

---

## Déroulé brut (extrait analysé)

### T=19:13:00 — cycles à vide
- Meute : `🐺 snapshot vide → not_found (attente prochain burst)` — normal, pas encore de créneau.
- Éclaireur (Global Vas VIP 1) : shortscan `GET widget → datetime/ direct`, `hCaptcha requis (portail connu=true, main=false)`, datetime 0B → `not_found`.

### T=19:13:08.9 — ÉCLAIREUR détecte le burst
- `datetime 2026-11: 2 créneau(x) | maxDays=2026-11-02` → `scan=found`.
- `👁️ slotEverSeen=true`.
- `🏁 MODE RACE activé (2 créneau(x) ≤ 5) — pas de lock Redis, tous les workers foncent`.
- `🏁 RACE snapshot frais (0s) — 2 places < 5 → respect du sémaphore`
- `🏁 MODE RACE — sémaphore bypassé sans condition → booking immédiat` (⚠️ messages contradictoires : "respect du sémaphore" puis "sémaphore bypassé sans condition" — À ANALYSER)
- getsigninfields/ **13739B ✅** (éclaireur, session shortscan complète).
- signin/ (2026-11-02 08:45, freeSlots=1) → **raw=0B → "signin/ → réponse vide"** → échec.
- L'éclaireur : `🔄 signin/ → réponse vide — session booking consommée, abandon du snapshot et refresh + scan`.

### T=19:13:12+ — MEUTE réveillée par le snapshot
- Les 6 meute : `🐺 snapshot lu : 2 créneau(x) (âge 3s) — SAUT de datetime/` → scan=found.
- Chacune : MODE RACE → getsigninfields/ (armement) → **0B** systématiquement côté meute :
  `🔑 getsigninfields/ (armement) → 0B ⚠️ 0B` + `🚫 armement getsigninfields/ toujours 0B après 2 cycle(s)`.
- MAIS signin/ tenté quand même (canAttemptSignin meute=true), avec gct pré-résolu ou à chaud.

### RÉSULTATS signin/ meute (créneaux freeSlots=1, comptes réels) :
- **Global vas vip 5** (08:45) : signin/ → `bktToken` OK (BUKI ADIMWA ISAAC) → **summary/ state=1 → ✅ BOOKED** 2026-11-02 08:45.
- **Global vas vip 3** (10:45) : signin/ → `bktToken` OK (KABAKU A NTUMBA BOB) → **summary/ state=1 → ✅ BOOKED** 2026-11-02 10:45.
- **Enock NTETE MBUNGU** (08:45) : signin/ → **236B "Usuario o contraseña incorrectos"** → error credentials → worker arrêté.
- **Christian madada** (08:45 puis 10:45) : signin/ → **0B "réponse vide"** répété → rescan en boucle (Cycle 97→98→99→100…).
- **Global vas vip 7** (10:45) : signin/ → **0B "réponse vide"** → rescan.
- **Global VAS VIP 2** (10:45) : getsigninfields 0B, booking en cours (résultat non visible dans l'extrait).
- **Global Vas VIP 1** (éclaireur, 08:45) : signin/ 0B → rescan → datetime 0B → `🔎 0B contredit par un burst peer récent → anomalie proxy/session` → `🔄 Burst peer confirmé — rotation IP immédiate` → `proxy_error #1 — rotation IP + réinit` → blacklist IP + re-solve CF.

---

## BILAN DE CE BURST
- **2 créneaux disponibles (freeSlots=1 chacun) → 2 BOOKINGS RÉELS réussis** (vip 5 → 08:45, vip 3 → 10:45). ✅ Le système A RÉSERVÉ 2 vrais RDV.
- Les autres workers sur les mêmes 2 créneaux : signin/ 0B (créneau déjà pris = comportement serveur attendu quand la place est consommée) ou credentials invalides (Enock).
- **2 places pour 6 meute + 1 éclaireur → seuls 2 peuvent gagner** : cohérent avec freeSlots=1×2.

---

## STATUT DES CORRECTIFS (2026-09-27, session d'analyse)

- ✅ **#1 reportSlotFound 400** : `location` vide (meute, serviceName="") → `||` au lieu de `??` +
  message d'erreur Convex dynamique (http.ts). Le booking remonte enfin à Convex.
- ✅ **#2 peers gaspillent sur créneau booké** : nouvelle `isSlotAlreadyBooked` (lecture du
  registre gagnant Redis) + garde en tête de boucle booking (même en RACE). Coupe les rescans
  tardifs (Christian madada Cycle 97→100).
- ✅ **#3 messages RACE contradictoires** : clarifié — `attemptBookingRace` logge la décision
  CAPACITÉ (distincte du MODE RACE). Cosmétique.
- ✅ **#4 éclaireur ne booke pas (0B)** : cause racine = `scanDatetimeDirect` ne propageait pas
  `captchaRequired` → captchaNeeded=false → signin/ sans gct → 0B Kinshasa. Fixé + garde
  "pas de signin/ sans gct" + prewarm 20s→7s + réserve base 1→2.
- ✅ **#5 message meute trompeur** : "on n'insiste pas" alors qu'on insiste → message distinct meute.
- ✅ **#6 rotation IP + blacklist faux positif** : `lastOwnFoundAtMs` — si CE worker a vu un found
  < 20s avant le 0B, c'est "créneaux consommés" pas "proxy mort" → pas de rotation/blacklist.
- ✅ **#7 Enock credentials invalides** : déjà géré correctement (arrêt immédiat + reportBookingLog
  admin avec raison). Pas de bug — comportement attendu.

RESTE (amélioration produit, non-bug) : notif client structurée "identifiants Bookitit incorrects".
Snapshot Redis non invalidé au booking → meute fait des cycles légers à vide jusqu'au TTL 2min
(borné, sans solve grâce à la garde #2). Acceptable.

## POINTS À ANALYSER (historique)

1. **Bug Convex reporting** : `reportSlotFound Convex error: 400 Missing required fields: applicationId, date, time, location`
   → les 2 bookings RÉUSSIS ne sont PAS remontés à Convex (donc pas de notif client / statut dossier).
   ⚠️ PRIORITÉ HAUTE : on book mais on ne l'enregistre pas côté app.

2. **getsigninfields/ 0B systématique côté meute** vs 13739B côté éclaireur.
   → confirme la mémoire (meute ne fait pas datetime/ → gsf 0B), mais signin/ aboutit quand même
   (2 bookings prouvent que gsf 0B n'empêche pas le booking). Comportement attendu, à confirmer.

3. **Messages RACE contradictoires** : "respect du sémaphore" (2<5) PUIS "sémaphore bypassé sans
   condition → booking immédiat". Logs incohérents à clarifier (le comportement final = booking immédiat).

4. **signin/ 0B "réponse vide"** (Christian madada, vip 7, éclaireur) vs **236B credentials** (Enock)
   vs **succès bktToken** (vip 5, vip 3). Distinguer : 0B = créneau déjà pris/session ? 236B = mauvais
   identifiants du dossier ? À cartographier.

5. **Boucle de rescan agressive** (Christian madada Cycle 97→98→99→100 en ~3s) sur snapshot encore
   frais alors que les 2 places sont déjà consommées → gaspillage de solves hCaptcha. Faut-il arrêter
   de foncer quand le snapshot est "épuisé" (places déjà prises par des peers) ?

6. **Éclaireur : rotation IP + blacklist** après signin/ 0B + datetime 0B (`anomalie proxy/session`).
   Est-ce justifié ou faux positif (le 0B datetime venait juste du fait que les 2 créneaux ont été
   consommés entre-temps) ?

7. **Enock credentials invalides** : dossier avec login/password erronés → à signaler à l'admin ?
