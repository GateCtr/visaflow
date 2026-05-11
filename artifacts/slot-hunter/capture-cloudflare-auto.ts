import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

async function captureCloudflareBundleAuto() {
  console.log("Capture automatique du bundle Cloudflare...");
  console.log("Le navigateur va s'ouvrir, attendez 60 secondes pour résolution manuelle.");
  
  // Créer un dossier pour les captures
  const captureDir = join(process.cwd(), "cloudflare-capture-auto");
  if (!existsSync(captureDir)) {
    mkdirSync(captureDir, { recursive: true });
  }
  
  // Lancer le navigateur en mode headless=false pour interaction manuelle
  console.log("Lancement du navigateur...");
  const { browser, page, context } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  // Intercepter toutes les requêtes réseau
  const capturedScripts: Array<{
    url: string;
    content: string;
    type: string;
  }> = [];
  
  page.on('response', async (response) => {
    const url = response.url();
    
    // Capturer les scripts JavaScript
    if (url.includes('.js') || response.headers()['content-type']?.includes('javascript')) {
      try {
        const buffer = await response.body();
        if (buffer) {
          const content = buffer.toString('utf-8');
          
          // Filtrer les scripts intéressants
          if (url.includes('cloudflare') || url.includes('turnstile') || 
              url.includes('challenge') || url.includes('cdn-cgi') ||
              content.includes('cf_') || content.includes('turnstile') ||
              content.includes('challenge') || content.length > 1000) {
            
            const scriptInfo = {
              url,
              content,
              type: 'javascript'
            };
            
            capturedScripts.push(scriptInfo);
            
            // Sauvegarder le script
            const filename = url
              .replace(/[^a-zA-Z0-9]/g, '_')
              .substring(0, 100) + '.js';
            const filepath = join(captureDir, filename);
            
            writeFileSync(filepath, content, 'utf-8');
            console.log(`📦 Script capturé: ${filename} (${content.length} chars)`);
          }
        }
      } catch (error) {
        // Ignorer les erreurs de lecture
      }
    }
  });
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\n🌐 Navigation vers: ${portalUrl}`);
    console.log("⏳ Attendez 60 secondes pour résoudre le captcha manuellement...");
    
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Prendre une capture d'écran initiale
    await page.screenshot({ path: join(captureDir, 'initial.png') });
    console.log(`📸 Capture d'écran initiale sauvegardée`);
    
    // Attendre 60 secondes pour résolution manuelle
    console.log("\n⏰ Attente de 60 secondes pour résolution manuelle...");
    for (let i = 60; i > 0; i--) {
      if (i % 10 === 0) console.log(`   ${i} secondes restantes...`);
      await new Promise(r => setTimeout(r, 1000));
    }
    
    console.log("\n✅ Temps écoulé, analyse en cours...");
    
    // Prendre une capture d'écran finale
    await page.screenshot({ path: join(captureDir, 'final.png') });
    console.log(`📸 Capture d'écran finale sauvegardée`);
    
    // Capturer le HTML de la page
    const html = await page.content();
    writeFileSync(join(captureDir, 'page.html'), html, 'utf-8');
    console.log(`📄 HTML de la page sauvegardé`);
    
    // Capturer tous les cookies
    const cookies = await context.cookies();
    writeFileSync(join(captureDir, 'cookies.json'), JSON.stringify(cookies, null, 2), 'utf-8');
    console.log(`🍪 Cookies sauvegardés: ${cookies.length} cookies`);
    
    // Afficher le cookie cf_clearance s'il existe
    const cfClearance = cookies.find(c => c.name === "cf_clearance");
    if (cfClearance) {
      console.log(`✅ Cookie cf_clearance trouvé: ${cfClearance.value.slice(0, 30)}...`);
    } else {
      console.log(`❌ Aucun cookie cf_clearance trouvé`);
    }
    
    // Capturer les localStorage
    const localStorage = await page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) items[key] = localStorage.getItem(key) || '';
      }
      return items;
    });
    
    writeFileSync(join(captureDir, 'localStorage.json'), JSON.stringify(localStorage, null, 2), 'utf-8');
    console.log(`💾 localStorage sauvegardé: ${Object.keys(localStorage).length} items`);
    
    // Analyser les scripts capturés
    console.log("\n🔍 ANALYSE DES SCRIPTS CAPTURÉS:");
    console.log(`Total: ${capturedScripts.length} scripts`);
    
    // Rechercher des patterns intéressants dans TOUS les scripts
    const interestingScripts = capturedScripts.filter(script => 
      script.content.includes('turnstile') || 
      script.content.includes('sitekey') ||
      script.content.includes('cf_') ||
      script.content.includes('challenge')
    );
    
    console.log(`Scripts intéressants: ${interestingScripts.length}`);
    
    for (const script of interestingScripts.slice(0, 10)) { // Limiter à 10 scripts
      console.log(`\n📜 Script: ${script.url}`);
      console.log(`   Taille: ${script.content.length} caractères`);
      
      // Rechercher le sitekey
      const sitekeyMatch = script.content.match(/sitekey["']?\s*:\s*["']([^"']+)["']/i);
      if (sitekeyMatch) {
        console.log(`   🔑 SITEKEY TROUVÉ: ${sitekeyMatch[1]}`);
      }
      
      // Rechercher des callbacks
      const callbackMatch = script.content.match(/callback["']?\s*:\s*["']([^"']+)["']/i);
      if (callbackMatch) {
        console.log(`   📞 CALLBACK: ${callbackMatch[1]}`);
      }
      
      // Rechercher des actions
      const actionMatch = script.content.match(/action["']?\s*:\s*["']([^"']+)["']/i);
      if (actionMatch) {
        console.log(`   ⚡ ACTION: ${actionMatch[1]}`);
      }
      
      // Rechercher des URLs Turnstile
      const turnstileUrls = script.content.match(/https?:\/\/[^"'\s]*turnstile[^"'\s]*/gi);
      if (turnstileUrls) {
        console.log(`   🔗 URLs Turnstile: ${turnstileUrls.length}`);
        turnstileUrls.slice(0, 3).forEach((url, i) => {
          console.log(`      ${i + 1}. ${url}`);
        });
      }
    }
    
    // Analyser le HTML pour des informations supplémentaires
    console.log("\n🔍 ANALYSE DU HTML:");
    
    // Vérifier le titre
    const title = await page.title();
    console.log(`   Titre: "${title}"`);
    
    // Vérifier si Cloudflare est toujours présent
    const cfPattern = /un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i;
    const isCloudflare = cfPattern.test(title);
    
    if (isCloudflare) {
      console.log(`   ❌ Cloudflare toujours présent`);
    } else {
      console.log(`   ✅ Cloudflare résolu !`);
      
      // Vérifier si on voit le widget Bookitit
      const hasBookitit = html.includes('bookitit') || html.includes('bkt_');
      if (hasBookitit) {
        console.log(`   ✅ Widget Bookitit détecté`);
      }
    }
    
    // Rechercher des iframes
    const iframeCount = (html.match(/<iframe/gi) || []).length;
    console.log(`   🖼️ Iframes: ${iframeCount}`);
    
    // Rechercher des scripts inline avec Turnstile
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    let inlineTurnstileScripts = 0;
    
    while ((scriptMatch = scriptPattern.exec(html)) !== null) {
      const scriptContent = scriptMatch[1];
      if (scriptContent.includes('turnstile') || scriptContent.includes('0x4AAAAAA')) {
        inlineTurnstileScripts++;
        
        // Extraire le sitekey
        const inlineSitekey = scriptContent.match(/sitekey["']?\s*:\s*["']([^"']+)["']/);
        if (inlineSitekey) {
          console.log(`   🔑 Sitekey dans script inline: ${inlineSitekey[1]}`);
        }
      }
    }
    
    if (inlineTurnstileScripts > 0) {
      console.log(`   📝 Scripts inline Turnstile: ${inlineTurnstileScripts}`);
    }
    
    console.log("\n✅ CAPTURE TERMINÉE !");
    console.log(`📁 Tous les fichiers sont dans: ${captureDir}`);
    console.log("\n📋 RÉSUMÉ:");
    console.log(`   - Scripts capturés: ${capturedScripts.length}`);
    console.log(`   - Scripts intéressants: ${interestingScripts.length}`);
    console.log(`   - Cookies: ${cookies.length} (cf_clearance: ${cfClearance ? 'OUI' : 'NON'})`);
    console.log(`   - Cloudflare résolu: ${!isCloudflare ? 'OUI' : 'NON'}`);
    console.log(`   - Dossier: ${captureDir}`);
    
  } catch (error) {
    console.error("Erreur pendant la capture:", error);
  } finally {
    // Fermer le navigateur
    await browser.close();
    console.log("\n👋 Navigateur fermé. Analyse terminée!");
  }
}

// Exécuter la capture
captureCloudflareBundleAuto().catch(console.error);