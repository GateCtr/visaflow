---
name: Spain portal constants
description: Fichier spain-portals.ts centralise les clés Bookitit des portails citaconsular.es; règle le bug de mélange Kinshasa↔Saopolo.
---

## Règle

Toutes les clés Bookitit (portal URL, widget key, service ID) des portails citaconsular.es sont centralisées dans `artifacts/slot-hunter/src/spain-portals.ts`. Ne jamais les recoder en dur dans les fichiers de production.

## Constantes disponibles

| Portail | Constante URL | Constante Key | Service ID |
|---------|--------------|---------------|------------|
| Kinshasa (défaut historique) | `KINSHASA_PORTAL_URL` | `KINSHASA_WIDGET_KEY` | `KINSHASA_DEFAULT_SERVICE_ID` = `bkt1181774` (se termine par 74) |
| São Paulo (Saopolo) | `SAOPOLO_PORTAL_URL` | `SAOPOLO_WIDGET_KEY` | dynamique via getservices/ |
| Défaut générique | `DEFAULT_PORTAL_URL` | `DEFAULT_WIDGET_KEY` | `DEFAULT_PORTAL_SERVICE_ID` |

Fonction helper : `extractWidgetKey(portalUrl)` extrait la clé depuis n'importe quelle URL citaconsular.es.

## Bug corrigé : isBookititServiceRedirect

`spain-http-scanner.ts` — `isBookititServiceRedirect()` codait en dur la clé Kinshasa pour détecter les redirections. Corrigé avec une regex générique `/^\/es\/hosteds\/widgetdefault\/[a-f0-9]{30,}\//i` qui fonctionne pour tout portail.

**Why:** La détection de redirect hardcodée à Kinshasa ratait les redirects sur Saopolo, causant `not_found` alors que des créneaux existaient.

## Fichier test live Saopolo

`artifacts/slot-hunter/src/scripts/test-saopola-live.ts` — test bout-en-bout non-mock sur le portail Saopolo.

Usage : `SPAIN_HTTP_MODE=1 tsx src/scripts/test-saopola-live.ts`

Couvre : session CF → probe complet → getservices/ → getagendas/ → datetime/ → résumé.
