import type { Browser, BrowserContext, Page } from "playwright";
import { cookieManager } from "./cookie-manager.js";

export interface FreeCloudflareSolverOptions {
  /** URL du portail cible */
  portalUrl: string;
  /** Domaine pour les cookies */
  domain: string;
  /** Utiliser le mode stealth (anti-détection) */
  useStealth?: boolean;
  /** Utiliser les cookies manuels si disponibles */
  useCookies?: boolean;
  /** User-Agent personnalisé */
  userAgent?: string;
  /** Délai avant navigation (ms) */
  delayBeforeNavigation?: number;
  /** Utiliser la stratégie de référent */
  useReferer?: boolean;
  /** Headless mode */
  headless?: boolean;
  /** Attendre résolution manuelle du captcha (semi-automatique) */
  waitForManualCaptcha?: boolean;
  /** Timeout pour la résolution manuelle (ms) */
  manualCaptchaTimeout?: number;
}

export interface FreeCloudflareSolverResult {
  success: boolean;
  strategy: string;
  timeMs: number;
  error?: string;
  page?: Page;
  context?: BrowserContext;
  browser?: Browser;
}

/**
 * Solveur gratuit de Cloudflare utilisant des techniques stealth et cookies
 * Solution validée: fonctionne sans services payants comme Capsolver
 */
export async function solveCloudflareFree(
  options: FreeCloudflareSolverOptions
): Promise<FreeCloudflareSolverResult> {
  const startTime = Date.now();
  const {
    portalUrl,
    domain,
    useStealth = true,
    useCookies = true,
    userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    delayBeforeNavigation = 0,
    useReferer = false,
    headless = false,
    waitForManualCaptcha = true,
    manualCaptchaTimeout = 120000 // 2 minutes par défaut
  } = options;

  console.log(`[free-cloudflare-solver] Début résolution gratuite pour ${domain}`);
  console.log(`[free-cloudflare-solver] Stealth: ${useStealth}, Cookies: ${useCookies}, Referer: ${useReferer}`);

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // 1. Lancer le navigateur avec options anti-détection si stealth activé
    const launchOptions: any = {
      headless,
    };

    if (useStealth) {
      launchOptions.args = [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1920,1080'
      ];
    }

    const { chromium } = await import('playwright');
    browser = await chromium.launch(launchOptions);

    // 2. Créer le contexte avec configuration optimisée
    const contextOptions: any = {
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      permissions: ['geolocation'],
      geolocation: { latitude: 40.4168, longitude: -3.7038 }, // Madrid
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      }
    };

    if (useReferer) {
      contextOptions.extraHTTPHeaders = {
        ...contextOptions.extraHTTPHeaders,
        'Referer': `https://www.${domain}/`,
        'Origin': `https://www.${domain}`,
      };
    }

    context = await browser.newContext(contextOptions);

    // 3. Injecter script anti-détection si stealth activé
    if (useStealth) {
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

        // Simuler un canvas plus naturel (anti-fingerprinting)
        try {
          const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function(type?: string, quality?: number) {
            const ctx = this.getContext('2d');
            if (ctx) {
              try {
                const imageData = ctx.getImageData(0, 0, this.width, this.height);
                for (let i = 0; i < imageData.data.length; i += 4) {
                  imageData.data[i] += Math.random() * 0.1;
                }
                ctx.putImageData(imageData, 0, 0);
              } catch (e) {
                // Ignorer les erreurs de canvas
              }
            }
            return originalToDataURL.call(this, type, quality);
          };
        } catch (e) {
          // Ignorer les erreurs de modification de prototype
        }
      });
    }

    // 4. Appliquer les cookies manuels si activé
    if (useCookies) {
      cookieManager.loadManualCookies();
      const stats = cookieManager.getStats();
      
      if (stats.valid > 0) {
        console.log(`[free-cloudflare-solver] ${stats.valid} cookies valides disponibles`);
        const applied = await cookieManager.applyBestCookie(context, domain);
        
        if (applied) {
          console.log(`[free-cloudflare-solver] Cookie appliqué avec succès`);
        } else {
          console.log(`[free-cloudflare-solver] Échec application cookie, continuation sans cookie`);
        }
      } else {
        console.log(`[free-cloudflare-solver] Aucun cookie valide disponible`);
      }
    }

    // 5. Créer la page
    page = await context.newPage();

    // 6. Attendre avant navigation si délai configuré
    if (delayBeforeNavigation > 0) {
      console.log(`[free-cloudflare-solver] Attente ${delayBeforeNavigation}ms avant navigation`);
      await new Promise(resolve => setTimeout(resolve, delayBeforeNavigation));
    }

    // 7. Navigation avec référent si activé
    if (useReferer) {
      console.log(`[free-cloudflare-solver] Navigation via page d'accueil`);
      await page.goto(`https://www.${domain}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // 8. Navigation vers l'URL cible
    console.log(`[free-cloudflare-solver] Navigation vers ${portalUrl}`);
    await page.goto(portalUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    // 9. Attendre pour stabilisation
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 10. Vérifier si Cloudflare bloque
    const title = await page.title();
    const isBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(title);

    if (isBlocked) {
      console.log(`[free-cloudflare-solver] ⚠️  Cloudflare détecté: "${title}"`);
      
      // Essayer de cliquer automatiquement sur la checkbox si présente
      try {
        const checkboxSelectors = [
          'input[type="checkbox"]',
          '#cf-challenge-checkbox',
          '.cf-turnstile',
          '[data-sitekey]',
          'iframe[src*="challenges.cloudflare.com"]'
        ];
        
        let checkboxClicked = false;
        
        // Attendre que la checkbox apparaisse et soit visible
        console.log(`[free-cloudflare-solver] 🔍 Recherche de la checkbox Cloudflare...`);
        
        for (const selector of checkboxSelectors) {
          try {
            // Attendre que l'élément soit présent et visible
            const element = await page.waitForSelector(selector, {
              state: 'visible',
              timeout: 60000 // 10 secondes max par sélecteur
            }).catch(() => null);
            
            if (element) {
              console.log(`[free-cloudflare-solver] 🔘 Checkbox détectée et visible: ${selector}`);
              
              // Attendre un délai réaliste pour simuler un humain
              const humanDelay = Math.random() * 2000 + 1000; // 1-3 secondes
              console.log(`[free-cloudflare-solver] ⏱️  Attente ${(humanDelay / 1000).toFixed(1)}s avant click (simulation humaine)`);
              await new Promise(resolve => setTimeout(resolve, humanDelay));
              
              // Vérifier que l'élément est toujours visible avant de cliquer
              const isVisible = await element.isVisible();
              if (!isVisible) {
                console.log(`[free-cloudflare-solver] ⚠️  Élément n'est plus visible, passage au sélecteur suivant`);
                continue;
              }
              
              // Si c'est une iframe, essayer de cliquer dedans
              if (selector.includes('iframe')) {
                const frame = await element.contentFrame();
                if (frame) {
                  // Attendre que la checkbox dans l'iframe soit visible
                  const frameCheckbox = await frame.waitForSelector('input[type="checkbox"]', {
                    state: 'visible',
                    timeout: 5000
                  }).catch(() => null);
                  
                  if (frameCheckbox) {
                    console.log(`[free-cloudflare-solver] 🔘 Checkbox dans iframe détectée`);
                    
                    // Attendre un délai supplémentaire pour l'iframe
                    await new Promise(resolve => setTimeout(resolve, 500));
                    
                    await frameCheckbox.click();
                    console.log(`[free-cloudflare-solver] ✅ Click automatique sur checkbox dans iframe`);
                    checkboxClicked = true;
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    break;
                  }
                }
              } else {
                await element.click();
                console.log(`[free-cloudflare-solver] ✅ Click automatique sur checkbox`);
                checkboxClicked = true;
                await new Promise(resolve => setTimeout(resolve, 3000));
                break;
              }
            }
          } catch (e) {
            // Continuer avec le sélecteur suivant
            console.log(`[free-cloudflare-solver] ⚠️  Sélecteur ${selector} non trouvé ou erreur: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        
        // Vérifier si le click automatique a résolu le problème
        if (checkboxClicked) {
          const titleAfterClick = await page.title();
          const stillBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(titleAfterClick);
          
          if (!stillBlocked) {
            console.log(`[free-cloudflare-solver] ✅ Click automatique a résolu le challenge!`);
            console.log(`[free-cloudflare-solver] ✅ Accès autorisé: "${titleAfterClick}"`);
            
            // Capturer les cookies
            if (useCookies) {
              const captured = await cookieManager.captureCookies(context, 'automatic');
              if (captured > 0) {
                console.log(`[free-cloudflare-solver] ${captured} nouveaux cookies capturés`);
              }
            }
            
            const timeMs = Date.now() - startTime;
            const strategy = useStealth && useCookies ? 'stealth+cookies+auto-click' : 'auto-click';
            
            console.log(`[free-cloudflare-solver] ✅ Résolu en ${timeMs}ms avec stratégie: ${strategy}`);
            
            return {
              success: true,
              strategy,
              timeMs,
              page,
              context,
              browser
            };
          } else {
            console.log(`[free-cloudflare-solver] ⚠️  Click automatique n'a pas résolu le challenge`);
          }
        }
      } catch (e) {
        console.log(`[free-cloudflare-solver] ⚠️  Erreur click automatique: ${e instanceof Error ? e.message : String(e)}`);
      }
      
      // Si mode semi-automatique activé, attendre résolution manuelle
      if (waitForManualCaptcha) {
        console.log(`[free-cloudflare-solver] 🔄 Mode semi-automatique: attente résolution manuelle du captcha`);
        console.log(`[free-cloudflare-solver] ⏱️  Timeout: ${manualCaptchaTimeout / 1000}s`);
        console.log(`[free-cloudflare-solver] 👆 Résolvez le captcha dans le navigateur ouvert...`);
        
        // Attendre que Cloudflare disparaisse (résolution manuelle)
        const captchaResolved = await Promise.race([
          (async () => {
            while (true) {
              await new Promise(resolve => setTimeout(resolve, 1000));
              const currentTitle = await page.title();
              const stillBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(currentTitle);
              if (!stillBlocked) {
                return true;
              }
            }
          })(),
          new Promise<boolean>((_, reject) => 
            setTimeout(() => reject(new Error('Timeout captcha manuel')), manualCaptchaTimeout)
          )
        ]);
        
        if (captchaResolved) {
          console.log(`[free-cloudflare-solver] ✅ Captcha résolu manuellement!`);
          
          // Attendre un peu pour la stabilisation
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Vérifier à nouveau
          const finalTitle = await page.title();
          const stillBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(finalTitle);
          
          if (stillBlocked) {
            console.log(`[free-cloudflare-solver] ❌ Toujours bloqué après résolution manuelle`);
            
            // Nettoyer
            await page.close();
            await context.close();
            await browser.close();
            
            return {
              success: false,
              strategy: 'semi-automatic',
              timeMs: Date.now() - startTime,
              error: 'Still blocked after manual captcha'
            };
          }
          
          console.log(`[free-cloudflare-solver] ✅ Accès autorisé après résolution manuelle: "${finalTitle}"`);
        } else {
          console.log(`[free-cloudflare-solver] ❌ Timeout attente résolution manuelle`);
          
          // Nettoyer
          await page.close();
          await context.close();
          await browser.close();
          
          return {
            success: false,
            strategy: 'semi-automatic',
            timeMs: Date.now() - startTime,
            error: 'Timeout waiting for manual captcha'
          };
        }
      } else {
        // Mode automatique pur - échec
        console.log(`[free-cloudflare-solver] ❌ Mode automatique: échec contournement`);
        
        // Nettoyer
        await page.close();
        await context.close();
        await browser.close();
        
        return {
          success: false,
          strategy: useStealth && useCookies ? 'stealth+cookies' : (useStealth ? 'stealth' : 'basic'),
          timeMs: Date.now() - startTime,
          error: 'Cloudflare still blocking (automatic mode)'
        };
      }
    } else {
      console.log(`[free-cloudflare-solver] ✅ Accès autorisé sans captcha: "${title}"`);
    }

    // 11. Capturer les cookies si succès pour réutilisation future
    if (useCookies) {
      const captured = await cookieManager.captureCookies(context, 'automatic');
      if (captured > 0) {
        console.log(`[free-cloudflare-solver] ${captured} nouveaux cookies capturés`);
      }
    }

    const timeMs = Date.now() - startTime;
    const strategy = useStealth && useCookies ? 'stealth+cookies' : (useStealth ? 'stealth' : 'basic');

    console.log(`[free-cloudflare-solver] ✅ Résolu en ${timeMs}ms avec stratégie: ${strategy}`);

    // Retourner les instances pour usage continu
    return {
      success: true,
      strategy,
      timeMs,
      page,
      context,
      browser
    };

  } catch (error) {
    console.error(`[free-cloudflare-solver] Erreur:`, error);

    // Nettoyer en cas d'erreur
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});

    return {
      success: false,
      strategy: 'error',
      timeMs: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Fonction simplifiée pour usage rapide
 * Par défaut utilise le mode semi-automatique (attend résolution manuelle captcha)
 */
export async function bypassCloudflareFree(
  portalUrl: string,
  domain: string = 'citaconsular.es',
  options: Partial<FreeCloudflareSolverOptions> = {}
): Promise<{ success: boolean; page?: Page; context?: BrowserContext; browser?: Browser }> {
  const result = await solveCloudflareFree({
    portalUrl,
    domain,
    useStealth: true,
    useCookies: true,
    headless: false,
    waitForManualCaptcha: true,
    manualCaptchaTimeout: 120000,
    ...options
  });

  if (result.success) {
    return {
      success: true,
      page: result.page,
      context: result.context,
      browser: result.browser
    };
  }

  return { success: false };
}

/**
 * Fonction pour nettoyer les ressources
 */
export async function cleanupCloudflareFree(
  browser?: Browser,
  context?: BrowserContext,
  page?: Page
): Promise<void> {
  try {
    if (page) await page.close();
    if (context) await context.close();
    if (browser) await browser.close();
  } catch (error) {
    console.error('[free-cloudflare-solver] Erreur cleanup:', error);
  }
}
