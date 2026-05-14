import { ProxyAgent } from "undici";
import { Impit } from "impit";
import { randomDelay, proxyPool, launchBrowser } from "../browser.js";
import { reportSlotFound, sendHeartbeat, uploadFile, botLog, reportSlotDiscovery, reportSlotDiscoveryBatch, type SlotDiscoveryEvent, type HunterJob } from "../convexClient.js";
import { 
  humanLikeDelay, 
  humanPause, 
  getVariableBrowserHeaders, 
  shouldSimulateNetworkError, 
  simulateNetworkTimeout,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
  estimateExecutionTime,
  printExecutionTimeReport,
  logHumanBehaviorStart,
  logHumanBehaviorEnd
} from "../humanBehavior.js";

import {
  tokenCache,
  pendingLogin,
  usaFetch,
  makeIproyalStickyUrl,
  setUsaSessionProxy,
  USA_UA_POOL,
  setActiveSessionUaFromPoolIndex,
  parseJwtExpiry,
  isCachedTokenValid,
  sendKeepAliveIfNeeded,
  updateSessionActivity,
  refreshUsaToken,
  getBrowserHeaders,
  hasUsaProxy,
  getActiveSessionUaLogLabel,
} from "./usa-http.js";
import {
  randomInterStepPause,
  selectRandomFlow,
  sendAntiDetectionNoise,
  executeWithHumanVariability,
  shouldDoWarmup,
  warmupLastCalledAt,
  ofcCursor,
} from "./anti-detection.js";
import { scanUsaSlotsViaAPI, downloadUsaConfirmationPdf } from "./scan-slot-booking.js";
import {
  checkUsaAppointmentRequestStatus,
  fetchCancellableSessionIds,
} from "./appointments-api.js";

import type { SessionResult, CachedToken, UsaSession, UsaLoginResponse } from "./types.js";
import {
  USA_BASE,
  USA_LOGIN_URL,
  USA_LOGOUT_URL,
  USA_REFRESH_URL,
  USA_MISSION_ID,
  USA_ADMIN_URL,
  USA_APPOINTMENT_URL,
  USA_NOTIFICATION_URL,
  USA_PAYMENT_URL,
  USA_WORKFLOW_URL,
  USA_APPLICANT_API_URL,
  USA_OFC_LIST_URL,
  USA_TRANSFORM_DATA_URL,
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  USA_APP_DETAILS_URL,
  USA_CONFIRMATION_LETTER_URL,
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  USA_SANITY_CHECK_URL,
  USA_FCS_CHECK_URL,
  TOKEN_REFRESH_BUFFER_MS,
  USA_PORTAL_IDLE_TIMEOUT_MS,
  MAX_AUTH_IDLE_MS,
  MAX_SESSION_ABSOLUTE_MS,
  PROXY_EXPIRY_BUFFER_MS,
  REFERER_LOGIN,
  REFERER_DASHBOARD,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
  KEEP_ALIVE_INTERVAL_MS,
  WARMUP_INTERVAL_MS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import {
  isAccountRestricted,
  markAccountRestricted,
  isRestrictedBody,
  getAccountRestrictionDeadline,
} from "./account-restriction.js";
import { encryptPortalCredentials } from "./crypto.js";







export async function getUsaSession(
  username: string,
  password: string,
  _captchaApiKey?: string  // Conservé pour compatibilité — le portail USA ne requiert pas de CAPTCHA via API
): Promise<UsaSession | null> {
  const cacheKey = username.toLowerCase();

  // ── Guard restriction compte ────────────────────────────────────────────────
  // Si le portail a renvoyé "temporarily restricted" lors d'un appel précédent,
  // NE PAS tenter de login — cela prolongerait la restriction.
  // Retourner null signale à runUsaApiSession de skipper ce cycle.
  if (isAccountRestricted(username)) {
    const until = getAccountRestrictionDeadline(username)!;
    const remainMin = Math.round((until - Date.now()) / 60000);
    console.warn(`[usa] 🔒 ${username} en restriction compte — ${remainMin} min restantes. Cycle ignoré.`);
    return null;
  }

  const cached = tokenCache.get(cacheKey);

  if (cached) {
    if (isCachedTokenValid(cached)) {
      const remainingMin = Math.round((cached.expiresAt - Date.now()) / 60000);
      console.log(`[usa] Token en cache valide pour ${cached.fullName} (expire dans ~${remainingMin} min)`);
      return {
        accessToken: cached.accessToken,
        refreshToken: cached.refreshToken,
        csrfToken: cached.csrfToken,
        userID: cached.userID,
        fullName: cached.fullName,
        applicationId: null,
        pendingAppoStatus: null,
        missionId: USA_MISSION_ID,
        allowedOfcs: cached.allowedOfcs ?? [],
      };
    }

    console.log("[usa] Token expiré — tentative de renouvellement...");
    const refreshed = await refreshUsaToken(cached, username);
    if (refreshed) {
      tokenCache.set(cacheKey, refreshed);
      return {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        csrfToken: refreshed.csrfToken,
        userID: refreshed.userID,
        fullName: refreshed.fullName,
        applicationId: null,
        pendingAppoStatus: null,
        missionId: USA_MISSION_ID,
        // Préserver les OFCs autorisés depuis le token précédent — le refresh ne recrée pas la session
        allowedOfcs: cached.allowedOfcs ?? [],
      };
    }
    console.log("[usa] Refresh échoué — reconnexion complète");
    tokenCache.delete(cacheKey);
  }

  // ── Verrou anti-race-condition ──────────────────────────────────────────────
  // Si un login est déjà en cours pour ce compte (job concurrent), on attend sa
  // résolution plutôt que d'envoyer une 2e requête qui pourrait déclencher un lockout.
  const inFlight = pendingLogin.get(cacheKey);
  if (inFlight) {
    console.log(`[usa] Login déjà en cours pour ${username} — attente de la réponse en cours...`);
    return inFlight;
  }

  const loginPromise = (async (): Promise<UsaSession | null> => {
    let session: UsaSession | null = null;
    try {
      console.log("[usa] Login API avec credentials AES chiffrés...");
      session = await loginUsaPortal(username, password, null);
    } catch (err) {
      // AccountRestrictedError : le portail a refusé le login avec "temporarily restricted".
      // Enregistrer la restriction et retourner null — PAS d'exception qui casserait l'auto-pause.
      if (err instanceof AccountRestrictedError) {
        markAccountRestricted(username, err.retryAfterMs, err.retryAfterHeader);
        pendingLogin.delete(cacheKey);
        return null;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Login USA échoué: ${msg}`);
    } finally {
      pendingLogin.delete(cacheKey);
    }

    if (!session) return null;

    const expiresAt = parseJwtExpiry(session.accessToken) || Date.now() + 55 * 60 * 1000;
    // Jitter ±5 min calculé une fois au login. Valeur aléatoire en ms dans [-300_000, +300_000].
    // Appliqué dans isCachedTokenValid() pour décaler l'expiration perçue de chaque compte,
    // évitant le pattern "login toutes les 55 min pile" corrélable entre comptes.
    const jitterMs = Math.floor((Math.random() * 2 - 1) * 5 * 60 * 1000);
    // uaIndex et proxyUrl sont volontairement absents ici — runUsaApiSession les injecte
    // immédiatement après (il connaît le proxy + UA assignés pour ce nouveau token).
    // proxyExpiresAt est aussi injecté par runUsaApiSession quand le proxy est acquis.
    tokenCache.set(cacheKey, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      csrfToken: session.csrfToken,
      expiresAt,
      allowedOfcs: session.allowedOfcs ?? [],
      userID: session.userID,
      fullName: session.fullName,
      jitterMs,
      sessionStartedAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    return session;
  })();

  pendingLogin.set(cacheKey, loginPromise);
  return loginPromise;
}

/**
 * Déconnecte l'utilisateur du portail USA et vide le cache de token.
 * Appelle POST /identity/user/logout avec le Bearer token en en-tête.
 */
export async function logoutUsaPortal(username: string): Promise<void> {
  const cacheKey = username.toLowerCase();
  const cached = tokenCache.get(cacheKey);

  if (cached) {
    console.log(`[usa] Déconnexion de ${username} du portail...`);
    try {
      const res = await usaFetch(USA_LOGOUT_URL, {
        method: "POST",
        headers: {
          ...getBrowserHeaders(),
          Authorization: `Bearer ${cached.accessToken}`,
        },
        body: null,
      });
      console.log(`[usa] Logout HTTP ${res.status} — ${username}`);
    } catch (err) {
      console.warn(`[usa] Erreur réseau lors du logout (ignorée):`, err);
    } finally {
      tokenCache.delete(cacheKey);
      console.log(`[usa] Cache token supprimé pour ${username}`);
    }
  } else {
    console.log(`[usa] Aucune session active pour ${username} — rien à déconnecter`);
  }
}

export async function loginUsaPortal(
  username: string,
  password: string,
  _captchaToken?: string | null  // Conservé pour compatibilité — le CAPTCHA n'est pas requis par l'API
): Promise<UsaSession | null> {
  console.log(`[usa] Connexion API pour ${username} avec credentials AES chiffrés...`);

  // Le portail USA attend les credentials chiffrés en AES-256-CBC dans le champ "authorization"
  // Format découvert dans le bundle Angular public : { authorization: "Basic " + encrypt(user:pass) }
  const body = {
    authorization: `Basic ${encryptPortalCredentials(username, password)}`,
  };

  console.log(`[usa] Body login: {authorization: "Basic <AES_encrypted(${username}:***)}"}`);

  // Bundle Angular : loginUser() vide sessionStorage avant login
  // Notre bot utilise une Map en mémoire (comportement équivalent)
  console.log(`[usa] Simulating sessionStorage.clear() before login (bundle behavior)`);

  let response: Response;
  try {
    // Bundle Angular : loginUser() envoie ses headers normaux
    const loginHeaders = {
      ...getBrowserHeaders(),
      "Content-Type": "application/json",
      "Referer": REFERER_LOGIN,
    };
    
    response = await usaFetch(USA_LOGIN_URL, {
      method: "POST",
      // Content-Type obligatoire : body JSON. Referer = page de login (le formulaire poste vers lui-même).
      // authHeaders() ne convient pas ici car on n'a pas encore de token.
      headers: loginHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error("[usa] Erreur réseau lors du login:", err);
    throw new Error(`Réseau: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 429 au login = trop de tentatives → risque de lockout compte
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
    throw new RateLimitError(USA_LOGIN_URL, waitMs);
  }

  // Lire le corps de la réponse dans tous les cas pour logger le vrai message d'erreur
  let rawBody = "";
  let data: UsaLoginResponse | null = null;
  try {
    rawBody = await response.text();
    data = JSON.parse(rawBody) as UsaLoginResponse;
  } catch {
    // pas du JSON
  }

  if (!response.ok) {
    const detail = data?.msg ?? rawBody.slice(0, 200);
    console.error(`[usa] Login HTTP ${response.status} — détail: ${detail}`);
    // 401 avec corps "temporarily restricted" = compte en cooldown côté portail.
    // NE PAS traiter comme une erreur de credentials — lever AccountRestrictedError
    // pour que getUsaSession puisse enregistrer la fenêtre de restriction sans loop.
    if (response.status === 401 && isRestrictedBody(rawBody + detail)) {
      const retryAfter = response.headers.get("Retry-After");
      throw new AccountRestrictedError(
        retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined,
        retryAfter ?? undefined
      );
    }
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  if (!data) {
    console.error("[usa] Réponse login invalide (JSON parse échoué)");
    throw new Error("Réponse non-JSON du portail USA");
  }

  let accessToken = response.headers.get("authorization");
  let refreshToken = response.headers.get("refreshtoken") ?? "";

  // ── Extraction csrfToken robuste ───────────────────────────────────────────
  // Le bundle Angular lit : F.headers.get("Csrftoken") (header de réponse custom).
  // Problème observé : les proxies résidentiels (iProyal) filtrent parfois les headers
  // non-standard de la réponse HTTP. On cherche dans plusieurs sources :
  //   1. Header "Csrftoken" (case-insensitive via l'API Headers)
  //   2. Header "x-csrf-token" (variante normalisée parfois utilisée par des reverse-proxies)
  //   3. Header "set-cookie" contenant "XSRF-TOKEN=" (le serveur peut poser un cookie CSRF)
  //   4. Champ "csrfToken" ou "csrf" dans le body JSON (si le serveur a changé le format)
  let csrfToken = response.headers.get("Csrftoken")
    ?? response.headers.get("csrftoken")
    ?? response.headers.get("x-csrf-token")
    ?? "";

  // Fallback : chercher dans le Set-Cookie un XSRF-TOKEN
  if (!csrfToken) {
    const setCookie = response.headers.get("set-cookie") ?? "";
    const xsrfMatch = setCookie.match(/XSRF-TOKEN=([^;]+)/);
    if (xsrfMatch) {
      csrfToken = xsrfMatch[1];
      console.log(`[usa] csrfToken extrait depuis Set-Cookie: ${csrfToken.slice(0, 8)}...`);
    }
  }

  // Fallback : chercher dans le body JSON (si le serveur a migré le CSRF dans le body)
  if (!csrfToken && data) {
    const bodyAny = data as unknown as Record<string, unknown>;
    const fromBody = bodyAny.csrfToken ?? bodyAny.csrf ?? bodyAny.xsrfToken ?? bodyAny.CsrfToken;
    if (typeof fromBody === "string" && fromBody.length > 0) {
      csrfToken = fromBody;
      console.log(`[usa] csrfToken extrait depuis le body JSON: ${csrfToken.slice(0, 8)}...`);
    }
  }

  // Diagnostic : loguer les headers de réponse si le csrfToken est toujours absent
  if (!csrfToken) {
    const headerEntries = [...response.headers.entries()];
    const headerNames = headerEntries.map(([k]) => k).join(", ");
    console.warn(`[usa] ⚠️ csrfToken ABSENT de la réponse login — headers reçus: [${headerNames}]`);
    console.warn(`[usa] Headers détaillés: ${JSON.stringify(Object.fromEntries(headerEntries)).slice(0, 1000)}`);
    // Le csrfToken vide n'empêche PAS le login ni le polling (GET).
    // Il ne bloque QUE les opérations PUT (booking/reschedule).
    // On continue avec un warning plutôt que de crasher.

    // ── Fallback : POST /refreshToken via le MÊME egress que le login (usaFetch) ─
    // NE JAMAIS utiliser fetch() direct ici quand un proxy est actif : le portail lie
    // le JWT à l'IP du login — un refresh depuis l'IP Railway (ou toute autre IP) casse
    // la session et les GET suivants (ex. payment status) répondent 401.
    // On ne refait pas un login complet — on réutilise refreshToken + username.
    if (hasUsaProxy()) {
      console.log("[usa] Tentative de récupération csrfToken via POST /refreshToken (même proxy / même IP que le login)...");
      try {
        const refreshRes = await usaFetch(USA_REFRESH_URL, {
          method: "POST",
          headers: {
            ...getBrowserHeaders(),
            "Content-Type": "application/json",
            "Referer": REFERER_DASHBOARD,
          },
          body: JSON.stringify({ refreshToken, username }),
        });
        const viaProxyCsrf =
          refreshRes.headers.get("Csrftoken") ?? refreshRes.headers.get("csrftoken") ?? "";
        if (viaProxyCsrf) {
          csrfToken = viaProxyCsrf;
          console.log(`[usa] ✅ csrfToken récupéré via refresh (même egress): ${csrfToken.slice(0, 8)}...`);
        } else {
          const hdrs = [...refreshRes.headers.entries()].map(([k]) => k).join(", ");
          console.warn(`[usa] csrfToken toujours absent après refresh même IP — headers: [${hdrs}]`);
          console.warn(`[usa] ⚠️ Le serveur ne renvoie pas Csrftoken — les PUT (booking) pourront échouer.`);
        }
        // Le refresh peut renvoyer un nouveau couple access/refresh ; l'ancien access peut
        // alors être rejeté sur les API suivantes si on ne pivote pas.
        if (refreshRes.ok) {
          const newAccess = refreshRes.headers.get("authorization");
          const newRefresh = refreshRes.headers.get("refreshtoken");
          if (newAccess && newAccess !== accessToken) {
            accessToken = newAccess;
            console.log("[usa] JWT access pivoté après refresh post-login (cohérence session)");
          }
          if (newRefresh) {
            refreshToken = newRefresh;
          }
        }
      } catch (refreshErr) {
        console.warn(`[usa] Fallback refresh même-IP échoué: ${refreshErr instanceof Error ? refreshErr.message : refreshErr}`);
      }
    }
  }

  if (data.msg && (data.msg.toLowerCase().includes("invalid") || data.msg.toLowerCase().includes("incorrect"))) {
    console.error(`[usa] Login refusé par le portail: ${data.msg}`);
    throw new Error(`Portail: ${data.msg}`);
  }

  // Détection MFA — bundle: "1 == j.body?.mfa ? (this.mfaMsg = j.body?.msg, ...) : ..."
  // Si mfa est truthy (1 ou true), le portail demande un OTP — le bot ne supporte pas ce cas.
  // Le token renvoyé dans ce cas serait invalide, donc on avorte proprement.
  if (data.mfa) {
    console.error(`[usa] Compte avec MFA activé — message portail: ${data.msg ?? "none"}`);
    throw new Error(
      `Compte MFA activé (mfa=${data.mfa}) — authentification à 2 facteurs non supportée par le bot. ` +
      `Désactivez le MFA sur votre compte usvisaappt.com pour utiliser Joventy.`
    );
  }

  // Détection "firstTimeLogin" — le portail force un changement de mot de passe
  if (data.firstTimeLogin) {
    console.error(`[usa] Premier login — le portail exige un changement de mot de passe.`);
    throw new Error(
      `Premier login détecté — connectez-vous une fois manuellement sur usvisaappt.com pour changer votre mot de passe avant d'utiliser Joventy.`
    );
  }

  // Comparaison insensible à la casse — le serveur peut renvoyer "active", "Active" ou "ACTIVE"
  if ((data.isActive ?? "").toUpperCase() !== "ACTIVE") {
    console.warn(`[usa] Compte inactif: isActive=${data.isActive}, msg=${data.msg}`);
    throw new Error(`Compte non actif (isActive=${data.isActive})`);
  }

  if (!accessToken) {
    console.error("[usa] JWT absent du header 'authorization'");
    throw new Error("JWT manquant dans la réponse — login incomplet");
  }

  console.log(`[usa] Connecté en tant que ${data.fullName} (userID: ${data.userID}) — csrfToken: ${csrfToken ? `${csrfToken.slice(0, 8)}...` : "(absent)"}`);

  // Bundle : localStorage.setItem("loggedInApplicantUser", JSON.stringify(F.body))
  // Les OFCs autorisés pour ce compte sont dans F.body.ofc (tableau de {postUserId}).
  // Utilisés après getFilteredOfcPostList pour filtrer la liste des OFCs disponibles.
  const allowedOfcs: Array<{ postUserId: number }> = Array.isArray(data.ofc) ? data.ofc : [];
  if (allowedOfcs.length > 0) {
    console.log(`[usa] OFCs autorisés pour ${data.fullName}: ${allowedOfcs.map(o => o.postUserId).join(", ")}`);
  }

  return {
    accessToken,
    refreshToken: refreshToken ?? "",
    csrfToken,
    userID: data.userID,
    fullName: data.fullName,
    applicationId: null,
    pendingAppoStatus: null,
    missionId: USA_MISSION_ID,
    allowedOfcs,
  };
}

export async function runUsaApiSession(job: HunterJob): Promise<SessionResult> {
  const { embassyUsername: username, embassyPassword: password, twoCaptchaApiKey } = job.hunterConfig;
  const sessionStartTime = Date.now();
  let result: SessionResult = "error";

  // Log le début du comportement humain
  logHumanBehaviorStart(job.id, `USA Portal - ${username}`);
  
  try {
    if (!username || !password) {
      console.error("[usa] Identifiants portail manquants dans hunterConfig");
      result = "error";
      return result;
    }

  // ── Proxy + UA sticky sur la durée du JWT ────────────────────────────────
  // Principe : un même JWT doit toujours être présenté depuis la même IP et avec
  // le même User-Agent. Changer d'IP ou d'UA en cours de token = empreinte bot.
  //
  //  • Cache hit (token valide) → réutiliser le proxy et l'UA du cache
  //  • Nouveau token (login ou expiry) → assigner un nouveau proxy + UA,
  //    puis les stocker dans le cache juste après le login réussi.
  const cacheKeySticky = username.toLowerCase();
  const cachedSticky = tokenCache.get(cacheKeySticky);
  const hasStickyCache = cachedSticky !== undefined && isCachedTokenValid(cachedSticky);

  let sessionProxy: string | undefined;
  let sessionUaIdx: number;

  if (hasStickyCache && cachedSticky) {
    sessionProxy  = cachedSticky.proxyUrl;
    sessionUaIdx  = cachedSticky.uaIndex ?? Math.floor(Math.random() * USA_UA_POOL.length);
    const maskedProxy = sessionProxy ? sessionProxy.replace(/:([^:@]+)@/, ":***@") : "aucun (direct)";
    console.log(`[usa] Token en cache → proxy sticky: ${maskedProxy} | UA idx ${sessionUaIdx}`);
  } else {
    // ── Proxy résidentiel 2captcha (OBLIGATOIRE pour USA) ──────────────────
    // Les IPs résidentielles du pool 2captcha sont STABLES pendant 30 min
    // (contrairement à iProyal/BrightData qui changent d'IP mid-session).
    // Le serveur USA lie le JWT à l'IP du login → on utilise getStickyProxy()
    // pour assigner UNE IP fixe par compte sur toute la durée du token.
    //
    // ⚠️ JAMAIS de fallback Railway direct — l'IP fixe Railway se fait restricter
    // après quelques logins. On attend que le pool soit disponible.
    const PROXY_ACQUIRE_MAX_RETRIES = 4;
    const PROXY_ACQUIRE_WAIT_MS = 5_000; // 5s entre retries
    let stickyProxyUrl: string | null = null;

    for (let attempt = 1; attempt <= PROXY_ACQUIRE_MAX_RETRIES; attempt++) {
      stickyProxyUrl = await proxyPool.getStickyProxy(username);
      if (stickyProxyUrl) break;
      if (attempt < PROXY_ACQUIRE_MAX_RETRIES) {
        console.warn(`[usa] ⏳ Proxy pool indisponible (tentative ${attempt}/${PROXY_ACQUIRE_MAX_RETRIES}) — attente ${PROXY_ACQUIRE_WAIT_MS / 1000}s...`);
        await new Promise(r => setTimeout(r, PROXY_ACQUIRE_WAIT_MS));
      }
    }

    if (stickyProxyUrl) {
      sessionProxy = stickyProxyUrl;
      const maskedProxy = stickyProxyUrl.replace(/:([^:@]+)@/, ":***@");
      console.log(`[usa] Nouveau token → proxy 2captcha sticky: ${maskedProxy}`);
    } else {
      // Pool toujours vide après retries → ABORTER le cycle (ne JAMAIS exposer l'IP Railway)
      console.error(`[usa] 🚫 Proxy pool indisponible après ${PROXY_ACQUIRE_MAX_RETRIES} tentatives — cycle AVORTÉ (protection IP Railway)`);
      botLog({ applicationId: job.id, step: "proxy", status: "fail", data: { username, error: "Proxy pool indisponible — cycle avorté" } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "Proxy pool indisponible — cycle avorté (ne pas exposer IP Railway)",
      });
      result = "not_found";
      return result;
    }
    sessionUaIdx = Math.floor(Math.random() * USA_UA_POOL.length);
  }

  // Activer le proxy et l'UA choisis pour TOUTE cette session
  setActiveSessionUaFromPoolIndex(sessionUaIdx);
  console.log(`[usa] UA: ${getActiveSessionUaLogLabel()}`);
  setUsaSessionProxy(sessionProxy);
  // ──────────────────────────────────────────────────────────────────────────

  // ── Keep-alive : si on réutilise une session cachée, vérifier qu'elle est active ─
  // Le portail tue les sessions après ~15 min d'inactivité. Si le dernier scan
  // remonte à > 8 min, on envoie un ping léger AVANT de tenter quoi que ce soit.
  if (hasStickyCache && cachedSticky) {
    const keepAliveOk = await sendKeepAliveIfNeeded(cachedSticky, username);
    if (!keepAliveOk) {
      // Session morte côté serveur — supprimer le cache et forcer un re-login
      console.warn(`[usa] ⚠️ Session morte (keep-alive 401) — suppression cache, re-login au prochain cycle`);
      tokenCache.delete(cacheKeySticky);
      proxyPool.releaseStickyProxy(username);
      botLog({ applicationId: job.id, step: "keep_alive", status: "fail", data: { username, error: "Session expirée côté serveur — re-login nécessaire" } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "Session expirée côté serveur (inactivité ~15 min) — re-login au prochain cycle",
      });
      result = "error";
      return result;
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  let session: UsaSession | null = null;
  try {
    session = await getUsaSession(username, password, twoCaptchaApiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[usa] getUsaSession échoué: ${msg}`);
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: msg.slice(0, 300) } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: msg.slice(0, 300),
    });
    result = "login_failed";
    return result;
  }
  if (!session) {
    // null peut vouloir dire : compte temporairement restreint (isAccountRestricted() = true)
    // ou identifiants incorrects. On distingue les deux pour éviter l'auto-pause inutile.
    if (isAccountRestricted(username)) {
      const until = getAccountRestrictionDeadline(username.toLowerCase())!;
      const remainMin = Math.round((until - Date.now()) / 60000);
      botLog({ applicationId: job.id, step: "login", status: "warn", data: { username, error: `Compte restreint — ${remainMin} min restantes` } });
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: `Compte restreint — cycle ignoré (${remainMin} min restantes)`,
      });
      result = "not_found";
      return result;  // "not_found" = pas de panique, on réessaie plus tard
    }
    botLog({ applicationId: job.id, step: "login", status: "fail", data: { username, error: "Identifiants incorrects ou portail indisponible" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: "Connexion API USA échouée — identifiants incorrects ou portail indisponible",
    });
    result = "login_failed";
    return result;
  }

  // ── Sticky proxy/UA : injecter dans le cache si nouveau token ────────────
  // getUsaSession() a créé une nouvelle entrée cache sans proxy ni UA.
  // On les injecte maintenant pour que les sessions suivantes (cache hit)
  // réutilisent exactement la même identité réseau.
  if (!hasStickyCache) {
    const freshEntry = tokenCache.get(cacheKeySticky);
    if (freshEntry) {
      freshEntry.proxyUrl = sessionProxy;
      freshEntry.uaIndex  = sessionUaIdx;
      // Synchroniser la durée de vie du token avec celle du proxy.
      // Le JWT ne peut pas survivre à son IP — on prend le min(JWT exp, proxy exp).
      const proxyInfo = proxyPool.getStickyProxyInfo(username);
      if (proxyInfo) {
        freshEntry.proxyExpiresAt = proxyInfo.expiresAt;
        // Si le proxy expire avant le JWT, ajuster expiresAt effectif
        if (proxyInfo.expiresAt < freshEntry.expiresAt) {
          console.log(`[usa] ⏱ Token expirera avec le proxy dans ${Math.round((proxyInfo.expiresAt - Date.now()) / 60000)} min (avant JWT ${Math.round((freshEntry.expiresAt - Date.now()) / 60000)} min)`);
        }
      }
    }
  }
  // ──────────────────────────────────────────────────────────────────────────

  // ── Log login réussi dans Convex (visible dans botLogs du panneau admin) ──
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      flow: "usa",
      username,
      fullName: session.fullName,
      userID: session.userID,
      csrfToken: session.csrfToken ? "present" : "ABSENT",
      missionId: session.missionId,
    },
  });

  // ── Résolution du dossier actif ────────────────────────────────────────────
  // Le portail peut retourner plusieurs dossiers si le compte en gère plusieurs.
  // portalApplicationId (admin) → sélection exacte ; sinon → premier avec paiement confirmé.
  const requestStatus = await checkUsaAppointmentRequestStatus(session, job.hunterConfig.portalApplicationId);
  session.applicationId = requestStatus.applicationId;
  session.pendingAppoStatus = requestStatus.pendingAppoStatus;
  // Priorité au missionId serveur (équivalent au cookie "missionId" que le portail Angular lit).
  session.missionId = requestStatus.missionId;
  // applicantId interne (bundle : selectedSlotDetails.applicantId) — propagé si le serveur le retourne.
  if (requestStatus.applicantId !== undefined) {
    session.applicantId = requestStatus.applicantId;
  }
  // appointmentId interne — OBLIGATOIRE dans le payload de booking.
  // Bundle Angular : this.selectedSlotDetails.appointmentId → envoyé dans le PUT /appointments/schedule.
  if (requestStatus.appointmentId !== undefined) {
    session.appointmentId = requestStatus.appointmentId;
  }
  // applicantUUID interne — requis dans le payload de booking.
  if (requestStatus.applicantUUID !== undefined) {
    session.applicantUUID = requestStatus.applicantUUID;
  }

  if (requestStatus.status === "error") {
    console.error(`[usa] Erreur lecture statut demande : ${requestStatus.message}`);
    botLog({ applicationId: job.id, step: "appointment_status", status: "fail", data: { flow: "usa", status: "error", message: requestStatus.message } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: requestStatus.message,
    });
    result = "error";
    return result;
  }

  if (requestStatus.status === "no_request") {
    console.warn(`[usa] Aucune demande soumise : ${requestStatus.message}`);
    botLog({ applicationId: job.id, step: "appointment_status", status: "warn", data: { flow: "usa", status: "no_request", pendingAppoStatus: requestStatus.pendingAppoStatus, message: requestStatus.message, action: "L'utilisateur doit effectuer le paiement sur usvisaappt.com" } });
    await sendHeartbeat({
      applicationId: job.id,
      result: "not_found",
      errorMessage: requestStatus.message,
    });
    result = "not_found";
    return result;
  }

  // ── Cas "cancellable" : demande avec applicationId mais pendingAppoStatus=0 (annulable) ──
  // Exemple : demande créée mais paiement non effectué, peut être annulée
  if (requestStatus.status === "cancellable") {
    const rescheduleMode = job.hunterConfig.rescheduleMode;
    if (!rescheduleMode) {
      console.log(`[usa] ♻️ Demande annulable (cancellable) — rescheduleMode non activé dans l'admin. Passage ignoré.`);
      await sendHeartbeat({
        applicationId: job.id,
        result: "not_found",
        errorMessage: "cancellable: rescheduleMode non activé",
      });
      return "not_found";
    }

    console.log(`[usa] ♻️ Demande cancellable — résolution applicationId/appointmentId via API...`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_start" } });

    const apiResult = await fetchCancellableSessionIds(session, job);
    if (apiResult === "error") {
      console.error("[usa] ❌ Résolution cancellable API échouée");
      await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: "Résolution cancellable API échouée" });
      return "error";
    }
    if (apiResult === "not_found") {
      console.warn("[usa] ⚠️ Résolution cancellable : aucun ID trouvé — skip");
      await sendHeartbeat({ applicationId: job.id, result: "not_found", errorMessage: "applicationId/appointmentId non trouvés via API dashboard" });
      return "not_found";
    }
    // apiResult = "proceed" : session.applicationId et session.appointmentId sont à jour
    console.log(`[usa] ✅ Résolution cancellable terminée — applicationId=${session.applicationId} appointmentId=${session.appointmentId}`);
    botLog({ applicationId: job.id, step: "scan", status: "ok", data: { flow: "usa", phase: "cancellable_api_proceed", applicationId: session.applicationId, appointmentId: session.appointmentId } });
    // Marquer la session pour utiliser PUT /appointments/reschedule lors du booking
    session.isReschedule = true;
    // Laisser tomber vers le scan de créneaux (ne pas return ici)
  }

  // Note: Le statut "scheduled" n'existe plus. Si un RDV est déjà bookté,
  // il sera détecté via showRescheduleButton dans le flow cancellable (pendingAppoStatus=0 + cancellable=true).
  // Si pendingAppoStatus !== 0 → demande active, on scanne directement.

  console.log(`[usa] ${requestStatus.message} — lancement scan créneaux via API directe...`);
  botLog({
    applicationId: job.id,
    step: "login",
    status: "ok",
    data: {
      username,
      applicationId: session.applicationId,
      missionId: session.missionId,
      allowedOfcs: session.allowedOfcs?.map((o) => o.postUserId) ?? [],
    },
  });

  try {
    const slotResult = await scanUsaSlotsViaAPI(job, session);
    result = slotResult;
    return result;
  } finally {
    setUsaSessionProxy(undefined);
    // Note: NE PAS libérer le sticky proxy ici — on le garde pour le prochain cycle
    // du même compte. Le proxy sera automatiquement libéré après expiration (30 min).
    // proxyPool.releaseStickyProxy(username) → seulement si logout explicite.
  }
} catch (error) {
  console.error("[usa] Erreur inattendue dans runUsaApiSession:", error);
  result = "error";
} finally {
  // ── Logout conditionnel — ne PAS logout systématiquement en rush hour ──────
  // Problème : logout + re-login toutes les 2 min (rush) = trop de logins → restriction.
  // Solution : garder la session active entre les cycles si le prochain check est < 5 min.
  // Le portail considère les appels API comme activité → session non-idle.
  //
  // On logout SEULEMENT si :
  //   1. Le prochain check est dans > 5 min (inter-cycle long → risque session idle)
  //   2. Ou si le scan a échoué avec login_failed/error (session corrompue)
  //   3. Ou si l'intervalle tier n'est PAS tres_urgent/urgent (sessions longues = idle risk)
  const shouldLogout = result === "login_failed" || result === "error" ||
    (job.urgencyTier !== "tres_urgent" && job.urgencyTier !== "urgent");
  
  if (username && shouldLogout) {
    try {
      // Petite pause avant logout (un humain ne clique pas "déconnexion" instantanément)
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      await logoutUsaPortal(username);
      botLog({
        applicationId: job.id,
        step: "logout",
        status: "ok",
        data: { username, sessionDurationMs: Date.now() - sessionStartTime, result },
      });
    } catch (logoutErr) {
      // Logout échoué — non bloquant, le token expirera naturellement
      console.warn(`[usa] Logout échoué (non bloquant): ${logoutErr}`);
    }
  } else if (username && !shouldLogout) {
    console.log(`[usa] 🔄 Session maintenue (tier=${job.urgencyTier}) — réutilisation token au prochain cycle`);
  }

  // Log la fin du comportement humain
  const sessionDuration = Date.now() - sessionStartTime;
  logHumanBehaviorEnd(job.id, `USA Portal - ${username}`, sessionDuration);
}
return result;
}

