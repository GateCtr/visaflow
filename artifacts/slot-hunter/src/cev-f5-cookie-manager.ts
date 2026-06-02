/**
 * cev-f5-cookie-manager.ts — Gestion des cookies F5 BIG-IP TS01*
 * 
 * Système centralisé pour :
 * 1. Stocker les cookies F5 siphonnés (TS0110ceb4 + ASP.NET_SessionId + User-Agent associé)
 * 2. Synchroniser le User-Agent entre génération et utilisation
 * 3. Gérer la rotation et expiration des cookies
 */

export interface F5CookieSession {
  // Cookies F5
  tsCookie: {
    name: string;  // "TS0110ceb4"
    value: string;
    domain: string; // ".visaonweb.diplomatie.be"
  };
  
  // Cookies de session
  aspNetSessionId: string;  // Valeur du cookie ASP.NET_SessionId
  preferredCulture: string; // "en-US" ou "fr-BE"
  
  // Métadonnées de synchronisation
  userAgent: string;        // User-Agent utilisé pour générer le cookie
  extractedAt: number;      // Timestamp d'extraction
  validUntil: number;       // Timestamp d'expiration (estimé 30-60 min)
  
  // Identifiants
  vowintEmail?: string;     // Email VOWINT associé (optionnel)
  identifier: string;       // Identifiant unique de session
}

export class F5CookieManager {
  private static instance: F5CookieManager;
  private sessions: Map<string, F5CookieSession> = new Map();
  
  private constructor() {}
  
  static getInstance(): F5CookieManager {
    if (!F5CookieManager.instance) {
      F5CookieManager.instance = new F5CookieManager();
    }
    return F5CookieManager.instance;
  }
  
  /**
   * Enregistre une session F5 siphonnée
   */
  registerSession(session: F5CookieSession): void {
    this.sessions.set(session.identifier, session);
    console.log(`[F5-Cookie] ✅ Session enregistrée: ${session.identifier} (expire dans ${Math.round((session.validUntil - Date.now()) / 60000)} min)`);
  }
  
  /**
   * Récupère une session F5 valide
   */
  getValidSession(identifier?: string): F5CookieSession | null {
    const now = Date.now();
    
    // Si identifiant spécifié
    if (identifier && this.sessions.has(identifier)) {
      const session = this.sessions.get(identifier)!;
      if (now < session.validUntil) {
        return session;
      } else {
        console.log(`[F5-Cookie] ⚠️ Session ${identifier} expirée`);
        this.sessions.delete(identifier);
      }
    }
    
    // Sinon, première session valide
    for (const [id, session] of this.sessions) {
      if (now < session.validUntil) {
        return session;
      } else {
        this.sessions.delete(id);
      }
    }
    
    return null;
  }
  
  /**
   * Génère le header Cookie complet pour une requête CEV
   */
  getCookieHeader(session: F5CookieSession): string {
    const cookies = [
      `${session.tsCookie.name}=${session.tsCookie.value}`,
      `ASP.NET_SessionId=${session.aspNetSessionId}`,
      `PreferredCulture=${session.preferredCulture}`
    ];
    return cookies.join('; ');
  }
  
  /**
   * Nettoie les sessions expirées
   */
  cleanupExpiredSessions(): number {
    const now = Date.now();
    const expired = Array.from(this.sessions.entries())
      .filter(([_, session]) => now >= session.validUntil);
    
    expired.forEach(([id, _]) => this.sessions.delete(id));
    
    if (expired.length > 0) {
      console.log(`[F5-Cookie] 🗑️ Nettoyé ${expired.length} session(s) expirée(s)`);
    }
    
    return expired.length;
  }
  
  /**
   * Liste toutes les sessions (pour debug)
   */
  listSessions(): Array<{identifier: string, validForMinutes: number, userAgent: string}> {
    const now = Date.now();
    return Array.from(this.sessions.entries()).map(([id, session]) => ({
      identifier: id,
      validForMinutes: Math.max(0, Math.round((session.validUntil - now) / 60000)),
      userAgent: session.userAgent.slice(0, 50) + '...'
    }));
  }
}

/**
 * Fonction utilitaire pour créer une session F5 à partir de cookies extraits
 */
export function createF5SessionFromExtracted(
  tsCookieValue: string,
  aspNetSessionId: string,
  userAgent: string,
  options?: {
    identifier?: string;
    vowintEmail?: string;
    preferredCulture?: string;
    validityMinutes?: number;
  }
): F5CookieSession {
  const now = Date.now();
  const validityMinutes = options?.validityMinutes ?? 45; // 45 min par défaut
  
  return {
    tsCookie: {
      name: 'TS0110ceb4',
      value: tsCookieValue,
      domain: '.visaonweb.diplomatie.be'
    },
    aspNetSessionId,
    preferredCulture: options?.preferredCulture ?? 'en-US',
    userAgent,
    extractedAt: now,
    validUntil: now + (validityMinutes * 60 * 1000),
    vowintEmail: options?.vowintEmail,
    identifier: options?.identifier ?? `f5-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
  };
}

/**
 * Fonction utilitaire pour extraire les cookies depuis un objet de capture
 */
export function extractF5CookiesFromCapture(captureData: any): {
  tsCookieValue?: string;
  aspNetSessionId?: string;
  userAgent?: string;
} {
  const result: any = {};
  
  // Chercher dans les cookies capturés
  if (captureData.cookiesAtMoment && Array.isArray(captureData.cookiesAtMoment)) {
    for (const cookie of captureData.cookiesAtMoment) {
      if (cookie.name === 'TS0110ceb4') {
        result.tsCookieValue = cookie.value;
      }
      if (cookie.name === 'ASP.NET_SessionId') {
        result.aspNetSessionId = cookie.value;
      }
    }
  }
  
  // Chercher dans les headers
  if (captureData.requestHeaders && captureData.requestHeaders['user-agent']) {
    result.userAgent = captureData.requestHeaders['user-agent'];
  }
  
  return result;
}