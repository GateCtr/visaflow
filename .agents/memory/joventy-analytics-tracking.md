---
name: Joventy analytics tracking
description: Règles durables pour les événements GA4/Umami et les vues de page SPA sur Joventy.
---

Utiliser le wrapper analytique commun pour les événements d’interaction et de résultat, et ne transmettre aucune donnée personnelle. Le tag GA4 déjà présent gère le suivi de base; ne pas ajouter un événement `page_view` manuel tant que le réglage de suivi d’historique SPA dans GA4 n’a pas été vérifié.

**Why:** les paramètres GA4 de mesure améliorée ne sont pas accessibles depuis le code; ajouter aussi des vues de page à chaque changement de route pourrait compter deux fois les visites.

**How to apply:** ajouter les événements aux clics ou après la réussite effective d’une mutation. Les propriétés doivent rester non identifiantes et de faible cardinalité.
