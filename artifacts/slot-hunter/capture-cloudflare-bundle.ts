import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

async function captureCloudflareBundle() {
  console.log("Capture du bundle Cloudflare pour analyse...");
  console.log("Le navigateur va s'ouvrir, résolvez le captcha manuellement.");
  console.log("Pendant ce temps, je vais capturer tous les scripts JavaScript.");
  
  // Créer un dossier pour les captures
  const captureDir = join(process.cwd(), "cloudflare-capture");
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
          
          // Filtrer les scripts intéressants (Cloudflare, Turnstile, etc.)
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
    
    // Capturer aussi les fichiers de configuration JSON
    if (url.includes('.json') || response.headers()['content-type']?.includes('json')) {
      try {
        const buffer = await response.body();
        if (buffer) {
          const content = buffer.toString('utf-8');
          
          const scriptInfo = {
            url,
            content,
            type: 'json'
          };
          
          capturedScripts.push(scriptInfo);
          
          const filename = url
            .replace(/[^a-zA-Z0-9]/g, '_')
            .substring(0, 100) + '.json';
          const filepath = join(captureDir, filename);
          
          writeFileSync(filepath, content, 'utf-8');
          console.log(`📦 JSON capturé: ${filename} (${content.length} chars)`);
        }
      } catch (error) {
        // Ignorer les erreurs
      }
    }
  });
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\n🌐 Navigation vers: ${portalUrl}`);
    console.log("⏳ Attendez que la page charge, puis résolvez le captcha manuellement...");
    console.log("📝 Pendant ce temps, je capture tous les scripts JavaScript.");
    
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // Attendre que l'utilisateur résolve le captcha
    console.log("\n👤 À VOUS DE JOUER :");
    console.log("1. Résolvez le captcha Cloudflare manuellement");
    console.log("2. Attendez que la page redirige vers le portail");
    console.log("3. Une fois sur le portail, appuyez sur ENTER dans cette console");
    
    // Prendre une capture d'écran initiale
    await page.screenshot({ path: join(captureDir, 'initial.png') });
    console.log(`📸 Capture d'écran initiale sauvegardée: ${join(captureDir, 'initial.png')}`);
    
    // Attendre l'entrée utilisateur
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => {
        console.log("\n✅ Capture terminée, analyse en cours...");
        resolve();
      });
    });
    
    // Prendre une capture d'écran finale
    await page.screenshot({ path: join(captureDir, 'final.png') });
    console.log(`📸 Capture d'écran finale sauvegardée: ${join(captureDir, 'final.png')}`);
    
    // Capturer le HTML de la page
    const html = await page.content();
    writeFileSync(join(captureDir, 'page.html'), html, 'utf-8');
    console.log(`📄 HTML de la page sauvegardé: ${join(captureDir, 'page.html')}`);
    
    // Capturer tous les cookies
    const cookies = await context.cookies();
    writeFileSync(join(captureDir, 'cookies.json'), JSON.stringify(cookies, null, 2), 'utf-8');
    console.log(`🍪 Cookies sauvegardés: ${join(captureDir, 'cookies.json')}`);
    
    // Capturer les localStorage et sessionStorage
    const localStorage = await page.evaluate(() => {
      const items: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) items[key] = localStorage.getItem(key) || '';
      }
      return items;
    });
    
    writeFileSync(join(captureDir, 'localStorage.json'), JSON.stringify(localStorage, null, 2), 'utf-8');
    console.log(`💾 localStorage sauvegardé: ${join(captureDir, 'localStorage.json')}`);
    
    // Analyser les scripts capturés
    console.log("\n🔍 ANALYSE DES SCRIPTS CAPTURÉS:");
    console.log(`Total: ${capturedScripts.length} scripts`);
    
    // Rechercher des patterns intéressants
    const patterns = {
      turnstile: /turnstile|cf-turnstile|0x4AAAAAA/gi,
      cloudflare: /cloudflare|cdn-cgi|cf_/gi,
      challenge: /challenge|verify|human/gi,
      sitekey: /sitekey["']?\s*:\s*["']([^"']+)["']|data-sitekey=["']([^"']+)["']/gi,
      callback: /callback["']?\s*:\s*["']([^"']+)["']|data-callback=["']([^"']+)["']/gi,
      action: /action["']?\s*:\s*["']([^"']+)["']/gi,
    };
    
    for (const script of capturedScripts) {
      console.log(`\n📜 Script: ${script.url}`);
      console.log(`   Type: ${script.type}, Taille: ${script.content.length} caractères`);
      
      // Rechercher des patterns
      for (const [patternName, pattern] of Object.entries(patterns)) {
        const matches = script.content.match(pattern);
        if (matches && matches.length > 0) {
          console.log(`   🔎 ${patternName.toUpperCase()}: ${matches.length} occurrences`);
          
          // Extraire les valeurs uniques
          const uniqueMatches = [...new Set(matches.slice(0, 5))];
          uniqueMatches.forEach((match, i) => {
            console.log(`      ${i + 1}. ${match.substring(0, 100)}${match.length > 100 ? '...' : ''}`);
          });
        }
      }
      
      // Rechercher des URLs de configuration
      const configUrls = script.content.match(/https?:\/\/[^"'\s]+(?:turnstile|challenge|cloudflare)[^"'\s]*/gi);
      if (configUrls) {
        console.log(`   🔗 URLs de configuration: ${configUrls.length}`);
        configUrls.slice(0, 3).forEach((url, i) => {
          console.log(`      ${i + 1}. ${url}`);
        });
      }
    }
    
    // Rechercher des informations spécifiques dans le HTML
    console.log("\n🔍 ANALYSE DU HTML:");
    
    // Rechercher des iframes Cloudflare
    const iframePattern = /<iframe[^>]*src=["']([^"']*cloudflare[^"']*)["'][^>]*>/gi;
    const iframeMatches = html.match(iframePattern);
    if (iframeMatches) {
      console.log(`   🖼️ Iframes Cloudflare: ${iframeMatches.length}`);
      iframeMatches.forEach((iframe, i) => {
        console.log(`      ${i + 1}. ${iframe.substring(0, 150)}...`);
      });
    }
    
    // Rechercher des scripts inline
    const scriptPattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;
    let inlineScriptCount = 0;
    
    while ((scriptMatch = scriptPattern.exec(html)) !== null) {
      const scriptContent = scriptMatch[1];
      if (scriptContent.includes('cloudflare') || scriptContent.includes('turnstile')) {
        inlineScriptCount++;
        
        // Extraire des informations intéressantes
        if (scriptContent.includes('sitekey')) {
          const sitekeyMatch = scriptContent.match(/sitekey["']?\s*:\s*["']([^"']+)["']/);
          if (sitekeyMatch) {
            console.log(`   🔑 Sitekey trouvé dans script inline: ${sitekeyMatch[1]}`);
          }
        }
        
        if (scriptContent.includes('callback')) {
          const callbackMatch = scriptContent.match(/callback["']?\s*:\s*["']([^"']+)["']/);
          if (callbackMatch) {
            console.log(`   📞 Callback trouvé: ${callbackMatch[1]}`);
          }
        }
      }
    }
    
    if (inlineScriptCount > 0) {
      console.log(`   📝 Scripts inline avec Cloudflare: ${inlineScriptCount}`);
    }
    
    console.log("\n✅ CAPTURE TERMINÉE !");
    console.log(`📁 Tous les fichiers sont dans: ${captureDir}`);
    console.log("\n📋 RÉSUMÉ DE L'ANALYSE:");
    console.log(`   - Scripts capturés: ${capturedScripts.length}`);
    console.log(`   - Cookies: ${cookies.length}`);
    console.log(`   - localStorage: ${Object.keys(localStorage).length} items`);
    console.log(`   - Dossier: ${captureDir}`);
    
  } catch (error) {
    console.error("Erreur pendant la capture:", error);
  } finally {
    // Fermer le navigateur
    await browser.close();
    console.log("\n👋 Navigateur fermé. Analyse terminée!");
    process.exit(0);
  }
}

// Exécuter la capture
captureCloudflareBundle().catch(console.error);