/**
 * cev-decodo-pool.ts — Pool d'IPs Decodo pour le CEV
 *
 * Assignation sticky par compte (1 IP dédiée par accountId, déterministe par hash).
 * Tous les dossiers du même compte partagent la même IP Decodo.
 *
 * Sources de pool (priorité) :
 *  1. Fichier CSV (DECODO_PROXY_FILE ou ./decodo-proxies.csv par défaut)
 *     Format : "host:port:username:password" (une ligne par IP)
 *  2. Variable d'env DECODO_PROXY_URLS (URLs complètes séparées par des virgules)
 *  3. Variable d'env DECODO_PROXY_URL (URL unique — toujours assignée au compte)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ─── Parsing CSV ─────────────────────────────────────────────────────────────

/** Parse le CSV → URLs. Accepte URL complète (http://…) ou host:port:user:pass. */
function parseProxyCsv(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const urls: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      // Format A : URL complète
      if (line.startsWith("http://") || line.startsWith("https://")) {
        try { new URL(line); urls.push(line); continue; } catch { /* invalide */ }
      }

      // Format B : host:port:username:password
      const parts = line.split(":");
      if (parts.length < 4) {
        console.warn(`[cev-decodo] ⚠️ Ligne CSV ignorée (format invalide): "${line}"`);
        continue;
      }
      const [host, port, user, ...passParts] = parts;
      const pass = passParts.join(":");
      urls.push(`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`);
    }
    return urls;
  } catch (err) {
    console.warn(`[cev-decodo] ⚠️ Impossible de lire le fichier CSV: ${err}`);
    return [];
  }
}

function parsePool(): string[] {
  // 1a. Fichier CSV dédié CEV (cev-decodo-proxies.csv) — priorité maximale
  const cevCsvPath = process.env.CEV_DECODO_PROXY_FILE
    ? resolve(process.env.CEV_DECODO_PROXY_FILE)
    : resolve(process.cwd(), "cev-decodo-proxies.csv");
  if (existsSync(cevCsvPath)) {
    const urls = parseProxyCsv(cevCsvPath);
    if (urls.length > 0) {
      console.log(`[cev-decodo] 📄 Pool chargé depuis CSV CEV: ${urls.length} IP(s) (${cevCsvPath})`);
      return urls;
    }
  }

  // 1b. Fichier CSV partagé (decodo-proxies.csv)
  const defaultCsvPath = resolve(process.cwd(), "decodo-proxies.csv");
  const csvPath = process.env.DECODO_PROXY_FILE
    ? resolve(process.env.DECODO_PROXY_FILE)
    : defaultCsvPath;

  if (existsSync(csvPath)) {
    const urls = parseProxyCsv(csvPath);
    if (urls.length > 0) {
      console.log(`[cev-decodo] 📄 Pool chargé depuis CSV: ${urls.length} IP(s) (${csvPath})`);
      return urls;
    }
  }

  // 2. DECODO_PROXY_URLS (liste d'URLs)
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

let _cachedPool: string[] | undefined;

function getPool(): string[] {
  if (_cachedPool === undefined) {
    _cachedPool = parsePool();
  }
  return _cachedPool;
}

/** Force le rechargement du pool (si le fichier a changé). */
export function reloadCevDecodoPool(): void {
  _cachedPool = undefined;
}

// ─── Rotation count — injecté depuis cev-shared-impit pour éviter import circulaire ──

/** Callback pour lire le compteur de rotation par compte (injecté par cev-shared-impit). */
let _getCevDecodoRotationCount: (accountKey: string) => number = () => 0;

/** Injecte la fonction de lecture du compteur de rotation. Appelé au démarrage par cev-shared-impit. */
export function setCevDecodoRotationCountFn(fn: (accountKey: string) => number): void {
  _getCevDecodoRotationCount = fn;
}

/** Retourne true si au moins une IP Decodo est configurée. */
export function hasCevDecodoProxy(): boolean {
  return getPool().length > 0;
}

/** Retourne le nombre d'IPs dans le pool. */
export function getCevDecodoPoolSize(): number {
  return getPool().length;
}

/**
 * Retourne l'URL Decodo assignée à ce compte (sticky par hash d'accountId).
 *
 * Tous les dossiers du même compte partagent la même IP.
 * En cas d'erreur de connexion, rotateCevDecodoSession(accountId) incrémente
 * le compteur de rotation → l'index est décalé → nouvelle IP assignée.
 *
 * @param accountId - Identifiant du compte CEV (même pour tous ses dossiers)
 * @returns URL proxy ou undefined si pool vide
 */
export function getCevDecodoUrlForAccount(accountId: string): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;

  // Hash déterministe sur l'accountId
  const key = accountId.toLowerCase();
  let hash = 0;
  for (const ch of key) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
  const baseIdx = Math.abs(hash) % pool.length;

  // Décaler l'index selon le compteur de rotation (incrémenté par rotateCevDecodoSession)
  // Permet de changer d'IP sans changer d'accountId quand l'IP assignée est morte.
  // Import dynamique évité — le Map est accessible directement depuis cev-shared-impit
  // via la fonction exportée getCevDecodoRotationCount.
  const rotationCount = _getCevDecodoRotationCount(key);
  const idx = (baseIdx + rotationCount) % pool.length;

  const url = pool[idx];
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  if (rotationCount > 0) {
    console.log(`[cev-decodo] 🔒 Compte ${key.slice(0, 16)}… → IP [${idx + 1}/${pool.length}] (rotation #${rotationCount}) ${masked.slice(0, 70)}`);
  } else {
    console.log(`[cev-decodo] 🔒 Compte ${key.slice(0, 16)}… → IP [${idx + 1}/${pool.length}] ${masked.slice(0, 70)}`);
  }
  return url;
}
