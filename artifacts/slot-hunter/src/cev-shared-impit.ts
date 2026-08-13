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
const DECODO_PROXY_URL_CEV = process.env.DECODO_PROXY_URL;

// ─── Configuration proxy via botConfig ──────────────────────────────────────

/** Cache pour la valeur cev_use_proxy depuis botConfig */
let _cevUseProxyCache: boolean | null = null;
let _cevUseProxyLastChecked = 0;
const CEV_USE_PROXY_CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Vérifie si le proxy doit être utilisé pour les requêtes CEV.
 * Consulte botConfig "cev_use_proxy" (0 = désactivé, 1 = activé).
 * Par défaut: true (utiliser le proxy si configuré).
 */
export async function shouldUseProxy(): Promise<boolean> {
  const now = Date.now();
  
  // Retourner la valeur mise en cache si elle est récente
  if (_cevUseProxyCache !== null && (now - _cevUseProxyLastChecked) < CEV_USE_PROXY_CACHE_TTL_MS) {
    return _cevUseProxyCache;
  }
  
  // Mettre à jour le timestamp
  _cevUseProxyLastChecked = now;
  
  try {
    // Import dynamique pour éviter les problèmes de dépendance circulaire
    const { getBotConfigValue } = await import("./convexClient.js");
    const configValue = await getBotConfigValue("cev_use_proxy");
    
    if (configValue === "0") {
      _cevUseProxyCache = false;
      console.log("[CEV-PROXY-CONFIG] 🔄 Proxy désactivé via botConfig (cev_use_proxy=0)");
      return false;
    } else if (configValue === "1") {
      _cevUseProxyCache = true;
      console.log("[CEV-PROXY-CONFIG] 🔄 Proxy activé via botConfig (cev_use_proxy=1)");
      return true;
    } else {
      // Non configuré ou autre valeur → utiliser le proxy par défaut s'il est configuré
      _cevUseProxyCache = true;
      console.log("[CEV-PROXY-CONFIG] 🔄 Proxy par défaut (cev_use_proxy non configuré ou ≠ 0/1)");
      return true;
    }
  } catch (error) {
    // En cas d'erreur (Convex inaccessible), utiliser la valeur cache ou false par défaut
    console.warn(`[CEV-PROXY-CONFIG] ⚠️ Erreur lecture botConfig cev_use_proxy: ${error}`);
    if (_cevUseProxyCache === null) {
      _cevUseProxyCache = false; // Par défaut, NE PAS utiliser le proxy si Convex inaccessible
    }
    return _cevUseProxyCache;
  }
}

/** Force le rechargement de la config proxy (pour tests/debug) */
export function forceReloadCevProxyConfig(): void {
  _cevUseProxyCache = null;
  _cevUseProxyLastChecked = 0;
  console.log("[CEV-PROXY-CONFIG] 🔄 Forcé rechargement config proxy");
}

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
    // Chrome 149 stable Windows — version courante (juin 2026), build réel
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="149", "Google Chrome";v="149"',
    platform: '"Windows"',
  },
  {
    // Chrome 149 stable macOS — version courante, diversité OS
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="149", "Google Chrome";v="149"',
    platform: '"macOS"',
  },
  {
    // Chrome 149 stable Windows — build patch .103 (coexiste avec .55 en déploiement progressif)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.103 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="149", "Google Chrome";v="149"',
    platform: '"Windows"',
  },
  {
    // FIX #6: Chrome 148 stable Windows — encore très répandu (update progressif)
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="148", "Google Chrome";v="148"',
    platform: '"Windows"',
  },
  {
    // FIX #6: Chrome 148 stable macOS — encore très répandu
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="148", "Google Chrome";v="148"',
    platform: '"macOS"',
  },
  {
    // FIX #8: Edge 148 stable Windows — build réel
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.7778.96 Safari/537.36 Edg/148.0.2849.68",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="148", "Microsoft Edge";v="148"',
    platform: '"Windows"',
  },
  {
    // FIX #7: Chrome 147 stable Windows — utilisateurs lents à mettre à jour
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7231.96 Safari/537.36",
    chUa: '"Not/A)Brand";v="99", "Chromium";v="147", "Google Chrome";v="147"',
    platform: '"Windows"',
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
  // Default values based on our internal pool (current stable Chrome)
  let majorVersion = "149";
  let fullVersion = "149.0.7827.55";
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
  // FIX #6: Include "Google Chrome" brand for official stable Chrome builds
  const isEdge = ua.includes("Edg/");
  const chUaReduced = isEdge
    ? `"Not/A)Brand";v="99", "Chromium";v="${majorVersion}", "Microsoft Edge";v="${majorVersion}"`
    : `"Not/A)Brand";v="99", "Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}"`;
  const chUaFullVersionListVal = isEdge
    ? `"Not/A)Brand";v="99.0.0.0", "Chromium";v="${fullVersion}", "Microsoft Edge";v="${fullVersion}"`
    : `"Not/A)Brand";v="99.0.0.0", "Chromium";v="${fullVersion}", "Google Chrome";v="${fullVersion}"`;
  return {
    chUa: chUaReduced,
    platform,
    chUaMobile: "?0",
    chUaFullVersionList: chUaFullVersionListVal,
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
  // Varier légèrement Accept-Language — uniquement des profils francophones réalistes
  // pour le portail belge. L'anglais comme langue primaire = signal bot évident.
  // La valeur courte "fr-BE" correspond au profil Chrome 148 capturé (01_initial.json).
  const langVariants = [
    "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",  // fr-BE primaire, long form classique
    "fr-BE,fr;q=0.9,en;q=0.8",               // fr-BE primaire, sans en-US
    "fr-BE",                                   // fr-BE court — capturé sur Chrome 148 réel
    "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",  // Ressortissant depuis France (légitime)
    "fr,fr-BE;q=0.9,en-US;q=0.8,en;q=0.7",  // fr générique primaire
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
 * Génère les headers Chrome pour les requêtes CEV.
 *
 * Ordre calqué sur le dump réseau humain Chrome 148 (2026-06-08) :
 *   document  → Accept / Accept-Encoding / Accept-Language /
 *               Sec-Fetch-Dest / Sec-Fetch-Mode / Sec-Fetch-Site /
 *               Sec-Fetch-User / Upgrade-Insecure-Requests /
 *               User-Agent / sec-ch-ua / sec-ch-ua-mobile / sec-ch-ua-platform
 *   fetch/xhr → même ordre, Sec-Fetch-Dest=empty, Sec-Fetch-Mode=cors,
 *               pas de Sec-Fetch-User / Upgrade-Insecure-Requests,
 *               + Content-Type / Origin / Referer selon override
 *
 * Suppressions (signaux bot confirmés par diff dump) :
 *   - Cache-Control / Pragma        (absents en navigation fluide Chrome)
 *   - Sec-CH-UA-Arch / Bitness / Full-Version-List / Platform-Version
 *     (high-entropy hints — Chrome ne les envoie que si Accept-CH le demande)
 *
 * Corrections brand :
 *   - "Not/A)Brand" (slash+parenthèse) au lieu de "Not:A-Brand"
 *   - "Google Chrome";v="X" présent dans sec-ch-ua pour les builds Chrome officiels stables
 *   - clés sec-ch-ua* en LOWERCASE (ordre réseau réel)
 *
 * FIX #2 : isFormPost=true force le mode "document navigate" (Sec-Fetch-Mode: navigate,
 *   Sec-Fetch-Dest: document, Sec-Fetch-User: ?1) même quand contentType est fourni.
 *   À utiliser pour les soumissions de formulaire HTML (POST login), pas pour les XHR.
 */
export function getCevBrowserHeaders(overrides?: {
  referer?: string;
  origin?: string;
  accept?: string;
  contentType?: string;
  cookie?: string;
  xRequestedWith?: boolean;
  userAgent?: string;
  /**
   * Valeur explicite de Sec-Fetch-Site.
   * Si absent, calculé automatiquement :
   *   - AJAX sans referer → "same-origin"
   *   - document sans referer → "none"
   *   - avec referer → "same-origin" (par défaut — passer "cross-site" explicitement
   *     pour les sauts inter-domaines, ex: VOWINT → CEV)
   */
  fetchSite?: "none" | "same-origin" | "same-site" | "cross-site";
  /**
   * FIX #2 : Forcer le mode "document navigate" pour les soumissions de formulaire HTML.
   * Quand true : Sec-Fetch-Mode=navigate, Sec-Fetch-Dest=document, Sec-Fetch-User=?1,
   * Cache-Control: max-age=0 toujours présent (Chrome l'ajoute systématiquement),
   * Cookie avant Origin, sec-ch-ua* après User-Agent (ordre Chrome réel pour form POST).
   * Incompatible avec xRequestedWith (XHR).
   */
  isFormPost?: boolean;
  /**
   * Valeur de Cache-Control à injecter en position 4 (après Accept-Language, avant Cookie/CT).
   * Ex : "max-age=0" pour les redirections post-form-submit (GET /en, GET /IndexByUserId) et
   * pour les appels AngularJS $http (GetEAppointmentUrl, DataTables, MyList).
   * Ignoré si isFormPost=true (Cache-Control: max-age=0 est toujours ajouté dans ce cas).
   */
  cacheControl?: string;
  /**
   * Valeur de If-Modified-Since à injecter après Cookie (position 8 dans le HAR réel).
   * Ex : "0" — anti-304 cache IE, envoyé par AngularJS $http sur tous les GET AJAX.
   * Présent sur GetEAppointmentUrl, DataTables, MyList (confirmé HAR 2026-06-08).
   */
  ifModifiedSince?: string;
}): Record<string, string> {
  const chUa = _externalSiphonedChUa ?? _sessionUa.chUa;
  const chUaPlatform = _externalSiphonedPlatform ?? _sessionUa.platform;
  const chUaMobile = _externalSiphonedChUaMobile;
  const ua = overrides?.userAgent ?? _externalSiphonedUa ?? _sessionUa.ua;

  // FIX #2: isFormPost=true → document navigate, même si contentType est fourni
  const isFormPost = !!(overrides?.isFormPost);
  const isAjax = !isFormPost && !!(overrides?.contentType || overrides?.xRequestedWith);

  // ── Ordre DÉFINITIF confirmé par HAR Chrome 148 (2026-06-08) ─────────────────
  //
  // FORM POST (POST /fr/Account/Login) :
  //   Accept → Accept-Encoding → Accept-Language → Cache-Control: max-age=0
  //   → [CT] → [Cookie] → [Origin] → [Referer]
  //   → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → Sec-Fetch-User → UIR
  //   → User-Agent → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform
  //
  // DOCUMENT navigate (GET /en, GET /IndexByUserId, GET Integration/VOW) :
  //   Accept → Accept-Encoding → Accept-Language → [Cache-Control]
  //   → [Cookie] → [Referer] → [Origin]
  //   → Sec-Fetch-Dest → Sec-Fetch-Mode → Sec-Fetch-Site → Sec-Fetch-User → UIR
  //   → User-Agent → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform
  //   NB: Sec-Fetch-Storage-Access ABSENT des navigations document.
  //
  // XHR / AJAX (POST SetCaptchaToken, GET GetEAppointmentUrl, GET MyList) :
  //   Accept → Accept-Encoding → Accept-Language → [Cache-Control]
  //   → [CT] → [Cookie] → [If-Modified-Since] → [Referer] → [Origin]
  //   → Sec-Fetch-Dest: empty → Sec-Fetch-Mode: cors → Sec-Fetch-Site
  //   → [Sec-Fetch-Storage-Access si cross-site]
  //   → User-Agent → [X-Requested-With]
  //   → sec-ch-ua → sec-ch-ua-mobile → sec-ch-ua-platform

  let headers: Record<string, string>;

  if (isFormPost) {
    // ── FIX #2 + #3 : Soumission de formulaire HTML (POST login) ───────────
    //
    // Ordre EXACT confirmé par HAR Chrome 148 (2026-06-08) — POST /fr/Account/Login :
    //   1. Accept
    //   2. Accept-Encoding
    //   3. Accept-Language
    //   4. Cache-Control: max-age=0    ← Chrome l'ajoute TOUJOURS sur form-submit POST
    //   5. [Content-Type]              ← avant Cookie
    //   6. [Cookie]                    ← avant Origin (FIX: était à la fin)
    //   7. [Origin]
    //   8. [Referer]
    //   9. Sec-Fetch-Dest: document
    //  10. Sec-Fetch-Mode: navigate
    //  11. Sec-Fetch-Site
    //  12. Sec-Fetch-User: ?1
    //  13. Upgrade-Insecure-Requests: 1
    //  14. User-Agent
    //  15. sec-ch-ua                   ← APRÈS User-Agent (FIX: était avant Sec-Fetch-*)
    //  16. sec-ch-ua-mobile
    //  17. sec-ch-ua-platform
    const secFetchSite = overrides?.fetchSite
      ?? (overrides?.referer ? "same-origin" : "none");
    let ct: string | undefined;
    if (overrides?.contentType) {
      ct = overrides.contentType.toLowerCase() === "application/x-www-form-urlencoded"
        ? "application/x-www-form-urlencoded"
        : overrides.contentType;
    }
    headers = {
      "Accept": overrides?.accept
        ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Encoding": _sessionAcceptEnc,
      "Accept-Language": _sessionAcceptLang,
      "Cache-Control": "max-age=0",
      ...(ct                 ? { "Content-Type": ct               } : {}),
      ...(overrides?.cookie  ? { "Cookie":  overrides.cookie  } : {}),
      ...(overrides?.origin  ? { "Origin":  overrides.origin  } : {}),
      ...(overrides?.referer ? { "Referer": overrides.referer } : {}),
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": secFetchSite,
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": ua,
      "sec-ch-ua": chUa,
      "sec-ch-ua-mobile": chUaMobile,
      "sec-ch-ua-platform": chUaPlatform,
      "Priority": "u=0, i",
    };
  } else if (!isAjax) {
    // ── Requête document (navigation GET) ──────────────────────────────────
    //
    // Ordre EXACT confirmé par HAR Chrome 148 (2026-06-08) — GET /en, GET /IndexByUserId :
    //   1. Accept
    //   2. Accept-Encoding
    //   3. Accept-Language
    //   4. [Cache-Control: max-age=0]  ← présent sur redirections post-form-submit (optionnel)
    //   5. [Cookie]                    ← avant Referer (FIX: était à la fin)
    //   6. [Referer]
    //   7. [Origin]
    //   8. Sec-Fetch-Dest: document
    //   9. Sec-Fetch-Mode: navigate
    //  10. Sec-Fetch-Site
    //  11. Sec-Fetch-User: ?1
    //  12. Upgrade-Insecure-Requests: 1
    //  13. User-Agent
    //  14. sec-ch-ua
    //  15. sec-ch-ua-mobile
    //  16. sec-ch-ua-platform
    const secFetchSite = overrides?.fetchSite
      ?? (overrides?.referer ? "same-origin" : "none");

    headers = {
      "Accept": overrides?.accept
        ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "Accept-Encoding": _sessionAcceptEnc,
      "Accept-Language": _sessionAcceptLang,
      ...(overrides?.cacheControl ? { "Cache-Control": overrides.cacheControl } : {}),
      ...(overrides?.cookie  ? { "Cookie":  overrides.cookie  } : {}),
      ...(overrides?.referer ? { "Referer": overrides.referer } : {}),
      ...(overrides?.origin  ? { "Origin":  overrides.origin  } : {}),
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": secFetchSite,
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": ua,
      "sec-ch-ua": chUa,
      "sec-ch-ua-mobile": chUaMobile,
      "sec-ch-ua-platform": chUaPlatform,
      "Priority": "u=0, i",
    };
  } else {
    // ── Requête fetch/XHR (AJAX) ────────────────────────────────────────────
    //
    // Ordre EXACT confirmé par HAR Chrome 148 (2026-06-08) :
    //   POST SetCaptchaToken same-origin + GET GetEAppointmentUrl (AngularJS $http) :
    //   1. Accept
    //   2. Accept-Encoding
    //   3. Accept-Language
    //   4. [Cache-Control: max-age=0]  ← AngularJS $http sur GET (optionnel, paramètre cacheControl)
    //   5. [Content-Type]
    //   6. [Cookie]
    //   7. [If-Modified-Since: 0]      ← AngularJS $http anti-304 (optionnel, paramètre ifModifiedSince)
    //   8. [Referer]
    //   9. [Origin]
    //  10. Sec-Fetch-Dest: empty
    //  11. Sec-Fetch-Mode: cors
    //  12. Sec-Fetch-Site
    //  13. [Sec-Fetch-Storage-Access: active]  ← uniquement cross-site
    //  14. User-Agent
    //  15. [X-Requested-With: XMLHttpRequest]
    //  16. sec-ch-ua
    //  17. sec-ch-ua-mobile
    //  18. sec-ch-ua-platform
    let ct: string | undefined;
    if (overrides?.contentType) {
      ct = overrides.contentType.toLowerCase() === "application/x-www-form-urlencoded"
        ? "application/x-www-form-urlencoded; charset=UTF-8"
        : overrides.contentType;
    }

    const secFetchSite = overrides?.fetchSite ?? "same-origin";
    const isCrossSite  = secFetchSite === "cross-site" || secFetchSite === "same-site";

    headers = {
      "Accept": overrides?.accept ?? "*/*",
      "Accept-Encoding": _sessionAcceptEnc,
      "Accept-Language": _sessionAcceptLang,
      ...(overrides?.cacheControl   ? { "Cache-Control":    overrides.cacheControl   } : {}),
      ...(ct                        ? { "Content-Type":     ct                        } : {}),
      ...(overrides?.cookie         ? { "Cookie":           overrides.cookie          } : {}),
      ...(overrides?.ifModifiedSince ? { "If-Modified-Since": overrides.ifModifiedSince } : {}),
      ...(overrides?.referer        ? { "Referer":          overrides.referer         } : {}),
      ...(overrides?.origin         ? { "Origin":           overrides.origin          } : {}),
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": secFetchSite,
      ...(isCrossSite ? { "Sec-Fetch-Storage-Access": "active" } : {}),
      "User-Agent": ua,
      ...(overrides?.xRequestedWith ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      "sec-ch-ua": chUa,
      "sec-ch-ua-mobile": chUaMobile,
      "sec-ch-ua-platform": chUaPlatform,
      "Priority": "u=1, i",
    };
  }

  return headers;
}

// ─── V10 — Offset de rotation par-compte (anti-synchronisation 00h/12h UTC) ──

/**
 * Calcule un offset déterministe [0–3599s] unique par identifiant de compte.
 *
 * Problème original : `halfDay = "AM"|"PM"` provoque une rotation synchronisée
 * de toutes les IPs SOAX/iProyal à 00h00 UTC et 12h00 UTC — pattern détectable.
 *
 * Fix V10 : chaque compte est décalé par hash(identifiant) % 3600, étalant
 * les rotations sur ±1h autour de chaque fenêtre 12h.
 */
function _cevAccountRotationOffsetSec(identifier: string): number {
  const key = identifier.toLowerCase() + ":v10-rotation-offset";
  let h = 0;
  for (const ch of key) h = ((h << 5) - h + ch.charCodeAt(0)) & 0x7fffffff;
  return Math.abs(h) % 3600;
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

    // V10 — Fenêtres 12h décalées par-compte (même logique que SOAX).
    const now = new Date();
    const accountKey = (identifier ?? "cev-default").toLowerCase();
    const offsetSec = _cevAccountRotationOffsetSec(accountKey);
    const windowIdx = Math.floor((Math.floor(now.getTime() / 1000) - offsetSec) / 43200);
    const rotationCount = _cevIproyalRotationCount.get(accountKey) ?? 0;
    const seed = `w${windowIdx}:${accountKey}:cev-iproyal:r${rotationCount}`;
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

    // V10 — Fenêtres 12h décalées par-compte pour éviter rotation synchronisée à 00h/12h UTC.
    const now = new Date();
    const accountKey = (identifier ?? "cev-default").toLowerCase();
    const offsetSec = _cevAccountRotationOffsetSec(accountKey);
    const windowIdx = Math.floor((Math.floor(now.getTime() / 1000) - offsetSec) / 43200);
    const rotationCount = _cevSoaxRotationCount.get(accountKey) ?? 0;
    const seed = `w${windowIdx}:${accountKey}:cev-soax:r${rotationCount}`;
    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 36];
      h = Math.floor(h / 36) + (i + 1) * 7;
    }
    const nextWindowSec = (windowIdx + 1) * 43200 + offsetSec;
    const nextRotationAt = new Date(nextWindowSec * 1000).toISOString().slice(11, 16) + " UTC";
    console.log(`[CEV-SOAX] ⏱ V10 offset=${offsetSec}s window=${windowIdx} → prochaine rotation ~${nextRotationAt}`);

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

// ─── Decodo Sticky Session Management ──────────────────────────────────────

/** Compteur de rotation Decodo par identifiant. */
const _cevDecodoRotationCount = new Map<string, number>();

/** Lifetime des sessions sticky Decodo (minutes) — cohérent avec iProyal. */
const DECODO_STICKY_LIFETIME_MIN = 60;

/**
 * Génère une URL Decodo résidentiel avec session sticky déterministe par dossier.
 *
 * Format Decodo résidentiel: http://user-sessid-{id}-sesstime-{min}:pass@gate.decodo.com:PORT
 *
 * Session ID déterministe par (fenêtre 12h + accountId + rotationCount) — même
 * logique V10 que SOAX/iProyal pour éviter la rotation synchronisée à 00h/12h UTC.
 *
 * @param baseUrl      - URL de base Decodo (http://user:pass@gate.decodo.com:PORT)
 * @param lifetimeMinutes - Durée sticky en minutes
 * @param identifier   - Identifiant unique par dossier (ex: "cev-dossier-VOWINTXXXXX")
 */
export function makeCevDecodoStickyUrl(
  baseUrl: string,
  lifetimeMinutes: number = DECODO_STICKY_LIFETIME_MIN,
  identifier?: string,
): string {
  try {
    const parsed = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    let proxyUser = decodeURIComponent(parsed.username);

    // Nettoyer les anciens paramètres de session Decodo si présents
    proxyUser = proxyUser
      .replace(/-sessid-[^-]*/g, "")
      .replace(/-sesstime-[^-]*/g, "")
      .replace(/-+$/, "");

    // V10 — Fenêtres 12h décalées par-compte (même logique SOAX/iProyal)
    const now = new Date();
    const accountKey = (identifier ?? "cev-default").toLowerCase();
    const offsetSec = _cevAccountRotationOffsetSec(accountKey);
    const windowIdx = Math.floor((Math.floor(now.getTime() / 1000) - offsetSec) / 43200);
    const rotationCount = _cevDecodoRotationCount.get(accountKey) ?? 0;
    const seed = `w${windowIdx}:${accountKey}:cev-decodo:r${rotationCount}`;
    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 36];
      h = Math.floor(h / 36) + (i + 1) * 7;
    }

    const nextWindowSec = (windowIdx + 1) * 43200 + offsetSec;
    const nextRotationAt = new Date(nextWindowSec * 1000).toISOString().slice(11, 16) + " UTC";
    console.log(`[CEV-DECODO] ⏱ V10 offset=${offsetSec}s window=${windowIdx} → prochaine rotation ~${nextRotationAt}`);

    proxyUser += `-sessid-${sessionId}-sesstime-${lifetimeMinutes}`;
    parsed.username = encodeURIComponent(proxyUser);
    console.log(`[CEV] 🔒 Decodo sticky sessid=${sessionId} sesstime=${lifetimeMinutes}min rot#${rotationCount}`);
    return parsed.toString();
  } catch {
    console.warn(`[CEV] ⚠️ Impossible de parser l'URL Decodo — fallback URL brute`);
    return baseUrl;
  }
}

/**
 * Force la rotation du proxy Decodo pour un identifiant CEV donné.
 */
export function rotateCevDecodoSession(identifier: string): void {
  const key = identifier.toLowerCase();
  const current = _cevDecodoRotationCount.get(key) ?? 0;
  _cevDecodoRotationCount.set(key, current + 1);
  _proxyImpit = undefined;
  _proxyImpitUrl = undefined;
  console.log(`[CEV] 🔄 Rotation proxy Decodo demandée pour ${key.slice(0, 20)}… (rot#${current + 1})`);
}

/**
 * Génère une URL proxy CEV sticky agnostique (SOAX, iProyal ou Decodo selon le provider choisi).
 *
 * @param provider - "soax" | "iproyal" | "decodo"
 * @param lifetimeMinutes - Durée de session sticky
 * @param identifier - Identifiant unique du slot IP
 */
export function makeCevProxyStickyUrl(
  provider: "soax" | "iproyal" | "decodo",
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
  if (provider === "decodo") {
    const base = DECODO_PROXY_URL_CEV;
    if (!base) {
      console.warn(`[CEV] ⚠️ DECODO_PROXY_URL non configurée — fallback sans proxy`);
      return "";
    }
    return makeCevDecodoStickyUrl(base, lifetimeMinutes ?? DECODO_STICKY_LIFETIME_MIN, identifier);
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
export function rotateCevProxySession(provider: "soax" | "iproyal" | "decodo", identifier: string): void {
  if (provider === "soax") {
    rotateCevSoaxSession(identifier);
  } else if (provider === "decodo") {
    rotateCevDecodoSession(identifier);
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
    const opts: Record<string, unknown> = { browser: "chrome" };
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
    _directImpit = new Impit({ browser: "chrome" } as any);
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

/** Récupère l'URL proxy actuellement utilisé par le CEV (si disponible) */
export function getCevProxyUrl(): string | undefined {
  return _cevProxyGuardState?.proxyUrl;
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

  // ── Vérifier si le proxy est désactivé via botConfig ─────────────────────────
  const useProxy = await shouldUseProxy();
  if (!useProxy) {
    // Proxy désactivé par configuration — connexion directe
    console.log(`${logPrefix} 🔄 Proxy désactivé via botConfig → mode direct`);
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

  // ── Jitter réseau log-normal (distribution réaliste — remplace Math.random uniforme) ──
  // Log-normal centré ~80ms (mu=4.2, sigma=0.45) — plage effective 20-350ms
  const _u1 = Math.random(), _u2 = Math.random();
  const _z = Math.sqrt(-2 * Math.log(_u1 + 1e-10)) * Math.cos(2 * Math.PI * _u2);
  const jitterMs = Math.max(20, Math.min(400, Math.exp(4.2 + 0.45 * _z)));
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
        console.error(`${logPrefix} ❌ Proxy 422 (CONNECT tunnel rejected) — Proxy utilisé: ${currentProxy?.replace(/:([^:@]+)@/, ":***@")}`);
        console.error(`${logPrefix} ❌ BASCULEMENT MODE DIRECT`);
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

      if (res.status === 502 || res.status === 503 || res.status === 504) {
        console.warn(`${logPrefix} ⚠️ HTTP ${res.status} (attempt ${attempt + 1}/${PROXY_MAX_RETRIES + 1})`);
        lastError = new Error(`ERROR_${res.status}`);
        if (attempt < PROXY_MAX_RETRIES) {
          if (res.status === 502) {
            // 502 = erreur gateway proxy → rotation IP immédiate
            if (currentProxy?.includes("soax") || currentProxy?.includes("sessionid")) {
              rotateCevSoaxSession("cev-retry");
              const newProxyUrl = makeCevProxyStickyUrl("soax", undefined, "cev-retry");
              process.env.IPROYAL_PROXY_URL = newProxyUrl;
              resetCevImpitInstances();
              console.log(`${logPrefix} 🔄 Rotation SOAX IP pour retry #${attempt + 2} (HTTP 502)`);
            }
            await new Promise(r => setTimeout(r, PROXY_RETRY_DELAY_MS));
          } else {
            // 503/504 = charge serveur CEV (pas un blocage) → retry immédiat, même IP
            console.log(`${logPrefix} ⚡ HTTP ${res.status} = charge serveur — retry immédiat (même IP, pas de rotation)`);
            // Pas de délai, pas de rotation : le serveur CEV est surchargé momentanément
          }
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
        console.error(`${logPrefix} ❌ Proxy 422 tunnel error (exception) — Proxy utilisé: ${currentProxy?.replace(/:([^:@]+)@/, ":***@")}`);
        console.error(`${logPrefix} ❌ BASCULEMENT MODE DIRECT`);
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
