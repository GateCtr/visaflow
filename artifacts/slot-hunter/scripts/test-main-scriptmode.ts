#!/usr/bin/env node
/**
 * Teste /main/ avec les VRAIS headers d'un script tag JSONP
 * et compare avant/après POST Continuar.
 *
 * Insight loadermaec.js :
 *   - JSONP via $.getJSON(url+'/?callback=?', bkt_init_widget, cb)
 *   - Script tag → Sec-Fetch-Mode: no-cors, Sec-Fetch-Dest: script (pas XHR!)
 *   - srvsrc supprimé des params, version et src (=document.location.href) ajoutés
 *   - src = URL de la page courante (portail après POST)
 */

import { Impit } from "impit";

const PROXY_URL = process.env.SOAX_PROXY_URL ?? "";
const CAP_KEY   = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE  = "https://api.capsolver.com";
const PORTAL    = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID       = "2d01502f12dc08400e22aea87fb00ae34";
const BASE      = "https://www.citaconsular.es/onlinebookings/";
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function capsolver(html: string): Promise<string | null> {
  const p = new URL(PROXY_URL);
  const proxy = `http://${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}@${p.hostname}:${p.port}`;
  const cr = await (await fetch(`${CAP_BASE}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAP_KEY, task: {
      type: "AntiCloudflareTask", websiteURL: PORTAL, proxy, userAgent: UA,
      html: html.slice(0, 32_000),
    } }), signal: AbortSignal.timeout(30_000),
  })).json() as any;
  if (cr.errorId !== 0) { console.error(`❌ ${cr.errorDescription}`); return null; }
  console.log(`  task: ${cr.taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAP_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAP_KEY, taskId: cr.taskId }), signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`❌ ${pr.errorCode}`); return null; }
    if (pr.status === "ready") return pr.solution?.cookies?.["cf_clearance"] ?? null;
    process.stdout.write(".");
  }
  return null;
}

async function get(imp: InstanceType<typeof Impit>, url: string, hdrs: Record<string, string>): Promise<[any, string]> {
  const r = await (imp.fetch(url, { headers: hdrs } as any) as unknown as Promise<any>);
  const b = await r.text() as string;
  return [r, b];
}

// Appel /main/ exact comme loadermaec.js (script tag JSONP)
async function callMain(
  imp: InstanceType<typeof Impit>,
  label: string,
  cookies: string,
  extraParams: Record<string, string> = {},
  mode: "script" | "xhr" = "script",
) {
  const cb = `jQuery${Date.now()}`;
  const params: Record<string, string> = {
    callback: cb,
    type: "default",
    publickey: WID,
    lang: "es",
    version: "4",
    src: PORTAL,   // document.location.href dans le vrai browser
    _: String(Date.now()),
    ...extraParams,
  };
  const q = new URLSearchParams(params);
  const url = `${BASE}main/?${q}`;

  const baseHeaders: Record<string, string> = {
    "User-Agent": UA,
    "Cookie": cookies,
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer": PORTAL,
  };

  let headers: Record<string, string>;
  if (mode === "script") {
    // Script tag JSONP — exactement comme le navigateur avec $.getJSON
    headers = {
      ...baseHeaders,
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-origin",
    };
  } else {
    // XHR mode
    headers = {
      ...baseHeaders,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    };
  }

  console.log(`\n[${label}] mode=${mode} ${url.slice(0, 100)}…`);
  const [r, b] = await get(imp, url, headers);

  const setCk = (r as any).headers?.get?.("set-cookie") ?? "";
  const newPhp = setCk.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const ct = (r as any).headers?.get?.("content-type") ?? "";
  const ce = (r as any).headers?.get?.("content-encoding") ?? "";

  const isJsonp   = b.startsWith(cb) || b.includes(`${cb}(`);
  const isCbEq    = b.startsWith(`callback=${cb}`);
  const isErr     = /Exception|Contact with your technical|no callback found/i.test(b.slice(0, 200));
  const hasWidget = /bkt_init_widget|Client|services|agendas/i.test(b.slice(0, 5000));
  const isCf      = /just a moment|_cf_chl_opt/i.test(b.slice(0, 1000));

  console.log(`  HTTP ${r.status} | ${b.length}B | ct=${ct} ce=${ce}`);
  console.log(`  CF:${isCf ? "🔴" : "✅"}  JSONP:${isJsonp || isCbEq ? "✅" : "—"}  widget:${hasWidget ? "✅" : "—"}  err:${isErr ? "⚠️" : "—"}`);
  if (newPhp) console.log(`  ⚠️  Set-Cookie PHPSESSID: ${newPhp.slice(0, 16)}… (différent!)`);
  if (b.length > 0) console.log(`  body: "${b.slice(0, 300).replace(/\s+/g, " ").trim()}"`);
  return b;
}

async function main() {
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);

  // Probe + CapSolver
  const [rP, bP] = await get(imp, PORTAL, {
    "User-Agent": UA, "Accept": "text/html,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
  });
  console.log(`Probe: HTTP ${rP.status}`);
  const cf = await capsolver(bP);
  if (!cf) process.exit(1);
  console.log(`cf_clearance: ${cf.slice(0, 30)}…`);

  // GET portal → PHPSESSID + token
  const [r3, b3] = await get(imp, PORTAL, {
    "User-Agent": UA, "Cookie": `cf_clearance=${cf}`,
    "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
  });
  const php = ((r3 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const token = b3.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";
  console.log(`\nGET portal: PHPSESSID=${php} | token=${token}`);

  // ── TEST : /main/ AVANT POST Continuar ───────────────────────────────────
  console.log("\n════ /main/ AVANT POST Continuar ════");
  const ckBase = `cf_clearance=${cf}; PHPSESSID=${php}`;

  await callMain(imp, "AVANT-script-avec-src", ckBase, {}, "script");
  await callMain(imp, "AVANT-script-sans-src", ckBase, { src: "" }, "script");
  await callMain(imp, "AVANT-xhr-sans-src", ckBase, { src: "" }, "xhr");

  // ── POST Continuar ────────────────────────────────────────────────────────
  console.log("\n════ POST Continuar ════");
  const [r4, b4] = await (async () => {
    const r = await (imp.fetch(PORTAL, {
      method: "POST",
      headers: {
        "User-Agent": UA, "Cookie": ckBase,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
        "Accept": "text/html,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Promise<any>);
    const b = await r.text() as string;
    return [r, b];
  })();
  const hasBktInit = /bkt_init_widget/i.test(b4);
  const phpAfter = ((r4 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? php;
  console.log(`  HTTP ${r4.status} | ${b4.length}B | bkt_init: ${hasBktInit ? "✅ widget" : "❌ form"}`);
  console.log(`  PHPSESSID: ${phpAfter}`);

  // ── TEST : /main/ APRÈS POST Continuar ──────────────────────────────────
  console.log("\n════ /main/ APRÈS POST Continuar ════");
  const ckFull = `cf_clearance=${cf}; PHPSESSID=${phpAfter}`;

  // A: script tag, avec src (exactement comme le vrai browser)
  await callMain(imp, "APRÈS-script-avec-src", ckFull, {}, "script");

  // B: script tag, sans src
  await callMain(imp, "APRÈS-script-sans-src", ckFull, { src: "" }, "script");

  // C: XHR, sans src
  await callMain(imp, "APRÈS-xhr-sans-src", ckFull, { src: "" }, "xhr");

  // D: script tag, SANS version ni _
  await callMain(imp, "APRÈS-script-sans-version", ckFull, { version: "", _: "" }, "script");

  // E: script tag, avec src = https://www.citaconsular.es/ (juste le domaine)
  await callMain(imp, "APRÈS-src=domain", ckFull, { src: "https://www.citaconsular.es/" }, "script");

  // F: Referer = postUrl, script tag
  console.log("\n[APRÈS-referer-posturl] GET /main/ avec Referer=postUrl");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    const [r, b] = await get(imp, `${BASE}main/?${q}`, {
      "User-Agent": UA, "Cookie": ckFull, "Accept": "*/*",
      "Referer": PORTAL + "#redsysok",  // parfois le Referer inclut le hash
      "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin",
    });
    console.log(`  HTTP ${r.status} | ${b.length}B`);
    if (b.length) console.log(`  body: "${b.slice(0, 200)}"`);
  }

  // G: Inspecter Set-Cookie sur /main/ → est-ce que le serveur crée une NOUVELLE session?
  console.log("\n[CHECK-set-cookie] Inspecter les headers de /main/");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
    const r = await (imp.fetch(`${BASE}main/?${q}`, {
      headers: {
        "User-Agent": UA,
        // PAS de Cookie du tout → est-ce que le serveur crée une session?
        "Accept": "*/*", "Referer": PORTAL,
        "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin",
      }
    } as any) as unknown as Promise<any>);
    const b = await r.text() as string;
    const allSetCk = (r as any).headers?.get?.("set-cookie") ?? "(aucun)";
    console.log(`  HTTP ${r.status} | ${b.length}B`);
    console.log(`  Set-Cookie: ${allSetCk}`);
    console.log(`  body: "${b.slice(0, 200)}"`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
