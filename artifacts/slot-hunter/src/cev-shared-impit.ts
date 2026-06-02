/**
 * cev-shared-impit.ts — Singleton impit partagé entre cevHttpSetup et cevPolling.
 * 
 * ANTI-DETECTION: Aligné sur le niveau USA (getBrowserHeaders).
 * Inclut : Sec-CH-UA, Sec-Fetch-*, jitter réseau, device fingerprint cohérent.
 * 
 * v2 (2026-05-24) : Alignement complet avec usa-http.ts —
 *   - Sticky sessions iProyal (session-ID déterministe + lifetime)
 *   - Retry avec timeout avant fallback (au lieu de fallback immédiat)
 *   - Rotation forcée après échec proxy (rotateIproyalSession)
 *   - Proxy liveness guard (mid-session freeze si proxy mort)
 *   - Logging détaillé du proxy (masqué)
 * 
 * Évite l'import circulaire : setup ↔ polling.
 * Les deux modules importent depuis ce fichier commun.
 */

import { Impit } from "impit";

const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;

// ─── Configuration proxy ────────────────────────────────────────────────────

/** Timeout pour les requêtes via proxy (ms). Si dépassé → retry ou fallback. */
const PROXY_FETCH_TIMEOUT_MS = 25_000;

/** Nombre de retries proxy avant fallback direct. */
const PROXY_MAX_RETRIES = 2;

/** Délai entre retries proxy (ms). */
const PROXY_RETRY_DELAY_MS = 2_000;

/** Lifetime des sessions sticky iProyal (minutes). */
const IPROYAL_STICKY_LIFETIME_MIN = 60;

// ─── UA Pool Chrome (aligné sur usa-http.ts) ────────────────────────────────

interface UaProfile {
  ua: string;
  chUa: string;
  platform: string;
}

const CEV_UA_POOL: UaProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
    chUa: '"Chromium";v="148", "Not:A-Brand";v="99", "Google Chrome";v="148"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="147", "Not:A-Brand";v="99", "Google Chrome";v="147"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
    chUa: '"Chromium";v="148", "Not:A-Brand";v="99", "Google Chrome";v="148"',
    platform: '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36 Edg/148.0.0.0",
    chUa: '"Chromium";v="148", "Not:A-Brand";v="99", "Microsoft Edge";v="148"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="147", "Not:A-Brand";v="99", "Google Chrome";v="147"',
    platform: '"Linux"',
  },
];

// Sticky UA par session (ne change pas mid-session)
let _sessionUa: UaProfile = CEV_UA_POOL[Math.floor(Math.random() * CEV_UA_POOL.length)];
let _sessionAcceptLang = "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7";
let _sessionAcceptEnc = "gzip, deflate, br, zstd";

// ─── UA externe siphonné (prioritaire sur le pool interne) ──────────────────
let _externalSiphonedUa: string | null = null;
let _externalSiphonedChUa: string | null = null;
let _externalSiphonedPlatform: string | null = null;
let _externalSiphonedChUaMobile: string = "?0";
let _externalSiphonedChUaFullVersionList: string | null = null;
let _externalSiphonedChUaPlatformVersion: string = '"10.0"';
let _externalSiphonedChUaArch: string = '"x86"';
let _externalSiphonedChUaBitness: string = '"64"';

/** Parse a User-Agent string to extract full sec-ch-ua* headers */
function parseUserAgentForSecCh(ua: string): {
  chUa: string;
  platform: string;
  chUaMobile: string;
  chUaFullVersionList: string;
  chUaPlatformVersion: string;
  chUaArch: string;
  chUaBitness: string;
} {
  // Default values based on our internal pool
  let majorVersion = "148";
  let fullVersion = "148.0.7778.96";
  let platform = '"Windows"';
  let platformVersion = '"10.0"';
  let arch = '"x86"';
  let bitness = '"64"';

  // Extract full Chrome version (major.minor.build.patch)
  const chromeFullMatch = ua.match(/Chrome\/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (chromeFullMatch) {
    majorVersion = chromeFullMatch[1];
    fullVersion = `${chromeFullMatch[1]}.${chromeFullMatch[2]}.${chromeFullMatch[3]}.${chromeFullMatch[4]}`;
  } else if (ua.match(/Chrome\/(\d+)/)) {
    // Fallback to just major version if full is not available
    majorVersion = ua.match(/Chrome\/(\d+)/)?.[1] || "148";
    fullVersion = `${majorVersion}.0.0.0`;
  }

  // Extract platform
  if (ua.includes("Windows NT")) {
    platform = '"Windows"';
    platformVersion = '"10.0"';
  } else if (ua.includes("Mac OS X")) {
    platform = '"macOS"';
    platformVersion = '"15.0"';
  } else if (ua.includes("Linux")) {
    platform = '"Linux"';
    platformVersion = '"6.8"';
  }

  // Build all client hints
  return {
    chUa: `"Not:A-Brand";v="99", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`,
    platform,
    chUaMobile: "?0",
    chUaFullVersionList: `"Not:A-Brand";v="99.0.0.0", "Chromium";v="${fullVersion}", "Google Chrome";v="${fullVersion}"`,
    chUaPlatformVersion: platformVersion,
    chUaArch: arch,
    chUaBitness: bitness
  };
}

/** Injecte un User-Agent siphonné depuis l'extérieur (extension Chrome, etc.)
 *  Ce UA sera utilisé pour TOUTES les requêtes tant qu'il est défini.
 *  Prioritaire sur le pool CEV_UA_POOL. */
export function setCevExternalUserAgent(ua: string | null): void {
  _externalSiphonedUa = ua;
  if (ua) {
    const parsed = parseUserAgentForSecCh(ua);
    _externalSiphonedChUa = parsed.chUa;
    _externalSiphonedPlatform = parsed.platform;
    _externalSiphonedChUaMobile = parsed.chUaMobile;
    _externalSiphonedChUaFullVersionList = parsed.chUaFullVersionList;
    _externalSiphonedChUaPlatformVersion = parsed.chUaPlatformVersion;
    _externalSiphonedChUaArch = parsed.chUaArch;
    _externalSiphonedChUaBitness = parsed.chUaBitness;
    console.log(`[CEV] 🔒 UA externe injecté: ${ua.slice(0, 60)}…`);
    console.log(`[CEV] 🔒 Matching sec-ch-ua: ${_externalSiphonedChUa.slice(0, 80)}…`);
  } else {
    _externalSiphonedChUa = null;
    _externalSiphonedPlatform = null;
    _externalSiphonedChUaFullVersionList = null;
    console.log(`[CEV] 🔓 UA externe retiré → retour pool interne`);
  }
}

/** Retourne le UA externe siphonné ou null */
export function getCevExternalUserAgent(): string | null {
  return _externalSiphonedUa;
}

/** Régénère le profil UA (appelé quand on change d'IP / nouvelle session) */
export function rotateCevUaProfile(): void {
  _sessionUa = CEV_UA_POOL[Math.floor(Math.random() * CEV_UA_POOL.length)];
  // Varier légèrement Accept-Language
  const langVariants = [
    "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "fr-BE,fr;q=0.9,en;q=0.8",
    "fr,en-US;q=0.9,en;q=0.8",
    "en-US,en;q=0.9,fr-BE;q=0.8,fr;q=0.7",
  ];
  _sessionAcceptLang = langVariants[Math.floor(Math.random() * langVariants.length)];
  // Varier Accept-Encoding (tous valides pour Chrome)
  const encVariants = [
    "gzip, deflate, br, zstd",
    "gzip, deflate, br",
    "gzip, deflate, br, zstd",
  ];
  _sessionAcceptEnc = encVariants[Math.floor(Math.random() * encVariants.length)];
}

/** Retourne le UA actuel (pour les headers manuels comme hCaptcha solve) */
export function getCevSessionUa(): string {
  return _externalSiphonedUa ?? _sessionUa.ua;
}

/**
 * Génère les headers Chrome complets pour les requêtes CEV.
 * Aligné sur le niveau anti-détection de usa-http.ts getBrowserHeaders().
 */
export function getCevBrowserHeaders(overrides?: {
  referer?: string;
  origin?: string;
  accept?: string;
  contentType?: string;
  cookie?: string;
  xRequestedWith?: boolean;
  userAgent?: string;
}): Record<string, string> {
  // Determine which client hints to use
  const chUa = _externalSiphonedChUa ?? _sessionUa.chUa;
  const chUaPlatform = _externalSiphonedPlatform ?? _sessionUa.platform;
  const chUaMobile = _externalSiphonedChUaMobile;
  const chUaFullVersionList = _externalSiphonedChUaFullVersionList 
    ? _externalSiphonedChUaFullVersionList 
    // For internal pool, parse the major version from chUa and build full version list
    : (() => {
        const poolMatch = _sessionUa.chUa.match(/"Google Chrome";v="(\d+)"/);
        const poolMajor = poolMatch?.[1] || "148";
        return `"Not:A-Brand";v="99.0.0.0", "Chromium";v="${poolMajor}.0.0.0", "Google Chrome";v="${poolMajor}.0.0.0"`;
      })();
  
  const headers: Record<string, string> = {
    "Accept": overrides?.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Encoding": _sessionAcceptEnc,
    "Accept-Language": _sessionAcceptLang,
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-CH-UA": chUa,
    "Sec-CH-UA-Arch": _externalSiphonedChUaArch ?? '"x86"',
    "Sec-CH-UA-Bitness": _externalSiphonedChUaBitness ?? '"64"',
    "Sec-CH-UA-Full-Version-List": chUaFullVersionList,
    "Sec-CH-UA-Mobile": chUaMobile,
    "Sec-CH-UA-Platform": chUaPlatform,
    "Sec-CH-UA-Platform-Version": _externalSiphonedChUaPlatformVersion ?? '"10.0"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": overrides?.userAgent ?? _externalSiphonedUa ?? _sessionUa.ua,
  };

  if (overrides?.referer) headers["Referer"] = overrides.referer;
  if (overrides?.origin) headers["Origin"] = overrides.origin;
  if (overrides?.cookie) headers["Cookie"] = overrides.cookie;
  if (overrides?.contentType) {
    let contentType = overrides.contentType;
    // Auto-add charset=UTF-8 to application/x-www-form-urlencoded (like real browsers)
    if (contentType.toLowerCase() === "application/x-www-form-urlencoded") {
      contentType = "application/x-www-form-urlencoded; charset=UTF-8";
    }
    headers["Content-Type"] = contentType;
    // AJAX requests have different Sec-Fetch values
    headers["Sec-Fetch-Dest"] = "empty";
    headers["Sec-Fetch-Mode"] = "cors";
    delete headers["Sec-Fetch-User"];
    delete headers["Upgrade-Insecure-Requests"];
  }
  if (overrides?.xRequestedWith) {
    headers["X-Requested-With"] = "XMLHttpRequest";
    headers["Sec-Fetch-Dest"] = "empty";
    headers["Sec-Fetch-Mode"] = "cors";
    delete headers["Sec-Fetch-User"];
    delete headers["Upgrade-Insecure-Requests"];
  }

  return headers;
}

// ─── iProyal Sticky Session Management (aligné sur usa-http.ts) ─────────────

/** Compteur de rotation par identifiant — incrémenté après échec proxy pour forcer nouvelle IP. */
const _cevIproyalRotationCount = new Map<string, number>();

/**
 * Génère une URL iProyal avec session sticky — même logique que usa-http.ts makeIproyalStickyUrl.
 * 
 * Le session ID est déterministe par (date + demi-journée + identifiant + rotationCount).
 * Cela permet :
 *   - Même session ID si le bot redémarre dans la même période → reprise déterministe
 *   - Changement automatique à 00h/12h UTC → nouvelle IP
 *   - Rotation forcée via rotateCevIproyalSession() après échec proxy
 * 
 * IMPORTANT: La lifetime iProyal est de 60 min. Après 60 min, la session expire
 * côté serveur iProyal et l'IP est relâchée.
 */
export function makeCevIproyalStickyUrl(
  baseUrl: string,
  lifetimeMinutes: number = IPROYAL_STICKY_LIFETIME_MIN,
  identifier?: string,
): string {
  try {
    const parsed = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    let password = decodeURIComponent(parsed.password);

    // Supprimer l'ancienne session sticky si présente
    if (password.includes("_session-") && password.includes("_lifetime-")) {
      password = password.replace(/_session-[^_]+_lifetime-\d+[mh]/, "");
    }

    // Générer un session ID stable par période + identifiant
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _cevIproyalRotationCount.get((identifier ?? "cev-default").toLowerCase()) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${(identifier ?? "cev-default").toLowerCase()}:cev-iproyal:r${rotationCount}`;
    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
    // Convertir en base62 (8 chars)
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 62];
      h = Math.floor(h / 62) + (i + 1) * 7;
    }

    const lifetimeStr = lifetimeMinutes >= 60 ? `${Math.round(lifetimeMinutes / 60)}h` : `${lifetimeMinutes}m`;
    password += `_session-${sessionId}_lifetime-${lifetimeStr}`;
    parsed.password = encodeURIComponent(password);
    console.log(`[CEV] 🔒 iProyal sticky session=${sessionId} lifetime=${lifetimeStr} rot#${rotationCount}`);
    return parsed.toString();
  } catch {
    console.warn(`[CEV] ⚠️ Impossible de parser l'URL proxy — fallback URL brute`);
    return baseUrl;
  }
}

/**
 * Force la rotation du proxy iProyal pour un identifiant CEV donné.
 * Appelé après un échec proxy persistant pour obtenir une nouvelle IP au prochain cycle.
 */
export function rotateCevIproyalSession(identifier: string): void {
  const key = identifier.toLowerCase();
  const current = _cevIproyalRotationCount.get(key) ?? 0;
  _cevIproyalRotationCount.set(key, current + 1);
  // Réinitialiser l'instance impit pour qu'elle soit recréée avec la nouvelle URL
  _proxyImpit = undefined;
  _proxyImpitUrl = undefined;
  console.log(`[CEV] 🔄 Rotation proxy iProyal demandée pour ${key.slice(0, 20)}… (rot#${current + 1})`);
}

// ─── SOAX Sticky Session Management (format Dashboard v2 — params dans USERNAME) ─

const SOAX_PROXY_URL = process.env.SOAX_PROXY_URL;
const SOAX_COUNTRY = process.env.SOAX_COUNTRY ?? "cd";
const SOAX_CITY = process.env.SOAX_CITY ?? "kinshasa";
const SOAX_SESSION_TIME_MIN = parseInt(process.env.SOAX_SESSION_TIME ?? "5", 10);

/** Compteur de rotation SOAX par identifiant. */
const _cevSoaxRotationCount = new Map<string, number>();

/**
 * Génère une URL SOAX avec session sticky (format Dashboard v2).
 *
 * Format: http://{package}-sessionid-{id}-sessionlength-{sec}-country-{cc}-city-{city}:{pass}@proxy.soax.com:5000
 *
 * IMPORTANT: codes pays/ville en MINUSCULE obligatoire.
 * SOAX sessionlength est en SECONDES (pas minutes).
 *
 * @param baseUrl - URL de base SOAX (http://package-XXXXX:PASSWORD@proxy.soax.com:5000)
 * @param lifetimeMinutes - Durée de session sticky en minutes (converti en secondes pour SOAX)
 * @param identifier - Identifiant unique du slot IP (pour session ID déterministe)
 */
export function makeCevSoaxStickyUrl(
  baseUrl: string,
  lifetimeMinutes: number = SOAX_SESSION_TIME_MIN,
  identifier?: string,
): string {
  try {
    const parsed = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    let proxyUser = decodeURIComponent(parsed.username);

    // Extraire et conserver les paramètres fixes depuis la base URL (bindttl, opt)
    const bindttlMatch = proxyUser.match(/-bindttl-(\d+)/);
    const optMatch = proxyUser.match(/-opt-([^-]+)/);
    const bindttl = bindttlMatch ? bindttlMatch[1] : null;
    const opt = optMatch ? optMatch[1] : null;

    // Nettoyer les anciens paramètres de session du username
    proxyUser = proxyUser
      .replace(/-sessionid-[^-]*/g, "")
      .replace(/-sessionlength-[^-]*/g, "")
      .replace(/-country-[^-]*/g, "")
      .replace(/-city-[^-]*/g, "")
      .replace(/-bindttl-[^-]*/g, "")
      .replace(/-opt-[^-]*/g, "")
      .replace(/-+$/, "");

    // Générer un session ID stable par période + identifiant (même logique que iProyal)
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _cevSoaxRotationCount.get((identifier ?? "cev-default").toLowerCase()) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${(identifier ?? "cev-default").toLowerCase()}:cev-soax:r${rotationCount}`;
    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 36];
      h = Math.floor(h / 36) + (i + 1) * 7;
    }

    // Construire le username avec les paramètres SOAX
    const sessionLengthSec = lifetimeMinutes * 60;
    proxyUser += `-sessionid-${sessionId}`;
    proxyUser += `-sessionlength-${sessionLengthSec}`;
    proxyUser += `-country-${SOAX_COUNTRY}`;
    if (SOAX_CITY) proxyUser += `-city-${SOAX_CITY}`;
    if (bindttl) proxyUser += `-bindttl-${bindttl}`;
    if (opt) proxyUser += `-opt-${opt}`;

    parsed.username = encodeURIComponent(proxyUser);
    console.log(`[CEV] 🔒 SOAX sticky sessionid=${sessionId} sessionlength=${sessionLengthSec}s country=${SOAX_COUNTRY} rot#${rotationCount}`);
    return parsed.toString();
  } catch {
    console.warn(`[CEV] ⚠️ Impossible de parser l'URL SOAX — fallback URL brute`);
    return baseUrl;
  }
}

/**
 * Force la rotation du proxy SOAX pour un identifiant CEV donné.
 * Appelé après un échec proxy persistant pour obtenir une nouvelle IP au prochain cycle.
 */
export function rotateCevSoaxSession(identifier: string): void {
  const key = identifier.toLowerCase();
  const current = _cevSoaxRotationCount.get(key) ?? 0;
  _cevSoaxRotationCount.set(key, current + 1);
  _proxyImpit = undefined;
  _proxyImpitUrl = undefined;
  console.log(`[CEV] 🔄 Rotation proxy SOAX demandée pour ${key.slice(0, 20)}… (rot#${current + 1})`);
}

/**
 * Génère une URL proxy CEV sticky agnostique (SOAX ou iProyal selon le provider choisi).
 *
 * @param provider - "soax" | "iproyal"
 * @param lifetimeMinutes - Durée de session sticky
 * @param identifier - Identifiant unique du slot IP
 */
export function makeCevProxyStickyUrl(
  provider: "soax" | "iproyal",
  lifetimeMinutes?: number,
  identifier?: string,
): string {
  if (provider === "soax") {
    const base = SOAX_PROXY_URL;
    if (!base) {
      console.warn(`[CEV] ⚠️ SOAX_PROXY_URL non configurée — fallback iProyal`);
      return makeCevIproyalStickyUrl(
        IPROYAL_PROXY_URL ?? "",
        lifetimeMinutes ?? IPROYAL_STICKY_LIFETIME_MIN,
        identifier,
      );
    }
    return makeCevSoaxStickyUrl(base, lifetimeMinutes ?? SOAX_SESSION_TIME_MIN, identifier);
  }
  // iProyal (défaut)
  return makeCevIproyalStickyUrl(
    IPROYAL_PROXY_URL ?? "",
    lifetimeMinutes ?? IPROYAL_STICKY_LIFETIME_MIN,
    identifier,
  );
}

/**
 * Force la rotation du proxy CEV agnostique.
 */
export function rotateCevProxySession(provider: "soax" | "iproyal", identifier: string): void {
  if (provider === "soax") {
    rotateCevSoaxSession(identifier);
  } else {
    rotateCevIproyalSession(identifier);
  }
}

// ─── CEV Proxy Session Guard (aligné sur usa proxy-session-guard.ts) ────────

/** Intervalle minimum entre deux health checks mid-session (ms). */
const CEV_PROXY_CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Timeout pour le health check mid-session (ms). */
const CEV_PROXY_CHECK_TIMEOUT_MS = 5000;

/** Nombre d'échecs consécutifs avant de déclarer le proxy mort. */
const CEV_PROXY_MAX_FAILURES = 2;

/** URL légère pour tester la connectivité proxy. */
const CEV_HEALTH_CHECK_URL = "https://api.ipify.org?format=text";

interface CevProxyGuardState {
  proxyUrl: string;
  lastCheckAt: number;
  consecutiveFailures: number;
  frozen: boolean;
  expectedExitIp?: string;
  identifier?: string;
}

let _cevProxyGuardState: CevProxyGuardState | undefined;

/**
 * Initialise le proxy guard CEV pour la session active.
 * Appelé après le premier fetch proxy réussi.
 */
export function initCevProxyGuard(proxyUrl: string, identifier?: string, exitIp?: string): void {
  _cevProxyGuardState = {
    proxyUrl,
    lastCheckAt: Date.now(),
    consecutiveFailures: 0,
    frozen: false,
    expectedExitIp: exitIp,
    identifier,
  };
  console.log(`[CEV-PROXY-GUARD] ✅ Guard initialisé (IP: ${exitIp ?? "inconnue"})`);
}

/** Libère le proxy guard (fin de session / rotation). */
export function releaseCevProxyGuard(): void {
  _cevProxyGuardState = undefined;
}

/** Vérifie si la session CEV est gelée (proxy mort mid-session). */
export function isCevSessionFrozen(): boolean {
  return _cevProxyGuardState?.frozen ?? false;
}

/**
 * Vérifie la santé du proxy CEV mid-session (non-bloquant si intervalle non écoulé).
 * Retourne true = OK, false = proxy mort → session gelée.
 */
export async function checkCevProxyLiveness(): Promise<boolean> {
  if (!_cevProxyGuardState) return true;
  if (_cevProxyGuardState.frozen) return false;

  const elapsed = Date.now() - _cevProxyGuardState.lastCheckAt;
  if (elapsed < CEV_PROXY_CHECK_INTERVAL_MS) return true;

  // Exécuter le health check
  const healthy = await performCevProxyHealthCheck(_cevProxyGuardState);

  if (healthy) {
    _cevProxyGuardState.lastCheckAt = Date.now();
    _cevProxyGuardState.consecutiveFailures = 0;
    return true;
  }

  _cevProxyGuardState.consecutiveFailures++;
  _cevProxyGuardState.lastCheckAt = Date.now();

  if (_cevProxyGuardState.consecutiveFailures >= CEV_PROXY_MAX_FAILURES) {
    _cevProxyGuardState.frozen = true;
    const masked = _cevProxyGuardState.proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.error(`[CEV-PROXY-GUARD] 🚨 PROXY MORT mid-session — SESSION GELÉE`);
    console.error(`[CEV-PROXY-GUARD]    ${_cevProxyGuardState.consecutiveFailures} échecs consécutifs`);
    console.error(`[CEV-PROXY-GUARD]    Proxy: ${masked.slice(0, 60)}…`);
    console.error(`[CEV-PROXY-GUARD]    → Requêtes bloquées — rotation proxy nécessaire`);

    // Forcer la rotation pour le prochain cycle
    if (_cevProxyGuardState.identifier) {
      rotateCevIproyalSession(_cevProxyGuardState.identifier);
    }
    return false;
  }

  // Premier échec → pas encore gelé, réduire l'intervalle pour revérifier rapidement
  console.warn(
    `[CEV-PROXY-GUARD] ⚠️ Health check échoué (${_cevProxyGuardState.consecutiveFailures}/${CEV_PROXY_MAX_FAILURES}) — re-check dans 30s`,
  );
  _cevProxyGuardState.lastCheckAt = Date.now() - CEV_PROXY_CHECK_INTERVAL_MS + 30_000;
  return true;
}

async function performCevProxyHealthCheck(state: CevProxyGuardState): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CEV_PROXY_CHECK_TIMEOUT_MS);

    // Utiliser impit avec le proxy actuel pour le health check
    const impit = getProxyImpit(state.proxyUrl);
    const res = await impit.fetch(CEV_HEALTH_CHECK_URL, {
      signal: controller.signal,
    } as any) as unknown as Response;

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[CEV-PROXY-GUARD] Health check HTTP ${res.status}`);
      return false;
    }

    const exitIp = (await res.text()).trim();

    // Vérifier que l'IP de sortie n'a pas changé
    if (state.expectedExitIp && exitIp !== state.expectedExitIp) {
      console.warn(
        `[CEV-PROXY-GUARD] ⚠️ IP de sortie changée mid-session: ${state.expectedExitIp} → ${exitIp}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("abort") || msg.includes("timeout");
    console.warn(
      `[CEV-PROXY-GUARD] Health check échoué: ${isTimeout ? "TIMEOUT" : msg.slice(0, 100)}`,
    );
    return false;
  }
}

// ─── Impit Instances ────────────────────────────────────────────────────────

/** Singleton impit avec proxy (fingerprint TLS Chrome) */
let _proxyImpit: InstanceType<typeof Impit> | undefined;
let _proxyImpitUrl: string | undefined;

export function getProxyImpit(proxyUrl?: string): InstanceType<typeof Impit> {
  const targetProxy = proxyUrl ?? IPROYAL_PROXY_URL;
  // Recréer si le proxy a changé
  if (!_proxyImpit || targetProxy !== _proxyImpitUrl) {
    const opts: Record<string, unknown> = { browser: "chrome", ignoreTlsErrors: true };
    if (targetProxy) {
      opts.proxyUrl = targetProxy;
      const masked = targetProxy.replace(/:([^:@]+)@/, ":***@");
      console.log(`[CEV] ✅ impit initialisé avec proxy: ${masked.slice(0, 60)}… (fingerprint TLS Chrome)`);
    }
    _proxyImpit = new Impit(opts as any);
    _proxyImpitUrl = targetProxy;
  }
  return _proxyImpit;
}

/** Singleton impit direct (sans proxy) — partagé entre setup ET polling.
 *  Garantit que la même connexion TLS est réutilisée → session ASP.NET stable. */
let _directImpit: InstanceType<typeof Impit> | undefined;
export function getDirectImpit(): InstanceType<typeof Impit> {
  if (!_directImpit) {
    _directImpit = new Impit({ browser: "chrome", ignoreTlsErrors: true } as any);
    console.log("[CEV] ✅ impit direct initialisé (fingerprint TLS Chrome) — sans proxy");
  }
  return _directImpit;
}

/** Réinitialise les instances impit (appelé en cas de changement de proxy) */
export function resetCevImpitInstances(): void {
  _proxyImpit = undefined;
  _proxyImpitUrl = undefined;
  _directImpit = undefined;
}

/**
 * Fetch CEV via impit avec :
 * - Fingerprint TLS Chrome (JA3/JA4)
 * - Jitter réseau réaliste (30-200ms avant chaque requête)
 * - Retry avec timeout (aligné sur usa-http.ts) au lieu de fallback immédiat
 * - Proxy liveness guard (bloque si proxy mort mid-session)
 * - Fallback direct uniquement après épuisement des retries
 * 
 * v2: Plus de fallback silencieux ! On retry PROXY_MAX_RETRIES fois avec timeout
 * avant de tomber en direct. Chaque échec est loggé avec détail.
 */

// ─── Mode direct durable (après 422 proxy) ─────────────────────────────────
// Quand le proxy rejette avec 422, on bascule en mode direct pour une durée fixe
// au lieu de retenter le proxy à chaque requête et échouer à répétition.
const CEV_DIRECT_MODE_DURATION_MS = 30 * 60_000; // 30 minutes en mode direct
let _cevDirectModeUntil = 0; // timestamp jusqu'auquel on reste en direct

/** Force le retour au mode proxy (appelable manuellement) */
export function resetCevDirectMode(): void {
  _cevDirectModeUntil = 0;
  console.log("[CEV] 🔄 Mode direct reseté → retour proxy");
}

/** Vérifie si on est en mode direct forcé */
export function isCevDirectMode(): boolean {
  return Date.now() < _cevDirectModeUntil;
}

/** Récupère l'IP de sortie proxy actuellement configurée (si disponible) */
export function getCevProxyExitIp(): string | undefined {
  return _cevProxyGuardState?.expectedExitIp;
}

/** Effectue un health check proxy pour récupérer l'IP de sortie et initialiser le guard */
export async function initCevProxyGuardWithExitIp(proxyUrl: string, identifier?: string): Promise<string | null> {
  try {
    const impit = getProxyImpit(proxyUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    
    const res = await impit.fetch(CEV_HEALTH_CHECK_URL, {
      signal: controller.signal,
    } as any) as unknown as Response;
    
    clearTimeout(timeout);
    
    if (!res.ok) {
      console.warn(`[CEV-PROXY-GUARD] Health check échoué (HTTP ${res.status})`);
      return null;
    }
    
    const exitIp = (await res.text()).trim();
    console.log(`[CEV-PROXY-GUARD] IP de sortie proxy détectée: ${exitIp}`);
    initCevProxyGuard(proxyUrl, identifier, exitIp);
    return exitIp;
  } catch (err) {
    console.warn(`[CEV-PROXY-GUARD] Échec init proxy guard: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function cevImpitFetch(url: string, options: RequestInit, logPrefix = "[CEV]"): Promise<Response> {
  // ── Mode direct forcé (après 422 proxy) ─────────────────────────────────────
  if (Date.now() < _cevDirectModeUntil) {
    // Jitter réseau réaliste même en mode direct
    await new Promise(r => setTimeout(r, 30 + Math.random() * 170));
    return getDirectImpit().fetch(url, options as any) as unknown as Response;
  }

  // ── Proxy liveness guard (comme usa-http.ts Pillar 2) ───────────────────────
  if (_cevProxyGuardState && _cevProxyGuardState.frozen) {
    console.error(`${logPrefix} 🛑 REQUÊTE BLOQUÉE — proxy mort mid-session (session gelée)`);
    console.error(`${logPrefix}    URL: ${url.slice(0, 80)}…`);
    // Retourner une fausse réponse 503 (comme usa-http.ts)
    return new Response(
      JSON.stringify({ error: "CEV_PROXY_DEAD_MID_SESSION", message: "Session frozen — proxy died mid-session" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── Jitter réseau réaliste (comme usa-http.ts) ──────────────────────────────
  const jitterMs = 30 + Math.random() * 170; // 30-200ms
  await new Promise(r => setTimeout(r, jitterMs));

  // ── Déterminer le proxy à utiliser ──────────────────────────────────────────
  // Si un proxy est passé dynamiquement via process.env (par le stealth loop),
  // l'utiliser. Sinon utiliser la variable globale IPROYAL_PROXY_URL.
  let currentProxy = process.env.IPROYAL_PROXY_URL;
  
  if (!currentProxy) {
    // Pas de proxy configuré — connexion directe
    return getDirectImpit().fetch(url, options as any) as unknown as Response;
  }

  // ── Fetch avec retry (aligné sur usa-http.ts) ─────────────────────────────
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= PROXY_MAX_RETRIES; attempt++) {
    // Re-lire le proxy à chaque retry (peut avoir été roté entre les tentatives)
    currentProxy = process.env.IPROYAL_PROXY_URL ?? currentProxy;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PROXY_FETCH_TIMEOUT_MS);

      const fetchOptions = {
        ...options,
        signal: controller.signal,
      };

      const res = await getProxyImpit(currentProxy).fetch(url, fetchOptions as any) as unknown as Response;
      clearTimeout(timeout);

      // Vérifier si la réponse est un 407 (proxy auth failed) ou 422/502/503 (proxy error)
      if (res.status === 407) {
        console.error(`${logPrefix} ❌ Proxy auth failed (407) — vérifier IPROYAL_PROXY_URL credentials`);
        lastError = new Error(`PROXY_AUTH_FAILED_407`);
        // Ne pas retry un 407, c'est un problème de credentials
        break;
      }

      if (res.status === 422) {
        // 422 = proxy CONNECT tunnel rejeté — basculer en mode DIRECT durablement
        console.error(`${logPrefix} ❌ Proxy 422 (CONNECT tunnel rejected) — BASCULEMENT MODE DIRECT`);
        _cevDirectModeUntil = Date.now() + CEV_DIRECT_MODE_DURATION_MS;
        console.warn(`${logPrefix} 🔀 Mode DIRECT activé pour ${Math.round(CEV_DIRECT_MODE_DURATION_MS / 60_000)} min`);
        // Exécuter immédiatement en direct (pas de retry proxy)
        try {
          return await getDirectImpit().fetch(url, options as any) as unknown as Response;
        } catch (directErr) {
          const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
          console.error(`${logPrefix} 💥 DIRECT aussi échoué après 422: ${directMsg.slice(0, 100)}`);
          throw directErr;
        }
      }

      if (res.status === 502 || res.status === 503) {
        console.warn(`${logPrefix} ⚠️ Proxy error ${res.status} (attempt ${attempt + 1}/${PROXY_MAX_RETRIES + 1})`);
        lastError = new Error(`PROXY_ERROR_${res.status}`);
        if (attempt < PROXY_MAX_RETRIES) {
          // ── Rotation IP SOAX entre les retries (HTTP 502/503) ──────────────
          if (currentProxy?.includes("soax") || currentProxy?.includes("sessionid")) {
            rotateCevSoaxSession("cev-retry");
            const newProxyUrl = makeCevProxyStickyUrl("soax", undefined, "cev-retry");
            process.env.IPROYAL_PROXY_URL = newProxyUrl;
            resetCevImpitInstances();
            console.log(`${logPrefix} 🔄 Rotation SOAX IP pour retry #${attempt + 2} (HTTP ${res.status})`);
          }
          await new Promise(r => setTimeout(r, PROXY_RETRY_DELAY_MS));
          continue;
        }
        break;
      }

      // Succès ! Mettre à jour le proxy guard si besoin
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes("abort") || msg.includes("timeout") || msg.includes("TIMEOUT");
      const isConnRefused = msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET") || msg.includes("EPIPE");
      const is422Tunnel = msg.includes("422") || msg.includes("CONNECT tunnel");

      // 422 proxy error in exception form → basculer en direct immédiatement
      if (is422Tunnel) {
        console.error(`${logPrefix} ❌ Proxy 422 tunnel error (exception) — BASCULEMENT MODE DIRECT`);
        _cevDirectModeUntil = Date.now() + CEV_DIRECT_MODE_DURATION_MS;
        console.warn(`${logPrefix} 🔀 Mode DIRECT activé pour ${Math.round(CEV_DIRECT_MODE_DURATION_MS / 60_000)} min`);
        try {
          return await getDirectImpit().fetch(url, options as any) as unknown as Response;
        } catch (directErr) {
          throw directErr;
        }
      }

      if (attempt < PROXY_MAX_RETRIES) {
        console.warn(
          `${logPrefix} ⚠️ Proxy ${isTimeout ? "TIMEOUT" : "error"} (attempt ${attempt + 1}/${PROXY_MAX_RETRIES + 1}): ${msg.slice(0, 80)}`
        );
        lastError = err instanceof Error ? err : new Error(msg);
        // ── Rotation IP SOAX entre les retries ──────────────────────────────
        // Si l'IP sticky actuelle est morte, on en demande une nouvelle
        // avant de retenter (nouveau sessionid = nouvelle IP SOAX).
        if (currentProxy?.includes("soax") || currentProxy?.includes("sessionid")) {
          rotateCevSoaxSession("cev-retry");
          const newProxyUrl = makeCevProxyStickyUrl("soax", undefined, "cev-retry");
          process.env.IPROYAL_PROXY_URL = newProxyUrl;
          resetCevImpitInstances();
          console.log(`${logPrefix} 🔄 Rotation SOAX IP pour retry #${attempt + 2}`);
        }
        await new Promise(r => setTimeout(r, PROXY_RETRY_DELAY_MS));
        continue;
      }

      lastError = err instanceof Error ? err : new Error(msg);
      console.error(
        `${logPrefix} ❌ Proxy failed après ${PROXY_MAX_RETRIES + 1} tentatives: ${isTimeout ? "TIMEOUT" : isConnRefused ? "CONN_REFUSED" : msg.slice(0, 100)}`
      );
    }
  }

  // ── Fallback direct (dernier recours) ──────────────────────────────────────
  const errorDetail = lastError?.message?.slice(0, 60) ?? "unknown";
  console.warn(`${logPrefix} ⚠️ FALLBACK impit direct (après ${PROXY_MAX_RETRIES + 1} retries proxy: ${errorDetail})`);
  
  try {
    return await getDirectImpit().fetch(url, options as any) as unknown as Response;
  } catch (directErr) {
    // Si même le direct échoue, c'est un problème réseau global
    const directMsg = directErr instanceof Error ? directErr.message : String(directErr);
    console.error(`${logPrefix} 💥 DIRECT aussi échoué: ${directMsg.slice(0, 100)}`);
    throw directErr;
  }
}
