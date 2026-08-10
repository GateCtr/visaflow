/**
 * test-saopolo-browser-e2e.ts — Test E2E complet booking Saopolo
 *
 * ARCHITECTURE : 100% standalone — utilise cf-challenge-solver.ts directement.
 *   • Lance son propre Chromium avec SPAIN_ISP_PROXY_URL en --proxy-server
 *   • solveCfChallengeWithRetry() pour le challenge CF (JSD / Turnstile)
 *   • Flow Bookitit inline : Continuar → /main/ → Aceptar → service → slot → signin → summary
 *   • Aucune dépendance sur spainPersistentBrowser
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   TEST_SPAIN_LOGIN=AB123456 TEST_SPAIN_PASSWORD=secret \
 *   npx tsx src/scripts/test-saopolo-browser-e2e.ts
 *
 *   # Navigateur visible :
 *   SPAIN_HEADED=1 SPAIN_SLOW_MO=120 TEST_SPAIN_LOGIN=... TEST_SPAIN_PASSWORD=... \
 *   npx tsx src/scripts/test-saopolo-browser-e2e.ts
 *
 * ENV VARS
 *   SPAIN_ISP_PROXY_URL     — REQUIS : http://user:pass@host:port
 *   TEST_SPAIN_LOGIN        — REQUIS : numéro passeport ou email
 *   TEST_SPAIN_PASSWORD     — REQUIS : mot de passe (fallback: CEV_TEST_PASSWORD)
 *   SPAIN_HEADED=1          — Navigateur visible
 *   SPAIN_SLOW_MO=N         — Délai interactions (ms, défaut 60 en headed)
 *   SPAIN_DEVTOOLS=1        — DevTools auto
 *   TEST_TARGET_DATE        — Forcer date YYYY-MM-DD (défaut: premier créneau trouvé)
 *   TEST_TARGET_TIME        — Forcer heure HH:MM
 *   TEST_AGENDA_ID          — Forcer agenda ID
 *   TEST_SERVICE_ID         — ID service (défaut: bkt853215 = Pasaportes Saopolo)
 *   CHROMIUM_EXECUTABLE_PATH — Chemin Chromium alternatif
 */

import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page, CDPSession } from "puppeteer";
import {
  solveCfChallengeWithRetry,
} from "../cf-challenge-solver.js";

puppeteer.use(StealthPlugin());

// ── Flags CLI ─────────────────────────────────────────────────────────────────
{
  const argv = process.argv.slice(2);
  if (argv.includes("--headed"))   process.env.SPAIN_HEADED   = "1";
  if (argv.includes("--devtools")) process.env.SPAIN_DEVTOOLS = "1";
  const sm = argv.find((a) => a.startsWith("--slow-mo="));
  if (sm)                          process.env.SPAIN_SLOW_MO  = sm.split("=")[1];
}

// ── Constantes portail Saopolo ────────────────────────────────────────────────
const SAOPOLO_URL        = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const SAOPOLO_WIDGET_KEY = "2d01502f12dc08400e22aea87fb00ae34";
const BASE_BOOKITIT      = "https://www.citaconsular.es/onlinebookings/";

// ── Helpers log ───────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: "INFO" | "OK" | "WARN" | "ERR" | "STEP", msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Parse JSONP ───────────────────────────────────────────────────────────────
function parseJsonp(raw: string): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* */ }
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* */ } }
  return null;
}

// ── Parse proxy URL → { server, username, password } ─────────────────────────
function parseProxy(proxyUrl: string): { server: string; username: string; password: string } | null {
  try {
    const u = new URL(proxyUrl);
    const server = `${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
    return { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  } catch {
    return null;
  }
}

// ── CDP proxy auth persistent (survit au detach de solveCfChallengeWithRetry) ─
async function attachProxyAuth(
  page: Page,
  username: string,
  password: string,
): Promise<CDPSession | null> {
  try {
    const client = await page.createCDPSession();
    await client.send("Fetch.enable", {
      handleAuthRequests: true,
      patterns: [],
    });
    client.on("Fetch.authRequired", async (ev: any) => {
      if (ev.authChallenge?.source === "Proxy") {
        await client.send("Fetch.continueWithAuth", {
          requestId: ev.requestId,
          authChallengeResponse: { response: "ProvideCredentials", username, password },
        }).catch(() => {});
      } else {
        await client.send("Fetch.continueWithAuth", {
          requestId: ev.requestId,
          authChallengeResponse: { response: "Default" },
        }).catch(() => {});
      }
    });
    client.on("Fetch.requestPaused", async (ev: any) => {
      await client.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
    });
    return client;
  } catch (err) {
    console.warn(`[proxy-auth] ⚠️ Attach échoué (non-fatal) : ${err}`);
    return null;
  }
}

// ── waitForHash : poll window.location.hash jusqu'à correspondance ────────────
async function waitForHash(page: Page, targets: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hash = await page.evaluate(() => window.location.hash).catch(() => "") as string;
    if (targets.some((t) => hash.includes(t))) return hash;
    await new Promise<void>((r) => setTimeout(r, 250));
  }
  return await page.evaluate(() => window.location.hash).catch(() => "") as string;
}

// ── Capture response réseau via page.waitForResponse ─────────────────────────
function captureResponse(page: Page, urlFragment: string, timeoutMs: number): Promise<string> {
  return page.waitForResponse(
    (r) => r.url().includes(urlFragment),
    { timeout: timeoutMs },
  ).then((r) => r.text()).catch(() => "");
}

// ── Snapshot DOM pour diagnostic ──────────────────────────────────────────────
async function domSnap(page: Page, label: string): Promise<void> {
  try {
    const snap = await page.evaluate(`(function() {
      return JSON.stringify({
        hash: window.location.hash,
        url:  window.location.href.slice(0, 100),
        btns: Array.from(document.querySelectorAll('button,a[href],div[role="button"]'))
          .filter(function(el) { return el.offsetParent !== null; })
          .slice(0, 8)
          .map(function(el) { return el.tagName + '[' + (el.id||'').slice(0,16) + '] "' + (el.textContent||'').trim().slice(0,25) + '"'; }),
        svcLinks: Array.from(document.querySelectorAll('a[href*="selectservice"]'))
          .filter(function(a) { return a.offsetParent !== null; })
          .map(function(a) { return (a.getAttribute('href')||'').slice(0,80); }).slice(0,4),
        stLinks: Array.from(document.querySelectorAll('a[href*="selecttime"]'))
          .filter(function(a) { return a.offsetParent !== null; })
          .map(function(a) { return (a.getAttribute('href')||'').slice(0,80); }).slice(0,4),
        inputs: Array.from(document.querySelectorAll('input'))
          .filter(function(i) { return i.offsetParent !== null; })
          .map(function(i) { return i.type+':'+(i.id||i.name||'?'); }),
      });
    })()`);
    const d = JSON.parse(snap as string);
    console.log(`\n[DOM:${label}] ${d.url} | hash=${d.hash}`);
    if (d.svcLinks.length) console.log(`  service  : ${d.svcLinks.slice(0, 3).join(" | ")}`);
    if (d.stLinks.length)  console.log(`  selecttime (${d.stLinks.length}): ${d.stLinks.slice(0, 3).join(" | ")}`);
    if (d.inputs.length)   console.log(`  inputs   : ${d.inputs.join(", ")}`);
    if (d.btns.length)     console.log(`  btns     : ${d.btns.join(" | ")}`);
  } catch (e) { console.warn(`[DOM:${label}] error: ${e}`); }
}

// ── Trouver premier créneau libre dans les réponses datetime/ ─────────────────
interface Slot { date: string; time: string; agendaId: string }
function findFirstSlot(raws: string[]): Slot | null {
  for (const raw of raws) {
    const p = parseJsonp(raw) as any;
    if (!Array.isArray(p?.Slots)) continue;
    for (const day of p.Slots) {
      const date: string  = day.date   ?? "";
      const agId: string  = day.agenda ?? "";
      for (const [time, info] of Object.entries(day.times ?? {}) as [string, any][]) {
        if (Number(info.freeSlots ?? 0) > 0) return { date, time, agendaId: agId };
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section(`TEST E2E BROWSER SAOPOLO — ${new Date().toISOString()}`);

  // ── Prérequis ───────────────────────────────────────────────────────────────
  const ispProxy  = process.env.SPAIN_ISP_PROXY_URL ?? "";
  const login     = process.env.TEST_SPAIN_LOGIN     ?? "";
  const password  = process.env.TEST_SPAIN_PASSWORD  ?? process.env.CEV_TEST_PASSWORD ?? "";
  const isHeaded  = process.env.SPAIN_HEADED === "1";
  const slowMo    = isHeaded ? Number(process.env.SPAIN_SLOW_MO ?? "60") : 0;
  const devtools  = process.env.SPAIN_DEVTOOLS === "1";
  const execPath  = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const prefSvcId = process.env.TEST_SERVICE_ID ?? "bkt853215";

  const missing: string[] = [];
  if (!ispProxy)  missing.push("SPAIN_ISP_PROXY_URL");
  if (!login)     missing.push("TEST_SPAIN_LOGIN");
  if (!password)  missing.push("TEST_SPAIN_PASSWORD (ou CEV_TEST_PASSWORD)");
  if (missing.length > 0) {
    log("ERR", `Variables manquantes : ${missing.join(", ")}`);
    log("INFO", "Exemple :");
    log("INFO", "  SPAIN_ISP_PROXY_URL=http://user:pass@isp.decodo.com:10001 \\");
    log("INFO", "  TEST_SPAIN_LOGIN=AB123456 TEST_SPAIN_PASSWORD=secret \\");
    log("INFO", "  npx tsx src/scripts/test-saopolo-browser-e2e.ts");
    process.exit(1);
  }

  const proxyParsed = parseProxy(ispProxy);
  if (!proxyParsed) {
    log("ERR", `SPAIN_ISP_PROXY_URL invalide : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
    process.exit(1);
  }

  if (isHeaded) {
    console.log("█".repeat(72));
    console.log("█" + "  🟢  SAOPOLO E2E — NAVIGATEUR VISIBLE".padEnd(70) + "█");
    console.log("█" + `  slowMo=${slowMo}ms | devtools=${devtools ? "ON" : "OFF"}`.padEnd(70) + "█");
    console.log("█".repeat(72));
  }

  log("INFO", `Portail    : ${SAOPOLO_URL}`);
  log("INFO", `ISP proxy  : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `Login      : ${login.slice(0, 4)}${"*".repeat(Math.max(0, login.length - 4))}`);
  log("INFO", `Service ID : ${prefSvcId}`);
  log("INFO", `Mode       : ${isHeaded ? "👁️  headed" : "headless"}`);
  if (execPath) log("INFO", `execPath   : ${execPath}`);

  // ─── ÉTAPE 1 : Lancement Chromium avec ISP proxy ───────────────────────────
  section("ÉTAPE 1 — Lancement Chromium + proxy ISP");

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-webgl",
    "--window-size=1366,768",
    "--disable-v8-code-cache",
    "--disable-crash-reporter",
    "--no-first-run",
    "--no-default-browser-check",
    `--proxy-server=${proxyParsed.server}`,
  ];

  log("STEP", `puppeteer.launch() — proxy: ${proxyParsed.server}`);
  const browser: Browser = await (puppeteer as any).launch({
    headless: !isHeaded,
    args: launchArgs,
    slowMo,
    devtools,
    protocolTimeout: 180_000,
    ...(execPath ? { executablePath: execPath } : {}),
  });

  const pages = await browser.pages();
  const page: Page = pages.length > 0 ? pages[0] : await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  log("OK", "Chromium lancé");

  // ── Attacher le handler proxy auth persistent ────────────────────────────
  // solveCfChallengeWithRetry attache et détache son propre handler temporaire.
  // Ce handler-ci reste actif tout le long du test pour les XHR Bookitit.
  let proxyAuthClient: CDPSession | null = null;
  if (proxyParsed.username) {
    proxyAuthClient = await attachProxyAuth(page, proxyParsed.username, proxyParsed.password);
    log("OK", `Proxy auth CDP attaché (${proxyParsed.username.slice(0, 8)}… @ ${proxyParsed.server})`);
  } else {
    log("INFO", "Proxy sans credentials — pas de handler auth CDP");
  }

  try {
    // ─── ÉTAPE 2 : solveCfChallengeWithRetry ────────────────────────────────
    section("ÉTAPE 2 — Résolution challenge Cloudflare (cf-challenge-solver)");
    log("STEP", `solveCfChallengeWithRetry — cible: ${SAOPOLO_URL.slice(0, 60)}…`);

    const t2 = Date.now();
    const cfResult = await solveCfChallengeWithRetry(page, browser, {
      targetUrl:       SAOPOLO_URL,
      proxyUrl:        ispProxy,
      maxRetries:      4,
      timeout:         90_000,
      cacheBustCdn:    true,
      purgeStaleData:  true,
      geoTimezone:     "Europe/Madrid",
    });
    const t2s = ((Date.now() - t2) / 1_000).toFixed(1);

    if (!cfResult.success) {
      log("ERR", `Challenge CF non résolu après ${t2s}s : ${cfResult.error}`);
      log("INFO", "→ Vérifier SPAIN_ISP_PROXY_URL (accès, credentials, PoP CF Madrid)");
      process.exit(1);
    }

    log("OK", `CF résolu en ${t2s}s — stratégie: ${cfResult.solvedBy}`);
    log("INFO", `cf_clearance : ${(cfResult.cfClearance ?? "").slice(0, 35)}…`);
    log("INFO", `cookies      : ${(cfResult.allCookies ?? []).map((c: any) => c.name).join(", ")}`);

    // Re-attacher proxy auth si nécessaire (solveCfChallengeWithRetry détache son propre handler)
    // Notre proxyAuthClient créé à l'étape 1 est toujours actif — pas besoin de recréer.

    await domSnap(page, "après-CF-solve");

    // ─── ÉTAPE 3 : RUM gate + clic Continuar ────────────────────────────────
    section("ÉTAPE 3 — RUM gate + clic Continuar");

    // Écouter le POST /cdn-cgi/rum? (signal LCP) via CDP Network
    // Le widget n'accepte les XHR /main/ qu'après que le navigateur ait émis ce beacon.
    const rumSignal = new Promise<void>((resolve) => {
      let resolved = false;
      const cdpNet = page.createCDPSession().then((client) => {
        client.send("Network.enable", {}).catch(() => {});
        client.on("Network.requestWillBeSent", (ev: any) => {
          const url: string = ev.request?.url ?? "";
          const method: string = ev.request?.method ?? "";
          if (!resolved && method === "POST" && url.includes("/cdn-cgi/rum")) {
            resolved = true;
            log("OK", `📊 RUM POST détecté (${url.slice(0, 60)}) — Continuar autorisé`);
            resolve();
            client.detach().catch(() => {});
          }
        });
        return client;
      }).catch(() => null);
      // Timeout 8s — si pas de RUM, on continue quand même
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          log("WARN", "RUM timeout 8s — continue sans attendre le beacon");
          resolve();
          cdpNet.then((c) => c?.detach().catch(() => {}));
        }
      }, 8_000);
    });

    await rumSignal;

    // Préparer la capture de /main/ AVANT le clic pour ne pas rater la réponse
    const mainCapture = captureResponse(page, "/main/", 20_000);

    // Clic Continuar : #idCaptchaButton en priorité, puis token-form, puis texte
    const continuarResult = await page.evaluate(`(function() {
      function visible(el) { return el && el.offsetParent !== null; }

      // 1) Bouton Bookitit standard "Continue / Continuar"
      var captchaBtn = document.getElementById('idCaptchaButton');
      if (visible(captchaBtn)) { captchaBtn.click(); return 'idCaptchaButton'; }

      // 2) Token form (JSD Turnstile caché)
      var tokenForm = Array.from(document.forms).find(function(f) {
        return f.querySelector('input[name="token"]') &&
          (f.action.includes('widgetdefault') || f.action.includes('hosteds') ||
           /continue|continuar/.test((f.innerText||'').toLowerCase()));
      });
      if (tokenForm) {
        var submitBtn = tokenForm.querySelector('button, input[type="submit"]');
        if (submitBtn) { submitBtn.click(); return 'token-form:submit'; }
        // Soumettre le form directement
        var payload = new URLSearchParams();
        new FormData(tokenForm).forEach(function(v, k) { if (typeof v === 'string') payload.append(k, v); });
        fetch(tokenForm.action || window.location.href, {
          method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: payload.toString(), credentials: 'include', redirect: 'manual'
        }).catch(function(){});
        return 'token-form:fetch';
      }

      // 3) Tout bouton/lien avec texte continuar/accept/ok visible
      var all = Array.from(document.querySelectorAll('button,a,[role="button"],input[type="submit"]'));
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!visible(el)) continue;
        var txt = (el.textContent || el.value || '').trim().toLowerCase();
        if (/^(continuar|continue|aceptar|accept|ok|siguiente)$/.test(txt)) {
          el.click(); return 'text:' + txt;
        }
      }
      return 'no_continue_btn';
    })()`).catch(() => "evaluate_error") as string;

    log(continuarResult.startsWith("no_") || continuarResult === "evaluate_error" ? "WARN" : "OK",
      `Clic Continuar → ${continuarResult}`);

    // ── Attendre /main/ ──────────────────────────────────────────────────────
    section("ÉTAPE 3b — Attente /main/ JSONP");
    const mainRaw = await mainCapture;
    log("INFO", `/main/ reçu : ${mainRaw.length}B`);

    if (mainRaw.length === 0) {
      log("ERR", "/main/ → 0B — le proxy ISP ne route pas via le bon PoP CF");
      log("WARN", "→ La nonce JSD est probablement stale (SJC PoP). Vérifier SPAIN_ISP_PROXY_URL.");
      log("WARN", "→ La session CF cf_clearance est bien obtenue mais /main/ refuse quand même.");
      await domSnap(page, "main-0B");
      process.exit(1);
    }

    const mainParsed = parseJsonp(mainRaw) as any;

    // "No hay horas" = aucun créneau
    const noHoras = typeof mainRaw === "string" && /no hay horas/i.test(mainRaw);
    if (noHoras) {
      log("INFO", '/main/ → "No hay horas disponibles" — pas de créneau pour le moment');
      log("INFO", "→ Saopolo est vide. Relancer plus tard. ISP proxy fonctionne ✓");
      process.exit(0);
    }

    log("OK", `/main/ reçu avec contenu (${mainRaw.length}B) — créneaux probables ✓`);
    if (mainParsed) {
      log("INFO", `/main/ clés : ${Object.keys(mainParsed).join(", ")}`);
    }

    await domSnap(page, "après-main");

    // ─── ÉTAPE 4 : Clic Aceptar ─────────────────────────────────────────────
    section("ÉTAPE 4 — Clic Aceptar (dialogue de confirmation de créneaux)");

    // Petite pause pour que Backbone rende le bouton Aceptar
    await new Promise<void>((r) => setTimeout(r, 1_500));

    const aceptarResult = await page.evaluate(`(function() {
      function visible(el) { return el && el.offsetParent !== null; }
      var all = Array.from(document.querySelectorAll('button,a,[role="button"]'));
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!visible(el)) continue;
        var txt = (el.textContent || '').trim();
        if (/^aceptar$/i.test(txt)) { el.click(); return 'aceptar:' + txt; }
      }
      // Fallback : tout bouton contenant "aceptar"
      for (var j = 0; j < all.length; j++) {
        var el2 = all[j];
        if (!visible(el2)) continue;
        var txt2 = (el2.textContent || '').trim().toLowerCase();
        if (txt2.includes('aceptar') || txt2.includes('acceptar')) {
          el2.click(); return 'aceptar-partial:' + txt2.slice(0,30);
        }
      }
      return 'no_aceptar_btn';
    })()`).catch(() => "evaluate_error") as string;

    log(aceptarResult.startsWith("no_") ? "WARN" : "OK", `Clic Aceptar → ${aceptarResult}`);
    if (aceptarResult.startsWith("no_")) {
      log("INFO", "→ Pas de bouton Aceptar visible (normal si /main/ envoie direct aux services)");
    }

    await new Promise<void>((r) => setTimeout(r, 1_000));
    await domSnap(page, "après-aceptar");

    // ─── ÉTAPE 5 : Clic service + capture getagendas/ + datetime/ ────────────
    section("ÉTAPE 5 — Clic service + capture agendas + créneaux");

    // Préparer captures réseau avant le clic
    const agCapture  = captureResponse(page, "/getagendas/",  12_000);
    const dt1Capture = captureResponse(page, "/datetime/",    12_000);

    log("STEP", `Clic lien service (prefId=${prefSvcId})…`);
    const clickedService = await page.evaluate((prefId: string) => {
      function visible(el: Element): boolean { return (el as HTMLElement).offsetParent !== null; }
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="#selectservice/"]'))
        .filter(visible);
      const target = links.find((a) => (a.getAttribute("href") ?? "").includes(prefId))
                  ?? links.find(() => true);
      if (!target) return null;
      target.click();
      return target.getAttribute("href") ?? null;
    }, prefSvcId).catch(() => null) as string | null;

    if (!clickedService) {
      log("ERR", "Aucun lien #selectservice/ visible dans le DOM");
      await domSnap(page, "no-service-links");
      process.exit(1);
    }
    log("OK", `Service cliqué : ${clickedService}`);

    // Attendre getagendas/
    const agRaw = await agCapture;
    log("INFO", `getagendas/ → ${agRaw.length}B`);

    if (agRaw.length === 0) {
      log("ERR", "getagendas/ → 0B — widget redirigé sur #services (PHPSESSID invalide ?)");
      await domSnap(page, "getagendas-vide");
      process.exit(1);
    }

    const agParsed = parseJsonp(agRaw) as any;
    const agendas: Array<{ idAgenda: string; agendaName?: string }> = agParsed?.agendas ?? [];
    log("INFO", `Agendas : ${agendas.map((a) => `${a.idAgenda}(${a.agendaName ?? "?"})`) .join(", ")}`);

    // Attendre premier datetime/
    const dt1Raw = await dt1Capture;
    log("INFO", `datetime/[0] → ${dt1Raw.length}B`);

    // Collecter d'autres datetime/ qui arrivent dans les 5s (mois suivants)
    const dtRaws: string[] = dt1Raw.length > 0 ? [dt1Raw] : [];
    {
      const extra = await Promise.all([1, 2].map(() => captureResponse(page, "/datetime/", 5_000)));
      for (const r of extra) { if (r.length > 0) dtRaws.push(r); }
    }
    log("INFO", `datetime/ capturés : ${dtRaws.length} mois (${dtRaws.map((r) => r.length + "B").join(", ")})`);

    await domSnap(page, "après-service");

    // ─── ÉTAPE 6 : Trouver le créneau cible ─────────────────────────────────
    section("ÉTAPE 6 — Sélection créneau");

    let targetSlot: Slot | null = null;
    const envDate = process.env.TEST_TARGET_DATE;
    const envTime = process.env.TEST_TARGET_TIME;
    const envAg   = process.env.TEST_AGENDA_ID ?? agendas[0]?.idAgenda ?? "";

    if (envDate && envTime) {
      log("INFO", `Créneau forcé par env : ${envDate} ${envTime} (agenda=${envAg})`);
      targetSlot = { date: envDate, time: envTime, agendaId: envAg };
    } else {
      targetSlot = findFirstSlot(dtRaws);
    }

    if (!targetSlot) {
      log("WARN", "Aucun créneau libre détecté dans les datetime/ reçus");
      for (let i = 0; i < dtRaws.length; i++) {
        const p = parseJsonp(dtRaws[i]) as any;
        const slots = p?.Slots ?? [];
        log("INFO", `  datetime/[${i}] → ${slots.length} jour(s)`);
        for (const s of (slots as any[]).slice(0, 3)) {
          log("INFO", `    📅 ${s.date} | times: ${Object.keys(s.times ?? {}).join(", ")}`);
        }
      }
      log("INFO", "→ Forcer avec TEST_TARGET_DATE / TEST_TARGET_TIME / TEST_AGENDA_ID");
      process.exit(0); // pas d'erreur — pas de créneau en ce moment
    }

    log("OK", `Créneau cible : ${targetSlot.date} ${targetSlot.time} (agenda=${targetSlot.agendaId})`);

    // ─── ÉTAPE 7 : Navigation hash Backbone vers le formulaire signin ─────────
    section("ÉTAPE 7 — Navigation hash Backbone (#selectservice → #selecttime → #signin)");

    const agendaId  = targetSlot.agendaId || agendas[0]?.idAgenda || envAg;
    const serviceId = prefSvcId;

    // #selectservice/{id}
    log("STEP", `hash → #selectservice/${serviceId}`);
    await page.evaluate((id: string) => { window.location.hash = "#selectservice/" + id; }, serviceId).catch(() => {});
    const afterSvc = await waitForHash(page, ["#agendas", "#datetime", "#selectagenda"], 7_000);
    log("INFO", `hash après #selectservice : ${afterSvc}`);

    // #selectagenda/{id} si on est sur #agendas
    if (agendaId && (afterSvc === "#agendas" || afterSvc.includes("#selectagenda"))) {
      log("STEP", `hash → #selectagenda/${agendaId}`);
      await page.evaluate((id: string) => { window.location.hash = "#selectagenda/" + id; }, agendaId).catch(() => {});
      const afterAg = await waitForHash(page, ["#datetime"], 7_000);
      log("INFO", `hash après #selectagenda : ${afterAg}`);
    }

    // #selecttime/{date}/{time}/{agendaId}
    const hashTarget = `#selecttime/${encodeURIComponent(targetSlot.date)}/${encodeURIComponent(targetSlot.time)}${agendaId ? "/" + encodeURIComponent(agendaId) : ""}`;
    log("STEP", `hash → ${hashTarget}`);
    await page.evaluate((h: string) => { window.location.hash = h; }, hashTarget).catch(() => {});

    const authHash = await waitForHash(page, ["#signin", "#signup", "#signupsecond", "#signupfirst", "#confirm"], 10_000);
    await new Promise<void>((r) => setTimeout(r, 700)); // Backbone render async

    log(authHash.includes("signin") || authHash.includes("signup") || authHash.includes("confirm") ? "OK" : "WARN",
      `hash après #selecttime : ${authHash || "(inchangé)"}`);

    await domSnap(page, "formulaire-signin");

    // ─── ÉTAPE 8 : Attendre champ login visible ──────────────────────────────
    section("ÉTAPE 8 — Formulaire signin visible");

    const loginSel = '#idBktSigninLogin, #idBktLogin, [name="login"], input[type="text"], input[type="email"]';
    let formVisible = false;
    try {
      await page.waitForSelector(loginSel, { visible: true, timeout: 14_000 });
      formVisible = true;
      log("OK", "Champ login visible dans le DOM ✓");
    } catch {
      log("WARN", "Champ login non visible après 14s — soumission tentée quand même");
    }

    if (!formVisible) await domSnap(page, "login-absent");

    // ─── ÉTAPE 9 : Soumettre le formulaire ──────────────────────────────────
    section("ÉTAPE 9 — Soumission formulaire (credentials)");
    log("WARN", "⚠️  Ce script peut créer une vraie réservation — annuler manuellement si nécessaire");

    const signinPromise  = captureResponse(page, "/signin/",  20_000);
    const summaryPromise = captureResponse(page, "/summary/", 35_000);

    // Préparer la capture AVANT le clic submit
    const fillResult = await page.evaluate(`(function(login, password) {
      function findField(selectors) {
        for (var i = 0; i < selectors.length; i++) {
          var els = document.querySelectorAll(selectors[i]);
          for (var j = 0; j < els.length; j++) {
            if (els[j].offsetParent !== null) return els[j];
          }
        }
        return null;
      }
      var loginFld = findField(['#idBktSigninLogin','#idBktLogin','[name="login"]','[id*="Login"],[id*="login"]','input[type="text"]','input:not([type="password"]):not([type="hidden"])']);
      var passFld  = findField(['#idBktSigninPassword','#idBktPassword','[name="password"]','[id*="Password"],[id*="password"]','input[type="password"]']);
      var submitBtn = findField(['#idBktDefaultSignInConfirmButton','#idBktSignInsubmit','#idBktSigninButton','#idBktSignInButton','.clsDivContinueButton','.clsBktSigninSubmit','[id*="ConfirmButton"],[id*="Confirm"],[id*="SigninButton"],[id*="SignInButton"],[id*="SigninSubmit"],[id*="SignInsubmit"],[id*="Submit"],[id*="submit"]','button[type="submit"]','input[type="submit"]','a.clsBktButton','.clsBktButton','button','a[href="#"]']);

      if (!loginFld) return 'no_login_field';
      if (!passFld)  return 'no_password_field';

      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      function setVal(el, val) {
        if (nativeSetter) nativeSetter.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      setVal(loginFld, login);
      setVal(passFld, password);

      if (!submitBtn) return 'no_submit_btn (login=' + (loginFld.id||loginFld.name) + ')';
      submitBtn.click();
      return 'submitted: login=' + (loginFld.id||loginFld.name) + ' pass=' + (passFld.id||passFld.name) + ' btn=' + (submitBtn.id||submitBtn.className||'?').slice(0,30);
    })(${JSON.stringify(login)}, ${JSON.stringify(password)})`).catch(() => "evaluate_error") as string;

    log(fillResult.startsWith("submitted") ? "OK" : "ERR", `Formulaire : ${fillResult}`);

    if (!fillResult.startsWith("submitted")) {
      log("ERR", "Formulaire non soumis — vérifier les sélecteurs et l'état du DOM");
      await domSnap(page, "submit-failed");
      process.exit(1);
    }

    // ─── ÉTAPE 10 : Analyse signin/ + summary/ ───────────────────────────────
    section("ÉTAPE 10 — Analyse réponses signin/ + summary/");

    const t10 = Date.now();
    const signinBody  = await signinPromise;
    log("INFO", `signin/ → ${signinBody.length}B (${((Date.now() - t10) / 1000).toFixed(1)}s)`);

    if (!signinBody) {
      log("ERR", "signin/ vide — aucune réponse HTTP reçue");
      process.exit(1);
    }

    const signinP     = parseJsonp(signinBody) as any;
    const bktToken    = signinP?.bktToken ?? signinP?.token ?? "";
    const signinError = signinP?.error ?? signinP?.Error ?? signinP?.message ?? "";

    log("INFO", `signin/ extrait : ${signinBody.slice(0, 250)}`);

    if (bktToken) {
      log("OK", `bktToken reçu → credentials acceptés ✓ (${String(bktToken).slice(0, 25)}…)`);
    } else if (signinError) {
      log("WARN", `Erreur credentials : ${signinError}`);
      log("INFO", "→ TEST_SPAIN_LOGIN / TEST_SPAIN_PASSWORD invalides pour ce portail");
      process.exit(1);
    } else {
      log("WARN", `signin/ réponse inattendue : ${signinBody.slice(0, 200)}`);
    }

    const summaryBody = await summaryPromise;
    log("INFO", `summary/ → ${summaryBody.length}B`);

    if (summaryBody) {
      log("INFO", `summary/ extrait : ${summaryBody.slice(0, 350)}`);
      const sumP  = parseJsonp(summaryBody) as any;
      const confId = sumP?.appointmentId ?? sumP?.id ?? sumP?.appointment_id ?? sumP?.confirmationCode ?? "";
      const confDate = sumP?.date ?? sumP?.appointmentDate ?? sumP?.selectedDate ?? "";
      const confTime = sumP?.time ?? sumP?.appointmentTime ?? sumP?.selectedTime ?? "";

      if (confId || confDate) {
        log("OK", "🎉🎉🎉 RÉSERVATION CONFIRMÉE !");
        if (confId)   log("OK", `ID confirmation : ${confId}`);
        if (confDate) log("OK", `Date / heure    : ${confDate} ${confTime}`);
      } else {
        log("INFO", "summary/ reçu mais champs de confirmation non identifiés");
        log("INFO", "→ La réservation a peut-être abouti. Vérifier sur citaconsular.es.");
      }
    } else {
      log("WARN", "summary/ non reçu dans les 35s");
      log("INFO", "→ Vérifier le DOM final — il peut contenir la confirmation");
    }

    // ─── Snapshot DOM final ──────────────────────────────────────────────────
    section("SNAPSHOT DOM FINAL");
    await domSnap(page, "final");
    const finalText = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 500)).catch(() => "");
    log("INFO", `Texte DOM :\n${finalText.replace(/\s+/g, " ")}`);

    // ─── Résumé ──────────────────────────────────────────────────────────────
    section("RÉSUMÉ");
    log("INFO", `Portail    : ${SAOPOLO_URL}`);
    log("INFO", `ISP proxy  : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
    log("INFO", `Créneau    : ${targetSlot.date} ${targetSlot.time} (agenda=${targetSlot.agendaId})`);
    log("INFO", `signin/    : ${signinBody.length}B | summary/ : ${summaryBody.length}B`);
    if (summaryBody.length > 0) log("OK", "✅ Flow E2E complet — signin + summary reçus");
    else if (bktToken)          log("OK", "✅ Flow signin OK — summary non intercepté (vérifier DOM)");
    else                        log("WARN", "Flow partiel");

    if (isHeaded) {
      log("INFO", "Mode headed — fermeture navigateur dans 8s…");
      await new Promise<void>((r) => setTimeout(r, 8_000));
    }

  } finally {
    if (proxyAuthClient) await proxyAuthClient.detach().catch(() => {});
    await browser.close().catch(() => {});
    log("INFO", "Chromium fermé.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
