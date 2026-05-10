/**
 * Test local : résolution Cloudflare Turnstile via 2captcha
 *
 * Usage:
 *   TWOCAPTCHA_API_KEY=xxx tsx src/testTurnstile.ts [url]
 *
 * Si aucune URL n'est fournie, utilise la page de démo Cloudflare.
 * Si une URL est fournie (ex: URL du consulat Espagne), la page est ouverte et
 * le challenge Turnstile est résolu dessus.
 */

import * as dotenv from "dotenv";
dotenv.config();

import { launchBrowser } from "./browser.js";

const TWO_CAPTCHA_BASE = "https://2captcha.com";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 36; // 3 min max

const TARGET_URL = process.argv[2] ?? "https://demo.turnstile.cloudflare.com/";
const API_KEY = process.env.TWOCAPTCHA_API_KEY ?? "";

function pad(s: string, n: number): string {
  return s.padEnd(n).slice(0, n);
}

async function checkBalance(): Promise<void> {
  const res = await fetch(`${TWO_CAPTCHA_BASE}/res.php?key=${API_KEY}&action=getbalance&json=1`);
  const data = await res.json() as { status: number; request: string };
  if (data.status === 1) {
    console.log(`  Solde 2captcha : $${data.request}`);
  } else {
    console.warn(`  Solde 2captcha : erreur (${data.request})`);
  }
}

async function extractSitekey(page: import("playwright").Page): Promise<string> {
  return page.evaluate(() => {
    // 1. Widget .cf-turnstile
    const widget = document.querySelector<HTMLElement>(".cf-turnstile[data-sitekey]");
    if (widget?.getAttribute("data-sitekey")) return widget.getAttribute("data-sitekey")!;

    // 2. Iframe challenges.cloudflare.com
    const iframes = document.querySelectorAll<HTMLIFrameElement>(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"]'
    );
    for (const f of iframes) {
      const m = (f.getAttribute("src") ?? "").match(/[?&/]k=([0-9a-zA-Z_-]{10,})/);
      if (m) return m[1];
    }

    // 3. data-sitekey générique
    const generic = document.querySelector<HTMLElement>("[data-sitekey]");
    if (generic?.getAttribute("data-sitekey")) return generic.getAttribute("data-sitekey")!;

    // 4. Scan HTML brut
    const match = document.documentElement.innerHTML.match(
      /"sitekey"\s*:\s*"([0-9a-zA-Z_-]{10,})"|data-sitekey="([0-9a-zA-Z_-]{10,})"/
    );
    return match ? (match[1] ?? match[2] ?? "") : "";
  }).catch(() => "");
}

async function submitTask(sitekey: string, pageUrl: string): Promise<string | null> {
  const params = new URLSearchParams({
    key: API_KEY,
    method: "turnstile",
    sitekey,
    pageurl: pageUrl,
    json: "1",
  });

  console.log(`\n  → Soumission à 2captcha (/in.php method=turnstile)…`);
  console.log(`    sitekey : ${pad(sitekey, 30)}…`);
  console.log(`    pageurl : ${pageUrl}`);

  const res = await fetch(`${TWO_CAPTCHA_BASE}/in.php?${params.toString()}`);
  const data = await res.json() as { status: number; request: string };

  if (data.status !== 1) {
    console.error(`  ❌ Refusé par 2captcha : ${data.request}`);
    if (data.request === "ERROR_WRONG_CAPTCHA_ID") {
      console.error("     → Ce compte 2captcha ne supporte PAS Turnstile (plan insuffisant).");
      console.error("     → Solution : utiliser Anti-Captcha ou CapSolver pour Turnstile.");
    }
    return null;
  }

  console.log(`  ✅ Tâche acceptée — ID: ${data.request}`);
  return data.request;
}

async function pollSolution(taskId: string): Promise<string | null> {
  console.log(`\n  ⏳ Polling résolution (max ${MAX_POLLS * POLL_INTERVAL_MS / 1000}s)…`);
  for (let i = 1; i <= MAX_POLLS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    const params = new URLSearchParams({
      key: API_KEY,
      action: "get",
      id: taskId,
      json: "1",
    });

    const res = await fetch(`${TWO_CAPTCHA_BASE}/res.php?${params.toString()}`);
    const data = await res.json() as { status: number; request: string };

    if (data.status === 1) {
      console.log(`  ✅ Token reçu en ${i * POLL_INTERVAL_MS / 1000}s (longueur: ${data.request.length})`);
      return data.request;
    }

    if (data.request !== "CAPCHA_NOT_READY") {
      console.error(`  ❌ Erreur poll : ${data.request}`);
      return null;
    }

    process.stdout.write(`     #${i}/${MAX_POLLS} en attente…\r`);
  }

  console.error("\n  ❌ Timeout — aucune solution reçue");
  return null;
}

async function injectToken(page: import("playwright").Page, token: string): Promise<void> {
  await page.evaluate((tok: string) => {
    const hidden = document.querySelector<HTMLInputElement>(
      '[name="cf-turnstile-response"], input[name="cf_challenge_response"]'
    );
    if (hidden) hidden.value = tok;

    const w = window as unknown as Record<string, unknown>;
    document.querySelectorAll<HTMLElement>(".cf-turnstile, [data-cf-turnstile]").forEach(widget => {
      const cbName = widget.getAttribute("data-callback");
      if (cbName && typeof w[cbName] === "function") {
        try { (w[cbName] as (t: string) => void)(tok); } catch { /* ignore */ }
      }
    });

    const form = document.querySelector<HTMLFormElement>(
      "#challenge-form, form[action*='cdn-cgi'], form"
    );
    if (form) {
      let inp = form.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]');
      if (!inp) {
        inp = document.createElement("input");
        inp.type = "hidden";
        inp.name = "cf-turnstile-response";
        form.appendChild(inp);
      }
      inp.value = tok;
      form.submit();
    }
  }, token);
}

async function main() {
  console.log("=".repeat(60));
  console.log(" TEST TURNSTILE 2CAPTCHA");
  console.log("=".repeat(60));
  console.log(`  URL cible  : ${TARGET_URL}`);
  console.log(`  2captcha   : ${API_KEY ? `✅ clé présente (${API_KEY.slice(0, 8)}…)` : "❌ TWOCAPTCHA_API_KEY manquante"}`);

  if (!API_KEY) {
    console.error("\nArrêt — définissez TWOCAPTCHA_API_KEY dans .env ou en variable d'environnement.");
    process.exit(1);
  }

  await checkBalance();

  console.log("\n[1/4] Lancement navigateur stealth…");
  const { browser, page } = await launchBrowser({
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  });

  try {
    console.log("[2/4] Navigation…");
    await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await new Promise(r => setTimeout(r, 2_000));

    const title = await page.title();
    console.log(`      Titre page : "${title}"`);
    console.log(`      URL réelle : ${page.url()}`);

    console.log("[3/4] Extraction sitekey Turnstile…");
    const sitekey = await extractSitekey(page);

    if (!sitekey) {
      console.error("  ❌ Aucun widget Turnstile détecté sur cette page.");
      console.log("\n  Astuce : passez l'URL d'une page avec Turnstile en argument :");
      console.log("    tsx src/testTurnstile.ts https://votre-consulat.es/...");
      await browser.close();
      process.exit(1);
    }

    console.log(`  ✅ Sitekey trouvé : ${sitekey}`);

    const taskId = await submitTask(sitekey, page.url());
    if (!taskId) {
      await browser.close();
      process.exit(1);
    }

    const token = await pollSolution(taskId);
    if (!token) {
      await browser.close();
      process.exit(1);
    }

    console.log("\n[4/4] Injection token dans la page…");
    await injectToken(page, token);
    await new Promise(r => setTimeout(r, 3_000));

    const newTitle = await page.title();
    const newUrl = page.url();
    console.log(`      Titre après : "${newTitle}"`);
    console.log(`      URL après   : ${newUrl}`);

    const cfTitleRe = /un instant|just a moment|un momento|attention required|verifying/i;
    if (!cfTitleRe.test(newTitle)) {
      console.log("\n✅ SUCCÈS — Cloudflare Turnstile résolu et page accessible !");
    } else {
      console.warn("\n⚠️  Token injecté mais CF toujours présent — l'injection form.submit() n'a peut-être pas fonctionné.");
      console.warn("   Le token lui-même est valide (reçu de 2captcha).");
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error("[FATAL]", err);
  process.exit(1);
});
