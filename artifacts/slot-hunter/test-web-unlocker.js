import fetch from 'node-fetch';

const BRIGHTDATA_API = "https://api.brightdata.com/request";
const API_KEY = "04390ede-cb89-4a42-a4d0-d9a9c7bf8769";

async function testWebUnlocker() {
  console.log("=== TEST WEB UNLOCKER BRIGHT DATA ===\n");
  
  // Test 1: API de test
  console.log("Test 1: API de test Bright Data...");
  try {
    const testResponse = await fetch(BRIGHTDATA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        zone: "web_unlocker1",
        url: "https://geo.brdtest.com/mygeo.json",
        format: "raw",
      }),
    });
    
    const testData = await testResponse.text();
    console.log("✅ API fonctionnelle");
    console.log("Réponse:", testData.substring(0, 200), "...\n");
  } catch (error) {
    console.error("❌ Erreur API:", error.message);
    return;
  }
  
  // Test 2: Portail Espagne
  console.log("Test 2: Portail Espagne (Cloudflare Managed Challenge)...");
  const portalUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";
  
  try {
    const startTime = Date.now();
    const response = await fetch(BRIGHTDATA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        zone: "web_unlocker1",
        url: portalUrl,
        format: "raw",
      }),
    });
    
    const elapsedTime = Date.now() - startTime;
    
    if (!response.ok) {
      console.error(`❌ Erreur HTTP: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error("Détails:", errorText.substring(0, 500));
      return;
    }
    
    const html = await response.text();
    console.log(`✅ Réponse reçue en ${elapsedTime}ms`);
    console.log(`Longueur HTML: ${html.length} caractères\n`);
    
    // Analyser la réponse
    const hasCloudflare = html.includes("un instant") || 
                         html.includes("just a moment") || 
                         html.includes("verifying");
    
    const hasBookitit = html.includes("idBktWidgetDefaultBodyContainer") ||
                       html.includes("Bookitit") ||
                       html.includes("bkt-widget");
    
    console.log("=== ANALYSE ===\n");
    console.log(`Cloudflare détecté: ${hasCloudflare ? "❌ OUI" : "✅ NON"}`);
    console.log(`Bookitit détecté: ${hasBookitit ? "✅ OUI" : "❌ NON"}`);
    
    if (!hasCloudflare && hasBookitit) {
      console.log("\n🎉 WEB UNLOCKER FONCTIONNE PARFAITEMENT!");
      console.log("🚀 CLOUDFLARE EST CONTOURNÉ!");
      console.log("📋 LE PORTAL EST ACCESSIBLE!\n");
      
      // Extraire des informations utiles
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      if (titleMatch) {
        console.log(`Titre: "${titleMatch[1]}"\n`);
      }
      
      // Chercher des cookies dans les headers
      const cookies = response.headers.get('set-cookie');
      if (cookies) {
        console.log("Cookies reçus:");
        const cookieLines = cookies.split(',');
        cookieLines.forEach((cookie, index) => {
          const cfClearance = cookie.match(/cf_clearance=([^;]+)/);
          if (cfClearance) {
            console.log(`✅ cf_clearance: ${cfClearance[1].substring(0, 30)}...`);
          }
        });
      }
      
      // Sauvegarder le HTML pour inspection
      const fs = await import('fs');
      fs.writeFileSync('web-unlocker-response.html', html);
      console.log("\n📁 HTML sauvegardé dans: web-unlocker-response.html");
      
    } else if (hasCloudflare) {
      console.log("\n❌ Web Unlocker n'a pas contourné Cloudflare");
      console.log("Raisons possibles:");
      console.log("1. Zone web_unlocker1 non configurée pour ce domaine");
      console.log("2. Cloudflare Managed Challenge trop avancé");
      console.log("3. Limite de requêtes atteinte\n");
      
      // Sauvegarder pour debug
      const fs = await import('fs');
      fs.writeFileSync('web-unlocker-cloudflare.html', html.substring(0, 5000));
      console.log("Extrait HTML sauvegardé pour debug");
      
    } else {
      console.log("\n⚠️  Réponse inattendue");
      console.log("Vérifier la configuration du Web Unlocker\n");
    }
    
  } catch (error) {
    console.error("❌ Erreur:", error.message);
  }
}

// Test 3: Options avancées
async function testAdvancedOptions() {
  console.log("\n=== TEST OPTIONS AVANCÉES ===\n");
  
  const options = {
    zone: "web_unlocker1",
    url: "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5",
    format: "raw",
    // Options avancées
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    },
    cookies: [
      {
        name: "preference",
        value: "fr",
        domain: "citaconsular.es",
        path: "/",
      }
    ],
    // Options de déblocage
    unlocker: {
      mode: "auto", // auto, manual, bypass
      response_format: "html",
      wait_for: 5000, // Attendre 5s pour le déblocage
      retries: 2,
    }
  };
  
  console.log("Test avec options avancées...");
  
  try {
    const response = await fetch(BRIGHTDATA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(options),
    });
    
    const html = await response.text();
    console.log(`Longueur: ${html.length} caractères`);
    
    const hasCloudflare = html.includes("un instant") || html.includes("just a moment");
    const hasBookitit = html.includes("idBktWidgetDefaultBodyContainer");
    
    console.log(`Cloudflare: ${hasCloudflare ? "❌" : "✅"}`);
    console.log(`Bookitit: ${hasBookitit ? "✅" : "❌"}`);
    
  } catch (error) {
    console.error("Erreur options avancées:", error.message);
  }
}

// Exécuter les tests
testWebUnlocker()
  .then(() => testAdvancedOptions())
  .catch(console.error);