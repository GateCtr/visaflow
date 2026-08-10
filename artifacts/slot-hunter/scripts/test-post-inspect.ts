#!/usr/bin/env node
/**
 * Inspecte le contenu complet du POST Continuar
 * et cherche les endpoints d'initialisation Bookitit dans le HTML.
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
    }}), signal: AbortSignal.timeout(30_000),
  })).json() as any;
  if (cr.errorId !== 0) { console.error(`❌ createTask: ${cr.errorDescription}`); return null; }
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

async function impFetch(imp: InstanceType<typeof Impit>, url: string, init: any): Promise<[any, string]> {
  const r = await (imp.fetch(url, init as any) as unknown as Promise<any>);
  const b = await r.text() as string;
  return [r, b];
}

async function main() {
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);

  // Probe + solve
  const [rP, bP] = await impFetch(imp, PORTAL, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1" }
  });
  console.log(`Probe: HTTP ${rP.status} | CF: ${/just a moment/i.test(bP)}`);
  const cf = await capsolver(bP);
  if (!cf) process.exit(1);
  console.log(`cf_clearance: ${cf.slice(0, 30)}…\n`);

  // GET portal → PHPSESSID + token
  const [r3, b3] = await impFetch(imp, PORTAL, {
    headers: { "User-Agent": UA, "Cookie": `cf_clearance=${cf}`,
      "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1" }
  });
  const php = ((r3 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const token = b3.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";
  console.log(`GET portal: HTTP ${r3.status} | PHPSESSID: ${php} | token: ${token}`);
  console.log(`\n── GET portal HTML (complet ${b3.length}B) ──`);
  console.log(b3);

  // POST Continuar
  const [r4, b4] = await impFetch(imp, PORTAL, {
    method: "POST",
    headers: { "User-Agent": UA, "Cookie": `cf_clearance=${cf}; PHPSESSID=${php}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
      "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1" },
    body: `token=${encodeURIComponent(token)}`,
  });
  console.log(`\nPOST Continuar: HTTP ${r4.status} | ${b4.length}B`);
  console.log(`Set-Cookie: ${(r4 as any).headers?.get?.("set-cookie") ?? "—"}`);
  console.log(`\n── POST Continuar HTML (complet ${b4.length}B) ──`);
  console.log(b4);

  // Analyser le POST response
  console.log("\n── Analyse du POST response ──");
  const hasForm    = /<form/i.test(b4);
  const hasToken   = /name=["']token["']/i.test(b4);
  const hasWidget  = /bkt_init_widget|new\s+Bookitit|bookitit\.js|widget_code/i.test(b4);
  const hasSrvsrc  = /srvsrc/i.test(b4);
  const hasScript  = /<script/i.test(b4);
  const scriptUrls = [...b4.matchAll(/src=["']([^"']+bookitit[^"']+)["']/gi)].map(m => m[1]);
  const apiUrls    = [...b4.matchAll(/["'](https?:\/\/[^"']*\/onlinebookings\/[^"']+)["']/gi)].map(m => m[1]);
  const ajaxUrls   = [...b4.matchAll(/url\s*:\s*["']([^"']+)["']/gi)].map(m => m[1]);
  const jsInit     = b4.match(/new\s+Bookitit\s*\(([^)]+)\)/i)?.[0] ?? "";

  console.log(`  <form>         : ${hasForm}`);
  console.log(`  token input    : ${hasToken} → ${hasForm && hasToken ? "❌ MÊME formulaire (POST a échoué)" : "✅ Pas de formulaire"}`);
  console.log(`  widget init    : ${hasWidget}`);
  console.log(`  srvsrc         : ${hasSrvsrc}`);
  console.log(`  scripts        : ${hasScript}`);
  console.log(`  Bookitit URLs  : ${scriptUrls.join(", ") || "—"}`);
  console.log(`  API URLs       : ${apiUrls.join(", ") || "—"}`);
  console.log(`  AJAX URLs      : ${ajaxUrls.slice(0, 5).join(", ") || "—"}`);
  console.log(`  new Bookitit() : ${jsInit || "—"}`);

  if (hasForm && hasToken) {
    console.log("\n❌ POST CONTINUAR ÉCHOUÉ — le serveur a retourné le même formulaire");
    console.log("   → Token invalide, PHPSESSID incorrect, ou autre validation");
    console.log("\n── Test : POST sans cf_clearance ──");
    const [r4b, b4b] = await impFetch(imp, PORTAL, {
      method: "POST",
      headers: { "User-Agent": UA, "Cookie": `PHPSESSID=${php}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
        "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1" },
      body: `token=${encodeURIComponent(token)}`,
    });
    const hasForm2 = /<form/i.test(b4b);
    const hasToken2 = /name=["']token["']/i.test(b4b);
    console.log(`  HTTP ${r4b.status} | ${b4b.length}B | form:${hasForm2} token:${hasToken2}`);
    console.log(`  → ${hasForm2 && hasToken2 ? "❌ Toujours le même formulaire" : "✅ Page différente!"}`);
    if (!hasForm2 || !hasToken2) console.log(b4b.slice(0, 800));
  } else {
    // POST a réussi → tester /main/
    console.log("\n✅ POST CONTINUAR RÉUSSI — page widget chargée");
    const php4 = ((r4 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? php;

    console.log("\n── Test /main/ après POST réussi ──");
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, publickey: WID, lang: "es", _: String(Date.now()) });
    const [rm, bm] = await impFetch(imp, `${BASE}main/?${q}`, {
      headers: { "User-Agent": UA, "Cookie": `PHPSESSID=${php4}; cf_clearance=${cf}`,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" }
    });
    console.log(`  /main/: HTTP ${rm.status} | ${bm.length}B`);
    if (bm.length > 0) console.log(`  Preview: "${bm.slice(0, 400)}"`);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
