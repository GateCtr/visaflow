import {
  tokenCache,
  usaFetch,
  getBrowserHeaders,
  hasUsaProxy,
  authHeaders,
} from "./usa-http.js";
import {
  USA_LOGIN_URL,
  USA_LOGOUT_URL,
  USA_REFRESH_URL,
  USA_MISSION_ID,
  REFERER_LOGIN,
  REFERER_DASHBOARD,
} from "./config.js";
import { RateLimitError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { encryptPortalCredentials } from "./crypto.js";
import type { UsaSession, UsaLoginResponse } from "./types.js";

/** Extrait un access token Cognito depuis un corps JSON (login ou refresh). */
function pickAccessTokenFromJsonBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const o = body as Record<string, unknown>;
  for (const k of ["accessToken", "AccessToken", "access_token"]) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v.trim();
  }
  const ar = o.AuthenticationResult;
  if (ar && typeof ar === "object") {
    const at = (ar as Record<string, unknown>).AccessToken;
    if (typeof at === "string" && at.length > 0) return at.trim();
  }
  return "";
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
        headers: authHeaders(cached.accessToken, REFERER_DASHBOARD, false),
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

  if (process.env.USA_DEBUG_LOGIN_JSON === "1") {
    console.warn(`[usa] DEBUG login JSON (tronqué): ${JSON.stringify(data).slice(0, 1500)}`);
    console.warn(`[usa] DEBUG login header names: ${[...response.headers.keys()].join(", ")}`);
  }

  const stripBearer = (t: string | null | undefined): string => {
    if (!t) return "";
    return t.trim().replace(/^Bearer\s+/i, "").trim();
  };

  // CORRECTION : D'après la capture manuelle, le token est dans le header Authorization
  // sans préfixe "Bearer ", et le body JSON a accessToken: null
  // Le token est un token ID (token_use: "id") mais fonctionne pour l'authentification API
  let accessToken = "";
  let refreshToken = "";
  
  // 1. Essayer d'abord le header Authorization
  const authHeader = response.headers.get("authorization");
  if (authHeader) {
    // Le header peut contenir "Bearer " ou pas - on le normalise
    accessToken = stripBearer(authHeader);
    console.log(`[usa] Token extrait du header Authorization (${accessToken.length} chars)`);
  }
  
  // 2. Fallback : essayer le body JSON (pour compatibilité)
  if (!accessToken) {
    accessToken =
      stripBearer(pickAccessTokenFromJsonBody(data))
      || stripBearer(typeof data.accessToken === "string" ? data.accessToken : "");
  }
  
  // 3. Refresh token depuis le header
  const refreshHeader = response.headers.get("refreshtoken");
  if (refreshHeader) {
    refreshToken = stripBearer(refreshHeader);
    console.log(`[usa] Refresh token extrait du header RefreshToken (${refreshToken.length} chars)`);
  }

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
        // Le refresh peut renvoyer l’access token dans le corps JSON (Cognito) alors que le header
        // ne porte que l’id token — lire le corps en priorité.
        if (refreshRes.ok) {
          const refreshTxt = await refreshRes.text();
          let refreshParsed: unknown = null;
          try {
            refreshParsed = JSON.parse(refreshTxt) as unknown;
          } catch {
            /* corps vide ou non-JSON */
          }
          const fromRefreshBody = stripBearer(pickAccessTokenFromJsonBody(refreshParsed));
          if (process.env.USA_DEBUG_LOGIN_JSON === "1") {
            console.warn(`[usa] DEBUG refresh corps (tronqué): ${refreshTxt.slice(0, 1200)}`);
          }
          if (fromRefreshBody) {
            accessToken = fromRefreshBody;
            console.log("[usa] JWT access depuis corps JSON /refreshToken (préféré au header)");
          } else {
            const newAccess = refreshRes.headers.get("authorization");
            if (newAccess && stripBearer(newAccess) !== stripBearer(accessToken)) {
              accessToken = stripBearer(newAccess);
              console.log("[usa] JWT access pivoté après refresh post-login (cohérence session)");
            }
          }
          const newRefresh = refreshRes.headers.get("refreshtoken");
          if (newRefresh) {
            refreshToken = stripBearer(newRefresh);
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
