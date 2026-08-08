import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test avec un NOUVEAU profil 2Captcha pour éviter les problèmes de profil verrouillé.
 * Crée un nouveau profil via API, puis teste la connexion et la détection captcha.
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

function randomProfileId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const id = Array.from(crypto.getRandomValues(new Uint8Array(20)))
    .map(b => chars[b % 36]).join("");
  return `visaflow_${id}`;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🧪 Test 2Captcha — Nouveau profil dédié");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const profileId = randomProfileId();
  console.log(`📋 Nouveau profil: ${profileId}`);

  // Obtenir connectionUri avec un nouveau profil
  const res = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: API_KEY,
      accountId: ACCOUNT_ID,
      profileId,
    }),
  });
  const data = await res.json() as any;
  if (data.status !== "OK") {
    console.error("❌ API error:", JSON.stringify(data));
    return;
  }

  let cdpUrl = data.connectionUri as string;
  console.log(`CDP URL brute: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);

  // Injecter -clickcaptcha
  cdpUrl = cdpUrl.replace(
    /(-pid-[^-:]+)(-proxy-|-nocaptcha|:)/,
    "$1-clickcaptcha$2",
  );
  console.log(`CDP URL +click: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

  // Connexion
  console.log("── Connexion ──");
  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 180_000,
  });
  console.log("✅ Connecté !\n");

  const page = await browser.newPage();
  const session = await page.createCDPSession();

  // Écouter événements
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

  session.on("Captcha.detected", () => console.log(`🔔 [${elapsed()}s] Captcha.detected`));
  session.on("Captcha.waitForSolve", () => console.log(`🔔 [${elapsed()}s] Captcha.waitForSolve`));
  session.on("Captcha.solveFinished", () => console.log(`🔔 [${elapsed()}s] Captcha.solveFinished`));
  session.on("Captcha.solveFailed", () => console.log(`🔔 [${elapsed()}s] Captcha.solveFailed`));

  // Auto-solve AVANT navigation
  console.log("── Captcha.setAutoSolve ──");
  await session.send("Captcha.setAutoSolve" as any, {
    autoSolve: true,
    options: [{ type: "*" }],
  });
  console.log("✅ Auto-solve activé\n");

  // Navigation
  console.log("── Navigation ──");
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 ${targetUrl}\n`);

  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });

  const title1 = await page.title();
  console.log(`[${elapsed()}s] Titre: "${title1}"`);

  // Inspection immédiate
  const info1 = await page.evaluate(() => {
    return {
      iframes: Array.from(document.querySelectorAll("iframe")).map(f => ({
        src: f.src?.slice(0, 120) || "",
        id: f.id,
      })),
      challengeStage: !!document.querySelector("#challenge-stage"),
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      bodySnippet: document.body?.innerText?.slice(0, 300) || "",
    };
  });
  console.log(`[${elapsed()}s] Iframes: ${info1.iframes.length}, challengeStage: ${info1.challengeStage}, turnstile: ${info1.turnstile}`);
  for (const f of info1.iframes) console.log(`  iframe: src="${f.src}" id="${f.id}"`);

  // Attendre les widgets dynamiques (5s)
  console.log(`\n[${elapsed()}s] Attente 5s pour chargement widgets…`);
  await new Promise(r => setTimeout(r, 5000));

  const info2 = await page.evaluate(() => {
    return {
      title: document.title,
      iframes: Array.from(document.querySelectorAll("iframe")).map(f => ({
        src: f.src?.slice(0, 120) || "",
        id: f.id,
      })),
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    };
  });
  console.log(`[${elapsed()}s] Titre: "${info2.title}", Iframes: ${info2.iframes.length}, turnstile: ${info2.turnstile}`);
  for (const f of info2.iframes) console.log(`  iframe: src="${f.src}" id="${f.id}"`);

  // Captcha.solve manuelle
  console.log(`\n[${elapsed()}s] Tentative Captcha.solve (detectTimeout=30s)…`);
  try {
    const result = await session.send("Captcha.solve" as any, {
      detectTimeout: 30_000,
      options: [{ type: "*" }],
    }) as any;
    console.log(`[${elapsed()}s] Résultat: ${JSON.stringify(result)}`);
  } catch (e: any) {
    console.log(`[${elapsed()}s] Erreur: ${e.message}`);
  }

  // Attente passive pour voir si le challenge se résout (60s)
  console.log(`\n[${elapsed()}s] Attente passive 90s…`);
  let solved = false;
  try {
    await page.waitForFunction(
      () => {
        const t = document.title.toLowerCase();
        return !t.includes("just a moment") && !t.includes("un instant") && !t.includes("checking");
      },
      { timeout: 90_000 },
    );
    solved = true;
    const newTitle = await page.title();
    console.log(`🎉 [${elapsed()}s] Challenge résolu ! Titre: "${newTitle}"`);
  } catch {
    console.log(`⏰ [${elapsed()}s] Challenge NON résolu après 90s`);
  }

  // Cookies
  const cookies = await page.cookies();
  const cf = cookies.find(c => c.name === "cf_clearance");
  const php = cookies.find(c => c.name === "PHPSESSID");
  console.log(`\n🍪 Cookies (${cookies.length} total):`);
  console.log(`   cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) + "…" : "❌ absent"}`);
  console.log(`   PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) + "…" : "❌ absent"}`);

  if (solved && cf) {
    console.log("\n🎯 SESSION OBTENUE — Le flux 2Captcha Browser fonctionne !");
  }

  await browser.disconnect();
  console.log(`\n✅ Déconnecté (durée totale: ${elapsed()}s)`);
}

main().catch(console.error);
