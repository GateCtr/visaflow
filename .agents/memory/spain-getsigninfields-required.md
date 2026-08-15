---
name: getsigninfields/ obligatoire avant signin/
description: Le nonce PHP de signin/ est activé uniquement si getsigninfields/ est appelé en premier (même PHPSESSID, mêmes params). Sans cet appel, signin/ retourne 0B.
---

## La règle

Pour déclencher `signin/` en mode HTTP pur (capsolver-residential), il faut appeler `getsigninfields/` en premier avec les mêmes params (services[], agendas[], date, time, selectedPeople).

**Why:** Le serveur PHP Bookitit stocke un nonce dans la session après `getsigninfields/`. Sans ce nonce, `signin/` retourne 0B (pas 4xx, juste vide). Le widget Backbone déclenche ce call automatiquement lors de la navigation `#selecttime/{date}/{time}/{svc}/{ag}` — en HTTP pur, il faut le répliquer explicitement.

**How to apply:** Dans `spain-http-booking.ts`, avant l'appel `signin/` (et ses candidats), ajouter un appel `getsigninfields/` avec les mêmes params (date, time, services[], agendas[]). Ignorer le corps retourné (il contient les champs du formulaire — CustomFields, Clients, etc.).

## Résultat après correction

- `getsigninfields/` → HTTP 200 | 13816B | `{"CustomFields": {"Clients": [...]}}` ✅
- `signin/` (faux credentials) → HTTP 200 | 236B | `{"Client": {"errors": [{"message": "Usuario o contraseña incorrectos"}]}}` ✅
- `signin/` (vrais credentials) → bktToken attendu

## Ce qui ne change pas

- `createIsolatedBookingSession` échoue pour capsolver-residential car le `/main/` dédié ne retourne pas de PHPSESSID (PHPSESSID vient du POST token, pas de /main/). En pratique, la session principale suffit pour un seul dossier.
- Sur un portail multi-agendas, getsigninfields/ et signin/ doivent utiliser la paire serviceId+agendaId d'où provient le créneau (date/heure), pas un agenda arbitraire — sinon la réponse ne prouve pas la séquence visée.
- Preuve de traitement serveur : getsigninfields/ = 200 + JSONP avec CustomFields ; signin/ = Client.errors login/password ("incorrectos") ou bktToken. Toute HTML/challenge/erreur générique ne prouve rien.
- Les proxies live viennent du fichier `decodo-proxies.csv` (chargé par spain-decodo-pool), PAS du secret `DECODO_PROXY_URL` (isp/gate.decodo.com peut être injoignable).
