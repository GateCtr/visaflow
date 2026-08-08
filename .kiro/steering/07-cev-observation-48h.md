# CEV Observation Mode — Budget 48h

## Objectif

Observer le portail CEV (appointment.cloud.diplomatie.be) pendant **48 heures continues**
pour déterminer **à quelle heure** les 200 créneaux/jour sont publiés (jours ouvrables).

**Contexte business :** Le CEV publie ~1000 créneaux/semaine (200/jour × 5 jours ouvrables).
L'heure exacte de publication est inconnue → observation nécessaire.

## Budget Disponible

| Ressource | Disponible | Garde de sécurité | Budget utilisable |
|-----------|-----------|-------------------|-------------------|
| iProyal (proxy résidentiel) | 2 GB (2048 MB) | 148 MB | 1900 MB |
| Anti-Captcha (hCaptcha) | $4.19 | $0.19 | $4.00 |

## Configuration Optimale (mode observation)

```
cev_stealth_mode = "1"
cev_stealth_pool_size = "4"
cev_stealth_checks_per_cycle = "1"
cev_stealth_pause_between_checks = "30"
```

### Débit résultant

- **4 IPs × 4 clics/IP/h = 16 checks/heure maximum**
- **1 check toutes les ~3.75 minutes** (couverture suffisante pour détecter une fenêtre de publication)
- Rotation IP automatique après chaque check (minimise le risque de ban)

### Coûts estimés sur 48h

| Poste | Calcul | Total 48h | % du budget |
|-------|--------|-----------|-------------|
| Captcha | 16/h × 48h × $0.003 | **$2.30** | 55% |
| Proxy | 16/h × 48h × 1 MB | **768 MB** | 37% |

**Marge restante : ~$1.89 captcha + ~1.28 GB proxy** (pour erreurs, retries, rate-limits)

## Garde-fous Automatiques

Le code (`cev-stealth-loop.ts`) inclut un **budget guard** qui arrête automatiquement le bot si :
- Captcha dépense ≥ $4.00
- Proxy consommé ≥ 1900 MB

Les stats (incluant consommation budget) sont loguées dans Convex toutes les 25 itérations
et affichées en console avec ETA du temps restant.

## Que faire quand un slot est détecté

1. Le bot tente un **booking HTTP pur** immédiat (~5s)
2. Si HTTP échoue → fallback **Playwright** (~2-3 min)
3. Résultat rapporté à Convex + notification

## Après l'observation

Une fois l'heure de publication identifiée :
1. Augmenter `cev_stealth_pool_size` (8-10 IPs) pendant la fenêtre de publication
2. Réduire à 2-3 IPs en dehors de la fenêtre
3. Budget mensuel recommandé : ~$30 captcha + 15 GB proxy

## Commandes Convex (bot-config)

| Clé | Valeur | Effet |
|-----|--------|-------|
| `cev_stealth_mode` | `"1"` / `"0"` | Activer/désactiver le mode stealth |
| `cev_stealth_pool_size` | `"4"` | Nombre d'IPs dans le pool (défaut observation) |
| `cev_stealth_checks_per_cycle` | `"1"` | Checks avant rotation IP |
| `cev_stealth_pause_between_checks` | `"30"` | Secondes entre checks |
