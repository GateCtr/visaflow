/**
 * test-worker-scan-loop.ts — Reproduit le flow exact du worker prod pour diagnostiquer
 * pourquoi "Session init" (avec cf solve) apparaît à chaque cycle.
 *
 * Utilise les MÊMES imports et fonctions que spain-dossier-worker.ts :
 *   1. initWorkerSession → session CF (solve initial)
 *   2. initPhpState → état PHP (cfg + svc + ag)
 *   3. Boucle de 3 cycles : refreshSessionAndScan (même que le worker prod)
 *
 * Objectif : vérifier si refreshSessionAndScan re-solve CF à chaque appel ou non.
 *
 * Usage : npx tsx src/scripts/test-worker-scan-loop.ts
 */

import "dotenv/config";
import {
  initWorkerSession,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import {
  initPhpState,
  refreshSessionAndScan,
  scanDatetimeDirect,
  type WorkerPhpState,
  type SpainDossierConfig,
} from "../spain-dossier-worker.js";
import { initDecodoPool, rotateDecodoUrl } from "../spain-decodo-pool.js";
import { log } from "../scheduler-utils.js";

const PORTAL_URL = process.env.SPAIN_TEST_PORTAL_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

const FAKE_CONFIG: SpainDossierConfig = {
  id: "test-worker-loop",
  applicantName: "TEST-CF-LOOP",
  visaType: "schengen",
  login: "FAKE_LOGIN",
  password: "FAKE_PASSWORD",
  applicationId: "test-cf-loop",
  otpChannel: "email",
  portalUrl: PORTAL_URL,
  slotDateFrom: "2026-08-01",
  slotDateDeadline: "2026-12-31",
  groupSize: 1,
};

function addSticky(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch { return url; }
}

async function main(): Promise<void> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
  if (!capsolverKey) {
    console.error("❌ CAPSOLVER_API_KEY manquante");
    process.exit(1);
  }

  const tag = "[TEST-CF-LOOP]";

  // 1. Init proxy
  await initDecodoPool();
  const baseProxy = rotateDecodoUrl();
  if (!baseProxy) {
    console.error("❌ Aucun proxy Decodo disponible");
    process.exit(1);
  }
  const stickyId = Math.random().toString(36).slice(2, 10);
  const proxyUrl = addSticky(baseProxy, stickyId);
  console.log(`\n📡 Proxy: ${proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}…`);

  // 2. Solve CF initial (identique au worker)
  console.log(`\n══ ÉTAPE 1 : initWorkerSession (solve CF initial) ══`);
  const t0 = Date.now();
  const result = await initWorkerSession(proxyUrl, PORTAL_URL, capsolverKey);
  if (!result) {
    console.error("❌ initWorkerSession échoué");
    process.exit(1);
  }
  console.log(`✅ Solve OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`   cf_clearance: ${result.session.cfClearance.slice(0, 30)}…`);

  const session: SpainCfSession = result.session;

  // 3. initPhpState (identique au worker)
  console.log(`\n══ ÉTAPE 2 : initPhpState ══`);
  const phpState = await initPhpState(session, FAKE_CONFIG, tag);
  if (!phpState) {
    console.error("❌ initPhpState échoué (0 services?)");
    process.exit(1);
  }
  console.log(`✅ PHP init OK — agenda=${phpState.agendaId || "(vide)"} | service="${phpState.bestServiceName}"`);

  // 4. Boucle de scan — d'abord scanDatetimeDirect (mode optimisé), puis refreshSessionAndScan
  const NUM_CYCLES = 3;
  const DELAY_BETWEEN = 10_000;

  console.log(`\n══ ÉTAPE 3A : Boucle scanDatetimeDirect × ${NUM_CYCLES} (mode phpState, PAS de cycle complet) ══`);
  for (let i = 1; i <= NUM_CYCLES; i++) {
    if (i > 1) {
      console.log(`   ⏳ Attente ${DELAY_BETWEEN / 1000}s…`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN));
    }
    const t1 = Date.now();
    const scan = await scanDatetimeDirect(phpState, FAKE_CONFIG, `${tag} [scanDirect#${i}]`);
    const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`   [${i}/${NUM_CYCLES}] scanDatetimeDirect → ${scan.status} (${elapsed}s)`);
    if (scan.status === "found") {
      console.log(`      🎯 ${scan.slots?.length} slot(s) trouvé(s)!`);
    }
  }

  console.log(`\n══ ÉTAPE 3B : Boucle refreshSessionAndScan × ${NUM_CYCLES} (cycle complet widget→datetime) ══`);
  for (let i = 1; i <= NUM_CYCLES; i++) {
    if (i > 1) {
      console.log(`   ⏳ Attente ${DELAY_BETWEEN / 1000}s…`);
      await new Promise(r => setTimeout(r, DELAY_BETWEEN));
    }
    const t1 = Date.now();
    const scan = await refreshSessionAndScan(session, FAKE_CONFIG, `${tag} [refresh#${i}]`);
    const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
    console.log(`   [${i}/${NUM_CYCLES}] refreshSessionAndScan → ${scan.status} (${elapsed}s)`);
    if (scan.status === "cf_expired") {
      console.log(`      ❌ CF challenge détecté — la clearance ne survit PAS entre les cycles!`);
      console.log(`      → Le worker devrait utiliser scanDatetimeDirect au lieu de refreshSessionAndScan`);
      break;
    }
    if (scan.status === "found") {
      console.log(`      🎯 ${scan.slots?.length} slot(s) trouvé(s)!`);
    }
  }

  console.log(`\n══ RÉSUMÉ ══`);
  console.log(`Si 3A OK et 3B échoue avec cf_expired : le problème est dans refreshSessionAndScan`);
  console.log(`Si les deux OK : le problème est ailleurs (pre-pub refresh qui reset la session?)`);
  console.log(`Si 3A montre session_dead : le phpState expire entre les cycles`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
