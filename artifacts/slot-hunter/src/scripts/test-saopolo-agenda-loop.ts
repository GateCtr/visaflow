/**
 * test-saopolo-agenda-loop.ts — Teste si getagendas/ retourne toujours une
 * réponse valide quand on le boucle N fois sur le même PHPSESSID (Sao Paulo).
 *
 * Sao Paulo a des créneaux → agenda non-vide → on peut vérifier si la réponse
 * reste stable ou passe à 0B après le premier appel.
 *
 * USAGE :
 *   npx tsx src/scripts/test-saopolo-agenda-loop.ts [PROXY_URL]
 */

import "dotenv/config";
import { Impit } from "impit";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  buildDynamicSession,
  callDirect,
  CALL_DIRECT_NETWORK_ERROR,
} from "../spain-bookitit-direct.js";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.argv[2] || (process.env.SPAIN_ISP_PROXY_URL ?? process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "");
const LOOP_COUNT = 5;

function log(msg: string): void {
  console.log(`[test-saopolo-loop] ${msg}`);
}

async function main(): Promise<void> {
  log(`Portal  : Sao Paulo`);
  log(`Proxy   : ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "(direct)"}`);
  log(`CapSolver: ${CAPSOLVER_API_KEY ? "✅" : "❌"}`);
  log(`Loops   : ${LOOP_COUNT}`);

  if (!CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }

  // Sticky ID
  const stickyId = Math.random().toString(36).slice(2, 10);
  let stickyProxy = PROXY_URL;
  if (PROXY_URL && PROXY_URL.includes("sessionduration")) {
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

  // ── 1. Init session CF ──────────────────────────────────────────────────────
  log("\n═══ INIT SESSION CF ═══");
  const initResult = await initWorkerSession(stickyProxy, SAOPOLO_URL.split("#")[0], CAPSOLVER_API_KEY);
  if (!initResult) { console.error("❌ initWorkerSession échoué"); process.exit(1); }
  const { session } = initResult;
  log(`✅ Session établie — /main/ ${session.prefetchedMainHtml?.length ?? 0}B`);

  // ── 2. Premier cycle complet ────────────────────────────────────────────────
  log("\n═══ CYCLE COMPLET INITIAL (cfg → svc → ag → dt) ═══");
  const ds = buildDynamicSession(session);
  if (!ds) { console.error("❌ buildDynamicSession échoué"); process.exit(1); }

  const cfgPayload = await callDirect(ds, "getwidgetconfigurations/");
  log(`cfg/ → ${JSON.stringify(cfgPayload ?? "").length}B`);

  const svcPayload = await callDirect(ds, "getservices/") as any;
  const services: Array<{ id: string; name: string }> = svcPayload?.Services ?? svcPayload?.services ?? [];
  log(`svc/ → ${services.length} services | AllowAppointment=${svcPayload?.AllowAppointment}`);

  const bestSvc = services.find(s => (s.name ?? "").replace(/<[^>]*>/g, "").trim().length > 0) ?? services[0];
  if (!bestSvc) { console.error("❌ Aucun service trouvé"); process.exit(1); }
  log(`Service cible: ${bestSvc.id} "${(bestSvc.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 40)}"`);

  const agPayload = await callDirect(ds, "getagendas/", {
    "services[]": bestSvc.id,
    selectedPeople: "1",
  }) as any;
  const agendas = agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = agendas.find((a: any) => a?.id)?.id ?? "";
  log(`ag/ initial → ${JSON.stringify(agPayload ?? "").length}B | agendaId="${agendaId}" | agendas=${agendas.length}`);

  if (!agendaId) {
    log("⚠️ Pas d'agenda — Sao Paulo n'a peut-être pas de créneaux en ce moment");
    log("   Test non concluant — réessayer quand des créneaux sont disponibles");
    process.exit(0);
  }

  // ── 3. Boucle : rappeler getagendas/ N fois ────────────────────────────────
  log(`\n═══ BOUCLE getagendas/ × ${LOOP_COUNT} (même PHPSESSID) ═══`);
  for (let i = 1; i <= LOOP_COUNT; i++) {
    await sleep(2000); // pause 2s entre appels

    const agResult = await callDirect(ds, "getagendas/", {
      "services[]": bestSvc.id,
      selectedPeople: "1",
    }) as any;

    const isNetErr = agResult === CALL_DIRECT_NETWORK_ERROR;
    const bytes = isNetErr ? -1 : JSON.stringify(agResult ?? "").length;
    const ags = isNetErr ? [] : (agResult?.Agendas ?? agResult?.agendas ?? []);
    const aid = ags.find((a: any) => a?.id)?.id ?? "";

    const status = isNetErr ? "❌ NET_ERR" : bytes <= 2 ? "❌ 0B" : aid ? "✅ OK" : "⚠️ vide";
    log(`  Loop ${i}/${LOOP_COUNT}: ${status} | ${bytes}B | agendaId="${aid}"`);
  }

  // ── 4. Boucle : rappeler datetime/ N fois ──────────────────────────────────
  log(`\n═══ BOUCLE datetime/ × ${LOOP_COUNT} (même PHPSESSID, agenda=${agendaId}) ═══`);
  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  for (let i = 1; i <= LOOP_COUNT; i++) {
    await sleep(2000);

    const dtResult = await callDirect(ds, "datetime/", {
      "services[]": bestSvc.id,
      "agendas[]": agendaId,
      start: startStr,
      end: endStr,
      selectedPeople: "1",
    });

    const isNetErr = dtResult === CALL_DIRECT_NETWORK_ERROR;
    const bytes = isNetErr ? -1 : JSON.stringify(dtResult ?? "").length;
    const status = isNetErr ? "❌ NET_ERR" : bytes <= 2 ? "❌ 0B" : "✅ OK";
    log(`  Loop ${i}/${LOOP_COUNT}: ${status} | ${bytes}B`);
  }

  log("\n═══ RÉSULTAT ═══");
  log("Si getagendas/ retourne 0B après le 1er appel → règle §9 confirmée (one-shot)");
  log("Si getagendas/ continue de répondre → on peut boucler librement");
  log("Si datetime/ continue de répondre → boucle datetime seule est safe");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
