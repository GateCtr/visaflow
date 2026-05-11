import type { Page } from "playwright";
import { solveAndApplyCloudflareChallenge } from "./capsolver.js";
import { solveCloudflareManagedChallenge } from "./cf-managed-injection.js";
import { detectAndSolveTurnstile } from "./captcha.js";

export interface CloudflareSolverOptions {
  /** Clé API Anti-Captcha (priorité 1 pour Managed Challenge) */
  anticaptchaApiKey?: string;
  /** Clé API CapSolver (nécessite proxy avec IP fixe) */
  capsolverApiKey?: string;
  /** Clé API 2Captcha (fallback) */
  twoCaptchaApiKey?: string;
  /** URL du proxy pour CapSolver (doit avoir IP fixe) */
  capsolverProxyUrl?: string;
  /** Stratégie à utiliser (auto = détection automatique) */
  strategy?: 'auto' | 'capsolver' | 'anticaptcha' | 'turnstile' | 'cookie';
  /** Timeout total en ms (défaut: 5 minutes) */
  timeoutMs?: number;
}

export interface CloudflareSolverResult {
  success: boolean;
  strategy: string;
  timeMs: number;
  error?: string;
  cfClearance?: string;
  cookies?: Array<{ name: string; value: string }>;
}

/**
 * Détecte le type de Cloudflare Challenge
 */
async function detectCloudflareType(page: Page): Promise<'managed' | 'turnstile' | 'unknown'> {
  try {
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (!isCloudflare) {
      return 'unknown';
    }
    
    // Analyser la page pour déterminer le type
    const pageType = await page.evaluate(() => {
      // Vérifier la présence d'éléments Turnstile
      const turnstileElements = document.querySelectorAll('.cf-turnstile, [data-cf-turnstile], iframe[src*="turnstile"]');
      if (turnstileElements.length > 0) {
        return 'turnstile';
      }
      
      // Vérifier la présence de scripts Cloudflare Managed
      const scripts = Array.from(document.scripts);
      const hasManagedScript = scripts.some(s => 
        s.src.includes('cdn-cgi/challenge-platform') || 
        s.src.includes('chl_page/v1')
      );
      
      if (hasManagedScript) {
        return 'managed';
      }
      
      // Vérifier les métadonnées
      const metaChallenge = document.querySelector('meta[name="cf-challenge"]');
      if (metaChallenge) {
        return 'managed';
      }
      
      return 'unknown';
    });
    
    return pageType;
  } catch (error) {
    console.warn("[cloudflare-solver] Erreur détection type:", error);
    return 'unknown';
  }
}

/**
 * Stratégie 1: CapSolver avec proxy fixe (si disponible)
 */
async function strategyCapSolver(
  page: Page,
  capsolverApiKey: string,
  capsolverProxyUrl: string
): Promise<boolean> {
  console.log("[cloudflare-solver] Stratégie CapSolver avec proxy fixe");
  
  if (!capsolverApiKey || !capsolverProxyUrl) {
    console.error("[cloudflare-solver] CapSolver nécessite API key et proxy URL");
    return false;
  }
  
  return await solveAndApplyCloudflareChallenge(page, capsolverApiKey, capsolverProxyUrl);
}

/**
 * Stratégie 2: Anti-Captcha avec méthode adaptée pour Managed Challenge
 */
async function strategyAntiCaptchaManaged(
  page: Page,
  anticaptchaApiKey: string
): Promise<boolean> {
  console.log("[cloudflare-solver] Stratégie Anti-Captcha Managed Challenge");
  
  if (!anticaptchaApiKey) {
    console.error("[cloudflare-solver] Anti-Captcha nécessite API key");
    return false;
  }
  
  const result = await solveCloudflareManagedChallenge(page, anticaptchaApiKey);
  return result === 'solved';
}

/**
 * Stratégie 3: Anti-Captcha Turnstile standard
 */
async function strategyAntiCaptchaTurnstile(
  page: Page,
  anticaptchaApiKey?: string,
  capsolverApiKey?: string,
  twoCaptchaApiKey?: string
): Promise<boolean> {
  console.log("[cloudflare-solver] Stratégie Anti-Captcha Turnstile standard");
  
  const result = await detectAndSolveTurnstile(page, {
    anticaptchaApiKey,
    capsolverApiKey,
    twoCaptchaApiKey,
  });
  
  return result === 'solved';
}

/**
 * Stratégie 4: Utilisation de cookie capturé
 */
async function strategyCookieReuse(page: Page): Promise<boolean> {
  console.log("[cloudflare-solver] Stratégie réutilisation cookie");
  
  try {
    const fs = await import('fs');
    const cookiesPath = './cloudflare-capture/cookies.json';
    
    if (!fs.existsSync(cookiesPath)) {
      console.error("[cloudflare-solver] Fichier cookies.json non trouvé");
      return false;
    }
    
    const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    const cfClearanceCookie = cookiesData.find((c: any) => c.name === 'cf_clearance');
    
    if (!cfClearanceCookie) {
      console.error("[cloudflare-solver] Cookie cf_clearance non trouvé");
      return false;
    }
    
    console.log(`[cloudflare-solver] Utilisation cookie capturé: ${cfClearanceCookie.value.slice(0, 20)}...`);
    
    // Ajouter le cookie
    await page.context().addCookies([{
      name: 'cf_clearance',
      value: cfClearanceCookie.value,
      domain: cfClearanceCookie.domain || '.citaconsular.es',
      path: cfClearanceCookie.path || '/',
      expires: cfClearanceCookie.expires || Math.floor(Date.now() / 1000) + 7200,
      httpOnly: cfClearanceCookie.httpOnly || true,
      secure: cfClearanceCookie.secure !== false,
      sameSite: cfClearanceCookie.sameSite || 'None',
    }]);
    
    // Recharger la page
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Vérifier si Cloudflare est toujours présent
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    return !isCloudflare;
    
  } catch (error) {
    console.error("[cloudflare-solver] Erreur réutilisation cookie:", error);
    return false;
  }
}

/**
 * Résolveur intelligent de Cloudflare
 * Essaie différentes stratégies dans l'ordre optimal
 */
export async function solveCloudflareIntelligently(
  page: Page,
  options: CloudflareSolverOptions
): Promise<CloudflareSolverResult> {
  const startTime = Date.now();
  const timeoutMs = options.timeoutMs || 300000; // 5 minutes par défaut
  
  console.log("[cloudflare-solver] Début résolution intelligente Cloudflare");
  
  // Vérifier si Cloudflare est présent
  const title = await page.title();
  const isCloudflare = /un instant|just a moment|verifying/i.test(title);
  
  if (!isCloudflare) {
    console.log("[cloudflare-solver] Cloudflare non détecté");
    return {
      success: true,
      strategy: 'none',
      timeMs: Date.now() - startTime,
    };
  }
  
  console.log(`[cloudflare-solver] Cloudflare détecté: "${title}"`);
  
  // Détecter le type de challenge
  const challengeType = await detectCloudflareType(page);
  console.log(`[cloudflare-solver] Type détecté: ${challengeType}`);
  
  // Déterminer la stratégie
  let strategy = options.strategy || 'auto';
  
  if (strategy === 'auto') {
    // Logique de sélection automatique
    if (challengeType === 'managed' && options.anticaptchaApiKey) {
      strategy = 'anticaptcha';
    } else if (options.capsolverApiKey && options.capsolverProxyUrl) {
      strategy = 'capsolver';
    } else if (options.anticaptchaApiKey) {
      strategy = 'turnstile';
    } else {
      strategy = 'cookie';
    }
  }
  
  console.log(`[cloudflare-solver] Stratégie sélectionnée: ${strategy}`);
  
  // Exécuter la stratégie
  let success = false;
  let error: string | undefined;
  
  try {
    switch (strategy) {
      case 'capsolver':
        if (!options.capsolverApiKey || !options.capsolverProxyUrl) {
          throw new Error('CapSolver nécessite API key et proxy URL');
        }
        success = await strategyCapSolver(page, options.capsolverApiKey, options.capsolverProxyUrl);
        break;
        
      case 'anticaptcha':
        if (!options.anticaptchaApiKey) {
          throw new Error('Anti-Captcha nécessite API key');
        }
        success = await strategyAntiCaptchaManaged(page, options.anticaptchaApiKey);
        break;
        
      case 'turnstile':
        success = await strategyAntiCaptchaTurnstile(
          page,
          options.anticaptchaApiKey,
          options.capsolverApiKey,
          options.twoCaptchaApiKey
        );
        break;
        
      case 'cookie':
        success = await strategyCookieReuse(page);
        break;
        
      default:
        throw new Error(`Stratégie inconnue: ${strategy}`);
    }
    
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`[cloudflare-solver] Erreur stratégie ${strategy}:`, error);
  }
  
  // Si échec, essayer les fallbacks
  if (!success && strategy !== 'auto') {
    console.log("[cloudflare-solver] Échec de la stratégie principale, essai des fallbacks...");
    
    const fallbacks: Array<{ name: string; fn: () => Promise<boolean> }> = [];
    
    // Ajouter les fallbacks disponibles
    if (strategy !== 'cookie') {
      fallbacks.push({
        name: 'cookie',
        fn: () => strategyCookieReuse(page)
      });
    }
    
    if (strategy !== 'turnstile' && (options.anticaptchaApiKey || options.capsolverApiKey || options.twoCaptchaApiKey)) {
      fallbacks.push({
        name: 'turnstile',
        fn: () => strategyAntiCaptchaTurnstile(
          page,
          options.anticaptchaApiKey,
          options.capsolverApiKey,
          options.twoCaptchaApiKey
        )
      });
    }
    
    if (strategy !== 'anticaptcha' && options.anticaptchaApiKey) {
      fallbacks.push({
        name: 'anticaptcha',
        fn: () => strategyAntiCaptchaManaged(page, options.anticaptchaApiKey!)
      });
    }
    
    // Essayer les fallbacks
    for (const fallback of fallbacks) {
      if (Date.now() - startTime > timeoutMs) {
        console.error("[cloudflare-solver] Timeout atteint");
        break;
      }
      
      console.log(`[cloudflare-solver] Essai fallback: ${fallback.name}`);
      
      try {
        success = await fallback.fn();
        if (success) {
          strategy = fallback.name;
          console.log(`[cloudflare-solver] Fallback ${fallback.name} réussi`);
          break;
        }
      } catch (err) {
        console.warn(`[cloudflare-solver] Erreur fallback ${fallback.name}:`, err);
      }
    }
  }
  
  const timeMs = Date.now() - startTime;
  
  // Récupérer les cookies si succès
  let cfClearance: string | undefined;
  let cookies: Array<{ name: string; value: string }> | undefined;
  
  if (success) {
    const allCookies = await page.context().cookies();
    cfClearance = allCookies.find(c => c.name === 'cf_clearance')?.value;
    cookies = allCookies.map(c => ({ name: c.name, value: c.value }));
    
    if (cfClearance) {
      console.log(`[cloudflare-solver] Cookie cf_clearance obtenu: ${cfClearance.slice(0, 20)}...`);
    }
  }
  
  const result: CloudflareSolverResult = {
    success,
    strategy,
    timeMs,
    error,
    cfClearance,
    cookies,
  };
  
  console.log(`[cloudflare-solver] Résultat final: ${success ? '✅ SUCCÈS' : '❌ ÉCHEC'} (${timeMs}ms)`);
  
  return result;
}

/**
 * Méthode simplifiée pour intégration dans les scripts existants
 */
export async function bypassCloudflare(
  page: Page,
  anticaptchaApiKey?: string,
  capsolverApiKey?: string,
  capsolverProxyUrl?: string
): Promise<boolean> {
  const result = await solveCloudflareIntelligently(page, {
    anticaptchaApiKey,
    capsolverApiKey,
    capsolverProxyUrl,
    strategy: 'auto',
  });
  
  return result.success;
}

/**
 * Vérifie si un proxy a une IP fixe (nécessaire pour CapSolver)
 */
export function hasFixedIpProxy(proxyUrl: string): boolean {
  try {
    const url = new URL(proxyUrl);
    const hostname = url.hostname;
    
    // Les proxies avec IP dynamique ont souvent:
    // - Sous-domaines dynamiques (ex: *.superproxy.io)
    // - DNS dynamique
    // - Noms de domaine génériques
    
    const dynamicPatterns = [
      /\.superproxy\.io$/i,
      /\.brightdata\.com$/i,
      /\.iproyal\.com$/i,
      /^[a-z0-9-]+\.dynamic\./i,
      /^[a-z0-9-]+\.pool\./i,
      /^proxy-.*\./i,
    ];
    
    for (const pattern of dynamicPatterns) {
      if (pattern.test(hostname)) {
        return false;
      }
    }
    
    // Vérifier si c'est une IP directe
    const ipPattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
    if (ipPattern.test(hostname)) {
      return true; // IP fixe
    }
    
    // Par défaut, considérer comme potentiellement dynamique
    return false;
    
  } catch (error) {
    console.warn("[cloudflare-solver] Erreur vérification proxy:", error);
    return false;
  }
}

/**
 * Recommande la meilleure stratégie basée sur la configuration
 */
export function recommendStrategy(options: CloudflareSolverOptions): string {
  const hasCapSolver = !!(options.capsolverApiKey && options.capsolverProxyUrl);
  const hasAntiCaptcha = !!options.anticaptchaApiKey;
  const hasFixedIp = options.capsolverProxyUrl ? hasFixedIpProxy(options.capsolverProxyUrl) : false;
  
  if (hasCapSolver && hasFixedIp) {
    return "capsolver";
  } else if (hasAntiCaptcha) {
    return "anticaptcha";
  } else if (options.capsolverApiKey) {
    return "capsolver"; // Essayer même sans IP fixe
  } else {
    return "cookie";
  }
}