import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test avec pays "es" (Espagne) et observation longue du challenge CF.
 * Hypothèse: le Turnstile widget peut apparaître APRÈS le JS challenge initial.
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🇪🇸 Test 2Captcha — Pays ES + observation challenge CF");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 1. Changer le pays du compte en "es"
  console.log("── Mise à jour pays → es ──");
  const updateRes = await fetch(`${API_BASE}/browser/accounts`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, id: ACCOUNT_ID, country: "es" }),
  });
  const updateData = await updateRes.json() as any;
  console.log(`Mise à jour: status=${updateData.status}, country=${updateData.account?.country || "?"}`);

  // 2. Créer un nouveau profil avec pays hérité (es)
  const profileId = `vf_es_${Date.now()}`;
  const createRes = await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId, name: "VF ES Test", proxyMode: "inherit" }),
  });
  const createData = await createRes.json() as any;
  console.log(`Profil créé: status=${createData.status}, country=${createData.profile?.country || "?"}`);

  // 3. Connexion
  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  const cdpUrl = connData.connectionUri as string;
  console.log(`CDP: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);
  console.log(`Country in URL: ${cdpUrl.match(/-country-([^-]+)/)?.[1] || "?"}\n`);

  // 4. Browser
  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 180_000,
  });
  console.log("✅ Connecté");

  const page = await browser.newPage();
  const session = await page.createCDPSession();

  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);

  // Événements
  let detectedCount = 0;
  session.on("Captcha.detected", (d: any) => { detectedCount++; console.log(`🔔 [${el()}s] DETECTED`, JSON.stringify(d)); });
  session.on("Captcha.waitForSolve", (d: any) => console.log(`🔔 [${el()}s] WAIT_FOR_SOLVE`, JSON.stringify(d)));
  session.on("Captcha.solveFinished", (d: any) => console.log(`🔔 [${el()}s] SOLVE_FINISHED ✅`, JSON.stringify(d)));
  session.on("Captcha.solveFailed", (d: any) => console.log(`🔔 [${el()}s] SOLVE_FAILED ❌`, JSON.stringify(d)));

  // Auto-solve AVANT navigation
  await session.send("Captcha.setAutoSolve" as any, { autoSolve: true, options: [{ type: "*" }] });
  console.log("Auto-solve: ON\n");

  // Navigation
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  console.log(`[${el()}s] Titre: "${await page.title()}"`);

  // Monitoring toutes les 5s pendant 60s
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const snap = await page.evaluate(() => ({
      title: document.title,
      iframes: Array.from(document.querySelectorAll("iframe")).length,
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      cfForm: !!document.querySelector('#challenge-form'),
      cfStage: !!document.querySelector('#challenge-stage'),
      bodySnippet: document.body?.innerText?.slice(0, 100) || "",
    })).catch(() => null);

    if (!snap) { console.log(`[${el()}s] page.evaluate failed`); continue; }

    const changed = !snap.title.toLowerCase().includes("just a moment") &&
                    !snap.title.toLowerCase().includes("un instant");
    console.log(`[${el()}s] titre="${snap.title.slice(0, 40)}" iframes=${snap.iframes} turnstile=${snap.turnstile} cfForm=${snap.cfForm}`);

    if (changed) {
      console.log(`🎉 [${el()}s] CHALLENGE RÉSOLU ! Titre: "${snap.title}"`);
      break;
    }
  }

  // Résultat final
  const finalTitle = await page.title().catch(() => "?");
  console.log(`\n[${el()}s] Titre final: "${finalTitle}"`);
  console.log(`Captcha.detected count: ${detectedCount}`);

  const cookies = await page.cookies();
  const cf = cookies.find(c => c.name === "cf_clearance");
  const php = cookies.find(c => c.name === "PHPSESSID");
  console.log(`🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) : "❌ absent"}`);
  console.log(`🍪 PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) : "❌ absent"}`);

  if (cf) {
    console.log("\n🎯 SESSION OBTENUE !");
  } else {
    // Tenter Captcha.solve une dernière fois
    console.log(`\n[${el()}s] Dernière tentative Captcha.solve…`);
    try {
      const r = await session.send("Captcha.solve" as any, { detectTimeout: 20_000, options: [{ type: "*" }] }) as any;
      console.log(`Résultat: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.log(`Erreur: ${e.message.slice(0, 150)}`);
    }
  }

  await browser.disconnect();
  console.log(`\n✅ Fin (${el()}s)`);

  // Cleanup
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  console.log(`🗑️ Profil ${profileId} supprimé`);
}

main().catch(console.error);
