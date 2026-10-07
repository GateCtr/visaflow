---
name: Spain proxy exclusion policy
description: User-selected seven-day quarantine independent of Cloudflare cache expiry; no arbitrary port range exclusions.
---

# Spain proxy exclusion policy

## Seven-day exclusion
L'utilisateur a choisi une exclusion de **7 jours** pour les IP Espagne rejetées. L'expiration du cache Cloudflare ne signifie pas que le portail accepte de nouveau l'IP.

**Why:** L'utilisateur a signalé qu'un dossier reprenait des IP déjà rejetées après expiration de leur état Redis.

**How to apply:** Préserver les exclusions pendant les sept jours, y compris après redémarrage. Un pool entièrement exclu ne doit pas réutiliser automatiquement une IP rejetée.

## No arbitrary port range
« Port 4000 » était un exemple de port X, pas une demande de bloquer les 4000 premières entrées ou les ports 14xxx.

**Why:** L'utilisateur l'a précisé lors du choix de la durée.

**How to apply:** Exclure les proxys réellement signalés comme défaillants, jamais une plage déduite de cet exemple.

## Shared failure policy
Reserve warm-up and background replenishment must share the same proxy-exclusion policy. Warm-up must have a bounded solve budget rather than trying the entire configured proxy pool.

**Why:** Failed reserve initialization previously did not flag the proxy during warm-up, allowing later reuse and long runs of paid solves that never produced a usable session.

**How to apply:** Flag failed reserve initialization consistently in both paths. Restore legacy URL-shaped blacklist keys into the same host:port identity used by current lookups. Host:port exclusion is an allocation rule, not proof that two provider ports have distinct real exit IPs.
