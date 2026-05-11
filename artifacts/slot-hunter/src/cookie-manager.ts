import type { BrowserContext } from "playwright";
import fs from 'fs';
import path from 'path';

export interface CloudflareCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  capturedAt: number;
  source: 'manual' | 'automatic' | 'capsolver';
  validFor: string[]; // Domaines où le cookie est valide
}

export interface CookiePool {
  cookies: CloudflareCookie[];
  lastUpdated: number;
  version: number;
}

export class CookieManager {
  private cookieFile: string;
  private pool: CookiePool;
  
  constructor(cookieDir: string = './cookies') {
    // Créer le répertoire si nécessaire
    if (!fs.existsSync(cookieDir)) {
      fs.mkdirSync(cookieDir, { recursive: true });
    }
    
    this.cookieFile = path.join(cookieDir, 'cf-cookie-pool.json');
    this.pool = this.loadPool();
  }
  
  private loadPool(): CookiePool {
    try {
      if (fs.existsSync(this.cookieFile)) {
        const data = fs.readFileSync(this.cookieFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.warn("[cookie-manager] Erreur chargement pool:", error);
    }
    
    // Pool vide par défaut
    return {
      cookies: [],
      lastUpdated: Date.now(),
      version: 1,
    };
  }
  
  private savePool(): void {
    try {
      this.pool.lastUpdated = Date.now();
      fs.writeFileSync(this.cookieFile, JSON.stringify(this.pool, null, 2), 'utf8');
    } catch (error) {
      console.error("[cookie-manager] Erreur sauvegarde pool:", error);
    }
  }
  
  /**
   * Ajoute un cookie au pool
   */
  addCookie(cookie: Omit<CloudflareCookie, 'capturedAt'>): void {
    const newCookie: CloudflareCookie = {
      ...cookie,
      capturedAt: Date.now(),
    };
    
    // Vérifier si le cookie existe déjà
    const existingIndex = this.pool.cookies.findIndex(
      c => c.name === cookie.name && c.domain === cookie.domain
    );
    
    if (existingIndex >= 0) {
      this.pool.cookies[existingIndex] = newCookie;
    } else {
      this.pool.cookies.push(newCookie);
    }
    
    this.savePool();
    console.log(`[cookie-manager] Cookie ${cookie.name} ajouté/mis à jour`);
  }
  
  /**
   * Charge les cookies capturés manuellement
   */
  loadManualCookies(captureDir: string = './cloudflare-capture'): number {
    const cookiesPath = path.join(captureDir, 'cookies.json');
    
    if (!fs.existsSync(cookiesPath)) {
      console.warn(`[cookie-manager] Fichier non trouvé: ${cookiesPath}`);
      return 0;
    }
    
    try {
      const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      let loaded = 0;
      
      for (const cookie of cookiesData) {
        if (cookie.name === 'cf_clearance') {
          this.addCookie({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain || '.citaconsular.es',
            path: cookie.path || '/',
            expires: cookie.expires || Math.floor(Date.now() / 1000) + 7200,
            httpOnly: cookie.httpOnly !== false,
            secure: cookie.secure !== false,
            sameSite: cookie.sameSite || 'None',
            source: 'manual',
            validFor: ['citaconsular.es', 'www.citaconsular.es'],
          });
          loaded++;
        }
      }
      
      console.log(`[cookie-manager] ${loaded} cookies manuels chargés`);
      return loaded;
      
    } catch (error) {
      console.error("[cookie-manager] Erreur chargement cookies manuels:", error);
      return 0;
    }
  }
  
  /**
   * Trouve le meilleur cookie valide pour un domaine
   */
  getBestCookie(domain: string): CloudflareCookie | null {
    const now = Math.floor(Date.now() / 1000);
    
    // Filtrer les cookies valides
    const validCookies = this.pool.cookies.filter(cookie => {
      // Vérifier l'expiration
      if (cookie.expires < now) {
        return false;
      }
      
      // Vérifier le domaine
      if (!this.matchesDomain(cookie.domain, domain)) {
        return false;
      }
      
      return true;
    });
    
    if (validCookies.length === 0) {
      return null;
    }
    
    // Trier par: 1) source (manual > automatic > capsolver), 2) expiration la plus lointaine
    validCookies.sort((a, b) => {
      const sourcePriority: Record<string, number> = {
        'manual': 3,
        'automatic': 2,
        'capsolver': 1,
      };
      
      const priorityA = sourcePriority[a.source] || 0;
      const priorityB = sourcePriority[b.source] || 0;
      
      if (priorityB !== priorityA) {
        return priorityB - priorityA;
      }
      
      return b.expires - a.expires;
    });
    
    return validCookies[0];
  }
  
  /**
   * Vérifie si un cookie correspond à un domaine
   */
  private matchesDomain(cookieDomain: string, targetDomain: string): boolean {
    // Normaliser les domaines
    const normCookie = cookieDomain.startsWith('.') ? cookieDomain.slice(1) : cookieDomain;
    const normTarget = targetDomain.startsWith('.') ? targetDomain.slice(1) : targetDomain;
    
    // Domaine exact
    if (normCookie === normTarget) {
      return true;
    }
    
    // Sous-domaine
    if (cookieDomain.startsWith('.') && normTarget.endsWith(normCookie)) {
      return true;
    }
    
    // Vérifier dans validFor
    const cookie = this.pool.cookies.find(c => c.domain === cookieDomain);
    if (cookie && cookie.validFor) {
      return cookie.validFor.some(d => 
        d === targetDomain || 
        (d.startsWith('.') && targetDomain.endsWith(d.slice(1)))
      );
    }
    
    return false;
  }
  
  /**
   * Applique le meilleur cookie à un contexte Playwright
   */
  async applyBestCookie(context: BrowserContext, domain: string): Promise<boolean> {
    const cookie = this.getBestCookie(domain);
    
    if (!cookie) {
      console.log(`[cookie-manager] Aucun cookie valide pour ${domain}`);
      return false;
    }
    
    try {
      // Nettoyer les cookies existants pour le domaine
      const existingCookies = await context.cookies();
      const cookiesToRemove = existingCookies.filter(c => 
        c.name === cookie.name && this.matchesDomain(c.domain, domain)
      );
      
      if (cookiesToRemove.length > 0) {
        await context.clearCookies();
      }
      
      // Ajouter le nouveau cookie
      await context.addCookies([{
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }]);
      
      console.log(`[cookie-manager] Cookie appliqué: ${cookie.name}=${cookie.value.slice(0, 20)}...`);
      console.log(`[cookie-manager] Expire: ${new Date(cookie.expires * 1000).toLocaleString()}`);
      console.log(`[cookie-manager] Source: ${cookie.source}`);
      
      return true;
      
    } catch (error) {
      console.error("[cookie-manager] Erreur application cookie:", error);
      return false;
    }
  }
  
  /**
   * Capture les cookies actuels d'un contexte Playwright
   */
  async captureCookies(context: BrowserContext, source: 'automatic' | 'manual' = 'automatic'): Promise<number> {
    try {
      const cookies = await context.cookies();
      const cfCookies = cookies.filter(c => c.name.startsWith('cf_'));
      
      if (cfCookies.length === 0) {
        console.log("[cookie-manager] Aucun cookie Cloudflare à capturer");
        return 0;
      }
      
      let captured = 0;
      
      for (const cookie of cfCookies) {
        this.addCookie({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires || Math.floor(Date.now() / 1000) + 7200,
          httpOnly: cookie.httpOnly || true,
          secure: cookie.secure !== false,
          sameSite: cookie.sameSite as 'Strict' | 'Lax' | 'None' || 'None',
          source,
          validFor: [cookie.domain],
        });
        captured++;
      }
      
      console.log(`[cookie-manager] ${captured} cookies Cloudflare capturés`);
      return captured;
      
    } catch (error) {
      console.error("[cookie-manager] Erreur capture cookies:", error);
      return 0;
    }
  }
  
  /**
   * Nettoie les cookies expirés
   */
  cleanupExpiredCookies(): number {
    const now = Math.floor(Date.now() / 1000);
    const initialCount = this.pool.cookies.length;
    
    this.pool.cookies = this.pool.cookies.filter(cookie => cookie.expires > now);
    
    const removed = initialCount - this.pool.cookies.length;
    
    if (removed > 0) {
      this.savePool();
      console.log(`[cookie-manager] ${removed} cookies expirés nettoyés`);
    }
    
    return removed;
  }
  
  /**
   * Statistiques du pool
   */
  getStats(): {
    total: number;
    valid: number;
    expired: number;
    bySource: Record<string, number>;
    byDomain: Record<string, number>;
  } {
    const now = Math.floor(Date.now() / 1000);
    
    const stats = {
      total: this.pool.cookies.length,
      valid: 0,
      expired: 0,
      bySource: {} as Record<string, number>,
      byDomain: {} as Record<string, number>,
    };
    
    for (const cookie of this.pool.cookies) {
      // Source
      stats.bySource[cookie.source] = (stats.bySource[cookie.source] || 0) + 1;
      
      // Domaine
      stats.byDomain[cookie.domain] = (stats.byDomain[cookie.domain] || 0) + 1;
      
      // Validité
      if (cookie.expires > now) {
        stats.valid++;
      } else {
        stats.expired++;
      }
    }
    
    return stats;
  }
  
  /**
   * Exporte les cookies pour un domaine
   */
  exportForDomain(domain: string): CloudflareCookie[] {
    const now = Math.floor(Date.now() / 1000);
    
    return this.pool.cookies.filter(cookie => 
      cookie.expires > now && this.matchesDomain(cookie.domain, domain)
    );
  }
  
  /**
   * Vérifie si un cookie valide existe pour un domaine
   */
  hasValidCookie(domain: string): boolean {
    return this.getBestCookie(domain) !== null;
  }
  
  /**
   * Durée de vie restante du meilleur cookie (en secondes)
   */
  getRemainingLifetime(domain: string): number {
    const cookie = this.getBestCookie(domain);
    if (!cookie) return 0;
    
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, cookie.expires - now);
  }
}

/**
 * Instance globale du gestionnaire de cookies
 */
export const cookieManager = new CookieManager();

/**
 * Fonction utilitaire pour initialiser avec les cookies manuels
 */
export function initializeCookieManager(): boolean {
  const loaded = cookieManager.loadManualCookies();
  cookieManager.cleanupExpiredCookies();
  
  const stats = cookieManager.getStats();
  console.log("[cookie-manager] Statistiques:", stats);
  
  return loaded > 0;
}

/**
 * Fonction utilitaire pour vérifier et appliquer les cookies
 */
export async function ensureCloudflareCookie(
  context: BrowserContext,
  domain: string = 'citaconsular.es'
): Promise<boolean> {
  // Initialiser avec les cookies manuels
  initializeCookieManager();
  
  // Vérifier si nous avons un cookie valide
  if (!cookieManager.hasValidCookie(domain)) {
    console.log(`[cookie-manager] Aucun cookie valide pour ${domain}`);
    return false;
  }
  
  // Appliquer le cookie
  return await cookieManager.applyBestCookie(context, domain);
}

/**
 * Fonction pour capturer manuellement un cookie (à appeler après résolution manuelle)
 */
export async function captureCurrentCookies(context: BrowserContext): Promise<boolean> {
  const captured = await cookieManager.captureCookies(context, 'manual');
  
  if (captured > 0) {
    const stats = cookieManager.getStats();
    console.log("[cookie-manager] Cookies capturés avec succès");
    console.log("[cookie-manager] Nouvelle statistique:", stats);
    return true;
  }
  
  return false;
}