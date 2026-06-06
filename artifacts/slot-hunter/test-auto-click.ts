import * as dotenv from "dotenv";
dotenv.config();

import { chromium, type Browser, type Page } from "playwright";

const SPAIN_PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

async function testAutoClick() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TEST DU CLIC AUTOMATIQUE SUR CHECKBOX CLOUDFLARE            ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  console.log("Ce script va:");
  console.log("1. Ouvrir un navigateur SANS cookie existant");
  console.log("2. Forcer l'apparition du challenge Cloudflare");
  console.log("3. Tenter de cliquer automatiquement sur la checkbox");
  console.log("4. Vérifier si le challenge est résolu\n");

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    // Lancer avec options anti-détection
    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
    });

    // Injecter script anti-détection
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
    });

    page = await context.newPage();

    console.log("Navigation vers le portail...");
    await page.goto(SPAIN_PORTAL_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    console.log("⏱️  Attente de 10 secondes pour laisser Cloudflare apparaître...");
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Vérifier si Cloudflare est présent
    const title = await page.title();
    const isBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(title);

    console.log(`Titre de la page: "${title}"`);
    console.log(`Cloudflare détecté: ${isBlocked}\n`);

    if (!isBlocked) {
      console.log("⚠️  Cloudflare n'est pas détecté automatiquement");
      console.log("Veuillez vérifier manuellement si une checkbox Cloudflare est visible dans le navigateur");
      console.log("Si vous voyez une checkbox, appuyez sur Entrée pour continuer le test du clic automatique");
      console.log("Sinon, appuyez sur Ctrl+C pour annuler\n");
      
      await new Promise(resolve => {
        process.stdin.once('data', resolve);
      });
      
      console.log("\n🔍 Recherche de la checkbox Cloudflare (mode manuel activé)...");
    } else {
      console.log("✅ Cloudflare détecté automatiquement\n");
    }

    console.log("\n🔍 Recherche de la checkbox Cloudflare...");

    // Chercher la checkbox avec plusieurs sélecteurs
    const checkboxSelectors = [
      'input[type="checkbox"]',
      '#cf-challenge-checkbox',
      '.cf-turnstile',
      '[data-sitekey]',
      'iframe[src*="challenges.cloudflare.com"]',
      'div[id*="cf-challenge"]',
      'div[class*="cf-"]'
    ];

    let foundElement = false;
    let clickedSuccessfully = false;

    for (const selector of checkboxSelectors) {
      try {
        console.log(`  Test sélecteur: ${selector}`);
        
        const elements = await page.$$(selector);
        console.log(`    Éléments trouvés: ${elements.length}`);
        
        if (elements.length > 0) {
          foundElement = true;
          console.log(`    ✅ Élément détecté avec: ${selector}`);
          
          // Essayer de cliquer sur chaque élément trouvé
          for (let i = 0; i < elements.length; i++) {
            try {
              const element = elements[i];
              
              // Si c'est une iframe, essayer d'accéder au contenu
              if (selector.includes('iframe')) {
                console.log(`    Tentative d'accès à l'iframe...`);
                const frame = await element.contentFrame();
                if (frame) {
                  console.log(`    ✅ Iframe accessible`);
                  
                  // Chercher la checkbox dans l'iframe
                  const frameCheckboxes = await frame.$$('input[type="checkbox"]');
                  console.log(`    Checkboxes dans iframe: ${frameCheckboxes.length}`);
                  
                  for (const frameCheckbox of frameCheckboxes) {
                    try {
                      await frameCheckbox.click();
                      console.log(`    ✅ Click sur checkbox dans iframe réussi!`);
                      clickedSuccessfully = true;
                      await new Promise(resolve => setTimeout(resolve, 5000));
                      break;
                    } catch (e) {
                      console.log(`    ❌ Erreur click iframe: ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }
                  
                  if (clickedSuccessfully) break;
                }
              } else {
                // Click normal sur l'élément
                console.log(`    Tentative de click...`);
                await element.click();
                console.log(`    ✅ Click réussi!`);
                clickedSuccessfully = true;
                await new Promise(resolve => setTimeout(resolve, 5000));
                break;
              }
            } catch (e) {
              console.log(`    ❌ Erreur click: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          
          if (clickedSuccessfully) break;
        }
      } catch (e) {
        console.log(`    ❌ Erreur sélecteur: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (!foundElement) {
      console.log("\n❌ Aucun élément Cloudflare détecté");
      console.log("Possibilités:");
      console.log("- Le challenge est déjà résolu");
      console.log("- La structure de la page a changé");
      console.log("- Cloudflare utilise une méthode différente\n");
    } else if (!clickedSuccessfully) {
      console.log("\n❌ Élément détecté mais click échoué");
      console.log("L'intervention manuelle est nécessaire\n");
    } else {
      console.log("\n✅ Click automatique effectué - vérification du résultat...");

      // Attendre et vérifier si le challenge est résolu
      await new Promise(resolve => setTimeout(resolve, 3000));

      const titleAfterClick = await page.title();
      const stillBlocked = /un instant|just a moment|verifying|attention required|comprobando/i.test(titleAfterClick);

      console.log(`Titre après click: "${titleAfterClick}"`);
      console.log(`Toujours bloqué: ${stillBlocked}\n`);

      if (!stillBlocked) {
        console.log("🎉 SUCCÈS! Le clic automatique a résolu le challenge Cloudflare!");
      } else {
        console.log("⚠️  Le clic automatique n'a pas résolu le challenge");
        console.log("Le challenge nécessite probablement une intervention humaine supplémentaire");
      }
    }

    console.log("\nAppuyez sur Entrée pour fermer le navigateur...");
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });

    await browser.close();
    console.log("✅ Test terminé");

  } catch (error) {
    console.error("\n❌ ERREUR:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
}

testAutoClick();
