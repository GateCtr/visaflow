import * as dotenv from "dotenv";
import * as fs from 'fs';
import * as path from 'path';
dotenv.config();

import { launchBrowser } from "./src/browser.js";

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

async function useCapturedCookie() {
  console.log("Utilisation du cookie cf_clearance capturé...");
  
  // Lire le cookie capturé
  const captureDir = path.join(process.cwd(), 'cloudflare-capture');
  const cookiesPath = path.join(captureDir, 'cookies.json');
  
  if (!fs.existsSync(cookiesPath)) {
    console.error(`Fichier ${cookiesPath} non trouvé`);
    return;
  }
  
  const cookiesData = fs.readFileSync(cookiesPath, 'utf-8');
  const cookies: Cookie[] = JSON.parse(cookiesData);
  
  const cfClearance = cookies.find(c => c.name === 'cf_clearance');
  const phpSessionId = cookies.find(c => c.name === 'PHPSESSID');
  
  if (!cfClearance) {
    console.error("Cookie cf_clearance non trouvé dans le fichier capturé");
    return;
  }
  
  console.log(`Cookie cf_clearance trouvé:`);
  console.log(`  Valeur: ${cfClearance.value.slice(0, 20)}...`);
  console.log(`  Expire: ${new Date(cfClearance.expires * 1000).toISOString()}`);
  console.log(`  Domain: ${cfClearance.domain}`);
  
  // Lancer le navigateur
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Ajouter les cookies avant la navigation
    console.log("\nAjout des cookies au navigateur...");
    
    const context = page.context();
    await context.addCookies([
      {
        name: cfClearance.name,
        value: cfClearance.value,
        domain: cfClearance.domain,
        path: cfClearance.path,
        expires: cfClearance.expires,
        httpOnly: cfClearance.httpOnly,
        secure: cfClearance.secure,
        sameSite: cfClearance.sameSite as any,
      },
      ...(phpSessionId ? [{
        name: phpSessionId.name,
        value: phpSessionId.value,
        domain: phpSessionId.domain,
        path: phpSessionId.path,
        expires: phpSessionId.expires,
        httpOnly: phpSessionId.httpOnly,
        secure: phpSessionId.secure,
        sameSite: phpSessionId.sameSite as any,
      }] : [])
    ]);
    
    console.log("Cookies ajoutés avec succès");
    
    // Accéder au portail
    const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
    console.log(`\nNavigation vers: ${portalUrl}`);
    
    await page.goto(portalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    
    // Vérifier le titre
    const title = await page.title();
    console.log(`Titre: "${title}"`);
    
    // Vérifier si Cloudflare est présent
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      console.log("❌ Cloudflare toujours présent - le cookie n'a pas fonctionné");
      
      // Vérifier les cookies actuels
      const currentCookies = await context.cookies();
      const currentCfClearance = currentCookies.find(c => c.name === 'cf_clearance');
      console.log(`Cookie cf_clearance actuel: ${currentCfClearance ? "PRÉSENT" : "ABSENT"}`);
      if (currentCfClearance) {
        console.log(`  Valeur: ${currentCfClearance.value.slice(0, 20)}...`);
        console.log(`  Comparaison avec cookie capturé: ${currentCfClearance.value === cfClearance.value ? "IDENTIQUE" : "DIFFÉRENT"}`);
      }
    } else {
      console.log("✅ Cloudflare absent - le cookie a fonctionné!");
      
      // Vérifier le contenu de la page
      const pageContent = await page.content();
      const successIndicators = [
        "Embajada de España",
        "VISADOS", 
        "Servicios disponibles",
        "No hay horas disponibles",
        "bookitit"
      ];
      
      console.log("\nIndicateurs dans la page:");
      for (const indicator of successIndicators) {
        const found = pageContent.includes(indicator);
        console.log(`  ${indicator}: ${found ? "✅" : "❌"}`);
      }
      
      // Essayer d'accéder aux services
      console.log("\nTest d'accès aux services...");
      try {
        await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5#selectservices", {
          waitUntil: "domcontentloaded",
          timeout: 15000
        });
        
        const servicesTitle = await page.title();
        console.log(`Page services titre: "${servicesTitle}"`);
        
        // Vérifier si on voit les services
        const servicesContent = await page.content();
        if (servicesContent.includes("Servicios disponibles") || servicesContent.includes("No hay horas disponibles")) {
          console.log("✅ Accès au portail réussi avec le cookie capturé!");
        } else {
          console.log("⚠️  Accès au portail, mais contenu différent");
        }
      } catch (error) {
        console.log("❌ Erreur navigation services: ", error instanceof Error ? error.message : error);
      }
    }
    
    // Prendre une capture
    await page.screenshot({ path: "cookie-test.png", fullPage: true });
    console.log("\nCapture sauvegardée: cookie-test.png");
    
  } catch (error) {
    console.error("Erreur:", error);
  } finally {
    await browser.close();
    console.log("Test terminé.");
  }
}

useCapturedCookie().catch(console.error);