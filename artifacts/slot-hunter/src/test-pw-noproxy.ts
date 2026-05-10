/**
 * Test Playwright SANS PROXY — diagnostic rendu Angular USA portal
 * Vérifie si le proxy iProyal est la cause du router-outlet vide.
 * Usage : USA_EMAIL="email" USA_PASSWORD="pass" npx tsx src/test-pw-noproxy.ts
 */

import { launchBrowser, randomDelay } from "./browser.js";

const EMAIL    = process.env.USA_EMAIL    ?? "";
const PASSWORD = process.env.USA_PASSWORD ?? "";

if (!EMAIL || !PASSWORD) {
  console.error("❌  USA_EMAIL et USA_PASSWORD requis");
  process.exit(1);
}

const USA_PORTAL = "https://www.usvisaappt.com";
const LOGIN_URL  = `${USA_PORTAL}/visaapplicantui/home/auth/login`;
const ROOT_URL   = `${USA_PORTAL}/visaapplicantui/`;

async function waitForInput(page: Awaited<ReturnType<typeof launchBrowser>>["page"], timeout = 30_000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll("input")).some((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }),
      { timeout },
    );
    return true;
  } catch { return false; }
}

async function main(): Promise<void> {
  console.log("=".repeat(65));
  console.log("  DIAGNOSTIC ANGULAR — SANS PROXY (forceNoProxy=true)");
  console.log("=".repeat(65));

  const captures: { method: string; url: string; status: number; body: string }[] = [];

  const { browser, context, page } = await launchBrowser({
    forceNoProxy: true,
    locale: "en-US",
    timezoneId: "America/New_York",
    acceptLanguage: "en-US,en;q=0.9",
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (!url.includes("usvisaappt.com")) return;
    if (url.match(/\.(js|css|png|jpg|ico|woff|svg|gif|woff2|map)(\?|$)/)) return;
    try {
      const ct = res.headers()["content-type"] ?? "";
      const body = (ct.includes("json") || ct.includes("text")) ? await res.text().catch(() => "") : "";
      captures.push({ method: res.request().method(), url, status: res.status(), body: body.slice(0, 500) });
    } catch { /* ignore */ }
  });

  try {
    console.log("\n[1] Navigation → login URL (waitUntil=load)...");
    await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 45_000 });
    console.log(`   URL après load: ${page.url()}`);

    const rootInner1 = await page.evaluate(() => ({
      url: location.href,
      inner: document.querySelector("app-root")?.innerHTML?.slice(0, 300) ?? "absent",
      inputs: document.querySelectorAll("input").length,
    }));
    console.log("   État Angular:", JSON.stringify(rootInner1));

    // Attendre qu'un input soit visible (max 30s)
    console.log("\n[2] Attente input Angular (30s)...");
    const hasInput = await waitForInput(page, 30_000);
    if (hasInput) {
      console.log("   ✅ Input visible!");
      const inputs = await page.evaluate(() =>
        Array.from(document.querySelectorAll("input")).map(el => ({
          type: el.type, name: el.name, id: el.id, placeholder: el.placeholder,
          visible: el.getBoundingClientRect().width > 0,
        }))
      );
      console.log("   Inputs:", JSON.stringify(inputs));
    } else {
      console.log("   ❌ Pas d'inputs après 30s");
      const state = await page.evaluate(() => ({
        url: location.href,
        inner: document.querySelector("app-root")?.innerHTML?.slice(0, 600) ?? "absent",
      }));
      console.log("   État:", JSON.stringify(state));
      await page.screenshot({ path: "/tmp/usa-noproxy-debug.png" }).catch(() => {});
      console.log("   Screenshot: /tmp/usa-noproxy-debug.png");
    }

    // Essayer la route racine si login n'a pas fonctionné
    if (!hasInput) {
      console.log("\n[3] Tentative route racine (/visaapplicantui/)...");
      // Navigation via Angular router (pas goto → SPA)
      await page.evaluate((url) => { window.location.href = url; }, ROOT_URL);
      await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => {});
      await randomDelay(3000, 4000);
      const hasInput2 = await waitForInput(page, 15_000);
      console.log(`   Input sur root: ${hasInput2 ? "✅ OUI" : "❌ NON"}`);
      const state2 = await page.evaluate(() => ({
        url: location.href,
        inner: document.querySelector("app-root")?.innerHTML?.slice(0, 600) ?? "absent",
      }));
      console.log("   État:", JSON.stringify(state2));
    }

    console.log("\n[4] Appels API capturés:");
    for (const c of captures) {
      const ico = c.status < 400 ? "✅" : "❌";
      console.log(`   ${ico} [${c.status}] ${c.method} ${c.url.replace(USA_PORTAL, "")}`);
      if (c.body) console.log(`      ${c.body.slice(0, 200)}`);
    }

  } catch (err) {
    console.error("❌ Erreur:", err instanceof Error ? err.message : err);
    await page.screenshot({ path: "/tmp/usa-noproxy-error.png" }).catch(() => {});
  } finally {
    await browser.close();
  }

  process.exit(0);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
