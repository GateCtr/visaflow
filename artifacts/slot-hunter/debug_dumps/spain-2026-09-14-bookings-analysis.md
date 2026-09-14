# Analyse Espagne — publication du 14 septembre 2026

## État de conservation

Les fichiers sources reçus sont conservés tels quels dans `attached_assets/`.
Ce rapport contient uniquement l'index et les constats d'analyse ; il ne remplace
pas les traces originales.

Fenêtre couverte par les pièces reçues : **10:13:03 → 10:14:59 UTC**, principalement
les workers Espagne Kinshasa.

## Sources reçues

- `Pasted--10-13-03-CEV-Account-PANDA-MABUE-MIGNON-INFO-Grille-pr_1789385926626.txt`
- `Pasted--spain-booking-NoneCap-token-13-9s-spain-booking-hCaptc_1789385960579.txt`
- `Pasted--2026-09-14T10-13-15-339Z-INFO-WORKER-ADELARD-BENGA-NUM_1789386006823.txt`
- `Pasted--2026-09-14T10-13-22-781Z-INFO-WORKER-TAMBA-DIMBI-FRANC_1789386042555.txt`
- `Pasted--spain-booking-Envoi-solve-hCaptcha-NoneCap-sitekey-386_1789386086221.txt`
- `Pasted--bookitit-trace-REQUEST-getsigninfields-attempt-1-url-h_1789386121499.txt`
- `Pasted--bookitit-trace-GSF-COMPARE-portalFp-5696ac62-gsfCompar_1789386147169.txt`
- `Pasted--bookitit-trace-GSF-COMPARE-portalFp-5696ac62-gsfCompar_1789386173409.txt`
- `Pasted--bookitit-trace-GSF-COMPARE-portalFp-5696ac62-gsfCompar_1789386196016.txt`
- `Pasted--bookitit-trace-GSF-COMPARE-portalFp-5696ac62-gsfCompar_1789386219729.txt`
- `Pasted-2026-09-14T10-13-41-460Z-INFO-Scheduler-s-quentiel-idle_1789386245181.txt`
- `Pasted--spain-booking-NoneCap-token-8-7s-spain-booking-hCaptch_1789386269091.txt`
- `Pasted--2026-09-14T10-13-52-203Z-INFO-WORKER-MOKOBI-LIBUKU-BEN_1789386304429.txt`
- `Pasted--spain-hcaptcha-prewarm-token-servi-au-dossier-j5713vrn_1789386325019.txt`
- `Pasted--spain-hcaptcha-prewarm-dossier-j5713vrnns080vyxhwe67bs_1789386353743.txt`
- `Pasted--2026-09-14T10-14-02-738Z-INFO-WORKER-ADELARD-BENGA-NUM_1789386398696.txt`
- `Pasted--spain-booking-NoneCap-token-13-1s-spain-booking-hCaptc_1789386425055.txt`
- `Pasted--spain-hcaptcha-prewarm-token-p-rim-cart-pour-le-dossie_1789386459746.txt`
- `Pasted--spain-booking-NoneCap-token-52-3s-spain-booking-hCaptc_1789386496499.txt`
- `Pasted--bookitit-trace-RESPONSE-COOKIES-signin-set-cookie-none_1789386532889.txt`
- `Pasted-2026-09-14T10-14-27-211Z-INFO-WORKER-MOKOBI-LIBUKU-BENJ_1789386592527.txt`
- `Pasted--2026-09-14T10-14-33-849Z-INFO-WORKER-MOKOBI-LIBUKU-BEN_1789386639319.txt`
- `Pasted--bookitit-trace-RESPONSE-COOKIES-signin-set-cookie-none_1789386708553.txt`
- `Pasted--2026-09-14T10-14-46-433Z-INFO-WORKER-MAKOLA-MALUENGO-G_1789386746197.txt`
- `Pasted--2026-09-14T10-14-51-136Z-INFO-WORKER-MOKOBI-LIBUKU-BEN_1789386775299.txt`

## Premiers bookings confirmés dans les sources

Les traces contiennent cinq confirmations explicites, même si le bilan annoncé
mentionne quatre bookings. Cette différence doit être vérifiée avec les prochains
logs ; aucune ligne n'est supprimée ou dédupliquée ici.

| Heure UTC | Worker | Créneau | Preuve |
|---|---|---|---|
| 10:13:49 | Mr Bertin 5 | 2026-10-20 09:15 | `signin/` avec `client_signin=true`, puis `Booking confirmé` |
| 10:14:00 | Mr Nkumu | 2026-10-20 08:30 | `signin/` avec `client_signin=true`, puis `Booking confirmé` |
| 10:14:08 | TSHAMALA INOKOYA E | 2026-10-20 10:30 | `signin/` avec `client_signin=true`, puis `Booking confirmé` |
| 10:14:08 | Tamba Dimbi Franci | 2026-10-20 09:00 | `signin/` avec `client_signin=true`, puis `Booking confirmé` |
| 10:14:13 | Adelard Benga Numb | 2026-10-20 09:45 | `signin/` avec `client_signin=true`, puis `Booking confirmé` |

## Captcha : constats confirmés

1. Le captcha est bien détecté sur les workers concernés avec la même sitekey.
2. Les tokens préchauffés sont servis par dossier et consommés individuellement.
3. La limite d'âge à 20 secondes a effectivement écarté des tokens :
   - 20,1 s ;
   - 20,8 s ;
   - 21,0–23,8 s ;
   - plusieurs tokens entre 27 et 45 s.
4. Un token servi à 19,7 s est encore accepté par le chemin de booking.
5. Les durées `NoneCap token (8,7s / 13,9s / 52,3s)` représentent la durée
   de résolution, pas l'âge du token au moment de `signin/`. Il ne faut pas
   les confondre dans l'analyse.
6. Après épuisement ou rejet d'une réserve, le worker résout bien un token neuf
   avant `signin/`. Cela est visible notamment pour Inokoya Isolitina, Kaka Di
   Kaka et Tamba.

## Incidents observés

- `getsigninfields/` a répondu `0B` pour Mokobi Libuku Benj, avec réarmement
  de session et nouveau `PHPSESSID`. C'est un problème d'armement/session,
  pas une preuve d'échec hCaptcha.
- `datetime/` a renvoyé `0B` pour plusieurs workers (`Mr Nkumu`, `Makola`,
  `Inokoya Isolitina`, `Adelard`, `Kaka`, `Mr Bertin 6 bis`). Cela concerne le
  scan et ne doit pas être attribué automatiquement au captcha.
- Kaka Di Kaka a reçu `busyslot` sur 08:45 : créneau gagné par un autre acteur.
  C'est une perte de course normale et non une erreur captcha.
- Inokoya Isolitina a reçu au moins une réponse `signin/` vide, puis a continué
  avec un autre créneau et un nouveau token.

## Lecture provisoire

Le système a bien réalisé plusieurs bookings pendant cette fenêtre malgré des
réponses `0B`, des réarmements `getsigninfields/` et des tokens périmés.
Les traces ne montrent pas encore de message explicite `captcha invalid`.

Le point à surveiller dans les prochains fichiers est la relation entre :

```text
token servi / token périmé
→ requête signin/ correspondante
→ réponse 0B ou client_signin=true
```

Il faudra aussi réconcilier le compteur annoncé de **4 bookings** avec les
**5 confirmations explicites** présentes dans cet instantané.

## À compléter avec les prochains logs

- Ajouter les traces `signin/` complètes autour de chaque confirmation.
- Associer chaque `j57...` à son worker sans déduire l'identité depuis l'ordre
  d'arrivée des lignes.
- Compter les dossiers uniques et les créneaux uniques.
- Vérifier le résultat de `summary/` pour chacun des bookings.
- Comparer les réponses vides avant et après le rejet des tokens âgés.

## Complément des traces 10:14:27–10:14:59 UTC

### Réconciliation du nombre de bookings

Les nouveaux fichiers n'ajoutent pas de sixième réservation. Ils confirment les
cinq réservations déjà présentes dans le premier lot :

| Dossier | Heure de confirmation UTC | Créneau reporté | Preuves disponibles |
|---|---:|---|---|
| Mr Bertin 5 | 10:13:49 | 2026-10-20 09:15 | `signin/` accepté, puis `Booking confirmé` |
| Mr Nkumu | 10:14:00 | 2026-10-20 08:30 | `signin/` accepté, puis `Booking confirmé` |
| TSHAMALA INOKOYA ELIE | 10:14:08 | 2026-10-20 10:30 | `client_signin=true`, `state=1`, report Convex |
| Tamba Dimbi Francine | 10:14:08 | 2026-10-20 09:00 | `client_signin=true`, gagnant Redis, report Convex |
| Adelard Benga Numbi | 10:14:13 | 2026-10-20 09:45 | `client_signin=true`, gagnant Redis, report Convex |

Dans les pièces fournies, le bilan vérifiable est donc **5 bookings confirmés**.
Le chiffre de 4 est probablement un compteur annoncé avant la fin du traitement
ou un compteur Convex incomplet au moment du message. Les logs montrent aussi
les cinq dossiers retirés de Convex après les confirmations ; cela ne constitue
pas à lui seul une preuve de lecture durable en base, mais rend l'hypothèse du
compteur à 4 obsolète pour cette fenêtre.

### Classification des nouvelles tentatives

- **Courses serveur confirmées : au moins 4 `busyslot` distincts** dans les
  extraits : Kaka à 08:45, Inokoya à 2026-10-19 09:45, Makola à 10:45 et
  Mr Bertin 7 à 10:15. Le serveur donne explicitement la cause : le créneau
  a été sélectionné par une autre personne.
- **Réponses `signin/` vides : nombreuses, au moins 10 couples
  dossier/créneau visibles dans les nouveaux extraits**, notamment Kaka
  (09:00, 09:15, 09:30, 10:00), Inokoya (08:45, 09:00, 09:15, 09:30),
  Makola (08:30, 11:00, 11:15) et d'autres tentatives intercalées.
  Ces réponses sont toutes `HTTP=200`, `raw=0B`, `contentType=text/html`,
  `bodyFp=811c9dc5`, sans erreur JSON ni `busyslot`.
- **Sessions/réarmement :** le `getsigninfields/` de Mokobi répond `0B`,
  puis le worker réarme la session avec un nouveau `PHPSESSID`. Ce cas est
  distinct d'un `signin/` vide : il prouve une session mal armée ou morte,
  mais pas une invalidité hCaptcha.
- **Réservation Redis interne :** Mokobi ignore 10:15 et 11:30, puis indique
  que les 15 créneaux éligibles sont épuisés ; Makola ignore aussi 11:30.
  La trace de Makola annonce un snapshot de **12 places sur 7 créneaux**.
  Ces exclusions sont locales et ne sont pas des réponses d'occupation
  envoyées par Bookitit.

### Le token hCaptcha n'explique pas les `0B`

Les extraits associent des réponses vides à des tokens récents, par exemple :

- Kaka : token servi à **16,7 s**, puis `signin/` vide ;
- Inokoya : token servi à **15,0 s**, puis `signin/` vide ;
- Makola : token servi à **12,4 s**, puis `signin/` vide ;
- Makola : token servi à **18,4 s**, puis `signin/` vide.

À l'inverse, des tokens proches de la limite ont aussi produit des résultats
normaux : le token à **19,7 s** est associé à une réponse serveur exploitable,
et les tokens neufs ont produit à la fois `client_signin=true` et `busyslot`.
La règle des 20 secondes fonctionne donc comme protection contre les tokens
trop vieux, mais les `0B` restants ne peuvent pas être classés comme des
échecs hCaptcha sur la seule base de ces traces.

Un autre indice est Kaka : plusieurs tentatives vides partagent le même état
de cookies observé dans les requêtes (`cf_clearance` et `PHPSESSID` inchangés
dans l'extrait), alors que le worker continue à recevoir des réponses
différentes sur d'autres tentatives. Les causes encore compatibles sont le
portail, le proxy, l'état de session côté Bookitit ou une réponse transitoire
du service ; aucune n'est démontrée individuellement par le dump.

### Décision sur le fallback

Ces logs ne justifient pas l'ajout d'un `datetime/` avant chaque fallback :

1. `busyslot` est déjà une décision serveur immédiate et le fallback suivant
   peut partir sans requête supplémentaire ;
2. les `0B` sont précisément les cas ambigus pour lesquels un `datetime/`
   supplémentaire peut encore être obsolète au retour ;
3. les appels observés à `getservices/`, `getagendas/` et `datetime/` prennent
   parfois plusieurs secondes, ce qui agrandirait la fenêtre de course.

La stratégie à conserver pour cette publication est donc : snapshot frais,
tentative immédiate, token neuf pour chaque `signin/`, puis candidat suivant
sur `busyslot` ou réponse vide. Il faut traiter les `0B` comme **état
inconnu**, pas comme preuve d'une place libre, d'une place prise ou d'un
captcha invalide.

## Couverture réelle de la fenêtre de deux minutes

La fenêtre analysée est **10:13:00–10:15:00 UTC** (soit 11:13–11:15 à
Kinshasa/Lagos). À 10:13:21, l'itération #442 indique **11 workers actifs**,
et les traces d'orchestration montrent encore ces 11 dossiers à 10:14:08.

Cependant, les 11 n'ont pas couvert toute la fenêtre en pratique. Cinq ont
réussi leur booking puis ont terminé avant 10:14:13 :

- Mr Bertin 5 — 10:13:49 ;
- Mr Nkumu — 10:14:00 ;
- TSHAMALA INOKOYA ELIE — 10:14:08 ;
- Tamba Dimbi Francine — 10:14:09 ;
- Adelard Benga Numbi — 10:14:13.

Les **6 dossiers restants** ont encore des événements de travail jusqu'à la
fin observable de l'instantané, entre 10:14:38 et 10:14:59 :

- Mr Bertin 6 bis ;
- Mr Bertin 7 ;
- Kaka Di Kaka ;
- Mokobi Libuku ;
- Makola Maluengo ;
- Inokoya Isolitina.

Conclusion opérationnelle : **11 dossiers au total, 6 ont effectivement
traversé la fenêtre jusqu'à sa dernière trace, et 5 se sont arrêtés après
booking**. Comme les logs fournis s'arrêtent à 10:14:59.091, ils ne permettent
pas de prouver une activité à la seconde exacte 10:15:00 ; « 6 couvrent les
2 minutes » signifie donc ici qu'ils sont restés actifs pendant toute la
fenêtre observable, pas qu'un heartbeat a été enregistré à chaque seconde.

### Correction apportée avec l'information utilisateur

Les fichiers fournis prouvent explicitement le schéma
`busyslot → fallback → 0B` pour Kaka, Inokoya et Makola. L'utilisateur confirme
que **Mr Bertin 7 a subi le même schéma**, mais les traces correspondantes ne
font pas partie des pièces archivées. Le bilan opérationnel est donc **4/4
dossiers avec ce problème**, avec une preuve documentaire disponible pour
3/4 et une confirmation utilisateur pour le quatrième. Le passage de Bertin 7
par Redis et l'épuisement des candidats reste visible dans les extraits déjà
reçus, mais ne permet pas à lui seul de reconstituer son `0B` de fallback.