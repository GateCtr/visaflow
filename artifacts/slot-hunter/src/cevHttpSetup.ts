/**
 * cevHttpSetup.ts — Setup CEV session en HTTP pur (sans Playwright)
 *
 * Flux complet :
 *   1. Login VOWINT (ou réutiliser session existante)
 *   2. GET /Common/GetEAppointmentUrl?id={appId} → URL d'intégration CEV (= 1 clic VOWINT)
 *   3. GET {integrationUrl} → cookie ASP.NET_SessionId CEV
 *   4. Résoudre hCaptcha via Anti-Captcha
 *   5. POST /Captcha/SetCaptchaToken → validUntil + redirectUrl
 *   6. GET redirectUrl (follow redirects) → /Integration/VOW/SelectSlot → VERDICT FINAL
 *      → 200 calendrier = session activée, polling possible
 *      → 302 → NoAvailability = pas de créneaux
 *
 * Optimisation : les cookies VOWINT sont persistés en mémoire entre les checks.
 * On ne re-login que si la session VOWINT a expiré (401/302 vers login).
 * Seul le GetEAppointmentUrl compte comme "clic" (limite 5/heure).
 *
 * Coût : 1 hCaptcha (~$0.003) par check, ZERO Playwright
 */

import { botLog, getBotConfigValue } from "./convexClient.js";
import { cevImpitFetch, getCevBrowserHeaders, getCevSessionUa, rotateCevUaProfile, setCevExternalUserAgent, getCevProxyExitIp, getCevProxyUrl, shouldUseProxy } from "./cev-shared-impit.js";
import { lookup } from "node:dns/promises";
import {
  syncVowintSessionToRedis,
  restoreVowintSessionFromRedis,
  removeVowintSessionFromRedis,
} from "./cev-redis-persistence.js";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";

// ─── Clé Anti-Captcha : lecture DYNAMIQUE (pas de constante module-level) ────
// Problème résolu : si la clé n'est pas dans l'env au démarrage du bot (ex: git pull
// en cours de route, ou clé stockée dans botConfig Convex), le bot ne la voyait jamais.
// Solution : lecture depuis process.env à chaque appel + fallback getBotConfigValue.
let _anticaptchaKeyCache: string | null = null; // null = jamais chargé, "" = chargé mais vide, "key" = valide

export async function resolveAnticaptchaKey(): Promise<string> {
  // 1. Lire process.env dynamiquement (capte les changements post-démarrage)
  const envKey = process.env.ANTICAPTCHA_API_KEY?.trim() ?? "";
  if (envKey) {
    _anticaptchaKeyCache = envKey;
    return envKey;
  }
  // 2. Si déjà en cache mémoire (chargé depuis botConfig), l'utiliser
  if (_anticaptchaKeyCache) return _anticaptchaKeyCache;
  // 3. Fallback : lire depuis botConfig Convex (permet de configurer sans variable d'env)
  try {
    const botKey = await getBotConfigValue("anticaptcha_api_key");
    if (botKey?.trim()) {
      _anticaptchaKeyCache = botKey.trim();
      console.log(`[CEV-SETUP] ✅ ANTICAPTCHA_KEY chargé depuis botConfig Convex (longueur: ${_anticaptchaKeyCache.length})`);
      return _anticaptchaKeyCache;
    }
  } catch { /* graceful */ }
  _anticaptchaKeyCache = ""; // marquer "chargé, mais vide"
  return "";
}

/** Vide le cache de la clé Anti-Captcha — à appeler sur erreur anticaptcha_not_configured. */
export function invalidateAnticaptchaCache(): void {
  _anticaptchaKeyCache = null; // force une relecture env + botConfig au prochain scan
  console.log("[CEV-SETUP] 🔄 Cache clé Anti-Captcha invalidé — prochaine tentative relira env + botConfig");
}

const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY?.trim() ?? "";
const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim() ?? "";

/** Fetch CEV via impit partagé (setup + polling = même instance TLS → session stable) */
function cevSetupFetch(url: string, options: RequestInit): Promise<Response> {
  return cevImpitFetch(url, options, "[CEV-SETUP]");
}

// ─── Cache session VOWINT — DEUX COUCHES ─────────────────────────────────────
//
// COUCHE 1 : Auth cache (cookies + ua) — clé = email
//   On ne re-login que si la session HTTP VOWINT a expiré (302→login).
//   TOUS les dossiers du même compte partagent les mêmes cookies.
//
// COUCHE 2 : AppId cache — clé = "email|VOWINTREF"
//   Chaque dossier a son propre UUID (appId) résolu via MyList.
//   Cela évite que le même appId soit utilisé pour tous les dossiers.
//
// BUG FIX (2026-05-28) : Avant, le cache était clé=email uniquement et stockait
// un seul appId. En mode dossier pool, TOUS les dossiers utilisaient le même appId
// (celui résolu au premier login), causant des rate-limits fantômes sur les mauvais dossiers.

interface VowintAuthCache {
  cookies: string;
  ua: string;
  lastUsedAt: number;
}
const vowintAuthCache = new Map<string, VowintAuthCache>();

// AppId par dossier — clé = "email|VOWINTREF" (ex: "user@mail.com|VOWINT6085888")
const vowintAppIdCache = new Map<string, { appId: string; resolvedAt: number }>();

// Legacy compat: l'ancien cache est gardé pour les appels sans vowintAppUrl (mode non-pool)
interface VowintSessionCache {
  cookies: string;
  appId: string;
  ua: string;
  lastUsedAt: number;
}
const vowintSessionCache = new Map<string, VowintSessionCache>();

// Durée max avant de forcer un re-login préventif.
// La session VOWINT persiste plusieurs jours côté serveur.
// On ne force le re-login que si le serveur retourne 302→login (détecté dynamiquement
// via invalidateVowintCache()). Ce timeout 24h est un filet de sécurité ultime.
const VOWINT_SESSION_MAX_AGE_MS = 4 * 60 * 60_000; // 4h (sessions CEV expirent bien avant 24h)

// Durée max pour le cache appId (24h — les UUIDs ne changent pas)
const VOWINT_APPID_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

export interface CevHttpSetupResult {
  success: boolean;
  sessionCookie?: string;
  validUntilMs?: number;
  integrationUrl?: string;
  redirectUrl?: string;       // URL retournée par SetCaptchaToken
  slotsAvailable?: boolean;   // true si la page calendrier (SelectSlot) a été atteinte → polling OK
  needsPlaywrightNavigation?: boolean; // DEPRECATED: toujours false — le redirect est suivi en HTTP maintenant
  /** URL finale après suivi des redirects (SelectSlot direct) — à utiliser pour booking si slotsAvailable=true */
  selectSlotUrl?: string;
  /** HTML complet de la page SelectSlot capturé lors du setup — évite une 2ème requête (URL à usage unique) */
  selectSlotHtml?: string;
  /** Cookie string complet après la chaîne de redirects — inclut __RequestVerificationToken (anti-CSRF ASP.NET) */
  selectSlotCookies?: string;
  /**
   * true si le dossier a déjà un RDV confirmé (Overview ou Booked).
   * L'annulation est possible via cancelCevAppointment(overviewHtml, overviewCookies, overviewUrl).
   */
  isLimitReached?: boolean;
  /** HTML de la page Overview/Booked — contient le lien d'annulation */
  overviewHtml?: string;
  /** URL finale de la page Overview/Booked */
  overviewUrl?: string;
  /** Cookies complets après la chaîne de redirects — nécessaires pour le POST d'annulation */
  overviewCookies?: string;
  error?: string;
  /**
   * true si la redirectProbe a échoué (timeout, 503, 504, erreur réseau).
   * Permet au loop de distinguer "pas de slots" d'un échec transitoire
   * et de retenter immédiatement avec le dossier suivant.
   */
  probeError?: boolean;
  /**
   * État de la page Overview (quand un autre dossier du même type passeport a déjà un RDV).
   *   'new_appointment_available' — lien "Nouveau rendez-vous" détecté et suivi (Cas 1)
   *   'limit_reached'            — seul "Annuler" disponible, limite atteinte (Cas 2)
   */
  overviewState?: 'new_appointment_available' | 'limit_reached';
}

/**
 * Obtient une session VOWINT (login + appId) — cache à DEUX COUCHES.
 *
 * COUCHE 1 (auth) : cookies + ua par email — évite re-login inutile
 * COUCHE 2 (appId) : UUID par dossier (email+vowintRef) — résout le BON dossier
 *
 * BUG FIX (2026-05-28) : Avant, un seul appId était caché par email.
 * En mode pool, tous les dossiers utilisaient le même appId (le premier résolu).
 */
async function getVowintSession(
  vowintEmail: string,
  vowintPassword: string,
  clientId: string,
  vowintAppUrl?: string,
  ipSlotId?: string,
): Promise<{ success: true; cookies: string; appId: string; ua: string } | { success: false; error: string }> {

  // Fix TGT_TokenReuseIP : clé de cache = "email:ipSlotId" pour que chaque slot IP
  // ait sa propre ASP.NET_SessionId — empêche le WAF de corréler le même token sur N IPs.
  // Sans ipSlotId (appels legacy) : clé = email seul (comportement inchangé).
  const authCacheKey = ipSlotId ? `${vowintEmail}:${ipSlotId}` : vowintEmail;

  // ═══ COUCHE 1 : Obtenir cookies authentifiés (liés au slot IP si fourni) ═══
  let authCookies: string | null = null;
  let authUa: string | null = null;

  // Cache mémoire auth
  const cachedAuth = vowintAuthCache.get(authCacheKey);
  if (cachedAuth && (Date.now() - cachedAuth.lastUsedAt) < VOWINT_SESSION_MAX_AGE_MS) {
    authCookies = cachedAuth.cookies;
    authUa = cachedAuth.ua;
    cachedAuth.lastUsedAt = Date.now();
    if (ipSlotId) console.log(`[CEV-SETUP] 🔑 Cache auth HIT pour slot ${ipSlotId.slice(0, 20)}…`);
  }

  // Legacy cache (compat mode non-pool, uniquement si pas de slot)
  if (!authCookies && !ipSlotId) {
    const cachedLegacy = vowintSessionCache.get(vowintEmail);
    if (cachedLegacy && (Date.now() - cachedLegacy.lastUsedAt) < VOWINT_SESSION_MAX_AGE_MS) {
      authCookies = cachedLegacy.cookies;
      authUa = cachedLegacy.ua;
      cachedLegacy.lastUsedAt = Date.now();
    }
  }

  // Redis fallback (clé = authCacheKey pour isolation par slot)
  if (!authCookies) {
    const redisSession = await restoreVowintSessionFromRedis(authCacheKey);
    if (redisSession && (Date.now() - redisSession.lastUsedAt) < VOWINT_SESSION_MAX_AGE_MS) {
      authCookies = redisSession.cookies;
      authUa = redisSession.ua;
      vowintAuthCache.set(authCacheKey, { cookies: redisSession.cookies, ua: redisSession.ua, lastUsedAt: Date.now() });
      botLog({ applicationId: clientId, step: "cev_http_vowint_redis_hit", status: "ok" });
    }
  }

  // Pas de cookies → login complet
  if (!authCookies) {
    const ua = getCevSessionUa();
    rotateCevUaProfile();

    // 1. GET page login → CSRF token + cookies
    //
    // ⚠️ PIÈGE CRITIQUE : redirect:"follow" perd le Set-Cookie des réponses 302
    // intermédiaires. Le cookie F5 BIG-IP ASM (TS0110ceb4) est posé UNIQUEMENT
    // sur le 302 de GET /  → Location: /en. Avec redirect:"follow" ce cookie
    // disparaît et le bot envoie toutes les requêtes VOWINT sans lui.
    //
    // Fix : redirect:"manual" + suivi manuel des redirects, cookie-jar cumulatif.
    // Fix Burp 2026-06-26 : _culture=en-US présent dès le 1er GET / dans le vrai navigateur.
    // Un utilisateur ayant déjà visité le site a ce cookie persistent. L'initialiser ici
    // permet de reproduire ce comportement — le serveur le renvoie via Set-Cookie de toute façon.
    let vowintCookies = "_culture=en-US";
    let loginHtml = "";

    // Premier hop GET / — peut répondre 302 (TS0110ceb4 posé ici) ou directement 200
    const initRes = await cevSetupFetch(`${VOWINT_BASE}/`, {
      method: "GET",
      headers: getCevBrowserHeaders({ fetchSite: "none", cookie: vowintCookies }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    const initCookies = extractCookies(initRes);
    if (initCookies) vowintCookies = initCookies;

    if (initRes.status < 300) {
      // Rare : réponse directe 200
      loginHtml = await initRes.text();
    } else {
      // Suivre les redirects manuellement, accumuler tous les Set-Cookie
      let nextUrl = initRes.headers.get("location");
      for (let hop = 0; hop < 5 && nextUrl; hop++) {
        const fullUrl = nextUrl.startsWith("http") ? nextUrl : `${VOWINT_BASE}${nextUrl}`;
        const hopRes = await cevSetupFetch(fullUrl, {
          method: "GET",
          headers: getCevBrowserHeaders({
            referer: `${VOWINT_BASE}/`,
            ...(vowintCookies ? { cookie: vowintCookies } : {}),
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
        });
        vowintCookies = mergeCookies(vowintCookies, hopRes);
        if (hopRes.status < 300) {
          loginHtml = await hopRes.text();
          break;
        }
        nextUrl = hopRes.headers.get("location");
      }
    }

    if (!loginHtml) {
      return { success: false, error: "VOWINT_GET_FAILED_NO_LOGIN_PAGE" };
    }

    const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!tokenMatch) return { success: false, error: "CSRF_TOKEN_NOT_FOUND" };
    const csrfToken = tokenMatch[1];
    if (!vowintCookies) return { success: false, error: "VOWINT_COOKIES_NOT_FOUND" };

    // FIX E (HAR réel 2026-06-08) : extraire l'action du formulaire plutôt que hardcoder /en/Account/Login.
    // Le serveur redirige vers /fr/ quand _culture=fr-BE — la form action reflète la locale active.
    const formActionMatch = loginHtml.match(/action="([^"]*Account\/Login[^"]*)"/i);
    const loginPath = formActionMatch?.[1] ?? "/en/Account/Login";
    const loginUrl = loginPath.startsWith("http") ? loginPath : `${VOWINT_BASE}${loginPath}`;

    // Délai humain simulé : un vrai utilisateur prend 2-8 secondes pour taper ses identifiants.
    // Sans ce délai, le POST arrive ~100ms après le GET → signal bot évident pour F5 WAF.
    const loginTypingDelayMs = 2000 + Math.random() * 6000; // 2-8 secondes
    await new Promise(r => setTimeout(r, loginTypingDelayMs));

    // 2. POST login — Cache-Control: max-age=0 maintenant intégré dans isFormPost (getCevBrowserHeaders).
    //    sec-ch-ua* APRÈS User-Agent, Cookie AVANT Origin — ordre Chrome réel (HAR 2026-06-08).
    const loginRes = await cevSetupFetch(loginUrl, {
      method: "POST",
      headers: getCevBrowserHeaders({
        referer: `${VOWINT_BASE}/`,
        origin: VOWINT_BASE,
        contentType: "application/x-www-form-urlencoded",
        cookie: vowintCookies,
        isFormPost: true,
      }),
      body: new URLSearchParams({
        __RequestVerificationToken: csrfToken,
        UserName: vowintEmail,
        Password: vowintPassword,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (loginRes.status !== 302) {
      let bodyPreview = "";
      try { bodyPreview = (await loginRes.text()).slice(0, 400); } catch { /* ignore */ }
      const redirectLocation = loginRes.headers.get("location") ?? "(none)";
      console.error(`[CEV-SETUP] ❌ LOGIN VOWINT ÉCHOUÉ — status=${loginRes.status} redirect="${redirectLocation}" email="${vowintEmail.slice(0, 30)}…"`);
      console.error(`[CEV-SETUP] ❌ Body preview: ${bodyPreview.replace(/\s+/g, " ").slice(0, 300)}`);
      botLog({ applicationId: clientId, step: "cev_http_login_failed", status: "fail", data: { status: loginRes.status, redirect: redirectLocation, bodyPreview: bodyPreview.slice(0, 300), email: vowintEmail } });
      return { success: false, error: "CEV_VOWINT_SESSION_FAILED" };
    }

    // Suivre les redirections post-login — Cache-Control: max-age=0 via paramètre cacheControl
    // (position 4, après Accept-Language) — Chrome maintient ce header sur toute la chaîne de redirects.
    let cookies = mergeCookies(vowintCookies, loginRes);
    let redirectUrl = loginRes.headers.get("location");
    for (let i = 0; i < 5 && redirectUrl; i++) {
      const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${VOWINT_BASE}${redirectUrl}`;
      const r = await cevSetupFetch(fullUrl, {
        method: "GET",
        headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/`, cookie: cookies, cacheControl: "max-age=0" }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
      cookies = mergeCookies(cookies, r);
      if (r.status >= 300 && r.status < 400) { redirectUrl = r.headers.get("location"); }
      else break;
    }
    botLog({ applicationId: clientId, step: "cev_http_login_ok", status: "ok" });

    authCookies = cookies;
    authUa = ua;
    // Stocker dans le cache auth (clé = authCacheKey : isolée par slot IP si fourni)
    vowintAuthCache.set(authCacheKey, { cookies, ua, lastUsedAt: Date.now() });
    if (ipSlotId) console.log(`[CEV-SETUP] 🔐 Nouveau login VOWINT pour slot ${ipSlotId.slice(0, 20)}…`);
  }

  // ═══ COUCHE 2 : Résoudre l'appId pour le dossier SPÉCIFIQUE demandé ═══
  let appId: string | null = null;

  if (vowintAppUrl) {
    if (vowintAppUrl.includes("GetEAppointmentUrl")) {
      appId = vowintAppUrl.match(/id=([a-f0-9-]+)/i)?.[1] ?? null;
    } else if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(vowintAppUrl.trim())) {
      appId = vowintAppUrl.trim();
    } else if (/^VOWINT\d+$/i.test(vowintAppUrl.trim())) {
      // Mode Pool : résoudre via cache appId ou MyList
      const vowintRefNumber = vowintAppUrl.trim().toUpperCase();
      const appIdCacheKey = `${vowintEmail}|${vowintRefNumber}`;
      const cachedAppId = vowintAppIdCache.get(appIdCacheKey);
      if (cachedAppId && (Date.now() - cachedAppId.resolvedAt) < VOWINT_APPID_CACHE_MAX_AGE_MS) {
        appId = cachedAppId.appId;
        console.log(`[CEV-SETUP] AppId cache HIT: ${vowintRefNumber} → ${appId.slice(0, 8)}…`);
      } else {
        // Résoudre via MyList (ne consomme PAS de clic)
        console.log(`[CEV-SETUP] Résolution ${vowintRefNumber} via MyList...`);
        appId = await resolveVowintRefViaMyList(vowintRefNumber, authCookies!);
        if (appId) {
          vowintAppIdCache.set(appIdCacheKey, { appId, resolvedAt: Date.now() });
          console.log(`[CEV-SETUP] ✅ ${vowintRefNumber} résolu et caché → ${appId}`);
        }
      }
    }
  }

  // Fallback : pas de dossier spécifique ou résolution échouée → premier dossier
  if (!appId) {
    appId = await resolveFirstAppIdFromMyList(authCookies!);
  }

  if (!appId) {
    botLog({ applicationId: clientId, step: "cev_http_no_app_id", status: "fail" });
    return { success: false, error: "NO_APP_ID" };
  }

  botLog({ applicationId: clientId, step: "cev_http_app_id_found", status: "ok", data: { appId, dossier: vowintAppUrl ?? "default" } });

  // Mettre à jour les caches (clé = authCacheKey pour isolation par slot IP)
  vowintSessionCache.set(authCacheKey, { cookies: authCookies!, appId, ua: authUa!, lastUsedAt: Date.now() });
  syncVowintSessionToRedis(authCacheKey, { cookies: authCookies!, appId, ua: authUa!, lastUsedAt: Date.now() });

  return { success: true, cookies: authCookies!, appId, ua: authUa! };
}

/**
 * Résout un numéro VOWINT (ex: "VOWINT6085888") en UUID via l'API MyList.
 * Ne consomme PAS de clic GetEAppointmentUrl — c'est une simple lecture.
 */
async function resolveVowintRefViaMyList(vowintRefNumber: string, cookies: string): Promise<string | null> {
  // GET DataTables init — Burp Chrome 146 (2026-06-26) confirme l'absence de Cache-Control
  // et If-Modified-Since sur cet endpoint (contrairement à GetAllVisaStatusTypes qui les a).
  await cevSetupFetch(`${VOWINT_BASE}/VisaApplication/DataTables`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01" }),
    signal: AbortSignal.timeout(20_000),
  }).then(r => r.text()).catch(() => {});

  // GET GetAllVisaStatusTypes — Burp Chrome 146 confirme cet appel entre DataTables et MyList
  // (AngularJS $http — même ordre exact que le vrai navigateur)
  await cevSetupFetch(`${VOWINT_BASE}/Common/GetAllVisaStatusTypes`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/plain, */*", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.text()).catch(() => {});

  // GET MyList — length=50 pour voir tous les dossiers (AngularJS $http)
  const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=LName&columns%5B2%5D%5Bname%5D=LastName&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=St&columns%5B3%5D%5Bname%5D=Status&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=50&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const listRes = await cevSetupFetch(dtUrl, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!listRes.ok) return null;

  const text = await listRes.text();
  try {
    const data = JSON.parse(text) as { data?: Array<{ Id?: string; VOWId?: string }> };
    if (data.data) {
      const match = data.data.find(d => d.VOWId?.toUpperCase() === vowintRefNumber);
      if (match?.Id) return match.Id;
      console.log(`[CEV-SETUP] ⚠️ ${vowintRefNumber} non trouvé dans MyList (${data.data.length} dossiers). Disponibles: ${data.data.map(d => d.VOWId).join(', ')}`);
    }
  } catch { /* non-JSON */ }
  return null;
}

/**
 * Résout le premier appId disponible (mode non-pool / fallback).
 */
export async function resolveFirstAppIdFromMyList(cookies: string): Promise<string | null> {
  // GET IndexByUserId — FIX #5: redirect:"manual" + boucle cumulative pour ne perdre
  // aucun cookie de session ou F5 lors des sauts de redirection.
  let currentUrl = `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`;
  let currentCookies = cookies;
  let finalRes: Response | null = null;

  for (let i = 0; i < 6; i++) {
    const r = await cevSetupFetch(currentUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en`, cookie: currentCookies }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    currentCookies = mergeCookies(currentCookies, r);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) break;
      currentUrl = loc.startsWith("http") ? loc : `${VOWINT_BASE}${loc}`;
    } else {
      finalRes = r;
      break;
    }
  }

  if (finalRes?.ok) {
    const html = await finalRes.text();
    const m = html.match(/GetEAppointmentUrl\?id=([a-f0-9-]+)/i);
    if (m) return m[1];
  }

  // Fallback MyList — précédé de DataTables + GetAllVisaStatusTypes (Burp Chrome 146 2026-06-26)
  // DataTables n'a PAS Cache-Control ni If-Modified-Since (confirmé Burp Chrome 146).
  await cevSetupFetch(`${VOWINT_BASE}/VisaApplication/DataTables`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01" }),
    signal: AbortSignal.timeout(20_000),
  }).then(r => r.text()).catch(() => {});
  await cevSetupFetch(`${VOWINT_BASE}/Common/GetAllVisaStatusTypes`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/plain, */*", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.text()).catch(() => {});
  const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=LName&columns%5B2%5D%5Bname%5D=LastName&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=St&columns%5B3%5D%5Bname%5D=Status&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=10&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const listRes = await cevSetupFetch(dtUrl, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (listRes.ok) {
    const text = await listRes.text();
    try {
      const data = JSON.parse(text) as { data?: Array<{ Id?: string; VOWId?: string }> };
      const first = data.data?.find(d => d.Id || d.VOWId);
      if (first) return first.Id ?? first.VOWId ?? null;
    } catch {
      const m = text.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i);
      if (m) return m[0];
    }
  }
  return null;
}

/**
 * Résout TOUS les dossiers disponibles dans MyList.
 * Retourne un tableau de UUIDs (champ Id — utilisable directement comme vowintAppUrl).
 * Si un seul dossier → comportement identique à resolveFirstAppIdFromMyList.
 * length=100 dans la requête MyList pour capturer tous les dossiers même si > 10.
 * Ne consomme PAS de clic GetEAppointmentUrl.
 */
export async function resolveAllAppIdsFromMyList(cookies: string): Promise<string[]> {
  const results: string[] = [];

  // 1ère passe : scraper l'HTML de IndexByUserId pour tous les GetEAppointmentUrl?id=
  let currentUrl = `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`;
  let currentCookies = cookies;
  let finalRes: Response | null = null;

  for (let i = 0; i < 6; i++) {
    const r = await cevSetupFetch(currentUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en`, cookie: currentCookies }),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    currentCookies = mergeCookies(currentCookies, r);
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) break;
      currentUrl = loc.startsWith("http") ? loc : `${VOWINT_BASE}${loc}`;
    } else {
      finalRes = r;
      break;
    }
  }

  if (finalRes?.ok) {
    const html = await finalRes.text();
    const allMatches = [...html.matchAll(/GetEAppointmentUrl\?id=([a-f0-9-]+)/gi)];
    for (const m of allMatches) {
      if (!results.includes(m[1])) results.push(m[1]);
    }
  }

  if (results.length > 0) return results;

  // Fallback : API MyList avec length=100 (Burp Chrome 146 — DataTables + GetAllVisaStatusTypes d'abord)
  await cevSetupFetch(`${VOWINT_BASE}/VisaApplication/DataTables`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01" }),
    signal: AbortSignal.timeout(20_000),
  }).then(r => r.text()).catch(() => {});
  await cevSetupFetch(`${VOWINT_BASE}/Common/GetAllVisaStatusTypes`, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/plain, */*", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.text()).catch(() => {});

  const allUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B2%5D%5Bdata%5D=LName&columns%5B2%5D%5Bname%5D=LastName&columns%5B2%5D%5Bsearchable%5D=true&columns%5B2%5D%5Borderable%5D=true&columns%5B2%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B2%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B3%5D%5Bdata%5D=St&columns%5B3%5D%5Bname%5D=Status&columns%5B3%5D%5Bsearchable%5D=true&columns%5B3%5D%5Borderable%5D=true&columns%5B3%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B3%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=100&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const listRes2 = await cevSetupFetch(allUrl, {
    method: "GET",
    headers: getCevBrowserHeaders({ referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`, cookie: cookies, xRequestedWith: true, accept: "application/json, text/javascript, */*; q=0.01", cacheControl: "max-age=0", ifModifiedSince: "0" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (listRes2.ok) {
    const text = await listRes2.text();
    try {
      const data = JSON.parse(text) as { data?: Array<{ Id?: string; VOWId?: string }> };
      for (const item of data.data ?? []) {
        const ref = item.Id ?? item.VOWId;
        if (ref && !results.includes(ref)) results.push(ref);
      }
    } catch {
      const allUuids = [...text.matchAll(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gi)];
      for (const m of allUuids) {
        if (!results.includes(m[0])) results.push(m[0]);
      }
    }
  }
  return results;
}

/**
 * Invalide le cache VOWINT pour un email — et optionnellement pour un slot IP précis.
 *
 * Fix TGT_TokenReuseIP : chaque slot IP a sa propre entrée de cache sous la clé
 * `${email}:${ipSlotId}`. Sans ipSlotId, on invalide le cache "global" (clé=email)
 * ET toutes les clés `email:*` (tous les slots).
 */
export function invalidateVowintCache(vowintEmail: string, ipSlotId?: string): void {
  if (ipSlotId) {
    const slotKey = `${vowintEmail}:${ipSlotId}`;
    vowintSessionCache.delete(slotKey);
    vowintAuthCache.delete(slotKey);
    removeVowintSessionFromRedis(slotKey);
    console.log(`[CEV-SETUP] 🔄 Cache VOWINT invalidé pour slot ${ipSlotId.slice(0, 20)}…`);
  } else {
    // Invalider clé globale (email seul) ET toutes les clés slot (email:*)
    vowintSessionCache.delete(vowintEmail);
    vowintAuthCache.delete(vowintEmail);
    for (const key of vowintSessionCache.keys()) {
      if (key.startsWith(`${vowintEmail}:`)) vowintSessionCache.delete(key);
    }
    for (const key of vowintAuthCache.keys()) {
      if (key.startsWith(`${vowintEmail}:`)) vowintAuthCache.delete(key);
    }
    removeVowintSessionFromRedis(vowintEmail);
  }
  // Invalider tous les appId cachés pour cet email (indépendant du slot)
  for (const key of vowintAppIdCache.keys()) {
    if (key.startsWith(`${vowintEmail}|`)) {
      vowintAppIdCache.delete(key);
    }
  }
}

/**
 * Setup complet d'une session CEV en HTTP pur.
 *
 * @param ipSlotId - Identifiant du slot IP (ex: ipSlot.sessionId depuis cev-stealth-loop).
 *   Quand fourni, la session VOWINT est isolée par slot : chaque IP du pool obtient son
 *   propre ASP.NET_SessionId, ce qui neutralise la règle WAF TGT_ML_TokenReuseIP_High
 *   (même token vu depuis N IPs différentes).
 */
export async function setupCevSessionHttp(
  vowintEmail: string,
  vowintPassword: string,
  _applicationId: string,
  clientId: string,
  vowintAppUrl?: string,
  siphoned?: {
    f5CookieValue?: string;
    f5CookieName?: string;
    aspNetSessionId?: string;
    userAgent?: string;
    validUntil?: number;
  },
  ipSlotId?: string,
  /** Token hCaptcha pré-résolu — bypasse solveHcaptcha() entièrement (utile pour les tests) */
  presolvedHcaptchaToken?: string,
): Promise<CevHttpSetupResult> {
  try {
    botLog({ applicationId: clientId, step: "cev_http_setup_start", status: "ok" });
    
    // ✅ Log détaillé des cookies siphonnés (pour vérifier en production)
    if (siphoned) {
      botLog({
        applicationId: clientId,
        step: "cev_http_siphoned_details",
        status: "ok",
        data: {
          hasF5Cookie: !!siphoned.f5CookieValue,
          f5CookieName: siphoned.f5CookieName,
          hasAspNetCookie: !!siphoned.aspNetSessionId,
          hasUserAgent: !!siphoned.userAgent,
          userAgentPreview: siphoned.userAgent ? siphoned.userAgent.slice(0, 60) + "…" : undefined,
          validUntil: siphoned.validUntil,
        },
      });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 1 : Obtenir session VOWINT (login ou cache isolé par slot IP)
    // ══════════════════════════════════════════════════════════════════════════
    const vowintSession = await getVowintSession(vowintEmail, vowintPassword, clientId, vowintAppUrl, ipSlotId);
    if (!vowintSession.success) {
      return { success: false, error: vowintSession.error };
    }

    const { cookies: postLoginCookies, appId: vowintAppId, ua: defaultUa } = vowintSession;
    const ua = siphoned?.userAgent ?? defaultUa;
    if (siphoned?.userAgent) {
      setCevExternalUserAgent(siphoned.userAgent);
    }

    // ── Telemetry OutSystems LogRenderingClientTime ─────────────────────────
    // Le framework JS OutSystems envoie ce POST automatiquement après rendu de page.
    // En mode HTTP pur (sans navigateur réel), il faut l'émuler — son absence est
    // un signal bot détectable par le WAF F5.
    // Source HAR réel 2026-06-09: POST /Common/LogRenderingClientTime?actionName=getVisaApplication&time=334
    // Fire-and-forget : non bloquant, erreur ignorée (dégrad gracieux).
    void (async () => {
      try {
        // Log-normal centré ~380ms (plage réaliste 120-1100ms — app AngularJS + réseau BE)
        const _u1 = Math.random(), _u2 = Math.random();
        const _z = Math.sqrt(-2 * Math.log(_u1 + 1e-10)) * Math.cos(2 * Math.PI * _u2);
        const renderTimeMs = Math.max(120, Math.min(1100, Math.round(Math.exp(5.94 + 0.38 * _z))));
        const telemetryUrl = `${VOWINT_BASE}/Common/LogRenderingClientTime?actionName=getVisaApplication&time=${renderTimeMs}`;
        await cevImpitFetch(telemetryUrl, {
          method: "POST",
          headers: getCevBrowserHeaders({
            referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
            cookie: postLoginCookies,
            xRequestedWith: true,
            accept: "*/*",
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(8_000),
        });
        console.log(`[CEV-TELEMETRY] LogRenderingClientTime: time=${renderTimeMs}ms`);
      } catch { /* non-critique — ignorer silencieusement */ }
    })();

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 2 : GET /Common/GetEAppointmentUrl → URL d'intégration CEV
    //           (= 1 clic VOWINT comptabilisé, limite 5/heure)
    // ══════════════════════════════════════════════════════════════════════════

    // Délai "lecture de liste" : un utilisateur réel prend 1-4 secondes pour
    // repérer son dossier dans la liste MyList avant de cliquer sur "Get Appointment".
    // Sans ce délai, MyList → GetEAppointmentUrl arrive en ~0ms — signal bot détectable
    // par les systèmes d'analyse comportementale (F5 WAF, OutSystems APM).
    const listReadDelayMs = 1000 + Math.random() * 3000; // 1-4 secondes
    await new Promise(r => setTimeout(r, listReadDelayMs));

    // Appeler GetEAppointmentUrl avec l'appId
    const eAppointmentUrl = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${vowintAppId}`;
    let integrationUrl: string | null = null;

    if (eAppointmentUrl.includes("GetEAppointmentUrl")) {
      // HAR réel (2026-06-08T17-14-59) : AngularJS $http envoie 3 headers absents dans la version précédente :
      //   1. Accept: "application/json, text/plain, */*"  (pas "text/html" — défaut AngularJS)
      //   2. Cache-Control: max-age=0                      ($http désactive le cache navigateur, position 4)
      //   3. If-Modified-Since: 0                          ($http anti-304 cache IE, position après Cookie)
      // cacheControl + ifModifiedSince injectés aux bonnes positions par getCevBrowserHeaders (isAjax branch).
      const eRes = await cevSetupFetch(eAppointmentUrl, {
        method: "GET",
        headers: getCevBrowserHeaders({
          referer: `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
          cookie: postLoginCookies,
          xRequestedWith: true,
          accept: "application/json, text/plain, */*",
          cacheControl: "max-age=0",
          ifModifiedSince: "0",
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      if (eRes.ok) {
        const eText = await eRes.text();

        // ── Détection rate-limit VOWINT dans la réponse GetEAppointmentUrl ──
        // Quand les 5 clics/heure sont épuisés, VOWINT peut retourner :
        //   - Un HTML/texte contenant des messages d'erreur au lieu de l'URL
        //   - Un JSON avec un champ erreur type "ErrorTooManyAttempts"
        const rateLimitPatterns = [
          /5\s*fois/i, /5\s*times/i, /bloqu[ée]\s*pendant/i, /blocked\s*for/i,
          /too\s*many\s*attempts/i, /ErrorTooManyAttempts/i, /rate.?limit/i,
          /maximum.*tentatives/i, /maximum.*attempts/i,
          /veuillez\s*r[ée]essayer/i, /please\s*try\s*again\s*later/i,
        ];
        const isRateLimited = rateLimitPatterns.some(p => p.test(eText));
        if (isRateLimited) {
          // On ne vide plus le cache VOWINT global ici car la session reste valide pour les autres dossiers du pool.
          botLog({ applicationId: clientId, step: "cev_http_rate_limit_detected", status: "warn", data: { responsePreview: eText.slice(0, 300) } });
          return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
        }

        // La réponse peut être :
        //  - JSON : {"url": "https://appointment.cloud.diplomatie.be/Integration/VOW/..."}
        //  - Texte brut : "https://appointment.cloud.diplomatie.be/Integration/VOW/..."
        //  - JSON string : "\"https://appointment.cloud.diplomatie.be/Integration/VOW/...\""
        try {
          const eData = JSON.parse(eText) as { url?: string; error?: string } | string;
          // Vérifier aussi un éventuel champ "error" dans le JSON
          if (typeof eData === "object" && eData?.error) {
            const errStr = eData.error;
            if (rateLimitPatterns.some(p => p.test(errStr))) {
              // Idem, pas d'invalidation
              botLog({ applicationId: clientId, step: "cev_http_rate_limit_json", status: "warn", data: { error: errStr } });
              return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
            }
          }
          if (typeof eData === "string" && eData.includes("/Integration/VOW/")) {
            integrationUrl = eData;
          } else if (typeof eData === "object" && eData?.url) {
            integrationUrl = eData.url;
          }
        } catch {
          // Pas du JSON — vérifier si c'est une URL brute
          if (eText.includes("/Integration/VOW/")) {
            integrationUrl = eText.trim().replace(/^"|"$/g, "");
          }
        }
        // Burp Chrome 146 (2026-06-26) : le vrai navigateur NE remplace PAS /en-US par /fr-BE.
        // VOWINT retourne toujours /en-US pour ce compte (_culture=en-US) et le serveur CEV
        // pose PreferredCulture=en-US via Set-Cookie sur le GET Integration/VOW — cohérent.
        // Le remplacement /fr-BE était erroné : Accept-Language fr-BE et culture URL en-US
        // coexistent normalement chez les vrais utilisateurs belges francophones.
      } else if (eRes.status === 429) {
        // HTTP 429 explicite = rate-limit sur ce dossier/requête (pas d'invalidation session globale)
        botLog({ applicationId: clientId, step: "cev_http_rate_limit_429", status: "warn", data: { status: eRes.status } });
        return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS" };
      }

      // Fallback: check redirect location
      if (!integrationUrl && eRes.status >= 300 && eRes.status < 400) {
        const loc = eRes.headers.get("location");
        if (loc?.includes("/Integration/VOW/")) {
          integrationUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
        }
        // Vérifier si la redirection pointe vers une page d'erreur/login (= session expirée ou rate-limit)
        if (!integrationUrl && loc) {
          const locLower = loc.toLowerCase();
          if (locLower.includes("error") || locLower.includes("login") || locLower.includes("account")) {
            if (locLower.includes("toomanyattempts")) {
              // C'est un rate limit sur le dossier, la session VOWINT reste valide
              botLog({ applicationId: clientId, step: "cev_http_redirect_rate_limit", status: "warn", data: { redirectTo: loc } });
              return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS_REDIRECT" };
            }
            invalidateVowintCache(vowintEmail, ipSlotId);
            botLog({ applicationId: clientId, step: "cev_http_redirect_error", status: "warn", data: { redirectTo: loc } });
            return { success: false, error: "RATE_LIMIT_VOWINT_5_CLICKS_REDIRECT" };
          }
        }
      }
    } else {
      // URL directe fournie — l'utiliser telle quelle
      integrationUrl = eAppointmentUrl;
    }

    if (!integrationUrl) {
      // Si GetEAppointmentUrl a échoué, la session VOWINT est peut-être expirée → invalider le cache du slot
      invalidateVowintCache(vowintEmail, ipSlotId);
      botLog({ applicationId: clientId, step: "cev_http_no_integration_url", status: "fail" });
      return { success: false, error: "NO_INTEGRATION_URL" };
    }

    botLog({ applicationId: clientId, step: "cev_http_integration_url", status: "ok", data: { url: integrationUrl.slice(0, 100) } });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 4 : GET integrationUrl → cookie ASP.NET_SessionId CEV (ou utiliser siphonné)
    // ══════════════════════════════════════════════════════════════════════════
    let cevSessionCookie: string | null = null;
    // rqdata hCaptcha enterprise extrait de la page /Captcha (scope ici pour être accessible après le if/else)
    let captchaPageRqdata: string | undefined;

    // Utiliser le cookie ASP.NET siphonné si disponible
    if (siphoned?.aspNetSessionId) {
      cevSessionCookie = siphoned.aspNetSessionId;
      botLog({ applicationId: clientId, step: "cev_http_using_siphoned_asp_net", status: "ok" });
    } else {
      // VOWINT → CEV : visaonweb.diplomatie.be → appointment.cloud.diplomatie.be
      // même eTLD+1 (diplomatie.be), sous-domaines différents → Sec-Fetch-Site: same-site
      // HAR réel (2026-06-08) confirme : "sec-fetch-site": "same-site" sur ce saut.
      //
      // Burp Chrome 146 (2026-06-26) : le vrai navigateur envoie déjà Cookie: PreferredCulture=en-US
      // sur ce premier GET (cookie persistant de visites antérieures) + pas d'ASP.NET_SessionId encore.
      const cevRes = await cevSetupFetch(integrationUrl, {
        method: "GET",
        headers: getCevBrowserHeaders({
          referer: `${VOWINT_BASE}/`,
          fetchSite: "same-site",
          cookie: "PreferredCulture=en-US",
          userAgent: siphoned?.userAgent,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      // Extraire ASP.NET_SessionId ET PreferredCulture depuis les Set-Cookie de la réponse.
      // Burp confirme : le serveur pose les deux cookies simultanément sur ce 302.
      let capturedCulture = "en-US"; // valeur par défaut cohérente avec le cookie initial
      const cevSetCookies = cevRes.headers.getSetCookie?.() ?? [];
      for (const c of cevSetCookies) {
        const mSession = c.match(/ASP\.NET_SessionId=([^;]+)/);
        if (mSession) cevSessionCookie = mSession[1];
        const mCulture = c.match(/PreferredCulture=([^;]+)/);
        if (mCulture) capturedCulture = mCulture[1];
      }
      // Fallback raw header
      if (!cevSessionCookie) {
        const raw = cevRes.headers.get("set-cookie") ?? "";
        const mS = raw.match(/ASP\.NET_SessionId=([^;]+)/);
        if (mS) cevSessionCookie = mS[1];
        const mC = raw.match(/PreferredCulture=([^;]+)/);
        if (mC) capturedCulture = mC[1];
      }

      if (!cevSessionCookie) {
        botLog({ applicationId: clientId, step: "cev_http_no_cev_cookie", status: "fail", data: { status: cevRes.status } });
        return { success: false, error: "NO_CEV_SESSION_COOKIE" };
      }

      // ── GET /Captcha (étape manquante — Burp Chrome 146 2026-06-26) ──────────
      // Le vrai navigateur est redirigé vers /Captcha après Integration/VOW, et charge
      // cette page avant de soumettre SetCaptchaToken. Son absence serait détectable
      // par le serveur (pas de requête /Captcha → SetCaptchaToken direct = pattern bot).
      // On simule ce GET avec les deux cookies déjà acquis.
      // IMPORTANT : on LIT le HTML pour extraire l'eventuel rqdata hCaptcha enterprise.
      // Sans rqdata, Anti-Captcha resout un challenge generique que CEV rejette (captchaSolved:false).
      const captchaPageCookie = `PreferredCulture=${capturedCulture}; ASP.NET_SessionId=${cevSessionCookie}`;
      try {
        const captchaPageRes = await cevSetupFetch(`${CEV_BASE}/Captcha`, {
          method: "GET",
          headers: getCevBrowserHeaders({
            fetchSite: "same-site",
            cookie: captchaPageCookie,
            userAgent: siphoned?.userAgent,
          }),
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        const captchaPageHtml = await captchaPageRes.text().catch(() => "");
        // Extraire rqdata depuis le HTML de la page captcha.
        // Patterns couverts (du plus spécifique au plus large) :
        //   <div ... data-rqdata="VALUE" ...>         attribut HTML standard hCaptcha
        //   data-rq-data="VALUE"                      variante avec tiret
        //   rqdata: "VALUE"  /  "rqdata":"VALUE"      objet JS inline
        //   var rqdata = "VALUE"                      variable JS
        //   "rqdata","VALUE"  /  rqdata=VALUE          formats OutSystems minifiés
        //   enterpriseRqdata / enterprise_rqdata       alias entreprise alternatifs
        const rqdataPatterns = [
          /data-rqdata=["']([^"']+)["']/i,
          /data-rq-data=["']([^"']+)["']/i,
          /["']rqdata["']\s*:\s*["']([^"']+)["']/i,
          /rqdata\s*:\s*["']([^"']+)["']/i,
          /var\s+rqdata\s*=\s*["']([^"']+)["']/i,
          /rqdata=["']([^"'&]+)["']/i,
          /["']rqdata["'],["']([^"']+)["']/i,
          /enterpriseRqdata["']?\s*:\s*["']([^"']+)["']/i,
          /enterprise_rqdata["']?\s*:\s*["']([^"']+)["']/i,
        ];
        let extractedRqdata: string | undefined;
        for (const pat of rqdataPatterns) {
          const m = captchaPageHtml.match(pat);
          if (m?.[1]) { extractedRqdata = m[1]; break; }
        }
        captchaPageRqdata = extractedRqdata;

        // Diagnostic : extraire un snippet autour de "rqdata" pour débogage si non trouvé
        let rqdataContext: string | null = null;
        if (!extractedRqdata) {
          const rqdataIdx = captchaPageHtml.toLowerCase().indexOf("rqdata");
          if (rqdataIdx !== -1) {
            rqdataContext = captchaPageHtml.slice(Math.max(0, rqdataIdx - 30), rqdataIdx + 120);
          }
        }

        // Extraire le sitekey depuis le HTML (pour vérifier qu'il correspond à HCAPTCHA_SITEKEY)
        const pageSitekeyMatch = captchaPageHtml.match(/data-sitekey=["']([^"']+)["']/i);
        const pageSitekey = pageSitekeyMatch?.[1] ?? null;

        botLog({
          applicationId: clientId,
          step: "cev_http_captcha_page_fetch",
          status: "ok",
          data: {
            htmlLen: captchaPageHtml.length,
            rqdataFound: !!extractedRqdata,
            rqdataPreview: extractedRqdata ? extractedRqdata.slice(0, 40) : null,
            // Snippet autour de "rqdata" dans le HTML si non trouvé par regex
            rqdataContext: rqdataContext,
            // Sitekey extrait de la page (cross-check avec HCAPTCHA_SITEKEY du code)
            pageSitekey,
            codeHcaptchaSitekey: HCAPTCHA_SITEKEY,
            sitekeyMatch: pageSitekey === HCAPTCHA_SITEKEY,
            // Corps de la page (début + fin) pour voir la structure du widget hCaptcha
            htmlHead: captchaPageHtml.slice(0, 400),
            htmlBody: captchaPageHtml.slice(400, 1200),
          },
        });
      } catch (captchaPageErr) {
        // Non-bloquant : on continue sans rqdata (pire cas : CEV rejette le token)
        botLog({ applicationId: clientId, step: "cev_http_captcha_page_fetch", status: "fail", data: { error: String(captchaPageErr) } });
      }
    }

    // Construire le cookie header complet, avec F5 si disponible.
    // Burp Chrome 146 (2026-06-26) : ordre réel = PreferredCulture AVANT ASP.NET_SessionId
    // (le navigateur envoie les cookies dans l'ordre d'insertion dans son jar).
    // Valeur PreferredCulture = ce que le serveur a posé (en-US si URL /en-US, fr-BE si /fr-BE).
    const capturedCultureFinal = (() => {
      // Si cevSessionCookie a été extrait normalement, utiliser la culture capturée.
      // Si siphoned (session pré-existante), conserver en-US par défaut.
      return "en-US"; // toujours en-US — VOWINT account utilise _culture=en-US
    })();
    let fullCevCookie = `PreferredCulture=${capturedCultureFinal}; ASP.NET_SessionId=${cevSessionCookie}`;
    if (siphoned?.f5CookieValue && siphoned?.f5CookieName) {
      fullCevCookie = `${siphoned.f5CookieName}=${siphoned.f5CookieValue}; ${fullCevCookie}`;
    }
    botLog({ applicationId: clientId, step: "cev_http_cev_cookie_ok", status: "ok", data: { cookieLen: cevSessionCookie!.length, usingSiphoned: !!siphoned } });

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 5 : Résoudre hCaptcha (ou utiliser token pré-résolu)
    // ══════════════════════════════════════════════════════════════════════════
    let hcaptchaToken: string | null = null;
    if (presolvedHcaptchaToken) {
      hcaptchaToken = presolvedHcaptchaToken;
      console.log(`[CEV-SETUP] ⚡ Token hCaptcha pré-résolu injecté (bypass solveHcaptcha) — len=${hcaptchaToken.length}`);
      botLog({ applicationId: clientId, step: "cev_http_hcaptcha_presolved", status: "ok", data: { tokenLen: hcaptchaToken.length } });
    } else {
      try {
        hcaptchaToken = await solveHcaptcha(clientId, captchaPageRqdata);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 🔥 DÉTECTION SPÉCIALE : ERREUR PROXY CONNECT REFUSED → ROTATION REQUISE
        if (msg.includes("PROXY_CONNECT_REFUSED_NEEDS_ROTATION")) {
          botLog({ 
            applicationId: clientId, 
            step: "cev_http_proxy_connect_refused", 
            status: "fail", 
            data: { 
              error: msg,
              recommendation: "ROTATE_PROXY_IMMEDIATELY"
            } 
          });
          return { success: false, error: "PROXY_CONNECT_REFUSED_NEEDS_ROTATION" };
        }
        // Autre erreur
        botLog({ applicationId: clientId, step: "cev_http_hcaptcha_exception", status: "fail", data: { error: msg } });
        return { success: false, error: "HCAPTCHA_FAILED" };
      }
      
      if (!hcaptchaToken) {
        return { success: false, error: "HCAPTCHA_FAILED" };
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 6 : POST /Captcha/SetCaptchaToken → validUntil
    // ══════════════════════════════════════════════════════════════════════════
    // HAR réel (2026-06-08) : Accept=* /* (pas la valeur jQuery dataType:"json") — pas de Referer
    const captchaRes = await cevSetupFetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: "POST",
      headers: getCevBrowserHeaders({
        origin: CEV_BASE,
        cookie: fullCevCookie,
        contentType: "application/x-www-form-urlencoded",
        xRequestedWith: true,
      }),
      body: new URLSearchParams({ captcha: hcaptchaToken }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });

    if (!captchaRes.ok) {
      botLog({ applicationId: clientId, step: "cev_http_captcha_submit_failed", status: "fail", data: { status: captchaRes.status } });
      return { success: false, error: `CAPTCHA_SUBMIT_${captchaRes.status}` };
    }

    // FIX OSOnline : capturer tout Set-Cookie posé par le serveur OutSystems lors de la
    // validation du captcha (le cookie OSOnline arrive ici, avant la chaîne de redirects).
    fullCevCookie = mergeCookies(fullCevCookie, captchaRes);

    const captchaData = await captchaRes.json() as { validUntil?: string; redirectUrl?: string; captchaSolved?: boolean };

    // FIX #4: Le serveur peut renvoyer HTTP 200 avec captchaSolved:false — vérifier explicitement.
    if (captchaData.captchaSolved === false) {
      botLog({ applicationId: clientId, step: "cev_http_captcha_rejected", status: "fail", data: { fullResponse: JSON.stringify(captchaData) } });
      // Invalider le cache VOWINT pour forcer une nouvelle session ASP.NET complète au prochain essai.
      // Raison : le token hCaptcha est lié à la session serveur — réessayer sur la même
      // session produit le même rejet. Une session fraîche = nouveau captcha challenge = nouveau token.
      invalidateVowintCache(vowintEmail, ipSlotId);
      return { success: false, error: "HCAPTCHA_REJECTED_BY_SERVER" };
    }
    
    // DEBUG: Loguer la réponse brute pour comprendre le format du validUntil
    botLog({
      applicationId: clientId,
      step: "cev_http_captcha_response",
      status: "ok",
      data: {
        validUntilRaw: captchaData.validUntil,
        redirectUrlRaw: captchaData.redirectUrl,
        now: new Date().toISOString(),
        nowLocal: new Date().toString(),
        fullResponse: JSON.stringify(captchaData),
      },
    });
    
    if (!captchaData.validUntil) {
      // RETRY: Si validUntil absent, résoudre un NOUVEAU captcha et réessayer
      botLog({
        applicationId: clientId,
        step: "cev_http_captcha_no_valid_until_retry",
        status: "warn",
        data: { message: "validUntil absent - résolution nouveau captcha pour retry" },
      });
      
      // Invalider le cache Anti-Captcha pour forcer une nouvelle résolution
      invalidateAnticaptchaCache();
      
      // Attendre 20s avant de résoudre le nouveau captcha — laisser CEV se désencombrer
      // (validUntil absent = timeout backend, même cause que captchaSolved:false)
      await new Promise(r => setTimeout(r, 20_000));
      
      // Résoudre un NOUVEAU captcha
      botLog({
        applicationId: clientId,
        step: "cev_http_captcha_retry_solve",
        status: "ok",
        data: { message: "Résolution nouveau captcha pour retry" },
      });
      
      const retryHcaptchaToken = await solveHcaptcha(clientId, captchaPageRqdata);
      
      if (!retryHcaptchaToken) {
        return { success: false, error: "HCAPTCHA_RETRY_FAILED" };
      }
      
      // Réessayer SetCaptchaToken avec le NOUVEAU token
      // HAR réel (2026-06-08T17-14-59) : SetCaptchaToken n'a PAS de Referer — supprimé du retry.
      const retryRes = await cevSetupFetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
        method: "POST",
        headers: getCevBrowserHeaders({
          origin: CEV_BASE,
          cookie: fullCevCookie,
          contentType: "application/x-www-form-urlencoded",
          xRequestedWith: true,
          accept: "*/*",
        }),
        body: new URLSearchParams({ captcha: retryHcaptchaToken }).toString(),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      
      if (retryRes.ok) {
        // FIX OSOnline : même logique que le premier POST — capturer Set-Cookie du retry
        fullCevCookie = mergeCookies(fullCevCookie, retryRes);
        const retryData = await retryRes.json() as { validUntil?: string; redirectUrl?: string };
        botLog({
          applicationId: clientId,
          step: "cev_http_captcha_retry_response",
          status: "ok",
          data: {
            validUntilRaw: retryData.validUntil,
            redirectUrlRaw: retryData.redirectUrl,
          },
        });
        
        if (retryData.validUntil) {
          // Retry réussi - utiliser les nouvelles valeurs
          captchaData.validUntil = retryData.validUntil;
          captchaData.redirectUrl = retryData.redirectUrl;
        } else {
          // Retry échoué aussi - retourner erreur
          return { success: false, error: "CAPTCHA_NO_VALID_UNTIL_RETRY_FAILED" };
        }
      } else {
        return { success: false, error: `CAPTCHA_RETRY_FAILED_${retryRes.status}` };
      }
    }

    // validUntil parsing
    const validUntilStr = captchaData.validUntil.endsWith('Z') 
      ? captchaData.validUntil 
      : captchaData.validUntil + 'Z';
    const validUntilMs = new Date(validUntilStr).getTime();

    // ══════════════════════════════════════════════════════════════════════════
    // ÉTAPE 7 : Suivre redirectUrl pour ACTIVER la session et obtenir le VRAI verdict
    // ══════════════════════════════════════════════════════════════════════════
    // SetCaptchaToken retourne TOUJOURS une redirectUrl du type :
    //   /Integration/VOW/{orgId}/{appId}/{sessionGuid}/{tokenGuid}/{lang}
    // La page finale est déterminée APRÈS navigation :
    //   → GET redirectUrl → 302 → /Integration/VOW/SelectSlot
    //     → 302 → /Integration/Error/NoAvailability → 302 → SessionExpired (serveur expire la session)
    //     → 200  page calendrier                      (créneaux dispo → session activée pour polling)
    //
    // FIX #9 : redirect:"manual" avec boucle cumulative.
    //   Problème avec redirect:"follow" : la chaîne NoAvailability → SessionExpired fait atterrir
    //   le bot sur SessionExpired, qui était classifié comme SESSION_EXPIRED_AFTER_REDIRECT.
    //   Résultat : chaque check "pas de créneaux" invalidait le cache VOWINT et gaspillait 1 clic/5h.
    //   Fix : tracer CHAQUE URL intermédiaire → NoAvailability détecté avant SessionExpired.
    // HAR réel (capture 2026-06-08) : le serveur retourne parfois un body vide sur SetCaptchaToken
    // (HTTP 200, body="", Set-Cookie=[]).  Le navigateur navigue alors vers l'URL d'intégration
    // originale (step 2) stockée côté JS.  Le bot doit faire pareil : fallback sur integrationUrl.
    const captchaRedirectUrl = captchaData.redirectUrl ?? "";

    if (!captchaRedirectUrl) {
      // Fallback : ré-utiliser l'URL d'intégration originale — comportement identique au navigateur réel
      botLog({
        applicationId: clientId,
        step: "cev_http_no_redirect_url_fallback",
        status: "warn",
        data: { fallback: integrationUrl.slice(0, 100) },
      });
    }

    // Construire l'URL absolue : préférer redirectUrl du JSON, sinon l'URL d'intégration originale
    const resolvedRedirect = captchaRedirectUrl
      ? (captchaRedirectUrl.startsWith("http") ? captchaRedirectUrl : `${CEV_BASE}${captchaRedirectUrl}`)
      : integrationUrl;

    const fullRedirectUrl = resolvedRedirect;

    let finalUrl = fullRedirectUrl;
    let probeBodyRaw = "";
    let probeBodyPreview = "";
    let probeHttpStatus = 0;
    // Historique de toutes les URLs visitées (pour détecter NoAvailability même si suivi de SessionExpired)
    const redirectChain: string[] = [fullRedirectUrl];

    try {
      // FIX #9 : boucle redirect:"manual" — on trace chaque hop
      // HAR réel (2026-06-08T17-14-59) : aucune des requêtes de la chaîne navigate
      // (Integration/VOW → SelectSlot → NoAvailability) n'envoie de Referer.
      // sec-fetch-site=same-origin est forcé explicitement (toujours même domaine CEV).
      let currentUrl = fullRedirectUrl;
      let finalRes: Response | null = null;

      for (let hop = 0; hop < 10; hop++) {
        const hopRes = await cevSetupFetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: getCevBrowserHeaders({
            fetchSite: "same-origin",
            cookie: fullCevCookie,
            // Propager le UA siphonné si présent (sessions pré-établies)
            // Burp Chrome 146 (2026-06-26) : SelectSlot + Integration/VOW 2ème hit
            // utilisent le même UA que toutes les requêtes précédentes.
            userAgent: siphoned?.userAgent,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        probeHttpStatus = hopRes.status;

        // FIX OSOnline : accumuler les Set-Cookie de CHAQUE hop (302 ou 200)
        // Le serveur OutSystems peut rafraîchir OSOnline ou TS01* à n'importe quel saut.
        fullCevCookie = mergeCookies(fullCevCookie, hopRes);

        if (hopRes.status >= 300 && hopRes.status < 400) {
          const loc = hopRes.headers.get("location");
          if (!loc) break;
          // Arrêt anticipé : si on passe par NoAvailability, noter et continuer
          // (on veut aussi activer le SelectSlot si présent plus tôt dans la chaîne)
          const nextUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
          redirectChain.push(nextUrl);
          currentUrl = nextUrl;
        } else {
          // Réponse finale (200, 4xx, 5xx)
          finalRes = hopRes;
          finalUrl = currentUrl;
          break;
        }
      }

      // Si on n'a jamais obtenu de réponse finale (que des 3xx), finalUrl = dernière URL tentée
      if (!finalRes) {
        finalUrl = currentUrl;
      }

      // Capturer le body pour diagnostiquer
      if (finalRes) {
        try { probeBodyRaw = await finalRes.text(); } catch { /* ignore */ }
      }
      // Extraire le texte visible (sans scripts/styles/tags)
      probeBodyPreview = probeBodyRaw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);

      botLog({
        applicationId: clientId,
        step: "cev_http_redirect_probe",
        status: "ok",
        data: {
          httpStatus: probeHttpStatus,
          finalUrl,
          redirectChain,
          bodyPreview: probeBodyPreview || "(vide)",
        },
      });
    } catch (probeErr) {
      const errMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
      botLog({
        applicationId: clientId,
        step: "cev_http_redirect_probe_error",
        status: "warn",
        data: { error: errMsg },
      });
      // En cas d'échec réseau (timeout, 503, 504) — signaler probeError
      // pour que le loop retente immédiatement avec le dossier suivant.
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
        probeError: true,
      };
    }

    // FIX #9 : vérifier toute la chaîne de redirections, pas seulement l'URL finale
    const chainPassedThrough = (keyword: string) =>
      redirectChain.some(u => u.includes(keyword)) || finalUrl.includes(keyword);

    // ── Classifier le verdict final ──────────────────────────────────────────
    // FIX #9 : utiliser chainPassedThrough() au lieu de finalUrl.includes() pour
    // détecter NoAvailability même quand il est suivi d'un 302 → SessionExpired.

    // Cas 1 : NoAvailability — pas de créneaux, mais session correctement établie
    // Priorité sur SessionExpired : si on est passé par NoAvailability, c'est un
    // résultat normal (pas d'erreur de session — le serveur expire la session après
    // avoir montré le message "pas de créneau").
    if (chainPassedThrough("NoAvailability")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_no_availability",
        status: "ok",
        data: { finalUrl, redirectChain, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
      };
    }

    // Cas 2 : MultiSessionNotAllowed — URL d'intégration déjà utilisée dans une autre session
    if (chainPassedThrough("MultiSessionNotAllowed")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_multi_session",
        status: "fail",
        data: { finalUrl, redirectChain, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return { success: false, error: "MULTI_SESSION_NOT_ALLOWED" };
    }

    // Cas 3 : Overview — un autre dossier du même type passeport a déjà un RDV planifié.
    //
    //   Cas 1 (différent dossier, même passeport) : page montre "Vous avez déjà planifié..."
    //     + lien "Nouveau rendez-vous" → le suivre → SelectSlot pour CE dossier
    //   Cas 2 (même dossier) : "Vous ne pouvez pas prendre un nouveau rendez-vous..."
    //     → seul bouton "Annuler" → retourner APPOINTMENT_LIMIT_REACHED
    if (chainPassedThrough("VOW/Overview") || finalUrl.includes("VOW/Overview")) {
      // Log complet pour analyse forensique (on ne connaît pas encore la structure HTML réelle)
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_overview_detected",
        status: "ok",
        data: {
          finalUrl,
          redirectChain,
          bodyPreview: probeBodyPreview.slice(0, 800),
          // HTML brut complet pour analyse de la structure du lien "Nouveau rendez-vous"
          htmlRaw: probeBodyRaw.slice(0, 10_000),
          overviewHtmlLen: probeBodyRaw.length,
        },
      });

      const newRdvHref = extractNouveauRdvLink(probeBodyRaw);
      console.log(`[CEV-SETUP] 📋 Overview détecté — lien "Nouveau rendez-vous": ${newRdvHref ?? "(absent — Cas 2: limite atteinte)"}`);

      if (!newRdvHref) {
        // Cas 2 : même dossier, limite de RDV atteinte — seul "Annuler" est disponible
        botLog({
          applicationId: clientId,
          step: "cev_http_overview_limit_reached",
          status: "warn",
          data: {
            finalUrl,
            bodyPreview: probeBodyPreview.slice(0, 500),
            message: "Aucun lien Nouveau rendez-vous — limite de RDV atteinte pour ce dossier",
          },
        });
        return {
          success: true,
          sessionCookie: cevSessionCookie,
          validUntilMs,
          integrationUrl,
          redirectUrl: captchaRedirectUrl,
          slotsAvailable: false,
          overviewState: 'limit_reached',
          overviewHtml: probeBodyRaw || undefined,
          overviewUrl: finalUrl || undefined,
        };
      }

      // Cas 1 : lien "Nouveau rendez-vous" trouvé → le suivre (même chaîne de redirects)
      const absoluteNewRdvUrl = newRdvHref.startsWith("http") ? newRdvHref : `${CEV_BASE}${newRdvHref}`;
      console.log(`[CEV-SETUP] ✅ Overview Cas 1 — suivi "Nouveau rendez-vous": ${absoluteNewRdvUrl.slice(0, 120)}`);
      botLog({
        applicationId: clientId,
        step: "cev_http_overview_new_appointment_follow",
        status: "ok",
        data: { newRdvHref, absoluteNewRdvUrl: absoluteNewRdvUrl.slice(0, 150) },
      });

      // Suivre le lien vers SelectSlot (même logique que la chaîne principale)
      let newRdvCurrentUrl = absoluteNewRdvUrl;
      let newRdvBodyRaw = "";
      const newRdvChain: string[] = [absoluteNewRdvUrl];

      for (let hop = 0; hop < 10; hop++) {
        const hopRes = await cevSetupFetch(newRdvCurrentUrl, {
          method: "GET",
          redirect: "manual",
          headers: getCevBrowserHeaders({
            fetchSite: "same-origin",
            cookie: fullCevCookie,
            referer: finalUrl,          // Overview page = referer naturel
            userAgent: siphoned?.userAgent,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        fullCevCookie = mergeCookies(fullCevCookie, hopRes);

        if (hopRes.status >= 300 && hopRes.status < 400) {
          const loc = hopRes.headers.get("location");
          if (!loc) break;
          const nextUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
          newRdvChain.push(nextUrl);
          newRdvCurrentUrl = nextUrl;
        } else {
          try { newRdvBodyRaw = await hopRes.text(); } catch { /* ignore */ }
          break;
        }
      }

      const newRdvChainStr = newRdvChain.join(" ");
      const newRdvBodyLower = newRdvBodyRaw.toLowerCase();
      const newRdvHasCalendar = (
        newRdvBodyLower.includes("getavailabletimeslotsforpublic") ||
        newRdvBodyLower.includes("home/availabletimeslots") ||
        newRdvBodyLower.includes("selectslot") ||
        newRdvBodyLower.includes("data-slot-time") ||
        newRdvBodyLower.includes("availability =") ||
        newRdvBodyLower.includes("availability=")
      );

      botLog({
        applicationId: clientId,
        step: "cev_http_overview_new_rdv_chain",
        status: "ok",
        data: {
          redirectChain: newRdvChain,
          finalUrl: newRdvCurrentUrl,
          hasCalendar: newRdvHasCalendar,
          htmlLen: newRdvBodyRaw.length,
          htmlPreview: newRdvBodyRaw.slice(0, 4000),
        },
      });

      if (newRdvChainStr.includes("SelectSlot") || newRdvHasCalendar) {
        console.log(`[CEV-SETUP] 🎯 Overview → "Nouveau rendez-vous" → SelectSlot ✅`);
        return {
          success: true,
          sessionCookie: cevSessionCookie,
          validUntilMs,
          integrationUrl,
          redirectUrl: captchaRedirectUrl,
          slotsAvailable: true,
          overviewState: 'new_appointment_available',
          selectSlotUrl: newRdvCurrentUrl,
          selectSlotHtml: newRdvBodyRaw || undefined,
          selectSlotCookies: fullCevCookie,
        };
      }

      if (newRdvChainStr.includes("NoAvailability")) {
        console.log(`[CEV-SETUP] ⚠️  Overview → "Nouveau rendez-vous" → NoAvailability (aucun créneau)`);
        return {
          success: true,
          sessionCookie: cevSessionCookie,
          validUntilMs,
          integrationUrl,
          redirectUrl: captchaRedirectUrl,
          slotsAvailable: false,
          overviewState: 'new_appointment_available',
        };
      }

      // Résultat inconnu après le suivi — logguer pour analyse et retourner sans crash
      botLog({
        applicationId: clientId,
        step: "cev_http_overview_new_rdv_unknown_result",
        status: "warn",
        data: {
          finalUrl: newRdvCurrentUrl,
          chain: newRdvChain,
          htmlPreview: newRdvBodyRaw.slice(0, 1000),
        },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        overviewState: 'new_appointment_available',
      };
    }

    // Cas 4 : Session expirée / re-captcha demandé (sans passer par NoAvailability)
    if (chainPassedThrough("SessionExpired") || chainPassedThrough("/Captcha")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_session_expired",
        status: "warn",
        data: { finalUrl, redirectChain, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return { success: false, error: "SESSION_EXPIRED_AFTER_REDIRECT" };
    }

    // Cas 4 : Page d'erreur générique CEV (/Error/Default, /Error/*)
    if (chainPassedThrough("/Error/")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_error_page",
        status: "warn",
        data: { finalUrl, redirectChain, bodyPreview: probeBodyPreview.slice(0, 300) },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
      };
    }

    // Cas 5 : Overview / Booked → dossier a déjà un RDV (limite atteinte)
    // Le portail redirige vers /Integration/VOW/Overview ou /Integration/VOW/Booked
    // quand un créneau a déjà été réservé pour ce dossier.
    if (chainPassedThrough("Overview") || chainPassedThrough("Booked")) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_overview_detected",
        status: "warn",
        data: {
          finalUrl,
          redirectChain,
          bodyPreview: probeBodyPreview.slice(0, 400),
          htmlRaw: probeBodyRaw.slice(0, 6000),
        },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: false,
        needsPlaywrightNavigation: false,
        isLimitReached: true,
        overviewHtml: probeBodyRaw || undefined,
        overviewUrl: finalUrl,
        overviewCookies: fullCevCookie || undefined,
      };
    }

    // Cas 6 : Page calendrier / SelectSlot → SESSION ACTIVÉE, slots potentiellement disponibles
    // Vérifier les marqueurs positifs dans le body pour confirmer
    const bodyLower = probeBodyRaw.toLowerCase();
    const hasCalendarMarkers = (
      bodyLower.includes("getavailabletimeslotsforpublic") ||
      bodyLower.includes("home/availabletimeslots") ||
      bodyLower.includes("selectslot") ||
      bodyLower.includes("data-slot-time") ||
      bodyLower.includes("calendar")
    );

    if (chainPassedThrough("SelectSlot") || hasCalendarMarkers) {
      botLog({
        applicationId: clientId,
        step: "cev_http_verdict_slots_available",
        status: "ok",
        data: {
          finalUrl,
          redirectChain,
          hasCalendarMarkers,
          validUntil: captchaData.validUntil,
          bodyPreview: probeBodyPreview.slice(0, 500),
          htmlRaw: probeBodyRaw.slice(0, 4000),
        },
      });
      return {
        success: true,
        sessionCookie: cevSessionCookie,
        validUntilMs,
        integrationUrl,
        redirectUrl: captchaRedirectUrl,
        slotsAvailable: true,
        needsPlaywrightNavigation: false,
        // IMPORTANT : l'integrationUrl est à usage unique (déjà consommée par la chaîne de redirects).
        // On retourne la vraie URL finale et le HTML complet capturé pour que le booking
        // puisse opérer directement sans refaire une requête (qui échouerait avec SESSION_EXPIRED_OR_CAPTCHA).
        selectSlotUrl: finalUrl,
        selectSlotHtml: probeBodyRaw || undefined,
        // fullCevCookie contient le __RequestVerificationToken cookie (anti-CSRF ASP.NET).
        // Sans lui, le POST SelectSlot retourne HTTP 500 "anti-forgery cookie not present".
        selectSlotCookies: fullCevCookie,
      };
    }

    // Cas 5 : URL inconnue — loguer et retourner la session pour polling
    botLog({
      applicationId: clientId,
      step: "cev_http_verdict_unknown",
      status: "warn",
      data: {
        finalUrl,
        httpStatus: probeHttpStatus,
        bodyPreview: probeBodyPreview.slice(0, 500),
        htmlRaw: probeBodyRaw.slice(0, 4000),
      },
    });
    return {
      success: true,
      sessionCookie: cevSessionCookie,
      validUntilMs,
      integrationUrl,
      redirectUrl: captchaRedirectUrl,
      slotsAvailable: false,
      needsPlaywrightNavigation: false,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    botLog({ applicationId: clientId, step: "cev_http_setup_error", status: "fail", data: { error: msg } });
    return { success: false, error: msg };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrait le href du lien "Nouveau rendez-vous" depuis la page Overview CEV.
 *
 * La page /Integration/VOW/Overview s'affiche quand un autre dossier du même
 * type de passeport a déjà un rendez-vous planifié (Cas 1). Elle contient alors
 * un lien "Nouveau rendez-vous" permettant de prendre RDV pour le dossier courant.
 *
 * Si seul "Annuler" est présent (Cas 2 — même dossier, limite atteinte), retourne null.
 *
 * Patterns couverts :
 *   <a href="...">Nouveau rendez-vous</a>
 *   <a href="..."> ... Nouveau rendez-vous ...</a>
 *   href="..." suivi de texte "Nouveau rendez-vous" dans les ~300 chars
 *   Variantes EN / NL : "New appointment" / "Nieuw afspraak"
 */
function extractNouveauRdvLink(html: string): string | null {
  const patterns = [
    // Cas direct : <a href="...">Nouveau rendez-vous</a>
    /<a[^>]+href="([^"]+)"[^>]*>\s*(?:Nouveau\s+rendez-vous|New\s+appointment|Nieuw\s+afspraak)/i,
    // Cas inversé : texte avant href dans la même balise <a>
    /<a[^>]*>\s*(?:Nouveau\s+rendez-vous|New\s+appointment|Nieuw\s+afspraak)[\s\S]{0,50}<\/a>/i,
    // href suivi du texte dans les 300 chars suivants (bouton ou span wrappé)
    /href="([^"]+)"[^>]*>[\s\S]{0,300}(?:Nouveau\s+rendez-vous|New\s+appointment)/i,
    // Texte "Nouveau rendez-vous" précédant un href dans les 300 chars
    /(?:Nouveau\s+rendez-vous|New\s+appointment)[\s\S]{0,300}href="([^"]+)"/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    // Le groupe 1 doit être une URL (relative /... ou absolute http...)
    if (m?.[1] && (m[1].startsWith('/') || m[1].startsWith('http'))) {
      return m[1];
    }
  }
  return null;
}

/**
 * Parse une chaîne "k1=v1; k2=v2" en Map.
 * FIX : utilise indexOf("=") au lieu de split("=") pour préserver les
 * valeurs contenant des "=" (base64 paddé, tokens, etc.)
 */
function parseCookieStr(cookieStr: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!cookieStr.trim()) return map;
  for (const part of cookieStr.split(";")) {
    const trimmed = part.trim();
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1); // préserve tout, y compris "=" dans la valeur
      if (k) map.set(k, v);
    }
  }
  return map;
}

/**
 * Extrait les cookies "nom=valeur" depuis les headers Set-Cookie d'une Response.
 * Utilise getSetCookie() (API correcte) avec fallback raw header.
 */
function extractCookies(res: Response): string | null {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  if (setCookies.length > 0) {
    // Chaque Set-Cookie : "nom=valeur; Path=/; HttpOnly" → on garde "nom=valeur"
    return setCookies.map(c => c.split(";")[0].trim()).join("; ");
  }
  // Fallback : header Set-Cookie brut (certains HTTP clients fusionnent les lignes)
  const raw = res.headers.get("set-cookie");
  if (raw) {
    // Cas "Set-Cookie: a=1, b=2" (fusionné) → split par ", " est risqué si la valeur
    // contient des virgules (ex: Expires), mais split(";")[0] nous protège.
    return raw.split(/,(?=[^;]+=[^;]+)/).map(c => c.split(";")[0].trim()).join("; ");
  }
  return null;
}

/**
 * Fusionne le jar de cookies existant avec les nouveaux cookies d'une Response.
 * Préserve l'ordre d'insertion (anciens d'abord, nouveaux/mis à jour ensuite).
 */
function mergeCookies(existing: string, res: Response): string {
  const newCookies = extractCookies(res);
  const map = parseCookieStr(existing);
  if (newCookies) {
    parseCookieStr(newCookies).forEach((v, k) => map.set(k, v));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function solveHcaptcha(clientId: string, rqdata?: string): Promise<string | null> {
  // Anti-Captcha met en cache les tokens par (sitekey + websiteURL).
  // Si deux scans appellent solveHcaptcha avec la même URL statique, Anti-Captcha peut renvoyer
  // le même token déjà utilisé → CEV le rejette (captchaSolved:false).
  // Fix : ajouter un nonce unique par appel → Anti-Captcha traite chaque requête comme
  // une URL distincte → toujours un token frais, jamais de hit de cache inter-scans.
  // hCaptcha siteverify ne valide PAS l'URL de la page, uniquement (sitekey + token + IP)
  // → le nonce n'affecte pas la validité du token côté CEV.
  const pageUrl = `${CEV_BASE}/Captcha?_=${Date.now()}`;
  const errors: string[] = [];
  // UA aligné sur la session HTTP courante (Chrome 147/148) — pas Chrome 125 codé en dur.
  // Si hCaptcha lie le token au UA du solveur, un mismatch → token rejeté à la soumission.
  const userAgent = getCevSessionUa();

  const useProxy = await shouldUseProxy();
  // Priorité : getCevProxyUrl() = proxy réel de la session CEV (chargé depuis CSV, SOAX, DECODO…).
  // C'est la SEULE source fiable — il correspond exactement à l'IP utilisée par cevImpitFetch.
  // Fallback env vars seulement si le proxy guard n'est pas encore initialisé.
  const rawProxyUrl = useProxy
    ? (getCevProxyUrl() || process.env.SOAX_PROXY_URL || process.env.IPROYAL_PROXY_URL || process.env.DECODO_PROXY_URL || null)
    : null;
  const proxyUrl = rawProxyUrl ? (rawProxyUrl.startsWith("http") ? rawProxyUrl : `http://${rawProxyUrl}`) : null;
  let proxyConfig: any = null;
  let proxyDnsResolved: string | null = null;
  
  // Get the already-resolved proxy exit IP (from proxy guard) if available (for token binding!)
  const proxyExitIp = useProxy ? getCevProxyExitIp() : undefined;
  
  if (proxyUrl) {
    try {
      const parsedProxy = new URL(proxyUrl);
      let proxyType = parsedProxy.protocol.replace(':', '');
      // Anti-Captcha uses http/socks4/socks5, if it's https we'll use http (since proxy is usually same for both)
      if (proxyType === 'https') proxyType = 'http';
      
      // SOAX uses port 5000 by default
      let port = parsedProxy.port;
      if (!port) {
        port = '5000';
      }
      
      // Résoudre le hostname du proxy en IP pour Anti-Captcha (requiert une IP, pas de hostname !)
      let proxyAddress = parsedProxy.hostname;
      try {
        console.log(`[CEV-SETUP] Resolving proxy hostname ${proxyAddress} to IP...`);
        const dnsResult = await lookup(proxyAddress);
        proxyAddress = dnsResult.address;
        proxyDnsResolved = dnsResult.address;
        console.log(`[CEV-SETUP] ✅ Resolved to IP: ${proxyAddress}`);
      } catch (dnsErr) {
        console.warn(`[CEV-SETUP] ⚠️ Failed to resolve proxy hostname: ${dnsErr}. Using hostname anyway (may fail).`);
      }
      
      if (proxyExitIp) {
        console.log(`[CEV-SETUP] Proxy exit IP (token binding): ${proxyExitIp}`);
      }
      
      proxyConfig = {
        proxyType: proxyType,
        proxyAddress: proxyAddress,
        proxyPort: parseInt(port, 10),
        proxyLogin: decodeURIComponent(parsedProxy.username || ''),
        proxyPassword: decodeURIComponent(parsedProxy.password || ''),
      };
      
      console.log("[CEV-SETUP] Parsed proxy config:", {
        ...proxyConfig,
        proxyPassword: "***",
      });
    } catch (e) {
      errors.push(`proxy_parse_failed: ${String(e)}`);
    }
  }

  // Only use Anti-Captcha for CEV (CapSolver doesn't support this sitekey)
  // Résolution dynamique : env var + fallback botConfig Convex
  const ANTICAPTCHA_KEY = await resolveAnticaptchaKey();
  if (ANTICAPTCHA_KEY) {
    botLog({ applicationId: clientId, step: "cev_http_hcaptcha_start", status: "ok", data: { service: "anticaptcha", useProxy: !!proxyConfig, proxyExitIp: proxyExitIp, proxyDnsResolved: proxyDnsResolved } });
    try {
      // ── Helper : créer + poller une tâche Anti-Captcha ──────────────────────
      // Renvoie le token ou null (en cas de timeout / erreur).
      // Lance Error("PROXY_CONNECT_REFUSED_NEEDS_ROTATION") si le proxy est coupé.
      const createAndPoll = async (task: Record<string, unknown>, label: string): Promise<string | null> => {
        console.log(`[CEV-SETUP] Sending task to Anti-Captcha (${label}):`, JSON.stringify(task, null, 2));
        const createRes = await fetch("https://api.anti-captcha.com/createTask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, task }),
          signal: AbortSignal.timeout(30_000),
        });
        const createData = await createRes.json() as { errorId: number; taskId?: number; errorCode?: string; errorDescription?: string };
        console.log(`[CEV-SETUP] Anti-Captcha createTask (${label}):`, createData);
        botLog({ applicationId: clientId, step: "cev_http_hcaptcha_create", status: createData.errorId === 0 ? "ok" : "fail", data: { label, errorId: createData.errorId, taskId: createData.taskId, errorCode: createData.errorCode } });

        if (createData.errorId !== 0 || !createData.taskId) return null;

        // Polling max 180s (36 × 5s) — premier poll à 15s (pas 5s).
        // Anti-Captcha peut retourner un token mis en cache en <5s pour la même sitekey/URL.
        // Ces tokens mis en cache sont souvent invalides (utilisés, expirés, IP-bindés différemment).
        // 15s > TTL du cache Anti-Captcha (~10s) → garantit un token fraîchement résolu.
        for (let i = 0; i < 36; i++) {
          await new Promise(r => setTimeout(r, i === 0 ? 15_000 : 5_000));
          let pollData: any;
          try {
            const pollRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: createData.taskId }),
              signal: AbortSignal.timeout(10_000),
            });
            pollData = await pollRes.json();
          } catch (fetchErr) {
            console.warn(`[CEV-SETUP] Anti-Captcha poll error (${label}): ${fetchErr}`);
            continue;
          }

          if (pollData.status === "ready") {
            const token = pollData.solution?.gRecaptchaResponse ?? pollData.solution?.token ?? null;
            if (token) {
              botLog({ applicationId: clientId, step: "cev_http_hcaptcha_solved", status: "ok", data: { label, seconds: (i + 1) * 5 } });
              return token;
            }
            return null; // ready but no token
          }
          if (pollData.errorId !== 0) {
            if (pollData.errorCode?.includes("PROXY_CONNECT_REFUSED") ||
                pollData.errorDescription?.includes("Could not connect to proxy")) {
              botLog({ applicationId: clientId, step: "cev_http_hcaptcha_proxy_refused", status: "fail", data: { errorCode: pollData.errorCode, errorDescription: pollData.errorDescription, recommendation: "ROTATE PROXY IP IMMEDIATELY" } });
              throw new Error("PROXY_CONNECT_REFUSED_NEEDS_ROTATION");
            }
            errors.push(`anticaptcha_poll_error(${label}): ${pollData.errorCode}`);
            return null;
          }
        }
        errors.push(`anticaptcha_timeout_180s(${label})`);
        return null;
      };

      // ── Construire la tâche ──────────────────────────────────────────────────
      // Priorité : si proxy disponible → HCaptchaTask ; sinon HCaptchaTaskProxyless.
      // ── Fetch rqdata enterprise depuis hCaptcha checksiteconfig ─────────────
      // La sitekey CEV est configurée en mode hCaptcha Enterprise côté serveur
      // (confirmé par "remote.captcha.com" dans le CSP de la page /Captcha).
      // Le rqdata n'est PAS dans le HTML statique : hcaptcha api.js le charge
      // dynamiquement via un call à checksiteconfig. On reproduit ce call depuis
      // notre process pour obtenir le rqdata, puis on le passe à Anti-Captcha.
      // Sans rqdata + isEnterprise:true → token standard rejeté par siteverify enterprise.
      let resolvedRqdata: string | undefined = rqdata; // rqdata depuis HTML (généralement undefined)
      if (!resolvedRqdata) {
        try {
          const checksiteUrl =
            `https://hcaptcha.com/checksiteconfig?v=1` +
            `&host=appointment.cloud.diplomatie.be` +
            `&sitekey=${HCAPTCHA_SITEKEY}` +
            `&sc=1&swa=1` +
            `&spst=${Math.floor(Date.now() / 1000)}`;
          const checksiteRes = await fetch(checksiteUrl, {
            headers: {
              "User-Agent": userAgent,
              "Referer": `${CEV_BASE}/Captcha`,
              "Origin": "https://js.hcaptcha.com",
              "Accept": "application/json, text/plain, */*",
            },
            signal: AbortSignal.timeout(10_000),
          });
          if (checksiteRes.ok) {
            const checksiteData = await checksiteRes.json() as {
              pass?: boolean;
              c?: { type?: string; req?: string };
            };
            if (checksiteData?.c?.req) {
              resolvedRqdata = checksiteData.c.req;
              console.log(`[CEV-SETUP] ✅ hCaptcha enterprise rqdata: ${resolvedRqdata.slice(0, 30)}… (type=${checksiteData.c.type})`);
            } else {
              console.log(`[CEV-SETUP] ℹ️ checksiteconfig: pass=${checksiteData?.pass}, c=${JSON.stringify(checksiteData?.c)} — pas de rqdata (mode standard)`);
            }
          } else {
            console.warn(`[CEV-SETUP] ⚠️ checksiteconfig HTTP ${checksiteRes.status}`);
          }
        } catch (cse) {
          console.warn(`[CEV-SETUP] ⚠️ checksiteconfig fetch failed: ${cse}`);
        }
      }
      botLog({
        applicationId: clientId,
        step: "cev_http_hcaptcha_rqdata",
        status: "ok",
        data: {
          rqdataFound: !!resolvedRqdata,
          rqdataPreview: resolvedRqdata ? resolvedRqdata.slice(0, 40) : null,
        },
      });

      // HCaptchaEnterpriseTaskProxyless supprimé — Anti-Captcha retourne
      // ERROR_TASK_NOT_SUPPORTED (errorId=23) pour ce type sur la sitekey CEV.
      //
      // Si rqdata enterprise disponible → isEnterprise:true + enterprisePayload requis.
      // Si pas de rqdata → mode standard (pas de flag enterprise).
      const enterprisePayload = resolvedRqdata
        ? { isEnterprise: true, enterprisePayload: { rqdata: resolvedRqdata } }
        : {};
      const baseTask = proxyConfig
        ? { type: "HCaptchaTask", websiteURL: pageUrl, websiteKey: HCAPTCHA_SITEKEY, ...proxyConfig, userAgent, ...enterprisePayload }
        : { type: "HCaptchaTaskProxyless", websiteURL: pageUrl, websiteKey: HCAPTCHA_SITEKEY, userAgent, ...enterprisePayload };

      const taskLabel = proxyConfig ? "HCaptchaTask" : "HCaptchaTaskProxyless";
      botLog({ applicationId: clientId, step: "cev_http_hcaptcha_task", status: "ok", data: { type: taskLabel } });

      try {
        const token = await createAndPoll(baseTask, taskLabel);
        if (token) {
          return token;
        }
        if (!errors.some(e => e.includes("anticaptcha"))) {
          errors.push("anticaptcha_task_failed");
        }
      } catch (e) {
        if (String(e).includes("PROXY_CONNECT_REFUSED_NEEDS_ROTATION")) throw e;
        errors.push(`anticaptcha_exception: ${String(e)}`);
      }
    } catch (e) {
      if (String(e).includes("PROXY_CONNECT_REFUSED_NEEDS_ROTATION")) throw e;
      errors.push(`anticaptcha_exception: ${String(e)}`);
    }
  } else {
    errors.push(`anticaptcha_not_configured`);
  }

  // NOTE: CapSolver est blacklisté pour la sitekey CEV (5f64399c-...) depuis 2026-04.
  // ERROR_INVALID_TASK_DATA systématique → ne PAS tenter CapSolver, utiliser UNIQUEMENT Anti-Captcha.

  botLog({ applicationId: clientId, step: "cev_http_hcaptcha_failed", status: "fail", data: { errors: errors.join(', ') } });
  console.log(`[CEV-SETUP] hCaptcha failed. Errors:`, errors);
  return null;
}
