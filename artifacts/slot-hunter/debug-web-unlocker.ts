const BRIGHTDATA_API = "https://api.brightdata.com/request";
const API_KEY = "04390ede-cb89-4a42-a4d0-d9a9c7bf8769";

async function debugWebUnlocker() {
  console.log("=== DEBUG WEB UNLOCKER ===\n");
  
  const testUrls = [
    {
      name: "Test API Bright Data",
      url: "https://geo.brdtest.com/mygeo.json",
      expected: "json"
    },
    {
      name: "Google (simple)",
      url: "https://www.google.com",
      expected: "html"
    },
    {
      name: "Portail Espagne",
      url: "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5",
      expected: "html"
    },
    {
      name: "Autre site test",
      url: "https://httpbin.org/headers",
      expected: "json"
    }
  ];
  
  for (const test of testUrls) {
    console.log(`\n=== ${test.name} ===`);
    console.log(`URL: ${test.url}`);
    
    try {
      const response = await fetch(BRIGHTDATA_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          zone: "web_unlocker1",
          url: test.url,
          format: "raw",
        }),
      });
      
      console.log(`Status: ${response.status} ${response.statusText}`);
      
      // Afficher les headers
      console.log("Headers:");
      response.headers.forEach((value, key) => {
        console.log(`  ${key}: ${value}`);
      });
      
      const text = await response.text();
      console.log(`Longueur réponse: ${text.length} caractères`);
      
      if (text.length > 0) {
        console.log("Premiers 500 caractères:");
        console.log(text.substring(0, Math.min(500, text.length)));
        
        if (text.length === 0) {
          console.log("⚠️  Réponse vide!");
          
          // Vérifier si c'est une erreur
          try {
            const jsonResponse = JSON.parse(text);
            console.log("Réponse JSON:", jsonResponse);
          } catch {
            // Pas JSON
          }
        }
      } else {
        console.log("❌ Réponse complètement vide");
      }
      
    } catch (error) {
      console.error("Erreur:", (error as Error).message);
    }
    
    // Attendre entre les requêtes
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Test avec différentes zones
  console.log("\n=== TEST DIFFÉRENTES ZONES ===\n");
  
  const zones = ["web_unlocker1", "web_unlocker", "unlocker", "default"];
  
  for (const zone of zones) {
    console.log(`\nZone: ${zone}`);
    
    try {
      const response = await fetch(BRIGHTDATA_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          zone: zone,
          url: "https://www.google.com",
          format: "raw",
        }),
      });
      
      const text = await response.text();
      console.log(`Status: ${response.status}, Longueur: ${text.length}`);
      
      if (text.length > 0 && text.length < 1000) {
        console.log("Réponse:", text);
      }
      
    } catch (error) {
      console.error("Erreur:", (error as Error).message);
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Vérifier la documentation Bright Data
  console.log("\n=== CONFIGURATION RECOMMANDÉE ===\n");
  console.log("D'après la documentation Bright Data:");
  console.log("1. Vérifier que la zone 'web_unlocker1' est activée");
  console.log("2. Vérifier les crédits/limites");
  console.log("3. Vérifier la configuration du unlocker");
  console.log("\nOptions de configuration possibles:");
  console.log(`
{
  "zone": "web_unlocker1",
  "url": "https://example.com",
  "format": "raw",
  "method": "GET",
  "headers": {
    "User-Agent": "Mozilla/5.0..."
  },
  "cookies": [],
  "unlocker": {
    "mode": "auto",  // auto, manual, bypass
    "response_format": "html",
    "wait_for": 10000,
    "retries": 3,
    "render_js": true,
    "wait_until": "networkidle"
  }
}
`);
  
  // Test avec configuration complète
  console.log("\n=== TEST CONFIGURATION COMPLÈTE ===\n");
  
  const fullConfig = {
    zone: "web_unlocker1",
    url: "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5",
    format: "raw",
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0"
    },
    unlocker: {
      mode: "auto",
      response_format: "html",
      wait_for: 15000, // 15 secondes pour Cloudflare
      retries: 2,
      render_js: true,
      wait_until: "networkidle",
      intercept_cookies: true,
      intercept_headers: true
    }
  };
  
  console.log("Test avec configuration complète...");
  
  try {
    const response = await fetch(BRIGHTDATA_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(fullConfig),
    });
    
    console.log(`Status: ${response.status} ${response.statusText}`);
    console.log("Headers:");
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().includes('cookie') || key.toLowerCase().includes('cf-')) {
        console.log(`  ${key}: ${value.substring(0, 100)}...`);
      }
    });
    
    const text = await response.text();
    console.log(`Longueur: ${text.length} caractères`);
    
    if (text.length > 0) {
      // Sauvegarder pour analyse
      const fs = await import('fs');
      fs.writeFileSync(`debug-response-${Date.now()}.html`, text);
      console.log("Réponse sauvegardée");
      
      // Analyser rapidement
      if (text.includes("cf-") || text.includes("cloudflare")) {
        console.log("⚠️  Cloudflare détecté dans la réponse");
      }
      if (text.includes("Bookitit") || text.includes("bkt")) {
        console.log("✅ Bookitit détecté!");
      }
    }
    
  } catch (error) {
    console.error("Erreur:", (error as Error).message);
  }
}

debugWebUnlocker().catch(console.error);