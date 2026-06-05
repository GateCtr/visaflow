import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { cookieManager } from './cookie-manager.js';

// @ts-ignore
puppeteer.use(StealthPlugin());

/**
 * Resolves Cloudflare Challenge locally using Puppeteer Stealth and saves the cookie.
 */
export async function solveWithLocalStealth(portalUrl: string): Promise<boolean> {
  console.log("[LOCAL-STEALTH] 👻 Lancement d'un Chrome invisible pour résoudre Turnstile...");
  
  // @ts-ignore
  const browser = await puppeteer.launch({
    headless: "shell", // Utilise le moteur Chrome Headless moderne qui est beaucoup plus difficile à détecter
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--lang=fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    const page = await browser.newPage();
    const domain = new URL(portalUrl).hostname;

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    console.log(`[LOCAL-STEALTH] Navigation vers ${portalUrl}...`);
    await page.goto(portalUrl, { waitUntil: 'networkidle2', timeout: 45000 });

    console.log("[LOCAL-STEALTH] ⏳ Négociation du Turnstile (attente prolongée)...");
    await new Promise(resolve => setTimeout(resolve, 25000));

    const cookies = await page.cookies();
    const cfClearance = cookies.find(c => c.name === 'cf_clearance');

    if (!cfClearance) {
      throw new Error("cf_clearance non trouvé dans les cookies.");
    }

    console.log(`[LOCAL-STEALTH] ✅ Cookie cf_clearance obtenu avec succès !`);

    // Add cookie to the manager
    cookieManager.addCookie({
      name: cfClearance.name,
      value: cfClearance.value,
      domain: cfClearance.domain || `.${domain}`,
      path: cfClearance.path || '/',
      expires: cfClearance.expires || (Math.floor(Date.now() / 1000) + 7200),
      httpOnly: !!cfClearance.httpOnly,
      secure: !!cfClearance.secure,
      sameSite: (cfClearance.sameSite as any) || 'None',
      source: 'automatic',
      validFor: [domain, 'citaconsular.es', 'www.citaconsular.es']
    });

    return true;

  } catch (error: any) {
    console.error(`[LOCAL-STEALTH] ❌ Échec de la résolution locale: ${error.message}`);
    return false;
  } finally {
    await browser.close();
    console.log("[LOCAL-STEALTH] 🔋 Navigateur local fermé.");
  }
}
