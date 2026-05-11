import type { Page } from "playwright";
import { solveAndApplyCloudflareChallenge } from "./capsolver.js";
import { solveTurnstileWithProxyInjection, CaptchaResult } from "./captcha.js";
import { cookieManager, CloudflareCookie } from "./cookie-manager.js";

export interface CloudflareStrategyResult {
  success: boolean;
  strategy: 'manual-cookies' | 'capsolver' | 'anticaptcha' | 'none';
  message: string;
  cookieUsed?: CloudflareCookie;
}

/**
 * Stratégie 1: Cookies manuels capturés
 * Solution la plus fiable et gratuite
 */
export async function tryManualCookiesStrategy(
  page: Page,
  portalUrl: string
): Promise<CloudflareStrategyResult> {
  console.log("[cloudflare-strategies] Tentative stratégie 1: Cookies manuels...");
  
  try {
    // Initialiser le gestionnaire de cookies
    cookieManager.loadManualCookies();
    
    // Récupérer un cookie valide
    const domain = new URL(portalUrl).hostname;
    const cookie = cookieManager.getBestCookie(domain);
    
    if (!cookie) {
      return {
        success: false,
        strategy: 'manual-cookies',
        message: "Aucun cookie valide disponible"
      };
    }
    
    console.log(`[cloudflare-strategies] Cookie valide trouvé: ${cookie.value.slice(0, 30)}...`);
    console.log(`[cloudflare-strategies] Expire dans: ${Math.round((cookie.expires - Date.now()/1000)/60)} minutes`);
    
    // Appliquer le cookie
    const context = page.context();
    const applied = await cookieManager.applyBestCookie(context, domain);
    
    if (!applied) {
      return {
        success: false,
        strategy: 'manual-cookies',
        message: "Échec application cookie"
      };
    }
    
    // Recharger la page
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    
    // Vérifier si Cloudflare est toujours présent
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      return {
        success: false,
        strategy: 'manual-cookies',
        message: "Cloudflare toujours présent après cookie",
        cookieUsed: cookie
      };
    }
    
    console.log(`[cloudflare-strategies] ✅ Cloudflare résolu avec cookies manuels!`);
    
    return {
      success: true,
      strategy: 'manual-cookies',
      message: "Cloudflare contourné avec succès",
      cookieUsed: cookie
    };
    
  } catch (error) {
    console.error("[cloudflare-strategies] Erreur stratégie cookies:", error);
    return {
      success: false,
      strategy: 'manual-cookies',
      message: `Erreur: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Stratégie 2: CapSolver avec proxy iProyal
 * Solution payante mais automatique
 */
export async function tryCapSolverStrategy(
  page: Page,
  capsolverApiKey: string,
  proxyUrl: string
): Promise<CloudflareStrategyResult> {
  console.log("[cloudflare-strategies] Tentative stratégie 2: CapSolver...");
  
  try {
    const startTime = Date.now();
    const success = await solveAndApplyCloudflareChallenge(page, capsolverApiKey, proxyUrl);
    const elapsedTime = Date.now() - startTime;
    
    if (!success) {
      return {
        success: false,
        strategy: 'capsolver',
        message: `Échec après ${elapsedTime}ms`
      };
    }
    
    // Vérifier
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      return {
        success: false,
        strategy: 'capsolver',
        message: "Cloudflare toujours présent après CapSolver"
      };
    }
    
    console.log(`[cloudflare-strategies] ✅ Cloudflare résolu avec CapSolver! (${elapsedTime}ms)`);
    
    return {
      success: true,
      strategy: 'capsolver',
      message: `Cloudflare résolu en ${elapsedTime}ms`
    };
    
  } catch (error) {
    console.error("[cloudflare-strategies] Erreur stratégie CapSolver:", error);
    return {
      success: false,
      strategy: 'capsolver',
      message: `Erreur: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Stratégie 3: Anti-Captcha pour Turnstile
 * Pour les portails qui utilisent Turnstile standard (pas Managed Challenge)
 */
export async function tryAntiCaptchaStrategy(
  page: Page,
  anticaptchaApiKey: string
): Promise<CloudflareStrategyResult> {
  console.log("[cloudflare-strategies] Tentative stratégie 3: Anti-Captcha...");
  
  try {
    // Détecter si c'est Turnstile
    const hasTurnstile = await page.evaluate(() => {
      return !!document.querySelector('[data-sitekey]') || 
             !!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    });
    
    if (!hasTurnstile) {
      return {
        success: false,
        strategy: 'anticaptcha',
        message: "Turnstile non détecté"
      };
    }
    
    // Essayer de résoudre avec proxy injection
    const result = await solveTurnstileWithProxyInjection(page, anticaptchaApiKey);
    
    if (result !== "solved") {
      return {
        success: false,
        strategy: 'anticaptcha',
        message: result === "no_key" ? "Clé API manquante" : "Échec résolution"
      };
    }
    
    console.log(`[cloudflare-strategies] ✅ Turnstile résolu avec Anti-Captcha (proxy injection)!`);
    
    return {
      success: true,
      strategy: 'anticaptcha',
      message: "Turnstile résolu avec proxy injection"
    };
    
  } catch (error) {
    console.error("[cloudflare-strategies] Erreur stratégie Anti-Captcha:", error);
    return {
      success: false,
      strategy: 'anticaptcha',
      message: `Erreur: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Stratégie unifiée: Essaye toutes les stratégies dans l'ordre
 * 1. Cookies manuels (gratuit, fiable)
 * 2. CapSolver avec iProyal (payant, automatique)
 * 3. Anti-Captcha (pour Turnstile standard)
 */
export async function solveCloudflareWithAllStrategies(
  page: Page,
  portalUrl: string,
  capsolverApiKey?: string,
  anticaptchaApiKey?: string,
  proxyUrl?: string
): Promise<CloudflareStrategyResult> {
  console.log("[cloudflare-strategies] === DÉBUT RÉSOLUTION CLOUDFLARE MULTI-STRATÉGIES ===\n");
  
  // Vérifier si Cloudflare est présent
  const title = await page.title();
  const isCloudflare = /un instant|just a moment|verifying/i.test(title);
  
  if (!isCloudflare) {
    console.log("[cloudflare-strategies] ✅ Cloudflare non détecté");
    return {
      success: true,
      strategy: 'none',
      message: "Cloudflare non présent"
    };
  }
  
  console.log(`[cloudflare-strategies] ❌ Cloudflare détecté: "${title}"\n`);
  
  // Stratégie 1: Cookies manuels
  console.log("[cloudflare-strategies] --- STRATÉGIE 1: COOKIES MANUELS ---");
  const manualResult = await tryManualCookiesStrategy(page, portalUrl);
  
  if (manualResult.success) {
    console.log("[cloudflare-strategies] ✅ SUCCÈS avec cookies manuels!\n");
    return manualResult;
  }
  
  console.log(`[cloudflare-strategies] ❌ Échec: ${manualResult.message}\n`);
  
  // Stratégie 2: CapSolver (si configuré)
  if (capsolverApiKey && proxyUrl) {
    console.log("[cloudflare-strategies] --- STRATÉGIE 2: CAPSOLVER ---");
    const capsolverResult = await tryCapSolverStrategy(page, capsolverApiKey, proxyUrl);
    
    if (capsolverResult.success) {
      console.log("[cloudflare-strategies] ✅ SUCCÈS avec CapSolver!\n");
      return capsolverResult;
    }
    
    console.log(`[cloudflare-strategies] ❌ Échec: ${capsolverResult.message}\n`);
  } else {
    console.log("[cloudflare-strategies] ⚠️  CapSolver non configuré (API key ou proxy manquant)\n");
  }
  
  // Stratégie 3: Anti-Captcha (si configuré)
  if (anticaptchaApiKey) {
    console.log("[cloudflare-strategies] --- STRATÉGIE 3: ANTI-CAPTCHA ---");
    const anticaptchaResult = await tryAntiCaptchaStrategy(page, anticaptchaApiKey);
    
    if (anticaptchaResult.success) {
      console.log("[cloudflare-strategies] ✅ SUCCÈS avec Anti-Captcha!\n");
      return anticaptchaResult;
    }
    
    console.log(`[cloudflare-strategies] ❌ Échec: ${anticaptchaResult.message}\n`);
  } else {
    console.log("[cloudflare-strategies] ⚠️  Anti-Captcha non configuré\n");
  }
  
  // Toutes les stratégies ont échoué
  console.log("[cloudflare-strategies] === TOUTES LES STRATÉGIES ONT ÉCHOUÉ ===\n");
  console.log("[cloudflare-strategies] Solutions possibles:");
  console.log("1. Capturer manuellement un nouveau cookie cf_clearance");
  console.log("2. Vérifier le solde CapSolver/Anti-Captcha");
  console.log("3. Essayer avec un autre proxy");
  console.log("4. Attendre et réessayer plus tard\n");
  
  return {
    success: false,
    strategy: 'none',
    message: "Toutes les stratégies ont échoué"
  };
}

/**
 * Vérifie rapidement si une page est bloquée par Cloudflare
 */
export async function isCloudflareBlocking(page: Page): Promise<boolean> {
  try {
    const title = await page.title();
    return /un instant|just a moment|verifying/i.test(title);
  } catch (error) {
    console.error("[cloudflare-strategies] Erreur vérification Cloudflare:", error);
    return false;
  }
}

/**
 * Configuration recommandée pour chaque portail
 */
export interface PortalConfig {
  name: string;
  url: string;
  recommendedStrategy: 'manual-cookies' | 'capsolver' | 'anticaptcha';
  notes: string;
}

export const PORTAL_CONFIGS: Record<string, PortalConfig> = {
  'spain': {
    name: 'Espagne (citaconsular.es)',
    url: 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5',
    recommendedStrategy: 'manual-cookies',
    notes: 'Utilise Cloudflare Managed Challenge. Cookies manuels fonctionnent bien.'
  },
  'belgium': {
    name: 'Belgique (CEV)',
    url: 'https://appointment.cloud.diplomatie.be/',
    recommendedStrategy: 'anticaptcha',
    notes: 'Utilise hCaptcha. Anti-Captcha fonctionne bien.'
  }
};

/**
 * Obtenir la configuration recommandée pour un portail
 */
export function getRecommendedConfig(portalKey: string): PortalConfig | null {
  return PORTAL_CONFIGS[portalKey] || null;
}