import "dotenv/config";
import puppeteer from "puppeteer";

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🔍 Liste profils + Test avec profil disponible");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 1. Lister les profils existants
  console.log("── Profils existants ──");
  const profilesRes = await fetch(
    `${API_BASE}/browser/profiles?key=${API_KEY}&accountId=${ACCOUNT_ID}&limit=50`,
  );
  const profilesData = await profilesRes.json() as any;
  console.log("Réponse brute:", JSON.stringify(profilesData, null, 2).slice(0, 3000));

  // 2. Créer un nouveau profil via POST /browser/profiles
  console.log("\n── Création d'un nouveau profil ──");
  const newProfileId = `visaflow_test_${Date.now()}`;
  const createRes = await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: API_KEY,
      accountId: ACCOUNT_ID,
      profileId: newProfileId,
      name: "VisaFlow CF Test",
      proxyMode: "inherit",
    }),
  });
  const createData = await createRes.json() as any;
  console.log("Création:", JSON.stringify(createData, null, 2).slice(0, 2000));

  if (createData.status !== "OK") {
    console.log("⚠️ Échec création profil — utilisons le Default");
  }

  // 3. Obtenir connectionUri avec le nouveau profil ou le default
  const useProfileId = createData.status === "OK" ? newProfileId : undefined;
  console.log(`\n── Connexion avec profil: ${useProfileId || "Default"} ──`);

  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: API_KEY,
      accountId: ACCOUNT_ID,
      ...(useProfileId ? { profileId: useProfileId } : {}),
    }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") {
    console.error("❌ Connection error:", JSON.stringify(connData));
    return;
  }

  let cdpUrl = connData.connectionUri as string;
  console.log(`CDP URL: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);

  // Injecter -clickcaptcha
  cdpUrl = cdpUrl.replace(
    /(-pid-[^-:]+)(-proxy-|-nocaptcha|:)/,
    "$1-clickcaptcha$2",
  );
  console.log(`+clickcaptcha: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}`);

  // 4. Connexion et test
  console.log("\n── Connexion au navigateur ──");
  let browser;
  try {
    browser = await puppeteer.connect({
      browserWSEndpoint: cdpUrl,
      defaultViewport: { width: 1920, height: 1080 },
      protocolTimeout: 180_000,
    });
  } catch (e: any) {
    console.error(`❌ Connexion échouée: ${e.message}`);
    // Essayer sans -clickcaptcha
    console.log("\n🔄 Retry sans -clickcaptcha…");
    cdpUrl = connData.connectionUri;
    try {
      browser = await puppeteer.connect({
        browserWSEndpoint: cdpUrl,
        defaultViewport: { width: 1920, height: 1080 },
        protocolTimeout: 180_000,
      });
    } catch (e2: any) {
      console.error(`❌ Connexion échouée aussi sans clickcaptcha: ${e2.message}`);
      return;
    }
  }
  console.log("✅ Connecté !\n");

  const page = await browser.newPage();
  const session = await page.createCDPSession();

  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(1);

  // Événements captcha
  session.on("Captcha.detected", () => console.log(`🔔 [${elapsed()}s] Captcha.detected`));
  session.on("Captcha.waitForSolve", () => console.log(`🔔 [${elapsed()}s] Captcha.waitForSolve`));
  session.on("Captcha.solveFinished", () => console.log(`🔔 [${elapsed()}s] Captcha.solveFinished`));
  session.on("Captcha.solveFailed", () => console.log(`🔔 [${elapsed()}s] Captcha.solveFailed`));

  // Auto-solve
  await session.send("Captcha.setAutoSolve" as any, {
    autoSolve: true,
    options: [{ type: "*" }],
  });
  console.log("✅ Auto-solve activé");

  // Navigation
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 Navigation: ${targetUrl}`);

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const title1 = await page.title();
  console.log(`[${elapsed()}s] Titre: "${title1}"`);

  // Inspection page
  const info = await page.evaluate(() => ({
    iframes: Array.from(document.querySelectorAll("iframe")).map(f => f.src?.slice(0, 150) || ""),
    challengeStage: !!document.querySelector("#challenge-stage"),
    turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    bodyText: document.body?.innerText?.slice(0, 200) || "",
  }));
  console.log(`[${elapsed()}s] challengeStage=${info.challengeStage}, turnstile=${info.turnstile}, iframes=${info.iframes.length}`);
  for (const src of info.iframes) console.log(`  iframe: ${src}`);
  console.log(`Body: "${info.bodyText.slice(0, 150)}"`);

  // Attendre + observer
  console.log(`\n[${elapsed()}s] Attente passive 120s pour résolution auto…`);
  let solved = false;
  try {
    await page.waitForFunction(
      () => {
        const t = document.title.toLowerCase();
        return !t.includes("just a moment") && !t.includes("un instant") && !t.includes("checking") && t.length > 2;
      },
      { timeout: 120_000 },
    );
    solved = true;
    const newTitle = await page.title();
    console.log(`🎉 [${elapsed()}s] RÉSOLU ! Titre: "${newTitle}"`);
  } catch {
    console.log(`⏰ [${elapsed()}s] NON résolu après 120s`);

    // Inspection finale
    const finalInfo = await page.evaluate(() => ({
      title: document.title,
      iframes: Array.from(document.querySelectorAll("iframe")).map(f => f.src?.slice(0, 150) || ""),
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    }));
    console.log(`Titre final: "${finalInfo.title}"`);
    console.log(`Iframes final: ${finalInfo.iframes.length}`);
    for (const src of finalInfo.iframes) console.log(`  iframe: ${src}`);

    // Tenter solve manuel
    console.log(`\n[${elapsed()}s] Captcha.solve manuelle…`);
    try {
      const r = await session.send("Captcha.solve" as any, {
        detectTimeout: 15_000,
        options: [{ type: "*" }],
      }) as any;
      console.log(`Résultat: ${JSON.stringify(r)}`);
    } catch (e: any) {
      console.log(`Erreur: ${e.message}`);
    }
  }

  // Cookies
  const cookies = await page.cookies();
  const cf = cookies.find(c => c.name === "cf_clearance");
  console.log(`\n🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) + "…" : "❌ absent"}`);
  console.log(`🍪 Total cookies: ${cookies.length}`);

  await browser.disconnect();
  console.log(`\n✅ Terminé (${elapsed()}s)`);
}

main().catch(console.error);
