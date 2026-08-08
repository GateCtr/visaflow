import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test avec proxy RÉSIDENTIEL 2Captcha au lieu du datacenter Decodo.
 * Hypothèse: CF bloque les IPs datacenter avec un JS challenge impossible.
 * Les IPs résidentielles devraient passer ou recevoir un Turnstile (que 2Captcha résout).
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🏠 Test avec proxy résidentiel 2Captcha");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 1. Lister les proxy accounts disponibles
  console.log("── Proxy accounts 2Captcha ──");
  const proxyRes = await fetch(`${API_BASE}/browser/proxy_accounts?key=${API_KEY}`);
  const proxyData = await proxyRes.json() as any;
  console.log(JSON.stringify(proxyData, null, 2));

  const proxyAccounts = proxyData.proxy?.data || [];
  if (proxyAccounts.length === 0) {
    console.log("⚠️ Aucun proxy account 2Captcha disponible.");
    console.log("Il faut acheter/configurer un proxy 2Captcha dans le dashboard.");
    console.log("Alternativement, on peut passer le proxy CSV Decodo résidentiel via l'URL.\n");

    // Essayer avec le proxy résidentiel Decodo (sticky session)
    // Charger depuis le CSV si disponible
    const { existsSync, readFileSync } = await import("fs");
    const { resolve } = await import("path");

    const csvPath = resolve(process.cwd(), "decodo-proxies.csv");
    if (existsSync(csvPath)) {
      const lines = readFileSync(csvPath, "utf-8").trim().split("\n").filter(l => l.trim());
      if (lines.length > 0) {
        const [host, port, user, pass] = lines[0].split(":");
        console.log(`📄 Proxy CSV trouvé: ${host}:${port}`);
        
        // Créer un profil avec ce proxy custom passé dans connectionUri
        const profileId = `vf_res_${Date.now()}`;
        await fetch(`${API_BASE}/browser/profiles`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId, name: "VF Residential", proxyMode: "none" }),
        });

        // Obtenir connectionUri avec custom proxy
        const connRes = await fetch(`${API_BASE}/browser/connection`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: API_KEY,
            accountId: ACCOUNT_ID,
            profileId,
            customProxy: { type: "http", host, port: parseInt(port), login: user, password: pass },
          }),
        });
        const connData = await connRes.json() as any;
        if (connData.status !== "OK") {
          console.error("ERROR:", JSON.stringify(connData));
          return;
        }

        await runTest(connData.connectionUri, profileId);
        return;
      }
    }

    console.log("Pas de proxy résidentiel disponible.");
    return;
  }

  // Utiliser le premier proxy account disponible
  const proxyAccount = proxyAccounts[0];
  console.log(`\nUtilisation proxy account: id=${proxyAccount.id}, ${proxyAccount.host}:${proxyAccount.port}`);

  // 2. Créer profil avec proxy résidentiel 2Captcha
  const profileId = `vf_res_${Date.now()}`;
  const createRes = await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: API_KEY,
      accountId: ACCOUNT_ID,
      profileId,
      name: "VF Residential",
      proxyMode: "our_proxy",
      proxyAccountId: proxyAccount.id,
      country: "es",
    }),
  });
  const createData = await createRes.json() as any;
  console.log(`Profil créé: ${createData.status}, country=${createData.profile?.country || "?"}`);

  // Connexion
  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  await runTest(connData.connectionUri, profileId);
}

async function runTest(cdpUrl: string, profileId: string) {
  console.log(`\nCDP: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

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

  // Events
  let events: string[] = [];
  session.on("Captcha.detected", (d: any) => { events.push("detected"); console.log(`🔔 [${el()}s] DETECTED`, JSON.stringify(d)); });
  session.on("Captcha.waitForSolve", (d: any) => { events.push("waitForSolve"); console.log(`🔔 [${el()}s] WAIT_FOR_SOLVE`, JSON.stringify(d)); });
  session.on("Captcha.solveFinished", (d: any) => { events.push("solveFinished"); console.log(`🔔 [${el()}s] SOLVE_FINISHED ✅`, JSON.stringify(d)); });
  session.on("Captcha.solveFailed", (d: any) => { events.push("solveFailed"); console.log(`🔔 [${el()}s] SOLVE_FAILED ❌`, JSON.stringify(d)); });

  // Vérifier IP
  console.log("\n── IP Check ──");
  await page.goto("https://api.ipify.org?format=json", { waitUntil: "networkidle2", timeout: 15_000 });
  const ip = await page.evaluate(() => document.body.innerText);
  console.log(`IP: ${ip}`);

  // Auto-solve ON
  await session.send("Captcha.setAutoSolve" as any, { autoSolve: true, options: [{ type: "*" }] });
  console.log("\nAuto-solve: ON");

  // Navigation
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  console.log(`[${el()}s] Titre: "${await page.title()}"`);

  // Inspection
  const dom = await page.evaluate(() => ({
    iframes: Array.from(document.querySelectorAll("iframe")).map(f => f.src?.slice(0, 120) || "(none)"),
    turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    cfForm: !!document.querySelector('#challenge-form'),
    body: document.body?.innerText?.slice(0, 200) || "",
  }));
  console.log(`Iframes: ${dom.iframes.length}, turnstile=${dom.turnstile}, cfForm=${dom.cfForm}`);
  for (const src of dom.iframes) console.log(`  ${src}`);

  // Monitoring 90s
  console.log(`\n[${el()}s] Monitoring 90s…`);
  for (let i = 0; i < 18; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const snap = await page.evaluate(() => ({
      title: document.title,
      iframes: Array.from(document.querySelectorAll("iframe")).length,
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    })).catch(() => null);

    if (!snap) { console.log(`[${el()}s] evaluate failed`); continue; }

    const resolved = !snap.title.toLowerCase().includes("just a moment") &&
                     !snap.title.toLowerCase().includes("un instant") &&
                     !snap.title.toLowerCase().includes("checking");
    console.log(`[${el()}s] "${snap.title.slice(0, 35)}" iframes=${snap.iframes} turnstile=${snap.turnstile} ${resolved ? "✅ RESOLVED" : ""}`);

    if (resolved) {
      const cookies = await page.cookies();
      const cf = cookies.find(c => c.name === "cf_clearance");
      const php = cookies.find(c => c.name === "PHPSESSID");
      console.log(`🎉 CHALLENGE RÉSOLU !`);
      console.log(`🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 25) : "❌"}`);
      console.log(`🍪 PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) : "❌"}`);
      break;
    }
  }

  console.log(`\nÉvénements captcha: ${events.length > 0 ? events.join(" → ") : "AUCUN"}`);

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
