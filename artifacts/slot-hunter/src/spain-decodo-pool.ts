/**
 * spain-decodo-pool.ts — Pool d'IPs Decodo pour l'Espagne
 *
 * Ordre de priorité pour construire le pool :
 *
 *  1. Fichier CSV (DECODO_PROXY_FILE ou ./decodo-proxies.csv par défaut)
 *     Format : une ligne par IP → "host:port:username:password"
 *     Ex: dc.decodo.com:10001:sphgi7znzc:TZhC3m4byb_hN96kuw
 *
 *  2. Variable d'env DECODO_PROXY_URLS (URLs complètes séparées par des virgules)
 *     Ex: http://user:pass@dc.decodo.com:10001,http://user:pass@dc.decodo.com:10002
 *
 *  3. Variable d'env DECODO_PROXY_URL (URL unique — fallback résidentiel/rotatif)
 *     Ex: http://user:pass@dc.decodo.com:10001
 *     → rotation via "-sessionid-XXXX" dans le username (comportement d'origine)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Parse le fichier CSV → tableau d'URLs http://user:pass@host:port */
function parseProxyCsv(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const urls: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 4) {
        console.warn(`[spain-decodo] ⚠️ Ligne CSV ignorée (format invalide): "${line}"`);
        continue;
      }
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":"); // au cas où le mot de passe contiendrait un ":"
      urls.push(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`);
    }
    return urls;
  } catch (err) {
    console.warn(`[spain-decodo] ⚠️ Impossible de lire le fichier CSV: ${err}`);
    return [];
  }
}

function parseDecodoPool(): string[] {
  // 1. Fichier CSV
  const defaultCsvPath = resolve(process.cwd(), "decodo-proxies.csv");
  const csvPath = process.env.DECODO_PROXY_FILE
    ? resolve(process.env.DECODO_PROXY_FILE)
    : defaultCsvPath;

  if (existsSync(csvPath)) {
    const urls = parseProxyCsv(csvPath);
    if (urls.length > 0) {
      console.log(`[spain-decodo] 📄 Pool chargé depuis fichier CSV: ${urls.length} IP(s) (${csvPath})`);
      return urls;
    }
  }

  // 2. DECODO_PROXY_URLS (liste d'URLs complètes)
  const multi = process.env.DECODO_PROXY_URLS;
  if (multi) {
    const urls = multi.split(",").map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }

  // 3. DECODO_PROXY_URL (URL unique)
  const single = process.env.DECODO_PROXY_URL;
  if (single) return [single.trim()];

  return [];
}

// Index courant dans le pool (round-robin)
let _index = 0;
// Cache du pool (re-parsé si undefined)
let _cachedPool: string[] | undefined;

function getPool(): string[] {
  // Re-parse au premier appel seulement (le fichier ne change pas à chaud)
  if (_cachedPool === undefined) {
    _cachedPool = parseDecodoPool();
  }
  return _cachedPool;
}

/** Force le re-chargement du pool (utile si le fichier a changé). */
export function reloadDecodoPool(): void {
  _cachedPool = undefined;
  _index = 0;
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
 * Pour un pool multi-URLs (IPs dédiées à ports fixes), cela change réellement l'IP.
 * Pour une URL unique, retourne la même URL — la rotation sessionid est gérée
 * dans spain-persistent-browser.ts.
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

/** True si le pool contient plusieurs URLs (IPs dédiées à ports fixes). */
export function isDecodoMultiPool(): boolean {
  return getPool().length > 1;
}

/** Retourne le nombre d'IPs dans le pool (0 si non configuré). */
export function getDecodoPoolSize(): number {
  return getPool().length;
}
