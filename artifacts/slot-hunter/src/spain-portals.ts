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

/** Service Pasaportes São Paulo (validé 2026-08-11). */
export const SAOPOLO_DEFAULT_SERVICE_ID = "bkt853215";

// ─── Cuba / La Habana (LMD) ──────────────────────────────────────────────────
/** URL complète du widget Bookitit pour le portail Cuba (La Habana / LMD). */
export const CUBA_LMD_PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

/** Clé Bookitit extraite de l'URL (publickey / widgetId) — portail Cuba LMD. */
export const CUBA_LMD_WIDGET_KEY = "28330379fc95acafd31ee9e8938c278ff";

// ─── Cameroun (Yaoundé) ───────────────────────────────────────────────────────
/** Clé Bookitit — portail Cameroun. */
export const CAMEROON_WIDGET_KEY = "2c7359283dfa615bb8bf086b630561d9d";

// ─── Proxy résidentiel Decodo (gate.decodo.com) ───────────────────────────────
/**
 * Portails qui exigent le proxy résidentiel rotatif (gate.decodo.com).
 * Le range ISP Decodo (isp.decodo.com) est grillé sur citaconsular.es pour ces portails.
 * Validé 2026-08-11 : ISP ports 10001-10005 → 0B sur /main/ ; résidentiel → 128KB OK.
 */
export const RESIDENTIAL_PROXY_PORTALS = new Set([
  SAOPOLO_WIDGET_KEY,
  CUBA_LMD_WIDGET_KEY,
]);

/**
 * Retourne le type de proxy recommandé pour un portail donné.
 * @param widgetKey - Clé Bookitit du portail (publickey)
 * @returns "residential" (gate.decodo.com) ou "isp" (isp.decodo.com)
 */
export function getPortalProxyType(widgetKey: string): "residential" | "isp" {
  return RESIDENTIAL_PROXY_PORTALS.has(widgetKey) ? "residential" : "isp";
}

/**
 * Retourne l'URL du proxy résidentiel Decodo (gate.decodo.com) depuis les env vars.
 * Si SPAIN_RESIDENTIAL_PROXY_URL est défini, l'utilise ; sinon tente de dériver
 * depuis DECODO_PROXY_URL en remplaçant isp.decodo.com → gate.decodo.com.
 *
 * @param portOffset - Décalage de port optionnel (0 = port de base, 1 = port+1, etc.)
 */
export function getResidentialProxyUrl(portOffset = 0): string | undefined {
  const base = process.env.SPAIN_RESIDENTIAL_PROXY_URL;
  if (!base) return undefined;
  if (portOffset === 0) return base;
  try {
    const u = new URL(base);
    const basePort = parseInt(u.port || "10001", 10);
    u.port = String(((basePort - 10001 + portOffset) % 10) + 10001);
    return u.toString();
  } catch {
    return base;
  }
}

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

/** Construit l'URL widget citaconsular.es à partir d'une clé Bookitit (publickey). */
export function buildPortalUrlFromWidgetKey(widgetKey: string): string {
  return `https://www.citaconsular.es/es/hosteds/widgetdefault/${widgetKey}/`;
}

/**
 * Format log-safe pour une URL portail — ne tronque jamais au milieu de la publickey.
 * Les URLs widget font ~87 chars ; un slice(0, 80) coupe la clé et crée des faux positifs
 * de "mutation" (ex: …87fb au lieu de …87fb00ae34/).
 */
export function formatPortalUrlForLog(url: string): string {
  const key = extractWidgetKey(url);
  if (key !== DEFAULT_WIDGET_KEY || url.includes(key)) {
    return `…/widgetdefault/${key}/`;
  }
  return url.length > 100 ? `${url.slice(0, 100)}…` : url;
}
