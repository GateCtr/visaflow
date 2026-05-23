/**
 * cev-shared-impit.ts — Singleton impit partagé entre cevHttpSetup et cevPolling.
 * 
 * ANTI-DETECTION: Aligné sur le niveau USA (getBrowserHeaders).
 * Inclut : Sec-CH-UA, Sec-Fetch-*, jitter réseau, device fingerprint cohérent.
 * 
 * Évite l'import circulaire : setup ↔ polling.
 * Les deux modules importent depuis ce fichier commun.
 */

import { Impit } from "impit";

const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;

// ─── UA Pool Chrome (aligné sur usa-http.ts) ────────────────────────────────

interface UaProfile {
  ua: string;
  chUa: string;
  platform: string;
}

const CEV_UA_POOL: UaProfile[] = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="135", "Not.A/Brand";v="99", "Google Chrome";v="135"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
    platform: '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    chUa: '"Chromium";v="136", "Not.A/Brand";v="99", "Microsoft Edge";v="136"',
    platform: '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa: '"Chromium";v="135", "Not.A/Brand";v="99", "Google Chrome";v="135"',
    platform: '"Linux"',
  },
];

// Sticky UA par session (ne change pas mid-session)
let _sessionUa: UaProfile = CEV_UA_POOL[Math.floor(Math.random() * CEV_UA_POOL.length)];
let _sessionAcceptLang = "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7";
let _sessionAcceptEnc = "gzip, deflate, br, zstd";

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
  return _sessionUa.ua;
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
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": overrides?.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Encoding": _sessionAcceptEnc,
    "Accept-Language": _sessionAcceptLang,
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-CH-UA": _sessionUa.chUa,
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": _sessionUa.platform,
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": _sessionUa.ua,
  };

  if (overrides?.referer) headers["Referer"] = overrides.referer;
  if (overrides?.origin) headers["Origin"] = overrides.origin;
  if (overrides?.cookie) headers["Cookie"] = overrides.cookie;
  if (overrides?.contentType) {
    headers["Content-Type"] = overrides.contentType;
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

// ─── Impit Instances ────────────────────────────────────────────────────────

/** Singleton impit avec proxy (fingerprint TLS Chrome) */
let _proxyImpit: InstanceType<typeof Impit> | undefined;
let _proxyImpitUrl: string | undefined;

export function getProxyImpit(proxyUrl?: string): InstanceType<typeof Impit> {
  const targetProxy = proxyUrl ?? IPROYAL_PROXY_URL;
  // Recréer si le proxy a changé
  if (!_proxyImpit || targetProxy !== _proxyImpitUrl) {
    const opts: Record<string, unknown> = { browser: "chrome", ignoreTlsErrors: true };
    if (targetProxy) opts.proxyUrl = targetProxy;
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
 * - Fallback proxy → direct si proxy down
 */
export async function cevImpitFetch(url: string, options: RequestInit, logPrefix = "[CEV]"): Promise<Response> {
  // ── Jitter réseau réaliste (comme usa-http.ts) ──────────────────────────────
  // Un vrai navigateur a une latence variable avant chaque requête.
  // Sans jitter = signature de bot (requêtes à intervalle constant).
  const jitterMs = 30 + Math.random() * 170; // 30-200ms
  await new Promise(r => setTimeout(r, jitterMs));

  const currentProxy = IPROYAL_PROXY_URL;
  if (currentProxy) {
    try {
      return await getProxyImpit(currentProxy).fetch(url, options as any) as unknown as Response;
    } catch {
      console.log(`${logPrefix} ⚠️ impit+proxy failed → fallback impit direct`);
      return getDirectImpit().fetch(url, options as any) as unknown as Response;
    }
  }
  return getDirectImpit().fetch(url, options as any) as unknown as Response;
}
