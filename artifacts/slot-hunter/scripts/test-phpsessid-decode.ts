#!/usr/bin/env node
/**
 * Teste l'hypothèse : PHPSESSID URL-encodé (%2C) doit être DÉCODÉ dans le Cookie header.
 * Test rapide : probe → CapSolver → GET portal → tester /main/ avec PHP encodé vs décodé.
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
    body: JSON.stringify({ clientKey: CAP_KEY, task: { type: "AntiCloudflareTask", websiteURL: PORTAL, proxy, userAgent: UA, html: html.slice(0, 32_000) } }),
    signal: AbortSignal.timeout(30_000),
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

async function testMain(label: string, imp: InstanceType<typeof Impit>, php: string, cf: string) {
  const cb = `jQuery${Date.now()}`;
  // Test sans src (donne 124B JSONP avec PHPSESSID propre)
  const q  = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
  const url = `${BASE}main/?${q}`;
  const [r, b] = await get(imp, url, {
    "User-Agent": UA, "Cookie": `cf_clearance=${cf}; PHPSESSID=${php}`,
    "Accept": "*/*", "Referer": PORTAL,
    "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin",
  });
  const ct = (r as any).headers?.get?.("content-type") ?? "";
  const isErr = /Exception|Contact with your technical/i.test(b.slice(0, 200));
  const hasWidget = /Client|services|agendas/i.test(b.slice(0, 5000));
  console.log(`  [${label}] HTTP ${r.status} | ${b.length}B | ct=${ct}`);
  console.log(`    err:${isErr} widget:${hasWidget} → "${b.slice(0, 200)}"`);
}

async function main() {
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);

  // Probe
  const [rP, bP] = await get(imp, PORTAL, {
    "User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
  });
  console.log(`Probe: HTTP ${rP.status}`);
  const cf = await capsolver(bP);
  if (!cf) process.exit(1);
  console.log(`cf_clearance: ${cf.slice(0, 30)}…`);

  // GET portal → PHPSESSID
  const [r3, b3] = await get(imp, PORTAL, {
    "User-Agent": UA, "Cookie": `cf_clearance=${cf}`,
    "Accept": "text/html,*/*", "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
  });
  const phpRaw = ((r3 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const phpDecoded = decodeURIComponent(phpRaw);
  const token = b3.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";

  console.log(`\nGET portal: HTTP ${r3.status}`);
  console.log(`  PHPSESSID brut     : ${phpRaw}`);
  console.log(`  PHPSESSID décodé   : ${phpDecoded}`);
  console.log(`  Encodé = Décodé?   : ${phpRaw === phpDecoded ? "✅ (pas de %xx, pas de problème)" : "❌ DIFFÉRENT — test critique!"}`);

  // POST Continuar
  await (async () => {
    const r = await (imp.fetch(PORTAL, {
      method: "POST",
      headers: {
        "User-Agent": UA, "Cookie": `cf_clearance=${cf}; PHPSESSID=${phpRaw}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
        "Accept": "text/html,*/*", "Accept-Language": "es-ES,es;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Promise<any>);
    const b = await r.text() as string;
    console.log(`\nPOST Continuar: HTTP ${r.status} | ${b.length}B | bkt_init: ${/bkt_init_widget/i.test(b) ? "✅" : "❌"}`);
  })();

  // Test /main/ avec PHPSESSID brut vs décodé
  console.log("\n════ Test /main/ : brut vs décodé ════");
  await testMain("PHPSESSID brut (URL-encodé)", imp, phpRaw, cf);
  await testMain("PHPSESSID décodé (plain text)", imp, phpDecoded, cf);

  // Si les deux donnent 0B, tester SANS PHPSESSID du tout
  console.log("\n════ Contrôle : /main/ SANS PHPSESSID ════");
  await testMain("SANS PHPSESSID", imp, "", cf);

  // Test avec juste le PHPSESSID (sans cf_clearance) 
  console.log("\n════ /main/ SANS cf_clearance (PHPSESSID seulement) ════");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
    const [r, b] = await get(imp, `${BASE}main/?${q}`, {
      "User-Agent": UA, "Cookie": `PHPSESSID=${phpDecoded}`,
      "Accept": "*/*", "Referer": PORTAL,
      "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin",
    });
    console.log(`  [PHPSESSID décodé, sans cf_clearance] HTTP ${r.status} | ${b.length}B`);
    console.log(`  body: "${b.slice(0, 200)}"`);
  }

  // Si la session a des %2C, aussi tester avec double-décodage
  if (phpRaw.includes("%2C") || phpRaw.includes("%2c")) {
    const phpDoubleDecoded = decodeURIComponent(decodeURIComponent(phpRaw));
    console.log(`\n════ Test /main/ avec double-décodage (si %2C) ════`);
    console.log(`  Double-décodé: ${phpDoubleDecoded}`);
    await testMain("PHPSESSID double-décodé", imp, phpDoubleDecoded, cf);
  }

  // Test : appeler /main/ via native fetch (Node.js) au lieu d'impit
  console.log("\n════ /main/ via native Node fetch (pas impit) ════");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()) });
    const url = `${BASE}main/?${q}`;

    // Obtenir le proxy HTTP
    const proxyUrl = PROXY_URL;
    // Native fetch ne supporte pas les proxies directement dans Node 20, skip proxy pour ce test
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA, "Cookie": `cf_clearance=${cf}; PHPSESSID=${phpDecoded}`,
          "Accept": "*/*", "Referer": PORTAL,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const b = await r.text();
      console.log(`  native fetch: HTTP ${r.status} | ${b.length}B`);
      console.log(`  body: "${b.slice(0, 200)}"`);
    } catch (e) {
      console.log(`  native fetch: erreur ${e}`);
    }
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
