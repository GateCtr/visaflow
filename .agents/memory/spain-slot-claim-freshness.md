---
name: Spain slot claim freshness
description: Règle de fraîcheur et d’observabilité des claims de capacité Redis Espagne.
---

Un claim Redis Espagne doit comparer l’horodatage du snapshot entrant à celui stocké. Seul un snapshot strictement plus récent peut remplacer `free`; cette mise à jour doit être persistée même si le claim est refusé.

**Why:** Un snapshot ancien avec une faible capacité peut sinon bloquer des places apparues dans un snapshot plus récent. À l’inverse, un snapshot plus ancien avec une capacité supérieure ne doit pas restaurer une capacité périmée.

**How to apply:** Transmettre l’horodatage du snapshot réellement utilisé par le worker. Lors d’un refus, exposer la capacité retenue, les places bookées, le nombre de claims, le TTL et l’horodatage observé afin de distinguer capacité épuisée, claim déjà présent et Redis dégradé.