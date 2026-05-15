import { ProxyAgent } from "undici";
import { Impit } from "impit";
import { proxyPool } from "../browser.js";
import { getVariableBrowserHeaders } from "../humanBehavior.js";
import { getDeviceConsistencyHeaders } from "./device-fingerprint.js";
import type { CachedToken, UsaSession } from "./types.js";
import {
  USA_REFRESH_URL,
  USA_LANDING_PAGE_URL,
  TOKEN_REFRESH_BUFFER_MS,
  MAX_AUTH_IDLE_MS,
  MAX_SESSION_ABSOLUTE_MS,
  PROXY_EXPIRY_BUFFER_MS,
  USA_MISSION_ID,
  REFERER_LOGIN,
  REFERER_DASHBOARD,
  REFERER_CREATE_APT,
  MIN_KEEP_ALIVE_INTERVAL_MS,
  MAX_KEEP_ALIVE_INTERVAL_MS,
} from "./config.js";

export const tokenCache = new Map<string, CachedToken>();

/**
 * Verrou de login concurrent : si deux jobs pour le même compte tentent un login simultané,
 * le deuxième attend la résolution du premier au lieu d'envoyer une 2e requête au serveur.
 * Deux logins simultanés peuvent déclencher un lockout côté portail.
 */
export const pendingLogin = new Map<string, Promise<UsaSession | null>>();

// ── Username de la session active (pour device fingerprint headers) ───────────
// Set par updateSessionActivity() à chaque cycle de scan.
// Utilisé par getBrowserHeaders() pour enrichir avec les device consistency headers.
let _activeSessionUsername: string | undefined;

export function parseJwtExpiry(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return 0;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return decoded.exp ? decoded.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export function isCachedTokenValid(cached: CachedToken): boolean {
  // Le jitter ±5 min est fixé au moment du login et conservé tout au long du JWT.
  // Résultat : chaque compte se reconnecte à un moment légèrement différent,
  // ce qui brise le pattern "login toutes les 55 min pile" détectable par le portail.
  const now = Date.now();

  // JWT lié à l’IP du login : invalider avant expiration du sticky proxy (évite 401 en cascade).
  if (cached.proxyExpiresAt && now >= cached.proxyExpiresAt - PROXY_EXPIRY_BUFFER_MS) {
    console.log(
      `[usa] Token invalidé : proxy expire dans ${Math.round((cached.proxyExpiresAt - now) / 1000)}s — re-login nécessaire avec nouvelle IP`,
    );
    return false;
  }

  // Inactivité API : portail ~15 min sans appel authentifié — on invalide à 13 min depuis
  // la dernière réponse OK avec ce Bearer (usaFetch met à jour lastActivityAt).
  const lastAct = cached.lastActivityAt ?? cached.sessionStartedAt;
  if (now - lastAct >= MAX_AUTH_IDLE_MS) {
    return false;
  }

  // Plafond absolu depuis login/refresh (indépendant de l’activité).
  const sessionAge = now - cached.sessionStartedAt;
  if (sessionAge >= MAX_SESSION_ABSOLUTE_MS) {
    return false;
  }

  return now < cached.expiresAt - TOKEN_REFRESH_BUFFER_MS - cached.jitterMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keep-alive : ping léger pour éviter le timeout d'inactivité serveur (15 min)
// ─────────────────────────────────────────────────────────────────────────────
// Le portail USA invalide les sessions côté serveur après ~15 min sans activité API.
// Ce keep-alive envoie un GET léger (getLandingPageDetails) à intervalles variables (5-12 min)
// pour maintenir la session active sans pattern détectable.


/**
 * Vérifie si un keep-alive est nécessaire et l'envoie si oui.
 * Appelé au début de chaque cycle de scan (runUsaApiSession) quand un token en cache est réutilisé.
 * Met à jour lastActivityAt dans le cache en cas de succès.
 * 
 * @returns true si le keep-alive a réussi (ou n'était pas nécessaire), false si la session est morte.
 */
export async function sendKeepAliveIfNeeded(cached: CachedToken, username: string): Promise<boolean> {
  const now = Date.now();
  const timeSinceActivity = now - cached.lastActivityAt;
  
  // Déterminer un intervalle de keep-alive variable pour cette session
  // Stocké dans le cache pour cohérence
  let keepAliveInterval = cached.keepAliveInterval;
  if (!keepAliveInterval) {
    // Nouvelle session : déterminer un intervalle aléatoire (5-12 min)
    keepAliveInterval = MIN_KEEP_ALIVE_INTERVAL_MS + Math.random() * (MAX_KEEP_ALIVE_INTERVAL_MS - MIN_KEEP_ALIVE_INTERVAL_MS);
    cached.keepAliveInterval = keepAliveInterval;
    const intervalMinutes = Math.round(keepAliveInterval / 60000);
    console.log(`[usa] ⏱️ Intervalle keep-alive variable: ${intervalMinutes}min`);
  }
  
  // Pas besoin si une activité récente (< intervalle variable)
  if (timeSinceActivity < keepAliveInterval) {
    return true;
  }

  const inactiveMin = Math.round(timeSinceActivity / 60000);
  const targetMin = Math.round(keepAliveInterval / 60000);
  console.log(`[usa] 🏓 Keep-alive nécessaire — ${inactiveMin}min (seuil: ${targetMin}min) depuis dernière activité`);

  try {
    // getLandingPageDetails est un endpoint léger que le portail Angular appelle
    // lors de la navigation normale (dashboard). Il ne déclenche pas d'action métier.
    const res = await usaFetch(USA_LANDING_PAGE_URL, {
      method: "GET",
      headers: authHeaders(cached.accessToken, REFERER_DASHBOARD, false),
    });

    if (res.status === 401) {
      // Session morte côté serveur — le keep-alive est arrivé trop tard
      console.warn(`[usa] 🏓 Keep-alive ÉCHOUÉ (401) — session expirée côté serveur après ${inactiveMin} min d'inactivité`);
      return false;
    }

    if (res.status === 429) {
      // Rate limit — pas grave, la requête a quand même été vue par le serveur
      console.warn(`[usa] 🏓 Keep-alive rate-limited (429) — session probablement encore active`);
      cached.lastActivityAt = now;
      return true;
    }

    if (res.ok || res.status < 500) {
      // Succès ou erreur client non-401 — la session est active
      console.log(`[usa] 🏓 Keep-alive OK — session maintenue active`);
      cached.lastActivityAt = now;
      return true;
    }

    // Erreur serveur 5xx — ne pas invalider la session, le serveur peut être temporairement down
    console.warn(`[usa] 🏓 Keep-alive HTTP ${res.status} — serveur en erreur, session non invalidée`);
    return true;
  } catch (err) {
    // Erreur réseau — proxy down ou timeout. Ne pas invalider immédiatement.
    console.warn(`[usa] 🏓 Keep-alive erreur réseau: ${err} — non bloquant`);
    return true;
  }
}

/**
 * Met à jour lastActivityAt après un appel API réussi.
 * Appelé depuis les fonctions de scan après chaque requête réussie.
 */
export function updateSessionActivity(username: string): void {
  const cacheKey = username.toLowerCase();
  _activeSessionUsername = cacheKey;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    cached.lastActivityAt = Date.now();
  }
}

export async function refreshUsaToken(cached: CachedToken, username: string): Promise<CachedToken | null> {
  // ── Guard proxy : le JWT est lié à l'IP du login. Si le proxy a expiré,
  // le refresh passera par une nouvelle IP → le serveur renverra 401.
  // Mieux vaut forcer un re-login complet avec la nouvelle IP assignée.
  if (cached.proxyExpiresAt && Date.now() >= cached.proxyExpiresAt) {
    console.warn(`[usa] Refresh AVORTÉ : proxy expiré — re-login complet nécessaire (nouvelle IP requise)`);
    return null;
  }
  // Vérifier aussi que le proxy sticky dans le pool n'a pas changé d'URL
  // (rotation forcée suite à restriction, par exemple).
  if (cached.proxyUrl) {
    const currentSticky = proxyPool.getStickyProxyInfo(username);
    if (currentSticky && currentSticky.proxy !== cached.proxyUrl) {
      console.warn(`[usa] Refresh AVORTÉ : IP proxy a changé (rotation détectée) — re-login complet nécessaire`);
      return null;
    }
  }

  console.log("[usa] Renouvellement token via refresh token...");
  try {
    // Bundle Angular : http.post(authURL+"/refreshToken", {refreshToken, username}, {observe:"response"})
    // Les deux champs sont requis — le portail vérifie la cohérence refreshToken↔compte.
    const res = await usaFetch(USA_REFRESH_URL, {
      method: "POST",
      // Le refresh est appelé depuis la session active — referer = dashboard
      // Content-Type obligatoire car le body est du JSON
      headers: {
        ...getBrowserHeaders(),
        "Content-Type": "application/json",
        "Referer": REFERER_DASHBOARD,
      },
      body: JSON.stringify({ refreshToken: cached.refreshToken, username }),
    });

    if (!res.ok) {
      console.warn(`[usa] Refresh token refusé (HTTP ${res.status}) — reconnexion complète requise`);
      return null;
    }

    const newAccessRaw = res.headers.get("authorization")?.trim().replace(/^Bearer\s+/i, "").trim() ?? "";
    const newRefreshRaw = res.headers.get("refreshtoken")?.trim().replace(/^Bearer\s+/i, "").trim();

    if (!newAccessRaw) {
      console.warn("[usa] Refresh: aucun token dans la réponse");
      return null;
    }

    const expiresAt = parseJwtExpiry(newAccessRaw) || Date.now() + 55 * 60 * 1000;
    console.log("[usa] Token renouvelé avec succès");

    return {
      accessToken: newAccessRaw,
      refreshToken: newRefreshRaw || cached.refreshToken,
      // Le CSRF token ne change pas lors du refresh (le bundle n'en capture pas un nouveau
      // dans fetchNewRefreshToken — seul l'Authorization header est sauvegardé).
      csrfToken: cached.csrfToken,
      expiresAt,
      userID: cached.userID,
      fullName: cached.fullName,
      // Proxy + UA hérités du token précédent — sticky pour toute la chaîne de refresh.
      uaIndex: cached.uaIndex,
      proxyUrl: cached.proxyUrl,
      // proxyExpiresAt hérité — l'IP n'a pas changé, l'expiration reste la même.
      proxyExpiresAt: cached.proxyExpiresAt,
      // Jitter conservé du login initial — la dispersion temporelle reste cohérente
      // sur toute la chaîne de refreshs d'un même compte.
      jitterMs: cached.jitterMs,
      // Réinitialiser les horodatages au refresh — nouveau JWT / nouvelle fenêtre absolue.
      sessionStartedAt: Date.now(),
      lastActivityAt: Date.now(),
      allowedOfcs: cached.allowedOfcs,
    };
  } catch (err) {
    console.warn("[usa] Erreur lors du refresh:", err);
    return null;
  }
}


export function authHeaders(
  accessToken: string,
  referer: string = REFERER_DASHBOARD,
  withBody = true
): Record<string, string> {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "").trim();
  const h: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization": `Bearer ${token}`,
    "Referer": referer,
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

// Version alternative sans "Bearer " prefix - à tester si les 401 persistent
export function authHeadersNoBearer(
  accessToken: string,
  referer: string = REFERER_DASHBOARD,
  withBody = true
): Record<string, string> {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "").trim();
  const h: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization": token, // Pas de "Bearer " prefix
    "Referer": referer,
  };
  if (withBody) h["Content-Type"] = "application/json";
  return h;
}

// ─── Pool UA Chrome/Edge pour les appels API USA ─────────────────────────────
// Le portail Angular envoie des requêtes depuis Chrome uniquement → pas de Firefox/Safari ici.
// Sec-CH-UA doit correspondre exactement à la version Chrome dans le User-Agent (cohérence).
// IMPORTANT : ne jamais inclure de headers CORS côté requête (Access-Control-Allow-*) —
// ce sont des headers de RÉPONSE que seul le serveur envoie, jamais le navigateur.
export const USA_UA_POOL: ReadonlyArray<{ ua: string; chUa: string; platform: string }> = [
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
  {
    ua:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"',
    platform: '"macOS"',
  },
  {
    ua:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    chUa:     '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="8"',
    platform: '"macOS"',
  },
  {
    ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    chUa:     '"Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="8"',
    platform: '"Windows"',
  },
];

// UA actif pour la session courante — STICKY par compte pour éviter la détection Cognito
let _sessionUa = USA_UA_POOL[1]; // Chrome/135 Windows par défaut

// Map compte → index UA pour maintenir le même fingerprint
const accountUaMap = new Map<string, number>();

export function pickSessionUa(): void {
  _sessionUa = USA_UA_POOL[Math.floor(Math.random() * USA_UA_POOL.length)];
  console.log(`[usa] UA session: ${_sessionUa.ua.match(/Chrome\/[\d.]+/)?.[0] ?? _sessionUa.ua.slice(0, 60)}`);
}

export function getStickyUaForAccount(username: string): number {
  const cacheKey = username.toLowerCase();
  
  if (accountUaMap.has(cacheKey)) {
    // Réutiliser le même UA pour ce compte
    const uaIndex = accountUaMap.get(cacheKey)!;
    _sessionUa = USA_UA_POOL[uaIndex];
    console.log(`[usa] 🔄 UA sticky réutilisé pour ${username}: Chrome/${_sessionUa.ua.match(/Chrome\/([\d.]+)/)?.[1]}`);
    return uaIndex;
  } else {
    // Nouveau compte → choisir un UA et le garder
    const uaIndex = Math.floor(Math.random() * USA_UA_POOL.length);
    accountUaMap.set(cacheKey, uaIndex);
    _sessionUa = USA_UA_POOL[uaIndex];
    console.log(`[usa] 📝 Nouveau UA sticky pour ${username}: Chrome/${_sessionUa.ua.match(/Chrome\/([\d.]+)/)?.[1]}`);
    return uaIndex;
  }
}

/** Génère un ID de corrélation de 15 caractères aléatoires comme le bundle Angular. */
function generateCorrelationId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 15; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ── Headers Accept-* FIXÉS PAR SESSION (pas par requête) ─────────────────────
// Un vrai navigateur Chrome envoie TOUJOURS les mêmes Accept-Encoding et Accept-Language
// pendant toute une session. Randomiser par requête = signal bot détectable par un WAF
// qui corrèle "même JWT mais Accept-Language change toutes les 3min".
// 
// Ces valeurs sont fixées au login (via initSessionHeaders) et gardées jusqu'au logout.
// Chaque compte a ses propres valeurs (sticky, comme le UA).
const SESSION_ENCODINGS = [
  "gzip, deflate, br, zstd",
  "gzip, deflate, br",
  "gzip, deflate, br",  // doublon volontaire — la majorité des Chrome envoient br
  "gzip, deflate, br, zstd",
];
const SESSION_LANGUAGES = [
  "fr-CD,fr;q=0.9,en-US;q=0.6,en;q=0.5",
  "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "fr;q=0.9,en-US;q=0.8,en;q=0.7",
  "fr-CD,fr;q=0.9,en-US;q=0.8,en;q=0.7",
];

// Map compte → headers fixés pour la session (Accept-Encoding, Accept-Language)
const sessionHeadersMap = new Map<string, { encoding: string; language: string }>();

/**
 * Initialise les headers de session pour un compte.
 * Appelé au login (1 fois) — les valeurs restent stables pendant toute la session.
 * Si déjà initialisé (session réutilisée), ne change rien.
 */
export function initSessionHeaders(username: string): void {
  const key = username.toLowerCase();
  if (sessionHeadersMap.has(key)) return; // déjà initialisé
  
  // Choix déterministe basé sur le hash du username (même valeurs après redéploiement)
  let hash = 0;
  for (const ch of key) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
  
  const encoding = SESSION_ENCODINGS[hash % SESSION_ENCODINGS.length];
  const language = SESSION_LANGUAGES[(hash >> 4) % SESSION_LANGUAGES.length];
  
  sessionHeadersMap.set(key, { encoding, language });
}

/** Retourne les headers Accept-* fixés pour la session active. */
function getSessionAcceptHeaders(): { encoding: string; language: string } {
  if (_activeSessionUsername && sessionHeadersMap.has(_activeSessionUsername)) {
    return sessionHeadersMap.get(_activeSessionUsername)!;
  }
  // Fallback si pas de session active (pre-login) : valeurs par défaut Chrome
  return { encoding: "gzip, deflate, br, zstd", language: "fr-CD,fr;q=0.9,en-US;q=0.8,en;q=0.7" };
}

export function getBrowserHeaders(jobId?: string): Record<string, string> {
  // Headers Accept-* FIXÉS pour la durée de la session (pas randomisés par requête)
  const { encoding, language } = getSessionAcceptHeaders();
  
  const baseHeaders = {
    "Accept":             "application/json, text/plain, */*",
    "Accept-Encoding":    encoding,
    "Accept-Language":    language,
    "Cache-Control":      "no-cache",
    // NOTE : LanguageId N'est PAS ajouté ici.
    // L'intercepteur Angular ne l'envoie QUE pour /getLandingPageDeatils et /generatewizardtemplate.
    // Toutes les autres requêtes (slots, booking, login…) NE reçoivent PAS ce header.
    // → ajouté explicitement dans callLandingPage() uniquement.
    "Pragma":             "no-cache",
    "Origin":             "https://www.usvisaappt.com",
    "Referer":            REFERER_LOGIN,
    "Sec-CH-UA":          _sessionUa.chUa,
    "Sec-CH-UA-Mobile":   "?0",
    "Sec-CH-UA-Platform": _sessionUa.platform,
    "Sec-Fetch-Dest":     "empty",
    "Sec-Fetch-Mode":     "cors",
    "Sec-Fetch-Site":     "same-origin",
    "User-Agent":         _sessionUa.ua,
    // Bundle Angular : X-Correlation-key présent sur toutes les requêtes authentifiées
    "X-Correlation-key":  generateCorrelationId(),
  };
  
  // Ajouter de la variabilité humaine aux headers
  const withVariability = getVariableBrowserHeaders(baseHeaders, jobId);

  // ── Device fingerprint headers — cohérence anti-WAF préventive ──────────────
  // Si un username de session est actif, enrichir avec des headers stables par compte.
  // Ces headers imitent les Client Hints étendus que Chrome envoie quand le serveur
  // les demande (Accept-CH). Même si le portail ne les requiert pas encore, leur
  // présence renforce la cohérence du "navigateur" simulé face à un futur WAF.
  if (_activeSessionUsername) {
    const deviceHeaders = getDeviceConsistencyHeaders(_activeSessionUsername);
    Object.assign(withVariability, deviceHeaders);
  }

  return withVariability;
}

// ─── Proxy résidentiel pour les appels API USA ────────────────────────────────
// Utilise undici ProxyAgent pour router les requêtes via un proxy résidentiel.
// setUsaSessionProxy() est appelé au début de runUsaApiSession() et réinitialisé à la fin.
let _usaProxyAgent: ProxyAgent | undefined;
let _usaProxyUrl: string | undefined;

/**
 * Génère une URL iProyal avec session sticky.
 * iProyal fournit des URLs avec format: host:port:user:password_session-xxx_lifetime-30m
 * Si l'URL de base ne contient pas déjà _session-, on en ajoute un.
 * Si elle en contient déjà, on la retourne telle quelle.
 * 
 * ROTATION IP (anti-Fraud Control) :
 * Le session ID est dérivé de la demi-journée actuelle (AM/PM) + username.
 * → Même IP pendant 12h (stable pour le JWT), nouvelle IP à chaque changement de demi-journée.
 * Changements à ~00h00 UTC et ~12h00 UTC. SAFE car :
 *   - Les sessions durent 30-120min max (puis logout force un releaseStickyProxy)
 *   - Le changement de sessionId ne prend effet qu'au prochain login (après release)
 *   - Le JWT en cache garde l'ancien proxyUrl → pas de 401 mid-session
 * Cela évite qu'une même IP résidentielle soit utilisée 20h/jour pendant des semaines.
 */
export function makeIproyalStickyUrl(baseUrl: string, lifetimeMinutes: number = 60, username?: string): string {
  try {
    const parsed = new URL(baseUrl);
    let password = decodeURIComponent(parsed.password);
    
    // Supprimer l'ancienne session sticky si présente (force une nouvelle session ID)
    // Cas : re-login après 401/504 — l'ancienne session iProyal est morte,
    // il faut en créer une nouvelle même si on est dans la même demi-journée.
    if (password.includes("_session-") && password.includes("_lifetime-")) {
      password = password.replace(/_session-[^_]+_lifetime-\d+m/, "");
    }
    
    // ── Générer un session ID stable par demi-journée + compte (rotation IP toutes les 12h) ──
    // Hash déterministe : même demi-journée + même username → même session ID → même IP.
    // Changement à ~00h00 UTC et ~12h00 UTC → nouvelle IP résidentielle.
    // On ajoute un compteur de rotation pour forcer une nouvelle IP après un 401/504.
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _iproyalRotationCount.get((username ?? "default").toLowerCase()) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${(username ?? "default").toLowerCase()}:iproyal-rotate:r${rotationCount}`;
    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
    // Convertir en base62 (8 chars) — même format que l'ancien random
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 62];
      h = Math.floor(h / 62) + (i + 1) * 7; // Ajout pour avoir 8 chars distincts
    }
    
    password += `_session-${sessionId}_lifetime-${lifetimeMinutes}m`;
    parsed.password = encodeURIComponent(password);
    console.log(`[usa] 🔒 Proxy sticky activé: session=${sessionId}, lifetime=${lifetimeMinutes}m (rotation toutes les 12h — ${halfDay}, rot#${rotationCount})`);
    return parsed.toString();
  } catch {
    // Si le parsing d'URL échoue, retourner l'URL d'origine
    console.warn(`[usa] ⚠️ Impossible de parser l'URL proxy — fallback`);
    return baseUrl;
  }
}

/** Compteur de rotation iProyal par compte — incrémenté après un 401/504 pour forcer une nouvelle IP. */
const _iproyalRotationCount = new Map<string, number>();

/**
 * Force la rotation du proxy iProyal pour un compte donné.
 * Appelé après un 401 ou ProxyTunnelError (504) pour obtenir une nouvelle IP au prochain login.
 */
export function rotateIproyalSession(username: string): void {
  const key = username.toLowerCase();
  const current = _iproyalRotationCount.get(key) ?? 0;
  _iproyalRotationCount.set(key, current + 1);
  console.log(`[usa] 🔄 Rotation proxy iProyal demandée pour ${key.slice(0, 12)}… (rot#${current + 1})`);
}

export function setUsaSessionProxy(proxyUrl: string | undefined): void {
  if (proxyUrl) {
    _usaProxyUrl = proxyUrl;
    _usaProxyAgent = undefined; // On n'utilise plus ProxyAgent, on utilise impit avec proxyUrl
    const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`[usa] Proxy résidentiel actif (impit): ${masked}`);
  } else {
    _usaProxyUrl = undefined;
    _usaProxyAgent = undefined;
  }
}

/**
 * Fetch avec fingerprint TLS Chrome via impit (anti-détection JA3/JA4).
 * 
 * impit génère un handshake TLS identique à un vrai Chrome, rendant le bot
 * indistinguable d'un navigateur réel au niveau réseau (ciphers, ALPN, extensions TLS).
 * 
 * IMPORTANT : on NE laisse PAS impit gérer les headers HTTP — on les envoie nous-mêmes
 * via getBrowserHeaders() pour garder le contrôle exact sur Sec-CH-UA, Referer, cookies, etc.
 * impit est utilisé UNIQUEMENT pour le fingerprint TLS sous-jacent.
 * 
 * Mode sans proxy : connexion directe via IP Railway (fixe et stable).
 * Le serveur USA lie le JWT à l'IP — pas de changement mid-session.
 */

// Instance impit singleton — réutilisée pour toutes les requêtes USA.
// browser:"chrome" = fingerprint TLS du dernier Chrome supporté par impit.
// redirect:"follow" = suit les redirections comme un vrai navigateur.
let _impitInstance: InstanceType<typeof Impit> | undefined;
let _impitProxyUrl: string | undefined;

function getImpitInstance(proxyUrl?: string): InstanceType<typeof Impit> {
  // Si le proxy a changé, recréer l'instance impit
  if (!_impitInstance || (proxyUrl && proxyUrl !== _impitProxyUrl) || (!proxyUrl && _impitProxyUrl)) {
    const options: any = {
      browser: "chrome",
    };
    
    if (proxyUrl) {
      options.proxyUrl = proxyUrl;
      _impitProxyUrl = proxyUrl;
      const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
      console.log(`[usa] ✅ impit initialisé avec proxy: ${masked} (fingerprint TLS Chrome)`);
    } else {
      _impitProxyUrl = undefined;
      console.log("[usa] ✅ impit initialisé sans proxy (fingerprint TLS Chrome) — indétectable JA3/JA4");
    }
    
    _impitInstance = new Impit(options);
  }
  return _impitInstance;
}

/** Extrait le JWT Bearer des en-têtes de requête (formats Headers, tableau ou objet). */
function extractBearerFromHeaders(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const v = headers.get("Authorization") ?? headers.get("authorization");
    return v?.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
  }
  if (Array.isArray(headers)) {
    const row = headers.find(([k]) => k.toLowerCase() === "authorization");
    const v = row?.[1];
    return v?.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
  }
  const o = headers as Record<string, string>;
  const v = o.Authorization ?? o.authorization;
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
}

/** Met à jour lastActivityAt si la requête était authentifiée et la réponse OK. */
function touchCachedTokenActivity(headers: HeadersInit | undefined, res: Response): void {
  if (!res.ok) return;
  const bearer = extractBearerFromHeaders(headers);
  if (!bearer) return;
  for (const cached of tokenCache.values()) {
    if (cached.accessToken === bearer) {
      cached.lastActivityAt = Date.now();
      return;
    }
  }
}

export async function usaFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let res: Response;
  
  // ── Jitter réseau réaliste (anti-Bot Control) ─────────────────────────────
  // Un vrai navigateur a une latence variable : DNS lookup (10-50ms), TCP connect (20-80ms),
  // TLS handshake (30-100ms), rendering pause (50-200ms). Total = 50-400ms de "bruit" naturel.
  // Sans jitter : les requêtes partent à intervalle quasi-constant → signature de bot.
  // IMPORTANT : le jitter est AVANT la requête (simule le temps de "préparation" navigateur),
  // pas APRÈS (le temps de réponse serveur est déjà variable naturellement).
  const jitterMs = 30 + Math.random() * 170; // 30-200ms (léger, ne ralentit pas significativement)
  await new Promise(r => setTimeout(r, jitterMs));
  
  // Toujours utiliser impit pour le fingerprint TLS Chrome, avec ou sans proxy
  // impit supporte nativement les proxies via l'option proxyUrl
  const impit = getImpitInstance(_usaProxyUrl);
  res = await impit.fetch(url, options as Parameters<typeof impit.fetch>[1]) as unknown as Response;
  
  touchCachedTokenActivity(options.headers, res);
  return res;
}

export function sessionHeaders(
  accessToken: string,
  applicationId: string,
  missionId = USA_MISSION_ID,
  referer: string = REFERER_CREATE_APT,
  withBody = true
): Record<string, string> {
  return {
    ...authHeaders(accessToken, referer, withBody),
    "Cookie": `APP_ID_TOBE=${applicationId}; missionId=${missionId}`,
  };
}

export function setActiveSessionUaFromPoolIndex(i: number): void {
  _sessionUa = USA_UA_POOL[i];
}

export function hasUsaProxy(): boolean {
  return _usaProxyUrl !== undefined;
}

export function getActiveSessionUaLogLabel(): string {
  return _sessionUa.ua.match(/(?:Chrome|Edg)\/[\d.]+/)?.[0] ?? _sessionUa.ua.slice(0, 60);
}
