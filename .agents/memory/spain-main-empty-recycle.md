---
name: Spain /main/ empty response
description: Règle de récupération quand le bootstrap Bookitit /main/ renvoie 0B.
---

Un `/main/` vide dès la première tentative ne doit pas être retenté avec le même PHPSESSID. Abandonner cette session et relancer immédiatement un cycle complet pour obtenir un nouveau PHPSESSID et recalculer service, agenda et datetime.

**Why:** `/main/` est l'initialisation de l'identité PHP. Une réponse 0B ne contient aucun état exploitable, et les retries sur la même session ont seulement retardé le rescan. Les réponses tronquées mais non vides restent un cas de surcharge transitoire distinct.

**How to apply:** Détecter `bodyBytes === 0` sur la première tentative, arrêter la boucle `/main/`, puis faire remonter un signal de rescan immédiat. Conserver le retry borné uniquement pour les réponses non vides sous le seuil de taille.