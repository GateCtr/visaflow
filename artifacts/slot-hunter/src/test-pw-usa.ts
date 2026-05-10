/**
 * Test Playwright — Interception réseau USA portal pour Christian (cancellable flow)
 * Approche : login via formulaire Angular → intercepter appels API → capturer IDs
 * Usage : USA_EMAIL="email" USA_PASSWORD="pass" npx tsx src/test-pw-usa.ts
 */

import { setUsaSessionProxy } from "./usaPortal.js";
import { launchBrowser, randomDelay } from "./browser.js";
import type { Page } from "playwright";

const EMAIL    = process.env.USA_EMAIL    ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";

if (!EMAIL || !PASSWORD) {
  console.error("❌  USA_EMAIL et USA_PASSWORD requis");
  process.exit(1);
}

const USA_PORTAL  = "https://www.usvisaappt.com";
const LOGIN_URL   = `${USA_PORTAL}/visaapplicantui/home/auth/login`;
const DASH_URL    = `${USA_PORTAL}/visaapplicantui/home/dashboard`;
const MANAGE_URL  = `${USA_PORTAL}/visaapplicantui/home/dashboard/manage-appointment`;

interface Capture {
  method: string;
  url: string;
  status: number | null;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  resBody: string | null;
}

async function waitForAngularInput(page: Page, timeout = 30_000): Promise<void> {
  // Playwright natif waitForSelector — bien plus fiable que le polling manuel.
  // Angular Material inputs peuvent aussi être wrappés dans <mat-form-field>.
  await page.waitForFunction(
    () => {
      const inputs = Array.from(document.querySelectorAll("input"));
      return inputs.some((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    },
    { timeout },
  );
}

async function main(): Promise<void> {
  console.log("=".repeat(65));
  console.log("  TEST PLAYWRIGHT USA — Login formulaire + interception réseau");
  console.log("=".repeat(65));
  console.log(`Email: ${EMAIL}`);
  console.log(`Proxy: ${process.env.IPROYAL_PROXY_URL ? "iProyal ✅" : "direct"}`);

  // Le proxy iProyal est configuré dans launchBrowser (proxySource: "iproyal")
  setUsaSessionProxy(undefined);

  const { browser, context, page } = await launchBrowser({
    proxySource: "iproyal",
    locale: "en-US",
    timezoneId: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  });

  const captures: Capture[] = [];
  const pending = new Map<string, { method: string; url: string; body: string | null; headers: Record<string, string> }>();

  // ── Intercepter tous les appels API du portail ───────────────────────────
  page.on("request", (req) => {
    const url = req.url();
    const isApi = url.includes("usvisaappt.com") &&
      !url.match(/\.(js|css|png|jpg|ico|woff|svg|gif)(\?|$)/);
    if (!isApi) return;

    let body: string | null = null;
    try { body = req.postData(); } catch { /* ignore */ }
    const hdrs: Record<string, string> = {};
    try { Object.assign(hdrs, req.headers()); } catch { /* ignore */ }
    pending.set(url + "|" + Date.now(), { method: req.method(), url, body, headers: hdrs });

    const isInteresting = /visa(userapi|workflowprocessor|appointmentapi)|identity\/user|cancel|reschedule|appoint|applicant/i.test(url);
    if (isInteresting) {
      console.log(`\n→ REQ [${req.method()}] ${url.replace(USA_PORTAL, "")}`);
      const auth = hdrs["authorization"] ?? hdrs["Authorization"];
      if (auth) console.log(`   Auth: ${auth.slice(0, 50)}...`);
      if (body) console.log(`   body: ${body.slice(0, 200)}`);
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    const isApi = url.includes("usvisaappt.com") &&
      !url.match(/\.(js|css|png|jpg|ico|woff|svg|gif)(\?|$)/);
    if (!isApi) return;

    // Trouver la requête correspondante (la plus récente pour cette URL)
    let matchKey: string | undefined;
    for (const [k] of pending) {
      if (k.startsWith(url + "|")) matchKey = k;
    }
    const pend = matchKey ? pending.get(matchKey) : undefined;
    if (matchKey) pending.delete(matchKey);

    let resBody: string | null = null;
    try {
      const ct = res.headers()["content-type"] ?? "";
      if (ct.includes("json") || ct.includes("text")) resBody = await res.text();
    } catch { /* ignore */ }

    const cap: Capture = {
      method: pend?.method ?? res.request().method(),
      url,
      status: res.status(),
      reqHeaders: pend?.headers ?? {},
      reqBody: pend?.body ?? null,
      resBody: resBody?.slice(0, 1500) ?? null,
    };
    captures.push(cap);

    const isInteresting = /visa(userapi|workflowprocessor|appointmentapi)|identity\/user|cancel|reschedule|appoint|applicant/i.test(url);
    if (isInteresting) {
      const ico = res.ok() ? "✅" : res.status() === 401 ? "🔒" : "❌";
      console.log(`${ico} RES [${res.status()}] ${url.replace(USA_PORTAL, "")}`);
      if (resBody) console.log(`   → ${resBody.slice(0, 600)}`);
    }
  });

  try {
    // ── 1. Navigation vers la page de login ─────────────────────────────────
    console.log("\n[1] Navigation → login page (waitUntil=load)...");
    // waitUntil:"load" attend que tout le JS soit chargé — Angular peut alors démarrer.
    // On n'utilise PAS networkidle car Angular fait des requêtes continues.
    // On n'utilise PAS domcontentloaded car le JS n'est pas encore exécuté.
    await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 45_000 });

    // Attendre que le composant login Angular rende ses inputs — max 40s
    // Angular est une SPA : les inputs apparaissent APRÈS l'exécution du JS + routing.
    // page.waitForFunction scrute le DOM réel toutes les 100ms — pas de 2ème navigation needed.
    console.log("[2] Attente rendu formulaire Angular (input visible dans le DOM)...");
    try {
      await waitForAngularInput(page, 40_000);
      console.log(`   ✅ Inputs visibles! URL: ${page.url()}`);
    } catch {
      const state = await page.evaluate(() => ({
        url: location.href,
        inner: document.querySelector("app-root")?.innerHTML?.slice(0, 600) ?? "absent",
        allInputs: document.querySelectorAll("input").length,
      }));
      console.log("   Debug Angular state:", JSON.stringify(state));
      await page.screenshot({ path: "/tmp/usa-angular-debug.png" }).catch(() => {});
      throw new Error(`Angular login form non rendu (${state.allInputs} inputs, url=${state.url})`);
    }
    await randomDelay(500, 800);

    // Lister tous les inputs sur la page pour debug
    const inputsInfo = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input"));
      return els.map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        classes: el.className.split(" ").slice(0, 3).join(" "),
        visible: el.offsetParent !== null,
      }));
    });
    console.log("   Inputs trouvés:", JSON.stringify(inputsInfo, null, 2));

    // ── 3. Remplissage email ─────────────────────────────────────────────────
    console.log("[3] Remplissage email...");
    // Angular Material inputs — essayer plusieurs sélecteurs
    const emailTried: string[] = [];
    let emailFilled = false;
    for (const sel of [
      'input[type="email"]',
      'input[type="text"]',
      'input:not([type="password"]):not([type="checkbox"])',
      'input.mat-input-element:not([type="password"])',
    ]) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        await el.click();
        await randomDelay(200, 400);
        await el.fill(EMAIL);
        emailTried.push(sel);
        emailFilled = true;
        console.log(`   ✅ Email rempli avec: ${sel}`);
        break;
      }
      emailTried.push(`${sel} (absent/invisible)`);
    }
    if (!emailFilled) {
      console.log("   Sélecteurs essayés:", emailTried);
      throw new Error("Aucun champ email trouvé");
    }

    // ── 4. Remplissage mot de passe ──────────────────────────────────────────
    console.log("[4] Remplissage mot de passe...");
    const passEl = await page.$('input[type="password"]');
    if (!passEl) throw new Error("Champ password non trouvé");
    await passEl.click();
    await randomDelay(200, 400);
    await passEl.fill(PASSWORD);
    console.log("   ✅ Password rempli");

    // ── 5. Soumission ────────────────────────────────────────────────────────
    console.log("[5] Soumission formulaire...");
    await randomDelay(500, 900);
    const btnEl = await page.$('button[type="submit"]') ??
                  await page.$('button.login-btn') ??
                  await page.$('button.signin') ??
                  await page.$("button");
    if (btnEl) {
      await btnEl.click();
      console.log("   ✅ Bouton cliqué");
    } else {
      await page.keyboard.press("Enter");
      console.log("   ✅ Enter pressé");
    }

    // ── 6. Attente dashboard ─────────────────────────────────────────────────
    console.log("[6] Attente redirection dashboard...");
    try {
      await page.waitForURL("**/dashboard**", { timeout: 30_000 });
    } catch {
      const currentUrl = page.url();
      console.log(`   URL actuelle: ${currentUrl}`);
      if (currentUrl.includes("login") || currentUrl.includes("auth")) {
        // Peut-être rate-limited ou mauvais credentials
        const body = await page.evaluate(() => document.body.innerText);
        console.log(`   Page: ${body.slice(0, 300)}`);
        throw new Error("Login échoué — pas de redirection vers dashboard");
      }
    }
    await randomDelay(2000, 3000);
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    console.log(`   URL: ${page.url()}`);

    // ── 7. Capturer les cookies serveur post-login ───────────────────────────
    console.log("\n[7] Cookies serveur post-login:");
    const cookies = await context.cookies(USA_PORTAL);
    for (const c of cookies) {
      console.log(`   ${c.name}=${c.value.slice(0, 30)}... [domain=${c.domain}, httpOnly=${c.httpOnly}]`);
    }

    // ── 8. Appels API du dashboard ───────────────────────────────────────────
    console.log("\n[8] Appels API capturés sur le dashboard:");
    printCaptures(captures, "DASHBOARD");

    // ── 9. Navigation manage-appointment ────────────────────────────────────
    const capsBefore = captures.length;
    console.log("\n[9] Navigation → manage-appointment...");
    await page.goto(MANAGE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await randomDelay(2000, 3000);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

    const manageCaptures = captures.slice(capsBefore);
    console.log(`\n   ${manageCaptures.length} appel(s) API sur manage-appointment:`);
    printCaptures(manageCaptures, "MANAGE");

    const manageText = await page.evaluate(() => document.body.innerText).catch(() => "");
    console.log(`\n   Texte page: ${manageText.slice(0, 500)}`);

    await page.screenshot({ path: "/tmp/usa-manage.png" }).catch(() => {});
    console.log("   Screenshot: /tmp/usa-manage.png");

    // ── Résumé IDs ───────────────────────────────────────────────────────────
    console.log("\n" + "=".repeat(65));
    console.log("  RÉSUMÉ — IDs extraits:");
    console.log("=".repeat(65));

    let found = false;
    for (const cap of captures) {
      if (!cap.resBody) continue;
      const appIdM   = cap.resBody.match(/"applicationId"\s*:\s*"?([^"}\s,]+)"?/);
      const apptIdM  = cap.resBody.match(/"appointmentId"\s*:\s*(\d+)/);
      const applIdM  = cap.resBody.match(/"applicantId"\s*:\s*(\d+)/);
      const apptUUID = cap.resBody.match(/"applicantUUID"\s*:\s*(\d+)/);
      if (appIdM || apptIdM || applIdM || apptUUID) {
        found = true;
        console.log(`\n  ✅ [${cap.status}] ${cap.url.replace(USA_PORTAL, "")}`);
        if (appIdM)   console.log(`     applicationId  : ${appIdM[1]}`);
        if (apptIdM)  console.log(`     appointmentId  : ${apptIdM[1]}`);
        if (applIdM)  console.log(`     applicantId    : ${applIdM[1]}`);
        if (apptUUID) console.log(`     applicantUUID  : ${apptUUID[1]}`);
      }
    }
    if (!found) {
      console.log("  ⚠️ Aucun ID trouvé. Vérifier les appels capturés ci-dessus.");
      // Afficher TOUS les appels pour debug
      console.log("\n  Tous les appels API interceptés:");
      for (const c of captures) {
        const ico = (c.status ?? 999) < 400 ? "✅" : "❌";
        console.log(`  ${ico} [${c.status}] ${c.method} ${c.url.replace(USA_PORTAL, "")}`);
        if (c.resBody) console.log(`     ${c.resBody.slice(0, 200)}`);
      }
    }

  } catch (err) {
    console.error("\n❌ Erreur:", err instanceof Error ? err.message : err);
    await page.screenshot({ path: "/tmp/usa-error.png" }).catch(() => {});
    console.log("   Screenshot: /tmp/usa-error.png");
  } finally {
    await browser.close();
  }

  console.log("\n" + "=".repeat(65));
  console.log("  FIN");
  console.log("=".repeat(65));
  process.exit(0);
}

function printCaptures(caps: Capture[], label: string): void {
  if (caps.length === 0) { console.log(`   (aucun appel pour ${label})`); return; }
  for (const c of caps) {
    const ico = (c.status ?? 999) < 400 ? "✅" : "❌";
    console.log(`   ${ico} [${c.status ?? "?"}] ${c.method} ${c.url.replace(USA_PORTAL, "")}`);
    if (c.resBody && c.resBody !== "null") {
      console.log(`      → ${c.resBody.slice(0, 300)}`);
    }
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
