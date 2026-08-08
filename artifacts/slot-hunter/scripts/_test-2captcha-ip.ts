import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Vérifie l'IP de sortie du navigateur cloud 2Captcha.
 * Si le proxy Decodo n'est PAS utilisé, c'est l'IP de 2Captcha qui est vue
 * par Cloudflare — et elle est probablement blacklistée.
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🌐 Vérification IP de sortie — 2Captcha Browser");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // 1. Vérifier la config du compte
  console.log("── Config compte ──");
  const accRes = await fetch(`${API_BASE}/browser/accounts?key=${API_KEY}`);
  const accData = await accRes.json() as any;
  const rawAccounts = accData.accounts ?? accData.data ?? accData;
  const accounts = Array.isArray(rawAccounts) ? rawAccounts : Object.values(rawAccounts);
  for (const acc of accounts) {
    const a = acc as any;
    if (a.id === ACCOUNT_ID) {
      console.log(`Account ${a.id}: proxyMode="${a.proxyMode}", country="${a.country}"`);
      if (a.customProxy) console.log(`  customProxy: ${a.customProxy.type}://${a.customProxy.host}:${a.customProxy.port}`);
      if (a.proxy) console.log(`  proxy: ${a.proxy.host}:${a.proxy.port}`);
    }
  }

  // 2. Créer profil + connexion
  const profileId = `vf_ip_${Date.now()}`;
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId, name: "VF IP Check", proxyMode: "inherit" }),
  });

  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  const cdpUrl = connData.connectionUri as string;
  console.log(`CDP: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

  // 3. Browser
  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 60_000,
  });

  const page = await browser.newPage();

  // 4. Vérifier l'IP via plusieurs services
  const ipServices = [
    "https://api.ipify.org?format=json",
    "https://httpbin.org/ip",
    "https://ifconfig.me/ip",
  ];

  for (const url of ipServices) {
    try {
      console.log(`── ${url} ──`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 15_000 });
      const text = await page.evaluate(() => document.body.innerText);
      console.log(`Réponse: ${text.trim().slice(0, 200)}`);
    } catch (e: any) {
      console.log(`Erreur: ${e.message.slice(0, 100)}`);
    }
  }

  // 5. Vérifier le User-Agent et la géolocalisation
  console.log("\n── Navigator info ──");
  const navInfo = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    language: navigator.language,
    languages: navigator.languages.join(", "),
    platform: navigator.platform,
    webdriver: (navigator as any).webdriver,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as any).deviceMemory,
  }));
  console.log(`UA: ${navInfo.userAgent}`);
  console.log(`Language: ${navInfo.language} (${navInfo.languages})`);
  console.log(`Platform: ${navInfo.platform}`);
  console.log(`Webdriver: ${navInfo.webdriver}`);
  console.log(`Cores: ${navInfo.hardwareConcurrency}, Memory: ${navInfo.deviceMemory}GB`);

  // 6. Test rapide sur un site sans CF pour voir si le navigateur fonctionne
  console.log("\n── Test site sans CF ──");
  try {
    await page.goto("https://example.com", { waitUntil: "networkidle2", timeout: 15_000 });
    console.log(`Titre: "${await page.title()}" ✅`);
  } catch (e: any) {
    console.log(`Erreur: ${e.message.slice(0, 100)}`);
  }

  await browser.disconnect();

  // Cleanup
  await fetch(`${API_BASE}/browser/profiles`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId }),
  });

  console.log("\n✅ Fin");
}

main().catch(console.error);
