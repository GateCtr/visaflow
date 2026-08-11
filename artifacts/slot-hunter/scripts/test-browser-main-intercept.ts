#!/usr/bin/env node
/**
 * Utilise SpainPersistentBrowser (proxy + JSD + CF solve complet)
 * pour charger le portail Saopolo et intercepter la vraie requête /main/.
 *
 * Deux objectifs :
 *   1. Voir EXACTEMENT quels headers le browser envoie à /main/
 *   2. Voir EXACTEMENT quelle réponse le serveur retourne
 *
 * Usage :
 *   SOAX_PROXY_URL=... CAPSOLVER_API_KEY=... node_modules/.bin/tsx scripts/test-browser-main-intercept.ts
 */
import "dotenv/config";
import puppeteer, { type Browser, type Page } from "puppeteer";

// ─── Config ────────────────────────────────────────────────────────────────────
const PROXY_URL   = process.env.SOAX_PROXY_URL ?? "";
const PORTAL_URL  = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const CHROME_PATH = "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";

// ─── Proxy helpers ────────────────────────────────────────────────────────────
function parseProxy(url: string): { server: string; username: string; password: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return {
      server:   `${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  } catch { return null; }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const proxy = parseProxy(PROXY_URL);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  console.log(`Proxy : ${proxy ? proxy.server : "DIRECT (no proxy)"}`);
  console.log(`Chrome: ${CHROME_PATH}`);

  const args = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--use-gl=angle", "--use-angle=swiftshader-webgl", "--enable-webgl",
    "--disable-crash-reporter",
    "--no-first-run", "--no-default-browser-check",
    `--user-agent=${UA}`,
    ...(proxy ? [`--proxy-server=${proxy.server}`] : []),
  ];

  const browser: Browser = await (puppeteer as any).launch({
    headless: true,
    executablePath: CHROME_PATH,
    args,
    protocolTimeout: 120_000,
  });

  const page: Page = await browser.newPage();
  await (page as any).setUserAgent(UA);
  await (page as any).setViewport({ width: 1280, height: 800 });

  // ─── CDP proxy auth + intercept /main/ ─────────────────────────────────────
  const client = await (page as any).createCDPSession();

  // Activer Network pour capturer les headers de requête/réponse
  await client.send("Network.enable");
  await client.send("Fetch.enable", { handleAuthRequests: true });

  const mainRequests: any[] = [];
  const mainResponses: any[] = [];

  client.on("Fetch.authRequired", async (ev: any) => {
    if (ev.authChallenge?.source === "Proxy" && proxy) {
      await client.send("Fetch.continueWithAuth", {
        requestId: ev.requestId,
        authChallengeResponse: {
          response: "ProvideCredentials",
          username: proxy.username,
          password: proxy.password,
        },
      }).catch(() => {});
    } else {
      await client.send("Fetch.continueWithAuth", {
        requestId: ev.requestId,
        authChallengeResponse: { response: "Default" },
      }).catch(() => {});
    }
  });

  client.on("Fetch.requestPaused", async (ev: any) => {
    const url: string = ev.request?.url ?? "";
    if (url.includes("/onlinebookings/main/")) {
      mainRequests.push({
        url,
        method: ev.request?.method,
        headers: ev.request?.headers,
        postData: ev.request?.postData,
      });
      console.log(`\n🔍 REQUÊTE /main/ INTERCEPTÉE`);
      console.log(`  URL: ${url.slice(0, 300)}`);
      console.log(`  Method: ${ev.request?.method}`);
      const hdrs = ev.request?.headers ?? {};
      for (const [k, v] of Object.entries(hdrs)) {
        console.log(`  Header [${k}]: ${String(v).slice(0, 200)}`);
      }
    }
    await client.send("Fetch.continueRequest", { requestId: ev.requestId }).catch(() => {});
  });

  client.on("Network.responseReceived", async (ev: any) => {
    const url: string = ev.response?.url ?? "";
    if (url.includes("/onlinebookings/main/")) {
      const resp = ev.response;
      mainResponses.push({
        url,
        status: resp?.status,
        headers: resp?.headers,
        requestId: ev.requestId,
      });
      console.log(`\n✅ RÉPONSE /main/ REÇUE`);
      console.log(`  Status: ${resp?.status}`);
      console.log(`  Content-Type: ${resp?.headers?.["content-type"] ?? "(none)"}`);
      console.log(`  Content-Length: ${resp?.headers?.["content-length"] ?? "(none)"}`);
      console.log(`  Content-Encoding: ${resp?.headers?.["content-encoding"] ?? "(none)"}`);
      // Récupérer le body via CDP
      setTimeout(async () => {
        try {
          const body = await client.send("Network.getResponseBody", { requestId: ev.requestId });
          const decoded = body.base64Encoded
            ? Buffer.from(body.body, "base64").toString("utf8")
            : body.body;
          console.log(`  Body (${decoded.length}B): "${decoded.slice(0, 1000)}"`);
        } catch (e) {
          console.log(`  Body: (erreur CDP getResponseBody: ${e})`);
        }
      }, 500);
    }
  });

  // ─── Navigation ────────────────────────────────────────────────────────────
  console.log(`\nNavigation vers ${PORTAL_URL}`);
  console.log("(CF challenge va apparaître — attente résolution automatique par JSD…)");

  let resolved = false;
  const maxWait = 180_000; // 3 min pour CF
  const start = Date.now();

  // Première navigation
  await (page as any).goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});

  while (Date.now() - start < maxWait) {
    const title = await (page as any).title().catch(() => "");
    const url = (page as any).url();
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${elapsed}s] Title: "${title.slice(0, 40)}" URL: ${url.slice(0, 50)}`);

    // Vérifier si on est passé le CF challenge
    const isCF = /just a moment|un instant|un momento|moment/i.test(title);
    if (!isCF) {
      resolved = true;
      break;
    }
    await new Promise(r => setTimeout(r, 2_000));
  }

  console.log(`\n  Résultat CF: ${resolved ? "✅ résolu" : "❌ timeout"}`);

  if (!resolved) {
    const content = await (page as any).content().catch(() => "");
    console.log(`  Page (500c): ${content.slice(0, 500)}`);
    await browser.close();
    process.exit(1);
  }

  // ─── Attendre le formulaire + POST Continuar ────────────────────────────────
  const title2 = await (page as any).title().catch(() => "");
  console.log(`\nPage après CF: "${title2}"`);

  // Chercher le token CSRF
  let token: string | null = null;
  for (let i = 0; i < 10; i++) {
    token = await (page as any).evaluate(() => {
      const inp = document.querySelector<HTMLInputElement>("input[name='token']");
      return inp?.value ?? null;
    }).catch(() => null);
    if (token) break;
    await new Promise(r => setTimeout(r, 1_500));
  }
  console.log(`Token CSRF: ${token ? token.slice(0, 20) + "…" : "NON TROUVÉ"}`);

  // Cookies actuels
  const cookies = await (page as any).cookies().catch(() => []) as any[];
  const phpCookie = cookies.find((c: any) => c.name === "PHPSESSID");
  const cfCookie  = cookies.find((c: any) => c.name === "cf_clearance");
  console.log(`PHPSESSID: ${phpCookie?.value ?? "ABSENT"}`);
  console.log(`cf_clearance: ${cfCookie?.value?.slice(0, 40) ?? "ABSENT"}…`);

  if (token) {
    // Soumettre le formulaire via click
    console.log("\nSoumission Continuar…");
    const btnClicked = await (page as any).evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>("button[type='submit'], input[type='submit'], button.continuar, button");
      if (btn) { btn.click(); return btn.textContent?.trim() ?? "clicked"; }
      const form = document.querySelector<HTMLFormElement>("form");
      if (form) { form.submit(); return "form.submit"; }
      return null;
    }).catch(() => null);
    console.log(`  Bouton: ${btnClicked}`);

    // Attendre la page widget (bkt_init_widget doit apparaître)
    let widgetFound = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1_500));
      const hasWidget = await (page as any).evaluate(() => typeof (window as any).bkt_init_widget !== 'undefined').catch(() => false);
      if (hasWidget) { widgetFound = true; break; }
      const t = await (page as any).title().catch(() => "");
      process.stdout.write(`\r  [${i * 1.5}s] title="${t.slice(0, 30)}" widget=${hasWidget}   `);
    }
    console.log(`\nWidget chargé: ${widgetFound ? "✅" : "❌"}`);

    if (widgetFound) {
      // Lire le bkt_init_widget
      const widgetData = await (page as any).evaluate(() => {
        const w = (window as any).bkt_init_widget;
        return w ? JSON.stringify(w) : null;
      }).catch(() => null);
      console.log(`bkt_init_widget: ${widgetData?.slice(0, 200) ?? "(null)"}`);
    }
  }

  // ─── Attendre les requêtes /main/ ────────────────────────────────────────
  console.log("\nAttente des requêtes /main/ (max 30s)…");
  await new Promise(r => setTimeout(r, 30_000));

  // ─── Résumé ───────────────────────────────────────────────────────────────
  console.log("\n\n══════════ RÉSUMÉ FINAL ══════════");
  if (mainRequests.length === 0) {
    console.log("❌ Aucune requête /main/ interceptée");

    // Essayer manuellement d'appeler /main/ depuis le browser (page.evaluate fetch)
    console.log("\nTentative manuelle : fetch /main/ depuis le browser…");
    const PORTAL_URL_CLEAN = PORTAL_URL.replace(/#.*$/, "");
    const mainResult = await (page as any).evaluate(async (portal: string, wid: string) => {
      const cb = "jQuery21109" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
      const params = new URLSearchParams({
        callback: cb, type: "default", publickey: wid,
        lang: "es", version: "4", src: portal, _: String(Date.now()),
      });
      const url = `https://www.citaconsular.es/onlinebookings/main/?${params}`;
      try {
        const r = await fetch(url, { credentials: "include", headers: { "Accept": "*/*", "Referer": portal } });
        const b = await r.text();
        return { status: r.status, len: b.length, body: b.slice(0, 1000), ct: r.headers.get("content-type") };
      } catch(e) { return { error: String(e) }; }
    }, PORTAL_URL_CLEAN, "2d01502f12dc08400e22aea87fb00ae34").catch((e: unknown) => ({ error: String(e) }));

    console.log(`fetch /main/ depuis browser: ${JSON.stringify(mainResult, null, 2).slice(0, 2000)}`);

    // Aussi tester avec script tag (JSONP proper)
    const jsonpResult = await (page as any).evaluate(async (portal: string, wid: string) => {
      return new Promise((resolve) => {
        const cbName = "jQuery21109" + Date.now() + "_" + Math.floor(Math.random() * 1e9);
        const params = new URLSearchParams({
          callback: cbName, type: "default", publickey: wid,
          lang: "es", version: "4", src: portal, _: String(Date.now()),
        });
        const url = `https://www.citaconsular.es/onlinebookings/main/?${params}`;
        const timer = setTimeout(() => resolve({ timeout: true }), 20_000);
        (window as any)[cbName] = (data: any) => {
          clearTimeout(timer);
          delete (window as any)[cbName];
          resolve({ data: JSON.stringify(data).slice(0, 2000) });
        };
        if (typeof (window as any).callback === 'undefined') (window as any).callback = null;
        const sc = document.createElement("script");
        sc.onerror = (e) => { clearTimeout(timer); resolve({ scriptError: String(e) }); };
        sc.src = url;
        document.head.appendChild(sc);
      });
    }, PORTAL_URL_CLEAN, "2d01502f12dc08400e22aea87fb00ae34").catch((e: unknown) => ({ error: String(e) }));

    console.log(`JSONP /main/ depuis browser: ${JSON.stringify(jsonpResult, null, 2).slice(0, 2000)}`);

    // Cookies au moment de l'appel
    const c2 = await (page as any).cookies().catch(() => []) as any[];
    console.log(`\nCookies actuels:`);
    for (const c of c2) {
      console.log(`  ${c.name}=${c.value?.slice(0, 40)} (domain=${c.domain})`);
    }
  } else {
    console.log(`✅ ${mainRequests.length} requête(s) /main/ interceptée(s)`);
    console.log(`   ${mainResponses.length} réponse(s) capturée(s)`);
  }

  await new Promise(r => setTimeout(r, 2_000));
  await browser.close();
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
