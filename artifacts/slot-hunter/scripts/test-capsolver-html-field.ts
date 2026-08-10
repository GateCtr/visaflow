#!/usr/bin/env node
/**
 * test-capsolver-html-field.ts
 *
 * Deux tests en parallèle :
 *
 * TEST A — /main/ avec params COMPLETS (callback, publickey, type, version, src)
 *   → Peut-être que "no callback found" était juste des params incorrects, pas PHPSESSID
 *
 * TEST B — AntiCloudflareTask avec champ `html` (CF challenge HTML du probe impit)
 *   → La doc dit "we need this html for some websites" → peut lier le cf_clearance à
 *     la session TLS impit (pas celle de CapSolver Chrome)
 *
 * Usage : node_modules/.bin/tsx scripts/test-capsolver-html-field.ts
 */

import { Impit } from "impit";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

const PROXY_URL = process.env.SOAX_PROXY_URL || getCurrentDecodoUrl() || undefined;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const CAPSOLVER_BASE = "https://api.capsolver.com";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const WID     = "2d01502f12dc08400e22aea87fb00ae34";
const BASE    = "https://www.citaconsular.es/onlinebookings/";
const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function mask(u?: string) { return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 80) : "(direct)"; }
function sep(t: string) { console.log(`\n${"═".repeat(62)}\n  ${t}\n${"═".repeat(62)}`); }

// ─── Probe impit → CF challenge HTML ─────────────────────────────────────────

async function probeAndGetChallengeHtml(imp: InstanceType<typeof Impit>): Promise<string> {
  console.log("  [probe] GET portal via impit…");
  try {
    const res = await (imp.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);
    const body = await res.text();
    const isCf = /just a moment|_cf_chl_opt|challenge-platform/i.test(body.slice(0, 3000));
    console.log(`  [probe] HTTP ${(res as any).status} | ${body.length}B | CF: ${isCf ? "✅ (challenge détecté)" : "❌ (accès direct!)"}`);
    if (isCf) {
      const cTypeM = body.match(/["']cType["']\s*:\s*["']([^"']+)["']/);
      console.log(`  [probe] cType: ${cTypeM?.[1] ?? "inconnu"}`);
    }
    return body;
  } catch (e) {
    console.log(`  [probe] Erreur: ${e}`);
    return "";
  }
}

// ─── CapSolver — avec ou sans html ───────────────────────────────────────────

async function solveCapSolver(label: string, html?: string): Promise<string | null> {
  if (!CAPSOLVER_KEY || !PROXY_URL) { console.error(`  [${label}] ❌ config manquante`); return null; }

  const parsed = new URL(PROXY_URL);
  const capProxy = `http://${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}@${parsed.hostname}:${parsed.port || "5000"}`;

  const task: Record<string, string> = {
    type: "AntiCloudflareTask",
    websiteURL: PORTAL_URL,
    proxy: capProxy,
    userAgent: CHROME_UA,
  };
  if (html) {
    // Tronquer à 32KB max (certains services refusent les HTML trop longs)
    task["html"] = html.slice(0, 32_000);
    console.log(`  [${label}] Envoi avec html (${task["html"].length} chars tronqués)`);
  } else {
    console.log(`  [${label}] Envoi SANS html`);
  }

  try {
    const cr = await (await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, task }),
      signal: AbortSignal.timeout(30_000),
    })).json() as any;

    if (cr.errorId !== 0) {
      console.error(`  [${label}] ❌ createTask: ${cr.errorDescription ?? cr.errorCode}`);
      return null;
    }
    console.log(`  [${label}] ✅ Task: ${cr.taskId}`);

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const pr = await (await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: cr.taskId }),
        signal: AbortSignal.timeout(15_000),
      })).json() as any;

      if (pr.errorId !== 0) {
        console.error(`  [${label}] ❌ Poll erreur: ${pr.errorCode ?? pr.errorId}`);
        return null;
      }
      if (pr.status === "ready") {
        const cf = pr.solution?.cookies?.["cf_clearance"] || pr.solution?.token;
        const allKeys = Object.keys(pr.solution?.cookies ?? {});
        console.log(`  [${label}] ✅ Résolu (${(i + 1) * 5}s) — cookies: [${allKeys.join(", ")}]`);
        return cf ?? null;
      }
      if (i % 3 === 0) console.log(`  [${label}] ⏳ Poll #${i + 1}…`);
    }
    return null;
  } catch (e) {
    console.error(`  [${label}] ❌ Erreur: ${e}`);
    return null;
  }
}

// ─── TEST A : /main/ avec params COMPLETS ─────────────────────────────────────

async function testAMainWithFullParams(imp: InstanceType<typeof Impit>, cfClearance: string) {
  sep("TEST A — /main/ avec params COMPLETS (callback, publickey, type…)");

  // Params exacts du test-spain-decodo-unlocker.ts qui marchait en prod
  const cbName = `jQuery${Date.now()}`;
  const q = new URLSearchParams({
    callback: cbName,
    type: "default",
    publickey: WID,
    lang: "es",
    version: "4",
    src: PORTAL_URL,
    _: String(Date.now()),
  });
  const url = `${BASE}main/?${q}`;
  console.log(`  GET ${url.slice(0, 100)}…`);
  console.log(`  (SANS PHPSESSID, AVEC cf_clearance + params complets)`);

  try {
    const res = await (imp.fetch(url, {
      headers: {
        "User-Agent": CHROME_UA,
        "Cookie": `cf_clearance=${cfClearance}`,
        "Accept": "*/*",
        "Accept-Language": "es-ES,es;q=0.9",
        "Referer": PORTAL_URL,
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Ch-Ua": `"Not/A)Brand";v="8", "Chromium";v="136", "Google Chrome";v="136"`,
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const st   = (res as any).status as number;
    const setCk = (res as any).headers?.get?.("set-cookie") ?? "";
    const php = setCk.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";

    const isCf   = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));
    const isErr  = /no callback found|Exception|error/i.test(body.slice(0, 200));
    const isBkt  = /bkt_init_widget|bkt_widget_init|srvsrc/i.test(body);
    const isJsonp = body.startsWith(cbName) || new RegExp(`^${cbName}\\s*\\(`).test(body.slice(0, 50));

    console.log(`  HTTP ${st} | ${body.length}B`);
    console.log(`  CF:${isCf ? "🔴" : "✅"} JSONP:${isJsonp ? "✅" : "—"} bkt:${isBkt ? "✅" : "—"} err:${isErr ? "⚠️" : "—"} PHPSESSID_set:${php ? "✅" : "—"}`);
    console.log(`  Preview: "${body.slice(0, 250).replace(/\s+/g, " ").trim()}"`);

    if (isJsonp || isBkt) {
      console.log("\n  🎉 TEST A SUCCÈS — /main/ retourne des données sans PHPSESSID!");
      console.log("     → Les params complets (callback/publickey/src) suffisent");
    } else if (!isCf && !isErr) {
      console.log("  ℹ️  Réponse non-CF, non-erreur — analyser le contenu");
    }
  } catch (e) {
    console.error(`  ❌ Erreur: ${e}`);
  }
}

// ─── TEST B : portal GET avec cf_clearance du solve html-field ────────────────

async function testBPortalWithHtmlSolve(imp: InstanceType<typeof Impit>, cfClearance: string) {
  sep("TEST B — GET portal avec cf_clearance obtenu VIA html field");
  console.log("  (Si html field lie le cf_clearance à la TLS impit → 200 !)");

  try {
    const res = await (imp.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Cookie": `cf_clearance=${cfClearance}`,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none", "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);

    const body = await res.text();
    const st   = (res as any).status as number;
    const setCk = (res as any).headers?.get?.("set-cookie") ?? "";
    const php = setCk.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
    const isCf = /just a moment|_cf_chl_opt/i.test(body.slice(0, 2000));

    console.log(`  HTTP ${st} | ${body.length}B | CF:${isCf ? "🔴 ENCORE bloqué" : "✅ PASSÉ!"}`);
    if (php) console.log(`  ✅ PHPSESSID: ${php.slice(0, 12)}…`);
    if (!isCf) {
      console.log("\n  🎉 TEST B SUCCÈS — html field lie le cf_clearance à la TLS impit!");
      const tokenM = body.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i);
      console.log(`  Token CSRF: ${tokenM?.[1]?.slice(0, 20) ?? "absent"}`);
    }
    console.log(`  Preview: "${body.slice(0, 200).replace(/\s+/g, " ").trim()}"`);
  } catch (e) {
    console.error(`  ❌ Erreur: ${e}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(62));
  console.log("  TESTS A + B — CapSolver html field + /main/ params complets");
  console.log("=".repeat(62));
  console.log(`  Proxy: ${mask(PROXY_URL)}`);

  // Instance impit partagée — probe en premier pour établir session TLS
  const imp = new Impit({ browser: "chrome", ...(PROXY_URL ? { proxyUrl: PROXY_URL } : {}) } as any);

  // Probe → obtenir le HTML du CF challenge
  const challengeHtml = await probeAndGetChallengeHtml(imp);

  // Lancer les 2 solves en parallèle (économie de temps)
  console.log("\n  Lancement solve A (sans html) et solve B (avec html) en parallèle…");
  const [cfA, cfB] = await Promise.all([
    solveCapSolver("solve-A-sans-html"),
    challengeHtml ? solveCapSolver("solve-B-avec-html", challengeHtml) : Promise.resolve(null),
  ]);

  console.log(`\n  cf_clearance A (sans html): ${cfA ? "✅" : "❌"}`);
  console.log(`  cf_clearance B (avec html): ${cfB ? "✅" : "❌"}`);

  // TEST A — /main/ avec params complets (n'importe quel cfClearance)
  if (cfA) {
    await testAMainWithFullParams(imp, cfA);
  }

  // TEST B — portal GET avec cfClearance du solve html
  if (cfB) {
    await testBPortalWithHtmlSolve(imp, cfB);
  } else if (!challengeHtml) {
    sep("TEST B — skippé (probe sans CF challenge — accès direct)");
  } else {
    sep("TEST B — skippé (solve avec html échoué)");
    console.log("  → ERROR_INVALID_TASK_DATA probable pour cType:interactive");
  }

  sep("Résumé");
  console.log(`  TEST A (params complets /main/) : ${cfA ? "exécuté" : "non exécuté"}`);
  console.log(`  TEST B (html field portal)      : ${cfB ? "exécuté" : cfB === null && challengeHtml ? "❌ solve échoué" : "non exécuté"}`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
