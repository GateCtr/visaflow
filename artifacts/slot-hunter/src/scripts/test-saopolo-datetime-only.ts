/**
 * test-saopolo-datetime-only.ts — Mesure le temps d'un cycle datetime-only
 * vs le cycle complet refreshSessionAndScan sur São Paulo.
 *
 * HYPOTHÈSE : Si on skip l'init PHP (déjà fait au cycle 1) et qu'on appelle
 * uniquement datetime/ avec la session existante, le cycle devrait passer
 * de ~50-60s à ~1-2s.
 *
 * FLOW :
 *   1. Init session CF (CapSolver + sticky proxy)
 *   2. initPhpState one-shot (getwidgetcfg + getservices + getagendas)
 *   3. Boucle A : scanDatetimeDirect × N (datetime-only)  ← mesure timing
 *   4. Boucle B : refreshSessionAndScan × N (cycle complet) ← mesure timing
 *   5. Comparaison des temps
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-saopolo-datetime-only.ts
 */

import "dotenv/config";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  initPhpState,
  scanDatetimeDirect,
  refreshSessionAndScan,
  type SpainDossierConfig,
  type WorkerPhpState,
} from "../spain-dossier-worker.js";
import { SAOPOLO_PORTAL_URL } from "../spain-portals.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
// Sao Paulo exige un proxy résidentiel (ISP → 0B sur /main/).
// Prioriser SPAIN_RESIDENTIAL_PROXY_URL, puis 1ère ligne de decodo-proxies.csv, puis ISP fallback.
const PROXY_URL = await (async () => {
  if (process.env.SPAIN_RESIDENTIAL_PROXY_URL) return process.env.SPAIN_RESIDENTIAL_PROXY_URL;
  // Lire le CSV (proxies résidentiels es.decodo.com)
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const csvPath = path.resolve(import.meta.dirname ?? ".", "..", "..", "decodo-proxies.csv");
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length > 0) return lines[0].trim();
  } catch { /* ignore */ }
  return process.env.SPAIN_ISP_PROXY_URL ?? "";
})();
const DATETIME_ONLY_CYCLES = 5;   // Nombre de cycles datetime-only
const FULL_CYCLE_COUNT = 3;        // Nombre de cycles complets (plus longs)
const INTER_CYCLE_DELAY_MS = 1500; // Délai entre cycles (anti-détection)

const TAG = "[test-dt-only]";

// ─── Config dossier fictif ────────────────────────────────────────────────────
const config: SpainDossierConfig = {
  id: "test-datetime-only",
  applicantName: "TEST DATETIME ONLY",
  visaType: "schengen",
  login: "TESTPASSPORT000",
  password: "testpass000",
  applicationId: "TEST-DT-ONLY-000",
  otpChannel: "manual",
  portalUrl: SAOPOLO_PORTAL_URL,
  groupSize: 1,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(msg: string): void { console.log(`[${ts()}] ${msg}`); }
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface CycleMeasure {
  cycle: number;
  durationMs: number;
  status: string;
  slotsFound: number;
}

async function main(): Promise<void> {
  section("TEST : datetime-only vs cycle complet — São Paulo");

  // ── Vérification pré-requis ─────────────────────────────────────────────────
  if (!CAPSOLVER_API_KEY) {
    console.error("❌ CAPSOLVER_API_KEY requis");
    process.exit(1);
  }
  if (!PROXY_URL) {
    console.error("❌ SPAIN_RESIDENTIAL_PROXY_URL ou SPAIN_ISP_PROXY_URL requis");
    process.exit(1);
  }

  log(`Portail  : ${SAOPOLO_PORTAL_URL.slice(-50)}`);
  log(`Proxy    : ${PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}`);
  log(`Cycles A : ${DATETIME_ONLY_CYCLES} (datetime-only)`);
  log(`Cycles B : ${FULL_CYCLE_COUNT} (refreshSessionAndScan)`);

  // ── 1. Init session CF ──────────────────────────────────────────────────────
  section("PHASE 1 — Init session CF (CapSolver + sticky proxy)");
  const stickyId = Math.random().toString(36).slice(2, 10);
  let stickyProxy = PROXY_URL;

  // Ajouter sticky session si le proxy supporte sessionduration
  if (PROXY_URL.includes("sessionduration") || PROXY_URL.includes("session-")) {
    try {
      const u = new URL(PROXY_URL);
      const user = decodeURIComponent(u.username);
      const stickyUser = user.includes("-session-")
        ? user.replace(/-session-[^-]+/, `-session-${stickyId}`)
        : `${user}-session-${stickyId}`;
      u.username = encodeURIComponent(stickyUser);
      stickyProxy = u.toString();
    } catch { /* keep original */ }
  }

  const portalUrlNoFrag = SAOPOLO_PORTAL_URL.split("#")[0];
  const initT0 = Date.now();
  const initResult = await initWorkerSession(stickyProxy, portalUrlNoFrag, CAPSOLVER_API_KEY);
  const initDuration = Date.now() - initT0;

  if (!initResult) {
    console.error("❌ initWorkerSession échoué — vérifier proxy/capsolver");
    process.exit(1);
  }

  const { session, cfFromCache } = initResult;
  log(`✅ Session CF établie en ${(initDuration / 1000).toFixed(1)}s — cfFromCache=${cfFromCache}`);
  log(`   /main/ = ${session.prefetchedMainHtml?.length ?? 0}B | PHPSESSID présent`);

  // ── 2. PHP init one-shot ────────────────────────────────────────────────────
  section("PHASE 2 — initPhpState (getwidgetcfg + getservices + getagendas)");
  const phpT0 = Date.now();
  const phpState = await initPhpState(session, config, TAG);
  const phpDuration = Date.now() - phpT0;

  if (!phpState) {
    console.error("❌ initPhpState échoué — aucun service/agenda trouvé");
    process.exit(1);
  }

  log(`✅ PHP init en ${(phpDuration / 1000).toFixed(1)}s`);
  log(`   Services: ${phpState.services.length} | Best: "${phpState.bestServiceName}" (${phpState.bestServiceId})`);
  log(`   AgendaId: ${phpState.agendaId || "(vide = pas de créneaux?)"}`);

  if (!phpState.agendaId) {
    log("⚠️  Pas d'agenda — Sao Paulo n'a peut-être pas de créneaux maintenant.");
    log("   Le test datetime-only va quand même tourner (résultat attendu: not_found).");
  }

  // ── 3. BOUCLE A : datetime-only (scanDatetimeDirect) ───────────────────────
  section(`PHASE 3 — BOUCLE A : scanDatetimeDirect × ${DATETIME_ONLY_CYCLES} (datetime-only)`);
  const dtOnlyResults: CycleMeasure[] = [];

  for (let i = 1; i <= DATETIME_ONLY_CYCLES; i++) {
    if (i > 1) await sleep(INTER_CYCLE_DELAY_MS);

    const cycleT0 = Date.now();
    const result = await scanDatetimeDirect(phpState, config, `${TAG}[A${i}]`);
    const duration = Date.now() - cycleT0;

    const slotsFound = result.slots?.length ?? 0;
    dtOnlyResults.push({ cycle: i, durationMs: duration, status: result.status, slotsFound });

    log(`  A${i}: ${result.status} | ${(duration / 1000).toFixed(2)}s | ${slotsFound} slot(s)`);
  }

  // ── 4. BOUCLE B : cycle complet (refreshSessionAndScan) ────────────────────
  section(`PHASE 4 — BOUCLE B : refreshSessionAndScan × ${FULL_CYCLE_COUNT} (cycle complet)`);
  const fullCycleResults: CycleMeasure[] = [];

  for (let i = 1; i <= FULL_CYCLE_COUNT; i++) {
    if (i > 1) await sleep(INTER_CYCLE_DELAY_MS);

    const cycleT0 = Date.now();
    const result = await refreshSessionAndScan(session, config, `${TAG}[B${i}]`);
    const duration = Date.now() - cycleT0;

    const slotsFound = result.slots?.length ?? 0;
    fullCycleResults.push({ cycle: i, durationMs: duration, status: result.status, slotsFound });

    log(`  B${i}: ${result.status} | ${(duration / 1000).toFixed(2)}s | ${slotsFound} slot(s)`);
  }

  // ── 5. Comparaison ─────────────────────────────────────────────────────────
  section("RÉSULTATS — COMPARAISON");

  const avgDtOnly = dtOnlyResults.reduce((s, r) => s + r.durationMs, 0) / dtOnlyResults.length;
  const avgFull = fullCycleResults.reduce((s, r) => s + r.durationMs, 0) / fullCycleResults.length;
  const speedup = avgFull / avgDtOnly;

  console.log(`\n  ┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`  │  MÉTHODE                   │  MOY/CYCLE    │  SPEEDUP           │`);
  console.log(`  ├─────────────────────────────────────────────────────────────────┤`);
  console.log(`  │  A. datetime-only           │  ${(avgDtOnly / 1000).toFixed(2).padStart(7)}s   │  (baseline)          │`);
  console.log(`  │  B. refreshSessionAndScan   │  ${(avgFull / 1000).toFixed(2).padStart(7)}s   │  ${speedup.toFixed(1)}× plus lent    │`);
  console.log(`  └─────────────────────────────────────────────────────────────────┘`);

  console.log(`\n  Détails A (datetime-only):`);
  for (const r of dtOnlyResults) {
    console.log(`    Cycle ${r.cycle}: ${(r.durationMs / 1000).toFixed(2)}s — ${r.status} (${r.slotsFound} slots)`);
  }

  console.log(`\n  Détails B (cycle complet):`);
  for (const r of fullCycleResults) {
    console.log(`    Cycle ${r.cycle}: ${(r.durationMs / 1000).toFixed(2)}s — ${r.status} (${r.slotsFound} slots)`);
  }

  console.log(`\n  Init session CF : ${(initDuration / 1000).toFixed(1)}s (one-shot, pas compté dans les cycles)`);
  console.log(`  Init PHP state  : ${(phpDuration / 1000).toFixed(1)}s (one-shot, pas compté dans les cycles)`);

  // ── Conclusion ──────────────────────────────────────────────────────────────
  section("CONCLUSION");
  if (speedup >= 3) {
    log(`✅ HYPOTHÈSE CONFIRMÉE : datetime-only est ${speedup.toFixed(1)}× plus rapide`);
    log(`   → Le worker devrait faire initPhpState UNE FOIS puis boucler sur scanDatetimeDirect`);
    log(`   → refreshSessionAndScan ne devrait être appelé que sur session_dead/proxy_error`);
  } else if (speedup >= 1.5) {
    log(`⚠️  Gain modéré : ${speedup.toFixed(1)}× — datetime-only est plus rapide mais pas autant qu'espéré`);
    log(`   Possible que le proxy ajoute de la latence sur chaque requête`);
  } else {
    log(`❓ Pas de gain significatif (${speedup.toFixed(1)}×) — vérifier si datetime/ seul est suffisant`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
