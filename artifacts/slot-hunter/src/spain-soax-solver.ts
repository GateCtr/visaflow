/**
 * spain-soax-solver.ts — Session Cloudflare citaconsular.es via proxy + CapSolver
 *
 * ARCHITECTURE :
 *   1. Génère ou utilise l'URL proxy configurée (~2h = durée cf_clearance)
 *   2. Appelle CapSolver AntiCloudflareTask avec ce proxy
 *   3. Retourne le cookie cf_clearance + l'URL proxy (même IP)
 *   4. impit (Chrome TLS fingerprint) utilise la même IP proxy + cookie → accès aux APIs Bookitit
 *
 * POURQUOI ça marche :
 *   - cf_clearance est lié à l'IP + fingerprint TLS
 *   - impit simule Chrome JA3/JA4 → même fingerprint que CapSolver (profil Chrome)
 *   - Même IP proxy → le cookie est accepté
 *   - Résultat : scan HTTP pur toutes les 30-60s sans Playwright
 *
 * COÛT : ~$0.005 par solve CapSolver (vs $0.02+ pour Turnstile)
 * DURÉE : cf_clearance valide ~2h → 1 solve pour ~120 scans
 */

import { Impit } from "impit";
import {
  syncSpainCfSessionToRedis,
  restoreSpainCfSessionFromRedis,
  removeSpainCfSessionFromRedis,
  syncSoaxRotationToRedis,
  restoreSoaxRotationFromRedis,
  type SerializableSpainCfSession,
} from "./spain-redis-persistence.js";
import { cookieManager } from "./cookie-manager.js";
import { solveWithLocalPlaywright, solveSpainWidgetSession } from "./local-playwright-solver.js";
import { applyStableGaProfile } from "./spain-redis-persistence.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const CAPSOLVER_BASE = "https://api.capsolver.com";

/**
 * Retourne l'URL proxy active pour l'Espagne.
 * Priorité : DECODO_PROXY_URL (ISP fixe, utilisé tel quel) → SOAX_PROXY_URL (sticky session builder).
 * Decodo ISP utilise une IP fixe — pas besoin de session ID / rotation côté URL.
 */
function getSpainProxyUrl(identifier = "spain-cf", lifetime = SOAX_SPAIN_SESSION_LIFETIME_MIN): string | undefined {
  const decodo = process.env.DECODO_PROXY_URL;
  if (decodo) return decodo;
  const soax = process.env.SOAX_PROXY_URL;
  if (soax) return makeSpainSoaxStickyUrl(soax, lifetime, identifier);
  return undefined;
}

/**
 * En mode HTTP, une session sans proxy est inutilisable : le cookie CF est
 * lié à l'IP qui a servi à le résoudre. Ne jamais transformer une variable
 * d'environnement absente en requête directe silencieuse.
 */
function httpModeRequiresProxy(): boolean {
  return process.env.SPAIN_HTTP_MODE === "1";
}

function hasCompatibleProxy(sessionProxyUrl: string, configuredProxyUrl: string | undefined): boolean {
  if (!sessionProxyUrl) return false;

  // Decodo ISP est utilisé tel quel et son IP doit rester celle du solve.
  // Une session Redis créée avec SOAX (ou sans proxy) ne peut donc pas être
  // réutilisée après le passage à Decodo.
  if (process.env.DECODO_PROXY_URL) {
    return sessionProxyUrl === configuredProxyUrl;
  }

  // Pour SOAX, l'URL contient une session sticky persistée avec le cookie.
  return true;
}
const CAPSOLVER_POLL_MS = 5_000;
const CAPSOLVER_MAX_POLLS = 60; // 5min max (CF challenge peut être lent)

/** Durée de la sticky session SOAX (minutes). Doit couvrir la durée du cf_clearance. */
const SOAX_SPAIN_SESSION_LIFETIME_MIN = 130; // ~2h10 (marge sur les 2h du cookie)

/** TTL du cf_clearance cookie (ms). On re-solve 5min avant expiration. */
const CF_CLEARANCE_TTL_MS = 115 * 60_000; // 1h55 (marge de 5min sur les ~2h réelles)

/** URL cible pour le challenge Cloudflare */
const DEFAULT_SPAIN_TARGET_URL = "https://www.citaconsular.es/es/hosteds/widgetdef498.html";

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface SpainCfSession {
  /** Cookie cf_clearance value */
  cfClearance: string;
  /** Domain du cookie (e.g. ".citaconsular.es") */
  cfDomain: string;
  /** URL proxy à utiliser pour les requêtes impit */
  soaxProxyUrl: string;
  /** User-Agent retourné par CapSolver (à utiliser dans les requêtes) */
  userAgent: string;
  /** Timestamp de création */
  createdAt: number;
  /** Timestamp d'expiration estimée */
  expiresAt: number;
  /** Tous les cookies retournés par CapSolver */
  allCookies: Array<{ name: string; value: string }>;
  /** Headers supplémentaires recommandés */
  extraHeaders: Record<string, string>;
}

export interface SolveResult {
  success: boolean;
  session?: SpainCfSession;
  error?: string;
  durationMs: number;
}

// ─── SOAX Sticky URL Builder ────────────────────────────────────────────────

const _spainSoaxRotationCount = new Map<string, number>();

/**
 * Génère une URL SOAX sticky longue durée pour l'Espagne (fallback).
 * Format Dashboard v2 : params dans le USERNAME.
 *
 * @param baseUrl - URL base SOAX (http://package-XXXXX:PASSWORD@proxy.soax.com:5000)
 * @param lifetimeMinutes - Durée session sticky (défaut: 130min ≈ 2h10)
 * @param identifier - Identifiant unique (pour session ID déterministe)
 */
export function makeSpainSoaxStickyUrl(
  baseUrl: string,
  lifetimeMinutes: number = SOAX_SPAIN_SESSION_LIFETIME_MIN,
  identifier: string = "spain-cf",
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
    const _v10Key = identifier.toLowerCase();
    let _v10h = 0;
    for (const ch of (_v10Key + ":v10-rotation-offset")) _v10h = ((_v10h << 5) - _v10h + ch.charCodeAt(0)) & 0x7fffffff;
    const _v10OffsetSec = Math.abs(_v10h) % 3600;
    const _v10WindowIdx = Math.floor((Math.floor(now.getTime() / 1000) - _v10OffsetSec) / 43200);
    const rotationCount = _spainSoaxRotationCount.get(identifier) ?? 0;
    const seed = `w${_v10WindowIdx}:${_v10Key}:spain-soax:r${rotationCount}`;
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
    // Espagne (country=es) pour citaconsular.es — IP espagnole pour cohérence géo
    const country = process.env.SPAIN_SOAX_COUNTRY ?? "es";
    const city = process.env.SPAIN_SOAX_CITY ?? "";

    proxyUser += `-sessionid-${sessionId}`;
    proxyUser += `-sessionlength-${sessionLengthSec}`;
    proxyUser += `-country-${country}`;
    if (city) proxyUser += `-city-${city}`;
    if (bindttl) proxyUser += `-bindttl-${bindttl}`;
    if (opt) proxyUser += `-opt-${opt}`;

    parsed.username = encodeURIComponent(proxyUser);

    const masked = parsed.toString().replace(/:([^:@]+)@/, ":***@");
    console.log(`[spain-soax] 🔒 Sticky session: id=${sessionId} len=${lifetimeMinutes}min country=${country} rot#${rotationCount}`);
    console.log(`[spain-soax]    Proxy: ${masked.slice(0, 80)}…`);

    return parsed.toString();
  } catch (err) {
    console.error(`[spain-soax] ⚠️ Erreur parsing URL SOAX — fallback brut`);
    return baseUrl;
  }
}

/** Force rotation du proxy SOAX Espagne (nouvelle IP au prochain solve). */
export function rotateSpainSoaxSession(identifier: string = "spain-cf"): void {
  const current = _spainSoaxRotationCount.get(identifier) ?? 0;
  _spainSoaxRotationCount.set(identifier, current + 1);
  // Invalider le cache de session CF
  _activeCfSession = undefined;
  // Persist rotation state + remove dead session from Redis
  syncSoaxRotationToRedis(_spainSoaxRotationCount);
  removeSpainCfSessionFromRedis();
  console.log(`[spain-soax] 🔄 Rotation SOAX Espagne demandée (rot#${current + 1})`);
}

// ─── CapSolver AntiCloudflareTask ───────────────────────────────────────────

interface CapSolverCreateResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
}

interface CapSolverResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status: "processing" | "ready" | "failed";
  solution?: {
    token: string;
    type?: string;
    userAgent: string;
    /** CapSolver returns cookies as an object { name: value } (NOT an array) */
    cookies: Record<string, string>;
    headers?: Record<string, string>;
  };
}

/**
 * Convertit une URL proxy HTTP en format CapSolver.
 * CapSolver attend : "http://user:pass@host:port" ou "socks5://user:pass@host:port"
 */
function proxyUrlToCapsolverFormat(proxyUrl: string): string {
  // CapSolver accepte les formats standard HTTP proxy URLs
  // S'assurer que c'est bien au format http://user:pass@host:port
  try {
    const parsed = new URL(proxyUrl);
    const user = decodeURIComponent(parsed.username);
    const pass = decodeURIComponent(parsed.password);
    return `http://${user}:${pass}@${parsed.hostname}:${parsed.port || "5000"}`;
  } catch {
    return proxyUrl;
  }
}

/**
 * Résout le Cloudflare challenge de citaconsular.es via CapSolver + SOAX proxy.
 *
 * @param targetUrl - URL protégée par Cloudflare
 * @param capsolverApiKey - Clé API CapSolver
 * @param soaxProxyUrl - URL proxy SOAX sticky (déjà configurée avec session longue)
 */
export async function solveSpainCloudflare(
  targetUrl: string,
  capsolverApiKey: string,
  soaxProxyUrl: string,
): Promise<SolveResult> {
  const t0 = Date.now();
  console.log(`[spain-soax] 🚀 Début solve CF — ${targetUrl}`);

  // Vérifier le solde CapSolver
  try {
    const balRes = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: capsolverApiKey }),
      signal: AbortSignal.timeout(10_000),
    });
    const balData = (await balRes.json()) as { errorId: number; balance?: number };
    if (balData.errorId !== 0 || (balData.balance ?? 0) <= 0) {
      return { success: false, error: `CapSolver balance insuffisant: ${balData.balance ?? "erreur"}`, durationMs: Date.now() - t0 };
    }
    console.log(`[spain-soax] 💰 Balance CapSolver: $${balData.balance?.toFixed(3)}`);
  } catch (err) {
    return { success: false, error: `Balance check failed: ${err}`, durationMs: Date.now() - t0 };
  }

  // Préparer le proxy au format CapSolver
  const proxyForCapsolver = proxyUrlToCapsolverFormat(soaxProxyUrl);

  // Créer la tâche AntiCloudflareTask
  let taskId: string;
  try {
    console.log(`[spain-soax] 📤 createTask AntiCloudflareTask…`);
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverApiKey,
        task: {
          type: "AntiCloudflareTask",
          websiteURL: targetUrl,
          proxy: proxyForCapsolver,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const createData = (await createRes.json()) as CapSolverCreateResponse;
    if (createData.errorId !== 0 || !createData.taskId) {
      const errMsg = createData.errorDescription || createData.errorCode || `errorId=${createData.errorId}`;
      console.error(`[spain-soax] ❌ createTask failed: ${errMsg}`);
      return { success: false, error: `createTask: ${errMsg}`, durationMs: Date.now() - t0 };
    }

    taskId = createData.taskId;
    console.log(`[spain-soax] ✅ Task créée: ${taskId}`);
  } catch (err) {
    return { success: false, error: `createTask network error: ${err}`, durationMs: Date.now() - t0 };
  }

  // Poller le résultat
  for (let i = 0; i < CAPSOLVER_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, CAPSOLVER_POLL_MS));

    try {
      const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: capsolverApiKey, taskId }),
        signal: AbortSignal.timeout(15_000),
      });

      const resultData = (await resultRes.json()) as CapSolverResultResponse;

      if (resultData.errorId !== 0) {
        const errCode = resultData.errorCode || `errorId=${resultData.errorId}`;
        // Certaines erreurs sont fatales (pas de retry)
        if (errCode.includes("ERROR_CAPTCHA_UNSOLVABLE") || errCode.includes("ERROR_PROXY")) {
          console.error(`[spain-soax] ❌ Erreur fatale: ${errCode}`);
          return { success: false, error: errCode, durationMs: Date.now() - t0 };
        }
        console.warn(`[spain-soax] ⚠️ Poll #${i + 1} erreur non-fatale: ${errCode}`);
        continue;
      }

      if (resultData.status === "failed") {
        const errMsg = resultData.errorDescription || resultData.errorCode || "task failed";
        console.error(`[spain-soax] ❌ Task failed: ${errMsg}`);
        return { success: false, error: errMsg, durationMs: Date.now() - t0 };
      }

      if (resultData.status === "ready" && resultData.solution) {
        const solution = resultData.solution;

        // CapSolver returns cookies as object { name: value }, not array
        const cookiesObj = solution.cookies ?? {};
        const cfClearanceValue = cookiesObj["cf_clearance"] || solution.token || "";

        if (!cfClearanceValue) {
          console.error(`[spain-soax] ❌ Solution ready mais pas de cf_clearance ni token`);
          return { success: false, error: "No cf_clearance in solution", durationMs: Date.now() - t0 };
        }

        console.log(`[spain-soax] ✅ Résolu! (${Math.round((Date.now() - t0) / 1000)}s)`);
        console.log(`[spain-soax]    cf_clearance: ${cfClearanceValue.slice(0, 40)}…`);
        console.log(`[spain-soax]    UA: ${solution.userAgent?.slice(0, 60)}`);

        // Convert cookies object to array format for our session
        const allCookies: Array<{ name: string; value: string }> = [];
        for (const [name, value] of Object.entries(cookiesObj)) {
          allCookies.push({ name, value });
        }
        if (allCookies.length === 0 && cfClearanceValue) {
          allCookies.push({ name: "cf_clearance", value: cfClearanceValue });
        }

        const session: SpainCfSession = {
          cfClearance: cfClearanceValue,
          cfDomain: ".citaconsular.es",
          soaxProxyUrl,
          userAgent: solution.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          createdAt: Date.now(),
          expiresAt: Date.now() + CF_CLEARANCE_TTL_MS,
          allCookies,
          extraHeaders: solution.headers || {},
        };

        return { success: true, session, durationMs: Date.now() - t0 };
      }

      // Still processing
      if (i % 4 === 0) {
        console.log(`[spain-soax] ⏳ Poll #${i + 1}/${CAPSOLVER_MAX_POLLS} — processing (${Math.round((Date.now() - t0) / 1000)}s)`);
      }
    } catch (err) {
      console.warn(`[spain-soax] ⚠️ Poll #${i + 1} network error: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.error(`[spain-soax] ❌ Timeout après ${CAPSOLVER_MAX_POLLS} polls (${Math.round((Date.now() - t0) / 1000)}s)`);
  return { success: false, error: "Polling timeout", durationMs: Date.now() - t0 };
}

// ─── Session Manager (singleton) ────────────────────────────────────────────

let _activeCfSession: SpainCfSession | undefined;

/** Retourne la session CF active (ou undefined si expirée/inexistante). */
export function getActiveSpainCfSession(): SpainCfSession | undefined {
  if (!_activeCfSession) return undefined;
  if (Date.now() >= _activeCfSession.expiresAt) {
    console.log(`[spain-soax] ⏰ Session CF expirée (créée il y a ${Math.round((Date.now() - _activeCfSession.createdAt) / 60_000)}min)`);
    _activeCfSession = undefined;
    return undefined;
  }
  return _activeCfSession;
}

/** Vérifie si la session est sur le point d'expirer (< 10min restantes). */
export function isSpainCfSessionExpiringSoon(): boolean {
  if (!_activeCfSession) return true;
  return (Date.now() + 10 * 60_000) >= _activeCfSession.expiresAt;
}

/** Invalide manuellement la session (après un 403 par ex.). */
export function invalidateSpainCfSession(): void {
  if (_activeCfSession) {
    console.log(`[spain-soax] 🗑️ Session CF invalidée manuellement`);
    _activeCfSession = undefined;
    removeSpainCfSessionFromRedis();
  }
}

/**
 * Obtient ou renouvelle la session CF pour l'Espagne.
 * - Si une session valide existe en mémoire → la retourne
 * - Si pas en mémoire → tente restauration depuis Redis
 * - Si Redis vide/expiré → solve via CapSolver + SOAX
 * - Retry automatique (max 2 tentatives avec rotation IP)
 */
export async function ensureSpainCfSession(
  targetUrl: string = DEFAULT_SPAIN_TARGET_URL,
): Promise<SpainCfSession | null> {
  const configuredProxyUrl = getSpainProxyUrl();
  if (httpModeRequiresProxy() && !configuredProxyUrl) {
    console.error(
      "[spain-soax] ❌ SPAIN_HTTP_MODE=1 exige DECODO_PROXY_URL (ou SOAX_PROXY_URL). " +
      "Requête directe refusée.",
    );
    return null;
  }

  // Session active et valide en mémoire ?
  const existing = getActiveSpainCfSession();
  if (existing && (!httpModeRequiresProxy() || hasCompatibleProxy(existing.soaxProxyUrl, configuredProxyUrl))) {
    const remainMin = Math.round((_activeCfSession!.expiresAt - Date.now()) / 60_000);
    console.log(`[spain-soax] ♻️ Session CF réutilisée (reste ${remainMin}min)`);
    return existing;
  }
  if (existing && httpModeRequiresProxy()) {
    console.warn("[spain-soax] ⚠️ Session mémoire ignorée: proxy absent ou incompatible avec le proxy configuré");
    _activeCfSession = undefined;
  }

  // 1. Les cookies du pool local n'embarquent pas l'IP qui les a générés.
  // En HTTP-only, les réutiliser avec Decodo peut produire un couple
  // cf_clearance/IP incohérent (notamment après un ancien solve SOAX).
  // Ils restent utilisables uniquement par le mode Playwright legacy.
  const domain = new URL(targetUrl).hostname;
  const bestCookie = httpModeRequiresProxy()
    ? null
    : cookieManager.getBestCookie(domain);
  if (httpModeRequiresProxy() && cookieManager.getBestCookie(domain)) {
    console.log("[spain-soax] ℹ️ Cookie pool ignoré en HTTP-only: IP d'origine inconnue");
  }
  if (bestCookie) {
    const remainMin = Math.round((bestCookie.expires * 1000 - Date.now()) / 60_000);
    console.log(`[spain-soax] ♻️ Cookie valide trouvé dans le pool (source: ${bestCookie.source}, reste ${remainMin}min)`);
    
    // Même avec USE_LOCAL_STEALTH=true, le cookie doit rester lié au proxy
    // configuré lorsque le watcher tourne en HTTP-only.
    const isLocalStealth = process.env.USE_LOCAL_STEALTH === "true";
    const soaxProxyUrl = (httpModeRequiresProxy() || !isLocalStealth ? configuredProxyUrl : undefined) ?? "";
    if (httpModeRequiresProxy() && !soaxProxyUrl) {
      console.error("[spain-soax] ❌ Cookie pool trouvé mais aucun proxy disponible — requête directe refusée");
      return null;
    }

    const sessionCreatedAt = Date.now() - (7200 - (bestCookie.expires - Math.floor(Date.now() / 1000))) * 1000;
    const poolAllCookies = await applyStableGaProfile(
      [{ name: bestCookie.name, value: bestCookie.value }],
      sessionCreatedAt,
    );
    const session: SpainCfSession = {
      cfClearance: bestCookie.value,
      cfDomain: bestCookie.domain,
      soaxProxyUrl,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      createdAt: sessionCreatedAt,
      expiresAt: bestCookie.expires * 1000,
      allCookies: poolAllCookies,
      extraHeaders: {}
    };
    _activeCfSession = session;
    return session;
  }

  // 2. Tenter de résoudre via Local Playwright Stealth (si activé dans l'environnement)
  if (process.env.USE_LOCAL_STEALTH === "true") {
    console.log("[spain-soax] 🔍 Mode local stealth activé — solveSpainWidgetSession (JSD Oneshot natif)…");

    // Proxy actif (Decodo ou SOAX sticky) — DOIT être la même IP que les appels impit
    const soaxProxyForPlaywright = getSpainProxyUrl();

    const widgetCookies = await solveSpainWidgetSession(targetUrl, soaxProxyForPlaywright);
    if (widgetCookies) {
      const pwCreatedAt = Date.now();
      const pwAllCookies = await applyStableGaProfile(widgetCookies.allCookies, pwCreatedAt);
      const session: SpainCfSession = {
        cfClearance: widgetCookies.cfClearance,
        cfDomain: ".citaconsular.es",
        soaxProxyUrl: soaxProxyForPlaywright ?? "",
        userAgent: widgetCookies.userAgent,
        createdAt: pwCreatedAt,
        expiresAt: pwCreatedAt + CF_CLEARANCE_TTL_MS,
        allCookies: pwAllCookies,
        extraHeaders: {},
      };
      _activeCfSession = session;
      syncSpainCfSessionToRedis(session as SerializableSpainCfSession);
      console.log(
        `[spain-soax] 🎉 Session Playwright établie ! ` +
        `PHPSESSID=${session.allCookies.find(c => c.name === "PHPSESSID") ? "✅" : "❌"} | ` +
        `Valide ~${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`
      );
      return session;
    }

    console.warn("[spain-soax] ⚠️ solveSpainWidgetSession échoué — fallback CapSolver…");
    // Fallback : ancien solver simple (obtient cf_clearance #1 seulement, sans JSD Oneshot)
    const localSolved = await solveWithLocalPlaywright(targetUrl);
    if (localSolved) {
      return ensureSpainCfSession(targetUrl);
    }
    console.warn("[spain-soax] ⚠️ Échec fallback local stealth aussi. Tentative CapSolver cloud…");
  }

  // Tenter restauration depuis Redis (survit aux redéploiements)
  try {
    const cached = await restoreSpainCfSessionFromRedis();
    if (cached) {
      if (httpModeRequiresProxy() && !hasCompatibleProxy(cached.soaxProxyUrl, configuredProxyUrl)) {
        console.warn(
          "[spain-soax] ⚠️ Session Redis ignorée: elle a été créée sans proxy " +
          "ou avec un proxy différent du proxy configuré",
        );
        removeSpainCfSessionFromRedis();
      } else {
        // Reconstruire la session en mémoire
        const restoredAllCookies = await applyStableGaProfile(cached.allCookies, cached.createdAt);
        const restored: SpainCfSession = {
          cfClearance: cached.cfClearance,
          cfDomain: cached.cfDomain,
          soaxProxyUrl: cached.soaxProxyUrl,
          userAgent: cached.userAgent,
          createdAt: cached.createdAt,
          expiresAt: cached.expiresAt,
          allCookies: restoredAllCookies,
          extraHeaders: cached.extraHeaders,
        };
        _activeCfSession = restored;
        const remainMin = Math.round((restored.expiresAt - Date.now()) / 60_000);
        console.log(`[spain-soax] ♻️ Session CF restaurée depuis Redis (reste ${remainMin}min)`);
        return restored;
      }
    }
  } catch (err) {
    console.warn(`[spain-soax] ⚠️ Redis restore échoué (non-fatal): ${err}`);
  }

  // Vérifier les prérequis proxy
  const soaxProxyUrl = configuredProxyUrl;
  if (!soaxProxyUrl) {
    console.error(`[spain-soax] ❌ Aucun proxy configuré (DECODO_PROXY_URL ou SOAX_PROXY_URL requis)`);
    return null;
  }

  // ── Mode Decodo Direct ──────────────────────────────────────────────────────
  // Si DECODO_PROXY_URL est défini, tenter un accès direct : l'IP ISP Decodo
  // peut bypasser Cloudflare sans solve. Si la page répond 200 sans challenge,
  // on crée la session directement avec le PHPSESSID obtenu (coût CapSolver = 0).
  if (process.env.DECODO_PROXY_URL) {
    console.log(`[spain-soax] 🚀 Decodo ISP — tentative accès direct (bypass CF possible)…`);
    try {
      const directImpit = new Impit({
        browser: "chrome",
        proxyUrl: soaxProxyUrl,
        ignoreTlsErrors: true,
      } as any);

      const directRes = await directImpit.fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "es-ES,es;q=0.9,en;q=0.7",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="136", "Google Chrome";v="136"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
      } as any) as unknown as Response;

      const directBody = await (directRes as any).text();
      const isCfChallenge = /just a moment|jetzt einen moment|verifying|_cf_chl_opt/i.test(
        (directBody as string).slice(0, 3000),
      );

      if ((directRes as any).status === 200 && !isCfChallenge) {
        // Extraire le PHPSESSID depuis Set-Cookie
        const setCookie = (directRes as any).headers?.get?.("set-cookie") ?? "";
        const phpSessionMatch = setCookie.match(/PHPSESSID=([^;]+)/);
        const phpSessionId = phpSessionMatch?.[1] ?? "";

        const directUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
        const directCreatedAt = Date.now();
        // PHPSESSID courte durée — renouveler toutes les 30min pour être safe
        const directExpiresAt = directCreatedAt + 30 * 60_000;

        const directAllCookies: Array<{ name: string; value: string }> = [];
        if (phpSessionId) directAllCookies.push({ name: "PHPSESSID", value: phpSessionId });

        const directSession: SpainCfSession = {
          cfClearance: "",          // Pas de CF challenge → pas de cookie cf_clearance
          cfDomain: ".citaconsular.es",
          soaxProxyUrl,
          userAgent: directUA,
          createdAt: directCreatedAt,
          expiresAt: directExpiresAt,
          allCookies: directAllCookies,
          extraHeaders: {},
        };

        _activeCfSession = directSession;
        syncSpainCfSessionToRedis(directSession as SerializableSpainCfSession);
        console.log(
          `[spain-soax] 🎉 Session Decodo Direct établie (bypass CF) — PHPSESSID=${phpSessionId ? "✅" : "❌ absent"} | Valide 30min`,
        );
        return directSession;
      }

      if (isCfChallenge) {
        console.warn(`[spain-soax] ⚠️ Decodo direct: CF challenge détecté → fallback CapSolver`);
      } else {
        console.warn(`[spain-soax] ⚠️ Decodo direct: status ${(directRes as any).status} → fallback CapSolver`);
      }
    } catch (directErr) {
      console.warn(`[spain-soax] ⚠️ Decodo direct échoué (${directErr}) → fallback CapSolver`);
    }
  }

  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverKey) {
    console.error(`[spain-soax] ❌ CAPSOLVER_API_KEY non configurée`);
    return null;
  }

  const proxyLabel = process.env.DECODO_PROXY_URL ? "Decodo ISP" : "SOAX sticky";

  // Tenter le solve CapSolver (max 2 essais avec rotation)
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[spain-soax] 🎯 Tentative ${attempt}/${MAX_ATTEMPTS}…`);

    const result = await solveSpainCloudflare(targetUrl, capsolverKey, soaxProxyUrl);

    if (result.success && result.session) {
      result.session.allCookies = await applyStableGaProfile(
        result.session.allCookies,
        result.session.createdAt,
      );
      _activeCfSession = result.session;
      console.log(`[spain-soax] 🎉 Session CF établie via ${proxyLabel}! Durée solve: ${Math.round(result.durationMs / 1000)}s`);
      console.log(`[spain-soax]    Valide jusqu'à: ${new Date(result.session.expiresAt).toISOString()}`);

      // Persister dans Redis pour survivre aux redéploiements (inclut le GA stable)
      syncSpainCfSessionToRedis(result.session as SerializableSpainCfSession);

      return result.session;
    }

    console.warn(`[spain-soax] ⚠️ Tentative ${attempt} échouée: ${result.error}`);

    // Rotation IP avant retry
    if (attempt < MAX_ATTEMPTS) {
      rotateSpainSoaxSession("spain-cf");
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }

  console.error(`[spain-soax] ❌ Impossible d'obtenir le cookie CF après ${MAX_ATTEMPTS} tentatives`);
  return null;
}

// ─── Impit Instance (Chrome fingerprint + SOAX proxy) ───────────────────────

/**
 * Restaure l'état SOAX rotation depuis Redis (appelé au démarrage).
 * Permet de reprendre avec le bon rotation count après un redéploiement.
 */
export async function restoreSpainSoaxStateFromRedis(): Promise<void> {
  try {
    const rotationMap = await restoreSoaxRotationFromRedis();
    if (rotationMap && rotationMap.size > 0) {
      for (const [key, value] of rotationMap) {
        _spainSoaxRotationCount.set(key, value);
      }
      console.log(`[spain-soax] ✅ Rotation state restauré depuis Redis (${rotationMap.size} identifiers)`);
    }
  } catch (err) {
    console.warn(`[spain-soax] ⚠️ Restauration rotation échouée (non-fatal): ${err}`);
  }
}

let _spainImpit: InstanceType<typeof Impit> | undefined;
let _spainImpitProxyUrl: string | undefined;

/**
 * Retourne une instance impit configurée avec le proxy de la session CF active.
 * Le fingerprint TLS Chrome garantit la cohérence avec le solve CapSolver.
 */
export function getSpainImpit(session: SpainCfSession): InstanceType<typeof Impit> {
  if (httpModeRequiresProxy() && !session.soaxProxyUrl) {
    throw new Error(
      "SPAIN_HTTP_MODE=1 refuse toute requête directe: session CF sans proxy",
    );
  }

  if (_spainImpit && _spainImpitProxyUrl === session.soaxProxyUrl) {
    return _spainImpit;
  }

  _spainImpit = new Impit({
    browser: "chrome",
    ignoreTlsErrors: true,
    proxyUrl: session.soaxProxyUrl || undefined,
  } as any);
  _spainImpitProxyUrl = session.soaxProxyUrl;

  if (session.soaxProxyUrl) {
    const masked = session.soaxProxyUrl.replace(/:([^:@]+)@/, ":***@");
    const provider = process.env.DECODO_PROXY_URL ? "Decodo" : "proxy configuré";
    console.log(`[spain-soax] ✅ impit Espagne initialisé (Chrome TLS + ${provider}: ${masked.slice(0, 60)}…)`);
  } else {
    console.log(`[spain-soax] ✅ impit Espagne initialisé (Chrome TLS direct / sans proxy)`);
  }
  return _spainImpit;
}

/**
 * Effectue un fetch HTTP via impit avec la session CF active.
 * Injecte automatiquement : cf_clearance cookie, User-Agent, headers Chrome.
 *
 * @returns Response object ou null si session expirée/erreur
 */
export async function spainCfFetch(
  url: string,
  session: SpainCfSession,
  fetchOptions?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<Response | null> {
  const impit = getSpainImpit(session);

  const cookieParts = [`cf_clearance=${session.cfClearance}`];
  for (const c of session.allCookies) {
    if (c.name !== "cf_clearance") {
      cookieParts.push(`${c.name}=${c.value}`);
    }
  }

  // Extract Chrome major version from UA
  const chromeMajor = session.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "136";

  // Base headers, can be overridden by session.extraHeaders and fetchOptions.headers
  const baseHeaders: Record<string, string> = {
    "User-Agent": session.userAgent,
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cookie": cookieParts.join("; "),
    // Sec-Ch-Ua: ordre réel Chrome = "Not/A)Brand" first, then Chromium, then Google Chrome
    // La chaîne "Not(A;Brand" change de format à chaque version — Chrome 136 utilise "Not/A)Brand"
    "Sec-Ch-Ua": `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    // High-entropy hints requis par Cloudflare via Accept-CH sur citaconsular.es
    // Chrome envoie les headers mais avec valeurs vides (privacy budget)
    "Sec-Ch-Ua-Platform-Version": "",
    "Sec-Ch-Ua-Full-Version": "",
    "Sec-Ch-Ua-Full-Version-List": "",
    "Sec-Ch-Ua-Arch": "",
    "Sec-Ch-Ua-Bitness": "",
    "Sec-Ch-Ua-Model": "",
  };

  const finalHeaders = {
    ...baseHeaders,
    ...session.extraHeaders,
    ...fetchOptions?.headers,
  };

  try {
    const res = await impit.fetch(url, { ...fetchOptions, headers: finalHeaders } as any) as unknown as Response;
    return res;
  } catch (err) {
    console.error(`[spain-soax] ❌ Fetch error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Vérifie que la session CF est toujours valide en faisant un test fetch.
 * Retourne true si le proxy + cookie fonctionnent, false sinon.
 */
export async function verifySpainCfSession(session: SpainCfSession): Promise<boolean> {
  try {
    const testUrl = "https://www.citaconsular.es/es/";
    const res = await spainCfFetch(testUrl, session);
    if (!res) return false;

    // Si on reçoit un 403 ou une page Cloudflare → session morte
    if (res.status === 403) {
      console.warn(`[spain-soax] ⚠️ Verify: 403 → session CF morte`);
      return false;
    }

    // Vérifier le contenu (pas un challenge CF)
    const body = await res.text();
    if (/un instant|just a moment|verifying/i.test(body.slice(0, 2000))) {
      console.warn(`[spain-soax] ⚠️ Verify: Challenge CF encore présent`);
      return false;
    }

    console.log(`[spain-soax] ✅ Verify OK (status ${res.status})`);
    return true;
  } catch (err) {
    console.error(`[spain-soax] ❌ Verify error: ${err}`);
    return false;
  }
}
