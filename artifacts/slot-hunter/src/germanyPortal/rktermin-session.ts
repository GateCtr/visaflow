// ─── Germany RK-Termin — Session Management ────────────────────────────────
// Gère les cookies (JSESSIONID + KEKS) et la navigation initiale.

import { RKTERMIN_BASE_URL, RKTERMIN_ENDPOINTS, RKTERMIN_HEADERS, RKTERMIN_TIMING, RKTERMIN_USER_AGENTS } from "./config.js";
import type { RKTerminSession, RKTerminConfig } from "./types.js";
import { ProxyAgent } from "undici";
import { hasGermanyDecodoProxy, rotateGermanyDecodoUrl, getCurrentGermanyDecodoUrl } from "../germany-decodo-pool.js";

declare const process: { env: Record<string, string | undefined> };

/**
 * Construit une URL SOAX sticky pour Germany.
 *
 * service2.diplo.de bloque les plages IP datacenter (Railway, AWS, Decodo ISP, etc.) —
 * le symptôme est "fetch failed" en ~1-3s (connexion reset/refusée, pas un timeout).
 * SOAX résidentiel contourne ce blocage.
 *
 * Format URL SOAX : http://package-XXXXX:PASSWORD@proxy.soax.com:5000
 * On ajoute "-sessionid-XXXX" pour une IP sticky de 10min (évite les rotations mid-session).
 * Pas de contrainte de pays (-country-de serait plus "naturel" mais réduit le pool).
 */
function makeSoaxGermanyUrl(baseUrl: string): string {
  try {
    const u = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    const decodedUser = decodeURIComponent(u.username);
    const baseUser = decodedUser.replace(/-sessionid-[a-z0-9]+$/i, "");
    const sessionId = Math.random().toString(36).slice(2, 10);
    u.username = encodeURIComponent(`${baseUser}-sessionid-${sessionId}`);
    return u.toString();
  } catch {
    return baseUrl;
  }
}

// ─── Proxy cache (module-level, stable par session) ─────────────────────────
// diplo.de lie le JSESSIONID à l'IP source → le proxy ne doit PAS changer
// en cours de session. On cache le dispatcher et on ne le régénère que sur
// appel explicite de rotateRKProxy() (entre deux sessions).
let cachedDispatcher: { dispatcher: ProxyAgent; label: string } | undefined;

/**
 * Construit un ProxyAgent frais pour Germany (sans cache).
 *
 * Ordre de priorité :
 *  1. GERMANY_PROXY_URL — URL proxy dédiée Germany (résidentiel recommandé)
 *  2. SOAX_PROXY_URL    — SOAX résidentiel sticky (nouvelle sessionId à chaque appel)
 *  3. Pool Decodo CSV   — Round-robin partagé avec Espagne (3e fallback)
 *  4. Direct            — OK en local/Replit, bloqué sur Railway/cloud
 */
function buildProxyDispatcher(): { dispatcher: ProxyAgent; label: string } | undefined {
  const germanyUrl = process.env["GERMANY_PROXY_URL"];
  if (germanyUrl) {
    try {
      return { dispatcher: new ProxyAgent(germanyUrl), label: "GERMANY_PROXY_URL" };
    } catch { /* fall through */ }
  }

  const soaxBase = process.env["SOAX_PROXY_URL"];
  if (soaxBase) {
    try {
      const stickyUrl = makeSoaxGermanyUrl(soaxBase);
      return { dispatcher: new ProxyAgent(stickyUrl), label: "SOAX résidentiel (sticky)" };
    } catch { /* fall through */ }
  }

  // 3e fallback : pool Decodo CSV dédié Germany (decodo-proxies-germany.csv).
  if (hasGermanyDecodoProxy()) {
    const decodoUrl = getCurrentGermanyDecodoUrl();
    if (decodoUrl) {
      try {
        return { dispatcher: new ProxyAgent(decodoUrl), label: `Decodo Germany ${decodoUrl.split(":").pop()}` };
      } catch { /* fall through */ }
    }
  }

  return undefined;
}

/** Retourne le dispatcher courant (stable) ou le construit si absent. */
function getProxyDispatcher(): { dispatcher: ProxyAgent; label: string } | undefined {
  if (!cachedDispatcher) {
    cachedDispatcher = buildProxyDispatcher();
  }
  return cachedDispatcher;
}

/**
 * Tourne l'IP du proxy Germany.
 * Appelé par germany-loop.ts avant chaque nouvelle session (pas pendant une session active).
 * Avance le round-robin Decodo ET vide le cache → prochain appel getProxyDispatcher() choisit
 * la nouvelle IP.
 */
export function rotateRKProxy(): void {
  if (hasGermanyDecodoProxy()) {
    rotateGermanyDecodoUrl(); // avance l'index Decodo Germany
  }
  cachedDispatcher = undefined; // force la reconstruction avec la nouvelle IP
}

/**
 * Détecte si une erreur est d'origine réseau/transitoire (timeout, reset, connexion refusée).
 * Exporté pour germany-loop.ts qui doit distinguer erreurs réseau vs erreurs métier.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = (err as any)?.cause;
  const causeMsg = cause instanceof Error ? cause.message : String(cause ?? "");
  return (
    causeMsg.includes("ConnectTimeoutError") ||
    causeMsg.includes("ConnectTimeout") ||
    causeMsg.includes("ECONNRESET") ||
    causeMsg.includes("ECONNREFUSED") ||
    causeMsg.includes("UND_ERR_CONNECT_TIMEOUT") ||
    msg.includes("ConnectTimeoutError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("aborted") ||
    msg.includes("This operation was aborted") ||
    msg.includes("fetch failed")
  );
}

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [rktermin] [${level}] ${msg}`);

/** Sélection UA aléatoire */
function randomUA(): string {
  return RKTERMIN_USER_AGENTS[Math.floor(Math.random() * RKTERMIN_USER_AGENTS.length)];
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

/** Exécute une requête GET avec gestion de session (retry × 2 sur erreurs réseau transitoires) */
export async function rkGet(
  session: RKTerminSession,
  endpoint: string,
  params?: Record<string, string | number>,
  options?: { referer?: string },
): Promise<{ html: string; status: number; newSession?: Partial<RKTerminSession> }> {
  const url = buildUrl(endpoint, params);
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RKTERMIN_TIMING.requestTimeoutMs);
    const proxy = getProxyDispatcher();

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          ...RKTERMIN_HEADERS,
          "User-Agent": randomUA(),
          "Cookie": buildCookieHeader(session),
          ...(options?.referer ? { "Referer": options.referer } : {}),
        },
        redirect: "follow",
        signal: controller.signal,
        // @ts-ignore — undici dispatcher not in lib.dom types
        dispatcher: proxy?.dispatcher,
      });

      clearTimeout(timeout);
      const html = await res.text();
      const cookies = parseCookies(res.headers);

      const newSession: Partial<RKTerminSession> = {};
      if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
      if (cookies.keks) newSession.keks = cookies.keks;

      return { html, status: res.status, newSession: Object.keys(newSession).length ? newSession : undefined };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;

      if (isTransientNetworkError(err) && attempt < MAX_ATTEMPTS) {
        const backoffMs = attempt * 5_000; // 5s, 10s
        console.log(`[${new Date().toISOString()}] [rktermin] [WARN] rkGet ${endpoint} attempt ${attempt}/${MAX_ATTEMPTS} — erreur transitoire. Retry dans ${backoffMs / 1000}s...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      const cause = (err as any)?.cause;
      throw new Error(`rkGet ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}${cause ? ` (cause: ${cause})` : ""}`);
    }
  }
  throw lastErr;
}

/** Exécute une requête POST (form-encoded) avec gestion de session.
 *  Retourne `finalUrl` (URL après redirects) — utilisé pour détecter le redirect
 *  vers `appointment_thanx.do` qui signale une réservation réussie.
 */
export async function rkPost(
  session: RKTerminSession,
  endpoint: string,
  formData: Record<string, string>,
  options?: { referer?: string },
): Promise<{ html: string; status: number; finalUrl: string; newSession?: Partial<RKTerminSession> }> {
  const url = `${RKTERMIN_BASE_URL}/${endpoint}`;

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(formData)) {
    body.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RKTERMIN_TIMING.requestTimeoutMs);
  const proxy = getProxyDispatcher();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...RKTERMIN_HEADERS,
        "User-Agent": randomUA(),
        "Cookie": buildCookieHeader(session),
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": options?.referer ?? url,
        "Origin": RKTERMIN_BASE_URL,
      },
      body: body.toString(),
      redirect: "follow",
      signal: controller.signal,
      // @ts-ignore — undici dispatcher not in lib.dom types
      dispatcher: proxy?.dispatcher,
    });

    clearTimeout(timeout);
    const html = await res.text();
    const finalUrl = res.url ?? url;
    const cookies = parseCookies(res.headers);

    const newSession: Partial<RKTerminSession> = {};
    if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
    if (cookies.keks) newSession.keks = cookies.keks;

    return { html, status: res.status, finalUrl, newSession: Object.keys(newSession).length ? newSession : undefined };
  } catch (err) {
    clearTimeout(timeout);
    const cause = (err as any)?.cause;
    throw new Error(`rkPost ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}${cause ? ` (cause: ${cause})` : ""}`);
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
  
  const proxy = getProxyDispatcher();
  if (proxy) {
    log("DEBUG", `Via proxy: ${proxy.label}`);
  } else {
    log("DEBUG", "Direct (pas de proxy configuré — risque de blocage IP Railway/cloud)");
  }

  // Retry pour les erreurs réseau transitoires (ConnectTimeoutError, ECONNRESET, AbortError timeout).
  // Ces erreurs surviennent lors de pics de charge réseau ou de micro-coupures proxy et ne doivent
  // pas déclencher l'auto-pause du dossier. On retente 3 fois avec backoff exponentiel.
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RKTERMIN_TIMING.requestTimeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          ...RKTERMIN_HEADERS,
          "User-Agent": randomUA(),
        },
        redirect: "follow",
        signal: controller.signal,
        // @ts-ignore — undici dispatcher not in lib.dom types
        dispatcher: proxy?.dispatcher,
      });

      clearTimeout(timeout);
      const html = await res.text();
      const cookies = parseCookies(res.headers);

      if (!cookies.jsessionId) {
        throw new Error("Pas de JSESSIONID dans la réponse — le serveur est peut-être down");
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
      clearTimeout(timeout);
      lastErr = err;

      if (isTransientNetworkError(err) && attempt < MAX_ATTEMPTS) {
        const causeMsg = (err as any)?.cause instanceof Error ? (err as any).cause.message : String((err as any)?.cause ?? "");
        const backoffMs = attempt * 8_000; // 8s, 16s
        log("WARN", `initSession attempt ${attempt}/${MAX_ATTEMPTS} — erreur transitoire (${causeMsg || (err instanceof Error ? err.message : String(err))}). Retry dans ${backoffMs / 1000}s...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }

      // Erreur non-transitoire ou tentatives épuisées — lever
      const msg = err instanceof Error ? err.message : String(err);
      const cause = (err as any)?.cause;
      const causeStr = cause ? ` (cause: ${cause})` : "";
      const hint = !proxy
        ? " — configurer GERMANY_PROXY_URL ou SOAX_PROXY_URL pour contourner le blocage IP"
        : "";
      throw new Error(`initSession failed: ${msg}${causeStr}${hint}`);
    }
  }

  // Ne devrait jamais être atteint (la boucle throw avant)
  throw lastErr;
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
