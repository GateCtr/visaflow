/**
 * spain-impit-session.ts — Session CF citaconsular.es entièrement via impit
 *
 * OBJECTIF : obtenir une session CF (cf_clearance + PHPSESSID) sans lancer Chromium.
 * Toutes les requêtes HTTP passent par impit (Chrome TLS JA3/JA4) → le cf_clearance
 * est lié au MÊME fingerprint TLS que les appels JSONP suivants.
 *
 * DEUX TYPES DE CHALLENGE CF :
 *   A. JSD (__CF$cv$params présent) → JSDSolver extrait les params + POST oneshot
 *   B. Managed Challenge (_cf_chl_opt / Turnstile) → solveManagedChallengeViaImpit()
 *      1. Extrait sitekey depuis l'URL du script challenges.cloudflare.com
 *      2. CapSolver AntiTurnstileTaskProxyLess → token Turnstile
 *      3. POST #challenge-form avec le token via impit → Set-Cookie cf_clearance
 *      CF lie le cf_clearance à NOTRE TLS impit (pas celui de CapSolver).
 *
 * FLOW :
 *   1. Probe GET portal via impit → type de challenge ?
 *   2a. Pas de challenge → session directe (PHPSESSID depuis Set-Cookie)
 *   2b. JSD → JSDSolver (même impit, HTML pré-fetchée)
 *   2c. Managed Challenge → solveManagedChallengeViaImpit()
 *   3. GET portal avec cf_clearance (même impit instance) → PHPSESSID dans Set-Cookie
 *   4. Retourner SpainCfSession (compatible avec spain-soax-solver.ts + spain-http-scanner.ts)
 *
 * RÈGLE CRITIQUE : le même `impit` qui a obtenu cf_clearance DOIT être utilisé pour tous
 * les appels JSONP suivants. Ne pas créer une nouvelle instance impit pour les scans.
 */

import { Impit } from "impit";
import { JSDSolver } from "./jsd-solver.js";
import { solveTurnstileToken } from "./capsolver-turnstile.js";
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
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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

/** True when the challenge is a CF Managed Challenge (Turnstile widget) */
function isManagedChallenge(html: string): boolean {
  return /_cf_chl_opt|challenges\.cloudflare\.com\/turnstile/i.test(html.slice(0, 8000));
}

/** True when the challenge is a plain JSD challenge (__CF$cv$params present) */
function isJsdChallenge(html: string): boolean {
  return /window\.__CF\$cv\$params/.test(html);
}

/** Decode HTML entities in attribute values (&amp; → &, &#x2F; → /, etc.) */
function htmlDecode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

/**
 * Extracts the Turnstile sitekey from a CF Managed Challenge HTML page.
 * Tries multiple strategies in order:
 *  1. Script src: challenges.cloudflare.com/turnstile/v0/g/{SITEKEY}/api.js
 *  2. data-sitekey attribute
 *  3. _cf_chl_opt.cH (sometimes carries the sitekey hash)
 */
function extractTurnstileSitekey(html: string): string | null {
  const m1 = html.match(/challenges\.cloudflare\.com\/turnstile\/v[\d]+\/[a-z]\/([a-f0-9]{8,32})\/api\.js/);
  if (m1) return m1[1];
  const m2 = html.match(/data-sitekey="([a-zA-Z0-9_\-]{8,64})"/);
  if (m2) return m2[1];
  const m3 = html.match(/["']cH["']\s*:\s*["']([a-f0-9]{8,32})["']/);
  if (m3) return m3[1];
  return null;
}

/**
 * Extracts the CF challenge form action URL and all hidden field values.
 * Handles attribute ordering variations and HTML-encoded values.
 */
function extractChallengeForm(html: string): {
  action: string;
  fields: Record<string, string>;
} | null {
  // Match <form id="challenge-form" ...> or <form ... id="challenge-form">
  const formMatch = html.match(/<form[^>]+id="challenge-form"[^>]*>/i) ??
                    html.match(/<form[^>]*id="challenge-form"[^>]*>/i);
  if (!formMatch) return null;

  const formTag = formMatch[0];
  const actionM = formTag.match(/\baction="([^"]*)"/i);
  if (!actionM) return null;

  const action = htmlDecode(actionM[1]);

  // Extract all hidden inputs inside the page (CF challenge form spans the whole body)
  const fields: Record<string, string> = {};
  const inputRe = /<input[^>]+type="hidden"[^>]*>/gi;
  let inputM: RegExpExecArray | null;
  while ((inputM = inputRe.exec(html)) !== null) {
    const tag = inputM[0];
    const nameM  = tag.match(/\bname="([^"]*)"/i);
    const valueM = tag.match(/\bvalue="([^"]*)"/i);
    if (nameM && valueM) {
      fields[nameM[1]] = htmlDecode(valueM[1]);
    }
  }

  return { action, fields };
}

/**
 * Solves a CF Managed Challenge (Turnstile) entirely via impit.
 *
 * Flow:
 *   1. Extract sitekey from HTML
 *   2. CapSolver AntiTurnstileTaskProxyLess → Turnstile token
 *   3. POST #challenge-form with token via the same impit instance
 *   4. CF returns Set-Cookie: cf_clearance bound to OUR impit TLS fingerprint
 *
 * Returns cf_clearance value, or null on failure.
 */
async function solveManagedChallengeViaImpit(
  html: string,
  targetUrl: string,
  impitInstance: InstanceType<typeof Impit>,
): Promise<string | null> {
  const t0 = Date.now();
  const baseUrl = `${new URL(targetUrl).protocol}//${new URL(targetUrl).hostname}`;

  // ── 1. Sitekey ─────────────────────────────────────────────────────────────
  const sitekey = extractTurnstileSitekey(html);
  if (!sitekey) {
    console.error(`[spain-impit] ❌ Managed Challenge: sitekey Turnstile introuvable dans le HTML`);
    console.warn(`[spain-impit]    HTML preview: ${html.slice(0, 400).replace(/\s+/g, " ")}`);
    return null;
  }
  console.log(`[spain-impit] 🔑 Managed Challenge sitekey: ${sitekey}`);

  // ── 2. CapSolver AntiTurnstileTaskProxyLess ────────────────────────────────
  const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.ANTICAPTCHA_API_KEY;
  if (!capsolverKey) {
    console.error(`[spain-impit] ❌ CAPSOLVER_API_KEY non définie — impossible de résoudre Managed Challenge`);
    return null;
  }

  console.log(`[spain-impit] 🤖 CapSolver AntiTurnstileTaskProxyLess pour ${targetUrl.slice(0, 60)}…`);
  const tokenResult = await solveTurnstileToken(
    targetUrl,
    sitekey,
    process.env.CAPSOLVER_API_KEY ?? capsolverKey,
    { action: "managed" },
  );
  if (!tokenResult) {
    console.error(`[spain-impit] ❌ Token Turnstile non obtenu depuis CapSolver`);
    return null;
  }
  console.log(`[spain-impit] ✅ Token Turnstile obtenu (${Math.round((Date.now() - t0) / 1000)}s)`);

  // ── 3. Extraire le formulaire CF ───────────────────────────────────────────
  const formData = extractChallengeForm(html);
  if (!formData) {
    console.error(`[spain-impit] ❌ Managed Challenge: #challenge-form introuvable dans le HTML`);
    return null;
  }
  console.log(`[spain-impit]    Form action: ${formData.action}`);
  console.log(`[spain-impit]    Hidden fields: ${Object.keys(formData.fields).join(", ")}`);

  // ── 4. POST solution via impit ─────────────────────────────────────────────
  // CF lies the cf_clearance to the TLS session that POSTs the solution.
  // By using the same impit instance that made the probe, we guarantee that
  // cf_clearance will be valid for all subsequent impit requests.
  const postUrl = formData.action.startsWith("http")
    ? formData.action
    : `${baseUrl}${formData.action}`;

  const body = new URLSearchParams(formData.fields);
  body.set("cf-turnstile-response", tokenResult.token);

  console.log(`[spain-impit] 📤 POST challenge solution → ${postUrl.slice(0, 80)}…`);

  let cfClearance: string | null = null;
  try {
    const postRes = await (impitInstance.fetch(postUrl, {
      method:  "POST",
      headers: {
        "User-Agent":   CHROME_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer":      targetUrl,
        "Origin":       baseUrl,
        "Accept":       "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
      body: body.toString(),
    } as any) as unknown as Response);

    const setCookie = postRes.headers.get("set-cookie") ?? "";
    const m = setCookie.match(/cf_clearance=([^;]+)/);
    if (m) {
      cfClearance = m[1];
      console.log(
        `[spain-impit] ✅ cf_clearance dans réponse POST (status=${postRes.status}) : ${cfClearance.slice(0, 40)}…`,
      );
    } else {
      console.warn(
        `[spain-impit] ⚠️ cf_clearance absent dans réponse POST (status=${postRes.status})`,
      );
      const body2 = await postRes.text();
      console.warn(`[spain-impit]    Réponse POST preview: ${body2.slice(0, 300).replace(/\s+/g, " ")}`);
    }
  } catch (err) {
    console.error(`[spain-impit] ❌ POST challenge échoué: ${err}`);
    return null;
  }

  return cfClearance;
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

  // ── Étape 2b : CF challenge → router selon le type ───────────────────────────
  // CF sert deux types de challenges :
  //   A. JSD (__CF$cv$params) → JSDSolver extrait les params + POST oneshot via impit
  //   B. Managed Challenge (_cf_chl_opt / Turnstile) → CapSolver token + POST form via impit
  // Dans les deux cas, le MÊME probeImpit est réutilisé pour que cf_clearance soit lié
  // à notre fingerprint TLS Chrome et non à celui de CapSolver.

  let cfClearance: string;
  let cfCookies: Array<{ name: string; value: string }> = [];
  const solverImpit = probeImpit; // always reuse the probe's TLS session

  if (isManagedChallenge(probeHtml)) {
    // ── Cas B : Managed Challenge (Turnstile) ────────────────────────────────
    console.log(`[spain-impit] 🛡️ Managed Challenge (Turnstile) détecté — solveManagedChallengeViaImpit…`);
    const clearance = await solveManagedChallengeViaImpit(probeHtml, targetUrl, probeImpit);
    if (!clearance) {
      console.error(`[spain-impit] ❌ solveManagedChallengeViaImpit échoué`);
      return null;
    }
    cfClearance = clearance;
    cfCookies   = [{ name: "cf_clearance", value: clearance }];
  } else if (isJsdChallenge(probeHtml)) {
    // ── Cas A : JSD challenge (__CF$cv$params) ───────────────────────────────
    // CRITICAL: pass probeImpit so JSDSolver reuses the SAME TLS session as the probe.
    // Also pass probeHtml to skip the redundant GET (challenge params already in hand).
    console.log(`[spain-impit] 🔐 JSD challenge (__CF$cv$params) détecté — JSDSolver (impit réutilisé, HTML pré-fetchée)…`);
    const solver = new JSDSolver(targetUrl, CHROME_UA, proxyUrl, probeImpit);
    const solveResult = await solver.solve(40_000, probeHtml);
    if (!solveResult.success || !solveResult.session) {
      console.error(`[spain-impit] ❌ JSDSolver échoué: ${solveResult.error}`);
      return null;
    }
    cfClearance = solveResult.session.cfClearance;
    cfCookies   = solveResult.session.cookies;
  } else {
    // Unknown challenge type — log HTML preview and bail
    console.error(
      `[spain-impit] ❌ Type de challenge CF inconnu — ni JSD ni Managed.\n` +
      `   Preview: ${probeHtml.slice(0, 400).replace(/\s+/g, " ")}`,
    );
    return null;
  }
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
