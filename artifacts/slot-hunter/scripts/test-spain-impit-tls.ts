#!/usr/bin/env node
/**
 * test-spain-impit-tls.ts — Diagnostic TLS session reuse pour citaconsular.es
 *
 * Teste deux hypothèses :
 *   A. Une nouvelle instance impit avec les mêmes cookies → 0B (TLS mismatch)
 *   B. La MÊME instance impit réutilisée → 200 avec contenu (TLS cohérente)
 *
 * Résultats attendus après le fix :
 *   - Probe → 200 direct OU CF challenge détecté
 *   - Si direct : même impit pour JSONP → ≥100 chars (plus de 0B)
 *   - Si CF : solveViaImpit() → cf_clearance → même impit → ≥100 chars
 *
 * Usage :
 *   SPAIN_SESSION_MODE=impit \
 *   DECODO_PROXY_URL="http://user:pass@gate.decodo.com:7777" \
 *   CAPSOLVER_API_KEY="CAP-xxx" \
 *   node_modules/.bin/tsx scripts/test-spain-impit-tls.ts
 */

import { Impit } from "impit";
import { getCurrentDecodoUrl } from "../src/spain-decodo-pool.js";
import { solveViaImpit, getSpainImpitInstance } from "../src/spain-impit-session.js";

const WIDGET_URL =
  process.env.SPAIN_WIDGET_URL ||
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const BOOKITIT_BASE =
  "https://api.bookitit.com/onlinebookings/";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const proxyUrl = getCurrentDecodoUrl() ?? process.env.SOAX_PROXY_URL ?? undefined;

function maskProxy(u: string | undefined) {
  return u ? u.replace(/:([^:@]+)@/, ":***@").slice(0, 70) + "…" : "(aucun)";
}

async function testFetch(
  label: string,
  impit: InstanceType<typeof Impit>,
  url: string,
  cookies: Array<{ name: string; value: string }>,
): Promise<void> {
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  try {
    const res = await (impit.fetch(url, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Referer": WIDGET_URL,
        "Cookie": cookieHeader,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
    } as any) as unknown as Response);
    const body = await res.text();
    const size = body.length;
    const preview = body.slice(0, 120).replace(/\s+/g, " ");
    if (size === 0) {
      console.error(`❌ [${label}] 0B — TLS mismatch probable`);
    } else if (size < 50) {
      console.warn(`⚠️  [${label}] ${size} chars (trop court) : "${preview}"`);
    } else {
      console.log(`✅ [${label}] ${size} chars : "${preview}"`);
    }
  } catch (err) {
    console.error(`❌ [${label}] Erreur réseau: ${err}`);
  }
}

async function main() {
  console.log("=== Diagnostic TLS impit citaconsular.es ===");
  console.log(`Proxy: ${maskProxy(proxyUrl)}`);
  console.log(`Widget URL: ${WIDGET_URL}`);
  console.log("");

  // ── Phase 1 : Probe direct via impit ──────────────────────────────────────
  console.log("── Phase 1 : Probe direct impit ──");
  const probeImpit = new Impit({
    browser: "chrome",
    ...(proxyUrl ? { proxyUrl } : {}),
  } as any);

  let probeBody = "";
  let probeCookies: Array<{ name: string; value: string }> = [];
  try {
    const probeRes = await (probeImpit.fetch(WIDGET_URL, {
      headers: {
        "User-Agent": CHROME_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    } as any) as unknown as Response);
    probeBody = await probeRes.text();
    const isCf = /just a moment|jetzt einen moment|verifying|_cf_chl_opt/i.test(probeBody.slice(0, 3000));
    const setCookie = probeRes.headers.get("set-cookie") ?? "";
    const phpM = setCookie.match(/PHPSESSID=([^;]+)/);
    if (phpM) probeCookies.push({ name: "PHPSESSID", value: phpM[1] });

    console.log(`   HTTP ${probeRes.status} | ${probeBody.length} chars | CF challenge: ${isCf ? "OUI ⚠️" : "NON ✅"}`);
    if (phpM) console.log(`   PHPSESSID: ${phpM[1].slice(0, 20)}…`);
  } catch (err) {
    console.error(`   ❌ Probe échoué: ${err}`);
    process.exit(1);
  }

  const isCfPage = /just a moment|jetzt einen moment|verifying|_cf_chl_opt/i.test(probeBody.slice(0, 3000));

  // ── Phase 2 : CF challenge → solveViaImpit ────────────────────────────────
  let activeCookies = probeCookies;
  let solvedImpit: InstanceType<typeof Impit> = probeImpit;

  if (isCfPage) {
    console.log("\n── Phase 2 : CF détecté → solveViaImpit ──");
    const session = await solveViaImpit(WIDGET_URL, proxyUrl);
    if (!session) {
      console.error("   ❌ solveViaImpit échoué — arrêt");
      process.exit(1);
    }
    activeCookies = session.allCookies;
    const imp = getSpainImpitInstance();
    if (imp) {
      solvedImpit = imp;
      console.log("   ✅ Instance impit solvante récupérée via getSpainImpitInstance()");
    } else {
      console.warn("   ⚠️  getSpainImpitInstance() null — utilisation du probeImpit (peut causer 0B)");
    }
    console.log(`   cf_clearance: ${session.cfClearance?.slice(0, 40)}…`);
    console.log(`   PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 20) ?? "absent"}…`);
  } else {
    console.log("\n── Phase 2 : Pas de CF — utilisation du probeImpit directement ──");
    solvedImpit = probeImpit;
  }

  // ── Phase 3a : Test JSONP avec la MÊME instance impit (doit réussir) ────
  const svcUrl = `${BOOKITIT_BASE}getservices/?wid=2d01502f12dc08400e22aea87fb00ae34&lang=fr`;
  console.log("\n── Phase 3a : JSONP avec la MÊME instance impit (attendu: ≥100 chars) ──");
  await testFetch("MÊME impit", solvedImpit, svcUrl, activeCookies);

  // ── Phase 3b : Test JSONP avec une NOUVELLE instance impit (doit retourner 0B) ─
  console.log("\n── Phase 3b : JSONP avec une NOUVELLE instance impit (attendu: 0B) ──");
  const freshImpit = new Impit({
    browser: "chrome",
    ...(proxyUrl ? { proxyUrl } : {}),
  } as any);
  await testFetch("NOUVELLE impit", freshImpit, svcUrl, activeCookies);

  console.log("\n=== Fin du diagnostic ===");
  console.log("Si Phase 3a ≥100 chars et Phase 3b = 0B → hypothèse TLS confirmée ✅");
  console.log("Si les deux retournent 0B → autre cause (IP, PHPSESSID, CF bloquage)");
  console.log("Si les deux retournent ≥100 chars → impit 'stateless' pour ce site (pas de liage TLS)");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
