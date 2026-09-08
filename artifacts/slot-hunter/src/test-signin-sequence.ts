/**
 * test-signin-sequence.ts — Teste la séquence booking multi-créneaux pour isoler
 * le rate-limit de getsigninfields/ et vérifier si signin/ fonctionne indépendamment.
 *
 * HYPOTHÈSE TESTÉE
 *   Le 1er getsigninfields/ passe, les suivants (en rafale) → 0B (rate-limit serveur).
 *   MAIS signin/ semble répondre indépendamment. Question : sur le créneau SUIVANT,
 *   peut-on appeler signin/ DIRECTEMENT (sans getsigninfields/) et obtenir une réponse ?
 *
 * SCÉNARIO (Saopola, vrais créneaux)
 *   A) getsigninfields/(slot1) → attendu OK (1er)
 *   B) signin/(slot1)          → réponse ?
 *   C) getsigninfields/(slot2) → attendu 0B (rate-limit)
 *   D) signin/(slot2) DIRECT   → répond-il malgré le getsigninfields 0B ?   ← LA question
 *   E) signin/(slot3) SANS getsigninfields du tout → répond-il ?
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   npx tsx src/test-signin-sequence.ts
 *   SIGNIN_PORTAL=<url> pour un autre portail (défaut Saopola).
 */

import "dotenv/config";

import { initWorkerSession } from "./spain-soax-solver.js";
import {
  initPhpState,
  scanDatetimeDirect,
  type SpainDossierConfig,
} from "./spain-dossier-worker.js";
import {
  makeDirectUrl,
  makeDirectHeaders,
  parseDirectJsonp,
  type DynamicSession,
} from "./spain-bookitit-direct.js";
import { getDecodoPoolSize, getDecodoProxyForIndex } from "./spain-decodo-pool.js";

const SAOPOLA = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const PORTAL_URL = process.env.SIGNIN_PORTAL ?? SAOPOLA;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
const LOGIN = process.env.SIGNIN_LOGIN ?? "00000001";
const PASSWORD = process.env.SIGNIN_PASSWORD ?? "FakePass_Test";

function sep(l: string): void { console.log("\n" + "═".repeat(72) + `\n  ${l}\n` + "═".repeat(72)); }

function proxy0(): string {
  const size = getDecodoPoolSize();
  if (size > 0) return getDecodoProxyForIndex(0) ?? "";
  return process.env.DECODO_PROXY_URL ?? "";
}

interface CallResult { status: number; bytes: number; contentType: string; preview: string; parsed: unknown; }

async function raw(ds: DynamicSession, endpoint: string, extra: Record<string, string>): Promise<CallResult> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const headers = makeDirectHeaders(ds);
  const res = await (ds.impit.fetch(url, { headers } as any) as unknown as Promise<Response>);
  const contentType = (res.headers as any).get("content-type") ?? "";
  const body = await res.text();
  const preview = body.slice(0, 200).replace(/(login|password)=[^&";]*/gi, "$1=[R]").replace(/\s+/g, " ");
  return { status: res.status, bytes: body.length, contentType, preview, parsed: parseDirectJsonp(body) };
}

function slotBase(serviceId: string, slot: { date: string; time: string; agendaId?: string }): Record<string, string> {
  const b: Record<string, string> = { "services[]": serviceId, date: slot.date, time: slot.time, selectedPeople: "1" };
  if (slot.agendaId) b["agendas[]"] = slot.agendaId;
  return b;
}

async function gsf(ds: DynamicSession, serviceId: string, slot: { date: string; time: string; agendaId?: string }): Promise<CallResult> {
  const b = slotBase(serviceId, slot);
  return raw(ds, "getsigninfields/", {
    "services[]": b["services[]"], "agendas[]": b["agendas[]"] ?? "",
    date: b.date, time: b.time, selectedPeople: b.selectedPeople,
  });
}

async function signin(ds: DynamicSession, serviceId: string, slot: { date: string; time: string; agendaId?: string }): Promise<CallResult> {
  const b = slotBase(serviceId, slot);
  return raw(ds, "signin/", { ...b, logintype: "document", login: LOGIN, password: PASSWORD, comments: "" });
}

function show(label: string, r: CallResult): void {
  console.log(`  ${label}: HTTP ${r.status} | ${r.bytes}B | ${r.contentType.split(";")[0]} | ${r.preview.slice(0, 120)}`);
}

async function main(): Promise<void> {
  sep("TEST SÉQUENCE signin/ — getsigninfields rate-limit vs signin direct");
  console.log(`  Portail : ${PORTAL_URL}`);

  const config: SpainDossierConfig = {
    id: "seq-test", applicantName: "SEQ_TEST", visaType: "visa",
    login: LOGIN, password: PASSWORD, applicationId: "seq", otpChannel: "manual", portalUrl: PORTAL_URL,
  };
  const tag = "[SEQ]";

  const res = await initWorkerSession(proxy0(), PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res) { console.error("❌ initWorkerSession"); process.exit(1); }
  const php = await initPhpState(res.session, config, tag);
  if (!php) { console.error("❌ initPhpState"); process.exit(1); }

  const scan = await scanDatetimeDirect(php, config, tag);
  if (scan.status !== "found" || !scan.slots?.length) {
    console.log(`  ℹ️  Aucun créneau (status=${scan.status}). Lance quand des créneaux existent.`);
    process.exit(0);
  }
  const slots = scan.slots.filter((s) => s.freeslots > 0);
  if (slots.length < 1) { console.log("  ℹ️  Aucune place libre."); process.exit(0); }

  const ds = scan.ds ?? php.ds;
  const svc = php.bestServiceId;
  const s1 = slots[0];
  const s2 = slots[1] ?? slots[0];
  const s3 = slots[2] ?? slots[0];
  console.log(`  Créneaux: A=${s1.date} ${s1.time} | B=${s2.date} ${s2.time} | C=${s3.date} ${s3.time}`);

  sep("A) getsigninfields/(slot1) — attendu OK (1er appel)");
  show("gsf(A)", await gsf(ds, svc, s1));

  sep("B) signin/(slot1)");
  show("signin(A)", await signin(ds, svc, s1));

  sep("C) getsigninfields/(slot2) — attendu 0B (rate-limit après 1er)");
  const gsfB = await gsf(ds, svc, s2);
  show("gsf(B)", gsfB);

  sep("D) signin/(slot2) DIRECT — répond-il malgré gsf(B) 0B ? ← LA QUESTION");
  const signinB = await signin(ds, svc, s2);
  show("signin(B)", signinB);

  sep("E) signin/(slot3) SANS getsigninfields du tout");
  const signinC = await signin(ds, svc, s3);
  show("signin(C)", signinC);

  sep("CONCLUSION");
  console.log(`  gsf(B) rate-limité 0B : ${gsfB.bytes === 0 ? "OUI" : "NON"}`);
  console.log(`  signin(B) direct répond : ${signinB.bytes > 0 ? `OUI (${signinB.bytes}B)` : "NON (0B)"}`);
  console.log(`  signin(C) sans gsf répond : ${signinC.bytes > 0 ? `OUI (${signinC.bytes}B)` : "NON (0B)"}`);
  console.log();
  if (gsfB.bytes === 0 && (signinB.bytes > 0 || signinC.bytes > 0)) {
    console.log("  🎯 PREUVE : getsigninfields/ est rate-limité, MAIS signin/ répond quand même directement.");
    console.log("     → FIX : ne PAS skip le créneau sur getsigninfields/ 0B ; tenter signin/ directement.");
  } else if (gsfB.bytes === 0 && signinB.bytes === 0 && signinC.bytes === 0) {
    console.log("  🟠 getsigninfields/ ET signin/ rate-limités → il faut espacer/re-solver, pas juste sauter gsf.");
  } else {
    console.log("  🟢 getsigninfields/ pas rate-limité ici — résultat à re-tester.");
  }
  console.log();
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
