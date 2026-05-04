# BotLog Taxonomy (Slot Hunter)

Ce document définit un vocabulaire unique pour `botLog` afin d'alimenter les dashboards et alertes.

## Champs standards

- `applicationId`: id du dossier
- `step`: étape globale normalisée
- `status`: `ok` | `warn` | `fail`
- `data.flow`: flux métier (`usa`, `spain`, etc.)
- `data.phase`: sous-étape interne (optionnelle mais recommandée)

## Étapes globales (`step`)

- `login`: navigation/session/auth initiale
- `captcha`: challenge/captcha détecté ou résolu
- `scan`: exploration disponibilité (API, réseau, DOM)
- `slots_found`: disponibilité détectée (et actions post-détection)
- `not_found`: aucune disponibilité détectée
- `error`: erreur technique, blocage, rate-limit, échec booking

## Convention `status`

- `ok`: étape exécutée normalement
- `warn`: état non bloquant ou résultat dégradé attendu (ex: `not_found`, conflit 409)
- `fail`: échec bloquant nécessitant action ou retry

## Phases recommandées par flux

### USA (`data.flow = "usa"`)

- `phase: "ofc_list"`: chargement des OFCs
- `phase: "booking_attempt"`: tentative de réservation
- `phase: "booking_success"`: booking accepté
- `phase: "booking_fail"`: booking refusé/conflit/réponse invalide
- `phase: "confirmation_letter"`: téléchargement/upload PDF
- `phase: "rate_limit"`: HTTP 429
- `phase: "blocked"`: HTTP 403 / compte potentiellement bloqué
- `phase: "token_expired"`: 401 / JWT expiré

### Spain (`data.flow = "spain"`)

- `strategy: "api_first"`: scan via endpoints Bookitit
- `strategy: "fallback_network"`: scan via payloads réseau interceptés
- `strategy: "fallback_dom"`: scan via DOM
- (optionnel) `phase` si une granularité supplémentaire est ajoutée plus tard

## Requêtes dashboard (exemples)

- Taux de succès global:
  - `step = "slots_found" AND status = "ok"`
- Taux de no-slot:
  - `step = "not_found"`
- Erreurs critiques:
  - `step = "error" AND status = "fail"`
- Rate-limit:
  - `step = "error" AND data.phase = "rate_limit"`
- Santé Espagne API-first:
  - `data.flow = "spain" AND step = "scan" AND data.strategy = "api_first"`

## Règles d'évolution

1. Toujours privilégier un `step` existant avant d'en créer un nouveau.
2. Mettre le détail métier dans `data.phase` ou `data.strategy`.
3. Garder les noms courts, stables, et en snake/camel cohérents.
4. Toute nouvelle taxonomy doit être documentée ici.
