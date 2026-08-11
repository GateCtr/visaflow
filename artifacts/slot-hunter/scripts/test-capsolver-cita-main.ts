#!/usr/bin/env node
/**
 * test-capsolver-cita-main.ts
 *
 * La vraie URL de /main/ est https://www.citaconsular.es/onlinebookings/main/
 * (srvsrc = 'https://www.citaconsular.es' d'après extractBookititBaseFromHtml)
 *
 * Teste si ces endpoints acceptent le cf_clearance CapSolver via impit :
 *   1. CapSolver → cf_clearance
 *   2. GET portal citaconsular.es → token CSRF + PHPSESSID
 *      (avec cf_clearance — peut-être que /es/hosteds/... est plus strict que /onlinebookings/)
 *   3. GET /onlinebookings/main/    SANS PHPSESSID → réponse ?
 *   4. GET /onlinebookings/main/    AVEC PHPSESSID (si obtenu) → données ?
 *   5. GET /onlinebookings/getservices/  → JSONP ?
 *
 * Usage : node_modules/.bin/tsx scripts/test-capsolver-cita-main.ts
 */

import { Impit } from "impit";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

const PROXY_URL = process.env.SOAX_PROXY_URL || getCurrentDecodoUrl() || undefined;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const CAPSOLVER_BASE = "https://api.capsolver.com";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID   = "2d01502f12dc08400e22aea87fb00ae34";
const SRVSRC = "https://www.citaconsular.es";
const BASE  = `${SRVSRC}/onlinebookings/`;

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function mask(u?: string) { return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 80) : "(direct)"; }
function sep(t: string) { console.log(`\n${"─".repeat(62)}\n── ${t}\n${"─".repeat(62)}`); }

function parseCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const raw = (res as any).headers?.get?.("set-cookie") ?? "";
  for (const part of raw.split(/,\s*(?=[A-Za-z_][^=,]*=)/)) {
    const first = part.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return jar;
}

function ck(jar: Record<string, string>) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function doFetch(
  imp: InstanceType<typeof Impit>,
  url: string,
  opts: RequestInit & { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; cookies: Record<string, string> }> {
  const res = await (imp.fetch(url, opts as any) as unknown as Promise<Response>);
  const body = await res.text();
  return { status: (res as any).status, body, cookies: parseCookies(res) };
}

// ── CapSolver ─────────────────────────────────────────────────────────────────

async function solve(): Promise<string | null> {
  sep("Étape 1 : CapSolver AntiCloudflareTask → cf_clearance");
  if (!CAPSOLVER_KEY || !PROXY_URL) { console.error("❌ CAPSOLVER_API_KEY ou proxy manquant"); return null; }

  const parsed = new URL(PROXY_URL);
  const capProxy = `http://${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@${parsed.hostname}:${parsed.port || "5000"}`;

  const balR = await (await fetch(`${CAPSOLVER_BASE}/getBalance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY }), signal: AbortSignal.timeout(10_000),
  })).json() as any;
  if (balR.errorId !== 0) { console.error(`❌ Balance: ${balR.errorCode}`); return null; }
  console.log(`   💰 Balance: $${balR.balance?.toFixed(3)}`);

  const crR = await (await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY, task: { type: "AntiCloudflareTask", websiteURL: PORTAL_URL, proxy: capProxy } }),
    signal: AbortSignal.timeout(30_000),
  })).json() as any;
  if (crR.errorId !== 0) { console.error(`❌ createTask: ${crR.errorDescription}`); return null; }
  console.log(`   ✅ Task: ${crR.taskId}`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await (await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: crR.taskId }),
      signal: AbortSignal.timeout(15_000),
    })).json() as any;
    if (pr.errorId !== 0) { console.error(`❌ Poll: ${pr.errorCode}`); return null; }
    if (pr.status === "ready") {
      const cf = pr.solution?.cookies?.["cf_clearance"] || pr.solution?.token;
      console.log(`   ✅ cf_clearance: ${cf?.slice(0, 50)}…`);
      console.log(`   Tous cookies (${Object.keys(pr.solution?.cookies ?? {}).length}): ${Object.keys(pr.solution?.cookies ?? {}).join(", ")}`);
      return cf ?? null;
    }
    if (i % 3 === 0) console.log(`   ⏳ Poll #${i + 1}…`);
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(62));
  console.log("  TEST : CapSolver → /onlinebookings/main/ (citaconsular.es)");
  console.log("=".repeat(62));
  console.log(`  Proxy : ${mask(PROXY_URL)}`);
  console.log(`  BASE  : ${BASE}`);

  const cfClearance = await solve();
  if (!cfClearance) process.exit(1);

  const imp = new Impit({ browser: "chrome", ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}) } as any);
  const jar: Record<string, string> = { cf_clearance: cfClearance };

  // ── 2. GET portal (même path qu'avant) pour voir si on passe avec cf_clearance ────
  sep("Étape 2 : GET portal /es/hosteds/widgetdefault/… (avec cf_clearance)");
  {
    const { status, body, cookies } = await doFetch(imp, PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA, "Cookie": ck(jar),
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
      },
    });
    Object.assign(jar, cookies);
    const isCf = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    console.log(`   HTTP ${status} | ${body.length}B | CF: ${isCf ? "🔴 OUI" : "✅ NON"}`);
    console.log(`   Set-Cookie: ${Object.keys(cookies).join(", ") || "(aucun)"}`);
    if (!isCf && status === 200) {
      const tokenM = body.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i);
      const tok = tokenM?.[1] ?? "";
      console.log(`   ✅ Page portail chargée — token CSRF: ${tok ? tok.slice(0, 20) + "…" : "absent"}`);
      if (cookies["PHPSESSID"]) console.log(`   ✅ PHPSESSID: ${cookies["PHPSESSID"].slice(0, 12)}…`);
    }
  }
  console.log(`   Jar: ${Object.keys(jar).join(", ")}`);

  // ── 3. GET /onlinebookings/main/ SANS PHPSESSID ──────────────────────────────
  sep(`Étape 3 : GET ${BASE}main/ SANS PHPSESSID`);
  {
    const jarNoPhp = { ...jar };
    delete jarNoPhp["PHPSESSID"];
    const url = `${BASE}main/?wid=${WID}&lang=fr&v=2`;
    const { status, body, cookies } = await doFetch(imp, url, {
      headers: {
        "User-Agent": CHROME_UA, "Cookie": ck(jarNoPhp),
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      },
    });
    Object.assign(jar, cookies);
    const isCf   = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    const isBkt  = /bkt_init_widget|bkt_widget_init/i.test(body);
    const isSpa  = /BookititApp|<title>Bookitit/i.test(body);
    console.log(`   HTTP ${status} | ${body.length}B | CF:${isCf ? "🔴" : "✅"} Bookitit:${isBkt ? "✅" : "—"} SPA:${isSpa ? "⚠️" : "—"}`);
    console.log(`   Set-Cookie: ${Object.keys(cookies).join(", ") || "(aucun)"}`);
    if (body.length > 0 && !isCf) {
      console.log(`   Preview: "${body.slice(0, 200).replace(/\s+/g, " ").trim()}"`);
    }
    if (cookies["PHPSESSID"]) {
      console.log(`   ✅ /main/ pose son propre PHPSESSID: ${cookies["PHPSESSID"].slice(0, 12)}…`);
    }
  }

  // ── 4. GET /onlinebookings/main/ AVEC PHPSESSID (si dispo) ──────────────────
  if (jar["PHPSESSID"]) {
    sep(`Étape 4 : GET ${BASE}main/ AVEC PHPSESSID`);
    const url = `${BASE}main/?wid=${WID}&lang=fr&v=2`;
    const { status, body, cookies } = await doFetch(imp, url, {
      headers: {
        "User-Agent": CHROME_UA, "Cookie": ck(jar),
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      },
    });
    const isBkt = /bkt_init_widget|bkt_widget_init/i.test(body);
    const isCf  = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    console.log(`   HTTP ${status} | ${body.length}B | CF:${isCf ? "🔴" : "✅"} bkt_init_widget:${isBkt ? "✅" : "—"}`);
    if (body.length > 0) console.log(`   Preview: "${body.slice(0, 300).replace(/\s+/g, " ").trim()}"`);
    if (isBkt) console.log("   ✅✅ /main/ retourne des données Bookitit! FLOW VALIDÉ");
  } else {
    sep("Étape 4 : skippée (pas de PHPSESSID)");
  }

  // ── 5. GET /onlinebookings/getservices/ ──────────────────────────────────────
  sep(`Étape 5 : GET ${BASE}getservices/ (JSONP)`);
  {
    const url = `${BASE}getservices/?wid=${WID}&lang=fr&callback=cb_test`;
    const { status, body } = await doFetch(imp, url, {
      headers: {
        "User-Agent": CHROME_UA, "Cookie": ck(jar),
        "Accept": "text/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin",
      },
    });
    const isJsonp = /cb_test\s*\(|jQuery\d+\s*\(|\{"services/i.test(body);
    const isCf    = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    const isSpa   = /BookititApp/i.test(body);
    console.log(`   HTTP ${status} | ${body.length}B | CF:${isCf ? "🔴" : "✅"} JSONP:${isJsonp ? "✅" : "—"} SPA:${isSpa ? "⚠️" : "—"}`);
    if (body.length > 0) console.log(`   Preview: "${body.slice(0, 200).replace(/\s+/g, " ").trim()}"`);
    if (isJsonp) console.log("   ✅✅ JSONP valide! Endpoints Bookitit accessibles");
  }

  // ── Résumé ───────────────────────────────────────────────────────────────────
  sep("Résumé");
  console.log(`  cf_clearance : ✅ (CapSolver)`);
  console.log(`  PHPSESSID    : ${jar["PHPSESSID"] ? "✅ " + jar["PHPSESSID"].slice(0, 12) + "…" : "❌ manque"}`);
  console.log(`  Vrai BASE    : ${BASE}`);
  console.log(`  `);
  console.log(`  La clé : PHPSESSID vient-il de :`);
  console.log(`    • GET /es/hosteds/widgetdefault/… (portal)    → nécessite CF valide`);
  console.log(`    • GET /onlinebookings/main/ lui-même           → zone CF différente ?`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
