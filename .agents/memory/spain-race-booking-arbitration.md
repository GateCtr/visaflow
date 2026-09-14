---
name: Spain race booking arbitration
description: Règle de concurrence pendant une publication Bookitit Espagne.
---

En mode publication/race, ne jamais attendre un sémaphore et ne jamais réclamer un créneau dans Redis avant la tentative. Conserver l’ordre déterministe des premiers choix, mais autoriser plusieurs workers à frapper le même créneau. Plusieurs workers peuvent voir le même créneau sans que cela implique plusieurs bookings possibles.

**Why:** L’observation réelle confirme que Bookitit accepte un gagnant et renvoie `signin/ → 0B`, un timeout ou parfois un rejet aux perdants. Un `getsigninfields/` valide confirme l’armement de session, pas la réservation. Les verrous locaux ajoutent un délai critique et empêchent le serveur d’arbitrer naturellement.

**How to apply:** Garder les protections Redis pré-booking hors race. En race, traiter séparément les erreurs de credentials, qui sont permanentes. Après une réponse de concurrence (`busyslot`/horaire pris), abandonner les candidats de la session courante et relancer un cycle complet avec un nouveau PHPSESSID avant de recalculer le tri. Les `0B` isolés restent un cas distinct.

Les traces de septembre 2026 montrent aussi des `signin/ → 0B` avec des tokens
frais et un état de cookies inchangé, tandis que d'autres tentatives avec le même
type de token renvoient `client_signin=true` ou `busyslot`.

**Why:** Un `0B` ne peut donc pas être attribué au captcha sans preuve
explicite. Les causes encore ouvertes incluent l'état portail, proxy, session
Bookitit ou réponse transitoire.

**How to apply:** Conserver l'observabilité par tentative (âge du token,
session non secrète, créneau et forme de réponse), mais ne pas ajouter un
`datetime/` bloquant avant chaque fallback : cette requête augmente la fenêtre
de course sans rendre un `0B` autoritatif.