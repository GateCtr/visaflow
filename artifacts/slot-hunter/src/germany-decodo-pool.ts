/**
 * germany-decodo-pool.ts — Pool d'IPs Decodo dédié à l'Allemagne
 *
 * Ordre de priorité pour construire le pool :
 *
 *  1. Fichier CSV (GERMANY_DECODO_PROXY_FILE ou ./decodo-proxies-germany.csv par défaut)
 *     Format : une ligne par IP → "host:port:username:password"
 *     Ex: dc.decodo.com:10001:spz617nelm:tmsxV4r_tP6qu8AH0q
 *
 *  2. Variable d'env GERMANY_DECODO_PROXY_URLS (URLs complètes séparées par des virgules)
 *
 *  3. Variable d'env GERMANY_DECODO_PROXY_URL (URL unique — fallback)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parseProxyCsv(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const urls: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split(":");
      if (parts.length < 4) {
        console.warn(`[germany-decodo] ⚠️ Ligne CSV ignorée (format invalide): "${line}"`);
        continue;
      }
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":");
      urls.push(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`);
    }
    return urls;
  } catch (err) {
    console.warn(`[germany-decodo] ⚠️ Impossible de lire le fichier CSV: ${err}`);
    return [];
  }
}

function parseGermanyDecodoPool(): string[] {
  // 1. Fichier CSV dédié Germany
  const defaultCsvPath = resolve(process.cwd(), "decodo-proxies-germany.csv");
  const csvPath = process.env["GERMANY_DECODO_PROXY_FILE"]
    ? resolve(process.env["GERMANY_DECODO_PROXY_FILE"])
    : defaultCsvPath;

  if (existsSync(csvPath)) {
    const urls = parseProxyCsv(csvPath);
    if (urls.length > 0) {
      console.log(`[germany-decodo] 📄 Pool chargé depuis fichier CSV: ${urls.length} IP(s) (${csvPath})`);
      return urls;
    }
  }

  // 2. GERMANY_DECODO_PROXY_URLS (liste d'URLs complètes)
  const multi = process.env["GERMANY_DECODO_PROXY_URLS"];
  if (multi) {
    const urls = multi.split(",").map((u) => u.trim()).filter(Boolean);
    if (urls.length > 0) return urls;
  }

  // 3. GERMANY_DECODO_PROXY_URL (URL unique)
  const single = process.env["GERMANY_DECODO_PROXY_URL"];
  if (single) return [single.trim()];

  return [];
}

let _index = 0;
let _cachedPool: string[] | undefined;

function getPool(): string[] {
  if (_cachedPool === undefined) {
    _cachedPool = parseGermanyDecodoPool();
  }
  return _cachedPool;
}

export function reloadGermanyDecodoPool(): void {
  _cachedPool = undefined;
  _index = 0;
}

export function hasGermanyDecodoProxy(): boolean {
  return getPool().length > 0;
}

export function getCurrentGermanyDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  return pool[_index % pool.length];
}

export function rotateGermanyDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  if (pool.length > 1) {
    _index = (_index + 1) % pool.length;
  }
  const url = pool[_index % pool.length];
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  console.log(
    `[germany-decodo] 🔄 Rotation IP — [${(_index % pool.length) + 1}/${pool.length}] ${masked.slice(0, 80)}`,
  );
  return url;
}
