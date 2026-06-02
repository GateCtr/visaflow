/**
 * cev-f5-cookie-siphon.ts — Script de siphonnage du cookie F5 BIG-IP TS0110ceb4
 * 
 * Ce script utilise Playwright pour générer un cookie TS0110ceb4 légitime
 * via le fingerprinting JavaScript F5, puis l'extrait pour l'injection
 * dans les requêtes HTTP du bot.
 * 
 * Usage :
 *   npx tsx scripts/cev-f5-cookie-siphon.ts --email=xxx --password=xxx
 * 
 * Flux :
 *   1. Lance un navigateur Playwright avec fingerprinting réaliste
 *   2. Se connecte à visaonweb.diplomatie.be
 *   3. Attend que le cookie TS0110ceb4 soit généré par le JavaScript F5
 *   4. Extrait le cookie TS0110ceb4 + autres cookies pertinents
 *   5. Sauvegarde les cookies dans un fichier JSON pour injection
 *   6. Ferme le navigateur
 * 
 * Les cookies extraits peuvent être injectés dans cevHttpSetup.ts via :
 *   - Injection directe dans les headers des requêtes
 *   - Stockage en cache pour réutilisation
 */

import { chromium, Browser, Page, BrowserContext } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Command } from 'commander';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ExtractedCookies {
  tsCookie: {
    name: string;
    value: string;
    domain: string;
  };
  vowintCookies: Array<{
    name: string;
    value: string;
    domain: string;
  }>;
  cevCookies: Array<{
    name: string;
    value: string;
    domain: string;
  }>;
  userAgent: string;
  extractedAt: string;
  validForMinutes: number;
}

const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const CEV_BASE = 'https://appointment.cloud.diplomatie.be';

async function extractF5Cookie(email: string, password: string): Promise<ExtractedCookies | null> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  CEV F5 Cookie Siphon — Extraction cookie TS0110ceb4');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Email: ${email}`);
  console.log(`  Target: ${VOWINT_BASE}`);
  console.log('');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    // Lancer le navigateur avec fingerprinting réaliste
    browser = await chromium.launch({
      headless: false, // Visible pour debug, peut être true en production
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-features=BlockInsecurePrivateNetworkRequests',
        '--no-sandbox',
      ],
    });

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      locale: 'fr-BE',
      timezoneId: 'Europe/Brussels',
      ignoreHTTPSErrors: true,
    });

    // Activer le mode stealth pour éviter la détection
    await context.addInitScript(() => {
      // Masquer WebDriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      
      // Override les permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Override les plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['fr-BE', 'fr', 'en-US', 'en'],
      });
    });

    page = await context.newPage();

    // Intercepter les requêtes pour surveiller les cookies
    const cookiesCollected: Array<{name: string, value: string, domain: string}> = [];
    
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('diplomatie.be') || url.includes('hcaptcha.com')) {
        const headers = response.headers();
        const setCookie = headers['set-cookie'] || headers['Set-Cookie'];
        if (setCookie) {
          console.log(`  🍪 Set-Cookie détecté sur ${url.slice(0, 80)}...`);
        }
      }
    });

    // Naviguer vers VOWINT
    console.log('  🌐 Navigation vers VOWINT...');
    await page.goto(VOWINT_BASE, { waitUntil: 'networkidle', timeout: 30000 });

    // Attendre que la page soit chargée
    await page.waitForSelector('input[name="UserName"], input[type="email"], #UserName', { timeout: 10000 }).catch(() => {
      console.log('  ⚠️ Champ login non trouvé, peut-être déjà connecté ou page différente');
    });

    // Vérifier si on est déjà sur la page de login
    const currentUrl = page.url();
    if (currentUrl.includes('/Account/Login') || currentUrl.endsWith('/')) {
      console.log('  🔐 Connexion à VOWINT...');
      
      // Remplir le formulaire de login
      await page.fill('input[name="UserName"], input[type="email"], #UserName', email);
      await page.fill('input[name="Password"], input[type="password"], #Password', password);
      
      // Cliquer sur le bouton de connexion
      await page.click('input[type="submit"], button[type="submit"], .btn-primary');
      
      // Attendre la redirection post-login
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 });
    }

    console.log('  ⏳ Attente du fingerprinting F5 BIG-IP (15-30 secondes)...');
    
    // Attendre suffisamment longtemps pour que le JavaScript F5 s'exécute
    // Le fingerprinting F5 peut prendre plusieurs secondes
    await page.waitForTimeout(15000);
    
    // Recharger la page pour s'assurer que tous les scripts sont exécutés
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(5000);

    // Récupérer tous les cookies
    const allCookies = await context.cookies();
    
    // Filtrer les cookies pertinents
    const tsCookie = allCookies.find(c => c.name === 'TS0110ceb4');
    const vowintCookies = allCookies.filter(c => 
      c.domain.includes('visaonweb.diplomatie.be') && 
      c.name !== 'TS0110ceb4'
    );
    const cevCookies = allCookies.filter(c => 
      c.domain.includes('appointment.cloud.diplomatie.be')
    );

    if (!tsCookie) {
      console.log('  ❌ Cookie TS0110ceb4 NON TROUVÉ !');
      console.log('  Cookies disponibles:');
      allCookies.forEach(c => {
        console.log(`    - ${c.name}=${c.value.slice(0, 30)}... (${c.domain})`);
      });
      return null;
    }

    console.log('  ✅ Cookie TS0110ceb4 TROUVÉ !');
    console.log(`    Valeur: ${tsCookie.value.slice(0, 30)}...`);
    console.log(`    Domaine: ${tsCookie.domain}`);
    console.log(`    Cookies VOWINT: ${vowintCookies.length}`);
    console.log(`    Cookies CEV: ${cevCookies.length}`);

    const extracted: ExtractedCookies = {
      tsCookie: {
        name: tsCookie.name,
        value: tsCookie.value,
        domain: tsCookie.domain,
      },
      vowintCookies: vowintCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
      })),
      cevCookies: cevCookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
      })),
      userAgent: await page.evaluate(() => navigator.userAgent),
      extractedAt: new Date().toISOString(),
      validForMinutes: 60, // Les cookies F5 sont généralement valides 30-60 min
    };

    // Sauvegarder les cookies
    const outputFile = path.join(__dirname, '..', 'f5-cookies.json');
    fs.writeFileSync(outputFile, JSON.stringify(extracted, null, 2), 'utf-8');
    
    console.log('');
    console.log('  💾 Cookies sauvegardés dans:', outputFile);
    console.log('  ⏱️  Valides pour:', extracted.validForMinutes, 'minutes');
    console.log('');

    // Optionnel : tester l'accès CEV avec les cookies
    console.log('  🧪 Test d\'accès CEV avec les cookies extraits...');
    await testCevAccessWithCookies(context, extracted);

    return extracted;

  } catch (error) {
    console.error('  ❌ Erreur lors de l\'extraction:', error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

async function testCevAccessWithCookies(context: BrowserContext, cookies: ExtractedCookies): Promise<void> {
  try {
    // Créer une nouvelle page avec les cookies extraits
    const testPage = await context.newPage();
    
    // Ajouter le cookie TS0110ceb4
    await context.addCookies([{
      name: cookies.tsCookie.name,
      value: cookies.tsCookie.value,
      domain: cookies.tsCookie.domain,
      path: '/',
    }]);
    
    // Ajouter les autres cookies VOWINT
    for (const cookie of cookies.vowintCookies) {
      await context.addCookies([{
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: '/',
      }]);
    }
    
    // Tester l'accès à une page VOWINT
    console.log('  🔍 Test accès VOWINT avec cookie F5...');
    await testPage.goto(`${VOWINT_BASE}/en`, { waitUntil: 'networkidle', timeout: 15000 });
    
    // Vérifier qu'on n'est pas redirigé vers login
    const url = testPage.url();
    if (!url.includes('/Account/Login')) {
      console.log('  ✅ Accès VOWINT réussi avec cookie F5');
    } else {
      console.log('  ⚠️ Redirection vers login - cookie peut être invalide');
    }
    
    await testPage.close();
  } catch (error) {
    console.log('  ⚠️ Test d\'accès échoué:', error instanceof Error ? error.message.slice(0, 100) : String(error));
  }
}

async function main() {
  const program = new Command();
  
  program
    .name('cev-f5-cookie-siphon')
    .description('Extrait le cookie F5 BIG-IP TS0110ceb4 pour contourner le WAF')
    .requiredOption('-e, --email <email>', 'Email VOWINT')
    .requiredOption('-p, --password <password>', 'Mot de passe VOWINT')
    .option('-o, --output <file>', 'Fichier de sortie', 'f5-cookies.json')
    .parse(process.argv);
  
  const options = program.opts();
  
  const result = await extractF5Cookie(options.email, options.password);
  
  if (result) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ✅ EXTRACTION RÉUSSIE !');
    console.log('');
    console.log('  Instructions pour utiliser les cookies :');
    console.log('');
    console.log('  1. Injecter le cookie TS0110ceb4 dans cevHttpSetup.ts :');
    console.log('     - Ajouter le header "Cookie: TS0110ceb4=<valeur>"');
    console.log('     - Inclure aussi les autres cookies VOWINT si nécessaire');
    console.log('');
    console.log('  2. Mettre à jour getCevBrowserHeaders() dans cev-shared-impit.ts');
    console.log('     pour inclure automatiquement le cookie TS0110ceb4');
    console.log('');
    console.log('  3. Tester avec :');
    console.log('     npx tsx scripts/test-cev-comprehensive.ts --use-f5-cookie');
    console.log('');
    console.log('  ⚠️  Le cookie est valide pour environ 60 minutes');
    console.log('  ⚠️  Régénérer périodiquement avec ce script');
    console.log('═══════════════════════════════════════════════════════════════');
  } else {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ❌ EXTRACTION ÉCHOUÉE');
    console.log('');
    console.log('  Causes possibles :');
    console.log('  - Mauvais identifiants VOWINT');
    console.log('  - JavaScript F5 bloqué par adblocker/script blocker');
    console.log('  - Problème de réseau/proxy');
    console.log('  - Le WAF F5 a changé de comportement');
    console.log('');
    console.log('  Solutions :');
    console.log('  - Vérifier les identifiants');
    console.log('  - Désactiver les extensions navigateur');
    console.log('  - Utiliser un proxy résidentiel (IP Belgique)');
    console.log('  - Augmenter les timeouts dans le script');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Erreur fatale:', error);
    process.exit(1);
  });
}

export { extractF5Cookie, type ExtractedCookies };