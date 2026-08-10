#!/usr/bin/env node
/**
 * Réutilise la session déjà établie (cf_clearance + PHPSESSID) via les env vars
 * et teste des variantes pour /main/ + POST Continuar.
 *
 * Usage:
 *   CF_CLEARANCE=xxx PHPSESSID=yyy node_modules/.bin/tsx scripts/test-main-variants.ts
 *
 * Ou lancer en re-solvant :
 *   SOAX_PROXY_URL=xxx CAPSOLVER_API_KEY=yyy node_modules/.bin/tsx scripts/test-main-variants.ts
 */

import { Impit } from "impit";

const PROXY_URL    = process.env.SOAX_PROXY_URL ?? "";
const CAP_KEY      = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE     = "https://api.capsolver.com";
const PORTAL       = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID          = "2d01502f12dc08400e22aea87fb00ae34";
const BASE_CITA    = "https://www.citaconsular.es/onlinebookings/";
const BASE_BKT     = "https://www.bookitit.com/onlinebookings/";
const BASE_WEBAPP  = "https://webapp.bookitit.com/onlinebookings/";
const UA           = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function dump(label: string, res: any, body: string) {
  console.log(`\n[${label}] HTTP ${res.status} | ${body.length}B`);
  const h = res.headers as Headers;
  for (const [k, v] of (h as any).entries?.() ?? []) {
    if (/content-type|set-cookie|location|content-enc|content-length|x-frame/i.test(k))
      console.log(`  ${k}: ${v}`);
  }
  if (body.length > 0 && body.length < 600)
    console.log(`  body: "${body.replace(/\s+/g, " ").trim()}"`);
  else if (body.length >= 600)
    console.log(`  body[0:400]: "${body.slice(0, 400).replace(/\s+/g, " ").trim()}"`);
}

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

async function get(imp: InstanceType<typeof Impit>, url: string, headers: Record<string, string>): Promise<[any, string]> {
  const res = await (imp.fetch(url, { headers } as any) as unknown as Promise<any>);
  const body = await res.text() as string;
  return [res, body];
}

async function post(imp: InstanceType<typeof Impit>, url: string, headers: Record<string, string>, body: string): Promise<[any, string]> {
  const res = await (imp.fetch(url, { method: "POST", headers, body } as any) as unknown as Promise<any>);
  const b = await res.text() as string;
  return [res, b];
}

async function main() {
  // ─ Phase A : obtenir cf_clearance + PHPSESSID ────────────────────────────
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);

  // Probe
  const [rProbe, bProbe] = await get(imp, PORTAL, {
    "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  });
  const isCf = /just a moment|_cf_chl_opt/i.test(bProbe.slice(0, 2000));
  console.log(`Probe: HTTP ${rProbe.status} | CF: ${isCf}`);

  const cfClearance = await capsolver(bProbe);
  if (!cfClearance) { process.exit(1); }
  console.log(`\ncf_clearance: ${cfClearance.slice(0, 40)}…`);

  // GET portal
  const [r3, b3] = await get(imp, PORTAL, {
    "User-Agent": UA, "Cookie": `cf_clearance=${cfClearance}`,
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
  });
  dump("portal-get", r3, b3);
  const php = ((r3 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const token = b3.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";
  console.log(`  → PHPSESSID: ${php} | token: ${token.slice(0, 20)}`);

  // ─ Phase B : POST Continuar — essais multiples ───────────────────────────

  // B1 : POST avec Accept-Language es-ES (peut-être le serveur filtre)
  console.log("\n══ POST B1 : Accept-Language es-ES ══");
  const [rb1, bb1] = await post(imp, PORTAL, {
    "User-Agent": UA, "Cookie": `cf_clearance=${cfClearance}; PHPSESSID=${php}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
  }, `token=${encodeURIComponent(token)}`);
  dump("post-b1", rb1, bb1);
  const php2 = ((rb1 as any).headers?.get?.("set-cookie") ?? "").match(/PHPSESSID=([^;]+)/)?.[1] ?? php;
  const has_bkt_b1 = /bkt_init|widget\s*=\s*new|Bookitit|widgetCode/i.test(bb1);
  console.log(`  Bookitit widget dans réponse: ${has_bkt_b1 ? "✅" : "❌"}`);
  console.log(`  PHPSESSID après POST: ${php2}`);

  // B2 : POST avec cookies en ordre GA + PHPSESSID + cf_clearance
  const gaRnd = Math.floor(Math.random() * 999_999_999);
  const gaTs  = Math.floor(Date.now() / 1000) - Math.floor(Math.random() * 86400 * 30);
  const gaCk  = `_ga=GA1.1.${gaRnd}.${gaTs}`;
  console.log("\n══ POST B2 : avec GA cookies ══");
  const [rb2, bb2] = await post(imp, PORTAL, {
    "User-Agent": UA,
    "Cookie": `${gaCk}; PHPSESSID=${php2}; cf_clearance=${cfClearance}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": PORTAL, "Origin": "https://www.citaconsular.es",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9",
    "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
  }, `token=${encodeURIComponent(token)}`);
  dump("post-b2", rb2, bb2);
  console.log(`  Bookitit widget: ${/bkt_init|widget\s*=\s*new|Bookitit|widgetCode/i.test(bb2) ? "✅" : "❌"}`);

  // ─ Phase C : GET /main/ — variantes de paramètres ────────────────────────
  const ckStr = `${gaCk}; PHPSESSID=${php2}; cf_clearance=${cfClearance}`;

  async function testMain(label: string, base: string, params: Record<string, string>) {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, ...params });
    const url = `${base}main/?${q}`;
    console.log(`\n══ ${label} ══`);
    console.log(`  ${url.slice(0, 110)}…`);
    const [r, b] = await get(imp, url, {
      "User-Agent": UA, "Cookie": ckStr,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "Accept-Language": "es-ES,es;q=0.9",
      "Referer": PORTAL,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    });
    dump(label, r, b);
  }

  // C1 : citaconsular, params classiques avec publickey
  await testMain("C1 cita/main (publickey, type, ver, src)", BASE_CITA, {
    type: "default", publickey: WID, lang: "es", version: "4",
    src: PORTAL, _: String(Date.now()),
  });

  // C2 : citaconsular, params sans src
  await testMain("C2 cita/main sans src", BASE_CITA, {
    type: "default", publickey: WID, lang: "es", version: "4", _: String(Date.now()),
  });

  // C3 : citaconsular, params sans type/version
  await testMain("C3 cita/main sans type+version", BASE_CITA, {
    publickey: WID, lang: "es", src: PORTAL, _: String(Date.now()),
  });

  // C4 : citaconsular, wid= au lieu de publickey=
  await testMain("C4 cita/main wid=", BASE_CITA, {
    wid: WID, lang: "es", _: String(Date.now()),
  });

  // C5 : citaconsular, publickey uniquement
  await testMain("C5 cita/main publickey seulement", BASE_CITA, {
    publickey: WID, lang: "es",
  });

  // C6 : sans PHPSESSID, params complets — contrôle
  console.log(`\n══ C6 : /main/ SANS PHPSESSID (contrôle) ══`);
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    const [r, b] = await get(imp, `${BASE_CITA}main/?${q}`, {
      "User-Agent": UA, "Accept": "*/*", "Referer": PORTAL,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    });
    dump("C6-no-session", r, b);
  }

  // C7 : fresh impit (pas de session TLS partagée)
  console.log(`\n══ C7 : /main/ fresh impit (nouvelle TLS) ══`);
  {
    const freshImp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, type: "default", publickey: WID, lang: "es", version: "4", src: PORTAL, _: String(Date.now()) });
    const [r, b] = await get(freshImp, `${BASE_CITA}main/?${q}`, {
      "User-Agent": UA, "Cookie": ckStr,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    });
    dump("C7-fresh-impit", r, b);
  }

  // C8 : /getservices/ avec PHPSESSID (test session valide)
  console.log(`\n══ C8 : /getservices/ avec PHPSESSID ══`);
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, publickey: WID, lang: "es", _: String(Date.now()) });
    const [r, b] = await get(imp, `${BASE_CITA}getservices/?${q}`, {
      "User-Agent": UA, "Cookie": ckStr,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    });
    dump("C8-getservices", r, b);
  }

  // C9 : /getwidgetconfigurations/ avec PHPSESSID
  console.log(`\n══ C9 : /getwidgetconfigurations/ avec PHPSESSID ══`);
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({ callback: cb, publickey: WID, lang: "es", _: String(Date.now()) });
    const [r, b] = await get(imp, `${BASE_CITA}getwidgetconfigurations/?${q}`, {
      "User-Agent": UA, "Cookie": ckStr,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    });
    dump("C9-getwidgetconfs", r, b);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
