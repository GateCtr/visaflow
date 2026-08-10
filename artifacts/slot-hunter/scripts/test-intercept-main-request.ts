#!/usr/bin/env node
/**
 * Utilise Puppeteer pour charger le vrai portail citaconsular.es,
 * résoudre CF via CapSolver, et intercepter la requête /main/ réelle
 * que le navigateur envoie — y compris tous les headers et la vraie réponse.
 *
 * Objectif : obtenir la preuve empirique de ce que le vrai navigateur
 * envoie à /main/ et quelle réponse il reçoit.
 */
import puppeteer from "puppeteer";
import { createServer } from "http";

const PROXY_URL   = process.env.SOAX_PROXY_URL ?? "";
const CAP_KEY     = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE    = "https://api.capsolver.com";
const PORTAL_URL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const UA          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ─── CapSolver helper ────────────────────────────────────────────────────────
async function solveCF(html: string, websiteURL: string): Promise<string | null> {
  const p = new URL(PROXY_URL);
  const proxy = `http://${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}@${p.hostname}:${p.port}`;
  const cr = await (await fetch(`${CAP_BASE}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAP_KEY, task: {
      type: "AntiCloudflareTask", websiteURL, proxy, userAgent: UA,
      html: html.slice(0, 32_000),
    }}),
    signal: AbortSignal.timeout(30_000),
  })).json() as any;
  if (cr.errorId !== 0) { console.error(`❌ CapSolver: ${cr.errorDescription}`); return null; }
  console.log(`  task: ${cr.taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAP_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAP_KEY, taskId: cr.taskId }),
      signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`❌ CapSolver: ${pr.errorCode}`); return null; }
    if (pr.status === "ready") {
      const ua = pr.solution?.userAgent;
      if (ua) console.log(`  CapSolver UA: ${ua}`);
      return pr.solution?.cookies?.["cf_clearance"] ?? null;
    }
    process.stdout.write(".");
  }
  return null;
}

async function main() {
  // ─── 1. Probe pour obtenir le HTML du challenge CF ───────────────────────
  console.log("Étape 1 : Probe via impit (cf challenge HTML)…");
  const { Impit } = await import("impit");
  const probeImpit = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any) as any;
  const rProbe = await (probeImpit.fetch(PORTAL_URL, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,es;q=0.8",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
  } as any) as unknown as Promise<any>);
  const challengeHtml = await rProbe.text() as string;
  console.log(`  Probe: HTTP ${rProbe.status} | ${challengeHtml.length}B`);

  // ─── 2. Résoudre CF ──────────────────────────────────────────────────────
  console.log("Étape 2 : Résolution CF via CapSolver…");
  const cfClearance = await solveCF(challengeHtml, PORTAL_URL);
  if (!cfClearance) { console.error("Impossible d'obtenir cf_clearance"); process.exit(1); }
  console.log(`  cf_clearance: ${cfClearance.slice(0, 40)}…`);

  // ─── 3. Ouvrir Puppeteer, injecter cf_clearance, charger le portail ──────
  console.log("\nÉtape 3 : Démarrage Puppeteer (sans proxy, injection cookie)…");
  const chromePath = "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1280, height: 800 });

  // Intercepter TOUTES les requêtes /main/
  const mainRequests: any[] = [];
  const mainResponses: any[] = [];

  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = req.url();
    if (url.includes("/onlinebookings/")) {
      const headers = req.headers();
      const entry: any = { url, method: req.method(), headers };
      if (url.includes("/main/")) {
        mainRequests.push(entry);
        console.log(`\n🔍 REQUÊTE /main/ INTERCEPTÉE:`);
        console.log(`  URL: ${url.slice(0, 200)}`);
        console.log(`  Headers: ${JSON.stringify(headers, null, 2).slice(0, 2000)}`);
      }
      req.continue();
    } else {
      req.continue();
    }
  });

  page.on("response", async (resp) => {
    const url = resp.url();
    if (url.includes("/onlinebookings/main/")) {
      const status = resp.status();
      const ct = resp.headers()["content-type"] ?? "";
      try {
        const body = await resp.text();
        mainResponses.push({ url, status, ct, body: body.slice(0, 5000), length: body.length });
        console.log(`\n✅ RÉPONSE /main/:`);
        console.log(`  Status: ${status} | ${body.length}B | ${ct}`);
        console.log(`  Body: "${body.slice(0, 500)}"`);
      } catch (e) {
        console.log(`\n⚠️  RÉPONSE /main/ (body error): ${e}`);
      }
    }
  });

  // Injecter le cookie cf_clearance avant navigation
  await page.setCookie({
    name: "cf_clearance",
    value: cfClearance,
    domain: ".citaconsular.es",
    path: "/",
    httpOnly: true,
    secure: true,
  });

  // ─── 4. Naviguer vers le portail ─────────────────────────────────────────
  console.log(`\nÉtape 4 : Navigation vers ${PORTAL_URL}`);
  let navOk = false;
  try {
    const resp = await page.goto(PORTAL_URL, {
      waitUntil: "networkidle2",
      timeout: 60_000,
    });
    const title = await page.title();
    const url = page.url();
    console.log(`  HTTP: ${resp?.status()} | Title: "${title}" | URL: ${url}`);
    navOk = !title.includes("moment") && !title.includes("instant") && !title.includes("Just a");
  } catch (e) {
    console.log(`  Navigation timeout (normal si CF): ${e}`);
  }

  if (!navOk) {
    // Peut-être encore sur CF challenge — prendre screenshot
    console.log("⚠️  Possiblement sur page CF challenge. Titre de la page:");
    console.log("  " + await page.title());
    
    // Attendre un peu et re-tenter
    await new Promise(r => setTimeout(r, 3_000));
    await page.goto(PORTAL_URL, { waitUntil: "networkidle2", timeout: 60_000 }).catch(() => {});
    console.log("  Après 2ème tentative: " + await page.title());
  }

  // ─── 5. Attendre le token CSRF et faire POST Continuar ──────────────────
  console.log("\nÉtape 5 : Attente du formulaire token…");
  await new Promise(r => setTimeout(r, 3_000));
  
  const token = await page.evaluate(() => {
    const inp = document.querySelector<HTMLInputElement>("input[name='token']");
    return inp?.value ?? null;
  });
  console.log(`  Token CSRF: ${token ? token.slice(0, 20) + "…" : "NON TROUVÉ"}`);

  if (token) {
    console.log("\nÉtape 6 : POST Continuar via formulaire…");
    // Cliquer sur le bouton Continuar ou soumettre le formulaire
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button[type='submit'], input[type='submit']");
      if (btn) { btn.click(); return "button"; }
      const form = document.querySelector<HTMLFormElement>("form");
      if (form) { form.submit(); return "form"; }
      return null;
    });
    console.log(`  Soumission: ${submitted}`);
    await new Promise(r => setTimeout(r, 5_000));
    
    const titleAfter = await page.title();
    const urlAfter = page.url();
    console.log(`  Après POST: "${titleAfter}" | ${urlAfter}`);
  } else {
    // Chercher dans le contenu de la page
    const content = await page.content();
    console.log(`  Page content (500 chars): ${content.slice(0, 500)}`);
  }

  // ─── 6. Attendre les requêtes /main/ ─────────────────────────────────────
  console.log("\nÉtape 7 : Attente des requêtes /main/ (max 15s)…");
  await new Promise(r => setTimeout(r, 15_000));

  // ─── 7. Résumé ───────────────────────────────────────────────────────────
  console.log("\n══════════ RÉSUMÉ ══════════");
  if (mainRequests.length === 0) {
    console.log("❌ Aucune requête /main/ interceptée");
    // Inspecter le DOM pour debug
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log(`  Contenu visible: "${bodyText}"`);
    
    // Checker les cookies actuels
    const cookies = await page.cookies();
    const phpCookie = cookies.find(c => c.name === "PHPSESSID");
    const cfCookie = cookies.find(c => c.name === "cf_clearance");
    console.log(`  PHPSESSID: ${phpCookie?.value ?? "ABSENT"}`);
    console.log(`  cf_clearance: ${cfCookie?.value?.slice(0, 30) ?? "ABSENT"}…`);
  } else {
    console.log(`✅ ${mainRequests.length} requête(s) /main/ interceptée(s)`);
    console.log(`   ${mainResponses.length} réponse(s) capturée(s)`);
  }

  await browser.close();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
