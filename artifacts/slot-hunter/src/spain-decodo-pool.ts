/**
 * spain-decodo-pool.ts — Pool d'IPs Decodo pour l'Espagne
 *
 * Supporte deux modes :
 *
 * Mode A — IPs dédiées (ports fixes) :
 *   DECODO_PROXY_URLS=http://user:pass@dc.decodo.com:10010,http://user:pass@dc.decodo.com:10011,...
 *   → chaque URL = une IP physique différente (port 10010, 10011…)
 *   → rotation round-robin en changeant d'URL dans le pool
 *   → le "-sessionid-XXXX" du username est IGNORÉ par ce type de proxy
 *
 * Mode B — Proxy résidentiel/rotatif (fallback) :
 *   DECODO_PROXY_URL=http://user:pass@dc.decodo.com:PORT
 *   → URL unique, rotation via "-sessionid-XXXX" dans le username (comportement d'origine)
 *
 * DECODO_PROXY_URLS est prioritaire sur DECODO_PROXY_URL.
 */

function parseDecodoPool(): string[] {
  const multi = process.env.DECODO_PROXY_URLS;
  if (multi) {
    const urls = multi
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length > 0) return urls;
  }
  const single = process.env.DECODO_PROXY_URL;
  if (single) return [single.trim()];
  return [];
}

// Index courant dans le pool (commence à 0, incrémenté à chaque rotation)
let _index = 0;

/** Parse le pool depuis l'env à chaque appel (tient compte des changements runtime). */
function getPool(): string[] {
  return parseDecodoPool();
}

/** Retourne true si au moins une URL Decodo est configurée. */
export function hasDecodoProxy(): boolean {
  return getPool().length > 0;
}

/**
 * Retourne l'URL Decodo courante (sans avancer le compteur).
 * C'est l'IP qui sera utilisée par le browser ET par impit pour les requêtes HTTP.
 */
export function getCurrentDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  return pool[_index % pool.length];
}

/**
 * Avance vers la prochaine URL du pool et la retourne.
 *
 * Pour un pool d'IPs dédiées (DECODO_PROXY_URLS, plusieurs ports),
 * cela change réellement l'IP physique.
 *
 * Pour une URL unique (DECODO_PROXY_URL), retourne simplement la même URL —
 * la rotation sessionid est gérée dans spain-persistent-browser.ts.
 */
export function rotateDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  if (pool.length > 1) {
    _index = (_index + 1) % pool.length;
  }
  const url = pool[_index % pool.length];
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  console.log(
    `[spain-decodo] 🔄 Rotation IP — [${(_index % pool.length) + 1}/${pool.length}] ${masked.slice(0, 80)}`,
  );
  return url;
}

/**
 * Retourne true si le pool contient plusieurs URLs distinctes (IPs dédiées à ports fixes).
 * Dans ce cas, la rotation doit changer d'URL, pas de sessionid.
 */
export function isDecodoMultiPool(): boolean {
  return getPool().length > 1;
}
