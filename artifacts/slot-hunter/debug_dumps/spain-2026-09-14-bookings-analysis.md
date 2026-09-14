# Analyse Espagne — publication du 14 septembre 2026

## État de conservation

Les fichiers sources reçus sont conservés tels quels dans `attached_assets/`.
Ce rapport contient uniquement l'index et les constats d'analyse ; il ne remplace
pas les traces originales.

Fenêtre couverte par les pièces reçues : **10:13:03 → 10:14:27 UTC**, principalement
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