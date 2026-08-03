/**
 * spain-portals.ts — Constantes officielles des portails citaconsular.es
 *
 * Centralise les clés Bookitit pour éviter tout mélange entre portails lors des tests
 * et du développement. Importer depuis ici plutôt que de coder en dur dans chaque fichier.
 *
 * ─── Comment ajouter un nouveau portail ───────────────────────────────────────
 *   1. Ajouter les constantes NOMPORTAIL_PORTAL_URL / _WIDGET_KEY / _DEFAULT_SERVICE_ID
 *   2. Si ce portail doit devenir le défaut, changer DEFAULT_PORTAL_URL / _WIDGET_KEY
 *   3. Mettre à jour spain-portals.test.ts si un test de cohérence existe
 */

// ─── Kinshasa (Congo RDC — ambassade d'Espagne) ───────────────────────────────
/** URL complète du widget Bookitit pour le portail Kinshasa. */
export const KINSHASA_PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/#services";

/** Clé Bookitit extraite de l'URL (publickey / widgetId) — portail Kinshasa. */
export const KINSHASA_WIDGET_KEY = "25028fcd7126544630b8da0c6e60722b5";

/**
 * Fenêtre de publication calendrier Kinshasa : les créneaux sont publiés 36 jours à l'avance.
 * Ex : le 3 août → premiers créneaux disponibles le 8 septembre → démarrer le scan en septembre.
 */
export const KINSHASA_CALENDAR_PUBLISH_DAYS = 36;

/**
 * ID du service "Tramitación de visas" sur le portail Kinshasa.
 * Se termine par "74" — ne pas utiliser dans les fixtures de test Saopolo.
 */
export const KINSHASA_DEFAULT_SERVICE_ID = "bkt1181774";

// ─── São Paulo (Brésil — "Saopolo") ──────────────────────────────────────────
/** URL complète du widget Bookitit pour le portail São Paulo. */
export const SAOPOLO_PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services";

/** Clé Bookitit extraite de l'URL (publickey / widgetId) — portail São Paulo. */
export const SAOPOLO_WIDGET_KEY = "2d01502f12dc08400e22aea87fb00ae34";

// ─── Defaults (portail historique = Kinshasa) ─────────────────────────────────
/**
 * Portail et clé par défaut utilisés par les scripts de découverte, tests, etc.
 * quand aucun portail n'est fourni explicitement.
 *
 * ⚠️  KINSHASA est le portail historique — modifier ces valeurs impacte
 *     citaconsularDiscovery.ts, securityCheck.ts, cloudflare-strategies.ts, etc.
 */
export const DEFAULT_PORTAL_URL = KINSHASA_PORTAL_URL;
export const DEFAULT_WIDGET_KEY = KINSHASA_WIDGET_KEY;
export const DEFAULT_PORTAL_SERVICE_ID = KINSHASA_DEFAULT_SERVICE_ID;

/**
 * Extrait la clé Bookitit (widget key) depuis n'importe quelle URL de portail citaconsular.es.
 * Retourne le DEFAULT_WIDGET_KEY si l'URL ne contient pas de clé reconnue.
 *
 * @example
 *   extractWidgetKey("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f.../")
 *   // → "2d01502f12dc08400e22aea87fb00ae34"
 */
export function extractWidgetKey(portalUrl: string): string {
  return (
    portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$|#)/i)?.[1] ?? DEFAULT_WIDGET_KEY
  );
}
