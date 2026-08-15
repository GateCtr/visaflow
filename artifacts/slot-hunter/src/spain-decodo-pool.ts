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
 *
 * PERSISTANCE REDIS :
 *   - L'index de rotation est sauvegardé dans Redis après chaque rotation.
 *     Au redémarrage, on reprend là où on s'était arrêté (fallback aléatoire si absent).
 *   - Les IPs flaguées (0B /main/, block CF) sont mémorisées avec un TTL configurable
 *     (SPAIN_DECODO_BLACKLIST_TTL_MIN, défaut 45 min). Elles sont sautées par la rotation
 *     pendant le TTL. Si toutes les IPs sont flaguées, fallback round-robin complet.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  syncDecodoPoolStateToRedis,
  restoreDecodoPoolStateFromRedis,
} from "./spain-redis-persistence.js";

/** TTL blacklist en ms — configurable via SPAIN_DECODO_BLACKLIST_TTL_MIN (défaut 45 min). */
function getBlacklistTtlMs(): number {
  return parseInt(process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN || "45", 10) * 60_000;
}

/** Parse le fichier CSV → tableau d'URLs http://user:pass@host:port
 *
 * Deux formats acceptés :
 *   A. URL complète   → http://user:pass@host:port   (une par ligne)
 *   B. Champs séparés → host:port:username:password
 */
function parseProxyCsv(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const urls: string[] = [];
    for (const raw of content.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;

      // Format A : URL complète
      if (line.startsWith("http://") || line.startsWith("https://")) {
        try {
          new URL(line); // valider
          urls.push(line);
          continue;
        } catch {
          console.warn(`[spain-decodo] ⚠️ URL invalide ignorée: "${line}"`);
          continue;
        }
      }

      // Format B : host:port:username:password
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

// ─── Fingerprint ───────────────────────────────────────────────────────────────

/**
 * Calcule une empreinte du pool : "<taille>:<sha256-8hex des URLs concaténées>".
 * Permet de détecter tout changement de composition (ajout, suppression, réordonnancement).
 */
function computePoolFingerprint(pool: string[]): string {
  const hash = createHash("sha256").update(pool.join("\n")).digest("hex").slice(0, 8);
  return `${pool.length}:${hash}`;
}

// ─── État du pool ──────────────────────────────────────────────────────────────

// Index courant dans le pool (round-robin)
let _index = 0;
// Cache du pool (re-parsé si undefined)
let _cachedPool: string[] | undefined;
// IPs blacklistées : URL complète → timestamp du flagging (ms)
let _blacklistedIps = new Map<string, number>();
// true dès que initDecodoPool() a été appelé (évite double init)
let _poolInitialized = false;

function getPool(): string[] {
  // Re-parse au premier appel seulement (le fichier ne change pas à chaud)
  if (_cachedPool === undefined) {
    _cachedPool = parseDecodoPool();
  }
  return _cachedPool;
}

// ─── Blacklist helpers ─────────────────────────────────────────────────────────

/** Vérifie si une URL est actuellement blacklistée (TTL expirés auto-purgés). */
export function isDecodoIpBlacklisted(url: string): boolean { return isBlacklisted(url); }
function isBlacklisted(url: string): boolean {
  const ts = _blacklistedIps.get(url);
  if (ts === undefined) return false;
  if (Date.now() - ts > getBlacklistTtlMs()) {
    _blacklistedIps.delete(url); // auto-expire en mémoire
    return false;
  }
  return true;
}

/**
 * Trouve le premier index non-blacklisté en partant de `startIdx`.
 * Retourne startIdx si toutes les IPs sont blacklistées (fallback round-robin).
 *
 * @param startIdx - Index de départ (inclusif)
 * @param pool     - Pool d'URLs
 * @returns { idx, allBlacklisted, skipped }
 */
function findNextValidIndex(
  startIdx: number,
  pool: string[],
): { idx: number; allBlacklisted: boolean; skipped: number } {
  let idx = startIdx % pool.length;
  let skipped = 0;
  while (isBlacklisted(pool[idx]) && skipped < pool.length) {
    idx = (idx + 1) % pool.length;
    skipped++;
  }
  const allBlacklisted = skipped >= pool.length;
  return { idx, allBlacklisted, skipped };
}

// ─── API publique ──────────────────────────────────────────────────────────────

/** Force le re-chargement du pool (utile si le fichier a changé). */
export function reloadDecodoPool(): void {
  _cachedPool = undefined;
  _index = 0;
  _blacklistedIps.clear();
  _poolInitialized = false;
}

/** Retourne true si au moins une URL Decodo est configurée. */
export function hasDecodoProxy(): boolean {
  return getPool().length > 0;
}

/**
 * Initialise le pool Decodo depuis Redis.
 *
 * - Restaure l'index de rotation (reprend au proxy suivant celui d'avant le restart).
 * - Restaure la blacklist d'IPs flaguées (filtre les TTL expirés).
 * - Fallback aléatoire si Redis vide/indisponible.
 *
 * Doit être appelé après initSpainRedis() au démarrage de l'application.
 * Idempotent — les appels suivants sont ignorés.
 */
export async function initDecodoPool(): Promise<void> {
  if (_poolInitialized) return;
  _poolInitialized = true;

  const pool = getPool();
  if (pool.length <= 1) {
    // Pool d'une seule IP ou vide → pas de rotation utile
    if (pool.length === 1) {
      console.log("[spain-decodo] ℹ️ Pool unique (1 IP) — persistance index ignorée");
    }
    return;
  }

  const currentFingerprint = computePoolFingerprint(pool);
  const state = await restoreDecodoPoolStateFromRedis(getBlacklistTtlMs()).catch(() => null);
  if (state) {
    // ── Vérification de l'empreinte du pool ────────────────────────────────
    // Si le fichier CSV a changé (IPs ajoutées/supprimées/réordonnées), ou si
    // l'état Redis ne contient pas d'empreinte (entrée écrite avant ce correctif),
    // l'index sauvegardé peut pointer vers une IP différente ou être hors-limites.
    // Dans tous ces cas on invalide index + blacklist et on repart à 0.
    const fingerprintMissing = typeof state.poolFingerprint !== "string";
    const fingerprintMismatch = !fingerprintMissing && state.poolFingerprint !== currentFingerprint;

    if (fingerprintMissing || fingerprintMismatch) {
      const reason = fingerprintMissing
        ? "empreinte absente (état antérieur au correctif)"
        : `empreinte: ${state.poolFingerprint} → ${currentFingerprint}`;
      console.warn(
        `[spain-decodo] ⚠️ Composition du pool non vérifiable depuis la dernière sauvegarde ` +
        `(${reason}) — index et blacklist invalidés, démarrage à l'index 0`,
      );
      _index = 0;
      _blacklistedIps = new Map();
      // Persister l'état réinitialisé avec la nouvelle empreinte
      syncDecodoPoolStateToRedis(_index, _blacklistedIps, currentFingerprint);
      return;
    }

    // Restaurer l'index (le sauvegarder pointe sur la DERNIÈRE IP utilisée,
    // donc on reprend à +1 pour ne pas taper deux fois la même IP au restart)
    const restoredIdx = (state.rotationIndex + 1) % pool.length;
    _blacklistedIps = new Map(
      Object.entries(state.blacklistedIps).map(([k, v]) => [k, Number(v)]),
    );

    // Avancer l'index jusqu'à une IP non-blacklistée
    const { idx, allBlacklisted, skipped } = findNextValidIndex(restoredIdx, pool);
    _index = idx;

    const blacklistCount = _blacklistedIps.size;
    const source = "Redis";
    console.log(
      `[spain-decodo] ♻️ Index restauré (${source}) → [${_index + 1}/${pool.length}]` +
      (skipped > 0 ? ` (${skipped} IP${skipped > 1 ? "s" : ""} blacklistée${skipped > 1 ? "s" : ""} sautée${skipped > 1 ? "s" : ""})` : "") +
      (blacklistCount > 0 ? ` | blacklist: ${blacklistCount}/${pool.length} IP${blacklistCount > 1 ? "s" : ""}` : "") +
      (allBlacklisted ? " ⚠️ POOL ÉPUISÉ — fallback round-robin" : ""),
    );
  } else {
    // Fallback : index aléatoire (évite de concentrer le trafic sur l'IP n°1 à chaque restart)
    _index = Math.floor(Math.random() * pool.length);
    console.log(
      `[spain-decodo] 🎲 Redis absent/vide — index aléatoire → [${_index + 1}/${pool.length}]`,
    );
  }
}

/**
 * Retourne l'URL Decodo courante (sans avancer le compteur).
 * C'est l'IP qui sera utilisée par le browser ET par impit pour les requêtes HTTP.
 * Si l'IP courante est blacklistée, retourne la prochaine IP valide sans avancer l'index.
 */
export function getCurrentDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;

  const current = pool[_index % pool.length];
  if (!isBlacklisted(current)) return current;

  // IP courante blacklistée : chercher la prochaine valide sans modifier _index
  const { idx, allBlacklisted } = findNextValidIndex((_index + 1) % pool.length, pool);
  if (allBlacklisted) {
    // Toutes les IPs blacklistées → fallback round-robin complet (retourner l'actuelle)
    return current;
  }
  return pool[idx];
}

/**
 * Marque une IP Decodo comme flaguée (blacklist temporaire avec TTL).
 *
 * L'IP sera sautée par getCurrentDecodoUrl() et rotateDecodoUrl() pendant le TTL.
 * Sans effet si le pool contient ≤ 1 IP (pas de rotation possible).
 *
 * @param url    - URL complète du proxy (telle que retournée par getCurrentDecodoUrl)
 * @param reason - Raison du flag (pour les logs)
 */
export function flagDecodoIp(url: string | undefined, reason: string): void {
  if (!url) return;
  const pool = getPool();
  if (pool.length <= 1) return; // inutile si pool d'une seule IP

  const ttlMin = Math.round(getBlacklistTtlMs() / 60_000);
  const masked = url.replace(/:([^:@]+)@/, ":***@");
  const ipIdx = pool.indexOf(url);
  const idxLabel = ipIdx >= 0 ? `[${ipIdx + 1}/${pool.length}]` : `[?/${pool.length}]`;
  console.warn(
    `[spain-decodo] 🚫 IP blacklistée ${idxLabel} (${reason}, TTL ${ttlMin}min) — ${masked.slice(0, 60)}`,
  );
  _blacklistedIps.set(url, Date.now());
  syncDecodoPoolStateToRedis(_index, _blacklistedIps, computePoolFingerprint(pool));
}

/**
 * Avance vers la prochaine URL du pool et la retourne.
 * Saute les IPs blacklistées. Si toutes les IPs sont blacklistées,
 * revient au comportement round-robin complet (avec un warning).
 *
 * Pour un pool multi-URLs (IPs dédiées à ports fixes), cela change réellement l'IP.
 * Pour une URL unique, retourne la même URL — la rotation sessionid est gérée
 * dans spain-persistent-browser.ts.
 */
export function rotateDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  if (pool.length === 1) {
    // Pool d'une seule IP : pas de rotation possible
    return pool[0];
  }

  // Avancer d'au moins 1 position
  const nextCandidate = (_index + 1) % pool.length;

  // Trouver la prochaine IP non-blacklistée
  const { idx, allBlacklisted, skipped } = findNextValidIndex(nextCandidate, pool);
  _index = idx;

  const url = pool[_index];
  const masked = url.replace(/:([^:@]+)@/, ":***@");

  if (allBlacklisted) {
    // Toutes les IPs sont flaguées → fallback round-robin complet avec warning
    console.warn(
      `[spain-decodo] ⚠️ Toutes les IPs blacklistées (${_blacklistedIps.size}/${pool.length}) — ` +
      `fallback round-robin [${_index + 1}/${pool.length}] ${masked.slice(0, 60)}`,
    );
  } else {
    const skipMsg = skipped > 0
      ? ` (${skipped} IP${skipped > 1 ? "s" : ""} blacklistée${skipped > 1 ? "s" : ""} sautée${skipped > 1 ? "s" : ""})`
      : "";
    console.log(
      `[spain-decodo] 🔄 Rotation IP — [${_index + 1}/${pool.length}] ${masked.slice(0, 80)}${skipMsg}`,
    );
  }

  // Persister le nouvel index dans Redis (fire-and-forget)
  syncDecodoPoolStateToRedis(_index, _blacklistedIps, computePoolFingerprint(pool));

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

/**
 * Retourne l'URL à l'index donné (modulo taille du pool).
 * Utilisé par capsolver-residential pour la rotation manuelle avec tracking de ports mauvais.
 */
export function getDecodoProxyForIndex(idx: number): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  return pool[idx % pool.length];
}
