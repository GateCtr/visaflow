---
name: Spain cancellation month scan
description: Règle d'arrêt anticipé du scan multi-mois pendant les jours d'annulations.
---

Du mercredi au samedi, selon le fuseau `Africa/Kinshasa`, arrêter le scan des mois suivants dès que le premier mois positif retourne des créneaux. Si le premier mois interrogé est vide, continuer vers le deuxième.

**Why:** Ces jours-là, les publications sont généralement de petites annulations sur le premier mois utile. Continuer vers un mois vide retarde inutilement le booking de créneaux très disputés.

**How to apply:** La règle s'applique au premier mois effectivement interrogé, y compris quand le scan commence au mois suivant en fin de mois. Les autres jours conservent le scan multi-mois normal.