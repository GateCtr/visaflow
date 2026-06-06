import * as dotenv from "dotenv";
dotenv.config();

import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import { cookieManager } from "./src/cookie-manager.js";

interface TestResult {
  strategy: string;
  success: boolean;
  timeMs: number;
  error?: string;
  details?: string;
}

const SPAIN_PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

/**
 * Vérifie si Cloudflare bloque la page
 */
async function isCloudflareBlocking(page: Page): Promise<boolean> {
  const title = await page.title();
  const isBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(title);
  return isBlocked;
}

/**
 * Scénario 1: Stealth Browser avec playwright-extra
 * Utilise des techniques pour éviter la détection automatisée
 */
async function scenario1_stealthBrowser(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 1: STEALTH BROWSER ===");
  
  let browser: Browser | null = null;
  
  try {
    // Lancer avec des options anti-détection
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      permissions: ['geolocation'],
      geolocation: { latitude: 40.4168, longitude: -3.7038 }, // Madrid
      // Cacher les indicateurs d'automation
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      }
    });
    
    // Injecter du code pour masquer webdriver
    await context.addInitScript(() => {
      // Masquer navigator.webdriver
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      
      // Masquer les plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      
      // Masquer les languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['es-ES', 'es', 'en']
      });
      
      // Simuler un canvas plus naturel
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(...args) {
        // Ajouter du bruit pour éviter la fingerprinting
        const context = this.getContext('2d');
        if (context) {
          const imageData = context.getImageData(0, 0, this.width, this.height);
          for (let i = 0; i < imageData.data.length; i += 4) {
            imageData.data[i] += Math.random() * 0.1;
          }
          context.putImageData(imageData, 0, 0);
        }
        return originalToDataURL.apply(this, args);
      };
    });
    
    const page = await context.newPage();
    
    // Navigation progressive pour simuler un humain
    await page.goto(SPAIN_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    // Attendre un peu pour simuler un humain
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Scroll progressif
    await page.evaluate(() => {
      window.scrollBy(0, 100);
    });
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const isBlocked = await isCloudflareBlocking(page);
    
    await browser.close();
    
    return {
      strategy: "Stealth Browser",
      success: !isBlocked,
      timeMs: Date.now() - startTime,
      details: isBlocked ? "Cloudflare détecté" : "Accès autorisé"
    };
    
  } catch (error) {
    if (browser) await browser.close();
    return {
      strategy: "Stealth Browser",
      success: false,
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Scénario 2: Cookie manuel existant
 * Utilise les cookies déjà capturés
 */
async function scenario2_manualCookie(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 2: COOKIE MANUEL EXISTANT ===");
  
  let browser: Browser | null = null;
  
  try {
    // Initialiser le gestionnaire de cookies
    cookieManager.loadManualCookies();
    const stats = cookieManager.getStats();
    
    console.log(`Cookies disponibles: ${stats.valid} valides, ${stats.expired} expirés`);
    
    if (stats.valid === 0) {
      return {
        strategy: "Cookie Manuel",
        success: false,
        timeMs: Date.now() - startTime,
        error: "Aucun cookie valide disponible"
      };
    }
    
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    });
    
    // Appliquer le cookie
    const domain = 'citaconsular.es';
    const applied = await cookieManager.applyBestCookie(context, domain);
    
    if (!applied) {
      await browser.close();
      return {
        strategy: "Cookie Manuel",
        success: false,
        timeMs: Date.now() - startTime,
        error: "Échec application cookie"
      };
    }
    
    const page = await context.newPage();
    await page.goto(SPAIN_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    const isBlocked = await isCloudflareBlocking(page);
    
    await browser.close();
    
    return {
      strategy: "Cookie Manuel",
      success: !isBlocked,
      timeMs: Date.now() - startTime,
      details: isBlocked ? "Cookie expiré ou invalide" : "Cookie fonctionnel"
    };
    
  } catch (error) {
    if (browser) await browser.close();
    return {
      strategy: "Cookie Manuel",
      success: false,
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Scénario 3: Session Persistence
 * Tente de réutiliser une session existante
 */
async function scenario3_sessionPersistence(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 3: SESSION PERSISTENCE ===");
  
  let browser: Browser | null = null;
  
  try {
    const userDataDir = './.playwright-session-spain';
    
    browser = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
    });
    
    const page = browser.pages()[0] || await browser.newPage();
    
    await page.goto(SPAIN_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    // Attendre pour voir si une session existante est réutilisée
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const isBlocked = await isCloudflareBlocking(page);
    
    await browser.close();
    
    return {
      strategy: "Session Persistence",
      success: !isBlocked,
      timeMs: Date.now() - startTime,
      details: isBlocked ? "Session expirée ou inexistante" : "Session réutilisée avec succès"
    };
    
  } catch (error) {
    if (browser) await browser.close();
    return {
      strategy: "Session Persistence",
      success: false,
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Scénario 4: Multiple User-Agents
 * Teste différents user-agents pour trouver un qui fonctionne
 */
async function scenario4_userAgentRotation(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 4: USER-AGENT ROTATION ===");
  
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  ];
  
  let browser: Browser | null = null;
  
  for (const ua of userAgents) {
    try {
      console.log(`Testing UA: ${ua.substring(0, 50)}...`);
      
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        userAgent: ua,
        viewport: { width: 1920, height: 1080 },
        locale: 'es-ES',
      });
      
      const page = await context.newPage();
      await page.goto(SPAIN_PORTAL_URL, { 
        waitUntil: 'domcontentloaded',
        timeout: 20000 
      });
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const isBlocked = await isCloudflareBlocking(page);
      
      await browser.close();
      browser = null;
      
      if (!isBlocked) {
        return {
          strategy: "User-Agent Rotation",
          success: true,
          timeMs: Date.now() - startTime,
          details: `UA fonctionnel: ${ua.substring(0, 50)}`
        };
      }
    } catch (error) {
      if (browser) {
        await browser.close();
        browser = null;
      }
      console.log(`Erreur avec UA: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
  
  return {
    strategy: "User-Agent Rotation",
    success: false,
    timeMs: Date.now() - startTime,
    error: "Tous les user-agents testés ont échoué"
  };
}

/**
 * Scénario 5: Timing Strategy
 * Attend différents délais avant de naviguer
 */
async function scenario5_timingStrategy(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 5: TIMING STRATEGY ===");
  
  const delays = [0, 5000, 10000, 15000];
  
  let browser: Browser | null = null;
  
  for (const delay of delays) {
    try {
      console.log(`Testing avec délai: ${delay}ms`);
      
      browser = await chromium.launch({ headless: false });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 },
        locale: 'es-ES',
      });
      
      const page = await context.newPage();
      
      // Attendre avant de naviguer
      await new Promise(resolve => setTimeout(resolve, delay));
      
      await page.goto(SPAIN_PORTAL_URL, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 
      });
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const isBlocked = await isCloudflareBlocking(page);
      
      await browser.close();
      browser = null;
      
      if (!isBlocked) {
        return {
          strategy: "Timing Strategy",
          success: true,
          timeMs: Date.now() - startTime,
          details: `Délai fonctionnel: ${delay}ms`
        };
      }
    } catch (error) {
      if (browser) {
        await browser.close();
        browser = null;
      }
      console.log(`Erreur avec délai ${delay}ms: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
  }
  
  return {
    strategy: "Timing Strategy",
    success: false,
    timeMs: Date.now() - startTime,
    error: "Tous les délais testés ont échoué"
  };
}

/**
 * Scénario 6: Referer Header Strategy
 * Navigue depuis une page légitime du même domaine
 */
async function scenario6_refererStrategy(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 6: REFERER STRATEGY ===");
  
  let browser: Browser | null = null;
  
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      extraHTTPHeaders: {
        'Referer': 'https://www.citaconsular.es/',
        'Origin': 'https://www.citaconsular.es',
      }
    });
    
    const page = await context.newPage();
    
    // D'abord visiter la page d'accueil
    await page.goto('https://www.citaconsular.es/', { 
      waitUntil: 'domcontentloaded',
      timeout: 20000 
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Puis naviguer vers le widget
    await page.goto(SPAIN_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const isBlocked = await isCloudflareBlocking(page);
    
    await browser.close();
    
    return {
      strategy: "Referer Strategy",
      success: !isBlocked,
      timeMs: Date.now() - startTime,
      details: isBlocked ? "Référent non accepté" : "Navigation avec référent réussie"
    };
    
  } catch (error) {
    if (browser) await browser.close();
    return {
      strategy: "Referer Strategy",
      success: false,
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Scénario 7: Cookie + Stealth Combined
 * Combine le cookie manuel avec les techniques stealth
 */
async function scenario7_combinedStealthCookie(): Promise<TestResult> {
  const startTime = Date.now();
  console.log("\n=== SCÉNARIO 7: STEALTH + COOKIE COMBINÉ ===");
  
  let browser: Browser | null = null;
  
  try {
    // Initialiser le gestionnaire de cookies
    cookieManager.loadManualCookies();
    const stats = cookieManager.getStats();
    
    if (stats.valid === 0) {
      return {
        strategy: "Stealth + Cookie",
        success: false,
        timeMs: Date.now() - startTime,
        error: "Aucun cookie valide disponible"
      };
    }
    
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ]
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      }
    });
    
    // Injecter script anti-détection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });
    
    // Appliquer le cookie
    const domain = 'citaconsular.es';
    await cookieManager.applyBestCookie(context, domain);
    
    const page = await context.newPage();
    
    // Navigation progressive
    await page.goto(SPAIN_PORTAL_URL, { 
      waitUntil: 'domcontentloaded',
      timeout: 30000 
    });
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const isBlocked = await isCloudflareBlocking(page);
    
    await browser.close();
    
    return {
      strategy: "Stealth + Cookie",
      success: !isBlocked,
      timeMs: Date.now() - startTime,
      details: isBlocked ? "Combinaison échouée" : "Combinaison réussie"
    };
    
  } catch (error) {
    if (browser) await browser.close();
    return {
      strategy: "Stealth + Cookie",
      success: false,
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Exécute tous les scénarios de test
 */
async function runAllScenarios() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TEST DE SOLUTIONS GRATUITES POUR CLOUDFLARE - ESPAGNE       ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  
  const results: TestResult[] = [];
  
  // Exécuter tous les scénarios
  results.push(await scenario1_stealthBrowser());
  results.push(await scenario2_manualCookie());
  results.push(await scenario3_sessionPersistence());
  results.push(await scenario4_userAgentRotation());
  results.push(await scenario5_timingStrategy());
  results.push(await scenario6_refererStrategy());
  results.push(await scenario7_combinedStealthCookie());
  
  // Afficher les résultats
  console.log("\n\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                         RÉSULTATS                             ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  
  console.log("┌─────────────────────────────────────┬─────────┬─────────┬────────────────────────┐");
  console.log("│ Stratégie                           │ Succès  │ Temps   │ Détails                │");
  console.log("├─────────────────────────────────────┼─────────┼─────────┼────────────────────────┤");
  
  for (const result of results) {
    const successIcon = result.success ? "✅" : "❌";
    const timeStr = `${(result.timeMs / 1000).toFixed(1)}s`;
    const details = (result.details || result.error || "").substring(0, 22);
    
    console.log(`│ ${result.strategy.padEnd(35)} │ ${successIcon.padEnd(7)} │ ${timeStr.padEnd(7)} │ ${details.padEnd(22)} │`);
  }
  
  console.log("└─────────────────────────────────────┴─────────┴─────────┴────────────────────────┘");
  
  // Analyse des résultats
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log("\n╔════════════════════════════════════════════════════════════════╗");
  console.log("║                         ANALYSE                               ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");
  
  console.log(`Total scénarios: ${results.length}`);
  console.log(`Réussis: ${successful.length}`);
  console.log(`Échoués: ${failed.length}\n`);
  
  if (successful.length > 0) {
    console.log("✅ SOLUTIONS GRATUITES FONCTIONNELLES:\n");
    successful.forEach((s, i) => {
      console.log(`${i + 1}. ${s.strategy}`);
      console.log(`   Temps: ${(s.timeMs / 1000).toFixed(1)}s`);
      console.log(`   Détails: ${s.details}\n`);
    });
    
    // Trouver la meilleure solution
    const best = successful.reduce((best, current) => 
      current.timeMs < best.timeMs ? current : best
    );
    
    console.log("🎯 MEILLEURE SOLUTION RECOMMANDÉE:");
    console.log(`   ${best.strategy} (${(best.timeMs / 1000).toFixed(1)}s)`);
    console.log(`   ${best.details}\n`);
    
  } else {
    console.log("❌ AUCUNE SOLUTION GRATUITE N'A FONCTIONNÉ\n");
    console.log("Recommandations:\n");
    console.log("1. La solution manuelle avec cookie capturé reste la plus fiable");
    console.log("2. Capturer un nouveau cookie manuellement:");
    console.log("   npm run cloudflare:capture");
    console.log("3. Considérer l'utilisation d'un proxy résidentiel avec IP fixe");
    console.log("4. Évaluer les services payants (CapSolver, Anti-Captcha) si nécessaire\n");
  }
  
  // Sauvegarder les résultats
  const fs = await import('fs');
  fs.writeFileSync(
    './free-cloudflare-solutions-results.json',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      results,
      summary: {
        total: results.length,
        successful: successful.length,
        failed: failed.length,
        bestStrategy: successful.length > 0 ? successful.reduce((best, current) => 
          current.timeMs < best.timeMs ? current : best
        ).strategy : null
      }
    }, null, 2)
  );
  
  console.log("📄 Résultats sauvegardés dans: free-cloudflare-solutions-results.json\n");
}

// Exécuter les tests
runAllScenarios().catch(console.error);
