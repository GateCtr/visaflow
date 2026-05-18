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
import { USA_MISSION_ID, MIN_COOLDOWN_AFTER_EXPIRY_MS, MAX_COOLDOWN_AFTER_EXPIRY_MS, PROXY_EXPIRY_BUFFER_MS } from "./config.js";
import { AccountRestrictedError } from "./errors.js";
import {
  isAccountRestricted,
  markAccountRestricted,
  getAccountRestrictionDeadline,
} from "./account-restriction.js";
import { canLogin, recordLogin } from "../v3/core/session-pool.js";

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

    // ── Guard proxy-expiry cooldown ─────────────────────────────────────────
    // Si le token est invalide à cause de l'expiration PROXY (pas du JWT),
    // on doit quand même respecter un cooldown avant le re-login.
    // Sans ça : proxy expire à 55 min, JWT valide jusqu'à 60 min → re-login
    // IMMÉDIAT à 55 min = interval réduit entre sessions = trigger restriction.
    // Solution : imposer un cooldown minimum de 8 min après invalidation proxy.
    if (cached.proxyExpiresAt && now >= cached.proxyExpiresAt - PROXY_EXPIRY_BUFFER_MS) {
      // Le proxy est mort OU va mourir dans le buffer — vérifier le cooldown.
      // IMPORTANT: isCachedTokenValid() invalide le token AVANT l'expiration réelle
      // (buffer de 2-5 min). Sans ce check élargi, le code fait un re-login immédiat
      // pendant le buffer → changement d'IP rapide → restriction Cognito.
      const effectiveDeathTime = cached.proxyExpiresAt - PROXY_EXPIRY_BUFFER_MS;
      const timeSinceInvalidation = now - effectiveDeathTime;
      const proxyDeathCooldownMs = MIN_COOLDOWN_AFTER_EXPIRY_MS + 
        Math.random() * (MAX_COOLDOWN_AFTER_EXPIRY_MS - MIN_COOLDOWN_AFTER_EXPIRY_MS);
      
      if (timeSinceInvalidation < proxyDeathCooldownMs) {
        const remainingMs = proxyDeathCooldownMs - timeSinceInvalidation;
        const remainingMin = Math.round(remainingMs / 60000);
        console.log(`[usa] 🔒 Proxy expiré/expirant — cooldown ${remainingMin} min avant re-login (évite restriction)`);
        return null; // Attendre le cooldown
      }
      // Cooldown terminé → OK pour re-login avec nouvelle IP
      console.log(`[usa] ✅ Cooldown proxy terminé — re-login autorisé avec nouvelle IP`);
    }

    // Token expiré et pas en cooldown → re-login complet
    console.log("[usa] Token expiré — re-login complet au lieu de refresh (évite 401 en cascade)");
    tokenCache.delete(cacheKey);
  }

  // ── Guard budget V3 — vérifier le quota AVANT tout login ────────────────────
  // Le session-pool compte TOUS les logins (ici + accounts-keep-alive).
  // Si le budget est épuisé → retourner null (comme un cooldown).
  const loginDecision = canLogin(username);
  if (!loginDecision.allowed) {
    const waitMin = Math.round(loginDecision.waitMs / 60_000);
    console.warn(`[usa] 🚫 Budget login REFUSÉ pour ${username}: ${loginDecision.reason} — attente ${waitMin} min`);
    return null;
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
      
      // ── FIX 5 : Proxy 504 post-CAPTCHA → 1 retry avec même sticky ──────────
      // Si le login échoue à cause d'un proxy 504/tunnel error JUSTE après le CAPTCHA,
      // retry 1x avec le même proxy sticky URL. Le 504 est souvent un glitch temporaire
      // du tunnel (pas un changement d'IP). Si retry échoue → rotation + reschedule.
      const isProxy504 = msg.includes("504") || msg.includes("tunnel") || msg.includes("Proxy") || msg.includes("ECONNRESET");
      if (isProxy504) {
        console.warn(`[usa] ⚠️ FIX5: Proxy 504/tunnel error au login — 1 retry avec même sticky...`);
        try {
          // Petite pause avant retry (500-1500ms) — glitch temporaire
          await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
          session = await loginUsaPortal(username, password, null);
          if (session) {
            console.log(`[usa] ✅ FIX5: Retry login réussi après 504 — session obtenue`);
          }
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          console.error(`[usa] ❌ FIX5: Retry login aussi échoué: ${retryMsg} — rotation IP au prochain cycle`);
          throw new Error(`Login USA échoué (retry 504): ${retryMsg}`);
        }
      } else {
        throw new Error(`Login USA échoué: ${msg}`);
      }
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

    // ── V3 : Enregistrer le login réussi dans le budget global ────────────────
    recordLogin(username, loginDecision.phase);

    return session;
  })();

  pendingLogin.set(cacheKey, loginPromise);
  return loginPromise;
}
