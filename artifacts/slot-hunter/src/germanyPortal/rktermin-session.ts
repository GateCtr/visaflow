// ─── Germany RK-Termin — Session Management ────────────────────────────────
// Gère les cookies (JSESSIONID + KEKS) et la navigation initiale.

import { RKTERMIN_BASE_URL, RKTERMIN_ENDPOINTS, RKTERMIN_HEADERS, RKTERMIN_TIMING, RKTERMIN_USER_AGENTS } from "./config.js";
import type { RKTerminSession, RKTerminConfig } from "./types.js";

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
    throw new Error(`rkGet ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
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
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...RKTERMIN_HEADERS,
        "User-Agent": randomUA(),
        "Cookie": buildCookieHeader(session),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "follow",
      signal: controller.signal,
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
    throw new Error(`rkPost ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`);
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
  
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        ...RKTERMIN_HEADERS,
        "User-Agent": randomUA(),
      },
      redirect: "follow",
      signal: controller.signal,
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
    throw new Error(`initSession failed: ${err instanceof Error ? err.message : String(err)}`);
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
