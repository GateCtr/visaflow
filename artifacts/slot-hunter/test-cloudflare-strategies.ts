import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./src/browser.js";
import { solveAndApplyCloudflareChallenge } from "./src/capsolver.js";
import { solveCloudflareManagedChallenge } from "./src/cf-managed-injection.js";
import { detectAndSolveTurnstile } from "./src/captcha.js";

interface TestResult {
  strategy: string;
  success: boolean;
  timeMs: number;
  error?: string;
  cfClearance?: string;
}

async function testStrategy(
  name: string,
  testFn: () => Promise<boolean>,
  timeoutMs: number = 300000 // 5 minutes
): Promise<TestResult> {
  console.log(`\n=== TEST: ${name} ===`);
  const startTime = Date.now();
  
  try {
    const success = await Promise.race([
      testFn(),
      new Promise<boolean>((_, reject) => 
        setTimeout(() => reject(new Error(`Timeout après ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
    
    const timeMs = Date.now() - startTime;
    console.log(`Résultat: ${success ? "✅ SUCCÈS" : "❌ ÉCHEC"} (${timeMs}ms)`);
    
    return {
      strategy: name,
      success,
      timeMs,
    };
    
  } catch (error) {
    const timeMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.log(`Résultat: ❌ ERREUR (${timeMs}ms): ${errorMsg}`);
    
    return {
      strategy: name,
      success: false,
      timeMs,
      error: errorMsg,
    };
  }
}

// Stratégie 1: CapSolver avec iProyal (format standard)
async function strategy1() {
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    
    const title = await page.title();
    if (!/un instant|just a moment|verifying/i.test(title)) {
      console.log("Cloudflare non détecté");
      return true;
    }
    
    // Parser le proxy pour CapSolver
    const proxyUrl = process.env.IPROYAL_PROXY_URL!;
    const url = new URL(proxyUrl);
    const capsolverProxy = `${url.hostname}:${url.port}:${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    
    const success = await solveAndApplyCloudflareChallenge(
      page,
      process.env.CAPSOLVER_API_KEY!,
      capsolverProxy
    );
    
    if (success) {
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      if (cfClearance) {
        console.log(`Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
      }
    }
    
    return success;
  } finally {
    await browser.close();
  }
}

// Stratégie 2: CapSolver avec Bright Data
async function strategy2() {
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "brightdata",
  });
  
  try {
    await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    
    const title = await page.title();
    if (!/un instant|just a moment|verifying/i.test(title)) {
      console.log("Cloudflare non détecté");
      return true;
    }
    
    const success = await solveAndApplyCloudflareChallenge(
      page,
      process.env.CAPSOLVER_API_KEY!,
      process.env.BRIGHTDATA_PROXY_URL!
    );
    
    return success;
  } finally {
    await browser.close();
  }
}

// Stratégie 3: Anti-Captcha avec méthode adaptée (sans proxy fixe)
async function strategy3() {
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    
    const title = await page.title();
    if (!/un instant|just a moment|verifying/i.test(title)) {
      console.log("Cloudflare non détecté");
      return true;
    }
    
    const result = await solveCloudflareManagedChallenge(
      page,
      process.env.ANTICAPTCHA_API_KEY
    );
    
    return result === "solved";
  } finally {
    await browser.close();
  }
}

// Stratégie 4: Anti-Captcha Turnstile standard (si le portail change)
async function strategy4() {
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    
    const title = await page.title();
    if (!/un instant|just a moment|verifying/i.test(title)) {
      console.log("Cloudflare non détecté");
      return true;
    }
    
    // Utiliser la méthode standard de détection Turnstile
    const result = await detectAndSolveTurnstile(page, {
      anticaptchaApiKey: process.env.ANTICAPTCHA_API_KEY,
      capsolverApiKey: process.env.CAPSOLVER_API_KEY,
      twoCaptchaApiKey: process.env.TWOCAPTCHA_API_KEY,
    });
    
    return result === "solved";
  } finally {
    await browser.close();
  }
}

// Stratégie 5: Approche manuelle avec cookie capturé
async function strategy5() {
  const { browser, page } = await launchBrowser({
    headless: false,
    proxySource: "iproyal",
  });
  
  try {
    // Charger le cookie cf_clearance capturé précédemment
    const fs = await import('fs');
    const cookiesPath = './cloudflare-capture/cookies.json';
    
    if (fs.existsSync(cookiesPath)) {
      const cookiesData = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
      const cfClearanceCookie = cookiesData.find((c: any) => c.name === 'cf_clearance');
      
      if (cfClearanceCookie) {
        console.log(`Utilisation du cookie cf_clearance capturé: ${cfClearanceCookie.value.slice(0, 20)}...`);
        
        // Ajouter le cookie au contexte
        await page.context().addCookies([{
          name: 'cf_clearance',
          value: cfClearanceCookie.value,
          domain: '.citaconsular.es',
          path: '/',
          expires: Math.floor(Date.now() / 1000) + 7200,
          httpOnly: true,
          secure: true,
          sameSite: 'None' as const,
        }]);
      }
    }
    
    await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    return !isCloudflare;
  } finally {
    await browser.close();
  }
}

// Stratégie 6: Proxy résidentiel avec IP fixe (simulation)
async function strategy6() {
  console.log("Cette stratégie nécessite un proxy résidentiel avec IP fixe");
  console.log("À implémenter une fois un tel proxy obtenu");
  return false;
}

async function runAllStrategies() {
  console.log("=== TEST DE TOUTES LES STRATÉGIES CLOUDFLARE ===\n");
  
  const results: TestResult[] = [];
  
  // Vérifier les clés API
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const anticaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const iproyalProxy = process.env.IPROYAL_PROXY_URL;
  const brightdataProxy = process.env.BRIGHTDATA_PROXY_URL;
  
  console.log("Configuration actuelle:");
  console.log(`- CapSolver: ${capsolverKey ? "✅" : "❌"}`);
  console.log(`- Anti-Captcha: ${anticaptchaKey ? "✅" : "❌"}`);
  console.log(`- iProyal: ${iproyalProxy ? "✅" : "❌"}`);
  console.log(`- Bright Data: ${brightdataProxy ? "✅" : "❌"}`);
  
  // Exécuter les stratégies disponibles
  if (capsolverKey && iproyalProxy) {
    results.push(await testStrategy("1. CapSolver + iProyal", strategy1));
  }
  
  if (capsolverKey && brightdataProxy) {
    results.push(await testStrategy("2. CapSolver + Bright Data", strategy2));
  }
  
  if (anticaptchaKey && iproyalProxy) {
    results.push(await testStrategy("3. Anti-Captcha adapté + iProyal", strategy3));
  }
  
  if (anticaptchaKey && iproyalProxy) {
    results.push(await testStrategy("4. Anti-Captcha standard + iProyal", strategy4));
  }
  
  results.push(await testStrategy("5. Cookie capturé + iProyal", strategy5));
  
  // Stratégie 6 nécessite un proxy fixe
  results.push(await testStrategy("6. Proxy fixe (à implémenter)", strategy6));
  
  // Afficher les résultats
  console.log("\n\n=== RÉSULTATS FINAUX ===");
  console.log("┌────────────────────────────────────────────┬─────────┬─────────┬─────────────────┐");
  console.log("│ Stratégie                                  │ Succès  │ Temps   │ Détails         │");
  console.log("├────────────────────────────────────────────┼─────────┼─────────┼─────────────────┤");
  
  for (const result of results) {
    const successIcon = result.success ? "✅" : "❌";
    const timeStr = `${(result.timeMs / 1000).toFixed(1)}s`;
    const details = result.error ? result.error.slice(0, 15) + "..." : (result.success ? "OK" : "Échec");
    
    console.log(`│ ${result.strategy.padEnd(40)} │ ${successIcon.padEnd(7)} │ ${timeStr.padEnd(7)} │ ${details.padEnd(15)} │`);
  }
  
  console.log("└────────────────────────────────────────────┴─────────┴─────────┴─────────────────┘");
  
  // Recommandations
  const successfulStrategies = results.filter(r => r.success);
  
  console.log("\n=== RECOMMANDATIONS ===");
  
  if (successfulStrategies.length > 0) {
    console.log(`✅ ${successfulStrategies.length} stratégie(s) fonctionne(nt):`);
    successfulStrategies.forEach(s => {
      console.log(`   - ${s.strategy} (${s.timeMs}ms)`);
    });
    
    const bestStrategy = successfulStrategies.reduce((best, current) => 
      current.timeMs < best.timeMs ? current : best
    );
    
    console.log(`\n🎯 Stratégie recommandée: ${bestStrategy.strategy}`);
    
  } else {
    console.log("❌ Aucune stratégie n'a fonctionné.");
    console.log("\n🔧 Prochaines étapes:");
    console.log("1. Obtenir un proxy résidentiel avec IP fixe");
    console.log("2. Contacter le support CapSolver pour configuration spécifique");
    console.log("3. Explorer d'autres providers de résolution Cloudflare");
    console.log("4. Utiliser l'approche manuelle avec cookie capturé (stratégie 5)");
  }
  
  // Sauvegarder les résultats
  const fs = await import('fs');
  fs.writeFileSync(
    'cloudflare-strategy-results.json',
    JSON.stringify(results, null, 2)
  );
  console.log("\n📄 Résultats sauvegardés dans cloudflare-strategy-results.json");
}

runAllStrategies().catch(console.error);