// ─── Germany RK-Termin — Session Management ────────────────────────────────
// Gère les cookies (JSESSIONID + KEKS) et la navigation initiale.

import { RKTERMIN_BASE_URL, RKTERMIN_ENDPOINTS, RKTERMIN_HEADERS, RKTERMIN_TIMING, RKTERMIN_USER_AGENTS } from "./config.js";
import type { RKTerminSession, RKTerminConfig } from "./types.js";
import { ProxyAgent } from "undici";

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

/**
 * Crée un ProxyAgent pour Germany.
 *
 * Ordre de priorité :
 *  1. GERMANY_PROXY_URL  — URL proxy dédiée Germany (résidentiel recommandé)
 *  2. SOAX_PROXY_URL     — Fallback SOAX résidentiel (sticky session, sans pays fixé)
 *  3. undefined          — Direct (OK en local/Replit, bloqué sur Railway/cloud)
 *
 * DECODO_PROXY_URL est réservé à l'Espagne : ses IPs ISP sont aussi bloquées par diplo.de.
 */
function getProxyDispatcher(): { dispatcher: ProxyAgent; label: string } | undefined {
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

  return undefined;
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

/** Exécute une requête GET avec gestion de session */
export async function rkGet(
  session: RKTerminSession,
  endpoint: string,
  params?: Record<string, string | number>,
): Promise<{ html: string; status: number; newSession?: Partial<RKTerminSession> }> {
  const url = buildUrl(endpoint, params);
  
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
      },
      redirect: "follow",
      signal: controller.signal,
      // @ts-ignore — undici dispatcher not in lib.dom types
      dispatcher: proxy?.dispatcher,
    });
    
    clearTimeout(timeout);
    const html = await res.text();
    const cookies = parseCookies(res.headers);
    
    // Mettre à jour la session si nouveaux cookies
    const newSession: Partial<RKTerminSession> = {};
    if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
    if (cookies.keks) newSession.keks = cookies.keks;
    
    return { html, status: res.status, newSession: Object.keys(newSession).length ? newSession : undefined };
  } catch (err) {
    clearTimeout(timeout);
    const cause = (err as any)?.cause;
    throw new Error(`rkGet ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}${cause ? ` (cause: ${cause})` : ""}`);
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
        "Referer": url,
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
    const cookies = parseCookies(res.headers);
    
    const newSession: Partial<RKTerminSession> = {};
    if (cookies.jsessionId) newSession.jsessionId = cookies.jsessionId;
    if (cookies.keks) newSession.keks = cookies.keks;
    
    return { html, status: res.status, newSession: Object.keys(newSession).length ? newSession : undefined };
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
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RKTERMIN_TIMING.requestTimeoutMs);
  const proxy = getProxyDispatcher();
  if (proxy) {
    log("DEBUG", `Via proxy: ${proxy.label}`);
  } else {
    log("DEBUG", "Direct (pas de proxy configuré — risque de blocage IP Railway/cloud)");
  }
  
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
    // Exposer la cause sous-jacente (ECONNREFUSED, ECONNRESET, etc.) pour diagnostiquer
    // les blocages IP (service2.diplo.de bloque les plages IP datacenter Railway/cloud).
    const cause = (err as any)?.cause;
    const causeStr = cause ? ` (cause: ${cause})` : "";
    const hint = !proxy
      ? " — configurer GERMANY_PROXY_URL ou SOAX_PROXY_URL pour contourner le blocage IP"
      : "";
    throw new Error(`initSession failed: ${err instanceof Error ? err.message : String(err)}${causeStr}${hint}`);
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
