/**
 * test-probe-capsolver.ts
 *
 * Teste runSpainHttpProbe — la fonction exacte du watcher loop de production —
 * en mode capsolver-residential.
 *
 * 2 appels consécutifs :
 *   1er : solve CapSolver + scan → status + allSlots
 *   2ème : session réutilisée (cache mémoire) + scan → confirme pas de nouveau solve
 *
 * Usage :
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   CAPSOLVER_API_KEY=xxx \
 *   PORTAL_ONLY=saopolo  (ou cuba) \
 *   node_modules/.bin/tsx src/scripts/test-probe-capsolver.ts
 */

import "dotenv/config";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { getActiveSpainCfSession } from "../spain-soax-solver.js";
import { SAOPOLO_PORTAL_URL, CUBA_LMD_PORTAL_URL } from "../spain-portals.js";

const T0 = Date.now();
const ts  = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log  = (msg: string) => console.log(`[${ts()}] ${msg}`);
const sep  = (t: string)   => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);

const PORTAL = process.env.PORTAL_ONLY === "cuba" ? CUBA_LMD_PORTAL_URL : SAOPOLO_PORTAL_URL;
const LABEL  = process.env.PORTAL_ONLY === "cuba" ? "Cuba (LMD)" : "Saopolo (RDC)";

async function runProbe(n: number) {
  const label = `Probe #${n}`;
  sep(label);

  const sessionBefore = getActiveSpainCfSession();
  log(`Session en cache avant  : ${sessionBefore ? `✅ (expire dans ${Math.round((sessionBefore.expiresAt - Date.now()) / 60_000)}min)` : "❌ absente"}`);

  const t = Date.now();
  const result = await runSpainHttpProbe(PORTAL);
  const elapsed = ((Date.now() - t) / 1000).toFixed(1);

  const sessionAfter = getActiveSpainCfSession();
  log(`Session en cache après  : ${sessionAfter ? `✅ (expire dans ${Math.round((sessionAfter.expiresAt - Date.now()) / 60_000)}min)` : "❌ absente"}`);
  log(`Durée probe             : ${elapsed}s`);
  log(`Status                  : ${result.status}`);
  log(`slotInfo                : ${result.slotInfo ?? "(none)"}`);
  log(`allSlots dans _mainHtml : ${result._mainHtml ? `${result._mainHtml.length}B` : "(absent)"}`);
  if (result.errorMessage) log(`Erreur                  : ${result.errorMessage}`);

  const newSolve = !sessionBefore && !!sessionAfter;
  const cacheHit = !!sessionBefore;
  log(`→ ${newSolve ? "🔑 Nouveau solve CapSolver" : cacheHit ? "♻️  Session réutilisée (cache)" : "⚠️  Pas de session après probe"}`);

  return result;
}

async function main() {
  sep(`TEST runSpainHttpProbe — ${LABEL} — ${new Date().toISOString()}`);
  log(`Mode : ${process.env.SPAIN_SESSION_MODE ?? "(non défini)"}`);
  log(`URL  : ${PORTAL}`);

  // Probe 1 — doit déclencher un solve CapSolver
  const r1 = await runProbe(1);

  // Probe 2 — doit réutiliser la session du cache (pas de nouveau solve)
  if (r1.status !== "error") {
    log(`\n⏳ Pause 3s avant probe 2...`);
    await new Promise(r => setTimeout(r, 3_000));
    await runProbe(2);
  } else {
    log(`Probe 1 en erreur — probe 2 annulé`);
  }

  sep(`FIN — ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
