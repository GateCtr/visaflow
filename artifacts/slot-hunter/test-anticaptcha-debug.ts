import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { extractTurnstileSitekey } from "./src/captcha.js";

async function debugAntiCaptcha() {
  console.log("Debug Anti-Captcha pour le portail Espagne...");
  
  // Vérifier les clés API
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  
  console.log(`Clé Anti-Captcha: ${anticaptchaKey ? "OUI" : "NON"}`);
  
  if (!anticaptchaKey) {
    console.error("ERREUR: ANTICAPTCHA_API_KEY n'est pas configurée!");
    return;
  }
  
  // Lancer le navigateur
  console.log("Lancement du navigateur...");
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Accéder au portail Espagne
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`Navigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Vérifier si Cloudflare est présent
    const title = await page.title();
    console.log(`Titre de la page: "${title}"`);
    
    // Attendre un peu pour que Cloudflare charge
    await new Promise(r => setTimeout(r, 5000));
    
    // Analyser la page pour trouver le sitekey
    console.log("Analyse de la page pour trouver le sitekey...");
    
    // 1. Vérifier les iframes
    const frames = page.frames();
    console.log(`Nombre de frames: ${frames.length}`);
    
    for (let i = 0; i < frames.length; i++) {
      try {
        const frameUrl = frames[i].url();
        console.log(`Frame ${i}: ${frameUrl}`);
        
        if (frameUrl.includes("challenges.cloudflare.com") || frameUrl.includes("challenge-platform")) {
          console.log(`  → Frame Cloudflare détectée!`);
          console.log(`  → URL complète: ${frameUrl}`);
          
          // Chercher le sitekey dans l'URL
          const mFrame = frameUrl.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
          if (mFrame) {
            console.log(`  → Sitekey trouvé dans l'URL: ${mFrame[1]}`);
          }
        }
      } catch (error) {
        console.log(`  → Frame ${i} inaccessible`);
      }
    }
    
    // 2. Utiliser la fonction extractTurnstileSitekey
    console.log("\nUtilisation de extractTurnstileSitekey...");
    const sitekeyResult = await extractTurnstileSitekey(page);
    
    if (sitekeyResult) {
      console.log(`✅ Sitekey trouvé: ${sitekeyResult.sitekey}`);
      console.log(`   Type: ${sitekeyResult.isCfChallenge ? "CF Managed Challenge" : "Turnstile standard"}`);
      
      // Tester avec anti-captcha directement
      console.log("\nTest direct avec Anti-Captcha API...");
      
      const response = await fetch("https://api.anti-captcha.com/getBalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: anticaptchaKey }),
        signal: AbortSignal.timeout(10000),
      });
      
      const balanceData = await response.json();
      console.log(`Balance Anti-Captcha: ${balanceData.balance ?? "N/A"}`);
      console.log(`Error ID: ${balanceData.errorId}`);
      
      if (balanceData.errorId === 0 && balanceData.balance !== undefined) {
        console.log(`✅ Clé Anti-Captcha valide! Solde: ${balanceData.balance}`);
        
        // Tester la création de tâche
        console.log("\nTest création de tâche Turnstile...");
        
        const taskResponse = await fetch("https://api.anti-captcha.com/createTask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientKey: anticaptchaKey,
            task: {
              type: "TurnstileTaskProxyless",
              websiteURL: portalUrl,
              websiteKey: sitekeyResult.sitekey,
            },
          }),
          signal: AbortSignal.timeout(15000),
        });
        
        const taskData = await taskResponse.json();
        console.log("Réponse création tâche:", taskData);
        
        if (taskData.errorId === 0 && taskData.taskId) {
          console.log(`✅ Tâche créée avec succès! ID: ${taskData.taskId}`);
        } else {
          console.log(`❌ Erreur création tâche: ${taskData.errorCode ?? taskData.errorId}`);
        }
      }
    } else {
      console.log("❌ Aucun sitekey trouvé");
      
      // Afficher le HTML pour debug
      console.log("\nExtrait du HTML de la page:");
      const html = await page.content();
      
      // Chercher des patterns dans le HTML
      const patterns = [
        /0x4[A-Za-z0-9_-]{10,}/g,
        /sitekey["']?\s*:\s*["']([^"']+)["']/gi,
        /data-sitekey=["']([^"']+)["']/gi,
        /k=([0-9a-zA-Z_-]{10,})/gi
      ];
      
      for (const pattern of patterns) {
        const matches = html.match(pattern);
        if (matches) {
          console.log(`Pattern ${pattern} trouvé:`, matches.slice(0, 3));
        }
      }
    }
    
    // Prendre une capture d'écran
    await page.screenshot({ path: "debug-anticaptcha.png", fullPage: true });
    console.log("\nCapture d'écran sauvegardée: debug-anticaptcha.png");
    
  } catch (error) {
    console.error("Erreur pendant le debug:", error);
  } finally {
    // Fermer le navigateur
    await browser.close();
    console.log("Debug terminé.");
  }
}

// Exécuter le debug
debugAntiCaptcha().catch(console.error);