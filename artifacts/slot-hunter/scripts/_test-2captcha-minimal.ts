import "dotenv/config";
import puppeteer from "puppeteer";

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function main() {
  // 1. Lister les profils
  console.log("── PROFILS ──");
  const profilesRes = await fetch(`${API_BASE}/browser/profiles?key=${API_KEY}&accountId=${ACCOUNT_ID}&limit=50`);
  const profilesData = await profilesRes.json() as any;

  // Extraire le tableau de profils
  const rawProfiles = profilesData.profiles ?? profilesData.data ?? profilesData;
  const profilesArr = Array.isArray(rawProfiles) ? rawProfiles : Object.values(rawProfiles);
  for (const p of profilesArr) {
    if (typeof p === "object" && p !== null) {
      console.log(`  id=${(p as any).id} profileId="${(p as any).profileId}" name="${(p as any).name}" proxyMode="${(p as any).proxyMode}" country="${(p as any).country}"`);
    }
  }
  console.log(`Total: ${profilesArr.length}`);

  // 2. Créer un profil dédié (proxyMode inherit)
  console.log("\n── CRÉATION PROFIL ──");
  const newProfileId = `vf_test_${Date.now()}`;
  const createRes = await fetch(`${API_BASE}/browser/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId: newProfileId, name: "VF CF Test", proxyMode: "inherit" }),
  });
  const createData = await createRes.json() as any;
  console.log(`Création: status=${createData.status}, error=${createData.errorCode || "none"}`);
  if (createData.profile) console.log(`  profileId="${createData.profile.profileId}", country="${createData.profile.country}"`);

  // 3. Connexion avec le nouveau profil
  const useProfile = createData.status === "OK" ? newProfileId : undefined;
  console.log(`\n── CONNEXION (profil: ${useProfile || "Default"}) ──`);
  const connRes = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, ...(useProfile ? { profileId: useProfile } : {}) }),
  });
  const connData = await connRes.json() as any;
  if (connData.status !== "OK") { console.error("ERROR:", JSON.stringify(connData)); return; }

  const cdpUrl = connData.connectionUri as string;
  const masked = cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@");
  console.log(`CDP URL: ${masked}`);
  console.log(`Has -clickcaptcha: ${cdpUrl.includes("-clickcaptcha")}`);
  console.log(`Has -proxy-: ${cdpUrl.includes("-proxy-")}`);

  // 4. Connexion browser
  console.log("\n── BROWSER ──");
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
  session.on("Captcha.detected", (d: any) => console.log(`🔔 [${el()}s] DETECTED`, JSON.stringify(d)));
  session.on("Captcha.waitForSolve", (d: any) => console.log(`🔔 [${el()}s] WAIT_FOR_SOLVE`, JSON.stringify(d)));
  session.on("Captcha.solveFinished", (d: any) => console.log(`🔔 [${el()}s] SOLVE_FINISHED`, JSON.stringify(d)));
  session.on("Captcha.solveFailed", (d: any) => console.log(`🔔 [${el()}s] SOLVE_FAILED`, JSON.stringify(d)));

  // Auto-solve
  await session.send("Captcha.setAutoSolve" as any, { autoSolve: true, options: [{ type: "*" }] });
  console.log("Auto-solve: ON");

  // Navigation
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`Navigation: ${targetUrl.slice(0, 70)}…`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

  const title = await page.title();
  console.log(`[${el()}s] Titre: "${title}"`);

  // Inspection DOM
  const dom = await page.evaluate(() => ({
    iframes: Array.from(document.querySelectorAll("iframe")).map(f => ({
      src: f.src || "(empty)", id: f.id, w: f.width, h: f.height
    })),
    cfStage: !!document.querySelector("#challenge-stage"),
    cfForm: !!document.querySelector("#challenge-form"),
    turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
    divs: Array.from(document.querySelectorAll("div[id]")).map(d => d.id).slice(0, 20),
    body: document.body?.innerText?.slice(0, 300) || "",
    html: document.documentElement.outerHTML.slice(0, 2000),
  }));

  console.log(`[${el()}s] cfStage=${dom.cfStage}, cfForm=${dom.cfForm}, turnstile=${dom.turnstile}`);
  console.log(`Iframes: ${dom.iframes.length}`);
  for (const f of dom.iframes) console.log(`  src="${f.src.slice(0, 100)}" id="${f.id}" ${f.w}x${f.h}`);
  console.log(`Divs avec id: ${dom.divs.join(", ")}`);
  console.log(`Body: "${dom.body.slice(0, 200)}"`);
  console.log(`\nHTML extrait:\n${dom.html.slice(0, 1500)}`);

  // Attendre 10s et re-checker les iframes
  await new Promise(r => setTimeout(r, 10_000));
  const dom2 = await page.evaluate(() => ({
    title: document.title,
    iframes: Array.from(document.querySelectorAll("iframe")).map(f => f.src?.slice(0, 120) || "(empty)"),
    turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
  }));
  console.log(`\n[${el()}s] After 10s: titre="${dom2.title}", iframes=${dom2.iframes.length}, turnstile=${dom2.turnstile}`);
  for (const src of dom2.iframes) console.log(`  ${src}`);

  // Captcha.solve
  console.log(`\n[${el()}s] Captcha.solve (detectTimeout=20s)…`);
  try {
    const r = await session.send("Captcha.solve" as any, { detectTimeout: 20_000, options: [{ type: "*" }] }) as any;
    console.log(`Résultat: ${JSON.stringify(r)}`);
  } catch (e: any) {
    console.log(`Erreur: ${e.message.slice(0, 200)}`);
  }

  // Attente 30s
  console.log(`\n[${el()}s] Attente 30s…`);
  try {
    await page.waitForFunction(() => {
      const t = document.title.toLowerCase();
      return !t.includes("just a moment") && !t.includes("un instant") && t.length > 2;
    }, { timeout: 30_000 });
    console.log(`🎉 [${el()}s] RÉSOLU ! Titre: "${await page.title()}"`);
    const cookies = await page.cookies();
    const cf = cookies.find(c => c.name === "cf_clearance");
    console.log(`cf_clearance: ${cf ? cf.value.slice(0, 30) : "absent"}`);
  } catch {
    console.log(`⏰ [${el()}s] Non résolu.`);
  }

  await browser.disconnect();
  console.log(`\n✅ Fin (${el()}s)`);

  // Cleanup: supprimer le profil de test
  if (useProfile) {
    await fetch(`${API_BASE}/browser/profiles`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID, profileId: useProfile }),
    });
    console.log(`🗑️ Profil ${useProfile} supprimé`);
  }
}

main().catch(console.error);
