import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";

async function debugSitekeyExtraction() {
  console.log("Debug extraction du sitekey...");
  
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Attendre
    await new Promise(r => setTimeout(r, 5000));
    
    // Méthode 1: Chercher dans le HTML
    console.log("\nMéthode 1: Recherche dans le HTML...");
    const html = await page.content();
    
    // Patterns pour trouver le sitekey
    const patterns = [
      /0x4[A-Za-z0-9_-]{10,}/g,
      /sitekey["']?\s*:\s*["']([^"']+)["']/gi,
      /data-sitekey=["']([^"']+)["']/gi,
      /["']?k["']?\s*[:=]\s*["']([^"']+)["']/gi,
      /["']?websiteKey["']?\s*[:=]\s*["']([^"']+)["']/gi,
      /turnstile.*?["']([0-9a-zA-Z_-]{10,})["']/gi
    ];
    
    for (const pattern of patterns) {
      const matches = html.match(pattern);
      if (matches) {
        console.log(`Pattern ${pattern} trouvé:`, matches.slice(0, 3));
      }
    }
    
    // Méthode 2: Évaluer dans le contexte de la page
    console.log("\nMéthode 2: Évaluation dans le contexte...");
    
    const sitekeyFromEval = await page.evaluate(() => {
      const w = window as any;
      const results: string[] = [];
      
      // Chercher dans window
      if (w._cf_chl_opt && w._cf_chl_opt.sitekey) {
        results.push(`window._cf_chl_opt.sitekey: ${w._cf_chl_opt.sitekey}`);
      }
      
      // Chercher dans les scripts
      const scripts = Array.from(document.scripts);
      for (const script of scripts) {
        if (script.src.includes('cloudflare') || script.src.includes('challenge')) {
          results.push(`Script src: ${script.src}`);
          
          // Extraire le sitekey de l'URL
          const match = script.src.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
          if (match) {
            results.push(`  → Sitekey dans URL: ${match[1]}`);
          }
        }
      }
      
      // Chercher dans les iframes
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const iframe of iframes) {
        if (iframe.src.includes('cloudflare') || iframe.src.includes('challenge')) {
          results.push(`Iframe src: ${iframe.src}`);
          
          const match = iframe.src.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
          if (match) {
            results.push(`  → Sitekey dans iframe URL: ${match[1]}`);
          }
        }
      }
      
      // Chercher des éléments avec data-sitekey
      const elementsWithSitekey = document.querySelectorAll('[data-sitekey]');
      for (const el of elementsWithSitekey) {
        const sitekey = el.getAttribute('data-sitekey');
        if (sitekey) {
          results.push(`Element data-sitekey: ${sitekey}`);
        }
      }
      
      return results;
    });
    
    console.log("Résultats évaluation:");
    sitekeyFromEval.forEach(r => console.log(`  ${r}`));
    
    // Méthode 3: Intercepter les requêtes réseau
    console.log("\nMéthode 3: Interception des requêtes...");
    
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('cloudflare') || url.includes('challenge') || url.includes('turnstile')) {
        console.log(`Requête: ${url}`);
        
        // Chercher le sitekey dans l'URL
        const match = url.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
        if (match) {
          console.log(`  → Sitekey détecté: ${match[1]}`);
        }
      }
    });
    
    // Attendre pour capturer des requêtes
    await new Promise(r => setTimeout(r, 10000));
    
    // Méthode 4: Analyser les frames
    console.log("\nMéthode 4: Analyse des frames...");
    const frames = page.frames();
    console.log(`Nombre total de frames: ${frames.length}`);
    
    for (let i = 0; i < frames.length; i++) {
      try {
        const frame = frames[i];
        const frameUrl = frame.url();
        
        if (frameUrl.includes('cloudflare') || frameUrl.includes('challenge')) {
          console.log(`Frame ${i}: ${frameUrl}`);
          
          // Essayer d'extraire le sitekey
          const match = frameUrl.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
          if (match) {
            console.log(`  → Sitekey: ${match[1]}`);
          }
          
          // Essayer d'évaluer dans le frame
          try {
            const frameSitekey = await frame.evaluate(() => {
              const w = window as any;
              if (w._cf_chl_opt && w._cf_chl_opt.sitekey) {
                return w._cf_chl_opt.sitekey;
              }
              return null;
            });
            
            if (frameSitekey) {
              console.log(`  → Sitekey dans frame window: ${frameSitekey}`);
            }
          } catch (e) {
            // Ignorer les erreurs d'accès cross-origin
          }
        }
      } catch (error) {
        console.log(`Frame ${i} inaccessible`);
      }
    }
    
    // Prendre une capture
    await page.screenshot({ path: "debug-sitekey.png", fullPage: true });
    console.log("\nCapture sauvegardée: debug-sitekey.png");
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("Debug terminé.");
  }
}

debugSitekeyExtraction().catch(console.error);