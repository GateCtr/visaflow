import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { cookieManager } from "./cookie-manager.js";

// Apply stealth plugin to Playwright Extra
const chromiumStealth = chromium as any;
chromiumStealth.use((StealthPlugin as any)());

/**
 * Attempts to automatically click the Cloudflare Turnstile checkbox if it appears
 */
async function forceClickTurnstile(page: any): Promise<boolean> {
  try {
    console.log("[PLAYWRIGHT-STEALTH] 🔍 Recherche de l'Iframe Cloudflare Turnstile...");

    // 1. Attendre que l'iframe Cloudflare apparaisse
    await page.waitForSelector('iframe[src*="challenges.cloudflare.com"]', { timeout: 10000 });
    
    // 2. Cibler l'élément iframe
    const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]');
    if (!iframeElement) return false;

    console.log("[PLAYWRIGHT-STEALTH] 🎯 Iframe trouvé. Calcul des coordonnées physiques...");
    
    // 3. Récupérer les coordonnées (Bounding Box)
    const box = await iframeElement.boundingBox();
    if (!box) return false;

    // Calcul du centre de la case à cocher (généralement sur la gauche de l'iframe)
    const clicX = box.x + 45;
    const clicY = box.y + box.height / 2;

    console.log(`[PLAYWRIGHT-STEALTH] 🖲️ Déplacement de la souris vers [X: ${clicX}, Y: ${clicY}]...`);

    // 4. Déplacement fluide de la souris
    await page.mouse.move(clicX, clicY, { steps: 25 });
    
    // Micro-pause
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 400) + 200));

    // 5. Clic physique
    await page.mouse.click(clicX, clicY);
    console.log("[PLAYWRIGHT-STEALTH] 🔘 Clic de la case exécuté.");
    
    return true;
  } catch (error) {
    console.log("[PLAYWRIGHT-STEALTH] ℹ️ Pas de case Turnstile visible ou impossible de cliquer.");
    return false;
  }
}

/**
 * Resolves Cloudflare using a semi-invisible Playwright browser window positioned off-screen.
 */
export async function solveWithLocalPlaywright(portalUrl: string): Promise<boolean> {
  console.log("[PLAYWRIGHT-STEALTH] 👻 Lancement du faux-headless indétectable...");

  const domain = new URL(portalUrl).hostname;

  // Lancement en mode visible (headless: false) pour éviter la détection simple,
  // mais déplacé hors de l'écran principal pour rester invisible pour l'utilisateur
  const browser = await chromiumStealth.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-position=-2000,-2000',
      '--window-size=1200,800',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1200, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Africa/Kinshasa'
  });

  try {
    const page = await context.newPage();
    
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    console.log(`[PLAYWRIGHT-STEALTH] Navigation furtive vers ${portalUrl}...`);
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Attente pour laisser Turnstile et ses frames s'initialiser
    console.log("[PLAYWRIGHT-STEALTH] ⏳ Attente de chargement initial...");
    await new Promise(resolve => setTimeout(resolve, 8000));

    let cookies = await context.cookies();
    let cfClearance = cookies.find((c: any) => c.name === 'cf_clearance');

    if (!cfClearance) {
      console.log("[PLAYWRIGHT-STEALTH] Cookie cf_clearance non détecté immédiatement. Tentative de clic...");
      const clicked = await forceClickTurnstile(page);
      if (clicked) {
        console.log("[PLAYWRIGHT-STEALTH] ⏳ Clic effectué, attente de validation...");
        await new Promise(resolve => setTimeout(resolve, 8000));
      } else {
        console.log("[PLAYWRIGHT-STEALTH] ⏳ Pas de case cliquable détectée, attente de résolution passive...");
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }

    // Deuxième vérification après tentative de clic/résolution
    const updatedCookies = await context.cookies();
    const finalCfCookie = updatedCookies.find((c: any) => c.name === 'cf_clearance');

    if (!finalCfCookie) {
      throw new Error("Le cookie cf_clearance n'a pas pu être obtenu.");
    }

    console.log(`[PLAYWRIGHT-STEALTH] 🎯 SUCCÈS ! Cookie cf_clearance extrait : ${finalCfCookie.value.slice(0, 30)}...`);

    // Enregistrer dans le CookieManager
    cookieManager.addCookie({
      name: finalCfCookie.name,
      value: finalCfCookie.value,
      domain: finalCfCookie.domain || `.${domain}`,
      path: finalCfCookie.path || '/',
      expires: finalCfCookie.expires || (Math.floor(Date.now() / 1000) + 7200),
      httpOnly: !!finalCfCookie.httpOnly,
      secure: !!finalCfCookie.secure,
      sameSite: (finalCfCookie.sameSite as any) || 'None',
      source: 'automatic',
      validFor: [domain, 'citaconsular.es', 'www.citaconsular.es']
    });

    return true;

  } catch (error: any) {
    console.error(`[PLAYWRIGHT-STEALTH] ❌ Échec de la feinte locale : ${error.message}`);
    return false;
  } finally {
    await browser.close();
    console.log("[PLAYWRIGHT-STEALTH] 🔋 Instance fermée proprement.");
  }
}
