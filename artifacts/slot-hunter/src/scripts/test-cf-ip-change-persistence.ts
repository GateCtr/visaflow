/**
 * test-cf-ip-change-persistence.ts
 *
 * QUESTION PRÉCISE (forensic 2026-08-31) :
 *   Le cf_clearance survit-il à un CHANGEMENT D'EXIT IP tant que le fingerprint
 *   TLS reste cohérent (impit "chrome") ?
 *
 *   Si OUI  → réparer un proxy mort = re-router sur une autre IP (~qq s), PAS de re-solve (~66s).
 *             => la phase preflight HH:05→HH:13 devient confortable.
 *   Si NON  → le cf_clearance est lié à l'exit IP → tout changement d'IP impose un re-solve.
 *             => il faut sur-provisionner des sessions de secours pré-solvées.
 *
 * MÉTHODE :
 *   Phase 1 : solve CF initial sur IP-A (port X du CSV) via initWorkerSession.
 *   Phase 2 : GET widget répété — MÊME impit, MÊME IP-A (baseline: le clearance tient-il en répétition ?).
 *   Phase 3 : GET widget — impit "chrome" NEUF vers IP-B (port Y différent). MÊME UA + MÊME cf_clearance.
 *             => isole l'effet "changement d'exit IP" à fingerprint TLS constant (impit chrome = JA3 déterministe).
 *   Phase 4 : GET widget — impit "chrome" NEUF vers IP-A (contrôle: si Phase 3 échoue mais Phase 4 OK,
 *             c'est bien l'IP qui casse, pas le fait de recréer l'impit).
 *
 * Les proxies sont lus depuis un CSV (une URL proxy par ligne).
 *
 * Usage :
 *   npx tsx src/scripts/test-cf-ip-change-persistence.ts "C:\\Users\\sabow\\Downloads\\data(7).csv"
 *   (défaut CSV = data(7).csv dans ~/Downloads si non fourni)
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Impit } from "impit";
import { initWorkerSession, type SpainCfSession } from "../spain-soax-solver.js";

const PORTAL_URL =
  process.env.SPAIN_TEST_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

interface ProbeResult {
  status: number;
  bytes: number;
  ms: number;
  isCf: boolean;
  hasToken: boolean;
  bodyHead: string;
}

function buildCookieStr(cookies: Array<{ name: string; value: string }>): string {
  return cookies.filter((c) => c.value).map((c) => `${c.name}=${c.value}`).join("; ");
}

function maskProxy(url: string): string {
  return url.replace(/:([^:@]+)@/, ":***@");
}

/** GET widget via un impit donné, avec UA + cookies de la session. */
async function probeWidget(
  impit: InstanceType<typeof Impit>,
  session: SpainCfSession,
): Promise<ProbeResult> {
  const t1 = Date.now();
  const cookieStr = buildCookieStr(session.allCookies);
  const r = (await (impit.fetch(PORTAL_URL, {
    headers: {
      "User-Agent": session.userAgent,
      Cookie: cookieStr,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    },
  } as any) as unknown as Promise<Response>));
  const body = await r.text();
  const ms = Date.now() - t1;
  const isCf = r.status === 403 || /just a moment|_cf_chl_opt/i.test(body.slice(0, 3000));
  const hasToken = /name="token"\s+value="[^"]+"/i.test(body);
  return { status: r.status, bytes: body.length, ms, isCf, hasToken, bodyHead: body.slice(0, 300) };
}

function printProbe(label: string, p: ProbeResult): void {
  if (p.isCf) {
    console.log(`   ❌ ${label} → CF CHALLENGE (HTTP ${p.status}, ${p.bytes}B, ${p.ms}ms)`);
  } else if (p.hasToken) {
    console.log(`   ✅ ${label} → OK, token présent (HTTP ${p.status}, ${p.bytes}B, ${p.ms}ms)`);
  } else {
    console.log(`   ⚠️ ${label} → HTTP ${p.status}, PAS de token (${p.bytes}B, ${p.ms}ms)`);
    console.log(`      body[0..300]: ${p.bodyHead.replace(/\s+/g, " ")}`);
  }
}

function loadProxiesFromCsv(path: string): string[] {
  const raw = readFileSync(path, "utf8");
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /^https?:\/\//i.test(l));
}

async function main(): Promise<void> {
  const capsolverKey = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
  if (!capsolverKey) {
    console.error("❌ CAPSOLVER_API_KEY manquante");
    process.exit(1);
  }

  const csvPath = process.argv[2] ?? join(homedir(), "Downloads", "data(7).csv");
  console.log(`📄 CSV proxies: ${csvPath}`);
  let proxies: string[];
  try {
    proxies = loadProxiesFromCsv(csvPath);
  } catch (e) {
    console.error(`❌ Impossible de lire le CSV: ${e}`);
    process.exit(1);
  }
  if (proxies.length < 2) {
    console.error(`❌ Il faut au moins 2 proxies (IP-A et IP-B) dans le CSV, trouvé ${proxies.length}`);
    process.exit(1);
  }

  const proxyA = proxies[0];
  const proxyB = proxies[1];
  console.log(`📡 IP-A (solve + baseline): ${maskProxy(proxyA)}`);
  console.log(`📡 IP-B (test changement) : ${maskProxy(proxyB)}`);
  console.log(`🎯 Portal: ${PORTAL_URL.slice(-50)}\n`);

  // ── PHASE 1 : solve CF initial sur IP-A ─────────────────────────────────────
  console.log(`── PHASE 1 : Solve CF initial sur IP-A ──`);
  const t0 = Date.now();
  const result = await initWorkerSession(proxyA, PORTAL_URL, capsolverKey);
  if (!result) {
    console.error("❌ Solve initial échoué sur IP-A");
    process.exit(1);
  }
  const session = result.session;
  console.log(`✅ Solve OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`   cf_clearance: ${session.cfClearance.slice(0, 30)}…`);
  console.log(`   UA: ${session.userAgent.slice(0, 60)}`);
  console.log(`   cookies: ${session.allCookies.map((c) => c.name).join(", ")}`);

  const impitA = session._ownImpit;
  if (!impitA) {
    console.error("❌ _ownImpit absent — impossible de tester la baseline");
    process.exit(1);
  }

  // ── PHASE 2 : baseline — même impit, même IP-A ──────────────────────────────
  console.log(`\n── PHASE 2 : Baseline (MÊME impit, MÊME IP-A) ──`);
  const p2 = await probeWidget(impitA, session);
  printProbe("baseline même impit/IP-A", p2);

  // ── PHASE 3 : LA QUESTION — impit chrome NEUF vers IP-B ─────────────────────
  console.log(`\n── PHASE 3 : Changement d'IP (impit chrome NEUF → IP-B, même UA + cf_clearance) ──`);
  const impitB = new Impit({ browser: "chrome", proxyUrl: proxyB, timeout: 30_000 } as any);
  let p3: ProbeResult | null = null;
  try {
    p3 = await probeWidget(impitB, session);
    printProbe("IP-B (changement d'exit IP)", p3);
  } catch (e) {
    console.log(`   ❌ IP-B → erreur réseau: ${e}`);
  }

  // ── PHASE 4 : contrôle — impit chrome NEUF vers IP-A ────────────────────────
  console.log(`\n── PHASE 4 : Contrôle (impit chrome NEUF → IP-A, même UA + cf_clearance) ──`);
  const impitA2 = new Impit({ browser: "chrome", proxyUrl: proxyA, timeout: 30_000 } as any);
  let p4: ProbeResult | null = null;
  try {
    p4 = await probeWidget(impitA2, session);
    printProbe("IP-A via impit neuf", p4);
  } catch (e) {
    console.log(`   ❌ IP-A (impit neuf) → erreur réseau: ${e}`);
  }

  // ── VERDICT ─────────────────────────────────────────────────────────────────
  console.log(`\n══════════════════ VERDICT ══════════════════`);
  const ok = (p: ProbeResult | null): boolean => !!p && !p.isCf && p.hasToken;
  console.log(`Phase 2 (même impit / IP-A)      : ${ok(p2) ? "OK" : "ÉCHEC"}`);
  console.log(`Phase 3 (impit neuf / IP-B)      : ${p3 ? (ok(p3) ? "OK" : "ÉCHEC") : "ERREUR"}`);
  console.log(`Phase 4 (impit neuf / IP-A)      : ${p4 ? (ok(p4) ? "OK" : "ÉCHEC") : "ERREUR"}`);
  console.log(`─────────────────────────────────────────────`);
  if (ok(p3)) {
    console.log(`✅ Le cf_clearance SURVIT au changement d'exit IP (fingerprint chrome constant).`);
    console.log(`   → Réparer un proxy mort = re-router sur une autre IP, PAS de re-solve.`);
    console.log(`   → Preflight HH:05→HH:13 confortable.`);
  } else if (ok(p4) && p3 && !ok(p3)) {
    console.log(`❌ Le cf_clearance est LIÉ à l'exit IP (Phase 4 OK sur IP-A mais Phase 3 échoue sur IP-B).`);
    console.log(`   → Tout changement d'IP impose un re-solve (~66s).`);
    console.log(`   → Stratégie: sur-provisionner des sessions de secours pré-solvées.`);
  } else if (p4 && !ok(p4) && ok(p2)) {
    console.log(`⚠️ Le cf_clearance est LIÉ à l'instance impit (Phase 2 OK mais Phase 4 échoue même sur IP-A).`);
    console.log(`   → Ni le changement d'IP ni le changement d'impit ne sont supportés en réutilisation.`);
  } else {
    console.log(`⚠️ Résultat ambigu — voir les phases ci-dessus en détail.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
