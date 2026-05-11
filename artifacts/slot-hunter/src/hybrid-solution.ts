import type { Page, BrowserContext } from "playwright";
import { cookieManager, CloudflareCookie } from "./cookie-manager.js";
import { solveAndApplyCloudflareChallenge } from "./capsolver.js";
import { detectAndSolveTurnstileWithInjection } from "./captcha.js";

export interface HybridSolutionResult {
  success: boolean;
  method: 'manual-cookie' | 'capsolver' | 'anticaptcha-injection' | 'browser-solve' | 'none';
  message: string;
  cookie?: CloudflareCookie;
  duration: number;
}

export interface HybridSolutionOptions {
  // Stratégies disponibles
  useManualCookies: boolean;
  useCapSolver: boolean;
  useAntiCaptchaInjection: boolean;
  useBrowserSolve: boolean;
  
  // Configuration
  capsolverApiKey?: string;
  anticaptchaApiKey?: string;
  proxyUrl?: string;
  
  // Comportement
  maxAttempts: number;
  retryDelay: number;
  timeout: number;
}

const DEFAULT_OPTIONS: HybridSolutionOptions = {
  useManualCookies: true,
  useCapSolver: true,
  useAntiCaptchaInjection: true,
  useBrowserSolve: false, // Dernier recours
  
  maxAttempts: 3,
  retryDelay: 5000,
  timeout: 30000,
};

/**
 * Solution hybride intelligente pour Cloudflare Managed Challenge
 * Combine plusieurs approches pour maximiser les chances de succès
 */
export class HybridCloudflareSolver {
  private options: HybridSolutionOptions;
  
  constructor(options: Partial<HybridSolutionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }
  
  /**
   * Vérifie si une page est bloquée par Cloudflare
   */
  async isCloudflareBlocking(page: Page): Promise<boolean> {
    try {
      const title = await page.title();
      return /un instant|just a moment|verifying|comprobando/i.test(title);
    } catch (error) {
      return false;
    }
  }
  
  /**
   * Méthode 1: Cookies manuels
   * Utilise les cookies cf_clearance déjà capturés
   */
  private async tryManualCookies(
    page: Page,
    domain: string
  ): Promise<{ success: boolean; cookie?: CloudflareCookie }> {
    console.log("[hybrid] Tentative avec cookies manuels...");
    
    if (!this.options.useManualCookies) {
      return { success: false };
    }
    
    // Charger les cookies manuels
    cookieManager.loadManualCookies();
    
    const cookie = cookieManager.getBestCookie(domain);
    if (!cookie) {
      console.log("[hybrid] Aucun cookie manuel valide");
      return { success: false };
    }
    
    console.log(`[hybrid] Cookie trouvé: ${cookie.value.slice(0, 20)}...`);
    console.log(`[hybrid] Expire dans: ${Math.round((cookie.expires - Date.now()/1000)/60)} minutes`);
    
    const context = page.context();
    const applied = await cookieManager.applyBestCookie(context, domain);
    
    if (!applied) {
      return { success: false };
    }
    
    // Recharger et vérifier
    await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });
    
    const stillBlocked = await this.isCloudflareBlocking(page);
    
    if (stillBlocked) {
      console.log("[hybrid] Cookie appliqué mais Cloudflare toujours présent");
      return { success: false, cookie };
    }
    
    console.log("[hybrid] ✅ Succès avec cookie manuel!");
    return { success: true, cookie };
  }
  
  /**
   * Méthode 2: CapSolver avec proxy iProyal
   */
  private async tryCapSolver(
    page: Page,
    capsolverApiKey: string,
    proxyUrl: string
  ): Promise<boolean> {
    console.log("[hybrid] Tentative avec CapSolver...");
    
    if (!this.options.useCapSolver || !capsolverApiKey || !proxyUrl) {
      console.log("[hybrid] CapSolver non configuré");
      return false;
    }
    
    try {
      const success = await solveAndApplyCloudflareChallenge(
        page,
        capsolverApiKey,
        proxyUrl
      );
      
      if (success) {
        console.log("[hybrid] ✅ Succès avec CapSolver!");
        
        // Capturer le cookie généré
        const context = page.context();
        const cookies = await context.cookies();
        const cfCookie = cookies.find(c => c.name === 'cf_clearance');
        
        if (cfCookie) {
          cookieManager.addCookie({
            name: cfCookie.name,
            value: cfCookie.value,
            domain: cfCookie.domain,
            path: cfCookie.path,
            expires: cfCookie.expires || Math.floor(Date.now() / 1000) + 7200,
            httpOnly: true,
            secure: true,
            sameSite: 'None',
            source: 'capsolver',
            validFor: [cfCookie.domain],
          });
          console.log("[hybrid] Cookie CapSolver sauvegardé");
        }
      }
      
      return success;
      
    } catch (error) {
      console.error("[hybrid] Erreur CapSolver:", error);
      return false;
    }
  }
  
  /**
   * Méthode 3: Anti-Captcha avec proxy injection
   */
  private async tryAntiCaptchaInjection(
    page: Page,
    anticaptchaApiKey: string
  ): Promise<boolean> {
    console.log("[hybrid] Tentative avec Anti-Captcha injection...");
    
    if (!this.options.useAntiCaptchaInjection || !anticaptchaApiKey) {
      console.log("[hybrid] Anti-Captcha non configuré");
      return false;
    }
    
    try {
      // Utiliser la méthode d'injection
      const result = await detectAndSolveTurnstileWithInjection(
        page,
        undefined, // twoCaptchaApiKey
        undefined, // capsolverApiKey
        undefined, // proxyUrl
        anticaptchaApiKey
      );
      
      if (result === "solved") {
        console.log("[hybrid] ✅ Succès avec Anti-Captcha injection!");
        return true;
      }
      
      console.log(`[hybrid] Anti-Captcha échec: ${result}`);
      return false;
      
    } catch (error) {
      console.error("[hybrid] Erreur Anti-Captcha:", error);
      return false;
    }
  }
  
  /**
   * Méthode 4: Résolution manuelle dans le navigateur
   * Dernier recours - attend que l'utilisateur résolve manuellement
   */
  private async tryBrowserSolve(
    page: Page,
    domain: string
  ): Promise<{ success: boolean; cookie?: CloudflareCookie }> {
    console.log("[hybrid] ⚠️  Attente résolution manuelle...");
    console.log("[hybrid] Veuillez résoudre le captcha Cloudflare dans le navigateur");
    console.log("[hybrid] Attente de 60 secondes...");
    
    if (!this.options.useBrowserSolve) {
      return { success: false };
    }
    
    try {
      // Attendre que l'utilisateur résolve
      await page.waitForFunction(() => {
        const title = document.title;
        return !/un instant|just a moment|verifying/i.test(title);
      }, { timeout: 60000 });
      
      // Vérifier
      const stillBlocked = await this.isCloudflareBlocking(page);
      
      if (stillBlocked) {
        console.log("[hybrid] ❌ Cloudflare toujours présent après attente");
        return { success: false };
      }
      
      console.log("[hybrid] ✅ Cloudflare résolu manuellement!");
      
      // Capturer le cookie
      const context = page.context();
      const cookies = await context.cookies();
      const cfCookie = cookies.find(c => c.name === 'cf_clearance');
      
      if (cfCookie) {
        const capturedCookie: Omit<CloudflareCookie, 'capturedAt'> = {
          name: cfCookie.name,
          value: cfCookie.value,
          domain: cfCookie.domain,
          path: cfCookie.path,
          expires: cfCookie.expires || Math.floor(Date.now() / 1000) + 7200,
          httpOnly: true,
          secure: true,
          sameSite: 'None',
          source: 'manual',
          validFor: [domain],
        };
        
        cookieManager.addCookie(capturedCookie);
        console.log(`[hybrid] Cookie capturé: ${cfCookie.value.slice(0, 20)}...`);
        
        return { 
          success: true, 
          cookie: { ...capturedCookie, capturedAt: Date.now() } 
        };
      }
      
      return { success: true };
      
    } catch (error) {
      console.error("[hybrid] Timeout résolution manuelle:", error);
      return { success: false };
    }
  }
  
  /**
   * Solution hybride complète
   */
  async solveCloudflare(
    page: Page,
    url: string
  ): Promise<HybridSolutionResult> {
    const startTime = Date.now();
    const domain = new URL(url).hostname;
    
    console.log(`[hybrid] === DÉBUT SOLUTION HYBRIDE ===`);
    console.log(`[hybrid] URL: ${url}`);
    console.log(`[hybrid] Domain: ${domain}`);
    console.log(`[hybrid] Stratégies activées:`);
    console.log(`  - Cookies manuels: ${this.options.useManualCookies ? '✅' : '❌'}`);
    console.log(`  - CapSolver: ${this.options.useCapSolver && this.options.capsolverApiKey ? '✅' : '❌'}`);
    console.log(`  - Anti-Captcha: ${this.options.useAntiCaptchaInjection && this.options.anticaptchaApiKey ? '✅' : '❌'}`);
    console.log(`  - Résolution navigateur: ${this.options.useBrowserSolve ? '✅' : '❌'}`);
    console.log("");
    
    // Vérifier si Cloudflare est présent
    const isBlocked = await this.isCloudflareBlocking(page);
    
    if (!isBlocked) {
      const duration = Date.now() - startTime;
      return {
        success: true,
        method: 'none',
        message: "Cloudflare non détecté",
        duration,
      };
    }
    
    console.log(`[hybrid] ❌ Cloudflare détecté`);
    
    // Essayer chaque méthode dans l'ordre
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      console.log(`\n[hybrid] --- Tentative ${attempt}/${this.options.maxAttempts} ---`);
      
      // Méthode 1: Cookies manuels
      if (this.options.useManualCookies) {
        const result = await this.tryManualCookies(page, domain);
        if (result.success) {
          const duration = Date.now() - startTime;
          return {
            success: true,
            method: 'manual-cookie',
            message: "Résolu avec cookie manuel",
            cookie: result.cookie,
            duration,
          };
        }
      }
      
      // Méthode 2: CapSolver
      if (this.options.useCapSolver && this.options.capsolverApiKey && this.options.proxyUrl) {
        const success = await this.tryCapSolver(
          page,
          this.options.capsolverApiKey,
          this.options.proxyUrl
        );
        if (success) {
          const duration = Date.now() - startTime;
          return {
            success: true,
            method: 'capsolver',
            message: "Résolu avec CapSolver",
            duration,
          };
        }
      }
      
      // Méthode 3: Anti-Captcha injection
      if (this.options.useAntiCaptchaInjection && this.options.anticaptchaApiKey) {
        const success = await this.tryAntiCaptchaInjection(
          page,
          this.options.anticaptchaApiKey
        );
        if (success) {
          const duration = Date.now() - startTime;
          return {
            success: true,
            method: 'anticaptcha-injection',
            message: "Résolu avec Anti-Captcha injection",
            duration,
          };
        }
      }
      
      // Attendre avant prochaine tentative
      if (attempt < this.options.maxAttempts) {
        console.log(`[hybrid] Attente ${this.options.retryDelay}ms avant prochaine tentative...`);
        await new Promise(resolve => setTimeout(resolve, this.options.retryDelay));
      }
    }
    
    // Dernier recours: Résolution manuelle
    if (this.options.useBrowserSolve) {
      console.log(`\n[hybrid] --- DERNIER RECOURS: RÉSOLUTION MANUELLE ---`);
      const result = await this.tryBrowserSolve(page, domain);
      
      if (result.success) {
        const duration = Date.now() - startTime;
        return {
          success: true,
          method: 'browser-solve',
          message: "Résolu manuellement dans le navigateur",
          cookie: result.cookie,
          duration,
        };
      }
    }
    
    // Toutes les méthodes ont échoué
    const duration = Date.now() - startTime;
    console.log(`\n[hybrid] === TOUTES LES MÉTHODES ONT ÉCHOUÉ ===`);
    console.log(`[hybrid] Durée totale: ${duration}ms`);
    
    return {
      success: false,
      method: 'none',
      message: "Toutes les méthodes ont échoué",
      duration,
    };
  }
  
  /**
   * Configuration rapide pour le portail Espagne
   */
  static createForSpainPortal(): HybridCloudflareSolver {
    return new HybridCloudflareSolver({
      useManualCookies: true,
      useCapSolver: true,
      useAntiCaptchaInjection: true,
      useBrowserSolve: true, // Dernier recours
      
      capsolverApiKey: process.env.CAPSOLVER_API_KEY,
      anticaptchaApiKey: process.env.ANTICAPTCHA_API_KEY,
      proxyUrl: process.env.IPROYAL_PROXY_URL,
      
      maxAttempts: 2,
      retryDelay: 10000,
      timeout: 60000,
    });
  }
  
  /**
   * Statistiques des cookies disponibles
   */
  getCookieStats(): {
    total: number;
    valid: number;
    expired: number;
    bestCookie?: CloudflareCookie;
  } {
    cookieManager.loadManualCookies();
    const stats = cookieManager.getStats();
    const bestCookie = cookieManager.getBestCookie("citaconsular.es");
    
    return {
      total: stats.total,
      valid: stats.valid,
      expired: stats.expired,
      bestCookie: bestCookie || undefined,
    };
  }
  
  /**
   * Recommandations basées sur les statistiques
   */
  getRecommendations(): string[] {
    const stats = this.getCookieStats();
    const recommendations: string[] = [];
    
    if (stats.valid === 0) {
      recommendations.push("❌ Aucun cookie valide. Capturez-en un manuellement.");
    } else if (stats.valid < 2) {
      recommendations.push("⚠️  Seulement 1 cookie valide. Capturez-en plus pour la redondance.");
    } else {
      recommendations.push(`✅ ${stats.valid} cookies valides disponibles.`);
    }
    
    if (stats.bestCookie) {
      const remainingMinutes = Math.round((stats.bestCookie.expires - Date.now()/1000) / 60);
      recommendations.push(`⏰ Meilleur cookie expire dans ${remainingMinutes} minutes.`);
    }
    
    if (!this.options.capsolverApiKey) {
      recommendations.push("⚠️  CapSolver non configuré (variable CAPSOLVER_API_KEY manquante).");
    }
    
    if (!this.options.anticaptchaApiKey) {
      recommendations.push("⚠️  Anti-Captcha non configuré (variable ANTICAPTCHA_API_KEY manquante).");
    }
    
    if (!this.options.proxyUrl) {
      recommendations.push("⚠️  Proxy non configuré (variable IPROYAL_PROXY_URL manquante).");
    }
    
    return recommendations;
  }
}