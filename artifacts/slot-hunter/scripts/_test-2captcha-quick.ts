import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test rapide connexion 2Captcha Browser API
 * Teste 3 variantes :
 *   1. URL API brute (sans clickcaptcha)
 *   2. URL API + clickcaptcha
 *   3. Nouveau profil avec clickcaptcha
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function getConnectionUri(accountId: number, profileId?: string, customProxy?: any): Promise<string> {
  const body: Record<string, any> = { key: API_KEY, accountId };
  if (profileId) body.profileId = profileId;
  if (customProxy) body.customProxy = customProxy;

  const res = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json() as any;
  if (data.status !== "OK") throw new Error(`API error: ${JSON.stringify(data)}`);
  return data.connectionUri;
}

async function testConnection(label: string, cdpUrl: string): Promise<boolean> {
  console.log(`\n── Test: ${label} ──`);
  console.log(`   URL: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);

  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl,
      defaultViewport: { width: 1920, height: 1080 },
    });
    console.log("   ✅ Connexion réussie !");

    const page = await browser.newPage();
    const session = await page.createCDPSession();

    // Activer auto-solve
    await session.send("Captcha.setAutoSolve" as any, {
      autoSolve: true,
      options: [{ type: "*" }],
    });
    console.log("   ✅ Captcha.setAutoSolve activé");

    // Écouter les événements captcha
    session.on("Captcha.detected", () => console.log("   🔍 CAPTCHA détecté !"));
    session.on("Captcha.waitForSolve", () => console.log("   ⏳ CAPTCHA envoyé au solver…"));
    session.on("Captcha.solveFinished", () => console.log("   ✅ CAPTCHA résolu !"));
    session.on("Captcha.solveFailed", () => console.log("   ❌ CAPTCHA résolution échouée"));

    // Naviguer vers citaconsular.es
    const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
    console.log(`   🌐 Navigation vers ${targetUrl.slice(0, 60)}…`);

    await page.goto(targetUrl, {
      waitUntil: "networkidle2",
      timeout: 90_000,
    });

    const title = await page.title();
    console.log(`   📄 Titre: "${title}"`);

    const isCfChallenge = title.toLowerCase().includes("just a moment") ||
      title.toLowerCase().includes("un instant");

    if (isCfChallenge) {
      console.log("   🛡️ Challenge CF détecté — attente 60s pour auto-solve…");

      // Attendre que le titre change (challenge résolu)
      try {
        await page.waitForFunction(
          () => {
            const t = document.title.toLowerCase();
            return !t.includes("just a moment") && !t.includes("un instant") && !t.includes("checking");
          },
          { timeout: 60_000 },
        );
        const newTitle = await page.title();
        console.log(`   ✅ Challenge résolu ! Nouveau titre: "${newTitle}"`);

        // Extraire les cookies
        const cookies = await page.cookies();
        const cf = cookies.find(c => c.name === "cf_clearance");
        const php = cookies.find(c => c.name === "PHPSESSID");
        console.log(`   🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 20) + "…" : "❌"}`);
        console.log(`   🍪 PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) + "…" : "❌"}`);
      } catch {
        console.log("   ⏰ Timeout 60s — challenge non résolu");

        // Tenter Captcha.solve manuellement
        console.log("   🔧 Tentative Captcha.solve manuelle…");
        try {
          const solveResult = await session.send("Captcha.solve" as any, {
            detectTimeout: 15_000,
            options: [{ type: "*" }],
          }) as any;
          console.log(`   📋 Captcha.solve résultat: ${JSON.stringify(solveResult)}`);
        } catch (e: any) {
          console.log(`   ❌ Captcha.solve erreur: ${e.message}`);
        }

        // Vérifier le titre après manual solve
        await new Promise(r => setTimeout(r, 10_000));
        const finalTitle = await page.title();
        console.log(`   📄 Titre final: "${finalTitle}"`);

        const cookies = await page.cookies();
        const cf = cookies.find(c => c.name === "cf_clearance");
        console.log(`   🍪 cf_clearance final: ${cf ? "✅ " + cf.value.slice(0, 20) + "…" : "❌"}`);
      }
    } else {
      console.log("   ✅ Pas de challenge CF — page accessible directement !");
      const cookies = await page.cookies();
      const cf = cookies.find(c => c.name === "cf_clearance");
      const php = cookies.find(c => c.name === "PHPSESSID");
      console.log(`   🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 20) + "…" : "❌"}`);
      console.log(`   🍪 PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) + "…" : "❌"}`);
    }

    await browser.disconnect();
    return true;
  } catch (e: any) {
    console.log(`   ❌ Erreur: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🧪 Test rapide 2Captcha Browser API — VisaFlow");
  console.log("═══════════════════════════════════════════════════════════════");

  // Test 1: URL API brute
  console.log("\n🔵 Obtention CDP URL via API…");
  const baseUri = await getConnectionUri(ACCOUNT_ID);
  console.log(`   URI: ${baseUri.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);

  // Test avec clickcaptcha injecté
  const clickUri = baseUri.replace(
    /(-pid-[^-:]+)(-proxy-|-nocaptcha|:)/,
    "$1-clickcaptcha$2",
  );

  // Test la version avec clickcaptcha d'abord (c'est celle qui a échoué)
  const ok1 = await testConnection("Avec -clickcaptcha", clickUri);

  if (!ok1) {
    console.log("\n🟡 clickcaptcha a échoué, test sans…");
    // Attendre un peu pour libérer le profil
    await new Promise(r => setTimeout(r, 3000));
    await testConnection("Sans -clickcaptcha (URL brute API)", baseUri);
  }
}

main().catch(console.error);
