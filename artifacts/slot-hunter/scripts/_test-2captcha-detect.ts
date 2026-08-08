import "dotenv/config";
import puppeteer from "puppeteer";

/**
 * Test approfondi : pourquoi Captcha.detected ne se déclenche pas ?
 * On inspecte le contenu de la page CF challenge pour comprendre
 * ce que 2Captcha voit (ou ne voit pas).
 */

const API_KEY = process.env.TWOCAPTCHA_API_KEY?.trim()!;
const ACCOUNT_ID = parseInt(process.env.TWOCAPTCHA_ACCOUNT_ID || "6012", 10);
const API_BASE = "https://api.2captcha.com";

async function getConnectionUri(): Promise<string> {
  const res = await fetch(`${API_BASE}/browser/connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: API_KEY, accountId: ACCOUNT_ID }),
  });
  const data = await res.json() as any;
  if (data.status !== "OK") throw new Error(`API error: ${JSON.stringify(data)}`);
  return data.connectionUri;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  🔍 Diagnostic détection CAPTCHA — 2Captcha Browser API");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Obtenir CDP URL et injecter -clickcaptcha
  let cdpUrl = await getConnectionUri();
  cdpUrl = cdpUrl.replace(
    /(-pid-[^-:]+)(-proxy-|-nocaptcha|:)/,
    "$1-clickcaptcha$2",
  );
  console.log(`CDP URL: ${cdpUrl.replace(/:([^:@]{3})[^:@]*@/, ":$1***@")}\n`);

  const browser = await puppeteer.connect({
    browserWSEndpoint: cdpUrl,
    defaultViewport: { width: 1920, height: 1080 },
    protocolTimeout: 180_000,
  });
  console.log("✅ Connecté au navigateur cloud\n");

  const page = await browser.newPage();
  const session = await page.createCDPSession();

  // Écouter TOUS les événements CDP Captcha
  const captchaEvents: Array<{ event: string; time: number; data?: any }> = [];
  const t0 = Date.now();

  for (const evt of ["Captcha.detected", "Captcha.waitForSolve", "Captcha.solveFinished", "Captcha.solveFailed"]) {
    session.on(evt, (data: any) => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      captchaEvents.push({ event: evt, time: Date.now() - t0, data });
      console.log(`🔔 [${elapsed}s] ${evt}`, data ? JSON.stringify(data) : "");
    });
  }

  // Activer auto-solve AVANT navigation
  console.log("── Étape 1: Captcha.setAutoSolve ──");
  await session.send("Captcha.setAutoSolve" as any, {
    autoSolve: true,
    options: [{ type: "*" }],
  });
  console.log("✅ Auto-solve activé\n");

  // Naviguer
  console.log("── Étape 2: Navigation ──");
  const targetUrl = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
  console.log(`🌐 ${targetUrl}`);

  // Utiliser domcontentloaded au lieu de networkidle2 pour ne pas bloquer
  await page.goto(targetUrl, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });

  const title1 = await page.title();
  console.log(`📄 Titre initial: "${title1}"\n`);

  // Inspecter le contenu de la page
  console.log("── Étape 3: Inspection de la page CF ──");
  const pageInfo = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll("iframe")).map(f => ({
      src: f.src || f.getAttribute("src") || "",
      id: f.id,
      name: f.name,
      width: f.width,
      height: f.height,
      visible: f.offsetParent !== null,
    }));

    const cfElements = {
      challengeRunning: !!document.querySelector(".cf-challenge-running, #challenge-running"),
      challengeStage: !!document.querySelector("#challenge-stage"),
      cfPleaseWait: !!document.querySelector("#cf-please-wait"),
      turnstileIframe: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      turnstileDiv: !!document.querySelector('[class*="turnstile"], [id*="turnstile"], .cf-turnstile'),
      cfWrapper: !!document.querySelector("#cf-wrapper, .cf-wrapper"),
      challengeForm: !!document.querySelector('#challenge-form, form[action*="challenge"]'),
      scripts: Array.from(document.querySelectorAll("script")).map(s => s.src).filter(Boolean).slice(0, 10),
    };

    return {
      title: document.title,
      url: window.location.href,
      bodyText: document.body?.innerText?.slice(0, 500) || "",
      iframes,
      cfElements,
      htmlSnippet: document.documentElement.outerHTML.slice(0, 3000),
    };
  });

  console.log(`URL actuelle: ${pageInfo.url}`);
  console.log(`Titre: "${pageInfo.title}"`);
  console.log(`Body text: "${pageInfo.bodyText.slice(0, 200)}"`);
  console.log(`Iframes trouvés: ${pageInfo.iframes.length}`);
  for (const f of pageInfo.iframes) {
    console.log(`  - src="${f.src.slice(0, 100)}" id="${f.id}" visible=${f.visible}`);
  }
  console.log(`CF Elements:`, JSON.stringify(pageInfo.cfElements, null, 2));
  console.log(`Scripts chargés:`);
  for (const s of pageInfo.cfElements.scripts) {
    console.log(`  - ${s.slice(0, 100)}`);
  }

  // Attendre un peu pour voir si des iframes Turnstile apparaissent
  console.log("\n── Étape 4: Attente 15s pour widgets dynamiques ──");
  await new Promise(r => setTimeout(r, 15_000));

  const pageInfo2 = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll("iframe")).map(f => ({
      src: f.src || f.getAttribute("src") || "",
      id: f.id,
      visible: f.offsetParent !== null,
    }));
    return {
      title: document.title,
      iframes,
      turnstileIframe: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      challengeForm: !!document.querySelector('#challenge-form'),
    };
  });

  console.log(`Titre après 15s: "${pageInfo2.title}"`);
  console.log(`Iframes après 15s: ${pageInfo2.iframes.length}`);
  for (const f of pageInfo2.iframes) {
    console.log(`  - src="${f.src.slice(0, 120)}" id="${f.id}" visible=${f.visible}`);
  }
  console.log(`Turnstile iframe: ${pageInfo2.turnstileIframe}`);
  console.log(`Challenge form: ${pageInfo2.challengeForm}`);

  // Étape 5: Tenter Captcha.solve manuellement avec un detectTimeout long
  console.log("\n── Étape 5: Captcha.solve manuelle (detectTimeout=30s) ──");
  try {
    const result = await session.send("Captcha.solve" as any, {
      detectTimeout: 30_000,
      options: [{ type: "*" }],
    }) as any;
    console.log(`Résultat: ${JSON.stringify(result, null, 2)}`);
  } catch (e: any) {
    console.log(`Erreur: ${e.message}`);
  }

  // Attendre encore 30s pour observer si des événements arrivent
  console.log("\n── Étape 6: Attente passive 30s pour événements ──");
  const title3Promise = page.waitForFunction(
    () => {
      const t = document.title.toLowerCase();
      return !t.includes("just a moment") && !t.includes("un instant") && !t.includes("checking");
    },
    { timeout: 30_000 },
  ).then(async () => {
    const t = await page.title();
    console.log(`🎉 Titre changé ! → "${t}"`);
    return true;
  }).catch(() => {
    console.log("⏰ Titre inchangé après 30s supplémentaires");
    return false;
  });

  const resolved = await title3Promise;

  if (resolved) {
    const cookies = await page.cookies();
    const cf = cookies.find(c => c.name === "cf_clearance");
    const php = cookies.find(c => c.name === "PHPSESSID");
    console.log(`🍪 cf_clearance: ${cf ? "✅ " + cf.value.slice(0, 20) + "…" : "❌"}`);
    console.log(`🍪 PHPSESSID: ${php ? "✅ " + php.value.slice(0, 15) + "…" : "❌"}`);
  }

  // Résumé
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  📋 Résumé événements Captcha CDP");
  console.log("═══════════════════════════════════════════════════════════════");
  if (captchaEvents.length === 0) {
    console.log("⚠️ AUCUN événement Captcha CDP reçu !");
    console.log("   Hypothèses:");
    console.log("   1. Le challenge CF n'est PAS un Turnstile visible (JSD pur ?)");
    console.log("   2. Le widget Turnstile est dans un shadow DOM inaccessible");
    console.log("   3. L'extension 2Captcha ne supporte pas ce type de challenge CF");
    console.log("   4. Le navigateur est bloqué par CF avant que le widget ne charge");
  } else {
    for (const e of captchaEvents) {
      console.log(`   [${(e.time / 1000).toFixed(1)}s] ${e.event} ${e.data ? JSON.stringify(e.data) : ""}`);
    }
  }

  await browser.disconnect();
  console.log("\n✅ Déconnecté");
}

main().catch(console.error);
