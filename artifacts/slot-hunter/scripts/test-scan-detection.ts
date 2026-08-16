/**
 * test-scan-detection.ts
 *
 * Valide les trois chemins de détection de scanDatetimeDirect :
 *   1. proxy_error  — impit.fetch throw ProxyTunnelError  → tous les mois sentinel
 *   2. session_dead — impit.fetch retourne HTTP 200 + body vide → tous les mois null HTTP
 *                     condition : agendaId présent (si absent, 0B est normal → not_found)
 *   3. not_found    — même comportement mais agendaId absent → 0B est normal
 *
 * Aucune connexion réseau réelle — impit est un mock.
 */

import { scanDatetimeDirect, type WorkerPhpState } from "../src/spain-dossier-worker.js";
import type { DynamicSession } from "../src/spain-bookitit-direct.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDs(fetchImpl: (url: string, init?: any) => Promise<any>): DynamicSession {
  return {
    impit: { fetch: fetchImpl } as any,
    jar: { PHPSESSID: "fake-sessid", cf_clearance: "fake-cf" },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
    jqCallback: "jQuery12345",
    reqCounter: 0,
    publickey: "bkt853215",
    version: "4",
    widgetUrl: "https://www.citaconsular.es/onlinebookings/?publickey=bkt853215&version=4&lang=es",
    srvsrc: "https://www.citaconsular.es/onlinebookings",
    bookititBase: "https://www.citaconsular.es/onlinebookings",
  };
}

function makePhpState(ds: DynamicSession, agendaId: string): WorkerPhpState {
  return {
    services: [{ serviceId: "svc1", serviceName: "PASAPORTES" }],
    agendaId,
    bestServiceId: "svc1",
    bestServiceName: "PASAPORTES",
    allowAppointment: true,
    ds,
  };
}

const MOCK_CONFIG = {
  id: "test-dossier-id",
  applicationId: "test-app-id" as any,
  applicantName: "TEST DOSSIER",
  portalUrl: "https://www.citaconsular.es/onlinebookings/?publickey=bkt853215",
  targetCountry: "ESP",
  targetCity: "Kinshasa",
  notifyPhones: [],
  groupSize: 1,
} as any;

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testProxyError(): Promise<boolean> {
  console.log("\n━━━ TEST 1 : proxy_error (impit.fetch throw ProxyTunnelError) ━━━");

  const ds = makeDs(async (_url: string) => {
    throw new Error("ProxyTunnelError: Proxy rejected CONNECT 502");
  });

  const phpState = makePhpState(ds, "agenda-123"); // agendaId présent
  const result = await scanDatetimeDirect(phpState, MOCK_CONFIG, "[TEST-PROXY-ERROR]");

  const pass = result.status === "proxy_error";
  console.log(`  → status: "${result.status}"  ${pass ? "✅ PASS" : "❌ FAIL (attendu: proxy_error)"}`);
  if (!pass) console.error("  → monthTraces:", result.monthTraces);
  return pass;
}

async function testSessionDeadWithAgenda(): Promise<boolean> {
  console.log("\n━━━ TEST 2 : session_dead (HTTP 200 body vide + agendaId présent) ━━━");

  const ds = makeDs(async (_url: string) => ({
    ok: true,
    status: 200,
    text: async () => "",   // corps vide → parseDirectJsonp → null
  }));

  const phpState = makePhpState(ds, "agenda-456"); // agendaId présent → 0B = session morte
  const result = await scanDatetimeDirect(phpState, MOCK_CONFIG, "[TEST-SESSION-DEAD]");

  const pass = result.status === "session_dead";
  console.log(`  → status: "${result.status}"  ${pass ? "✅ PASS" : "❌ FAIL (attendu: session_dead)"}`);
  if (!pass) console.error("  → monthTraces:", result.monthTraces);
  return pass;
}

async function testNotFoundWithoutAgenda(): Promise<boolean> {
  console.log("\n━━━ TEST 3 : not_found (HTTP 200 body vide + agendaId ABSENT) ━━━");

  const ds = makeDs(async (_url: string) => ({
    ok: true,
    status: 200,
    text: async () => "",   // corps vide → null
  }));

  const phpState = makePhpState(ds, ""); // agendaId absent → 0B est normal
  const result = await scanDatetimeDirect(phpState, MOCK_CONFIG, "[TEST-NOT-FOUND]");

  const pass = result.status === "not_found";
  console.log(`  → status: "${result.status}"  ${pass ? "✅ PASS" : "❌ FAIL (attendu: not_found)"}`);
  if (!pass) console.error("  → monthTraces:", result.monthTraces);
  return pass;
}

async function testNotFoundWithSlots(): Promise<boolean> {
  console.log("\n━━━ TEST 4 : not_found (réponse JSONP vide valide — aucun slot) ━━━");

  // Simule un payload JSONP valide mais sans slot (maxDays absent, Times vide)
  const emptyPayloadJsonp = `jQuery12345(${JSON.stringify({ AllowAppointment: true, Times: {}, maxDays: "" })})`;

  const ds = makeDs(async (_url: string) => ({
    ok: true,
    status: 200,
    text: async () => emptyPayloadJsonp,
  }));

  const phpState = makePhpState(ds, "agenda-789");
  const result = await scanDatetimeDirect(phpState, MOCK_CONFIG, "[TEST-NOT-FOUND-SLOTS]");

  // Sans maxDays et sans slot, la boucle s'arrête après 3 consecutiveEmpty
  const pass = result.status === "not_found";
  console.log(`  → status: "${result.status}"  ${pass ? "✅ PASS" : "❌ FAIL (attendu: not_found)"}`);
  if (!pass) console.error("  → monthTraces:", result.monthTraces);
  return pass;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("🧪  TEST scanDatetimeDirect — détection proxy_error / session_dead");
  console.log("═══════════════════════════════════════════════════════════════");

  const results = await Promise.all([
    testProxyError(),
    testSessionDeadWithAgenda(),
    testNotFoundWithoutAgenda(),
    testNotFoundWithSlots(),
  ]);

  const passed = results.filter(Boolean).length;
  const total = results.length;

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`📊  ${passed}/${total} tests passés  ${passed === total ? "✅ TOUT OK" : "❌ ÉCHEC"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
