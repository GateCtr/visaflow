/**
 * cev-session-manager.ts — Gestionnaire de sessions CEV complètes
 *
 * Gère le cache des sessions CEV capturées via le flow Puppeteer complet.
 * Remplace le F5CookieManager pour le mode full-puppeteer (cev_full_puppeteer_mode=1).
 *
 * Différences clés vs F5CookieManager :
 *   - Stocke une FullCevSession (tous les cookies) au lieu d'un simple cookie F5
 *   - TTL réduit à 4h (sessions CEV expirent bien avant 24h)
 *   - Détection shadow ban via compteur no-slots (threshold=15)
 *   - Verrou par compte pour éviter les race conditions multi-dossiers
 */

// ─── Interface session complète ───────────────────────────────────────────────

export interface FullCevSession {
  // Cookies VOWINT (visaonweb.diplomatie.be) — extraits depuis Puppeteer
  f5CookieName: string;        // "TS0110ceb4"
  f5CookieValue: string;       // Valeur du cookie F5 BIG-IP
  serverId: string;            // Cookie "ServerId" (httpOnly — seulement via Puppeteer)
  osOnline: string;            // Cookie "OSOnline" (OutSystems session)
  culture: string;             // Cookie "_culture" (ex: "en-US")
  requestVerificationToken: string; // Cookie "__RequestVerificationToken"

  // Cookies CEV (appointment.cloud.diplomatie.be)
  aspNetSessionId: string;     // Cookie "ASP.NET_SessionId"
  preferredCulture: string;    // Cookie "PreferredCulture"

  // Données fonctionnelles
  integrationUrl: string;      // URL Integration/VOW/* pour polling direct
  appId: string;               // UUID du dossier VOWINT

  // Métadonnées de session
  userAgent: string;           // User-Agent du navigateur
  proxyUsed: string | null;    // URL proxy utilisé (masquée) ou null
  capturedAt: number;          // Timestamp de capture
  validUntil: number;          // Timestamp d'expiration (capturedAt + 4h)
  isFullSession: true;         // Flag pour distinguer des siphoned simples
  // Tous les cookies bruts Puppeteer — inclut BIGipServer, LastMRH_Session, rd, etc.
  rawCookies?: string[];
}

// ─── Cache interne ────────────────────────────────────────────────────────────

interface CachedSession {
  session: FullCevSession;
  noSlotsCount: number;        // Compteur no-slots consécutifs
}

/** TTL session : 4h (était 24h — sessions CEV expirent bien plus tôt) */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Seuil shadow ban : après N no-slots consécutifs → invalider la session.
 * Indique que le serveur retourne toujours "no slots" même quand il y en a
 * (comportement shadow ban).
 */
const SHADOW_BAN_THRESHOLD = 15;

// ─── Session Manager ──────────────────────────────────────────────────────────

class CevSessionManagerClass {
  private cache = new Map<string, CachedSession>();

  /**
   * Retourne la session en cache si valide, null sinon.
   */
  getSession(accountKey: string): FullCevSession | null {
    const cached = this.cache.get(accountKey);
    if (!cached) return null;

    if (Date.now() > cached.session.validUntil) {
      console.log(
        `[CevSessionManager] Session expirée pour ${accountKey.slice(0, 20)}… — suppression`,
      );
      this.cache.delete(accountKey);
      return null;
    }

    return cached.session;
  }

  /**
   * Stocke une nouvelle session.
   */
  storeSession(accountKey: string, session: FullCevSession): void {
    this.cache.set(accountKey, { session, noSlotsCount: 0 });
    const expiresInMin = Math.round((session.validUntil - Date.now()) / 60_000);
    console.log(
      `[CevSessionManager] ✅ Session stockée: ${accountKey.slice(0, 20)}… | appId=${session.appId.slice(0, 8)}… | expire dans ${expiresInMin}min`,
    );
  }

  /**
   * Enregistre un résultat "no slot" et vérifie le seuil shadow ban.
   * @returns true si la session a été invalidée (shadow ban détecté)
   */
  recordNoSlots(accountKey: string): boolean {
    const cached = this.cache.get(accountKey);
    if (!cached) return false;

    cached.noSlotsCount++;

    if (cached.noSlotsCount >= SHADOW_BAN_THRESHOLD) {
      console.warn(
        `[CevSessionManager] ⚠️ Shadow ban probable: ${cached.noSlotsCount} no-slots consécutifs pour ${accountKey.slice(0, 20)}… — session invalidée`,
      );
      this.cache.delete(accountKey);
      return true; // session invalidée → relancer Puppeteer
    }

    return false;
  }

  /**
   * Réinitialise le compteur no-slots (après un scan réussi ou slot trouvé).
   */
  resetNoSlots(accountKey: string): void {
    const cached = this.cache.get(accountKey);
    if (cached) cached.noSlotsCount = 0;
  }

  /**
   * Invalide explicitement une session (ex: HTTP 401, erreur proxy).
   */
  invalidate(accountKey: string): void {
    if (this.cache.has(accountKey)) {
      this.cache.delete(accountKey);
      console.log(
        `[CevSessionManager] 🗑️ Session invalidée: ${accountKey.slice(0, 20)}…`,
      );
    }
  }

  /**
   * Invalide toutes les sessions.
   */
  invalidateAll(): void {
    const count = this.cache.size;
    this.cache.clear();
    console.log(`[CevSessionManager] 🗑️ Toutes les sessions invalidées (${count} session(s))`);
  }

  /**
   * Retourne true si une session valide existe pour ce compte.
   */
  isValid(accountKey: string): boolean {
    return this.getSession(accountKey) !== null;
  }

  /**
   * Retourne les stats du cache pour monitoring.
   */
  getStats(): Array<{ accountKey: string; validForMin: number; noSlotsCount: number }> {
    const now = Date.now();
    return Array.from(this.cache.entries()).map(([key, cached]) => ({
      accountKey: key.slice(0, 20) + "…",
      validForMin: Math.max(0, Math.round((cached.session.validUntil - now) / 60_000)),
      noSlotsCount: cached.noSlotsCount,
    }));
  }
}

export const cevSessionManager = new CevSessionManagerClass();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Crée un objet compatible avec le type siphonedCreds du loop depuis une FullCevSession.
 * Utilisé pour passer la session complète à performScan / pollCevSlot.
 */
export function fullSessionToSiphoned(session: FullCevSession): {
  f5CookieValue: string;
  f5CookieName: string;
  aspNetSessionId: string;
  userAgent: string;
  validUntil: number;
  siphonedAt: number;
  integrationUrl: string;
  preferredCulture: string;
  serverId: string;
  osOnline: string;
  culture: string;
  isFullSession: true;
  rawCookies?: string[];
} {
  return {
    f5CookieValue:       session.f5CookieValue,
    f5CookieName:        session.f5CookieName,
    aspNetSessionId:     session.aspNetSessionId,
    userAgent:           session.userAgent,
    validUntil:          session.validUntil,
    siphonedAt:          session.capturedAt,
    integrationUrl:      session.integrationUrl,
    preferredCulture:    session.preferredCulture,
    serverId:            session.serverId,
    osOnline:            session.osOnline,
    culture:             session.culture,
    isFullSession:       true,
    rawCookies:          session.rawCookies,
  };
}
