// ─── Germany RK-Termin — Session Management ────────────────────────────────
// Gère les cookies (JSESSIONID + KEKS) et la navigation initiale.

import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { RKTERMIN_BASE_URL, RKTERMIN_ENDPOINTS, RKTERMIN_HEADERS, RKTERMIN_TIMING, RKTERMIN_USER_AGENTS } from "./config.js";
import type { RKTerminSession, RKTerminConfig } from "./types.js";
import { hasDecodoProxy, rotateDecodoUrl, getCurrentDecodoUrl } from "../spain-decodo-pool.js";

declare const process: { env: Record<string, string | undefined> };

// ─── Connexion HTTP ──────────────────────────────────────────────────────────
// service2.diplo.de est joignable en direct, mais il est LENT (souvent 10-20s
// pour l'établissement TLS depuis une IP datacenter) et refuse parfois la
// connexion pendant quelques minutes. Le dispatcher undici par défaut coupe la
// connexion au bout de 10s → « ConnectTimeoutError ». On utilise donc un Agent
// dédié avec un connectTimeout large + un retry avec backoff.
// Un proxy optionnel peut être fourni via GERMANY_PROXY_URL / RKTERMIN_PROXY_URL.

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin] [${level}] ${msg}`);

/** Sélection UA aléatoire */
function randomUA(): string {
  return RKTERMIN_USER_AGENTS[Math.floor(Math.random() * RKTERMIN_USER_AGENTS.length)];
}

// ─── Dispatcher undici dédié ────────────────────────────────────────────────

let rkDispatcher: Dispatcher | null = null;
/** URL de proxy actuellement utilisée par rkDispatcher (pour détecter un changement). */
let rkDispatcherProxyUrl: string | null = null;

/** Masque les identifiants d'une URL de proxy pour les logs. */
function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? "***:***@" : ""}${u.host}`;
  } catch {
    return "proxy (url illisible)";
  }
}

/**
 * Priorité de sélection du proxy Germany :
 *  1. GERMANY_PROXY_URL / RKTERMIN_PROXY_URL  (override manuel)
 *  2. Pool Decodo CSV (décodo-proxies.csv / DECODO_PROXY_URL*)
 *  3. Accès direct (risque de timeout/blocage IP)
 */
function resolveProxyUrl(): string | null {
  return (
    process.env.GERMANY_PROXY_URL ??
    process.env.RKTERMIN_PROXY_URL ??
    getCurrentDecodoUrl() ??
    null
  );
}

/**
 * Dispatcher partagé pour toutes les requêtes RK-Termin.
 * Reconstruit automatiquement si l'URL de proxy a changé (rotation).
 */
export function getRKDispatcher(): Dispatcher {
  const proxyUrl = resolveProxyUrl();

  // Recréer si pas encore initialisé OU si le proxy a changé (rotation Decodo)
  if (rkDispatcher && proxyUrl === rkDispatcherProxyUrl) return rkDispatcher;

  const connect = {
    timeout: RKTERMIN_TIMING.connectTimeoutMs,
    // Happy Eyeballs : si l'hôte annonce une route IPv6 non fonctionnelle,
    // bascule sur IPv4 après 1.5s au lieu d'attendre le timeout complet.
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 1_500,
  };
  const common = {
    connect,
    headersTimeout: RKTERMIN_TIMING.requestTimeoutMs,
    bodyTimeout: RKTERMIN_TIMING.requestTimeoutMs,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 6,
  };

  if (proxyUrl) {
    log("INFO", `Proxy RK-Termin: ${maskProxyUrl(proxyUrl)}`);
    rkDispatcher = new ProxyAgent({ uri: proxyUrl, ...common });
  } else {
    log("WARN", `Accès direct service2.diplo.de — risque de timeout (configurez GERMANY_PROXY_URL ou decodo-proxies.csv)`);
    rkDispatcher = new Agent(common);
  }
  rkDispatcherProxyUrl = proxyUrl;

  return rkDispatcher;
}

/**
 * Fait tourner le pool Decodo (prochaine IP) et force la reconstruction
 * du dispatcher lors du prochain appel à getRKDispatcher().
 * À appeler au début de chaque scan pour changer d'IP.
 */
export function rotateRKProxy(): void {
  if (!hasDecodoProxy()) return; // pas de pool configuré, rien à faire
  // Env overrides manuels : pas de rotation automatique (l'IP est fixée intentionnellement)
  if (process.env.GERMANY_PROXY_URL || process.env.RKTERMIN_PROXY_URL) return;
  const next = rotateDecodoUrl(); // avance le compteur round-robin
  if (next) {
    rkDispatcherProxyUrl = null; // force rebuild au prochain getRKDispatcher()
    rkDispatcher = null;
  }
}

// ─── Classification des erreurs réseau ──────────────────────────────────────

/** Codes undici/Node correspondant à un échec d'établissement de connexion. */
const CONNECTION_ERROR_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "ECONNABORTED",
]);

/** Codes supplémentaires transitoires (la requête a pu partir). */
const TRANSIENT_ERROR_CODES = new Set([
  ...CONNECTION_ERROR_CODES,
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_DESTROYED",
  "UND_ERR_RESPONSE_STATUS_CODE",
]);

const CONNECTION_ERROR_PATTERN = /Connect\s?Timeout|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo/i;
const TRANSIENT_ERROR_PATTERN = /Connect\s?Timeout|Headers\s?Timeout|Body\s?Timeout|fetch failed|socket hang up|other side closed|network|terminated|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR|The operation was aborted|Pas de JSESSIONID|serveur est peut-être down/i;

function matchError(err: unknown, codes: Set<string>, pattern: RegExp, depth = 0): boolean {
  if (!err || depth > 4) return false;
  if (typeof err === "string") return pattern.test(err);
  const e = err as { code?: string; name?: string; message?: string; cause?: unknown };
  if (e.code && codes.has(e.code)) return true;
  if (e.cause && matchError(e.cause, codes, pattern, depth + 1)) return true;
  return typeof e.message === "string" && pattern.test(e.message);
}

/**
 * L'erreur vient-elle d'un échec de connexion (le serveur n'a jamais reçu la requête) ?
 * Ces erreurs sont TOUJOURS rejouables, même pour un POST.
 */
export function isConnectionError(err: unknown): boolean {
  return matchError(err, CONNECTION_ERROR_CODES, CONNECTION_ERROR_PATTERN);
}

/**
 * Erreur réseau transitoire (portail injoignable/lent) par opposition à une
 * erreur « métier » (config invalide, captcha introuvable, booking refusé).
 * Utilisée par germany-loop pour éviter de mettre un dossier en pause
 * simplement parce que service2.diplo.de a hoqueté.
 */
export function isTransientNetworkError(err: unknown): boolean {
  return matchError(err, TRANSIENT_ERROR_CODES, TRANSIENT_ERROR_PATTERN);
}

/** Message d'erreur lisible incluant la cause undici sous-jacente. */
export function describeNetworkError(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  // La cause est déjà dépliée dans le message (erreur re-wrappée) → ne pas dupliquer
  if (!cause || base.includes("(cause:")) return base;
  const causeMsg = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return `${base} (cause: ${causeMsg})`;
}

// ─── Fetch avec retry ───────────────────────────────────────────────────────

function backoffDelay(attempt: number): number {
  const { baseDelayMs, maxDelayMs } = RKTERMIN_TIMING.networkRetry;
  const exp = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return exp + Math.random() * 500; // jitter
}

/**
 * Exécute un fetch RK-Termin et lit la réponse, avec retry sur erreur réseau.
 *
 * @param retryAfterSend Autoriser le retry même si la requête a pu atteindre le
 *                       serveur. `false` pour les POST non idempotents : seules
 *                       les erreurs de connexion sont alors rejouées.
 */
async function rkFetchHtml(
  url: string,
  init: RequestInit,
  label: string,
  retryAfterSend: boolean,
): Promise<{ html: string; status: number; headers: Headers }> {
  const { maxAttempts } = RKTERMIN_TIMING.networkRetry;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RKTERMIN_TIMING.requestTimeoutMs);

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        dispatcher: getRKDispatcher(),
      } as RequestInit & { dispatcher?: Dispatcher });

      const html = await res.text();
      clearTimeout(timeout);

      // 429 / 5xx : le portail est saturé → retry avec backoff
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const delay = backoffDelay(attempt);
        log("WARN", `${label}: HTTP ${res.status} (tentative ${attempt}/${maxAttempts}) — retry dans ${Math.round(delay / 1000)}s`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (attempt > 1) log("INFO", `${label}: OK après ${attempt} tentative(s)`);
      return { html, status: res.status, headers: res.headers };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;

      const retryable = isConnectionError(err) || (retryAfterSend && isTransientNetworkError(err));
      if (attempt >= maxAttempts || !retryable) break;

      const delay = backoffDelay(attempt);
      log("WARN", `${label}: échec réseau (tentative ${attempt}/${maxAttempts}) — ${describeNetworkError(err)} — retry dans ${Math.round(delay / 1000)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Pause aléatoire entre min et max ms */
export async function randomDelay(min: number, max: number): Promise<void> {
  const ms = min + Math.random() * (max - min);
  await new Promise(r => setTimeout(r, ms));
}

/** Parse les cookies Set-Cookie d'une réponse HTTP */
function parseCookies(headers: Headers): { jsessionId?: string; keks?: string } {
  const result: { jsessionId?: string; keks?: string } = {};
  const setCookies = headers.getSetCookie?.() ?? [];
  
  for (const cookie of setCookies) {
    const jsMatch = cookie.match(/JSESSIONID=([^;]+)/);
    if (jsMatch) result.jsessionId = jsMatch[1];
    
    const keksMatch = cookie.match(/KEKS=([^;]+)/);
    if (keksMatch) result.keks = keksMatch[1];
  }
  
  return result;
}

/** Construit le header Cookie pour les requêtes */
export function buildCookieHeader(session: RKTerminSession): string {
  return `JSESSIONID=${session.jsessionId}; KEKS=${session.keks}`;
}

/** Construit l'URL complète pour un endpoint */
export function buildUrl(endpoint: string, params?: Record<string, string | number>): string {
  let url = `${RKTERMIN_BASE_URL}/${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      searchParams.set(key, String(value));
    }
    url += `?${searchParams.toString()}`;
  }
  return url;
}

/** Exécute une requête GET avec gestion de session */
export async function rkGet(
  session: RKTerminSession,
  endpoint: string,
  params?: Record<string, string | number>,
): Promise<{ html: string; status: number; newSession?: Partial<RKTerminSession> }> {
  const url = buildUrl(endpoint, params);

  try {
    // GET idempotent → retry autorisé sur toute erreur réseau transitoire
    const { html, status, headers } = await rkFetchHtml(
      url,
      {
        method: "GET",
        headers: {
          ...RKTERMIN_HEADERS,
          "User-Agent": randomUA(),
          "Cookie": buildCookieHeader(session),
        },
        redirect: "follow",
      },
      `rkGet ${endpoint}`,
      true,
    );

    const cookies = parseCookies(headers);

    // Mettre à jour la session si nouveaux cookies
    const newSession: Partial<RKTerminSession> = {};
    if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
    if (cookies.keks) newSession.keks = cookies.keks;

    return { html, status, newSession: Object.keys(newSession).length ? newSession : undefined };
  } catch (err) {
    throw new Error(`rkGet ${endpoint} failed: ${describeNetworkError(err)}`, { cause: err });
  }
}

/** Exécute une requête POST (form-encoded) avec gestion de session */
export async function rkPost(
  session: RKTerminSession,
  endpoint: string,
  formData: Record<string, string>,
): Promise<{ html: string; status: number; newSession?: Partial<RKTerminSession> }> {
  const url = `${RKTERMIN_BASE_URL}/${endpoint}`;
  
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(formData)) {
    body.set(key, value);
  }
  
  try {
    // POST non idempotent → retry uniquement si la connexion n'a jamais abouti
    const { html, status, headers } = await rkFetchHtml(
      url,
      {
        method: "POST",
        headers: {
          ...RKTERMIN_HEADERS,
          "User-Agent": randomUA(),
          "Cookie": buildCookieHeader(session),
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": url,
          "Origin": RKTERMIN_BASE_URL,
        },
        body: body.toString(),
        redirect: "follow",
      },
      `rkPost ${endpoint}`,
      false,
    );

    const cookies = parseCookies(headers);

    const newSession: Partial<RKTerminSession> = {};
    if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
    if (cookies.keks) newSession.keks = cookies.keks;

    return { html, status, newSession: Object.keys(newSession).length ? newSession : undefined };
  } catch (err) {
    throw new Error(`rkPost ${endpoint} failed: ${describeNetworkError(err)}`, { cause: err });
  }
}

/**
 * Initialise une session fraîche en accédant à la page appointment_showMonth.
 * Retourne la session (cookies) ET le HTML de la page captcha.
 */
export async function initSession(config: RKTerminConfig): Promise<{ session: RKTerminSession; html: string }> {
  const url = buildUrl(RKTERMIN_ENDPOINTS.appointmentShowMonth, {
    locationCode: config.locationCode,
    realmId: config.realmId,
    categoryId: config.categoryId,
    request_locale: config.locale,
  });
  
  log("DEBUG", `Initialisation session: ${config.locationCode} realm=${config.realmId} cat=${config.categoryId}`);
  
  try {
    const { html, status, headers } = await rkFetchHtml(
      url,
      {
        method: "GET",
        headers: {
          ...RKTERMIN_HEADERS,
          "User-Agent": randomUA(),
        },
        redirect: "follow",
      },
      "initSession",
      true,
    );

    const cookies = parseCookies(headers);

    if (!cookies.jsessionId) {
      throw new Error(`Pas de JSESSIONID dans la réponse (HTTP ${status}) — le serveur est peut-être down`);
    }
    
    const session: RKTerminSession = {
      jsessionId: cookies.jsessionId,
      keks: cookies.keks ?? "TERMINA",
      createdAt: Date.now(),
      monthCaptchaSolved: false,
    };
    
    log("DEBUG", `Session créée: JSESSIONID=${session.jsessionId.slice(0, 8)}... KEKS=${session.keks}`);
    
    return { session, html };
  } catch (err) {
    // Exposer la cause sous-jacente (ConnectTimeout, ECONNRESET, etc.) pour diagnostiquer
    // les blocages IP (service2.diplo.de throttle les plages IP datacenter Railway/cloud).
    throw new Error(`initSession failed: ${describeNetworkError(err)}`, { cause: err });
  }
}

/** Vérifie si la session est encore valide (pas expirée). */
export function isSessionValid(session: RKTerminSession): boolean {
  return (Date.now() - session.createdAt) < RKTERMIN_TIMING.sessionMaxAgeMs;
}

/** Met à jour la session avec de nouveaux cookies si fournis. */
export function updateSession(session: RKTerminSession, update?: Partial<RKTerminSession>): RKTerminSession {
  if (!update) return session;
  return { ...session, ...update };
}
