/**
 * diag-bookitit-network-capture.ts — Capture réseau complète Bookitit
 *
 * Objectif : capturer EXACTEMENT ce que le navigateur envoie/reçoit
 * sur tous les endpoints /onlinebookings/* après le clic Continuar,
 * puis rejouer chaque requête avec impit pour identifier l'ordre et
 * les headers qui font fonctionner getservices/.
 *
 * Sortie :
 *   debug_dumps/bookitit-network-capture-<ts>.json — séquence complète
 *   debug_dumps/bookitit-network-capture-<ts>.log  — log lisible
 *
 * Usage :
 *   npx tsx scripts/diag-bookitit-network-capture.ts [--portal kinshasa|saopolo] [--headed] [--replay]
 *
 *   --replay  : après capture, rejoue les requêtes /onlinebookings/* avec impit
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Impit } from "impit";
import type { Browser, Page, HTTPRequest, HTTPResponse } from "puppeteer";

import {
  solveCfChallenge,
  preparePageStealth,
} from "../src/cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ─── Portails ──────────────────────────────────────────────────────────────────

const PORTALS: Record<string, { name: string; url: string; widgetKey: string }> = {
  kinshasa: {
    name: "Kinshasa (RDC)",
    url: "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/",
    widgetKey: "2d01502f12dc08400e22aea87fb00ae34",
  },
  saopolo: {
    name: "São Paulo (Brésil)",
    url: "https://www.citaconsular.es/pt/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/",
    widgetKey: "25028fcd7126544630b8da0c6e60722b5",
  },
};

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  seq: number;
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  status: number;
  responseHeaders: Record<string, string>;
  bodyLength: number;
  bodyPreview: string;   // first 500 chars
  bodyFull: string;      // full body (for replay)
  timingMs: number;
  phase: "pre-main" | "main" | "post-main";
}

interface NetworkCapture {
  portal: string;
  portalUrl: string;
  capturedAt: string;
  browserCookies: Array<{ name: string; value: string }>;
  userAgent: string;
  proxyUrl: string;
  cfClearance: string;
  phpSessId: string;
  requests: CapturedRequest[];
}

// ─── Proxy loader ──────────────────────────────────────────────────────────────

function loadProxyCsvFirst(): string {
  // IP ISP dédiée Espagne — priorité absolue (fixe, non-rotative)
  if (process.env.SPAIN_ISP_PROXY_URL?.trim()) {
    return process.env.SPAIN_ISP_PROXY_URL.trim();
  }
  const csv = resolve(process.cwd(), "decodo-proxies.csv");
  if (!existsSync(csv)) return process.env.DECODO_PROXY_URL?.trim() ?? "";
  const lines = readFileSync(csv, "utf-8")
    .split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (!lines.length) return process.env.DECODO_PROXY_URL?.trim() ?? "";
  const [host, port, user, ...pp] = lines[0].split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pp.join(":"))}@${host}:${port}`;
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(): { portalKey: string; headed: boolean; replay: boolean } {
  const args = process.argv.slice(2);
  let portalKey = "kinshasa";
  let headed = false;
  let replay = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal" && args[i + 1]) portalKey = args[++i].toLowerCase();
    if (args[i] === "--headed") headed = true;
    if (args[i] === "--replay") replay = true;
  }
  return { portalKey, headed, replay };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { portalKey, headed, replay } = parseArgs();
  const portal = PORTALS[portalKey];
  if (!portal) {
    console.error(`❌ Portail inconnu: "${portalKey}". Disponibles: ${Object.keys(PORTALS).join(", ")}`);
    process.exit(1);
  }

  mkdirSync("debug_dumps", { recursive: true });
  const ts = Date.now();
  const TAG = "[capture]";

  const proxyUrl = loadProxyCsvFirst();
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.55 Safari/537.36";

  let proxyServer: string | undefined;
  let proxyAuth: { username: string; password: string } | undefined;
  if (proxyUrl) {
    try {
      const p = new URL(proxyUrl);
      proxyServer = `http://${p.hostname}:${p.port || "10001"}`;
      proxyAuth = { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) };
    } catch { /* ignore */ }
  }

  console.log("═".repeat(70));
  console.log("  CAPTURE RÉSEAU COMPLÈTE — Bookitit España");
  console.log("═".repeat(70));
  console.log(`  Portail  : ${portal.name}`);
  console.log(`  URL      : ${portal.url}`);
  console.log(`  Proxy    : ${proxyServer ?? "aucun"}`);
  console.log(`  Mode     : ${headed ? "headed" : "headless"} | replay: ${replay}`);
  console.log();

  // ── Lancer Puppeteer ────────────────────────────────────────────────────────
  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,720",
    "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
    "--no-first-run", "--no-default-browser-check",
    "--disable-v8-code-cache", "--disable-crash-reporter",
  ];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);

  const browser: Browser = await (puppeteer as any).launch({
    headless: !headed,
    args,
    defaultViewport: { width: 1280, height: 720 },
  });

  const capture: NetworkCapture = {
    portal: portalKey,
    portalUrl: portal.url,
    capturedAt: new Date().toISOString(),
    browserCookies: [],
    userAgent: UA,
    proxyUrl,
    cfClearance: "",
    phpSessId: "",
    requests: [],
  };

  let seq = 0;
  let mainLoaded = false;
  let mainResolve: (() => void) | null = null;
  const mainSignal = new Promise<void>(r => { mainResolve = r; });

  // Tracking pour les phases
  const pendingRequests = new Map<string, { seq: number; t0: number; reqHeaders: Record<string,string>; postData?: string }>();

  try {
    const pages = await browser.pages();
    const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();

    if (proxyAuth) await page.authenticate(proxyAuth);
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 720 });
    await preparePageStealth(page, UA);

    // ── Dialog handler ────────────────────────────────────────────────────────
    page.on("dialog", async d => {
      console.log(`${TAG} 💬 Dialog: "${d.message().slice(0, 60)}" → accept`);
      await d.accept().catch(() => {});
    });

    // ── Interception réseau complète via CDP ──────────────────────────────────
    // requestWillBeSentExtraInfo : inclut les vrais headers HTTP (Cookie inclus)
    await page.setRequestInterception(false);
    const CDP = await page.createCDPSession();
    await CDP.send("Network.enable");

    // Map requestId → extra info (avec Cookie réel)
    const extraInfoMap = new Map<string, Record<string, string>>();

    // requestWillBeSentExtraInfo inclut le Cookie header réel
    CDP.on("Network.requestWillBeSentExtraInfo", (evt: any) => {
      if (evt.headers) {
        extraInfoMap.set(evt.requestId, evt.headers as Record<string, string>);
      }
    });

    // Tracker les requêtes envoyées (méta-données)
    CDP.on("Network.requestWillBeSent", (evt: any) => {
      const url = evt.request.url as string;
      if (!url.includes("citaconsular.es") && !url.includes("bookitit")) return;

      const currentSeq = ++seq;
      // Fusionner les headers de requestWillBeSent + extraInfo (cookie réel)
      const baseHeaders = (evt.request.headers ?? {}) as Record<string, string>;
      const extraHeaders = extraInfoMap.get(evt.requestId) ?? {};
      const mergedHeaders = { ...baseHeaders, ...extraHeaders };

      pendingRequests.set(evt.requestId, {
        seq: currentSeq,
        t0: Date.now(),
        reqHeaders: mergedHeaders,
        postData: evt.request.postData,
      });

      const phase: CapturedRequest["phase"] = mainLoaded
        ? "post-main"
        : url.includes("/main/")
          ? "main"
          : "pre-main";

      console.log(`${TAG} ➜ [${currentSeq}] ${evt.request.method} ${url.replace("https://www.citaconsular.es", "")} [${phase}]`);
    });

    // Capturer les réponses
    CDP.on("Network.responseReceived", async (evt: any) => {
      const pending = pendingRequests.get(evt.requestId);
      if (!pending) return;

      const url = evt.response.url as string;
      if (!url.includes("citaconsular.es") && !url.includes("bookitit")) return;

      const phase: CapturedRequest["phase"] = mainLoaded
        ? "post-main"
        : url.includes("/main/")
          ? "main"
          : "pre-main";

      // Récupérer le body — pour /main/ on attend plus longtemps (stream gzip)
      let bodyText = "";
      let bodyLength = 0;
      const waitMs = url.includes("/main/") ? 3_000 : 200;
      try {
        await new Promise(r => setTimeout(r, waitMs));
        const bodyEvt = await CDP.send("Network.getResponseBody", { requestId: evt.requestId })
          .catch(() => ({ body: "", base64Encoded: false })) as any;
        bodyText = bodyEvt.base64Encoded
          ? Buffer.from(bodyEvt.body as string, "base64").toString("utf-8")
          : (bodyEvt.body as string);
        bodyLength = bodyText.length;
      } catch { /* non-fatal */ }

      // Fusionner avec les extra headers si pas encore fait
      const extraHeaders = extraInfoMap.get(evt.requestId) ?? {};
      const fullReqHeaders = { ...pending.reqHeaders, ...extraHeaders };

      const entry: CapturedRequest = {
        seq: pending.seq,
        url,
        method: evt.response.requestHeaders?.["method"] ?? "GET",
        requestHeaders: fullReqHeaders,
        postData: pending.postData,
        status: evt.response.status as number,
        responseHeaders: evt.response.headers as Record<string, string>,
        bodyLength,
        bodyPreview: bodyText.slice(0, 500),
        bodyFull: bodyText,
        timingMs: Date.now() - pending.t0,
        phase,
      };

      capture.requests.push(entry);
      pendingRequests.delete(evt.requestId);
      extraInfoMap.delete(evt.requestId);

      const label = url.replace("https://www.citaconsular.es", "").split("?")[0];
      console.log(`${TAG} ← [${pending.seq}] ${evt.response.status} ${bodyLength}B${bodyLength === 0 && (evt.response.headers as any)?.["content-length"] ? ` (content-length: ${(evt.response.headers as any)["content-length"]})` : ""} | ${label}`);

      if (url.includes("/main/") && bodyLength > 10_000) {
        mainLoaded = true;
        mainResolve?.();
        console.log(`${TAG} ✅ /main/ marqué — les requêtes suivantes sont "post-main"`);
      } else if (url.includes("/main/") && (evt.response.headers as any)?.["content-length"]) {
        // /main/ a du contenu mais CDP n'a pas pu le lire — marquer quand même
        const cl = parseInt((evt.response.headers as any)["content-length"], 10);
        if (cl > 10_000) {
          mainLoaded = true;
          mainResolve?.();
          console.log(`${TAG} ✅ /main/ marqué via content-length (${cl}B) — CDP body capture failed`);
        }
      }
    });

    // ── Navigation + CF solve ─────────────────────────────────────────────────
    console.log(`\n${TAG} 🌐 Navigation vers le portail…`);
    try {
      await page.goto(
        `${portal.url}${portal.url.includes("?") ? "&" : "?"}_cb=${Date.now()}`,
        { waitUntil: "domcontentloaded", timeout: 70_000 },
      );
    } catch { /* timeout non-fatal */ }

    console.log(`${TAG} 🔐 Résolution CF…`);
    const solveResult = await solveCfChallenge(page, {
      targetUrl: portal.url,
      timeout: 120_000,
      enableCapsolverFallback: false,
    });

    if (!solveResult.success) throw new Error(`CF solve échoué: ${solveResult.error}`);
    console.log(`${TAG} ✅ CF résolu en ${Math.round(solveResult.durationMs / 1000)}s via ${solveResult.solvedBy}`);

    capture.cfClearance = solveResult.cfClearance ?? "";

    // ── Clic Continuar ────────────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, 2_500)); // laisser page se stabiliser

    console.log(`\n${TAG} 🖱️  Clic Continuar…`);
    const clicked = await page.evaluate((): { ok: boolean; info: string } => {
      const tokenInput = document.querySelector('input[name="token"]') as HTMLInputElement | null;
      if (tokenInput) {
        const form = (tokenInput as any).form || tokenInput.closest("form");
        if (form) { (form as HTMLFormElement).submit(); return { ok: true, info: "form.submit(token)" }; }
      }
      const submitEls = document.querySelectorAll<HTMLElement>('input[type="submit"], button[type="submit"]');
      if (submitEls.length > 0) { (submitEls[0] as any).click(); return { ok: true, info: "submit button" }; }
      const anyForm = document.querySelector("form");
      if (anyForm) { anyForm.submit(); return { ok: true, info: "any form" }; }
      return { ok: false, info: `body: ${document.body?.innerHTML?.slice(0, 200)}` };
    });

    if (clicked.ok) {
      console.log(`${TAG} ✅ Continuar cliqué (${clicked.info}) — attente /main/…`);
    } else {
      console.warn(`${TAG} ⚠️  Continuar pas trouvé: ${clicked.info.slice(0, 120)}`);
    }

    // ── Attendre /main/ puis laisser les POST-MAIN requests se faire ──────────
    console.log(`${TAG} ⏳ Attente /main/ + requêtes post-main (30s max)…`);
    await Promise.race([mainSignal, new Promise<void>(r => setTimeout(r, 30_000))]);

    if (mainLoaded) {
      // Laisser les requêtes post-main partir (getwidgetconfigurations, getservices, etc.)
      console.log(`${TAG} ⏳ Attente 10s pour capturer toutes les requêtes post-main…`);
      await new Promise(r => setTimeout(r, 10_000));
    } else {
      console.warn(`${TAG} ⚠️  /main/ non chargé dans le délai`);
    }

    // ── Extraire les cookies ───────────────────────────────────────────────────
    const rawCookies = await page.cookies("https://www.citaconsular.es").catch(() => [] as any[]);
    capture.browserCookies = rawCookies.map((c: any) => ({ name: c.name, value: c.value }));
    capture.phpSessId = capture.browserCookies.find(c => c.name === "PHPSESSID")?.value ?? "";

    console.log(`${TAG} 🍪 Cookies: ${capture.browserCookies.map(c => c.name).join(", ")}`);

  } finally {
    await browser.close().catch(() => {});
    console.log(`${TAG} 🔋 Browser fermé`);
  }

  // ── Sauvegarder la capture ───────────────────────────────────────────────────
  const jsonPath = `debug_dumps/bookitit-network-capture-${ts}.json`;
  writeFileSync(jsonPath, JSON.stringify(capture, null, 2), "utf-8");

  // ── Rapport lisible ──────────────────────────────────────────────────────────
  let log = "";
  log += "═".repeat(70) + "\n";
  log += "  SÉQUENCE RÉSEAU BOOKITIT — " + portal.name + "\n";
  log += "  Capturé le " + capture.capturedAt + "\n";
  log += "═".repeat(70) + "\n\n";

  log += `cf_clearance : ${capture.cfClearance.slice(0, 40)}…\n`;
  log += `PHPSESSID    : ${capture.phpSessId.slice(0, 30)}\n`;
  log += `Cookies      : ${capture.browserCookies.map(c => c.name).join(", ")}\n\n`;

  const bookititReqs = capture.requests.filter(r =>
    r.url.includes("/onlinebookings/") || r.url.includes("bookitit")
  );

  log += `\n── Requêtes /onlinebookings/* (${bookititReqs.length} au total) ──────────────────\n\n`;

  for (const req of bookititReqs) {
    log += `[${req.seq}] [${req.phase.toUpperCase().padEnd(10)}] ${req.method} ${req.url.replace("https://www.citaconsular.es", "")}\n`;
    log += `     Status: ${req.status} | Body: ${req.bodyLength}B | Temps: ${req.timingMs}ms\n`;

    // Headers de la requête (les plus importants)
    const importantHeaders = ["cookie", "referer", "origin", "x-requested-with",
      "accept", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site",
      "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "user-agent",
      "content-type", "content-length"];
    log += `     Request headers:\n`;
    for (const h of importantHeaders) {
      const val = req.requestHeaders[h] ?? req.requestHeaders[h.toLowerCase()];
      if (val) log += `       ${h}: ${val.slice(0, 120)}\n`;
    }

    if (req.postData) {
      log += `     POST data: ${req.postData.slice(0, 200)}\n`;
    }

    log += `     Response body preview: ${req.bodyPreview.slice(0, 300).replace(/\n/g, "↵")}\n\n`;
  }

  const logPath = `debug_dumps/bookitit-network-capture-${ts}.log`;
  writeFileSync(logPath, log, "utf-8");

  // ── Afficher le résumé ────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(70));
  console.log("  SÉQUENCE RÉSEAU CAPTURÉE");
  console.log("═".repeat(70));
  console.log(`  Total requêtes citaconsular.es : ${capture.requests.length}`);
  console.log(`  Requêtes /onlinebookings/*     : ${bookititReqs.length}`);
  console.log();

  for (const req of bookititReqs) {
    const endpoint = req.url.replace(/^https:\/\/www\.citaconsular\.es\/onlinebookings\//, "").split("?")[0];
    const mark = req.bodyLength > 100 ? "✅" : "❌";
    console.log(`  ${mark} [${req.seq}] [${req.phase.padEnd(10)}] ${req.method} /${endpoint} → ${req.status} | ${req.bodyLength}B`);
  }

  console.log();
  console.log(`  Fichiers :`);
  console.log(`    JSON : ${jsonPath}`);
  console.log(`    LOG  : ${logPath}`);

  // ── Replay avec impit ─────────────────────────────────────────────────────────
  if (replay && bookititReqs.length > 0) {
    console.log("\n" + "═".repeat(70));
    console.log("  REPLAY IMPIT — Reproduction exacte des requêtes /onlinebookings/");
    console.log("  (headers identiques au navigateur, Cookie réel capturé via extraInfo)");
    console.log("═".repeat(70));

    const cookieStr = capture.browserCookies.map(c => `${c.name}=${c.value}`).join("; ");
    console.log(`\n  Cookie reconstitué : ${cookieStr.replace(/cf_clearance=[^;]+/, "cf_clearance=…").slice(0, 100)}`);

    const impit = new Impit({ browser: "chrome", proxyUrl: capture.proxyUrl || undefined } as any);

    // Rejouer TOUTES les requêtes /onlinebookings/* dans l'ordre (main inclus)
    const toReplay = bookititReqs.filter(r => r.url.includes("/onlinebookings/"));
    console.log(`\n  ${toReplay.length} requêtes à rejouer (ordre séquentiel) :\n`);

    for (const req of toReplay) {
      const endpoint = req.url.replace(/^https:\/\/www\.citaconsular\.es\/onlinebookings\//, "").split("?")[0];
      process.stdout.write(`  [${req.seq}] [${req.phase.padEnd(10)}] ${req.method} /${endpoint} → `);

      try {
        // Headers EXACTS du navigateur — avec Cookie réel
        const headers: Record<string, string> = {};

        // Copier les headers du browser dans l'ordre naturel Chrome JSONP
        const chromeOrder = [
          "referer", "x-requested-with", "accept-language", "accept",
          "user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
          "cookie",
        ];

        // D'abord les headers capturés
        for (const [k, v] of Object.entries(req.requestHeaders)) {
          const kl = k.toLowerCase();
          if (![":", ":method", ":path", ":scheme", ":authority"].some(p => kl.startsWith(p))) {
            headers[kl] = v;
          }
        }

        // Injecter notre Cookie (qui inclut le vrai cf_clearance + PHPSESSID)
        if (req.requestHeaders["cookie"]) {
          // Cookie capturé par CDP ExtraInfo — utiliser tel quel
          headers["cookie"] = req.requestHeaders["cookie"];
          console.log(`\n    → Cookie réel CDP: ${req.requestHeaders["cookie"].slice(0, 80)}…`);
          process.stdout.write("    → ");
        } else {
          // Fallback : cookie reconstitué depuis page.cookies()
          headers["cookie"] = cookieStr;
        }

        // Supprimer les pseudo-headers HTTP/2
        for (const k of Object.keys(headers)) {
          if (k.startsWith(":")) delete headers[k];
        }

        const t0 = Date.now();
        const res = await impit.fetch(req.url, {
          method: req.method,
          headers,
          body: req.postData || undefined,
        } as any);
        const body = await res.text();
        const ms = Date.now() - t0;

        const mark = body.length > 100 ? "✅" : (body.length > 0 ? "⚠️ " : "❌");
        console.log(`${mark} ${res.status} | ${body.length}B | ${ms}ms`);
        if (body.length > 0 && body.length < 2000) {
          console.log(`         ${body.slice(0, 300)}`);
        }
        if (body.length === 0) {
          const cfRay = res.headers?.get?.("cf-ray") ?? "?";
          const ct = res.headers?.get?.("content-type") ?? "?";
          console.log(`         cf-ray: ${cfRay} | content-type: ${ct}`);
        }
      } catch (e: any) {
        console.log(`❌ Exception: ${e.message?.slice(0, 100)}`);
      }
    }

    // Résumé des headers importants pour diagnostic
    console.log("\n\n── Headers navigateur pour getservices/ (référence) ───────────────────────");
    const svcReq = bookititReqs.find(r => r.url.includes("getservices"));
    if (svcReq) {
      for (const [k, v] of Object.entries(svcReq.requestHeaders)) {
        if (!k.startsWith(":")) {
          console.log(`  ${k}: ${v.slice(0, 100)}`);
        }
      }
    }
  }

  console.log();
}

main().catch(e => {
  console.error(`Fatal: ${e.message ?? e}`);
  process.exit(1);
});
