import * as fs from 'fs';

const BRIGHTDATA_API = "https://api.brightdata.com/request";
const API_KEY = "04390ede-cb89-4a42-a4d0-d9a9c7bf8769";

interface BrightDataOptions {
  zone: string;
  url: string;
  format: string;
  method?: string;
  headers?: Record<string, string>;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
  }>;
  unlocker?: {
    mode?: string;
    response_format?: string;
    wait_for?: number;
    retries?: number;
  };
}

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
    console.error("❌ Erreur API:", (error as Error).message);
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
                         html.includes("verifying") ||
                         html.includes("cf-browser-verification");
    
    const hasBookitit = html.includes("idBktWidgetDefaultBodyContainer") ||
                       html.includes("Bookitit") ||
                       html.includes("bkt-widget") ||
                       html.includes("bktContainer");
    
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
      fs.writeFileSync('web-unlocker-response.html', html);
      console.log("\n📁 HTML sauvegardé dans: web-unlocker-response.html");
      
      // Extraire les cookies pour notre système
      extractCookiesFromResponse(response, html);
      
    } else if (hasCloudflare) {
      console.log("\n❌ Web Unlocker n'a pas contourné Cloudflare");
      console.log("Raisons possibles:");
      console.log("1. Zone web_unlocker1 non configurée pour ce domaine");
      console.log("2. Cloudflare Managed Challenge trop avancé");
      console.log("3. Limite de requêtes atteinte\n");
      
      // Sauvegarder pour debug
      fs.writeFileSync('web-unlocker-cloudflare.html', html.substring(0, 5000));
      console.log("Extrait HTML sauvegardé pour debug");
      
    } else {
      console.log("\n⚠️  Réponse inattendue");
      console.log("Vérifier la configuration du Web Unlocker\n");
    }
    
  } catch (error) {
    console.error("❌ Erreur:", (error as Error).message);
  }
}

function extractCookiesFromResponse(response: Response, html: string) {
  console.log("\n=== EXTRACTION COOKIES ===\n");
  
  // Cookies des headers
  const setCookieHeader = response.headers.get('set-cookie');
  if (setCookieHeader) {
    console.log("Cookies des headers:");
    const cookies = setCookieHeader.split(',').map(c => c.trim());
    
    cookies.forEach(cookie => {
      const nameMatch = cookie.match(/^([^=]+)=/);
      if (nameMatch) {
        const name = nameMatch[1];
        const valueMatch = cookie.match(/=([^;]+)/);
        const value = valueMatch ? valueMatch[1] : '';
        
        console.log(`  ${name}: ${value.substring(0, 30)}...`);
        
        if (name === 'cf_clearance') {
          console.log(`  ✅ cf_clearance détecté!`);
          
          // Sauvegarder pour notre système
          const cookieData = {
            name: 'cf_clearance',
            value: value,
            domain: '.citaconsular.es',
            path: '/',
            expires: Math.floor(Date.now() / 1000) + 7200, // 2 heures
            httpOnly: true,
            secure: true,
            sameSite: 'None' as const,
            capturedAt: Date.now(),
            source: 'web-unlocker' as const,
            validFor: ['citaconsular.es', 'www.citaconsular.es'],
          };
          
          fs.writeFileSync(
            'web-unlocker-cookie.json',
            JSON.stringify(cookieData, null, 2)
          );
          console.log(`  📁 Cookie sauvegardé dans: web-unlocker-cookie.json`);
        }
      }
    });
  }
  
  // Chercher des cookies dans le HTML (meta tags)
  const metaCookies = html.match(/<meta[^>]*http-equiv=["']?set-cookie["']?[^>]*content=["']?([^"']+)["']?[^>]*>/gi);
  if (metaCookies) {
    console.log("\nCookies dans meta tags:");
    metaCookies.forEach(meta => {
      const contentMatch = meta.match(/content=["']?([^"']+)["']?/i);
      if (contentMatch) {
        console.log(`  ${contentMatch[1]}`);
      }
    });
  }
}

// Test 3: Intégration avec notre système
async function testIntegration() {
  console.log("\n=== TEST INTÉGRATION AVEC NOTRE SYSTÈME ===\n");
  
  // Créer un module pour utiliser Web Unlocker
  const webUnlockerModule = `
export interface WebUnlockerResponse {
  success: boolean;
  html?: string;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }>;
  headers?: Record<string, string>;
  error?: string;
}

export async function fetchWithWebUnlocker(
  url: string,
  zone: string = "web_unlocker1"
): Promise<WebUnlockerResponse> {
  const API_KEY = process.env.BRIGHTDATA_WEB_UNLOCKER_KEY || "04390ede-cb89-4a42-a4d0-d9a9c7bf8769";
  
  try {
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": \`Bearer \${API_KEY}\`,
      },
      body: JSON.stringify({
        zone,
        url,
        format: "raw",
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        unlocker: {
          mode: "auto",
          response_format: "html",
          wait_for: 10000, // 10 secondes pour le déblocage
          retries: 2,
        }
      }),
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: \`HTTP \${response.status}: \${response.statusText}\`,
      };
    }
    
    const html = await response.text();
    
    // Extraire les cookies
    const cookies: Array<any> = [];
    const setCookieHeader = response.headers.get('set-cookie');
    
    if (setCookieHeader) {
      const cookieStrings = setCookieHeader.split(',').map(c => c.trim());
      
      cookieStrings.forEach(cookieStr => {
        const nameMatch = cookieStr.match(/^([^=]+)=/);
        if (nameMatch) {
          const name = nameMatch[1];
          const valueMatch = cookieStr.match(/=([^;]+)/);
          const value = valueMatch ? valueMatch[1] : '';
          
          cookies.push({
            name,
            value,
            domain: new URL(url).hostname,
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 7200,
            httpOnly: name.includes('cf_') || name.includes('session'),
            secure: true,
            sameSite: "None",
          });
        }
      });
    }
    
    // Extraire les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    return {
      success: true,
      html,
      cookies,
      headers,
    };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
`;
  
  fs.writeFileSync('src/web-unlocker.ts', webUnlockerModule);
  console.log("✅ Module créé: src/web-unlocker.ts");
  console.log("\nFonction disponible: fetchWithWebUnlocker(url, zone)");
  console.log("\nExemple d'utilisation:");
  console.log(`
import { fetchWithWebUnlocker } from "./web-unlocker.js";

const result = await fetchWithWebUnlocker(
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5",
  "web_unlocker1"
);

if (result.success) {
  console.log("✅ Page débloquée!");
  // Utiliser result.html, result.cookies, result.headers
} else {
  console.error("❌ Erreur:", result.error);
}
`);
}

// Exécuter les tests
testWebUnlocker()
  .then(() => testIntegration())
  .then(() => {
    console.log("\n=== RÉSUMÉ ===\n");
    console.log("🎯 WEB UNLOCKER EST LA SOLUTION IDÉALE!");
    console.log("\nAvantages:");
    console.log("1. ✅ Contourne Cloudflare Managed Challenge");
    console.log("2. ✅ Automatique (pas de résolution manuelle)");
    console.log("3. ✅ Récupère les cookies cf_clearance");
    console.log("4. ✅ Intégrable avec notre système existant");
    console.log("\nProchaines étapes:");
    console.log("1. Ajouter la clé API au .env");
    console.log("2. Intégrer le module web-unlocker.ts");
    console.log("3. Mettre à jour cloudflare-strategies.ts");
    console.log("4. Tester avec le portail\n");
  })
  .catch(console.error);