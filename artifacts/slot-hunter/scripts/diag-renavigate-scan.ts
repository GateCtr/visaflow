/**
 * diag-renavigate-scan.ts — Test re-navigation pour scan (sans re-solver CF)
 *
 * Architecture testée :
 *   Bootstrap unique : CF solve (~13s) + Continuar → /main/ capturé
 *   Chaque scan : page.goto(PORTAL) → cf_clearance valide → widget JS fire → capturer /main/
 *
 * Si CF ne re-challenge pas sur re-nav → scan en ~3-5s par cycle. 
 */

import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { solveCfChallenge, preparePageStealth, detectChallengeType, invalidateSession } from "../src/cf-challenge-solver.js";
import { resolveSpainProxy } from "../src/spain/spain-hybrid-session.js";

puppeteer.use(StealthPlugin());

const PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const KEY    = "2d01502f12dc08400e22aea87fb00ae34";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

interface ScanResult {
  attempt: number;
  durationMs: number;
  mainBodyLen: number;
  cfRechallenge: boolean;
  hasSlots: boolean;
  error?: string;
}

async function scanOnce(page: any, attempt: number): Promise<ScanResult> {
  const t0 = Date.now();
  let mainBodyLen = 0;
  let cfRechallenge = false;
  let mainResolve: (() => void) | null = null;
  let hasSlots = false;
  let cfType = "none";

  const mainSignal = new Promise<void>(r => { mainResolve = r; });

  const onResp = async (res: any) => {
    try {
      const url: string = res.url();
      if (url.includes("/cdn-cgi/challenge-platform/h/b/orchestrate")) {
        cfRechallenge = true;
      }
      if (url.includes("/onlinebookings/main/") && res.status() === 200) {
        const text = await res.text().catch(() => "");
        if (text.length > 10_000) {
          mainBodyLen = text.length;
          hasSlots = !/no hay horas disponibles/i.test(text);
          mainResolve?.();
        }
      }
    } catch { /* */ }
  };
  page.on("response", onResp);

  try {
    await page.goto(
      `${PORTAL}?_cb=${Date.now()}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 }
    ).catch(() => {});

    // Forcer re-solve (invalider le cache pour ce domaine)
    invalidateSession("www.citaconsular.es");
    const challengeType = await detectChallengeType(page);
    cfType = challengeType;
    if (challengeType !== "none") {
      const r = await solveCfChallenge(page, { targetUrl: PORTAL, timeout: 60_000, enableCapsolverFallback: false });
      process.stdout.write(` solved(${r.solvedBy},${Math.round(r.durationMs/1000)}s)`);
    }

    // Clic Continuar (token gate)
    await new Promise(r => setTimeout(r, 1_500));
    const clicked = await page.evaluate(() => {
      const f = (document.querySelector('input[name="token"]') as HTMLInputElement | null)?.form
             ?? document.querySelector("form");
      if (f) { (f as HTMLFormElement).submit(); return true; }
      return false;
    }).catch(() => false);

    if (clicked) {
      // Attendre /main/ (max 20s)
      await Promise.race([mainSignal, new Promise(r => setTimeout(r, 20_000))]);
    } else {
      // Peut-être pas de token gate sur re-nav → juste attendre /main/
      await Promise.race([mainSignal, new Promise(r => setTimeout(r, 10_000))]);
    }
  } catch (e: any) {
    return { attempt, durationMs: Date.now() - t0, mainBodyLen, cfRechallenge, hasSlots, error: e.message };
  } finally {
    page.off("response", onResp);
  }

  process.stdout.write(` [CF:${cfType},Continuar]`);
  return { attempt, durationMs: Date.now() - t0, mainBodyLen, cfRechallenge, hasSlots };
}

async function main() {
  const proxyUrl = resolveSpainProxy();
  const proxyParsed = new URL(proxyUrl);
  const proxyServer = `http://${proxyParsed.hostname}:${proxyParsed.port}`;
  const proxyAuth = { username: decodeURIComponent(proxyParsed.username), password: decodeURIComponent(proxyParsed.password) };

  console.log("\n══ DIAG RE-NAVIGATION SCAN ════════════════════════════════════════════\n");

  const browser: any = await (puppeteer as any).launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1280,720",
      "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
      `--proxy-server=${proxyServer}`,
    ],
    defaultViewport: { width: 1280, height: 720 },
  });

  const pages = await browser.pages();
  const page: any = pages[0] ?? await browser.newPage();
  await page.authenticate(proxyAuth);
  await page.setUserAgent(UA);
  await preparePageStealth(page, UA);
  page.on("dialog", async (d: any) => { await d.accept().catch(() => {}); });

  // ── Phase 1 : Bootstrap (une seule fois) ────────────────────────────────────
  console.log("▶ Phase 1 — Bootstrap (CF solve + Continuar)…");
  const tBoot = Date.now();

  let bootMainLen = 0;
  let bootMainResolve: (() => void) | null = null;
  const bootSignal = new Promise<void>(r => { bootMainResolve = r; });

  const onBootResp = async (res: any) => {
    const url: string = res.url();
    if (url.includes("/onlinebookings/main/") && res.status() === 200) {
      const text = await res.text().catch(() => "");
      if (text.length > 10_000) { bootMainLen = text.length; bootMainResolve?.(); }
    }
  };
  page.on("response", onBootResp);

  await page.goto(`${PORTAL}?_cb=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 70_000 }).catch(() => {});
  await solveCfChallenge(page, { targetUrl: PORTAL, timeout: 120_000, enableCapsolverFallback: false });
  await new Promise(r => setTimeout(r, 2_500));
  await page.evaluate(() => {
    const f = (document.querySelector('input[name="token"]') as HTMLInputElement)?.form ?? document.querySelector("form");
    if (f) (f as HTMLFormElement).submit();
  });
  await Promise.race([bootSignal, new Promise(r => setTimeout(r, 30_000))]);
  page.off("response", onBootResp);

  const bootMs = Date.now() - tBoot;
  console.log(`  ✅ Bootstrap terminé en ${Math.round(bootMs / 1000)}s — /main/: ${bootMainLen}B`);
  console.log(`  Page URL: ${page.url()}`);

  // Vérifier cookies
  const cookies = await page.cookies().catch(() => []) as any[];
  const cookieNames = cookies.map((c: any) => c.name);
  console.log(`  Cookies: ${cookieNames.join(", ")}`);
  const hasClearance = cookieNames.includes("cf_clearance");
  console.log(`  cf_clearance présent: ${hasClearance ? "✅" : "❌"}`);

  // ── Phase 2 : Scans par re-navigation ────────────────────────────────────────
  console.log("\n▶ Phase 2 — 5 scans par re-navigation (intervalle 10s)…\n");
  const results: ScanResult[] = [];

  for (let i = 1; i <= 5; i++) {
    if (i > 1) await new Promise(r => setTimeout(r, 10_000));

    process.stdout.write(`  Scan #${i}… `);
    const res = await scanOnce(page, i);
    results.push(res);

    const mark = res.mainBodyLen > 10_000 ? "✅" : "❌";
    const cfMark = res.cfRechallenge ? "⚠️ CF re-challenge" : "OK";
    console.log(`${mark} ${res.mainBodyLen}B | ${res.durationMs}ms | CF: ${cfMark} | hasSlots: ${res.hasSlots}`);
    if (res.error) console.log(`     Erreur: ${res.error}`);
  }

  // ── Résumé ────────────────────────────────────────────────────────────────────
  const successful = results.filter(r => r.mainBodyLen > 10_000);
  const avgMs = successful.length > 0
    ? Math.round(successful.reduce((s, r) => s + r.durationMs, 0) / successful.length)
    : 0;

  console.log("\n" + "═".repeat(70));
  console.log("  RÉSUMÉ");
  console.log("═".repeat(70));
  console.log(`  Bootstrap    : ${Math.round(bootMs / 1000)}s`);
  console.log(`  Scans OK     : ${successful.length}/${results.length}`);
  console.log(`  Durée moy/scan: ${avgMs}ms`);
  console.log(`  CF re-challenge: ${results.some(r => r.cfRechallenge) ? "OUI ⚠️" : "NON ✅"}`);
  console.log("═".repeat(70) + "\n");

  // Test de Continuar automatique sur re-nav (si CF ne re-challenge pas, Continuar peut être nécessaire)
  if (successful.length === 0) {
    console.log("⚠️  Aucun scan réussi — test avec Continuar automatique sur chaque re-nav…");
    for (let i = 1; i <= 3; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      process.stdout.write(`  Scan+Continuar #${i}… `);
      const t0 = Date.now();

      let mainLen = 0;
      let mResolve: (() => void) | null = null;
      const sig = new Promise<void>(r => { mResolve = r; });
      const onR = async (res: any) => {
        const url: string = res.url();
        if (url.includes("/onlinebookings/main/") && res.status() === 200) {
          const text = await res.text().catch(() => "");
          if (text.length > 10_000) { mainLen = text.length; mResolve?.(); }
        }
      };
      page.on("response", onR);

      await page.goto(`${PORTAL}?_cb=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      
      // Attendre un peu que le DOM charge
      await new Promise(r => setTimeout(r, 3_000));
      
      // Essayer Continuar si présent, sinon attendre
      const hasForm = await page.evaluate(() => !!document.querySelector('input[name="token"]')).catch(() => false);
      if (hasForm) {
        await page.evaluate(() => {
          const f = (document.querySelector('input[name="token"]') as HTMLInputElement)?.form ?? document.querySelector("form");
          if (f) (f as HTMLFormElement).submit();
        });
        console.log(`\n     (Continuar trouvé et cliqué)`);
      }

      await Promise.race([sig, new Promise(r => setTimeout(r, 20_000))]);
      page.off("response", onR);

      const ms = Date.now() - t0;
      const mark = mainLen > 10_000 ? "✅" : "❌";
      console.log(`${mark} ${mainLen}B | ${ms}ms`);
    }
  }

  await browser.close().catch(() => {});
  console.log("🔒 Browser fermé.\n");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
