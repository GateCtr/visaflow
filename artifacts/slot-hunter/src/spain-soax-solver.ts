/**
 * spain-soax-solver.ts — Session Cloudflare citaconsular.es via proxy + Playwright
 *
 * ARCHITECTURE :
 *   1. Génère ou utilise l'URL proxy configurée (~2h = durée cf_clearance)
 *   2. Laisse Playwright charger le challenge interactif et exécuter le JSD
 *   3. Retourne les cookies capturés + l'URL proxy (même IP)
 *   4. impit réutilise la même session uniquement après JSD confirmé
 *
 * POURQUOI ça marche :
 *   - cf_clearance est lié à l'IP + fingerprint TLS
 *   - impit simule Chrome JA3/JA4 → même fingerprint que CapSolver (profil Chrome)
 *   - Même IP proxy → le cookie est accepté
 *   - Résultat : scan HTTP pur toutes les 30-60s sans Playwright
 *
 * DURÉE : cf_clearance valide ~2h → 1 solve pour ~120 scans
 */

import { Impit } from "impit";
import {
  syncSpainCfSessionToRedis,
  restoreSpainCfSessionFromRedis,
  removeSpainCfSessionFromRedis,
  syncSoaxRotationToRedis,
  restoreSoaxRotationFromRedis,
  syncResidentialPortStateToRedis,
  restoreResidentialPortStateFromRedis,
  type SerializableSpainCfSession,
} from "./spain-redis-persistence.js";
import { cookieManager } from "./cookie-manager.js";
import { solveSpainWidgetSession } from "./local-playwright-solver.js";
import { applyStableGaProfile } from "./spain-redis-persistence.js";
import { getCurrentDecodoUrl } from "./spain-decodo-pool.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const CAPSOLVER_BASE = "https://api.capsolver.com";

/**
 * Retourne l'URL proxy active pour l'Espagne.
 * Priorité : Oxylabs résidentiel (si SPAIN_USE_OXYLABS=1) → Decodo pool → SOAX_PROXY_URL.
 *
 * SPAIN_USE_OXYLABS=1 force Oxylabs résidentiel pour contourner un PoP CF bloqué
 * (ex: tous les nœuds Decodo sortent par SJC avec un nonce JSD expiré).
 * Oxylabs résidentiel route via des IPs espagnoles/européennes → PoP CF différent.
 */
function getSpainProxyUrl(identifier = "spain-cf", lifetime = SOAX_SPAIN_SESSION_LIFETIME_MIN): string | undefined {
  // Oxylabs résidentiel — prioritaire si SPAIN_USE_OXYLABS=1 (bypass PoP CF bloqué)
  if (process.env.SPAIN_USE_OXYLABS === "1") {
    const oxUser = process.env.OXYLABS_USERNAME;
    const oxPass = process.env.OXYLABS_PASSWORD;
    if (oxUser && oxPass) {
      const cc = process.env.SPAIN_SOAX_COUNTRY ?? "es";
      const url = `http://customer-${oxUser}-cc-${cc}:${oxPass}@pr.oxylabs.io:7777`;
      const masked = url.replace(/:([^:@]+)@/, ":***@");
      console.log(`[spain-soax] 🌐 Oxylabs résidentiel actif (cc=${cc}) → PoP CF non-SJC attendu`);
      console.log(`[spain-soax]    Proxy: ${masked.slice(0, 80)}…`);
      return url;
    }
    console.warn("[spain-soax] ⚠️ SPAIN_USE_OXYLABS=1 mais OXYLABS_USERNAME/PASSWORD absents — fallback Decodo");
  }
  const decodo = getCurrentDecodoUrl();
  if (decodo) return decodo;
  const soax = process.env.SOAX_PROXY_URL;
  if (soax) return makeSpainSoaxStickyUrl(soax, lifetime, identifier);
  // Oxylabs résidentiel comme dernier recours (sans flag forcé)
  const oxUser = process.env.OXYLABS_USERNAME;
  const oxPass = process.env.OXYLABS_PASSWORD;
  if (oxUser && oxPass) {
    const cc = process.env.SPAIN_SOAX_COUNTRY ?? "es";
    const url = `http://customer-${oxUser}-cc-${cc}:${oxPass}@pr.oxylabs.io:7777`;
    const masked = url.replace(/:([^:@]+)@/, ":***@");
    console.log(`[spain-soax] 🌐 Oxylabs résidentiel (dernier recours, cc=${cc})`);
    console.log(`[spain-soax]    Proxy: ${masked.slice(0, 80)}…`);
    return url;
  }
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

function browserSessionRequired(): boolean {
  // HTTP-only must use CapSolver by default. A browser session is an explicit
  // diagnostic/compatibility mode because it is not HTTP-only.
  return httpModeRequiresProxy() && process.env.SPAIN_HTTP_SESSION_MODE === "playwright";
}

function hasCompatibleProxy(sessionProxyUrl: string, configuredProxyUrl: string | undefined): boolean {
  // Une session CF ne peut être réutilisée qu'avec l'URL proxy exacte qui a
  // servi à l'établir. Cela évite d'associer un cookie à une autre IP après
  // un redéploiement ou un changement de fournisseur.
  return Boolean(sessionProxyUrl && configuredProxyUrl && sessionProxyUrl === configuredProxyUrl);
}
const CAPSOLVER_POLL_MS = 5_000;
const CAPSOLVER_MAX_POLLS = 60; // 5min max (CF challenge peut être lent)

/** Durée de la sticky session SOAX (minutes). Doit couvrir la durée du cf_clearance. */
const SOAX_SPAIN_SESSION_LIFETIME_MIN = 130; // ~2h10 (marge sur les 2h du cookie)

/** TTL du cf_clearance cookie (ms). On re-solve 5min avant expiration. */
const CF_CLEARANCE_TTL_MS = 115 * 60_000; // 1h55 (marge de 5min sur les ~2h réelles)

/** URL cible pour le challenge Cloudflare */
const DEFAULT_SPAIN_TARGET_URL = process.env.SPAIN_WIDGET_URL || "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

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
  /** How the session was established. Browser sessions contain real CF state. */
  source?: "playwright" | "capsolver" | "direct";
  /**
   * Contenu JSONP pré-fetchée de /onlinebookings/main/ via le browser Chromium.
   * Défini uniquement pour les sessions persistent-browser (source=playwright) quand
   * la navigation directe /main/ a réussi. Le scanner l'utilise directement (bypasse
   * l'appel impit) car CF bloque /main/ pour les user-agents non-browser (0B text/html).
   */
  prefetchedMainHtml?: string;
  /**
   * Timestamp de création de la session PHP Bookitit (PHPSESSID).
   * Distinct de createdAt (qui marque la création du cf_clearance CF).
   * Permet de détecter l'expiration du PHPSESSID (~20 min TTL) indépendamment
   * du cf_clearance (~115 min) et de déclencher refreshPhpSession() plutôt
   * que closeAndInvalidate() quand seul le PHPSESSID a expiré.
   * Remis à Date.now() par refreshPhpSession() à chaque refresh de PHPSESSID.
   */
  phpSessionCreatedAt?: number;
  /**
   * Publickey Bookitit du portail pour lequel cette session a été résolue.
   * Ex: "25028fcd7126544630b8da0c6e60722b5" (Kinshasa).
   * Permet de détecter une contamination inter-portail (ex: session Saopolo réutilisée
   * pour Kinshasa) et d'invalider prefetchedMainHtml + apiPrefetchCache stale.
   */
  portalKey?: string;
  /**
   * Instance impit dédiée à cette session isolée (booking multi-dossiers).
   * Quand présent, spainCfFetch utilise cette instance au lieu du singleton
   * global _spainImpit — permet plusieurs bookings parallèles sans conflit TLS.
   * Créé par createIsolatedBookingSession() pour chaque session de booking.
   */
  _ownImpit?: InstanceType<typeof import("impit").Impit>;
  /**
   * État Bookitit pour le mode HTTP-pur (capsolver-residential).
   * Établi lors de l'init de session (GET widget → POST token → GET /main/).
   * Partagé par le scanner et le booking pour garantir le même jqCallback
   * et reqCounter incrémental tout au long de la session.
   * ⚠️ reqCounter est mutable — ne pas sérialiser vers Redis.
   */
  bookititState?: {
    /** jQuery callback fixe pour toute la session : jQuery21109{ts}_{rand9} */
    jqCallback: string;
    /** Compteur de requêtes mutable — incrémenté par makeBookititUrl() */
    reqCounter: number;
    /** srvsrc extrait du corps POST token (origin citaconsular.es ou app.bookitit.com) */
    srvsrc: string;
    /** Version JS Bookitit extraite du corps POST token (ex: "4") */
    version: string;
    /** URL du widget (citaconsular.es) — utilisée comme src= et Referer */
    widgetUrl: string;
    /** Clé Bookitit publique (publickey=) */
    publickey: string;
    /** Base des appels JSONP Bookitit (ex: https://app.bookitit.com/onlinebookings/) */
    bookititBase: string;
  };
}

/**
 * Crée une copie de session pour un flux Bookitit isolé par dossier.
 *
 * Le cookie Cloudflare peut être partagé tant que le proxy reste identique,
 * mais PHPSESSID est une session applicative côté Bookitit et ne doit jamais
 * être partagé entre deux dossiers. La copie conserve donc la clearance et
 * tous les cookies de fingerprint, tout en repartant sans PHPSESSID.
 */
export function cloneSpainCfSessionForDossier(session: SpainCfSession): SpainCfSession {
  return {
    ...session,
    allCookies: session.allCookies
      .filter((cookie) => cookie.name !== "PHPSESSID")
      .map((cookie) => ({ ...cookie })),
    extraHeaders: { ...session.extraHeaders },
  };
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
 * @param targetUrl        - URL protégée par Cloudflare
 * @param capsolverApiKey  - Clé API CapSolver
 * @param soaxProxyUrl     - URL proxy SOAX sticky (déjà configurée avec session longue)
 * @param challengeHtml    - HTML du challenge CF pré-fetché par impit (optionnel).
 *   Quand fourni, CapSolver résout le challenge dans le contexte de la session TLS
 *   impit (pas de son propre Chrome) → le cf_clearance résultant est valide pour
 *   les requêtes impit suivantes sur le même proxy IP.
 *   Si absent, CapSolver ouvre son propre Chrome → cf_clearance lié à sa TLS Chrome
 *   → incompatible avec impit sur le portail citaconsular.es.
 */
export async function solveSpainCloudflare(
  targetUrl: string,
  capsolverApiKey: string,
  soaxProxyUrl: string,
  challengeHtml?: string,
  /** User-Agent à inclure dans la tâche CapSolver quand html est fourni (obligatoire). */
  userAgent?: string,
): Promise<SolveResult> {
  const t0 = Date.now();
  console.log(`[spain-soax] 🚀 Début solve CF — ${targetUrl}`);

  // Vérifier le solde CapSolver — retry 2× sur erreurs transientes (rate-limit, hiccup API)
  const apiKey = capsolverApiKey.trim();
  let balOk = false;
  for (let balAttempt = 0; balAttempt < 3; balAttempt++) {
    if (balAttempt > 0) await new Promise((r) => setTimeout(r, 2_000 * balAttempt));
    try {
      const balRes = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const balData = (await balRes.json()) as { errorId: number; errorCode?: string; errorDescription?: string; balance?: number };
      if (balData.errorId !== 0) {
        console.warn(`[spain-soax] ⚠️ CapSolver getBalance errorId=${balData.errorId} code=${balData.errorCode ?? "?"} desc="${balData.errorDescription ?? ""}" (tentative ${balAttempt + 1}/3)`);
        if (balAttempt === 2) return { success: false, error: `CapSolver getBalance error: ${balData.errorCode ?? balData.errorId}`, durationMs: Date.now() - t0 };
        continue;
      }
      if ((balData.balance ?? 0) <= 0) {
        return { success: false, error: `CapSolver balance insuffisant: $${balData.balance ?? 0}`, durationMs: Date.now() - t0 };
      }
      console.log(`[spain-soax] 💰 Balance CapSolver: $${balData.balance?.toFixed(3)}`);
      balOk = true;
      break;
    } catch (err) {
      console.warn(`[spain-soax] ⚠️ CapSolver getBalance fetch error (tentative ${balAttempt + 1}/3): ${err}`);
      if (balAttempt === 2) return { success: false, error: `Balance check failed: ${err}`, durationMs: Date.now() - t0 };
    }
  }
  if (!balOk) return { success: false, error: "Balance check: toutes les tentatives échouées", durationMs: Date.now() - t0 };

  // Préparer le proxy au format CapSolver
  const proxyForCapsolver = proxyUrlToCapsolverFormat(soaxProxyUrl);

  // Créer la tâche AntiCloudflareTask
  let taskId: string;
  try {
    // Quand challengeHtml est fourni (HTML du challenge CF capturé par le probe impit),
    // CapSolver résout en utilisant ce HTML comme contexte de challenge au lieu de
    // fetcher la page lui-même. Le cf_clearance résultant est alors lié à la session
    // TLS du probe impit (même proxy IP + contexte), et non au Chrome interne de CapSolver.
    // → impit peut réutiliser ce cf_clearance pour accéder au portail (200, PHPSESSID).
    //
    // Sans html : CapSolver utilise son propre Chrome → cf_clearance lié à sa TLS Chrome
    // → impit reçoit 403 sur le portail (TLS fingerprint différent).
    //
    // Tronquer à 32KB : certaines implémentations rejettent les payloads trop longs.
    const capsolverTask: Record<string, string> = {
      type: "AntiCloudflareTask",
      websiteURL: targetUrl,
      proxy: proxyForCapsolver,
    };
    if (challengeHtml) {
      // CapSolver exige userAgent quand html est fourni (sinon → ERROR_INVALID_TASK_DATA)
      const ua = userAgent ??
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
      capsolverTask["html"] = challengeHtml.slice(0, 32_000);
      capsolverTask["userAgent"] = ua;
      console.log(`[spain-soax] 📤 createTask AntiCloudflareTask WITH html (${capsolverTask["html"].length} chars) + userAgent — cf_clearance lié à la TLS impit`);
    } else {
      console.log(`[spain-soax] 📤 createTask AntiCloudflareTask sans html — cf_clearance lié au Chrome CapSolver`);
    }

    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverApiKey,
        task: capsolverTask,
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
        // These errors describe an invalid task/request, not a task that is
        // still processing. Retrying the same task only burns polling time and
        // can hide the actual integration/configuration problem.
        if (
          errCode.includes("ERROR_INVALID_TASK_DATA") ||
          errCode.includes("ERROR_CAPTCHA_UNSOLVABLE") ||
          errCode.includes("ERROR_PROXY") ||
          errCode.includes("ERROR_TASK_NOT_FOUND")
        ) {
          // ERROR_TASK_NOT_FOUND = tâche expirée côté CapSolver (~2 min TTL) — inutile de continuer
          console.error(`[spain-soax] ❌ Erreur fatale: ${errCode}`);
          const details = resultData.errorDescription
            ? `${errCode}: ${resultData.errorDescription}`
            : errCode;
          return { success: false, error: details, durationMs: Date.now() - t0 };
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
        // Log full solution for diagnostics (captures any __cf_chl_tk / url / redirectUrl fields)
        const solutionKeys = Object.keys(solution as object);
        console.log(`[spain-soax]    solution keys: ${solutionKeys.join(", ")}`);
        const solutionFull = JSON.stringify(solution, (k, v) => {
          // Truncate long string values except cf_clearance keys
          if (typeof v === "string" && v.length > 120 && k !== "userAgent") return v.slice(0, 120) + "…";
          return v;
        });
        console.log(`[spain-soax]    solution full: ${solutionFull}`);

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
          userAgent: solution.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
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

/**
 * Index courant dans le pool résidentiel (gate.decodo.com:10001-10100, 100 ports).
 * Avancé d'un cran UNIQUEMENT quand /main/ retourne 0B ou erreur tunnel — jamais proactivement.
 * Persistant pour la durée de vie du process (Railway/Replit).
 */
let _residentialPortIndex = 0;

/**
 * Ports résidentiels ayant retourné /main/ = 0B ou une erreur tunnel,
 * mémorisés pour éviter de les réutiliser immédiatement.
 * Format : port → timestamp du flagging (ms). TTL = 30 min.
 */
const _badResidentialPorts = new Map<number, number>();

/** TTL de la mémoire des ports mauvais. Après ce délai le port est réhabilité. */
const BAD_PORT_TTL_MS = 30 * 60_000; // 30 min

/** Marque un port comme mauvais et persiste dans Redis.
 * @param reason motif lisible (ex: "main/ 0B", "token absent HTTP 403", "POST token échoué", …)
 */
function flagResidentialPort(port: number, reason = "main/ 0B"): void {
  _badResidentialPorts.set(port, Date.now());
  // Compter combien de ports sont actuellement exclus (TTL non expiré)
  let activeFlags = 0;
  for (const [p, t] of _badResidentialPorts) {
    if (Date.now() - t <= BAD_PORT_TTL_MS) activeFlags++;
    else _badResidentialPorts.delete(p);
  }
  console.log(`[spain-soax] 🚩 Port ${port} flaggé (${reason}) — ${activeFlags}/100 port(s) exclus pendant ${BAD_PORT_TTL_MS / 60_000}min`);
  // Persistance Redis — survit aux redémarrages
  syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
}

/** Retourne true si le port est actuellement flaggé (TTL non expiré). */
function isPortBad(port: number): boolean {
  const t = _badResidentialPorts.get(port);
  if (!t) return false;
  if (Date.now() - t > BAD_PORT_TTL_MS) {
    _badResidentialPorts.delete(port); // réhabilitation automatique
    return false;
  }
  return true;
}

/**
 * Avance _residentialPortIndex jusqu'au premier port non-flaggé.
 * Si tous les 100 ports sont flaggés (cas extrême), purge les flags et retourne au courant.
 */
function advanceToCleanPort(): void {
  const before = _residentialPortIndex;
  for (let i = 0; i < 100; i++) {
    const port = (_residentialPortIndex % 100) + 10001;
    if (!isPortBad(port)) break; // port propre trouvé
    _residentialPortIndex++;
  }
  if (_residentialPortIndex !== before) {
    // Cas extrême : tous les ports sont flaggés — purge totale
    const port = (_residentialPortIndex % 100) + 10001;
    if (isPortBad(port)) {
      console.warn(`[spain-soax] ⚠️ Tous les 100 ports résidentiels flaggés — purge des flags et reprise`);
      _badResidentialPorts.clear();
    }
    syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
  }
}

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
 * Injecte une session CF pré-établie par un autre mécanisme (ex: persistent-browser).
 *
 * Permet à spain-http-scanner.ts (qui appelle ensureSpainCfSession en interne) de
 * trouver la session dans son cache sans déclencher un nouveau solve CapSolver.
 * Ne syncronise PAS vers Redis (l'appelant gère sa propre persistance Redis).
 */
export function setActiveSpainCfSession(session: SpainCfSession): void {
  _activeCfSession = session;
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
  // ── Mode 2captcha-browser : navigateur cloud 2Captcha avec résolution CF native ──
  // SPAIN_SESSION_MODE=2captcha-browser → Se connecte à un navigateur distant
  // 2Captcha via CDP WebSocket. Le navigateur cloud gère les challenges CF
  // nativement (JSD, Turnstile, Managed) via l'interface CDP Captcha.
  // Avantages : fingerprint réel, pas de headless à gérer, résolution auto des captchas.
  if (process.env.SPAIN_SESSION_MODE === "2captcha-browser") {
    const { ensureSpain2CaptchaBrowserSession } = await import("./spain-2captcha-browser.js");
    return ensureSpain2CaptchaBrowserSession(targetUrl);
  }

  // ── Mode impit : JSD solve direct sans CapSolver ─────────────────────────────
  // SPAIN_SESSION_MODE=impit → JSDSolver (impit-based) résout le challenge CF
  // directement. cf_clearance + PHPSESSID obtenus avec le MÊME fingerprint TLS
  // que les appels JSONP suivants → cohérence garantie.
  if (process.env.SPAIN_SESSION_MODE === "impit") {
    const { ensureSpainImpitSession, getSpainImpitInstance } = await import("./spain-impit-session.js");
    const session = await ensureSpainImpitSession(targetUrl);
    // ⚠️  Synchroniser l'instance impit solvante dans getSpainImpit() pour que
    // spainCfFetch réutilise la même TLS session (sinon → 0B Bookitit).
    if (session) {
      const imp = getSpainImpitInstance();
      if (imp) {
        _spainImpit = imp;
        _spainImpitProxyUrl = session.soaxProxyUrl;
      }
    }
    return session;
  }

  // ── Mode capsolver-residential : HTTP-pur + proxy résidentiel Decodo ─────────
  // SPAIN_SESSION_MODE=capsolver-residential → Impit (Chrome TLS) + CapSolver
  // AntiCloudflareTask + gate.decodo.com (pool de 100 ports : 10001-10100).
  // Reproduit exactement test-bookitit-dynamic.ts :
  //   GET widget → CF solve → GET widget → POST token → srvsrc/version → GET /main/
  // Session PHPSESSID + jqCallback + reqCounter stockés dans session.bookititState.
  // Rotation : le port ne change QUE quand /main/ retourne 0B (_residentialPortIndex++).
  if (process.env.SPAIN_SESSION_MODE === "capsolver-residential") {
    // ── Cache check : réutiliser la session active si elle est encore valide ────
    // Sans ce check, le retry loop de scanSpainHttp (ligne ~3091) déclenche un
    // deuxième solve CapSolver même quand la session est toujours valide en mémoire.
    const cached = getActiveSpainCfSession();
    if (cached) {
      console.log(
        `[spain-soax] ♻️ capsolver-residential — session en cache réutilisée ` +
        `(expire dans ${Math.round((cached.expiresAt - Date.now()) / 60_000)}min)`,
      );
      return cached;
    }

    const residentialProxyBase = process.env.SPAIN_RESIDENTIAL_PROXY_URL;
    if (!residentialProxyBase) {
      console.error(
        "[spain-soax] ❌ SPAIN_SESSION_MODE=capsolver-residential exige " +
        "SPAIN_RESIDENTIAL_PROXY_URL (ex: http://user:pass@gate.decodo.com:10001)",
      );
      return null;
    }
    const capKey = process.env.CAPSOLVER_API_KEY;
    if (!capKey) {
      console.error("[spain-soax] ❌ capsolver-residential exige CAPSOLVER_API_KEY");
      return null;
    }

    const UA_RESIDENTIAL =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

    /**
     * Calcule l'URL proxy pour l'index absolu donné dans le pool de 100 ports (10001-10100).
     * L'index est toujours pris modulo 100 pour rester dans la plage.
     */
    const getResidentialProxyForIndex = (base: string, portIndex: number): string => {
      try {
        const u = new URL(base);
        u.port = String((portIndex % 100) + 10001);
        return u.toString();
      } catch { return base; }
    };

    /** Extrait tous les Set-Cookie en un dictionnaire name→value. */
    const extractCookies = (headers: { get: (k: string) => string | null }): Record<string, string> => {
      const jar: Record<string, string> = {};
      const raw = headers.get("set-cookie") ?? "";
      for (const part of raw.split(/,(?=[^ ])/)) {
        const m = part.trim().match(/^([^=]+)=([^;]*)/);
        if (m) jar[m[1].trim()] = m[2];
      }
      return jar;
    };

    const buildCookieStr = (j: Record<string, string>) =>
      Object.entries(j).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");

    /**
     * Injecte un identifiant de session sticky Decodo dans l'URL proxy.
     * Decodo résidentiel : username format = "user-{id}-session-{sid}-sessionduration-60"
     * Le même {sid} → même exit IP pour impit ET CapSolver → cf_clearance valide.
     *
     * Sans session sticky, impit et CapSolver obtiennent des exit IP différents (TCP
     * connections différentes → sessions Decodo différentes → IPs différentes) → CF
     * rejette le cf_clearance de CapSolver lors du GET impit suivant (HTTP 403).
     */
    const addStickySession = (url: string, sid: string): string => {
      try {
        const u = new URL(url);
        // Insérer -session-{sid} avant le dernier segment du username
        // ex: user-sp4e4cx19x-sessionduration-60  →  user-sp4e4cx19x-session-{sid}-sessionduration-60
        const user = decodeURIComponent(u.username);
        const stickyUser = user.includes("-session-")
          ? user.replace(/-session-[^-]+/, `-session-${sid}`)  // remplacer session existante
          : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
        u.username = encodeURIComponent(stickyUser);
        return u.toString();
      } catch { return url; }
    };

    const MAX_RETRIES_RESIDENTIAL = 3;

    for (let attempt = 0; attempt < MAX_RETRIES_RESIDENTIAL; attempt++) {
      // Sauter les ports flaggés (main/ 0B ou tunnel error) avant de sélectionner
      advanceToCleanPort();
      const proxyUrl = getResidentialProxyForIndex(residentialProxyBase, _residentialPortIndex);
      const portNum = parseInt(new URL(proxyUrl).port || "10001", 10);

      // Générer un session ID unique par tentative → impit + CapSolver partagent le même exit IP.
      const stickyId = Math.random().toString(36).slice(2, 10);
      const stickyProxyUrl = addStickySession(proxyUrl, stickyId);

      const masked = stickyProxyUrl.replace(/:([^:@/]+)@/, ":***@");
      const badCount = [..._badResidentialPorts.values()].filter(t => Date.now() - t <= BAD_PORT_TTL_MS).length;
      console.log(
        `[spain-soax] 🏠 capsolver-residential tentative ${attempt + 1}/${MAX_RETRIES_RESIDENTIAL} ` +
        `— port=${portNum} (index=${_residentialPortIndex % 100}/100) sid=${stickyId}` +
        `${badCount > 0 ? ` | 🚫 ${badCount} port(s) exclus` : ""} | proxy: ${masked.slice(0, 60)}…`,
      );

      // timeout: 12s — échoue rapide sur port Decodo injoignable (défaut impit = 30s),
      // ce qui déclenche la rotation vers le port suivant sans attendre 30s.
      // ⚠️ Utiliser stickyProxyUrl (avec session ID) pour que impit et CapSolver partagent le même exit IP.
      const impit = new Impit({ browser: "chrome", proxyUrl: stickyProxyUrl, timeout: 12_000 } as any);
      const jar: Record<string, string> = {};

      // Étape 1a : GET widget → détecter challenge CF
      let challengeHtml: string | undefined;
      try {
        const r1 = await (impit.fetch(targetUrl, {
          headers: { "User-Agent": UA_RESIDENTIAL, "Accept": "text/html,*/*;q=0.8" },
        } as any) as unknown as Promise<Response>);
        const body1 = await r1.text();
        Object.assign(jar, extractCookies(r1.headers as any));
        const isCf = r1.status === 403 || /just a moment|_cf_chl_opt/i.test(body1.slice(0, 3000));
        if (isCf) {
          challengeHtml = body1;
          console.log(`[spain-soax]    ⚠️ CF challenge (${body1.length}B) → Capsolver...`);
        } else {
          console.log(`[spain-soax]    ✅ Pas de CF challenge (HTTP ${r1.status}, ${body1.length}B)`);
        }
      } catch (e) {
        console.warn(`[spain-soax]    ⚠️ GET widget échoué: ${e} → rotation port + retry`);
        // Flag + rotate : tunnel error = port inutilisable, on l'évite pendant 30 min.
        flagResidentialPort(portNum, "GET widget erreur tunnel");
        _residentialPortIndex++;
        syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
        continue;
      }

      // Étape 1b : CapSolver AntiCloudflareTask si challenge détecté
      if (challengeHtml !== undefined) {
        // ⚠️ Passer stickyProxyUrl (avec session ID) → CapSolver résout depuis le MÊME exit IP
        // que notre impit. Le cf_clearance sera lié à cet exit IP → GET suivant accepté (pas 403).
        const capResult = await solveSpainCloudflare(targetUrl, capKey, stickyProxyUrl, challengeHtml, UA_RESIDENTIAL);
        if (!capResult.success || !capResult.session?.cfClearance) {
          console.warn(`[spain-soax]    ⚠️ CapSolver échoué: ${capResult.error} → rotation port + retry`);
          // Avancer le port : cette IP résidentielle n'a pas pu déverrouiller CF ;
          // flaggée pour 30 min pour éviter de la réessayer inutilement.
          flagResidentialPort(portNum, `CapSolver échoué: ${capResult.error ?? "unknown"}`);
          _residentialPortIndex++;
          syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
          continue;
        }
        jar.cf_clearance = capResult.session.cfClearance;
        console.log(`[spain-soax]    ✅ cf_clearance: ${jar.cf_clearance.slice(0, 30)}…`);
      }

      // Étape 2a : GET widget avec cf_clearance → token + PHPSESSID
      // (jqCallback généré une seule fois pour toute la session)
      const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1_000_000_000)}`;
      let reqCounter = Date.now();
      let token: string | undefined;

      try {
        const rGet = await (impit.fetch(targetUrl, {
          headers: { "User-Agent": UA_RESIDENTIAL, "Cookie": buildCookieStr(jar) },
        } as any) as unknown as Promise<Response>);
        const bodyGet = await rGet.text();
        Object.assign(jar, extractCookies(rGet.headers as any));
        token = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1];
        if (!token) {
          console.warn(`[spain-soax]    ⚠️ Token absent (HTTP ${rGet.status}, ${bodyGet.length}B) → rotation port + retry`);
          // CF bloque encore malgré le solve ou la page est anormale — changer d'IP.
          flagResidentialPort(portNum, `token absent HTTP ${rGet.status}`);
          _residentialPortIndex++;
          syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
          continue;
        }
        console.log(
          `[spain-soax]    ✅ Token: ${token.slice(0, 15)}… | ` +
          `PHPSESSID: ${jar.PHPSESSID ? jar.PHPSESSID.slice(0, 12) + "…" : "❌"}`,
        );
      } catch (e) {
        console.warn(`[spain-soax]    ⚠️ GET widget (token) échoué: ${e} → rotation port + retry`);
        flagResidentialPort(portNum, "GET widget (token) erreur");
        _residentialPortIndex++;
        syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
        continue;
      }

      // Étape 2b : POST token → srvsrc + version Bookitit
      const baseHost = new URL(targetUrl).origin;
      let srvsrc = baseHost;
      let version = "4";

      try {
        const rPost = await (impit.fetch(targetUrl, {
          method: "POST",
          headers: {
            "User-Agent": UA_RESIDENTIAL,
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": buildCookieStr(jar),
            "Referer": targetUrl,
            "Origin": baseHost,
          },
          body: `token=${encodeURIComponent(token)}`,
        } as any) as unknown as Promise<Response>);
        const bodyPost = await rPost.text();
        Object.assign(jar, extractCookies(rPost.headers as any));
        srvsrc = bodyPost.match(/srvsrc:\s*'([^']+)'/)?.[1] ?? baseHost;
        version = bodyPost.match(/loadermaec\.js\?v=(\d+)/)?.[1] ?? "4";
        console.log(
          `[spain-soax]    ✅ POST token → HTTP ${rPost.status} | ${bodyPost.length}B | ` +
          `srvsrc=${srvsrc} | v=${version}`,
        );
      } catch (e) {
        console.warn(`[spain-soax]    ⚠️ POST token échoué: ${e} → rotation port + retry`);
        flagResidentialPort(portNum, "POST token erreur");
        _residentialPortIndex++;
        syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
        continue;
      }

      // Construire makeUrl inline (même logique que test-bookitit-dynamic.ts)
      const publickey = targetUrl.match(/widgetdefault\/([^/?#]+)/)?.[1] ?? "";
      const bookititBase = `${baseHost}/onlinebookings`;

      const makeResidentialUrl = (endpoint: string, extra?: Record<string, string>): string => {
        reqCounter++;
        const params: Array<[string, string]> = [
          ["callback",  jqCallback],
          ["type",      "default"],
          ["publickey", publickey],
          ["lang",      "es"],
        ];
        if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
        if (extra?.["agendas[]"])  params.push(["agendas[]",  extra["agendas[]"]]);
        params.push(
          ["version", version],
          ["src",     targetUrl],
          ["srvsrc",  srvsrc],
        );
        if (extra) {
          for (const [k, v] of Object.entries(extra)) {
            if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
          }
        }
        params.push(["_", String(reqCounter)]);
        return `${bookititBase}/${endpoint}?` +
          params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      };

      const bktHeaders = {
        "User-Agent": UA_RESIDENTIAL,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        "Referer": targetUrl,
      };

      // Étape 2c : GET /main/ → valider session (>1000B)
      let prefetchedMainHtml: string;
      try {
        const rMain = await (impit.fetch(makeResidentialUrl("main/"), {
          headers: { ...bktHeaders, "Cookie": buildCookieStr(jar) },
        } as any) as unknown as Promise<Response>);
        prefetchedMainHtml = await rMain.text();
        if (prefetchedMainHtml.length < 1000) {
          flagResidentialPort(portNum, `main/ ${prefetchedMainHtml.length}B trop court`);
          _residentialPortIndex++;
          const nextPort = (_residentialPortIndex % 100) + 10001;
          syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
          console.warn(
            `[spain-soax] 🔄 /main/ = ${prefetchedMainHtml.length}B — ` +
            `rotation port ${portNum} → ${nextPort} (index=${_residentialPortIndex % 100}/100)`,
          );
          continue;
        }
        console.log(`[spain-soax]    ✅ /main/ → ${prefetchedMainHtml.length}B — session prête! port=${portNum}`);
      } catch (e) {
        console.warn(`[spain-soax]    ⚠️ GET /main/ échoué: ${e} → rotation port + retry`);
        flagResidentialPort(portNum, "GET /main/ erreur");
        _residentialPortIndex++;
        syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
        continue;
      }

      // Session établie — construire SpainCfSession avec bookititState
      const nowMs = Date.now();
      const allCookies: Array<{ name: string; value: string }> = Object.entries(jar)
        .filter(([, v]) => v)
        .map(([name, value]) => ({ name, value }));

      const session: SpainCfSession = {
        cfClearance:         jar.cf_clearance ?? "",
        cfDomain:            ".citaconsular.es",
        soaxProxyUrl:        stickyProxyUrl, // conserver l'URL sticky pour les requêtes JSONP suivantes
        userAgent:           UA_RESIDENTIAL,
        createdAt:           nowMs,
        expiresAt:           nowMs + CF_CLEARANCE_TTL_MS,
        allCookies,
        extraHeaders:        {},
        source:              "capsolver",
        prefetchedMainHtml,
        phpSessionCreatedAt: nowMs,
        bookititState: {
          jqCallback,
          reqCounter,
          srvsrc,
          version,
          widgetUrl:    targetUrl,
          publickey,
          bookititBase,
        },
      };

      // Réutiliser le même impit pour spainCfFetch (même TLS session = même IP résidentielle)
      _spainImpit        = impit;
      _spainImpitProxyUrl = proxyUrl;

      _activeCfSession = session;
      syncSpainCfSessionToRedis(session as SerializableSpainCfSession);

      console.log(
        `[spain-soax] 🎉 Session capsolver-residential établie! ` +
        `port=${portNum} (index=${_residentialPortIndex % 100}/100) | ` +
        `jqCallback=${jqCallback.slice(0, 30)}… | ` +
        `PHPSESSID=${jar.PHPSESSID ? "✅" : "❌"} | ` +
        `srvsrc=${srvsrc} | v=${version} | ` +
        `Valide ~${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`,
      );
      return session;
    }

    console.error(
      `[spain-soax] ❌ Impossible d'obtenir session capsolver-residential après ${MAX_RETRIES_RESIDENTIAL} tentatives`,
    );
    return null;
  }

  // ── Mode persistent-browser : déléguer entièrement au PB manager ────────────
  // Quand SPAIN_SESSION_MODE=persistent-browser, le solve CF et la capture /main/
  // sont gérés par SpainPersistentBrowserManager (Chromium Puppeteer + Decodo ISP).
  // Tomber dans le chemin soax/CapSolver ci-dessous serait une régression : CapSolver
  // AntiCloudflareTask produit un cf_clearance lié à son TLS, incompatible avec impit.
  if (process.env.SPAIN_SESSION_MODE === "persistent-browser") {
    const { ensureSpainPersistentBrowserSession, spainPersistentBrowser } =
      await import("./spain-persistent-browser.js");
    const pbSession = await ensureSpainPersistentBrowserSession(targetUrl);
    // Si /main/ n'a pas été capturé (CF bloque cette IP Decodo pour /main/),
    // fermer le browser MAINTENANT (avant tout retry) pour forcer une nouvelle
    // rotation IP → CF voit une IP inconnue → émet un nonce frais → /main/ répond.
    //
    // PROTECTION BOUCLE DESTRUCTRICE : si le token JSD oneshot CF est périmé (ex:
    // token émis à 07:05 toujours servi 2h38min plus tard), chaque retry produit
    // aussi 0B → closeAndInvalidate toutes les 10s → destroy en boucle d'une session
    // valide. On limite à UN seul retry par cycle de session via prefetchRetried.
    //
    // IMPORTANT : vérifier wasLastEnsureFromCache avant de déclencher la rotation.
    // Sans ce garde-fou, le scanner consomme le prefetch (session.prefetchedMainHtml = undefined)
    // et le probe SUIVANT voit !prefetchedMainHtml sur une session parfaitement valide
    // → closeAndInvalidate + re-solve CF à chaque cycle (toutes les 10s) alors que
    // la session est encore bonne pour ~115 min.
    if (pbSession && !(pbSession as any).prefetchedMainHtml && !spainPersistentBrowser.wasLastEnsureFromCache) {
      if (spainPersistentBrowser.prefetchRetried) {
        // Retry déjà effectué dans ce cycle — ne pas relancer closeAndInvalidate.
        // Retourner la session telle quelle ; le scanner gérera le 0B via son propre retry.
        console.warn(
          "[spain-soax] ⚠️ PB session sans prefetch (retry déjà tenté) — session acceptée telle quelle",
        );
        return pbSession;
      }
      console.warn(
        "[spain-soax] ⚠️ PB session sans prefetch /main/ (CF bloque cette IP Decodo)" +
        " — fermeture browser + rotation IP + retry unique…",
      );
      spainPersistentBrowser.markPrefetchRetried();
      await spainPersistentBrowser.closeAndInvalidate();
      return ensureSpainPersistentBrowserSession(targetUrl);
    }
    return pbSession;
  }

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
  if (
    existing &&
    (!httpModeRequiresProxy() || hasCompatibleProxy(existing.soaxProxyUrl, configuredProxyUrl)) &&
    (!browserSessionRequired() || existing.source === "playwright")
  ) {
    const remainMin = Math.round((_activeCfSession!.expiresAt - Date.now()) / 60_000);
    console.log(`[spain-soax] ♻️ Session CF réutilisée (reste ${remainMin}min)`);
    return existing;
  }
  if (existing && httpModeRequiresProxy()) {
    console.warn(
      "[spain-soax] ⚠️ Session mémoire ignorée: proxy incompatible ou session non établie par navigateur",
    );
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

  // Playwright is always tried first. CapSolver is only a fallback seed for a
  // second Playwright navigation; it is never accepted as a replacement for
  // the browser-side JSD Oneshot.
  const browserSessionPreferred =
    (!httpModeRequiresProxy() && process.env.USE_LOCAL_STEALTH === "true") ||
    (httpModeRequiresProxy() && process.env.SPAIN_HTTP_SESSION_MODE === "playwright");
  if (browserSessionPreferred) {
    console.log("[spain-soax] 🔍 Mode navigateur activé — Playwright + challenge humain + JSD Oneshot…");

    // Proxy actif (Decodo ou SOAX sticky) — DOIT être la même IP que les appels impit
    const soaxProxyForPlaywright = getSpainProxyUrl();
    if (httpModeRequiresProxy() && !soaxProxyForPlaywright) {
      console.error("[spain-soax] ❌ Le mode navigateur HTTP exige le proxy Espagne configuré");
      return null;
    }

    let widgetCookies = await solveSpainWidgetSession(
      targetUrl,
      soaxProxyForPlaywright,
      [],
    );

    if (!widgetCookies?.jsdOneshotCaptured && !widgetCookies?.seededClearanceAccepted) {
      const capsolverKey = process.env.CAPSOLVER_API_KEY;
      if (!capsolverKey || !soaxProxyForPlaywright) {
        console.error(
          "[spain-soax] ❌ Playwright a échoué et le fallback CapSolver exige " +
          "CAPSOLVER_API_KEY + le proxy Espagne",
        );
        return null;
      }

      console.warn(
        "[spain-soax] 🔁 Playwright n'a pas capturé le JSD — " +
        "fallback CapSolver, puis nouvelle navigation Playwright",
      );
      const capResult = await solveSpainCloudflare(
        targetUrl,
        capsolverKey,
        soaxProxyForPlaywright,
      );
      if (!capResult.success || !capResult.session) {
        console.error(
          `[spain-soax] ❌ Fallback CapSolver échoué: ${capResult.error ?? "erreur inconnue"}`,
        );
        return null;
      }

      // CapSolver only seeds the browser with the same-IP cookies. The
      // browser must still load the page and emit/capture the JSD request.
      widgetCookies = await solveSpainWidgetSession(
        targetUrl,
        soaxProxyForPlaywright,
        capResult.session.allCookies,
      );
    }

    if (widgetCookies?.jsdOneshotCaptured || widgetCookies?.seededClearanceAccepted) {
      const pwCreatedAt = Date.now();
      // Preserve the browser cookie jar exactly. In particular, replacing the
      // real Analytics cookies after a browser solve would create a session
      // that no longer matches the navigation that produced it.
      const pwAllCookies = widgetCookies.allCookies;

      // Test confirmé 2026-07-27 : CF (Decodo ISP) sert le widget directement même sans
      // cf_clearance → l'IP est de confiance et JSD Oneshot ne fire jamais en Phase 2b.
      // La clearance CapSolver liée à la même IP Decodo est acceptée par CF en HTTP impit.
      // On accepte donc la session seededClearanceAccepted sans exiger JSD.
      if (!widgetCookies.jsdOneshotCaptured && widgetCookies.seededClearanceAccepted) {
        console.log(
          "[spain-soax] ✅ Session CapSolver-only acceptée — IP Decodo ISP de confiance, " +
          "JSD Oneshot non requis (CF ne challenge pas cette IP).",
        );
      }

      const session: SpainCfSession = {
        cfClearance: widgetCookies.cfClearance,
        cfDomain: ".citaconsular.es",
        soaxProxyUrl: soaxProxyForPlaywright ?? "",
        userAgent: widgetCookies.userAgent,
        createdAt: pwCreatedAt,
        expiresAt: pwCreatedAt + CF_CLEARANCE_TTL_MS,
        allCookies: pwAllCookies,
        extraHeaders: {},
        source: "playwright",
      };
      _activeCfSession = session;
      syncSpainCfSessionToRedis(session as SerializableSpainCfSession);
      console.log(
        `[spain-soax] 🎉 Session Playwright établie ! ` +
        `JSD=${widgetCookies.jsdOneshotCaptured ? "✅ Oneshot#2" : "⚠️ clearance-only"} | ` +
        `PHPSESSID=${session.allCookies.find(c => c.name === "PHPSESSID") ? "✅" : "❌"} | ` +
        `Valide ~${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`
      );
      return session;
    }

    console.error(
      "[spain-soax] ❌ Session navigateur refusée: JSD Oneshot non capturé " +
      "et clearance CapSolver non acceptée. Aucun fallback legacy.",
    );
    return null;
  }

  // Tenter restauration depuis Redis (survit aux redéploiements)
  try {
    const cached = await restoreSpainCfSessionFromRedis();
    if (cached) {
      if (
        httpModeRequiresProxy() &&
        (!hasCompatibleProxy(cached.soaxProxyUrl, configuredProxyUrl) ||
          (browserSessionRequired() && cached.source !== "playwright"))
      ) {
        console.warn(
          "[spain-soax] ⚠️ Session Redis ignorée: proxy incompatible ou session non établie par navigateur",
        );
        removeSpainCfSessionFromRedis();
      } else {
        // Reconstruire la session en mémoire
        const restoredAllCookies = cached.allCookies;
        const restored: SpainCfSession = {
          cfClearance: cached.cfClearance,
          cfDomain: cached.cfDomain,
          soaxProxyUrl: cached.soaxProxyUrl,
          userAgent: cached.userAgent,
          createdAt: cached.createdAt,
          expiresAt: cached.expiresAt,
          allCookies: restoredAllCookies,
          extraHeaders: cached.extraHeaders,
          source: cached.source,
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

  // ── Étape 1 : Probe direct via impit (toujours en premier) ──────────────────
  // Decodo ISP est de confiance pour CF — le site est servi sans challenge dans
  // la grande majorité des cas. On tente l'accès direct avant d'appeler CapSolver
  // pour éviter ERROR_INVALID_TASK_DATA ("html field required") et économiser
  // les crédits + les ~18s de round-trip CapSolver.
  const DIRECT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
  const DIRECT_HEADERS = {
    "User-Agent": DIRECT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Sec-Ch-Ua": '"Not/A)Brand";v="8", "Chromium";v="151", "Google Chrome";v="151"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  };

  // TTL d'une session directe : même ordre de grandeur que cf_clearance.
  // Si le PHPSESSID expire avant, le scanner détectera un 403 et invalidera.
  const DIRECT_SESSION_TTL_MS = 90 * 60_000; // 90min

  let cfChallengeDetected = false;
  let challengeHtmlFromProbe: string | undefined;
  // Déclaré hors du try pour être réutilisable après le solve CapSolver :
  // la même instance impit doit faire le GET portal post-solve pour que le
  // cf_clearance (lié à cette TLS via le champ html) soit accepté.
  let probeImpit: InstanceType<typeof Impit> | undefined;

  try {
    console.log(`[spain-soax] 🔍 Probe direct Decodo ISP…`);
    probeImpit = new Impit({ browser: "chrome", proxyUrl: soaxProxyUrl } as any);
    const probeRes = await (probeImpit.fetch(targetUrl, { headers: DIRECT_HEADERS } as any) as unknown as Promise<Response>);
    const probeBody = await (probeRes as any).text() as string;
    const isCf = /just a moment|jetzt einen moment|verifying|_cf_chl_opt/i.test(probeBody.slice(0, 3000));

    if ((probeRes as any).status === 200 && !isCf) {
      // Pas de challenge CF → session directe
      const setCookie = (probeRes as any).headers?.get?.("set-cookie") ?? "";
      const phpSessionId = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";

      const directCreatedAt = Date.now();
      const directAllCookies: Array<{ name: string; value: string }> = [];
      if (phpSessionId) directAllCookies.push({ name: "PHPSESSID", value: phpSessionId });

      const directSession: SpainCfSession = {
        cfClearance: "",
        cfDomain: ".citaconsular.es",
        soaxProxyUrl,
        userAgent: DIRECT_UA,
        createdAt: directCreatedAt,
        expiresAt: directCreatedAt + DIRECT_SESSION_TTL_MS,
        allCookies: directAllCookies,
        extraHeaders: {},
        source: "direct",
      };

      // ⚠️  CRITIQUE : conserver la même instance impit pour les requêtes JSONP suivantes.
      // CF lie le cf_clearance (vide ici) ET le PHPSESSID à la session TLS du probe.
      // getSpainImpit() créerait une nouvelle instance → nouvelle TLS → 0B Bookitit.
      _spainImpit = probeImpit;
      _spainImpitProxyUrl = soaxProxyUrl;

      _activeCfSession = directSession;
      syncSpainCfSessionToRedis(directSession as SerializableSpainCfSession);
      console.log(
        `[spain-soax] 🎉 Session directe établie — PHPSESSID=${phpSessionId ? "✅" : "❌ absent"} | Valide 90min | impit probe réutilisé ✅`,
      );
      return directSession;
    }

    if (isCf) {
      cfChallengeDetected = true;
      console.log(`[spain-soax] ⚠️ CF challenge détecté sur probe direct → solve CapSolver nécessaire`);
      // Conserver le HTML pour l'envoyer à CapSolver et éviter un double-fetch proxy
      challengeHtmlFromProbe = probeBody;
    } else {
      console.warn(`[spain-soax] ⚠️ Probe direct: HTTP ${(probeRes as any).status} — tentative CapSolver`);
      cfChallengeDetected = true; // tenter CapSolver quand même
    }
  } catch (probeErr) {
    console.warn(`[spain-soax] ⚠️ Probe direct échoué (${probeErr}) → tentative CapSolver`);
    cfChallengeDetected = true;
  }

  // ── Étape 2 : CF challenge détecté → CapSolver AntiCloudflareTask ───────────
  //
  // Mécanisme clé (confirmé 2026-08-10) :
  //   • On passe le HTML du challenge CF (challengeHtmlFromProbe) à CapSolver.
  //   • CapSolver résout le challenge à partir de CE HTML (sans refetcher la page
  //     avec son propre Chrome). Le cf_clearance produit est lié à la session TLS
  //     du probe impit (même IP proxy + même contexte).
  //   • La même instance probeImpit (même objet) fait ensuite le GET portal avec ce
  //     cf_clearance → 200 + PHPSESSID. CapSolver Chrome n'est pas impliqué dans
  //     la session finale.
  //
  //   Sans html : CapSolver utilise son propre Chrome → cf_clearance lié à sa TLS
  //   Chrome → impit reçoit 403 sur le portail citaconsular.es. ❌
  if (!cfChallengeDetected) {
    console.error(`[spain-soax] ❌ Probe direct échoué sans challenge CF détecté`);
    return null;
  }

  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  if (!capsolverKey) {
    console.error(`[spain-soax] ❌ CF challenge détecté mais CAPSOLVER_API_KEY non configurée`);
    return null;
  }

  const proxyLabel = process.env.DECODO_PROXY_URL ? "Decodo ISP" : "SOAX sticky";
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[spain-soax] 🎯 CapSolver AntiCloudflareTask tentative ${attempt}/${MAX_ATTEMPTS}…`);

    // Passer le HTML du challenge probe → cf_clearance lié à la TLS impit
    const result = await solveSpainCloudflare(targetUrl, capsolverKey, soaxProxyUrl, challengeHtmlFromProbe);

    if (result.success && result.session) {
      // ── Étape 2b : GET portal avec le même probeImpit + cf_clearance ─────────
      // CRITIQUE : utiliser la même instance impit (même session TLS) que le probe.
      // Le cf_clearance (résolu via html) n'est valide que pour cette instance.
      let phpSessionId = "";
      if (probeImpit && result.session.cfClearance) {
        try {
          console.log(`[spain-soax] 🔄 GET portal post-solve (même impit) → PHPSESSID…`);
          const portalRes = await (probeImpit.fetch(targetUrl, {
            headers: {
              ...DIRECT_HEADERS,
              "Cookie": `cf_clearance=${result.session.cfClearance}`,
            },
          } as any) as unknown as Promise<Response>);
          const portalBody = await (portalRes as any).text() as string;
          const portalStatus = (portalRes as any).status as number;
          const setCookie = (portalRes as any).headers?.get?.("set-cookie") ?? "";
          phpSessionId = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
          const isCfStill = /just a moment|_cf_chl_opt/i.test(portalBody.slice(0, 2000));

          if (phpSessionId) {
            console.log(`[spain-soax] ✅ PHPSESSID obtenu via probeImpit: ${phpSessionId.slice(0, 12)}…`);
            result.session.allCookies = [
              ...result.session.allCookies.filter(c => c.name !== "PHPSESSID"),
              { name: "PHPSESSID", value: phpSessionId },
            ];
          } else {
            console.warn(`[spain-soax] ⚠️ GET portal post-solve: HTTP ${portalStatus} ${isCfStill ? "[CF encore actif]" : "[pas de PHPSESSID]"}`);
          }

          // Sauvegarder la même instance impit → toutes les requêtes suivantes
          // utilisent cette TLS (scan JSONP + booking).
          _spainImpit = probeImpit;
          _spainImpitProxyUrl = soaxProxyUrl;
        } catch (e) {
          console.warn(`[spain-soax] ⚠️ GET portal post-solve échoué (non-fatal): ${e}`);
        }
      }

      result.session.allCookies = await applyStableGaProfile(
        result.session.allCookies,
        result.session.createdAt,
      );
      result.session.source = "capsolver";
      _activeCfSession = result.session;
      console.log(`[spain-soax] 🎉 Session CF établie via ${proxyLabel}! Durée solve: ${Math.round(result.durationMs / 1000)}s | PHPSESSID: ${phpSessionId ? "✅" : "⚠️ absent"}`);
      console.log(`[spain-soax]    Valide jusqu'à: ${new Date(result.session.expiresAt).toISOString()}`);
      syncSpainCfSessionToRedis(result.session as SerializableSpainCfSession);
      return result.session;
    }

    const capErr = result.error ?? "";
    console.warn(`[spain-soax] ⚠️ CapSolver tentative ${attempt} échouée: ${capErr}`);

    if (/challenge not found/i.test(capErr)) {
      console.log(`[spain-soax] ℹ️ Challenge disparu entre probe et solve — accès direct maintenant`);
      break;
    }

    if (attempt < MAX_ATTEMPTS) {
      // Recréer probeImpit pour la prochaine tentative (nouveau contexte TLS)
      probeImpit = new Impit({ browser: "chrome", proxyUrl: soaxProxyUrl } as any);
      rotateSpainSoaxSession("spain-cf");
      await new Promise((r) => setTimeout(r, 5_000));
      // Refetcher le HTML du challenge pour la tentative suivante
      try {
        const reprobe = await (probeImpit.fetch(targetUrl, { headers: DIRECT_HEADERS } as any) as unknown as Promise<Response>);
        const reprobeBody = await (reprobe as any).text() as string;
        if (/just a moment|_cf_chl_opt/i.test(reprobeBody.slice(0, 3000))) {
          challengeHtmlFromProbe = reprobeBody;
          console.log(`[spain-soax] 🔄 Nouveau challenge HTML fetché pour tentative ${attempt + 1}`);
        }
      } catch { /* non-fatal */ }
    }
  }

  console.error(`[spain-soax] ❌ Impossible d'obtenir une session CF après probe + CapSolver`);
  return null;
}

// ─── Impit Instance (Chrome fingerprint + SOAX proxy) ───────────────────────

/**
 * Restaure l'état SOAX rotation depuis Redis (appelé au démarrage).
 * Permet de reprendre avec le bon rotation count après un redéploiement.
 */
export async function restoreSpainSoaxStateFromRedis(): Promise<void> {
  // Rotation SOAX
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

  // Port résidentiel — index + ports flaggés
  try {
    const portState = await restoreResidentialPortStateFromRedis();
    if (portState) {
      _residentialPortIndex = portState.portIndex;
      _badResidentialPorts.clear();
      for (const [port, ts] of Object.entries(portState.badPorts)) {
        _badResidentialPorts.set(Number(port), Number(ts));
      }
      const badCount = _badResidentialPorts.size;
      console.log(`[spain-soax] ✅ Port state restauré — index=${_residentialPortIndex} (port ${(_residentialPortIndex % 100) + 10001}), ${badCount} port(s) flaggé(s)`);
    }
  } catch (err) {
    console.warn(`[spain-soax] ⚠️ Restauration port state échouée (non-fatal): ${err}`);
  }
}

// ── Chromium page-fetch provider ─────────────────────────────────────────────
// Enregistré par spain-persistent-browser au chargement du module (évite la
// dépendance circulaire spain-soax-solver ↔ spain-persistent-browser).
// Quand une session Playwright est active, spainCfFetch route les endpoints
// Bookitit via la page Chromium → même IP garantie, PHPSESSID toujours valide.
type SpainPageFetchFn = (url: string) => Promise<string | null>;
let _spainPageFetcher: SpainPageFetchFn | null = null;

/**
 * Enregistre le fournisseur de fetch via page Chromium.
 * Doit être appelé par spain-persistent-browser après avoir défini
 * callBookititEndpointViaBrowser (aucun import circulaire requis).
 */
export function registerSpainPageFetcher(fn: SpainPageFetchFn | null): void {
  _spainPageFetcher = fn;
}

let _spainImpit: InstanceType<typeof Impit> | undefined;
let _spainImpitProxyUrl: string | undefined;

/**
 * Crée une instance impit fraîche pour une session isolée (booking multi-dossiers).
 * Chaque appel retourne un objet distinct — pas de singleton partagé.
 * Utilisé par createIsolatedBookingSession() pour isoler les bookings parallèles.
 */
export function createFreshSpainImpit(session: SpainCfSession): InstanceType<typeof Impit> {
  const impit = new Impit({
    browser: "chrome",
    proxyUrl: session.soaxProxyUrl || undefined,
  } as any);
  return impit;
}

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
// ─── Test injection hook ─────────────────────────────────────────────────────
// Pattern : same as _resetForTesting in session-pool.ts.
// Production build is not affected — the hook is null at runtime.

type SpainCfFetchImpl = (
  url: string,
  session: SpainCfSession,
  fetchOptions?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
) => Promise<Response | null>;

let _testFetchImpl: SpainCfFetchImpl | null = null;

/** Override spainCfFetch in tests — pass null to restore real impit behaviour. */
export function _setTestFetch(fn: SpainCfFetchImpl | null): void {
  _testFetchImpl = fn;
}

export async function spainCfFetch(
  url: string,
  session: SpainCfSession,
  fetchOptions?: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> },
): Promise<Response | null> {
  if (_testFetchImpl) return _testFetchImpl(url, session, fetchOptions);

  // ── Synchronisation impit ↔ Chromium ────────────────────────────────────────
  // Quand la session vient de Playwright, le PHPSESSID est lié à la connexion
  // TLS Chromium et non à l'IP seule → impit retourne 0B même avec le même proxy.
  // On délègue les endpoints Bookitit à la page Chromium active (même IP garantie)
  // et on ne tombe sur impit qu'en fallback (page absente ou réponse vide).
  if (session.source === "playwright" && _spainPageFetcher && url.includes("/onlinebookings/")) {
    try {
      const pageBody = await _spainPageFetcher(url);
      if (pageBody !== null && pageBody !== "") {
        return new Response(pageBody, {
          status: 200,
          headers: { "content-type": "text/javascript; charset=utf-8" },
        });
      }
      console.log(`[spain-soax] ⚠️  page-fetch vide pour ${url.slice(0, 80)} — fallback impit`);
    } catch (err) {
      console.warn(`[spain-soax] ⚠️  page-fetch error: ${err} — fallback impit`);
    }
  }

  const impit = session._ownImpit ?? getSpainImpit(session);

  // Keep the cookie order observed in the browser flow and place the
  // Cloudflare cookie last. Callers that update PHPSESSID after a response
  // may override this header with their current request-local jar.
  const cookieParts: string[] = [];
  const preferredCookieNames = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  for (const name of preferredCookieNames) {
    const cookie = session.allCookies.find((candidate) => candidate.name === name);
    if (cookie) cookieParts.push(`${cookie.name}=${cookie.value}`);
  }
  for (const c of session.allCookies) {
    if (c.name !== "cf_clearance" && !preferredCookieNames.includes(c.name)) {
      cookieParts.push(`${c.name}=${c.value}`);
    }
  }
  if (session.cfClearance) cookieParts.push(`cf_clearance=${session.cfClearance}`);

  // Extract Chrome major version from UA
  const chromeMajor = session.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "136";

  // Referer : le serveur PHP Bookitit valide le Referer pour lier le PHPSESSID.
  // Sans Referer, la session PHP n'est pas initialisée → réponses 0B.
  // Le widget jQuery natif envoie toujours le Referer de la page portail.
  const referer = url.includes("/onlinebookings/") && session.portalKey
    ? `https://www.citaconsular.es/es/hosteds/widgetdefault/${session.portalKey}/`
    : "https://www.citaconsular.es/es/";

  // Base headers, can be overridden by session.extraHeaders and fetchOptions.headers
  const baseHeaders: Record<string, string> = {
    "User-Agent": session.userAgent,
    "Accept": "*/*",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Referer": referer,
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

  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await impit.fetch(url, { ...fetchOptions, headers: finalHeaders } as any) as unknown as Response;
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout|timed out|request timeout/i.test(msg);
      const isProxyConnectError = /CONNECT tunnel|proxy.*502|502.*proxy|ProxyTunnel/i.test(msg);
      console.error(`[spain-soax] ❌ Fetch error: ${msg} (attempt ${attempt + 1}/${maxRetries + 1})`);

      if (isProxyConnectError) {
        // Le port résidentiel du proxy refuse le tunnel CONNECT → port inutilisable.
        // On flagge le port ET on invalide la session CF pour forcer un nouveau solve
        // avec un port différent au prochain appel à ensureSpainCfSession().
        // Sans cette invalidation, la boucle de rotation ISP réutilise la même session
        // cachée avec le même port mort → 10 rotations inutiles.
        if (session.soaxProxyUrl) {
          try {
            const deadPort = parseInt(new URL(session.soaxProxyUrl).port || "10001", 10);
            if (deadPort >= 10001 && deadPort <= 10100) {
              flagResidentialPort(deadPort);
              _residentialPortIndex++;
              syncResidentialPortStateToRedis(_residentialPortIndex, _badResidentialPorts);
            }
          } catch { /* ignore URL parse errors */ }
        }
        console.warn(`[spain-soax] ⚠️ Proxy CONNECT error → session CF invalidée (prochain solve avec port différent)`);
        invalidateSpainCfSession();
        return null;
      }

      if (attempt < maxRetries && isTimeout) {
        const backoff = 500 * (attempt + 1);
        await new Promise((r) => setTimeout(r, backoff));
        continue; // retry on timeout
      }
      return null;
    }
  }
  return null;
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

// ─── Utilitaire URL Bookitit partagé ────────────────────────────────────────

/**
 * Construit une URL JSONP Bookitit avec l'ordre de paramètres strict
 * requis par certains portails (ex: Cuba bkt897578 retourne 0B si ordre incorrect).
 *
 * Ordre canonique (reproduit test-bookitit-dynamic.ts) :
 *   callback → type → publickey → lang → [services[]] → [agendas[]] →
 *   version → src → srvsrc → [autres params] → _
 *
 * @param session  Session active avec bookititState (mode capsolver-residential)
 * @param endpoint Endpoint Bookitit ex: "datetime/", "getservices/"
 * @param extra    Params supplémentaires : services[], agendas[], start, end, etc.
 * @returns URL complète prête à passer à spainCfFetch / impit.fetch
 */
export function makeBookititUrl(
  session: SpainCfSession,
  endpoint: string,
  extra?: Record<string, string>,
): string {
  const state = session.bookititState;
  if (!state) {
    throw new Error(
      "[spain-soax] makeBookititUrl() exige session.bookititState " +
      "(mode capsolver-residential uniquement)",
    );
  }
  state.reqCounter++;
  const params: Array<[string, string]> = [
    ["callback",  state.jqCallback],
    ["type",      "default"],
    ["publickey", state.publickey],
    ["lang",      "es"],
  ];
  if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
  if (extra?.["agendas[]"])  params.push(["agendas[]",  extra["agendas[]"]]);
  params.push(
    ["version", state.version],
    ["src",     state.widgetUrl],
    ["srvsrc",  state.srvsrc],
  );
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
    }
  }
  params.push(["_", String(state.reqCounter)]);
  return `${state.bookititBase}/${endpoint}?` +
    params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}
