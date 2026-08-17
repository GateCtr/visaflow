/**
 * test-full-cycle-scan.ts — Teste le cycle complet (main → cfg → services → agendas → datetime)
 * répété 3 fois, en réutilisant la même session CF (cf_clearance + impit).
 *
 * Objectif : vérifier que /main/ peut être rappelé à chaque cycle (nouveau PHPSESSID)
 * et que la chaîne complète retourne du JSONP valide à chaque itération.
 *
 * USAGE :
 *   npx tsx src/scripts/test-full-cycle-scan.ts [URL_WIDGET] [PROXY_URL]
 */

import { Impit } from "impit";
import "dotenv/config";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  buildDynamicSession,
  callDirect,
  parseDirectJsonp,
  makeDirectUrl,
  makeDirectHeaders,
  CALL_DIRECT_NETWORK_ERROR,
  type DynamicSession,
} from "../spain-bookitit-direct.js";
import type { SpainCfSession } from "../spain-soax-solver.js";

// ── Config ────────────────────────────────────────────────────────────────────
const WIDGET_URL = process.argv[2] || "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.argv[3] || (process.env.SPAIN_ISP_PROXY_URL ?? process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "");
const NUM_CYCLES = 3;

function log(msg: string): void {
  console.log(`[test-full-cycle] ${msg}`);
}

function section(title: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  section("CONFIG");
  log(`Widget    : ${WIDGET_URL}`);
  log(`Proxy     : ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "(direct)"}`);
  log(`CapSolver : ${CAPSOLVER_API_KEY ? "✅" : "❌ (manquant)"}`);
  log(`Cycles    : ${NUM_CYCLES}`);

  if (!CAPSOLVER_API_KEY) {
    console.error("❌ CAPSOLVER_API_KEY requis");
    process.exit(1);
  }

  // ── Sticky session Decodo ───────────────────────────────────────────────────
  const stickyId = Math.random().toString(36).slice(2, 10);
  let stickyProxy = PROXY_URL;
  if (PROXY_URL && PROXY_URL.includes("sessionduration")) {
    // Injecter un sticky session ID
    try {
      const u = new URL(PROXY_URL);
      const user = decodeURIComponent(u.username);
      const stickyUser = user.includes("-session-")
        ? user.replace(/-session-[^-]+/, `-session-${stickyId}`)
        : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${stickyId}$2`);
      u.username = encodeURIComponent(stickyUser);
      stickyProxy = u.toString();
    } catch { /* keep original */ }
  }
  log(`Sticky    : sid=${stickyId}`);

  // ── Étape 1 : Établir la session CF (une seule fois) ────────────────────────
  section("1 — INIT SESSION CF (solve CapSolver)");
  const portalUrl = WIDGET_URL.split("#")[0];
  const initResult = await initWorkerSession(stickyProxy, portalUrl, CAPSOLVER_API_KEY);
  if (!initResult) {
    console.error("❌ initWorkerSession échoué — proxy bloqué ou solve raté");
    process.exit(1);
  }
  const { session, impit } = initResult;
  log(`✅ Session CF établie — PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 12) ?? "?"}`);
  log(`   cf_clearance: ${session.cfClearance.slice(0, 30)}…`);
  log(`   /main/ prefetch: ${session.prefetchedMainHtml?.length ?? 0}B`);

  // ── Étape 2 : Cycles complets (main → cfg → services → agendas → datetime) ─
  for (let cycle = 1; cycle <= NUM_CYCLES; cycle++) {
    section(`CYCLE ${cycle}/${NUM_CYCLES} — Full scan (main → cfg → svc → ag → dt)`);
    const cycleT0 = Date.now();

    // Construire DynamicSession à partir de la session CF
    const ds = buildDynamicSession(session);
    if (!ds) {
      log("❌ buildDynamicSession échoué");
      break;
    }

    // ── GET /main/ ──────────────────────────────────────────────────────────────
    log("📡 GET main/ …");
    const mainUrl = makeDirectUrl(ds, "main/");
    const mainHeaders = makeDirectHeaders(ds);
    let mainRaw = "";
    try {
      const r = await (ds.impit.fetch(mainUrl, { headers: mainHeaders } as any) as unknown as Promise<Response>);
      mainRaw = await r.text();
      // Extraire Set-Cookie PHPSESSID si le serveur en pose un nouveau
      const setCookie = r.headers.get("set-cookie") ?? "";
      const phpMatch = setCookie.match(/PHPSESSID=([^;]+)/);
      if (phpMatch) {
        ds.jar.PHPSESSID = phpMatch[1];
        // Mettre à jour aussi dans la session pour le prochain buildDynamicSession
        const idx = session.allCookies.findIndex(c => c.name === "PHPSESSID");
        if (idx >= 0) session.allCookies[idx].value = phpMatch[1];
        else session.allCookies.push({ name: "PHPSESSID", value: phpMatch[1] });
      }
      log(`   main/ → ${mainRaw.length}B | HTTP ${r.status} | PHPSESSID: ${ds.jar.PHPSESSID?.slice(0, 12) ?? "❌"}`);
      // Vérifier si c'est du JSONP valide
      const mainParsed = parseDirectJsonp(mainRaw);
      log(`   JSONP parsable: ${mainParsed !== null ? "✅" : "❌ (HTML?)"} | preview: ${mainRaw.slice(0, 100).replace(/\n/g, " ")}…`);
    } catch (e) {
      log(`   ❌ main/ erreur: ${e}`);
      continue;
    }

    // ── getwidgetconfigurations/ ────────────────────────────────────────────────
    log("📡 GET getwidgetconfigurations/ …");
    const cfgPayload = await callDirect(ds, "getwidgetconfigurations/");
    const cfgOk = cfgPayload !== null && cfgPayload !== CALL_DIRECT_NETWORK_ERROR;
    log(`   cfg/ → ${JSON.stringify(cfgPayload ?? "").length}B | ok=${cfgOk}`);

    // ── getservices/ ────────────────────────────────────────────────────────────
    log("📡 GET getservices/ …");
    const svcPayload = await callDirect(ds, "getservices/") as any;
    const svcOk = svcPayload !== null && svcPayload !== CALL_DIRECT_NETWORK_ERROR;
    const services: Array<{ id: string; name: string }> = svcPayload?.Services ?? svcPayload?.services ?? [];
    log(`   svc/ → ${JSON.stringify(svcPayload ?? "").length}B | ok=${svcOk} | services=${services.length}`);
    if (services.length > 0) {
      log(`   services: ${services.map(s => `${s.id}="${(s.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 30)}"`).join(", ")}`);
    }
    const allowAppt = svcPayload?.AllowAppointment ?? svcPayload?.allowAppointment;
    log(`   AllowAppointment: ${allowAppt}`);

    // ── getagendas/ ─────────────────────────────────────────────────────────────
    const bestSvc = services.find(s => s.id) ?? null;
    if (!bestSvc) {
      log("   ⚠️ Pas de service → skip getagendas/ + datetime/");
      log(`   ⏱ Cycle ${cycle} en ${Date.now() - cycleT0}ms`);
      await sleep(5000);
      continue;
    }

    log(`📡 GET getagendas/ (service=${bestSvc.id}) …`);
    const agPayload = await callDirect(ds, "getagendas/", {
      "services[]": bestSvc.id,
      selectedPeople: "1",
    }) as any;
    const agOk = agPayload !== null && agPayload !== CALL_DIRECT_NETWORK_ERROR;
    const agendas: Array<{ id: string }> = agPayload?.Agendas ?? agPayload?.agendas ?? [];
    const agendaId = agendas.find(a => a?.id)?.id ?? "";
    log(`   ag/ → ${JSON.stringify(agPayload ?? "").length}B | ok=${agOk} | agendas=${agendas.length} | agendaId="${agendaId}"`);

    // ── datetime/ (mois courant + 2 suivants) ───────────────────────────────────
    if (!agendaId) {
      log("   ⚠️ Agenda vide → pas de créneau disponible (comportement attendu)");
      log(`   ⏱ Cycle ${cycle} en ${Date.now() - cycleT0}ms`);
      await sleep(5000);
      continue;
    }

    log(`📡 GET datetime/ (3 mois, service=${bestSvc.id}, agenda=${agendaId}) …`);
    const now = new Date();
    for (let m = 0; m < 3; m++) {
      const d = new Date(now.getFullYear(), now.getMonth() + m, 1);
      const startStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const endStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      const dtPayload = await callDirect(ds, "datetime/", {
        "services[]": bestSvc.id,
        "agendas[]": agendaId,
        start: startStr,
        end: endStr,
        selectedPeople: "1",
      });
      const dtOk = dtPayload !== null && dtPayload !== CALL_DIRECT_NETWORK_ERROR;
      const dtBytes = JSON.stringify(dtPayload ?? "").length;
      log(`   ${monthLabel}: ${dtBytes}B | ok=${dtOk}`);
    }

    log(`   ⏱ Cycle ${cycle} en ${Date.now() - cycleT0}ms`);

    // Pause inter-cycle (comme le worker ferait)
    if (cycle < NUM_CYCLES) {
      log("   ⏳ Pause 10s avant prochain cycle…");
      await sleep(10_000);
    }
  }

  section("RÉSULTAT");
  log("✅ Test terminé — vérifier que chaque cycle a des réponses JSONP valides");
  log("   Si main/ retourne du HTML (pas JSONP), c'est normal — il rend le widget.");
  log("   L'important est que cfg/, svc/, ag/, dt/ retournent du JSONP (ok=true).");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
