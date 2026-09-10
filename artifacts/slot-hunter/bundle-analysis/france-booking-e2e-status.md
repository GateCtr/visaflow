# France (consulat.gouv.fr / Troov) — Statut du booking E2E

> Dernière mise à jour : 2026-09-02
> Cible de test : ADF Kinshasa, contact `encoraplus@gmail.com` (test, à annuler manuellement).
> Mode : `npx tsx scripts/france-live-diagnostic.ts --no-proxy --book` (code de prod exécuté directement).

## TL;DR

Le scan fonctionne parfaitement (≈290 créneaux détectés). Le flux de booking
persiste **toutes** les étapes en `200 OK`, mais le `POST reservations/family`
final renvoie systématiquement :

```json
{"message":"ERROR_ADD_GROUPPED_RESERVATION","description":"The resource referenced by request does not exists","code":404}
```

La cause exacte de ce 404 métier **n'est pas encore identifiée**. Le body envoyé
est structurellement conforme au bundle. Reste une divergence probable sur la
forme de l'objet `service` (`zone` / `zone_id`) — piste principale à creuser.

## Ce qui fonctionne (validé live)

- **Handshake** anti-bot (`x-gouv-*`), résolution **Turnstile** via CapSolver, `resolveTeam`.
- **openSession** (`POST reservations-session` sans `sessionId` dans le body → `_id` retourné).
- **Scan complet** : `get-interval` + `exclude-days` + `availability` → ~290 créneaux.
- **Persistance des étapes** (toutes en `200 OK`) via `update-step-value` + `update-dynamic-steps` :
  1. `servicesStep` (stepIndex 0)
  2. `importantInformationStep` (stepIndex 1)
  3. `update-dynamic-steps` (crée `slotsSteps[0]`)
  4. `slotsStep` (stepIndex 2, `dynamicStepIndex 0`)
  5. `mainContactDetailsStep` (stepIndex 3)
  6. `askConfirmationStep` (stepIndex 4)
- **174/174 tests verts**, `tsc --noEmit` clean.

## Bugs corrigés pendant l'investigation

| Bug | Correction (source de vérité : bundle) |
|-----|----------------------------------------|
| `slotsStep` renvoyait "Invalid time value" | `slot.date` = JOUR SEUL `YYYY-MM-DD` ; slotValue via `new Date(day).toISOString()` (minuit UTC) |
| `slotsStep` → 404 | `update-dynamic-steps` doit créer `slotsSteps[0]` avec shape exact du bundle (`name`, `numberOfSlots`, `dynamicStepIndex`, `zone_id`, `value:{lastSelectedDate,label,accessibleCalendar,hasSwitchedCalendar,slots}`) |
| slotsStep value mal formée | `{lastSelectedDate,label,accessibleCalendar:false,hasSwitchedCalendar:false,slots:{[jour]:[slot]}}` (pas de champ `services`) |
| slot incomplet | slot porte `time`, `rate`, `capacity`, `date`(jour), `slotValue`, `serviceName`, `numberOfApplicants:1` |
| `birthdate` string dans le family | Doit être un **objet** `{month(0-indexé),day,year}` (bundle `setupUserForApi`) — la string ne vaut que pour `mainContactDetailsStep` |
| `slotsToKeep` incomplet | slot complet + `date` réécrit en `YYYY-MM-DDTHH:MM:00` (bundle `setupServiceForApi`) |
| **Clé de motif fausse** | ADF utilise `6480b20515fc40e7` (PAS `54cfd964c63f3386` = Visas). Chaque service a SA clé + SES valeurs |
| **Valeur de motif fausse** | "Autres" invalide pour ADF. Valeurs ADF : `Passeport `, `Carte nationale d'identité `, `Inscription au Registre `, `Passeport et CNI `, `Déclaration de vol ou de perte de documents ` (⚠️ espace final) |
| Motif validé contre liste Visas figée | Découplé : `BookingContext.motifKey` + `motif` (string), validation = présence uniquement |
| `contact.services=[]` | mainContactDetailsStep porte les services avec `slots` + `checkboxesSlots=[slotValue]` (auto-cochés pour 1 demandeur) |

## Découvertes clés du reverse-engineering

- **slotValue** (bundle `getSlotValueForFamilyReservations`) :
  `sanitizeToId(\`slot-${zone.name}-${new Date(slot.date).toISOString()}-${slot.time}\`)`.
  `zone.name` provient de `team.reservations_shop_availabilty[].name`.
  ✅ Vérifié : `zone.name === serviceName` pour ADF (MATCH). Notre slugify == `sanitizeToId` du bundle (comparaison exacte OK).
- **`reservations/family` body** (bundle `getReservationsForApi`) :
  `{mainUser, secondaryUsers:[], sessionId, team}`. ✅ Conforme.
- **Endpoint** confirmé : `POST /team/{teamId}/reservations/family` (le seul point de réservation public ; `/reservations` et `/zones` sont dashboard/authentifiés).
- **availability** ne renvoie QUE `{time, rate, capacity}` (aucun `_id` de créneau caché) — vérifié via sonde brute.
- **Jour même** (`2026-09-02`) renvoie `[]` (plus réservable) alors qu'un jour futur (`2026-09-08`) renvoie 9 créneaux. Le diagnostic choisit désormais un **jour futur**. Mais le 404 persiste même sur jour futur (`2026-09-03`).
- La session fraîche a `servicesStep.value.services = []` : le portail remplit ce tableau côté client depuis `reservations_shop_availabilty` avant de persister.

## Piste principale restante (NON résolue)

**Forme de l'objet `service` dans le body family.** Indices bundle :
- `SET_SERVICES_STEP_APPLICANTS_PER_SERVICE` filtre par **`service.zone_id`** (pas `_id`).
- `setupServiceForApi(t)` lit **`t.zone.custom_fields`** → le service porte un objet **`zone` complet** (avec `custom_fields`, `openings`, etc.), pas juste `{_id}`.

Actuellement on envoie `service = {_id, name, numberOfSlots, zone:{_id}, ...}`.
Il manque probablement :
- `zone_id` (en plus ou à la place de `_id`),
- l'objet **`zone` complet** issu de `team.reservations_shop_availabilty[serviceId]`.

**Prochaine action concrète** : faire porter au `BookingContext` l'objet `zone`
complet (récupéré via `GET /team/slug/{slug}` → `reservations_shop_availabilty`
filtré sur `serviceId`) et l'injecter tel quel dans `service.zone` +
`service.zone_id` du body family (et éventuellement du servicesStep/slotsStep).

## Autres pistes secondaires (si la principale échoue)

- Persister aussi `timbreStep` / `preRequestStep` (présents dans la session, non gérés).
- Vérifier si `numberOfApplicants` doit être présent au niveau `servicesStep.value` ET cohérent partout.
- Capturer le body réel du portail via DevTools/Burp (une vraie réservation manuelle) pour diff exact octet par octet — le plus décisif.
- Tester une valeur de motif différente (une des 5 valeurs ADF) au cas où "Inscription au Registre " ne serait pas acceptée pour ce sous-cas.

## Fichiers touchés

- `src/france/france-booking.ts` — `computeSlotValue`, `buildSlotToKeep`, `buildBookingSteps` (slotsStep + contact), `buildReservations`, `runBookingFlow` (validation motif + logs DIAG).
- `src/france/france-types.ts` — `SlotToKeep` (+rate/capacity/numberOfApplicants), `UserForApi.birthdate` (objet), `ServiceForApi` (+_id/name/zone/zone_id/checkboxesSlots/...), `BookingContext` (+motifKey, motif string), `FranceJobConfig` (+motifKey).
- `src/france/france-hunter.ts` — `mapJobToFranceConfig` (+franceMotifKey, motif découplé), `buildSlotToKeep` (+rate/capacity), bookingCtx (+motifKey).
- `scripts/france-live-diagnostic.ts` — TEST_MOTIF_KEY/TEST_MOTIF ADF, sélection jour futur, logs.
- `scripts/france-probe-zones.ts` — **sonde LECTURE SEULE** (zones/services + availability brute). Réutilisable.
- Tests mis à jour (SlotToKeep, BookingContext, mapJobToFranceConfig).

## ⚠️ Nettoyage à faire avant merge

- Retirer les logs `[DIAG]` de `france-booking.ts` (`update-step-value`, `update-dynamic-steps`, `reservations/family`).
- Restaurer `toResult` dans `france-http.ts` : le parse du body sur échec a été forcé pour le debug (`const parsed = safeJsonParse(...)` au lieu de `res.ok ? ... : null`). **À remettre** en `res.ok ? ... : null`.
- Supprimer les logs de diagnostic (`diag*.log`, `probe-*.log`) et éventuellement `scripts/france-probe-zones.ts` si non conservé.
- Réintroduire une vraie validation du motif (contre les valeurs réelles du service) si souhaité.

## Commandes utiles

```powershell
cd artifacts/slot-hunter
npx tsc --noEmit
npx vitest run src/__tests__/france-
# Sonde lecture seule (zones + availability brute) :
npx tsx scripts/france-probe-zones.ts --no-proxy
# Booking réel (⚠️ consomme un créneau, à annuler manuellement) :
npx tsx scripts/france-live-diagnostic.ts --no-proxy --book
```

## Constantes de référence

- teamId : `6230a987df141cedfef4a188`
- slug : `ambassade-de-france-a-kinshasa`
- serviceId ADF : `6346e242c47b29722d5f5f4e`
- serviceName ADF (EXACT) : `ADF - Demande d'inscription au Registre, de CNI/ passeport/déclaration de vol ou perte de documents`
- motifKey ADF : `6480b20515fc40e7`
- sitekey Turnstile : `0x4AAAAAAAc-bWzy0zJTmAqs`
- Services du team : ADF `...5f4e`, "ADF - Dépôt des Légalisations" `...5f50`, "Etat civil" `...5f51`, "Visas" `...5f52`
