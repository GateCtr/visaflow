/**
 * spain-impit-session.ts — Session CF citaconsular.es entièrement via impit
 *
 * OBJECTIF : obtenir une session CF (cf_clearance + PHPSESSID) sans CapSolver
 * ni Playwright, en passant uniquement par impit (Chrome TLS JA3/JA4).
 *
 * POURQUOI CE MODULE EXISTE :
 *   - CapSolver produit un cf_clearance lié à son propre TLS (CapSolver ≠ Chrome JA3)
 *   - impit rejetait ce cookie sur les JSONP car CF détecte la discordance fingerprint
 *   - Solution : JSDSolver (maintenant impit-based) obtient cf_clearance avec le MÊME
 *     fingerprint TLS que les appels JSONP → cohérence totale
 *
 * FLOW :
 *   1. Probe GET portal via impit → CF challenge ou accès direct ?
 *   2a. Accès direct → PHPSESSID dans Set-Cookie → session prête
 *   2b. CF challenge → JSDSolver.solve() → cf_clearance
 *   3. GET portal avec cf_clearance (même impit instance) → PHPSESSID dans Set-Cookie
 *   4. Retourner SpainCfSession (compatible avec spain-soax-solver.ts + spain-http-scanner.ts)
 *
 * RÈGLE CRITIQUE : le même `impit` qui a obtenu cf_clearance DOIT être utilisé pour tous
 * les appels JSONP suivants. Ne pas créer une nouvelle instance impit pour les scans.
 */

import { Impit } from "impit";
import { JSDSolver } from "./jsd-solver.js";
import type { SpainCfSession } from "./spain-soax-solver.js";
import {
  syncSpainCfSessionToRedis,
  restoreSpainCfSessionFromRedis,
  applyStableGaProfile,
  type SerializableSpainCfSession,
} from "./spain-redis-persistence.js";
import { getCurrentDecodoUrl } from "./spain-decodo-pool.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/** cf_clearance valid ~2h → solve once per 115min (5min marge) */
const CF_CLEARANCE_TTL_MS = 115 * 60_000;

/** TTL session directe (sans CF challenge) */
const DIRECT_SESSION_TTL_MS = 90 * 60_000;

// ─── Module state ─────────────────────────────────────────────────────────────

let _activeImpitSession: SpainCfSession | null = null;
/** The impit instance that produced the active session — MUST be reused */
let _sessionImpit: InstanceType<typeof Impit> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getProxyUrl(): string | undefined {
  return getCurrentDecodoUrl() ?? process.env.SOAX_PROXY_URL ?? undefined;
}

function isCfChallengePage(html: string): boolean {
  return /just a moment|jetzt einen moment|verifying|_cf_chl_opt|challenge-platform/i.test(
    html.slice(0, 4000),
  );
}

/** Parse multiple Set-Cookie header values into name/value pairs */
function parseCookiesFromSetCookie(raw: string): Array<{ name: string; value: string }> {
  const result: Array<{ name: string; value: string }> = [];
  for (const part of raw.split(/,\s*(?=[A-Za-z_][^=]*=)/)) {
    const directive = part.trim();
    const eqIdx = directive.indexOf("=");
    if (eqIdx > 0) {
      const name  = directive.slice(0, eqIdx).trim();
      const value = directive.slice(eqIdx + 1).split(";")[0].trim();
      if (name && value && !["Path", "Domain", "SameSite", "Expires", "Max-Age", "HttpOnly", "Secure"].includes(name)) {
        result.push({ name, value });
      }
    }
  }
  return result;
}

/**
 * Extrait tous les cookies d'une Response impit.
 * impit peut renvoyer les cookies dans `set-cookie` ou via `getSetCookie()`.
 */
function extractCookiesFromResponse(res: Response): Array<{ name: string; value: string }> {
  const rawHeader = res.headers.get("set-cookie") ?? "";
  return parseCookiesFromSetCookie(rawHeader);
}

// ─── Core solver ──────────────────────────────────────────────────────────────

/**
 * Établit une session CF pour le portail Spain via impit (pas de CapSolver).
 *
 * @param targetUrl  URL du portail à débloquer (ex: https://www.citaconsular.es/...)
 * @param proxyUrl   URL proxy Decodo/SOAX (obligatoire en production — cf_clearance lié à l'IP)
 */
export async function solveViaImpit(
  targetUrl: string,
  proxyUrl?: string,
): Promise<SpainCfSession | null> {
  const t0 = Date.now();
  console.log(`[spain-impit] 🔧 Début solve impit pour ${new URL(targetUrl).hostname}`);
  if (proxyUrl) {
    const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`[spain-impit]    Proxy: ${masked.slice(0, 70)}…`);
  } else {
    console.log(`[spain-impit]    ⚠️  Pas de proxy — session directe (IP locale)`);
  }

  // ── Étape 1 : Probe GET portal ───────────────────────────────────────────────
  const probeImpit = new Impit({
    browser: "chrome",
    ...(proxyUrl ? { proxyUrl } : {}),
  } as any);

  let probeHtml = "";
  let probeOk = false;
  let phpSessionId = "";

  try {
    const probeRes = await (
      probeImpit.fetch(targetUrl, {
        headers: {
          "User-Agent": CHROME_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
      } as any) as unknown as Response
    );

    probeHtml = await probeRes.text();
    probeOk   = probeRes.status === 200;

    // Extraire PHPSESSID du probe si déjà présent
    const probeCookies = extractCookiesFromResponse(probeRes as Response);
    const phpCookie    = probeCookies.find((c) => c.name === "PHPSESSID");
    if (phpCookie) phpSessionId = phpCookie.value;

    console.log(
      `[spain-impit] Probe: HTTP ${probeRes.status} | ${probeHtml.length} chars | ` +
      `CF challenge: ${isCfChallengePage(probeHtml) ? "OUI" : "NON"} | ` +
      `PHPSESSID: ${phpSessionId ? "présent" : "absent"}`,
    );
  } catch (err) {
    console.error(`[spain-impit] ❌ Probe échoué: ${err}`);
    return null;
  }

  // ── Étape 2a : Pas de CF challenge → session directe ─────────────────────────
  if (probeOk && !isCfChallengePage(probeHtml)) {
    console.log(`[spain-impit] ✅ Pas de CF challenge — session directe établie`);
    const cookies: Array<{ name: string; value: string }> = [];
    if (phpSessionId) cookies.push({ name: "PHPSESSID", value: phpSessionId });

    const now = Date.now();
    const session: SpainCfSession = {
      cfClearance:  "",
      cfDomain:     `.${new URL(targetUrl).hostname}`,
      soaxProxyUrl: proxyUrl ?? "",
      userAgent:    CHROME_UA,
      createdAt:    now,
      expiresAt:    now + DIRECT_SESSION_TTL_MS,
      allCookies:   await applyStableGaProfile(cookies, now),
      extraHeaders: {},
      source:       "direct" as any,
    };

    _sessionImpit = probeImpit;
    return session;
  }

  // ── Étape 2b : CF challenge → JSDSolver ─────────────────────────────────────
  console.log(`[spain-impit] 🔐 CF challenge détecté — JSDSolver (impit)…`);

  const solver = new JSDSolver(targetUrl, CHROME_UA, proxyUrl);
  const solveResult = await solver.solve(40_000);

  if (!solveResult.success || !solveResult.session) {
    console.error(`[spain-impit] ❌ JSDSolver échoué: ${solveResult.error}`);
    return null;
  }

  const { cfClearance, cookies: cfCookies, impit: solverImpit } = solveResult.session;
  console.log(`[spain-impit] ✅ cf_clearance obtenu (${Math.round((Date.now() - t0) / 1000)}s)`);

  // ── Étape 3 : GET portal avec cf_clearance (même impit) → PHPSESSID ─────────
  // Le MÊME solverImpit qui a résolu le challenge est utilisé ici.
  // CF vérifie que la TLS session est cohérente avec celle qui a obtenu cf_clearance.
  let phpsessid = "";
  const allCookies: Array<{ name: string; value: string }> = [...cfCookies];

  try {
    const cookieHeader = `cf_clearance=${cfClearance}`;
    const clearRes = await (
      solverImpit.fetch(targetUrl, {
        headers: {
          "User-Agent": CHROME_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Cookie": cookieHeader,
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
      } as any) as unknown as Response
    );

    const clearBody = await clearRes.text();
    const clearCookies = extractCookiesFromResponse(clearRes as Response);

    // Merge cookies (cf_clearance + PHPSESSID + autres)
    for (const c of clearCookies) {
      if (!allCookies.find((x) => x.name === c.name)) {
        allCookies.push(c);
      }
    }

    const phpCookie = clearCookies.find((c) => c.name === "PHPSESSID");
    if (phpCookie) {
      phpsessid = phpCookie.value;
      console.log(`[spain-impit] ✅ PHPSESSID établi via impit (même TLS session)`);
    } else {
      console.warn(
        `[spain-impit] ⚠️ PHPSESSID absent après cf_clearance GET (${clearRes.status}, ${clearBody.length} chars)`,
      );
    }
  } catch (err) {
    console.warn(`[spain-impit] ⚠️ GET post-clearance échoué (non-fatal): ${err}`);
  }

  // ── Étape 4 : Construire SpainCfSession ──────────────────────────────────────
  const now = Date.now();
  const enrichedCookies = await applyStableGaProfile(allCookies, now);

  const session: SpainCfSession = {
    cfClearance,
    cfDomain:     `.${new URL(targetUrl).hostname}`,
    soaxProxyUrl: proxyUrl ?? "",
    userAgent:    CHROME_UA,
    createdAt:    now,
    expiresAt:    now + CF_CLEARANCE_TTL_MS,
    allCookies:   enrichedCookies,
    extraHeaders: {},
    source:       "capsolver" as any, // champ de compatibilité — remplacer par "impit" si le type est mis à jour
  };

  // Mémoriser l'instance impit pour les appels JSONP suivants
  _sessionImpit = solverImpit;
  _activeImpitSession = session;

  // Persister en Redis (même TTL que les autres sessions)
  syncSpainCfSessionToRedis(session as SerializableSpainCfSession);

  console.log(
    `[spain-impit] 🎉 Session impit établie en ${Math.round((Date.now() - t0) / 1000)}s` +
    ` | PHPSESSID: ${phpsessid ? "✅" : "⚠️ absent"} | Valide: ${Math.round(CF_CLEARANCE_TTL_MS / 60_000)}min`,
  );

  return session;
}

// ─── Session manager (compatible avec ensureSpainCfSession) ──────────────────

/**
 * Retourne l'instance impit qui a obtenu la session active.
 * DOIT être utilisée pour tous les appels JSONP (même TLS session que cf_clearance).
 */
export function getSpainImpitInstance(): InstanceType<typeof Impit> | null {
  return _sessionImpit;
}

/**
 * Obtient ou renouvelle la session CF via impit (sans CapSolver).
 * Utilisé quand SPAIN_SESSION_MODE=impit.
 *
 * Cache hiérarchique :
 *   1. Mémoire (session encore valide)
 *   2. Redis (session sérialisée d'un précédent run)
 *   3. Solve fresh via JSDSolver
 */
export async function ensureSpainImpitSession(
  targetUrl: string,
): Promise<SpainCfSession | null> {
  // 1. Mémoire
  if (_activeImpitSession && Date.now() < _activeImpitSession.expiresAt) {
    const remainMin = Math.round((_activeImpitSession.expiresAt - Date.now()) / 60_000);
    console.log(`[spain-impit] ♻️ Session impit réutilisée (reste ${remainMin}min)`);
    return _activeImpitSession;
  }

  // 2. Redis
  try {
    const restored = await restoreSpainCfSessionFromRedis();
    if (restored && Date.now() < (restored as SpainCfSession).expiresAt) {
      const s = restored as SpainCfSession;
      const remainMin = Math.round((s.expiresAt - Date.now()) / 60_000);
      console.log(`[spain-impit] ♻️ Session impit restaurée depuis Redis (reste ${remainMin}min)`);
      _activeImpitSession = s;
      // Recréer une instance impit avec le proxy de la session restaurée
      const pUrl = s.soaxProxyUrl || undefined;
      _sessionImpit = new Impit({ browser: "chrome", ...(pUrl ? { proxyUrl: pUrl } : {}) } as any);
      return s;
    }
  } catch { /* Redis non disponible — continuer */ }

  // 3. Fresh solve
  const proxyUrl = getProxyUrl();
  console.log(`[spain-impit] 🔄 Solve fresh — proxy: ${proxyUrl ? "configuré" : "⚠️ absent"}`);

  const session = await solveViaImpit(targetUrl, proxyUrl);
  if (session) {
    _activeImpitSession = session;
  }
  return session;
}

/** Invalide la session impit (ex: après un 403). */
export function invalidateSpainImpitSession(): void {
  _activeImpitSession = null;
  _sessionImpit = null;
  console.log(`[spain-impit] 🗑️ Session impit invalidée`);
}
