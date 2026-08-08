import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test SANS auto-solve — hypothèse: l'extension interfère avec le JS challenge CF.
 * Le JS challenge devrait se résoudre naturellement par le navigateur (vrai Chromium).
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🧪 Test SANS auto-solve + flag -nocaptcha");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Créer profil
  const profileId = `vf_noauto_${Date.now()}`;
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId, name: "VF NoAuto", proxyMode: "inherit" }),
  });

  // Connexion AVEC -nocaptcha (désactive totalement l'extension captcha)
  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  // Injecter -nocaptcha pour désactiver l'extension
  let cdpUrl = connData.connectionUri as string;
  const cdpUrlNocaptcha = cdpUrl.replace(
    /(-pid-[^-:]+)(-proxy-|:)/,
    "$1-nocaptcha$2",
  );
  console.log(`URL sans captcha: ${cdpUrlNocaptcha.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);
  console.log(`URL originale:    ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

  // Test A: Avec -nocaptcha (extension désactivée)
  console.log("═══ TEST A: -nocaptcha (extension OFF) ═══");
  try {
    const browserA = await puppeteer.connect({
      browserWSEndpoint: cdpUrlNocaptcha,
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 120_000,
    });
    console.log("✅ Connecté (nocaptcha)");

    const pageA = await browserA.newPage();
    const t0a = Date.now();
    const elA = () => ((Date.now() - t0a) / 1000).toFixed(1);

    const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
    await pageA.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`[${elA()}s] Titre: "${await pageA.title()}"`);

    // Vérifier si l'extension est absente
    const hasExt = await pageA.evaluate(() =>
      Array.from(document.querySelectorAll("script")).some(s => s.src.includes("chrome-extension"))
    );
    console.log(`Extension captcha présente: ${hasExt}`);

    // Monitoring 60s
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const snap = await pageA.evaluate(() => ({
        title: document.title,
        iframes: Array.from(document.querySelectorAll("iframe")).length,
        turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      })).catch(() => null);

      if (!snap) { console.log(`[${elA()}s] evaluate failed`); continue; }
      console.log(`[${elA()}s] titre="${snap.title.slice(0, 30)}" iframes=${snap.iframes} turnstile=${snap.turnstile}`);

      if (!snap.title.toLowerCase().includes("just a moment") && !snap.title.toLowerCase().includes("un instant")) {
        console.log(`🎉 RÉSOLU (nocaptcha) ! Titre: "${snap.title}"`);
        const cookies = await pageA.cookies();
        const cf = cookies.find(c => c.name === "cf_clearance");
        console.log(`cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) : "❌"}`);
        break;
      }
    }

    await browserA.disconnect();
    console.log(`Fin test A (${elA()}s)\n`);
  } catch (e: any) {
    console.log(`❌ Test A erreur: ${e.message}\n`);
  }

  // Attendre que le profil se libère
  await new Promise(r => setTimeout(r, 3000));

  // Test B: Sans flag (extension active, mais pas d'auto-solve via CDP)
  console.log("═══ TEST B: extension ON, mais autoSolve=false ═══");
  const profileId2 = `vf_manual_${Date.now()}`;
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId: profileId2, name: "VF Manual", proxyMode: "inherit" }),
  });

  const connRes2 = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId: profileId2 }),
  });
  const connData2 = await connRes2.json() as any;
  if (connData2.status !== "OK") { console.error("ERROR B:", JSON.stringify(connData2)); return; }

  try {
    const browserB = await puppeteer.connect({
      browserWSEndpoint: connData2.connectionUri,
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 120_000,
    });
    console.log("✅ Connecté (autoSolve=false)");

    const pageB = await browserB.newPage();
    const sessionB = await pageB.createCDPSession();
    const t0b = Date.now();
    const elB = () => ((Date.now() - t0b) / 1000).toFixed(1);

    // AutoSolve OFF
    await sessionB.send("Captcha.setAutoSolve" as any, { autoSolve: false, options: [{ type: "*" }] });
    console.log("Auto-solve: OFF");

    sessionB.on("Captcha.detected", () => console.log(`🔔 [${elB()}s] DETECTED`));
    sessionB.on("Captcha.solveFinished", () => console.log(`🔔 [${elB()}s] FINISHED`));

    const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
    await pageB.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    console.log(`[${elB()}s] Titre: "${await pageB.title()}"`);

    // Monitoring 60s
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const snap = await pageB.evaluate(() => ({
        title: document.title,
        iframes: Array.from(document.querySelectorAll("iframe")).length,
      })).catch(() => null);

      if (!snap) { console.log(`[${elB()}s] evaluate failed`); continue; }
      console.log(`[${elB()}s] titre="${snap.title.slice(0, 30)}" iframes=${snap.iframes}`);

      if (!snap.title.toLowerCase().includes("just a moment") && !snap.title.toLowerCase().includes("un instant")) {
        console.log(`🎉 RÉSOLU (manual) ! Titre: "${snap.title}"`);
        const cookies = await pageB.cookies();
        const cf = cookies.find(c => c.name === "cf_clearance");
        console.log(`cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) : "❌"}`);
        break;
      }
    }

    await browserB.disconnect();
    console.log(`Fin test B (${elB()}s)`);
  } catch (e: any) {
    console.log(`❌ Test B erreur: ${e.message}`);
  }

  // Cleanup
  for (const pid of [profileId, profileId2]) {
    await fetch(`${API_BASE}/browser/profiles`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId: pid }),
    }).catch(() => {});
  }
  console.log("\n🗑️ Profils supprimés");
}

main().catch(console.error);
