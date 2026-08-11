#!/usr/bin/env node
/**
 * test-debug-main-0b.ts
 *
 * Debug brut : inspecte les headers et body RAW à chaque étape
 * pour comprendre pourquoi /main/ retourne 0B.
 */

import { Impit } from "impit";

const PROXY_URL = process.env.SOAX_PROXY_URL ?? "";
const CAP_KEY   = process.env.CAPSOLVER_API_KEY ?? "";
const CAP_BASE  = "https://api.capsolver.com";

const PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID    = "2d01502f12dc08400e22aea87fb00ae34";
const BASE   = "https://www.citaconsular.es/onlinebookings/";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function dumpRes(label: string, res: any, body: string) {
  console.log(`\n[${label}] HTTP ${res.status} | ${body.length}B`);
  // Headers
  const headers = res.headers as Headers;
  for (const [k, v] of (headers as any).entries?.() ?? []) {
    if (/content-type|set-cookie|location|content-encoding|transfer-encoding|content-length/i.test(k)) {
      console.log(`  ${k}: ${v}`);
    }
  }
  // Body preview
  const snippet = body.slice(0, 400).replace(/\s+/g, " ").trim();
  console.log(`  body: "${snippet}"`);
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

  if (cr.errorId !== 0) { console.error(`❌ createTask: ${cr.errorDescription ?? cr.errorCode}`); return null; }
  console.log(`  CapSolver task: ${cr.taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAP_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAP_KEY, taskId: cr.taskId }),
      signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`❌ poll: ${pr.errorCode}`); return null; }
    if (pr.status === "ready") { return pr.solution?.cookies?.["cf_clearance"] ?? null; }
    process.stdout.write(".");
  }
  return null;
}

async function impitFetch(imp: InstanceType<typeof Impit>, url: string, opts: any): Promise<[any, string]> {
  const res = await (imp.fetch(url, opts as any) as unknown as Promise<any>);
  const body = await (res as any).text() as string;
  return [res, body];
}

async function main() {
  const imp = new Impit({ browser: "chrome", proxyUrl: PROXY_URL } as any);

  // ─ Step 1 : probe portal ─────────────────────────────────────────────────
  console.log("\n══ Step 1 : probe portal ══");
  const [r1, b1] = await impitFetch(imp, PORTAL, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
    }
  });
  dumpRes("probe", r1, b1);

  // ─ Step 2 : CapSolver with html ──────────────────────────────────────────
  console.log("\n══ Step 2 : CapSolver WITH html ══");
  const cfClearance = await capsolver(b1);
  if (!cfClearance) { process.exit(1); }
  console.log(`\n  cf_clearance: ${cfClearance.slice(0, 40)}…`);

  // ─ Step 3 : GET portal avec cf_clearance ─────────────────────────────────
  console.log("\n══ Step 3 : GET portal + cf_clearance → PHPSESSID ══");
  const [r3, b3] = await impitFetch(imp, PORTAL, {
    headers: {
      "User-Agent": UA,
      "Cookie": `cf_clearance=${cfClearance}`,
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
    }
  });
  dumpRes("portal-get", r3, b3);

  const setCk3 = (r3 as any).headers?.get?.("set-cookie") ?? "";
  const php3 = setCk3.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
  const token3 = b3.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ?? "";
  // Form action — chercher en ignorant l'ordre des attributs
  const formM = b3.match(/<form[^>]+>/i)?.[0] ?? "";
  const actionM = formM.match(/action=["']([^"']+)["']/i)?.[1] ?? "";
  const postUrl = actionM
    ? (actionM.startsWith("http") ? actionM : `https://www.citaconsular.es${actionM}`)
    : PORTAL;

  console.log(`  PHPSESSID: ${php3 ? "✅ " + php3.slice(0, 16) : "❌ absent"}`);
  console.log(`  Token:     ${token3 ? "✅ " + token3.slice(0, 30) : "❌ absent"}`);
  console.log(`  Form tag:  ${formM.slice(0, 150)}`);
  console.log(`  POST url:  ${postUrl}`);

  // Afficher TOUS les hidden inputs
  const hiddenFields: Array<[string, string]> = [];
  for (const m of b3.matchAll(/type=["']hidden["'][^>]*/gi)) {
    const nameM = m[0].match(/name=["']([^"']+)["']/i)?.[1] ?? "";
    const valM  = m[0].match(/value=["']([^"']*?)["']/i)?.[1] ?? "";
    if (nameM) hiddenFields.push([nameM, valM]);
  }
  console.log(`  Hidden inputs: ${JSON.stringify(hiddenFields)}`);

  if (!php3) { console.error("\n❌ Pas de PHPSESSID — stop"); process.exit(1); }

  // ─ Step 4 : POST Continuar ───────────────────────────────────────────────
  console.log("\n══ Step 4 : POST Continuar ══");
  const formBody = hiddenFields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  console.log(`  POST body: ${formBody.slice(0, 200)}`);
  console.log(`  Cookie:    PHPSESSID=${php3.slice(0, 16)}… ; cf_clearance=${cfClearance.slice(0, 20)}…`);

  const [r4, b4] = await impitFetch(imp, postUrl, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Cookie": `cf_clearance=${cfClearance}; PHPSESSID=${php3}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": PORTAL,
      "Origin": "https://www.citaconsular.es",
      "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin", "Upgrade-Insecure-Requests": "1",
    },
    body: formBody,
  });
  dumpRes("post-continuar", r4, b4);

  // Vérifier si nouveau PHPSESSID après POST
  const setCk4 = (r4 as any).headers?.get?.("set-cookie") ?? "";
  const php4 = setCk4.match(/PHPSESSID=([^;]+)/)?.[1] ?? php3;
  console.log(`  PHPSESSID post-POST: ${php4.slice(0, 16)}…`);
  console.log(`  Contenu: ${b4.includes("bookitit") || b4.includes("bkt") ? "✅ Bookitit" : "—"}`);

  // Chercher JSD oneshot URL dans la réponse
  const jsdM = b4.match(/\/cdn-cgi\/challenge-platform\/h\/b\/jsd\/oneshot\/([^'"<\s]{20,})/);
  console.log(`  JSD oneshot: ${jsdM ? "✅ " + jsdM[0].slice(0, 60) : "absent"}`);

  // ─ Step 5a : GET /main/ SANS Cookie ─────────────────────────────────────
  console.log("\n══ Step 5a : GET /main/ SANS aucun cookie ══");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cb, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const [r, b] = await impitFetch(imp, `${BASE}main/?${q}`, {
      headers: {
        "User-Agent": UA, "Accept": "*/*",
        "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      }
    });
    dumpRes("main-no-cookie", r, b);
  }

  // ─ Step 5b : GET /main/ avec PHPSESSID seulement ─────────────────────────
  console.log("\n══ Step 5b : GET /main/ avec PHPSESSID SEULEMENT ══");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cb, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const [r, b] = await impitFetch(imp, `${BASE}main/?${q}`, {
      headers: {
        "User-Agent": UA,
        "Cookie": `PHPSESSID=${php4}`,
        "Accept": "*/*", "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      }
    });
    dumpRes("main-php-only", r, b);
  }

  // ─ Step 5c : GET /main/ avec PHPSESSID + cf_clearance ────────────────────
  console.log("\n══ Step 5c : GET /main/ avec PHPSESSID + cf_clearance ══");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cb, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const [r, b] = await impitFetch(imp, `${BASE}main/?${q}`, {
      headers: {
        "User-Agent": UA,
        "Cookie": `PHPSESSID=${php4}; cf_clearance=${cfClearance}`,
        "Accept": "*/*", "Referer": PORTAL, "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      }
    });
    dumpRes("main-php+cf", r, b);
  }

  // ─ Step 5d : GET /main/ avec POST Continuar response comme Referer ────────
  // Peut-être que le serveur vérifie que la session a été initialisée par le POST
  console.log("\n══ Step 5d : /main/ avec Referer = postUrl ══");
  {
    const cb = `jQuery${Date.now()}`;
    const q = new URLSearchParams({
      callback: cb, type: "default", publickey: WID,
      lang: "es", version: "4", src: PORTAL, _: String(Date.now()),
    });
    const [r, b] = await impitFetch(imp, `${BASE}main/?${q}`, {
      headers: {
        "User-Agent": UA,
        "Cookie": `PHPSESSID=${php4}; cf_clearance=${cfClearance}`,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "Referer": postUrl,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      }
    });
    dumpRes("main-referer-post", r, b);
  }

  // ─ Step 5e : GET /main/ avec params minimaux (pas de publickey) ───────────
  console.log("\n══ Step 5e : /main/ params minimaux (wid= uniquement) ══");
  {
    const [r, b] = await impitFetch(imp, `${BASE}main/?wid=${WID}&lang=es`, {
      headers: {
        "User-Agent": UA,
        "Cookie": `PHPSESSID=${php4}; cf_clearance=${cfClearance}`,
        "Accept": "*/*", "Referer": PORTAL,
      }
    });
    dumpRes("main-minimal", r, b);
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
