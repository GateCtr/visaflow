#!/usr/bin/env node
/**
 * test-spain-impit-tls.ts — Diagnostic session CF citaconsular.es
 *
 * Flow testé :
 *   1. Probe GET impit direct → direct session OU CF challenge détecté
 *   2. Si CF : CapSolver AntiCloudflareTask (sans html) → cf_clearance
 *   3. impit + même proxy + cf_clearance → JSONP getservices/ (attendu: ≥100 chars)
 *
 * Résultats attendus :
 *   - Phase 1 direct  → session directe, JSONP réussit
 *   - Phase 1 CF      → CapSolver résout, JSONP réussit (seededClearanceAccepted pattern)
 *
 * Usage :
 *   SOAX_PROXY_URL="http://user:pass@proxy:port" \
 *   CAPSOLVER_API_KEY="CAP-xxx" \
 *   node_modules/.bin/tsx scripts/test-spain-impit-tls.ts
 */

import { Impit } from "impit";
import { solveSpainCloudflare } from "../src/spain-soax-solver.js";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";

const WIDGET_URL =
  process.env.SPAIN_WIDGET_URL ||
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const BOOKITIT_BASE = "https://api.bookitit.com/onlinebookings/";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// Priorité : SOAX_PROXY_URL (passé manuellement) > pool CSV Decodo
const proxyUrl =
  process.env.SOAX_PROXY_URL ||
  getCurrentDecodoUrl() ||
  undefined;

function maskProxy(u: string | undefined) {
  return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 80) + "…" : "(aucun — direct)";
}

async function jsonpTest(
  label: string,
  impit: InstanceType<typeof Impit>,
  cookies: Array<{ name: string; value: string }>,
): Promise<void> {
  const svcUrl = `${BOOKITIT_BASE}getservices/?wid=2d01502f12dc08400e22aea87fb00ae34&lang=fr&callback=cb`;
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  try {
    const res = await (impit.fetch(svcUrl, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Referer": WIDGET_URL,
        "Cookie": cookieHeader,
        "Sec-Fetch-Dest": "script",
        "Sec-Fetch-Mode": "no-cors",
        "Sec-Fetch-Site": "cross-site",
      },
    } as any) as unknown as Response);
    const body = await res.text();
    const size = body.length;
    if (size === 0) {
      console.error(`❌ [${label}] 0B — CF/Bookitit rejette (TLS ou session invalide)`);
    } else if (size < 50) {
      console.warn(`⚠️  [${label}] ${size} chars (trop court) : "${body.slice(0, 120)}"`);
    } else {
      console.log(`✅ [${label}] ${size} chars — JSONP OK : "${body.slice(0, 120)}"`);
    }
  } catch (err) {
    console.error(`❌ [${label}] Erreur réseau: ${err}`);
  }
}

async function main() {
  console.log("=== Diagnostic citaconsular.es — CapSolver + impit ===");
  console.log(`Proxy  : ${maskProxy(proxyUrl)}`);
  console.log(`Target : ${WIDGET_URL}`);
  console.log("");

  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) {
    console.error("❌ CAPSOLVER_API_KEY manquante");
    process.exit(1);
  }
  if (!proxyUrl) {
    console.error("❌ Aucun proxy configuré (SOAX_PROXY_URL requis)");
    process.exit(1);
  }

  // ── Phase 1 : Probe impit direct ──────────────────────────────────────────
  console.log("── Phase 1 : Probe direct impit ──");
  const probeImpit = new Impit({ browser: "chrome", proxyUrl } as any);

  let probeCookies: Array<{ name: string; value: string }> = [];
  let isCfChallenge = false;

  try {
    const probeRes = await (probeImpit.fetch(WIDGET_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);

    const body = await probeRes.text();
    isCfChallenge = /just a moment|jetzt einen moment|verifying|_cf_chl_opt/i.test(body.slice(0, 3000));

    const setCookie = probeRes.headers.get("set-cookie") ?? "";
    const phpM = setCookie.match(/PHPSESSID=([^;]+)/);
    if (phpM) probeCookies.push({ name: "PHPSESSID", value: phpM[1] });
    // Extract cf_clearance if already present (trusted IP — no challenge)
    const cfM = setCookie.match(/cf_clearance=([^;]+)/);
    if (cfM) probeCookies.push({ name: "cf_clearance", value: cfM[1] });

    console.log(
      `   HTTP ${(probeRes as any).status} | ${body.length} chars | ` +
      `CF challenge: ${isCfChallenge ? "OUI ⚠️" : "NON ✅"} | ` +
      `PHPSESSID: ${phpM ? "présent" : "absent"}`
    );
  } catch (err) {
    console.error(`   ❌ Probe échoué: ${err}`);
    process.exit(1);
  }

  let sessionCookies = probeCookies;

  if (!isCfChallenge) {
    // ── Direct session — tester JSONP immédiatement ────────────────────────
    console.log("\n── Phase 2 : Pas de CF — JSONP avec probeImpit (même TLS) ──");
    await jsonpTest("probeImpit direct", probeImpit, sessionCookies);
    return;
  }

  // ── Phase 2 : CF challenge → CapSolver AntiCloudflareTask ────────────────
  console.log("\n── Phase 2 : CF challenge → CapSolver AntiCloudflareTask ──");
  console.log("   (CapSolver ouvre Chrome sur notre proxy, clique le challenge, retourne cf_clearance)");

  const solveResult = await solveSpainCloudflare(WIDGET_URL, capKey, proxyUrl);

  if (!solveResult.success || !solveResult.session) {
    console.error(`   ❌ CapSolver échoué: ${solveResult.error}`);
    process.exit(1);
  }

  const session = solveResult.session;
  sessionCookies = session.allCookies;
  console.log(`   ✅ cf_clearance: ${session.cfClearance?.slice(0, 40)}…`);
  console.log(`   UA CapSolver: ${session.userAgent?.slice(0, 80)}`);
  console.log(`   Cookies: ${sessionCookies.map(c => c.name).join(", ")}`);

  // ── Phase 3a : JSONP avec une NOUVELLE impit (même proxy) ─────────────────
  // CF lie cf_clearance à l'IP — pas au fingerprint TLS → doit passer
  console.log("\n── Phase 3a : JSONP avec NOUVELLE impit (même proxy, cf_clearance CapSolver) ──");
  const freshImpit = new Impit({ browser: "chrome", proxyUrl } as any);
  await jsonpTest("nouvelle impit + cf_clearance CapSolver", freshImpit, sessionCookies);

  // ── Phase 3b : JSONP avec le probeImpit (différente TLS session, référence) ─
  console.log("\n── Phase 3b : JSONP avec probeImpit (référence — TLS session probe) ──");
  await jsonpTest("probeImpit + cf_clearance CapSolver", probeImpit, sessionCookies);

  console.log("\n=== Fin ===");
  console.log("Si 3a ✅ → CF lie à l'IP (pas TLS) — architecture CapSolver+impit validée");
  console.log("Si 3a ❌ et 3b ✅ → CF lie à la TLS session — impossible sans même instance");
  console.log("Si les deux ❌ → problème PHPSESSID ou IP bloquée");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
