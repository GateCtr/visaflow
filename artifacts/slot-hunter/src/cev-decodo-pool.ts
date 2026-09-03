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
import { syncCevDecodoBlacklistToRedis, restoreCevDecodoBlacklistFromRedis } from "./cev-redis-persistence.js";

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

// ─── Blacklist des IP mortes (porté de spain-decodo-pool) ───────────────────────
//
// Une IP qui échoue (422/502/tunnel) est blacklistée avec un TTL. Pendant ce TTL,
// getCevDecodoUrlForAccount / getCevDecodoUrlForIndex la SAUTENT et prennent la
// prochaine IP propre du pool → on ne retombe jamais sur un port mort. Aligné Spain.

/** IPs blacklistées : base-URL (sans sticky) → timestamp du flagging (ms). */
const _cevBlacklistedIps = new Map<string, number>();

/** TTL blacklist (ms) — configurable via CEV_DECODO_BLACKLIST_TTL_MIN, défaut 30 min. */
function getCevBlacklistTtlMs(): number {
  return (parseInt(process.env.CEV_DECODO_BLACKLIST_TTL_MIN || "30", 10) || 30) * 60_000;
}

/**
 * Normalise une URL proxy Decodo en retirant le suffixe sticky du username
 * (-sessid-XXXX-sesstime-NN) → clé de blacklist stable par IP physique (host:port + user base).
 */
function baseProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username)
      .replace(/-sessid-[^-]*/g, "")
      .replace(/-sesstime-[^-]*/g, "")
      .replace(/-+$/, "");
    u.username = encodeURIComponent(user);
    return u.toString();
  } catch {
    return url;
  }
}

/** Vérifie si une URL Decodo est actuellement blacklistée (TTL expirés auto-purgés). */
export function isCevDecodoBlacklisted(url: string): boolean {
  const base = baseProxyUrl(url);
  const ts = _cevBlacklistedIps.get(base);
  if (ts === undefined) return false;
  if (Date.now() - ts > getCevBlacklistTtlMs()) {
    _cevBlacklistedIps.delete(base);
    return false;
  }
  return true;
}

/**
 * Blackliste une IP Decodo pour la durée du TTL (elle sera sautée par les sélecteurs).
 * @param url    URL proxy (sticky ou base) ayant échoué
 * @param reason motif (log)
 */
export function flagCevDecodoIp(url: string | undefined, reason: string): void {
  if (!url) return;
  const pool = getPool();
  if (pool.length <= 1) return; // inutile si pool d'une seule IP
  const base = baseProxyUrl(url);
  _cevBlacklistedIps.set(base, Date.now());
  const ttlMin = Math.round(getCevBlacklistTtlMs() / 60_000);
  const masked = base.replace(/:([^:@]+)@/, ":***@");
  const activeCount = [..._cevBlacklistedIps.values()].filter(ts => Date.now() - ts <= getCevBlacklistTtlMs()).length;
  console.warn(`[cev-decodo] 🚫 IP blacklistée (${reason}, TTL ${ttlMin}min, ${activeCount}/${pool.length}) — ${masked.slice(0, 60)}`);
  // Persister la blacklist en Redis (survit aux redémarrages) — fire-and-forget.
  syncCevDecodoBlacklistToRedis(_cevBlacklistedIps);
}

/**
 * Restaure la blacklist Decodo depuis Redis au démarrage (filtre les TTL expirés).
 * Idempotent. À appeler après initCevRedis().
 */
export async function restoreCevDecodoBlacklist(): Promise<void> {
  try {
    const restored = await restoreCevDecodoBlacklistFromRedis(getCevBlacklistTtlMs());
    for (const [base, ts] of restored) _cevBlacklistedIps.set(base, ts);
  } catch { /* non-bloquant */ }
}

/**
 * À partir de startIdx, trouve le premier index d'IP NON blacklistée.
 * Retourne startIdx si toutes sont blacklistées (fallback round-robin complet).
 */
function findNextValidCevIndex(startIdx: number, pool: string[]): { idx: number; allBlacklisted: boolean; skipped: number } {
  let idx = ((startIdx % pool.length) + pool.length) % pool.length;
  let skipped = 0;
  while (isCevDecodoBlacklisted(pool[idx]) && skipped < pool.length) {
    idx = (idx + 1) % pool.length;
    skipped++;
  }
  return { idx, allBlacklisted: skipped >= pool.length, skipped };
}

/** Force le rechargement du pool (si le fichier a changé). */
export function reloadCevDecodoPool(): void {
  _cachedPool = undefined;
  _cevBlacklistedIps.clear();
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
  const rawIdx = (baseIdx + rotationCount) % pool.length;

  // Sauter les IP blacklistées (mortes) → prendre la prochaine propre du pool.
  const { idx, allBlacklisted, skipped } = findNextValidCevIndex(rawIdx, pool);

  const url = pool[idx];
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  const skipMsg = skipped > 0 ? ` (${skipped} IP blacklistée(s) sautée(s))` : "";
  const rotMsg = rotationCount > 0 ? ` (rotation #${rotationCount})` : "";
  if (allBlacklisted) {
    console.warn(`[cev-decodo] ⚠️ Compte ${key.slice(0, 16)}… — TOUTES les IP blacklistées → fallback IP [${idx + 1}/${pool.length}] ${masked.slice(0, 60)}`);
  } else {
    console.log(`[cev-decodo] 🔒 Compte ${key.slice(0, 16)}… → IP [${idx + 1}/${pool.length}]${rotMsg}${skipMsg} ${masked.slice(0, 70)}`);
  }
  return url;
}

/**
 * Retourne l'URL Decodo à un index donné (modulo taille du pool).
 *
 * Utilisé pour l'assignation par accountIndex (sans collision entre comptes tant
 * que #comptes ≤ #IP) combinée à la réservation Redis : le loop tente accountIndex,
 * puis accountIndex+1, +2… jusqu'à trouver une IP non réservée par un autre compte.
 *
 * @param idx - Index (sera pris modulo la taille du pool)
 * @returns URL proxy ou undefined si pool vide
 */
export function getCevDecodoUrlForIndex(idx: number): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  const realIdx = ((idx % pool.length) + pool.length) % pool.length;
  return pool[realIdx];
}

/**
 * Rotation "façon Spain" : blackliste l'IP courante (morte) et retourne la PROCHAINE
 * IP PROPRE du pool (non blacklistée), en repartant juste après l'IP courante.
 *
 * Contrairement à une simple régénération de sessid (qui peut retomber sur le même
 * port mort), cette rotation SAUTE les IP blacklistées et avance dans le pool CSV.
 * Utilisé par cevImpitFetch sur 422/502/tunnel error.
 *
 * @param currentUrl URL Decodo actuelle (sticky ou base) qui a échoué
 * @param reason     motif de blacklist (log)
 * @returns nouvelle URL de base d'une IP propre, ou undefined si pool vide/toutes mortes
 */
export function rotateToNextCleanCevDecodo(currentUrl: string | undefined, reason: string): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  if (currentUrl) flagCevDecodoIp(currentUrl, reason);
  if (pool.length === 1) {
    // Pool d'une seule IP : pas d'alternative, on ne peut que retenter la même.
    return pool[0];
  }
  // Trouver l'index de l'IP courante (par base-URL), repartir juste après.
  const curBase = currentUrl ? baseProxyUrl(currentUrl) : "";
  let curIdx = pool.findIndex(u => baseProxyUrl(u) === curBase);
  if (curIdx < 0) curIdx = 0;
  const { idx, allBlacklisted, skipped } = findNextValidCevIndex((curIdx + 1) % pool.length, pool);
  const url = pool[idx];
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  if (allBlacklisted) {
    console.warn(`[cev-decodo] ⚠️ Rotation: toutes les IP blacklistées — fallback IP [${idx + 1}/${pool.length}] ${masked.slice(0, 60)}`);
  } else {
    console.log(`[cev-decodo] 🔄 Rotation IP → [${idx + 1}/${pool.length}]${skipped ? ` (${skipped} sautée(s))` : ""} ${masked.slice(0, 60)}`);
  }
  return url;
}
