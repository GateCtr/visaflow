#!/usr/bin/env node
/**
 * test-capsolver-main-direct.ts
 *
 * Teste si le flow CapSolver → /main/ fonctionne SANS passer par le portail
 * citaconsular.es (qui rejette impit + cf_clearance CapSolver).
 *
 * Hypothèse : webapp.bookitit.com est une zone CF différente, moins stricte.
 *   1. CapSolver AntiCloudflareTask sur portal URL → cf_clearance
 *   2. impit GET /main/?wid=…  (SANS PHPSESSID)  → Bookitit répond ?
 *      → Si Set-Cookie: PHPSESSID → Bookitit le pose lui-même (portal non nécessaire)
 *      → Si 0B → PHPSESSID obligatoire avant /main/
 *   3. Si PHPSESSID reçu → GET getservices/ → valide le flow
 *
 * Usage : node_modules/.bin/tsx scripts/test-capsolver-main-direct.ts
 */

import { Impit } from "impit";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PROXY_URL =
  process.env.SOAX_PROXY_URL ||
  getCurrentDecodoUrl() ||
  undefined;

const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const CAPSOLVER_BASE = "https://api.capsolver.com";

// Widget Kinshasa
const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID = "2d01502f12dc08400e22aea87fb00ae34";
const BOOKITIT_BASE = "https://webapp.bookitit.com/onlinebookings/";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mask(u: string | undefined) {
  return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 80) : "(aucun proxy)";
}
function sep(t: string) {
  console.log(`\n${"─".repeat(60)}\n── ${t}\n${"─".repeat(60)}`);
}

function parseCookies(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  const raw = (res as any).headers?.get?.("set-cookie") ?? "";
  if (!raw) return jar;
  for (const part of raw.split(/,\s*(?=[A-Za-z_][^=,]*=)/)) {
    const first = part.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq > 0) {
      jar[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
    }
  }
  return jar;
}

function cookieStr(jar: Record<string, string>) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// ─── CapSolver ────────────────────────────────────────────────────────────────

async function capsolver(): Promise<string | null> {
  sep("Étape 1 : CapSolver → cf_clearance");

  if (!CAPSOLVER_KEY) { console.error("❌ CAPSOLVER_API_KEY manquante"); return null; }
  if (!PROXY_URL)     { console.error("❌ Proxy manquant"); return null; }

  const parsed = new URL(PROXY_URL);
  const capProxy = `http://${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@${parsed.hostname}:${parsed.port || "5000"}`;
  console.log(`   Proxy: ${mask(capProxy)}`);

  // Balance
  const balRes = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY }),
    signal: AbortSignal.timeout(10_000),
  });
  const bal = (await balRes.json()) as any;
  if (bal.errorId !== 0) { console.error(`❌ Balance: ${bal.errorCode}`); return null; }
  console.log(`   💰 Balance: $${bal.balance?.toFixed(3)}`);

  // Create task
  const cr = await fetch(`${CAPSOLVER_BASE}/createTask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_KEY,
      task: { type: "AntiCloudflareTask", websiteURL: PORTAL_URL, proxy: capProxy },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const cd = (await cr.json()) as any;
  if (cd.errorId !== 0 || !cd.taskId) { console.error(`❌ createTask: ${cd.errorDescription}`); return null; }
  console.log(`   ✅ Task: ${cd.taskId}`);

  // Poll
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5_000));
    const pr = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: cd.taskId }),
      signal: AbortSignal.timeout(15_000),
    });
    const pd = (await pr.json()) as any;
    if (pd.errorId !== 0) { console.error(`❌ Poll: ${pd.errorCode}`); return null; }
    if (pd.status === "ready") {
      const cf = pd.solution?.cookies?.["cf_clearance"] || pd.solution?.token;
      console.log(`   ✅ cf_clearance: ${cf?.slice(0, 50)}…`);
      // Logger TOUS les cookies (peut inclure PHPSESSID si CapSolver navigue la page)
      const allCookies = pd.solution?.cookies ?? {};
      console.log(`   Tous les cookies CapSolver (${Object.keys(allCookies).length}): ${Object.keys(allCookies).join(", ")}`);
      for (const [k, v] of Object.entries(allCookies)) {
        console.log(`     ${k} = ${String(v).slice(0, 60)}`);
      }
      return cf ?? null;
    }
    if (i % 3 === 0) console.log(`   ⏳ Poll #${i + 1}…`);
  }
  console.error("❌ Timeout"); return null;
}

// ─── Test /main/ SANS PHPSESSID ───────────────────────────────────────────────

async function testMainDirect(imp: InstanceType<typeof Impit>, jar: Record<string, string>) {
  sep("Étape 2 : GET /main/ SANS PHPSESSID (Bookitit direct)");

  const url = `${BOOKITIT_BASE}main/?wid=${WID}&lang=fr&v=2`;
  console.log(`   GET ${url}`);
  console.log(`   Cookie envoyé: ${cookieStr(jar).slice(0, 100)}…`);

  const res = await (imp.fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      "Accept": "text/html,*/*;q=0.9",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Cookie": cookieStr(jar),
      "Referer": PORTAL_URL,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    },
  } as any) as unknown as Response);

  const body = await res.text();
  const sc = parseCookies(res);
  console.log(`   HTTP ${(res as any).status} | ${body.length} chars`);
  console.log(`   Set-Cookie: ${Object.keys(sc).join(", ") || "(aucun)"}`);

  if (sc["PHPSESSID"]) {
    console.log(`   ✅ PHPSESSID reçu depuis /main/: ${sc["PHPSESSID"].slice(0, 12)}…`);
    console.log("   → Bookitit pose le PHPSESSID lui-même (portail citaconsular.es non nécessaire!)");
  } else {
    console.log("   ❌ Pas de PHPSESSID → /main/ nécessite PHPSESSID préalable");
  }

  if (body.length === 0) {
    console.log("   ❌ 0B — sans PHPSESSID Bookitit ne répond pas");
  } else {
    console.log(`   Preview: "${body.slice(0, 200).replace(/\s+/g, " ").trim()}"`);
    if (/bkt_init_widget|bkt_widget_init/i.test(body)) {
      console.log("   ✅ bkt_init_widget détecté → données Bookitit présentes");
    }
  }

  return sc;
}

// ─── Test /main/ AVEC PHPSESSID (si reçu) ────────────────────────────────────

async function testMainWithPhpSessId(imp: InstanceType<typeof Impit>, jar: Record<string, string>) {
  sep("Étape 3 : GET /main/ AVEC PHPSESSID");

  const url = `${BOOKITIT_BASE}main/?wid=${WID}&lang=fr&v=2`;
  console.log(`   GET ${url}`);
  console.log(`   Cookie: ${cookieStr(jar).slice(0, 120)}`);

  const res = await (imp.fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      "Accept": "text/html,*/*;q=0.9",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Cookie": cookieStr(jar),
      "Referer": PORTAL_URL,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    },
  } as any) as unknown as Response);

  const body = await res.text();
  console.log(`   HTTP ${(res as any).status} | ${body.length} chars`);

  if (body.length === 0) {
    console.log("   ❌ 0B — PHPSESSID reçu mais /main/ reste vide");
    console.log("   → PHPSESSID de /main/ n'est peut-être pas le bon (cf citaconsular.es PHP)");
  } else {
    console.log(`   Preview: "${body.slice(0, 300).replace(/\s+/g, " ").trim()}"`);
    if (/bkt_init_widget|bkt_widget_init/i.test(body)) {
      console.log("   ✅ SUCCÈS — /main/ retourne des données Bookitit!");
    }
  }
}

// ─── Test getservices/ ────────────────────────────────────────────────────────

async function testServices(imp: InstanceType<typeof Impit>, jar: Record<string, string>) {
  sep("Étape 4 : GET getservices/ (JSONP)");

  const url = `${BOOKITIT_BASE}getservices/?wid=${WID}&lang=fr&callback=cb`;
  console.log(`   GET ${url}`);

  const res = await (imp.fetch(url, {
    headers: {
      "User-Agent": CHROME_UA,
      "Accept": "text/javascript, */*; q=0.01",
      "Cookie": cookieStr(jar),
      "Referer": PORTAL_URL,
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "cross-site",
    },
  } as any) as unknown as Response);

  const body = await res.text();
  console.log(`   HTTP ${(res as any).status} | ${body.length} chars`);

  if (body.length === 0) {
    console.log("   ❌ 0B");
  } else {
    console.log(`   Preview: "${body.slice(0, 200).replace(/\s+/g, " ")}")`);
    if (/cb\(|\{"services/i.test(body)) {
      console.log("   ✅ JSONP valide");
    } else if (/<!DOCTYPE/i.test(body)) {
      console.log("   ⚠️  HTML retourné (pas de JSONP) — session invalide ou CF block");
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  TEST : CapSolver → /main/ DIRECT (bypass portail)");
  console.log("=".repeat(60));
  console.log(`  Proxy  : ${mask(PROXY_URL)}`);

  // 1. CapSolver
  const cfClearance = await capsolver();
  if (!cfClearance) { process.exit(1); }

  const imp = new Impit({ browser: "chrome", ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}) } as any);

  // Cookie jar avec juste cf_clearance
  const jar: Record<string, string> = { cf_clearance: cfClearance };

  // 2. /main/ sans PHPSESSID
  const step2Cookies = await testMainDirect(imp, jar);
  Object.assign(jar, step2Cookies);

  if (jar["PHPSESSID"]) {
    // 3. /main/ avec PHPSESSID reçu de Bookitit
    await testMainWithPhpSessId(imp, jar);
  } else {
    // Pas de PHPSESSID → essayer getservices/ quand même (peut fonctionner sans)
    sep("Étape 3 : skippée (pas de PHPSESSID de /main/)");
    console.log("   → /main/ nécessite un PHPSESSID venant du portail citaconsular.es");
    console.log("   → Le portail rejette impit+cf_clearance CapSolver (TLS bound)");
    console.log("   → Solution : obtenir PHPSESSID via CapSolver Chrome (navigation étendue)");
  }

  // 4. getservices/ (indépendant du PHPSESSID pour voir si CF zone OK)
  await testServices(imp, jar);

  sep("Résumé");
  console.log(`  cf_clearance    : ✅`);
  console.log(`  PHPSESSID       : ${jar["PHPSESSID"] ? "✅ (posé par Bookitit)" : "❌ (manque)"}`);
  console.log(`  /main/ direct   : ${jar["PHPSESSID"] ? "🔄 à valider" : "❌"}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
