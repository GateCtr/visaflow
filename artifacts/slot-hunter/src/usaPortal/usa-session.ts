import {
  tokenCache,
  pendingLogin,
  parseJwtExpiry,
  isCachedTokenValid,
  isSessionInCooldown,
  getTimeUntilNextLogin,
} from "./usa-http.js";
import { loginUsaPortal } from "./usa-auth.js";
import type { UsaSession } from "./types.js";
import { USA_MISSION_ID } from "./config.js";
import { AccountRestrictedError } from "./errors.js";
import {
  isAccountRestricted,
  markAccountRestricted,
  getAccountRestrictionDeadline,
} from "./account-restriction.js";

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
    const now = Date.now();
    
    // Vérifier si le token est encore valide pour les scans
    if (isCachedTokenValid(cached)) {
      const remainingMin = Math.round((cached.expiresAt - now) / 60000);
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

    // Vérifier si on est en phase de cooldown
    if (isSessionInCooldown(cached)) {
      const timeUntilNextLogin = getTimeUntilNextLogin(cached);
      const remainingCooldownMin = Math.round(timeUntilNextLogin / 60000);
      console.log(`[usa] Session en cooldown pour ${cached.fullName} — ${remainingCooldownMin} min avant prochain login`);
      return null; // Retourner null pour indiquer qu'il faut attendre
    }

    // Token expiré et pas en cooldown → re-login complet
    console.log("[usa] Token expiré — re-login complet au lieu de refresh (évite 401 en cascade)");
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
