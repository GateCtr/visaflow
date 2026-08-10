#!/usr/bin/env node
/**
 * Version rapide : CapSolver pré-résout CF, Puppeteer via même proxy Decodo.
 * waitUntil: 'commit' pour ne pas bloquer sur CF challenge + injection cookie + reload.
 */
import "dotenv/config";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { Impit } from "impit";

const PROXY_URL   = process.env.SOAX_PROXY_URL ?? "";
const CAP_KEY     = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE    = "https://api.capsolver.com";
const PORTAL_URL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID         = "2d01502f12dc08400e22aea87fb00ae34";
const CHROME_PATH = "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";
const UA          = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function parseProxy(url: string) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { server: `${u.hostname}:${u.port}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  } catch { return null; }
}

async function solveCF(html: string): Promise<string | null> {
  const proxy = parseProxy(PROXY_URL);
  if (!proxy) return null;
  const proxyStr = `http://${proxy.username}:${proxy.password}@${proxy.server}`;
  const cr = await (await fetch(`${CAP_BASE}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAP_KEY, task: { type: "AntiCloudflareTask", websiteURL: PORTAL_URL, proxy: proxyStr, userAgent: UA, html: html.slice(0, 32_000) }}),
    signal: AbortSignal.timeout(30_000),
  })).json() as any;
  if (cr.errorId !== 0) { console.error(`CapSolver err: ${cr.errorDescription}`); return null; }
  console.log(`  CapSolver task: ${cr.taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAP_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAP_KEY, taskId: cr.taskId }),
      signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`CapSolver poll err: ${pr.errorCode}`); return null; }
    if (pr.status === "ready") return pr.solution?.cookies?.["cf_clearance"] ?? null;
    process.stdout.write(".");
  }
  return null;
}

async function waitTitle(page: Page, maxMs = 180_000, breakIf?: (t: string) => boolean): Promise<string> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const t = await (page as any).title().catch(() => "");
    if (breakIf && breakIf(t)) return t;
    process.stdout.write(`\r  [${Math.round((deadline - Date.now()) / 1000)}s rem] "${t.slice(0, 50)}"   `);
    await new Promise(r => setTimeout(r, 2_000));
  }
  return await (page as any).title().catch(() => "");
}

async function main() {
  const proxy = parseProxy(PROXY_URL);
  console.log(`Proxy: ${proxy?.server ?? "none"}`);

  // ─── 1. Probe + CapSolver (parallèle avec lancement browser) ─────────────
  console.log("\n[1] Probe CF + CapSolver solve (parallèle avec browser launch)…");
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any) as any;

  // Lance les deux en parallèle
  const [probeResp, browser] = await Promise.all([
    (async () => {
      const r = await imp.fetch(PORTAL_URL, { headers: {
        "User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
      }}) as any;
      const html = await r.text() as string;
      console.log(`  Probe: HTTP ${r.status} | ${html.length}B`);
      return html;
    })(),
    (puppeteer as any).launch({
      headless: true,
      executablePath: CHROME_PATH,
      args: [
        "--no-sandbox", "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
        "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
        "--disable-crash-reporter", "--no-first-run",
        `--user-agent=${UA}`,
        ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
      ],
      protocolTimeout: 120_000,
    }) as Promise<Browser>,
  ]);

  console.log("  Browser lancé ✅");
  const cfPromise = solveCF(probeResp);

  const page: Page = await browser.newPage();
  await (page as any).setUserAgent(UA);
  await (page as any).setViewport({ width: 1280, height: 800 });

  // ─── CDP : proxy auth + Network intercept ────────────────────────────────
  const client = await (page as any).createCDPSession();
  await client.send("Network.enable");
  await client.send("Fetch.enable", { handleAuthRequests: true });

  const mainInterceptions: any[] = [];

  client.on("Fetch.authRequired", async (ev: any) => {
    if (ev.authChallenge?.source === "Proxy" && proxy) {
      await client.send("Fetch.continueWithAuth", {
        requestId: ev.requestId,
        authChallengeResponse: { response: "ProvideCredentials", username: proxy.username, password: proxy.password },
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

  client.on("Network.requestWillBeSent", (ev: any) => {
    const url: string = ev.request?.url ?? "";
    if (url.includes("/onlinebookings/main/")) {
      console.log(`\n🔍 REQUÊTE /main/ envoyée`);
      console.log(`  URL: ${url.slice(0, 300)}`);
      const hdrs = ev.request?.headers ?? {};
      for (const [k, v] of Object.entries(hdrs)) {
        console.log(`  [${k}]: ${String(v).slice(0, 150)}`);
      }
    }
  });

  client.on("Network.responseReceived", async (ev: any) => {
    const url: string = ev.response?.url ?? "";
    if (!url.includes("/onlinebookings/")) return;
    const endpoint = url.match(/\/onlinebookings\/([^?]+)/)?.[1] ?? "?";
    setTimeout(async () => {
      try {
        const b = await client.send("Network.getResponseBody", { requestId: ev.requestId });
        const body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
        const ct = ev.response?.headers?.["content-type"] ?? "";
        const mark = body.length > 200 && !/Exception/.test(body) ? "🎉" : body.length === 0 ? "0️⃣ " : "⚠️ ";
        console.log(`\n  ${mark} [${endpoint}] HTTP ${ev.response?.status} | ${body.length}B | ${ct.slice(0,40)}`);
        if (body.length > 0 && body.length < 3000) console.log(`     "${body.slice(0, 800)}"`);
        if (endpoint.startsWith("main/")) mainInterceptions.push({ url, status: ev.response?.status, len: body.length, body: body.slice(0, 5000) });
      } catch { /* body not available yet — ignore */ }
    }, 1_500);
  });

  // ─── 2. Navigation sans attendre resolution CF ───────────────────────────
  // On utilise load avec timeout long; CF prend ~130s via JSD oneshot avec proxy.
  console.log("\n[2] Navigation portail (timeout=180s, CF se résout via JSD)…");
  await (page as any).goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 180_000 }).catch(() => {});
  console.log(`  Navigation lancée: "${await (page as any).title().catch(() => "")}"`);

  // ─── 3. Attendre CapSolver, puis injecter cf_clearance + reload ──────────
  console.log("\n[3] Attente cf_clearance CapSolver…");
  const cfClearance = await cfPromise;
  if (!cfClearance) { console.error("❌ CapSolver failed"); await browser.close(); process.exit(1); }
  console.log(`  cf_clearance: ${cfClearance.slice(0, 50)}…`);

  // Injecter le cookie (la page a maintenant chargé au moins partiellement)
  await (page as any).setCookie({
    name: "cf_clearance", value: cfClearance,
    domain: ".citaconsular.es", path: "/", httpOnly: true, secure: true, sameSite: "None",
  });
  console.log("  Cookie injecté → reload…");

  await (page as any).reload({ waitUntil: "commit", timeout: 30_000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 3_000));
  let title = await (page as any).title().catch(() => "");
  console.log(`  Après reload: "${title}"`);

  // Si CF encore présent, attendre résolution naturelle (max 120s)
  if (/just a moment|un instant|momento/i.test(title)) {
    console.log("  CF pas encore bypassé, attente naturelle (max 120s)…");
    title = await waitTitle(page, 120_000, t => !/just a moment|un instant|momento/i.test(t));
    console.log(`\n  Titre final: "${title}"`);
  }

  if (/just a moment|un instant|momento/i.test(title)) {
    console.log("❌ CF non résolu après 120s");
    await browser.close();
    process.exit(1);
  }
  console.log("✅ CF résolu!");

  // ─── 4. Token CSRF + Cookies ─────────────────────────────────────────────
  const cookies = await (page as any).cookies().catch(() => []) as any[];
  const php = cookies.find((c: any) => c.name === "PHPSESSID");
  const cf2 = cookies.find((c: any) => c.name === "cf_clearance");
  console.log(`\nPHPSESSID: ${php?.value ?? "ABSENT"}`);
  console.log(`cf_clearance: ${cf2?.value?.slice(0, 40) ?? "ABSENT"}…`);

  let token: string | null = null;
  for (let i = 0; i < 10; i++) {
    token = await (page as any).evaluate(() => {
      const inp = document.querySelector<HTMLInputElement>("input[name='token']");
      return inp?.value ?? null;
    }).catch(() => null);
    if (token) break;
    await new Promise(r => setTimeout(r, 1_000));
  }
  console.log(`Token CSRF: ${token ? token.slice(0, 20) + "…" : "NON TROUVÉ"}`);

  // ─── 5. Soumettre formulaire ──────────────────────────────────────────────
  if (token) {
    console.log("\n[4] Soumission Continuar…");
    await (page as any).evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button[type='submit'], input[type='submit'], button");
      if (btn) btn.click(); else document.querySelector<HTMLFormElement>("form")?.submit();
    }).catch(() => {});

    // Attendre widget
    let widgetOk = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 1_500));
      widgetOk = await (page as any).evaluate(() => typeof (window as any).bkt_init_widget !== "undefined").catch(() => false);
      if (widgetOk) break;
      const t = await (page as any).title().catch(() => "");
      process.stdout.write(`\r  [${i * 1.5}s] widget=${widgetOk} title="${t.slice(0,25)}"   `);
    }
    console.log(`\nbkt_init_widget: ${widgetOk ? "✅" : "❌"}`);

    if (widgetOk) {
      const wd = await (page as any).evaluate(() => JSON.stringify((window as any).bkt_init_widget)).catch(() => "null");
      console.log(`data: ${wd?.slice(0, 300) ?? "null"}`);
    }
  }

  // ─── 6. Attendre /main/ automatique ──────────────────────────────────────
  console.log("\n[5] Attente /main/ automatique (10s)…");
  await new Promise(r => setTimeout(r, 10_000));

  // ─── 7. Appel manuel /main/ depuis browser ────────────────────────────────
  console.log("\n[6] Appel JSONP /main/ via script tag depuis browser…");
  const portalClean = PORTAL_URL.replace(/#.*$/, "");
  const jsonpResult = await (page as any).evaluate(async (portal: string, wid: string) => {
    return new Promise<any>((resolve) => {
      const cbName = "jQuery21109" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
      const params = new URLSearchParams({ callback: cbName, type: "default", publickey: wid, lang: "es", version: "4", src: portal, _: String(Date.now()) });
      const url = `https://www.citaconsular.es/onlinebookings/main/?${params}`;
      const timer = setTimeout(() => resolve({ timeout: true }), 25_000);
      (window as any)[cbName] = (data: any) => {
        clearTimeout(timer);
        delete (window as any)[cbName];
        resolve({ ok: true, keys: Object.keys(data || {}), snippet: JSON.stringify(data).slice(0, 3000) });
      };
      if (typeof (window as any).callback === "undefined") (window as any).callback = null;
      const sc = document.createElement("script");
      sc.onerror = () => { clearTimeout(timer); resolve({ scriptError: true }); };
      sc.src = url;
      document.head.appendChild(sc);
    });
  }, portalClean, WID).catch((e: unknown) => ({ error: String(e) }));

  console.log("  JSONP result: " + JSON.stringify(jsonpResult).slice(0, 2000));

  // ─── 8. Fetch depuis browser ──────────────────────────────────────────────
  console.log("\n[7] Fetch /main/ avec credentials=include depuis browser…");
  const fetchResult = await (page as any).evaluate(async (portal: string, wid: string) => {
    const cb = "jQuery21109" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
    const params = new URLSearchParams({ callback: cb, type: "default", publickey: wid, lang: "es", version: "4", src: portal, _: String(Date.now()) });
    const url = `https://www.citaconsular.es/onlinebookings/main/?${params}`;
    const cookies = document.cookie;
    try {
      const r = await fetch(url, { credentials: "include", headers: { "Accept": "*/*", "Referer": portal } });
      const b = await r.text();
      return { status: r.status, len: b.length, body: b.slice(0, 1000), ct: r.headers.get("content-type"), cookies: cookies.slice(0, 300) };
    } catch(e) { return { error: String(e) }; }
  }, portalClean, WID).catch((e: unknown) => ({ error: String(e) }));

  console.log("  Fetch result: " + JSON.stringify(fetchResult).slice(0, 1000));

  // Attendre les intercepteurs CDP
  await new Promise(r => setTimeout(r, 5_000));

  console.log("\n══════════ RÉSUMÉ ══════════");
  console.log(`/main/ interceptés: ${mainInterceptions.length}`);
  for (const m of mainInterceptions) {
    console.log(`  ${m.status} | ${m.len}B → "${m.body?.slice(0,200)}"`);
  }

  await browser.close();
  console.log("Done.");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
