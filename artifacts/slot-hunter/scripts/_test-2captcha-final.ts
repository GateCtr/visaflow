import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test FINAL — proxy résidentiel 2Captcha + attente Captcha.solveFinished.
 * Le test précédent a confirmé que Captcha.detected fonctionne avec IP résidentielle.
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

// Tous les titres de challenge CF dans toutes les langues
const CF_CHALLENGE_TITLES = ["just a moment", "un momento", "un instant", "einen moment", "checking", "aguarde"];

function isCfChallengeTitle(title: string): boolean {
  const t = title.toLowerCase();
  return CF_CHALLENGE_TITLES.some(c => t.includes(c));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🏠 Test FINAL — Proxy résidentiel 2Captcha + CF solve");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Créer profil avec proxy résidentiel 2Captcha (our_proxy, id=1168)
  const profileId = `vf_final_${Date.now()}`;
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: API_KEY,
      accountId: ACCOUNT_ID,
      profileId,
      name: "VF Final Test",
      proxyMode: "our_proxy",
      proxyAccountId: 1168,
      country: "es",
    }),
  });

  // Connexion
  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  const cdpUrl = connData.connectionUri as string;
  console.log(`CDP: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 300_000, // 5min pour Captcha.solve
  });
  console.log("✅ Connecté");

  const page = await browser.newPage();
  const session = await page.createCDPSession();

  const t0 = Date.now();
  const el = () => ((Date.now() - t0) / 1000).toFixed(1);

  // Promesse pour solveFinished
  const solvePromise = new Promise<{ status: string; elapsed: number }>((resolve) => {
    session.on("Captcha.solveFinished", () => {
      resolve({ status: "finished", elapsed: Date.now() - t0 });
    });
    session.on("Captcha.solveFailed", () => {
      resolve({ status: "failed", elapsed: Date.now() - t0 });
    });
    // Timeout global 3min
    setTimeout(() => resolve({ status: "timeout", elapsed: Date.now() - t0 }), 180_000);
  });

  // Events logging
  session.on("Captcha.detected", () => console.log(`🔔 [${el()}s] Captcha.detected`));
  session.on("Captcha.waitForSolve", () => console.log(`🔔 [${el()}s] Captcha.waitForSolve`));
  session.on("Captcha.solveFinished", () => console.log(`🔔 [${el()}s] Captcha.solveFinished ✅`));
  session.on("Captcha.solveFailed", () => console.log(`🔔 [${el()}s] Captcha.solveFailed ❌`));

  // IP check
  await page.goto("https://api.ipify.org?format=json", { waitUntil: "networkidle2", timeout: 15_000 });
  const ipText = await page.evaluate(() => document.body.innerText);
  console.log(`IP: ${ipText}`);

  // Auto-solve ON
  await session.send("Captcha.setAutoSolve" as any, { autoSolve: true, options: [{ type: "*" }] });
  console.log("Auto-solve: ON\n");

  // Navigation
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

  const title1 = await page.title();
  console.log(`[${el()}s] Titre: "${title1}"`);
  console.log(`[${el()}s] Est un challenge CF: ${isCfChallengeTitle(title1)}`);

  if (isCfChallengeTitle(title1)) {
    console.log(`\n⏳ Attente résolution captcha (max 3 min)…`);

    // Monitoring parallèle pendant l'attente du solve
    const monitorInterval = setInterval(async () => {
      try {
        const snap = await page.evaluate(() => ({
          title: document.title,
          iframes: Array.from(document.querySelectorAll("iframe")).length,
          turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
        }));
        console.log(`[${el()}s] "${snap.title.slice(0, 35)}" iframes=${snap.iframes} turnstile=${snap.turnstile}`);
      } catch { /* page peut avoir navigué */ }
    }, 10_000);

    // Attendre le résultat
    const result = await solvePromise;
    clearInterval(monitorInterval);

    console.log(`\n📋 Résultat solve: ${result.status} (${(result.elapsed / 1000).toFixed(1)}s)`);

    if (result.status === "finished") {
      // Attendre la navigation post-solve
      console.log("⏳ Attente navigation post-solve (15s)…");
      await new Promise(r => setTimeout(r, 5_000));

      // Vérifier si la page a changé
      try {
        await page.waitForFunction(
          (titles: string[]) => {
            const t = document.title.toLowerCase();
            return !titles.some(c => t.includes(c)) && t.length > 2;
          },
          { timeout: 15_000 },
          CF_CHALLENGE_TITLES,
        );
      } catch { /* ok, peut-être déjà résolu */ }
    }
  } else {
    console.log("✅ Pas de challenge CF !");
  }

  // Résultat final
  const finalTitle = await page.title().catch(() => "?");
  console.log(`\n═══ RÉSULTAT FINAL ═══`);
  console.log(`Titre: "${finalTitle}"`);
  console.log(`Challenge résolu: ${!isCfChallengeTitle(finalTitle)}`);

  const cookies = await page.cookies();
  const cf = cookies.find(c => c.name === "cf_clearance");
  const php = cookies.find(c => c.name === "PHPSESSID");
  const allCookieNames = cookies.map(c => `${c.name}=${c.value.slice(0, 15)}`).join(", ");

  console.log(`🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 30) + "…" : "❌ absent"}`);
  console.log(`🍪 PHPSESSID: ${php ? "✅ " + php.value : "❌ absent"}`);
  console.log(`🍪 Tous: ${allCookieNames}`);

  // User-Agent
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => "?");
  console.log(`🌐 UA: ${ua.slice(0, 80)}`);

  if (cf || !isCfChallengeTitle(finalTitle)) {
    console.log("\n🎯 SUCCÈS — La session 2Captcha Browser fonctionne avec proxy résidentiel !");
  } else {
    console.log("\n❌ ÉCHEC — Le challenge n'a pas été résolu");
  }

  await browser.disconnect();

  // Cleanup
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  }).catch(() => {});

  console.log(`\n✅ Fin (${el()}s)`);
}

main().catch(console.error);
