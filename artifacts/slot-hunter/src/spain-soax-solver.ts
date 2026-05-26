/**
 * spain-soax-solver.ts — Cloudflare bypass pour citaconsular.es via SOAX + CapSolver
 *
 * ARCHITECTURE :
 *   1. Génère une URL SOAX sticky longue durée (~2h = durée cf_clearance)
 *   2. Appelle CapSolver AntiCloudflareTask avec ce proxy SOAX
 *   3. Retourne le cookie cf_clearance + l'URL proxy SOAX (même IP)
 *   4. impit (Chrome TLS fingerprint) utilise la même IP SOAX + cookie → accès direct aux APIs Bookitit
 *
 * POURQUOI ça marche :
 *   - cf_clearance est lié à l'IP + fingerprint TLS
 *   - impit simule Chrome JA3/JA4 → même fingerprint que CapSolver (profil Chrome)
 *   - Même IP SOAX (sticky session longue) → le cookie est accepté
 *   - Résultat : scan HTTP pur toutes les 30-60s sans Playwright
 *
 * COÛT : ~$0.005 par solve CapSolver (vs $0.02+ pour Turnstile)
 * DURÉE : cf_clearance valide ~2h → 1 solve pour ~120 scans
 */

import { Impit } from "impit";

// ─── Configuration ──────────────────────────────────────────────────────────

const CAPSOLVER_BASE = "https://api.capsolver.com";
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
  /** URL proxy SOAX sticky à utiliser pour les requêtes impit */
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
 * Génère une URL SOAX sticky longue durée pour l'Espagne.
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

    // Nettoyer les anciens paramètres de session du username
    proxyUser = proxyUser
      .replace(/-sessionid-[^-]*/g, "")
      .replace(/-sessionlength-[^-]*/g, "")
      .replace(/-country-[^-]*/g, "")
      .replace(/-city-[^-]*/g, "")
      .replace(/-+$/, "");

    // Session ID déterministe (stable pendant la demi-journée sauf rotation)
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _spainSoaxRotationCount.get(identifier) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${identifier}:spain-soax:r${rotationCount}`;
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
  }
}

/**
 * Obtient ou renouvelle la session CF pour l'Espagne.
 * - Si une session valide existe → la retourne
 * - Si expirée ou absente → solve via CapSolver + SOAX
 * - Retry automatique (max 2 tentatives avec rotation IP)
 */
export async function ensureSpainCfSession(
  targetUrl: string = DEFAULT_SPAIN_TARGET_URL,
): Promise<SpainCfSession | null> {
  // Session active et valide ?
  const existing = getActiveSpainCfSession();
  if (existing) {
    const remainMin = Math.round((_activeCfSession!.expiresAt - Date.now()) / 60_000);
    console.log(`[spain-soax] ♻️ Session CF réutilisée (reste ${remainMin}min)`);
    return existing;
  }

  // Vérifier les prérequis
  const soaxBaseUrl = process.env.SOAX_PROXY_URL;
  const capsolverKey = process.env.CAPSOLVER_API_KEY;

  if (!soaxBaseUrl) {
    console.error(`[spain-soax] ❌ SOAX_PROXY_URL non configurée`);
    return null;
  }
  if (!capsolverKey) {
    console.error(`[spain-soax] ❌ CAPSOLVER_API_KEY non configurée`);
    return null;
  }

  // Générer le proxy SOAX sticky longue durée
  const soaxProxyUrl = makeSpainSoaxStickyUrl(soaxBaseUrl, SOAX_SPAIN_SESSION_LIFETIME_MIN, "spain-cf");

  // Tenter le solve (max 2 essais avec rotation)
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(`[spain-soax] 🎯 Tentative ${attempt}/${MAX_ATTEMPTS}…`);

    const result = await solveSpainCloudflare(targetUrl, capsolverKey, soaxProxyUrl);

    if (result.success && result.session) {
      _activeCfSession = result.session;
      console.log(`[spain-soax] 🎉 Session CF établie! Durée solve: ${Math.round(result.durationMs / 1000)}s`);
      console.log(`[spain-soax]    Valide jusqu'à: ${new Date(result.session.expiresAt).toISOString()}`);
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

let _spainImpit: InstanceType<typeof Impit> | undefined;
let _spainImpitProxyUrl: string | undefined;

/**
 * Retourne une instance impit configurée avec le proxy SOAX de la session CF active.
 * Le fingerprint TLS Chrome garantit la cohérence avec le solve CapSolver.
 */
export function getSpainImpit(session: SpainCfSession): InstanceType<typeof Impit> {
  if (_spainImpit && _spainImpitProxyUrl === session.soaxProxyUrl) {
    return _spainImpit;
  }

  _spainImpit = new Impit({
    browser: "chrome",
    ignoreTlsErrors: true,
    proxyUrl: session.soaxProxyUrl,
  } as any);
  _spainImpitProxyUrl = session.soaxProxyUrl;

  const masked = session.soaxProxyUrl.replace(/:([^:@]+)@/, ":***@");
  console.log(`[spain-soax] ✅ impit Espagne initialisé (Chrome TLS + SOAX: ${masked.slice(0, 60)}…)`);
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
  extraHeaders?: Record<string, string>,
): Promise<Response | null> {
  const impit = getSpainImpit(session);

  // Construire le cookie header
  const cookieParts = [`cf_clearance=${session.cfClearance}`];
  for (const c of session.allCookies) {
    if (c.name !== "cf_clearance") {
      cookieParts.push(`${c.name}=${c.value}`);
    }
  }

  const headers: Record<string, string> = {
    "User-Agent": session.userAgent,
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cookie": cookieParts.join("; "),
    "Sec-CH-UA": '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
    ...session.extraHeaders,
    ...extraHeaders,
  };

  try {
    const res = await impit.fetch(url, { headers } as any) as unknown as Response;
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
