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
 *     (SPAIN_DECODO_BLACKLIST_TTL_MIN, défaut 7 jours). Elles sont sautées par la rotation
 *     pendant le TTL. Si toutes les IPs sont flaguées, aucune IP n'est retournée.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  syncDecodoPoolStateToRedis,
  restoreDecodoPoolStateFromRedis,
} from "./spain-redis-persistence.js";

/** Quarantaine indépendante du cache CF : 7 jours par défaut. */
function getBlacklistTtlMs(): number {
  const minutes = Number(process.env.SPAIN_DECODO_BLACKLIST_TTL_MIN ?? 7 * 24 * 60);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 7 * 24 * 60) * 60_000;
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

      // Format A : URL complète (http://user:pass@host:port)
      // On n'utilise PAS new URL() car Node.js rejette les ports > 65535,
      // or Decodo utilise des ports virtuels jusqu'à 110 000+.
      if (line.startsWith("http://") || line.startsWith("https://")) {
        // Validation légère : doit contenir @ et se terminer par :PORT
        if (/@.+:\d+$/.test(line)) {
          urls.push(line);
        } else {
          console.warn(`[spain-decodo] ⚠️ URL format inattendu ignorée: "${line}"`);
        }
        continue;
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

/**
 * Normalise une URL proxy en supprimant le suffixe sticky Decodo
 * (-session-XXXX-sessionduration-NN dans le username).
 *
 * Nécessaire car flagDecodoIp et isBlacklisted reçoivent des URLs sticky
 * (ex: user-session-cc4b6xqp-sessionduration-60) mais le pool contient
 * les URLs de base (ex: user). Sans normalisation :
 *   - indexOf retourne -1 → "[?/6000]" dans les logs
 *   - La blacklist clé = sticky URL → une autre sticky du même proxy n'est pas bloquée
 */
function baseProxyUrl(url: string): string {
  // On N'UTILISE PAS new URL().toString() : il ajoute un "/" final absent des entrées
  // du pool (→ indexOf = -1 → "[?/N]") et rejette les ports Decodo > 65535.
  //
  // CLÉ : les entrées du pool CSV CONTIENNENT "-sessionduration-NN" (ex.
  //   user-sp4e4cx19x-sessionduration-60). Ce segment fait partie de l'IDENTITÉ DE BASE
  //   et NE DOIT PAS être retiré (sinon la base normalisée ne matche plus le pool → "?").
  //   Seul le segment VARIABLE "-session-{sid}" (ajouté dynamiquement par addStickySession)
  //   doit être retiré. Même logique que stripStickySession côté worker.
  // Le retrait porte uniquement sur le username (entre "//" et le premier ":").
  try {
    const stripSticky = (s: string): string =>
      s
        // Sticky complet : ...-session-{sid}-sessionduration-60 → ...-sessionduration-60
        .replace(/-session-[^-:@]+(?=-sessionduration-)/g, "")
        // Sticky sans sessionduration : ...-session-{sid} en fin de username → retiré
        .replace(/-session-[^-:@]+$/g, "")
        // Rotation legacy DECODO_PROXY_URL : -sessionid-{id}
        .replace(/-sessionid-[^-:@]+/g, "");
    // Applique le nettoyage uniquement sur la portion username (avant le premier ":")
    // pour ne pas toucher au host/port/password. Format: scheme://user:pass@host:port
    const m = url.match(/^([a-z]+:\/\/)([^:@/]+)(.*)$/i);
    if (m) {
      const [, scheme, user, rest] = m;
      // On retire aussi un éventuel "/" final que d'anciennes normalisations auraient laissé.
      return `${scheme}${stripSticky(user)}${rest}`.replace(/\/+$/, "");
    }
    return url.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/** Extrait "host:port" d'une URL proxy — identité RÉELLE de l'exit IP Decodo (le
 *  username/password/sticky n'affectent pas l'exit IP, seul le port virtuel compte).
 *  Sert à retrouver l'index dans le pool de façon robuste, indépendamment du format
 *  du username (présence ou non de -sessionduration-NN / -session-{sid}). */
function proxyHostPort(url: string): string {
  const m = url.match(/@([^/@]+)(?:\/|$)/);
  return m ? m[1] : url;
}

/** Trouve l'index d'une URL dans le pool par host:port (robuste au format username).
 *  Retourne -1 si absente. */
function findPoolIndexByHostPort(url: string, pool: string[]): number {
  const target = proxyHostPort(url);
  for (let i = 0; i < pool.length; i++) {
    if (proxyHostPort(pool[i]) === target) return i;
  }
  return -1;
}

/** Vérifie si une URL est actuellement blacklistée (TTL expirés auto-purgés).
 *  Normalise les URLs sticky avant le lookup (même base IP → même entrée blacklist). */
export function isDecodoIpBlacklisted(url: string): boolean { return isBlacklisted(url); }
function isBlacklisted(url: string): boolean {
  // Clé = host:port (identité exit IP), robuste au format du username sticky.
  const key = proxyHostPort(url);
  const ts = _blacklistedIps.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts >= getBlacklistTtlMs()) {
    _blacklistedIps.delete(key); // auto-expire en mémoire
    return false;
  }
  return true;
}

/**
 * Trouve le premier index non-blacklisté en partant de `startIdx`.
 * Signale allBlacklisted si toutes les IPs sont blacklistées ; l'appelant doit
 * alors s'abstenir de retourner un proxy.
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
  if (pool.length === 0) return;

  // ── Override test-only : forcer l'index de départ ───────────────────────────
  // Si SPAIN_DECODO_START_INDEX est défini (scripts de test uniquement), on fixe
  // l'index courant et on COURT-CIRCUITE la restauration Redis / l'aléatoire.
  // Aucun effet en prod (variable absente). Permet de cibler une zone précise du
  // pool (ex: les IPs autour de l'index 8888) pour reproduire un comportement observé.
  const startOverride = process.env.SPAIN_DECODO_START_INDEX;
  if (startOverride !== undefined && startOverride !== "") {
    const n = Number(startOverride);
    if (Number.isFinite(n) && n >= 0) {
      _index = findNextValidIndex(Math.floor(n) % pool.length, pool).idx;
      console.warn(
        `[spain-decodo] 🎯 SPAIN_DECODO_START_INDEX=${startOverride} — index de départ forcé à ${_index}/${pool.length} (test)`,
      );
      return;
    }
  }

  const currentFingerprint = computePoolFingerprint(pool);
  const state = await restoreDecodoPoolStateFromRedis(getBlacklistTtlMs()).catch(() => null);
  if (state) {
    // Les rejets restent liés à host:port, même si le CSV est réordonné.
    _blacklistedIps = new Map();
    for (const [savedKey, timestamp] of Object.entries(state.blacklistedIps)) {
      const key = proxyHostPort(savedKey);
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Date.now() - ts >= getBlacklistTtlMs()) continue;
      _blacklistedIps.set(key, Math.max(_blacklistedIps.get(key) ?? 0, ts));
    }
    // ── Vérification de l'empreinte du pool ────────────────────────────────
    // Si le fichier CSV a changé (IPs ajoutées/supprimées/réordonnées), ou si
    // l'état Redis ne contient pas d'empreinte (entrée écrite avant ce correctif),
    // l'index sauvegardé peut pointer vers une IP différente ou être hors-limites.
    // Dans ces cas seul l'index est invalidé : la quarantaine reste valable.
    const fingerprintMissing = typeof state.poolFingerprint !== "string";
    const fingerprintMismatch = !fingerprintMissing && state.poolFingerprint !== currentFingerprint;

    if (fingerprintMissing || fingerprintMismatch) {
      const reason = fingerprintMissing
        ? "empreinte absente (état antérieur au correctif)"
        : `empreinte: ${state.poolFingerprint} → ${currentFingerprint}`;
      console.warn(
        `[spain-decodo] ⚠️ Composition du pool non vérifiable depuis la dernière sauvegarde ` +
        `(${reason}) — index réinitialisé, blacklist conservée`,
      );
      _index = findNextValidIndex(0, pool).idx;
      // Persister l'état réinitialisé avec la nouvelle empreinte
      syncDecodoPoolStateToRedis(_index, _blacklistedIps, currentFingerprint);
      return;
    }

    // Restaurer l'index (le sauvegarder pointe sur la DERNIÈRE IP utilisée,
    // donc on reprend à +1 pour ne pas taper deux fois la même IP au restart)
    const restoredIdx = (state.rotationIndex + 1) % pool.length;

    // Avancer l'index jusqu'à une IP non-blacklistée
    _index = findNextValidIndex(restoredIdx, pool).idx;
  } else {
    // Fallback : index aléatoire (évite de concentrer le trafic sur l'IP n°1 à chaque restart)
    _index = Math.floor(Math.random() * pool.length);
  }
  // Réécrire aussi après restauration pour retirer l'ancien EX 24h de Redis.
  syncDecodoPoolStateToRedis(_index, _blacklistedIps, currentFingerprint);
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
  if (allBlacklisted) return undefined;
  return pool[idx];
}

/**
 * Marque une IP Decodo comme flaguée (blacklist temporaire avec TTL).
 *
 * L'IP sera sautée par getCurrentDecodoUrl() et rotateDecodoUrl() pendant le TTL.
 * S'applique aussi au pool à un seul proxy.
 *
 * @param url    - URL complète du proxy (telle que retournée par getCurrentDecodoUrl)
 * @param reason - Raison du flag (pour les logs)
 */
export function flagDecodoIp(url: string | undefined, reason: string): void {
  if (!url) return;
  const pool = getPool();
  if (pool.length === 0) return;

  // Clé de blacklist ET recherche d'index par host:port (identité exit IP réelle),
  // robuste au format du username sticky (-sessionduration-NN / -session-{sid} présents
  // ou non selon le chemin d'appel). Corrige le "[?/N]" et garantit qu'une IP morte
  // reste bloquée quelle que soit sa forme d'URL.
  const key = proxyHostPort(url);
  const ttlMin = Math.round(getBlacklistTtlMs() / 60_000);
  const masked = baseProxyUrl(url).replace(/:([^:@]+)@/, ":***@");
  const ipIdx = findPoolIndexByHostPort(url, pool);
  const idxLabel = ipIdx >= 0 ? `[${ipIdx + 1}/${pool.length}]` : `[?/${pool.length}]`;
  console.warn(
    `[spain-decodo] 🚫 IP blacklistée ${idxLabel} (${reason}, TTL ${ttlMin}min) — ${masked.slice(0, 60)}`,
  );
  _blacklistedIps.set(key, Date.now());
  syncDecodoPoolStateToRedis(_index, _blacklistedIps, computePoolFingerprint(pool));
}

/**
 * Avance vers la prochaine URL du pool et la retourne.
 * Saute les IPs blacklistées. Si toutes les IPs sont blacklistées,
 * retourne undefined : jamais de réutilisation avant la fin de quarantaine.
 *
 * Pour un pool multi-URLs (IPs dédiées à ports fixes), cela change réellement l'IP.
 * Pour une URL unique, retourne la même URL — la rotation sessionid est gérée
 * dans spain-persistent-browser.ts.
 */
export function rotateDecodoUrl(): string | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  if (pool.length === 1) {
    return isBlacklisted(pool[0]) ? undefined : pool[0];
  }

  // Avancer d'au moins 1 position
  const nextCandidate = (_index + 1) % pool.length;

  // Trouver la prochaine IP non-blacklistée
  const { idx, allBlacklisted, skipped } = findNextValidIndex(nextCandidate, pool);
  if (allBlacklisted) {
    console.warn(
      `[spain-decodo] ⚠️ Pool épuisé (${pool.length}/${pool.length} proxies en quarantaine) — aucune IP disponible`,
    );
    return undefined;
  }
  _index = idx;

  const url = pool[_index];
  const masked = url.replace(/:([^:@]+)@/, ":***@");

  const skipMsg = skipped > 0
    ? ` (${skipped} IP${skipped > 1 ? "s" : ""} blacklistée${skipped > 1 ? "s" : ""} sautée${skipped > 1 ? "s" : ""})`
    : "";
  console.log(
    `[spain-decodo] 🔄 Rotation IP — [${_index + 1}/${pool.length}] ${masked.slice(0, 80)}${skipMsg}`,
  );

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

/** Retourne l'index courant dans le pool (restauré depuis Redis par initDecodoPool). */
export function getDecodoCurrentIndex(): number {
  return _index;
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

/**
 * Retourne le prochain proxy NON blacklisté à partir de `startIdx` (inclus), en sautant
 * les IPs flaguées — même logique de skip-blacklist que `getCurrentDecodoUrl`/`rotateDecodoUrl`
 * utilisés par les workers. Contrairement à `getDecodoProxyForIndex` (qui renvoie l'IP brute
 * à l'index, blacklistée ou non), cette fonction évite de retomber en boucle sur des IPs mortes.
 *
 * @param startIdx index de départ (inclusif ; modulo taille du pool appliqué en interne).
 * @returns `{ url, idx, allBlacklisted }` ou `undefined` si le pool est vide/épuisé. `idx` est
 *   l'index effectivement retenu (à utiliser pour l'avance suivante côté appelant).
 */
export function getValidDecodoProxyFromIndex(
  startIdx: number,
): { url: string; idx: number; allBlacklisted: boolean } | undefined {
  const pool = getPool();
  if (pool.length === 0) return undefined;
  const { idx, allBlacklisted } = findNextValidIndex(startIdx, pool);
  if (allBlacklisted) return undefined;
  return { url: pool[idx], idx, allBlacklisted };
}
