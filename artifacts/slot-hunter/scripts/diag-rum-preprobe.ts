/**
 * diag-rum-preprobe.ts — Test hypothèse : /cdn-cgi/rum comme keepalive CF
 *
 * HYPOTHÈSE :
 *   CF exige qu'un POST /cdn-cgi/rum ait été envoyé récemment (preuve que
 *   le client exécute du JS browser) avant d'accepter les XHR /onlinebookings/*.
 *   Sans ce RUM, même avec cf_clearance + PHPSESSID valides, on obtient 0B.
 *
 * CE SCRIPT TESTE 4 VARIANTES avec impit, dans l'ordre :
 *   A) Baseline — /main/ direct sans RUM           → attendu 0B
 *   B) RUM POST factice puis /main/                → attendu 200 si hypothèse OK
 *   C) RUM POST réaliste (copie exacte) puis /main/ → attendu 200
 *   D) RUM + 2s délai puis /main/                  → cas avec délai
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/diag-rum-preprobe.ts [--portal kinshasa|saopolo] [--headed]
 */

import puppeteer from "puppeteer";
import { Impit } from "impit";
import fs from "node:fs";
import path from "node:path";
import {
  SAOPOLO_PORTAL_URL, SAOPOLO_WIDGET_KEY,
  KINSHASA_PORTAL_URL, KINSHASA_WIDGET_KEY,
} from "../src/spain-portals.js";
import {
  solveCfChallenge,
  preparePageStealth,
  invalidateSession,
} from "../src/cf-challenge-solver.js";
import { loadProxyCsvFirst } from "../src/spain/spain-session-bootstrap.js";

// ── Config ────────────────────────────────────────────────────────────────────
const USE_SAOPOLO = process.argv.includes("--portal") &&
  process.argv[process.argv.indexOf("--portal") + 1] === "saopolo";
const HEADED = process.argv.includes("--headed");

const PORTAL_URL  = USE_SAOPOLO ? SAOPOLO_PORTAL_URL  : KINSHASA_PORTAL_URL;
const PORTAL_PK   = USE_SAOPOLO ? SAOPOLO_WIDGET_KEY   : KINSHASA_WIDGET_KEY;
const PORTAL_NAME = USE_SAOPOLO ? "saopolo"            : "kinshasa";

// RUM body minimal (realistic Chrome performance.memory values)
function buildRumBody(phase: "initial" | "widget"): string {
  const totalHeap = phase === "initial" ? 4_611_265 : 17_129_372;
  const usedHeap = phase === "initial" ? 3_280_165 : 10_893_196;
  return JSON.stringify({
    memory: {
      totalJSHeapSize: totalHeap,
      usedJSHeapSize: usedHeap,
      jsHeapSizeLimit: 4_294_967_296,
    },
    resources: [],
    timing: {
      navigationStart: Date.now() - 12_000,
      loadEventEnd: Date.now() - 8_000,
      domContentLoadedEventEnd: Date.now() - 9_000,
    },
    firstPaint: 1_200,
    firstContentfulPaint: 1_450,
    cacheWarmed: false,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n══ DIAG RUM PRE-PROBE ═══════════════════════════════════════════════\n");
  console.log(`Portal   : ${PORTAL_NAME} → ${PORTAL_URL}`);
  console.log(`Mode     : ${HEADED ? "headed" : "headless"}\n`);

  // ── 1. Résoudre CF dans Chrome pour obtenir des cookies frais ──────────────
  const proxyUrl = await loadProxyCsvFirst();
  console.log(`Proxy    : ${proxyUrl?.replace(/:[^:@]+@/, ":***@").slice(0, 60) ?? "direct"}\n`);

  const chromiumPath =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
  ];
  if (proxyUrl) args.push(`--proxy-server=${new URL(proxyUrl).host}`);

  const browser = await puppeteer.launch({
    executablePath: chromiumPath,
    headless: !HEADED,
    args,
  });

  let cfClearance = "";
  let phpSessId = "";
  let proxyAuth: { username: string; password: string } | undefined;
  let mainBodyFromChrome = "";

  try {
    const page = await browser.newPage();

    if (proxyUrl) {
      const u = new URL(proxyUrl);
      if (u.username) {
        proxyAuth = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
        await page.authenticate(proxyAuth);
      }
    }

    await preparePageStealth(page);
    invalidateSession("www.citaconsular.es");

    console.log("▶ Phase 1 — Bootstrap CF (Turnstile + Continuar + capturer /main/)…");

    // Intercepter /main/ via CDP
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");

    let mainBodyPromise: Promise<string> = new Promise((resolve) => {
      cdp.on("Network.responseReceived", async (evt) => {
        if (
          evt.response.url.includes("/onlinebookings/main/") &&
          evt.response.status === 200 &&
          (evt.response.headers["content-type"] ?? "").includes("javascript")
        ) {
          setTimeout(async () => {
            try {
              const body = await cdp.send("Network.getResponseBody", {
                requestId: evt.requestId,
              });
              resolve(body.body ?? "");
            } catch {
              resolve("");
            }
          }, 3_000);
        }
      });
    });

    const t0 = Date.now();
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // Résoudre CF
    await solveCfChallenge(page, {
      targetUrl: PORTAL_URL,
      timeout: 120_000,
      enableCapsolverFallback: false,
    });

    // Cliquer Continuar si token gate présent
    await page.waitForFunction(
      () =>
        !document.querySelector("input[name=token]") ||
        (document.querySelector("input[name=token]") as HTMLInputElement).value.length > 0,
      { timeout: 15_000 }
    ).catch(() => {});

    const tokenInput = await page.$('input[name="token"]');
    if (tokenInput) {
      const submitBtn = await page.$('input[type="submit"], button[type="submit"], .bienvenido-btn, button');
      if (submitBtn) {
        await submitBtn.click();
        console.log("  ✅ Continuar cliqué");
      }
    }

    // Attendre /main/
    mainBodyFromChrome = await Promise.race([
      mainBodyPromise,
      new Promise<string>((r) => setTimeout(() => r(""), 25_000)),
    ]);

    const bootstrapMs = Date.now() - t0;
    console.log(
      `  Bootstrap terminé en ${Math.round(bootstrapMs / 1000)}s — /main/: ${mainBodyFromChrome.length}B`
    );

    // Extraire cookies
    const cookies = await page.cookies();
    for (const c of cookies) {
      if (c.name === "cf_clearance") cfClearance = c.value;
      if (c.name === "PHPSESSID") phpSessId = c.value;
    }

    console.log(`  cf_clearance: ${cfClearance ? cfClearance.slice(0, 30) + "…" : "❌ absent"}`);
    console.log(`  PHPSESSID   : ${phpSessId ? phpSessId.slice(0, 20) + "…" : "❌ absent"}`);
  } finally {
    await browser.close();
  }

  if (!cfClearance || !phpSessId) {
    console.error("\n❌ Impossible de récupérer les cookies CF — arrêt.");
    process.exit(1);
  }

  // ── 2. Tests impit ──────────────────────────────────────────────────────────
  const cookieStr = [
    `PHPSESSID=${phpSessId}`,
    `cf_chl_rc_ni=1`,
    `cf_clearance=${cfClearance}`,
  ].join("; ");

  // Construire l'URL /main/ proprement
  const base = "https://www.citaconsular.es";
  const pk = PORTAL_PK;
  const ts = Date.now();
  const mainUrlClean = `${base}/onlinebookings/main/?callback=jQuery_diag&type=default&publickey=${pk}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts}`;
  const rumUrl = `${base}/cdn-cgi/rum?`;

  const commonHeaders: Record<string, string> = {
    "accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
    "cookie": cookieStr,
    "priority": "u=1, i",
    "referer": PORTAL_URL,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
    "x-requested-with": "XMLHttpRequest",
  };

  const rumHeaders: Record<string, string> = {
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br, zstd",
    "accept-language": "es-ES,es;q=0.9,en;q=0.8",
    "content-type": "application/json",
    "cookie": cookieStr,
    "origin": base,
    "priority": "u=1",
    "referer": PORTAL_URL,
    "sec-ch-ua": '"Google Chrome";v="149", "Chromium";v="149", "Not/A)Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36",
  };

  const impit = new Impit({
    browser: "chrome",
    proxyUrl: proxyUrl || undefined,
  } as any);

  async function callMain(label: string): Promise<{ size: number; ok: boolean; ms: number }> {
    const t = Date.now();
    try {
      const res = await impit.fetch(mainUrlClean, { method: "GET", headers: commonHeaders } as any);
      const body = await res.text();
      const ms = Date.now() - t;
      const ok = body.length > 10_000;
      const marker = ok ? "✅" : (body.length > 0 ? "⚠️ " : "❌");
      const ct = res.headers?.get?.("content-type") ?? "?";
      console.log(`  ${marker} ${label}: ${res.status} | ${body.length}B | ${ms}ms | ct=${ct}`);
      if (!ok && body.length > 0) {
        console.log(`     body preview: ${body.slice(0, 200)}`);
      }
      return { size: body.length, ok, ms };
    } catch (e: any) {
      console.log(`  ❌ ${label}: Exception — ${e.message?.slice(0, 80)}`);
      return { size: 0, ok: false, ms: Date.now() - t };
    }
  }

  async function postRum(label: string, body: string): Promise<boolean> {
    try {
      const res = await impit.fetch(rumUrl, {
        method: "POST",
        headers: rumHeaders,
        body,
      } as any);
      const responseBody = await res.text();
      console.log(`  🍃 RUM ${label}: ${res.status} | ${responseBody.length}B`);
      return res.status >= 200 && res.status < 400;
    } catch (e: any) {
      console.log(`  🍃 RUM ${label}: Exception — ${e.message?.slice(0, 80)}`);
      return false;
    }
  }

  console.log("\n══ TESTS IMPIT ══════════════════════════════════════════════════════\n");
  console.log(`URL main/ : ${mainUrlClean.slice(0, 100)}…`);
  console.log(`URL rum   : ${rumUrl}\n`);

  const results: Record<string, { size: number; ok: boolean; ms: number }> = {};

  // ── Variante A : baseline sans RUM ──
  console.log("── Variante A — /main/ DIRECT (sans RUM) ──────────────────────────");
  results.A = await callMain("A — baseline");

  // Attendre 1s entre variants
  await new Promise(r => setTimeout(r, 1_000));

  // ── Variante B : RUM factice minimal puis /main/ ──
  console.log("\n── Variante B — RUM minimal → /main/ ──────────────────────────────");
  await postRum("minimal (body vide)", "{}");
  await new Promise(r => setTimeout(r, 200));
  results.B = await callMain("B — après RUM minimal");

  await new Promise(r => setTimeout(r, 1_000));

  // ── Variante C : RUM réaliste (phase initial) puis /main/ ──
  console.log("\n── Variante C — RUM réaliste initial → /main/ ─────────────────────");
  await postRum("réaliste (initial)", buildRumBody("initial"));
  await new Promise(r => setTimeout(r, 200));
  results.C = await callMain("C — après RUM réaliste initial");

  await new Promise(r => setTimeout(r, 1_000));

  // ── Variante D : RUM réaliste (widget) + 2s puis /main/ ──
  console.log("\n── Variante D — RUM réaliste widget + 2s délai → /main/ ───────────");
  await postRum("réaliste (widget)", buildRumBody("widget"));
  await new Promise(r => setTimeout(r, 2_000));
  results.D = await callMain("D — après RUM widget + 2s");

  await new Promise(r => setTimeout(r, 1_000));

  // ── Variante E : 2x RUM puis /main/ (simuler burst browser) ──
  console.log("\n── Variante E — 2x RUM rapides → /main/ ───────────────────────────");
  await postRum("burst 1", buildRumBody("initial"));
  await new Promise(r => setTimeout(r, 300));
  await postRum("burst 2", buildRumBody("widget"));
  await new Promise(r => setTimeout(r, 300));
  results.E = await callMain("E — après 2x RUM");

  await new Promise(r => setTimeout(r, 1_000));

  // ── Variante F : /main/ sans cf_chl_rc_ni (tester si ce cookie est requis) ──
  console.log("\n── Variante F — /main/ SANS cf_chl_rc_ni ──────────────────────────");
  const headersNoRcNi = { ...commonHeaders };
  headersNoRcNi.cookie = `PHPSESSID=${phpSessId}; cf_clearance=${cfClearance}`;
  try {
    const res = await impit.fetch(mainUrlClean, { method: "GET", headers: headersNoRcNi } as any);
    const body = await res.text();
    const ok = body.length > 10_000;
    const marker = ok ? "✅" : (body.length > 0 ? "⚠️ " : "❌");
    console.log(`  ${marker} F — sans cf_chl_rc_ni: ${res.status} | ${body.length}B`);
    results.F = { size: body.length, ok, ms: 0 };
  } catch (e: any) {
    console.log(`  ❌ F — Exception: ${e.message?.slice(0, 80)}`);
    results.F = { size: 0, ok: false, ms: 0 };
  }

  // ── Résumé ──────────────────────────────────────────────────────────────────
  console.log("\n══ RÉSUMÉ ═══════════════════════════════════════════════════════════");
  console.log(`  Chrome /main/  : ${mainBodyFromChrome.length}B (référence)`);
  for (const [k, v] of Object.entries(results)) {
    const marker = v.ok ? "✅" : (v.size > 0 ? "⚠️ " : "❌");
    console.log(`  ${marker} Variante ${k}    : ${v.size}B`);
  }

  const anyWorked = Object.values(results).some(v => v.ok);
  if (anyWorked) {
    console.log("\n🎉 AU MOINS UNE VARIANTE IMPIT A FONCTIONNÉ !");
    console.log("   → L'hypothèse RUM-keepalive est CONFIRMÉE ou autre piste identifiée.");
  } else {
    console.log("\n📊 Aucune variante impit n'a retourné du contenu.");
    console.log("   → Le RUM seul ne suffit pas — la protection est ailleurs.");
  }

  // Sauvegarder les résultats
  const outPath = path.join("debug_dumps", `rum-probe-${Date.now()}.json`);
  fs.mkdirSync("debug_dumps", { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ results, cfClearance: cfClearance.slice(0, 30), phpSessId: phpSessId.slice(0, 10), mainBodyFromChrome: mainBodyFromChrome.length }, null, 2));
  console.log(`\n  Résultats sauvegardés : ${outPath}`);
  console.log();
}

main().catch(e => {
  console.error(`Fatal: ${e.message ?? e}`);
  process.exit(1);
});
