---
name: Spain race booking arbitration
description: Règle de concurrence pendant une publication Bookitit Espagne.
---

En mode publication/race, ne jamais attendre un sémaphore et ne jamais réclamer un créneau dans Redis avant la tentative. Conserver l’ordre déterministe des premiers choix, mais autoriser plusieurs workers à frapper le même créneau.

**Why:** L’observation réelle confirme que Bookitit accepte un gagnant et renvoie `signin/ → 0B` aux perdants. Les verrous locaux ajoutent un délai critique et empêchent le serveur d’arbitrer naturellement.

**How to apply:** Garder les protections Redis pré-booking hors race. En race, passer immédiatement au candidat suivant après un `signin/ → 0B`; n’utiliser la coordination persistante qu’après une réussite.