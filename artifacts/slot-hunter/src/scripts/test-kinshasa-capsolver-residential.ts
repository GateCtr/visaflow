/**
 * test-kinshasa-capsolver-residential.ts
 * Test rapide du mode capsolver-residential sur Kinshasa.
 * Usage: SPAIN_SESSION_MODE=capsolver-residential CAPSOLVER_API_KEY=... tsx src/scripts/test-kinshasa-capsolver-residential.ts
 */
import "dotenv/config";
import { ensureSpainCfSession, makeBookititUrl, invalidateSpainCfSession } from "../spain-soax-solver.js";
import { spainCfFetch } from "../spain-soax-solver.js";
import { KINSHASA_PORTAL_URL } from "../spain-portals.js";

const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`[${ts()}] ${msg}`);
const section = (t: string) => console.log(`\n${"═".repeat(65)}\n  ${t}\n${"═".repeat(65)}`);

function parseJsonp(raw: string): unknown | null {
  if (!raw?.trim()) return null;
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) { try { return JSON.parse(t); } catch { return null; } }
  const m = t.match(/^[^\(]+\(([\s\S]*)\)\s*;?\s*$/);
  return m ? (JSON.parse(m[1])) : null;
}

async function main() {
  section("TEST capsolver-residential → Kinshasa");
  log(`URL: ${KINSHASA_PORTAL_URL}`);
  log(`Mode: ${process.env.SPAIN_SESSION_MODE}`);
  log(`Proxy: ${(process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "").replace(/:([^:@/]+)@/, ":***@")}`);

  // 1. Session
  section("1 — Session ensureSpainCfSession");
  const session = await ensureSpainCfSession(KINSHASA_PORTAL_URL);
  if (!session) {
    log("❌ Session null — échec");
    process.exit(1);
  }
  log(`✅ Session établie | /main/: ${session.prefetchedMainHtml?.length ?? 0}B`);
  log(`   bookititState: ${session.bookititState ? "✅" : "❌"}`);
  log(`   PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID") ? "✅" : "❌"}`);
  if (session.bookititState) {
    log(`   port: ${new URL(session.soaxProxyUrl).port}`);
    log(`   srvsrc: ${session.bookititState.srvsrc}`);
    log(`   version: ${session.bookititState.version}`);
    log(`   jqCallback: ${session.bookititState.jqCallback.slice(0, 35)}…`);
  }

  const headers = { "Accept": "text/javascript, application/javascript, */*; q=0.01", "X-Requested-With": "XMLHttpRequest", "Referer": KINSHASA_PORTAL_URL };

  // 2. getwidgetconfigurations
  section("2 — getwidgetconfigurations");
  const cfgUrl = session.bookititState ? makeBookititUrl(session, "getwidgetconfigurations/") : null;
  const cfgRaw = cfgUrl ? (await (await spainCfFetch(cfgUrl, session, { headers }))?.text() ?? "") : "";
  log(`→ ${cfgRaw.length}B${cfgRaw.length > 0 ? " ✅" : " ❌"}`);
  if (cfgRaw.length > 0) log(`   snippet: ${cfgRaw.slice(0, 150)}`);

  // 3. getservices
  section("3 — getservices");
  const svcUrl = session.bookititState ? makeBookititUrl(session, "getservices/", { selectedPeople: "1" }) : null;
  const svcRaw = svcUrl ? (await (await spainCfFetch(svcUrl, session, { headers }))?.text() ?? "") : "";
  log(`→ ${svcRaw.length}B${svcRaw.length > 0 ? " ✅" : " ❌"}`);
  const svcData = parseJsonp(svcRaw) as any;
  const serviceIds: string[] = [];
  const walk = (obj: any) => {
    if (!obj) return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if ((typeof v === "string" || typeof v === "number") && /(service.*id|services.*id|^id$)/i.test(k)) serviceIds.push(String(v));
        else walk(v);
      }
    }
  };
  walk(svcData);
  const uniqServices = [...new Set(serviceIds)];
  log(`   Services: ${uniqServices.slice(0, 5).join(", ")} (${uniqServices.length} total)`);

  if (uniqServices.length === 0) {
    log("⚠️ Aucun service — portail fermé ou session invalide");
    return;
  }

  // 4. datetime/ mois courant
  section("4 — datetime/ (mois courant)");
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const dtUrl = session.bookititState ? makeBookititUrl(session, "datetime/", {
    "services[]": uniqServices[0], start, end, selectedPeople: "1",
  }) : null;
  const dtRaw = dtUrl ? (await (await spainCfFetch(dtUrl, session, { headers }))?.text() ?? "") : "";
  const dtData = parseJsonp(dtRaw) as any;
  const maxDays = dtData?.maxDays ?? "N/A";
  let slots = 0;
  if (dtData && typeof dtData === "object") {
    for (const [, day] of Object.entries(dtData)) {
      const d = day as any;
      if (Array.isArray(d?.Slots)) slots += d.Slots.length;
    }
  }
  log(`→ ${dtRaw.length}B | maxDays=${maxDays} | créneaux=${slots}${dtRaw.length > 0 ? " ✅" : " ❌"}`);

  // Résumé
  section("RÉSUMÉ");
  log(`Session: ✅ (${session.prefetchedMainHtml?.length ?? 0}B /main/)`);
  log(`getwidgetconfigurations: ${cfgRaw.length > 0 ? "✅" : "❌"} (${cfgRaw.length}B)`);
  log(`getservices: ${uniqServices.length > 0 ? "✅" : "❌"} (${uniqServices.length} services)`);
  log(`datetime/: ${dtRaw.length > 0 ? "✅" : "❌"} (${dtRaw.length}B | ${slots} créneaux | maxDays=${maxDays})`);

  const allOk = session.prefetchedMainHtml && session.prefetchedMainHtml.length > 1000 && cfgRaw.length > 0 && uniqServices.length > 0;
  log(allOk ? "🎉 SUCCÈS — système capsolver-residential fonctionnel sur Kinshasa!" : "⚠️ PARTIEL — voir logs ci-dessus");
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
