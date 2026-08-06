/**
 * test-cev-session-isolation.ts — Test d'isolation de session CEV (deux dossiers en parallèle)
 *
 * OBJECTIF :
 *   Vérifier que deux dossiers d'un même compte VOWINT peuvent ouvrir
 *   des sessions HTTP totalement indépendantes — sans déclencher l'erreur
 *   "multiple session" du portail CEV.
 *
 * CE QUI EST TESTÉ :
 *   1. Les deux sessions se connectent en parallèle (même email, deux VOWINT refs différents)
 *   2. Chaque session obtient un ASP.NET_SessionId différent  → isolation côté serveur
 *   3. Chaque session obtient un cookie VOWINT différent       → pas de partage d'authentification
 *   4. Les deux integrationUrl sont différentes               → flux applicatif isolé
 *   5. Timing : mesure du temps parallèle vs séquentiel estimé
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *
 *   CEV_TEST_EMAIL="email@example.com" \
 *   CEV_TEST_PASSWORD="motdepasse" \
 *   CEV_TEST_VOWINT_A="VOWINT6085888" \
 *   CEV_TEST_VOWINT_B="VOWINT6085889" \
 *   npx tsx scripts/test-cev-session-isolation.ts
 *
 *   # Avec probe de slot après isolation (dry-run, aucun booking) :
 *   CEV_TEST_PROBE=1 [...] npx tsx scripts/test-cev-session-isolation.ts
 *
 * VARIABLES D'ENVIRONNEMENT :
 *   CEV_TEST_EMAIL        Email du compte VOWINT (obligatoire)
 *   CEV_TEST_PASSWORD     Mot de passe VOWINT (obligatoire)
 *   CEV_TEST_VOWINT_A     Premier dossier  VOWINT ref (obligatoire)
 *   CEV_TEST_VOWINT_B     Deuxième dossier VOWINT ref (obligatoire)
 *   CEV_TEST_PROBE        "1" → tenter un pollCevSlot sur chaque session après isolation
 *   ANTICAPTCHA_API_KEY   Clé Anti-Captcha
 *   CAPSOLVER_API_KEY     Clé CapSolver (alternative)
 *   SOAX_PROXY_URL        Proxy résidentiel (optionnel)
 */

import "dotenv/config";
import { setupCevSessionHttp, invalidateVowintCache } from "../src/cevHttpSetup.js";
import { pollCevSlot } from "../src/cevPolling.js";

// ─── Configuration ─────────────────────────────────────────────────────────────

const EMAIL      = process.env.CEV_TEST_EMAIL      ?? "";
const PASSWORD   = process.env.CEV_TEST_PASSWORD   ?? "";
const VOWINT_A   = (process.env.CEV_TEST_VOWINT_A  ?? "").toUpperCase().trim();
const VOWINT_B   = (process.env.CEV_TEST_VOWINT_B  ?? "").toUpperCase().trim();
const DO_PROBE   = process.env.CEV_TEST_PROBE      === "1";
const CLIENT_ID  = `cev-isolation-test-${Date.now()}`;

// ─── Couleurs terminal ─────────────────────────────────────────────────────────

const R = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW= "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";
const BLUE  = "\x1b[34m";
const DIM   = "\x1b[2m";
const MAG   = "\x1b[35m";

function ok  (msg: string) { console.log(`${GREEN}  ✅ ${msg}${R}`); }
function warn(msg: string) { console.log(`${YELLOW}  ⚠️  ${msg}${R}`); }
function fail(msg: string) { console.log(`${RED}  ❌ ${msg}${R}`); }
function info(msg: string) { console.log(`${CYAN}  ℹ️  ${msg}${R}`); }
function dim (msg: string) { console.log(`${DIM}     ${msg}${R}`); }

function section(title: string) {
  const line = "═".repeat(62);
  console.log(`\n${BOLD}${line}${R}`);
  console.log(`${BOLD}  ${title}${R}`);
  console.log(`${BOLD}${line}${R}`);
}

function subsection(title: string) {
  console.log(`\n${BLUE}  ── ${title} ──${R}`);
}

// ─── Extraction de cookies ciblés ─────────────────────────────────────────────

function extractCookie(cookieStr: string | undefined, name: string): string {
  if (!cookieStr) return "(absent)";
  for (const part of cookieStr.split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k?.trim().toLowerCase() === name.toLowerCase()) {
      return v?.trim() ?? "(vide)";
    }
  }
  return "(absent)";
}

function cookieFingerprint(cookieStr: string | undefined): string {
  if (!cookieStr) return "(aucun cookie)";
  const keys = cookieStr.split(";")
    .map(p => p.trim().split("=")[0]?.trim())
    .filter(Boolean);
  return keys.join(" | ");
}

// ─── Assertion helper ─────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    ok(`PASS — ${label}`);
    passCount++;
  } else {
    fail(`FAIL — ${label}${detail ? ` (${detail})` : ""}`);
    failCount++;
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Validation des paramètres
  if (!EMAIL || !PASSWORD || !VOWINT_A || !VOWINT_B) {
    fail("Variables manquantes. Usage :");
    console.log(`\n  ${DIM}CEV_TEST_EMAIL=xxx CEV_TEST_PASSWORD=xxx \\${R}`);
    console.log(`  ${DIM}CEV_TEST_VOWINT_A=VOWINTXXXXXXX CEV_TEST_VOWINT_B=VOWINTYYYYYYY \\${R}`);
    console.log(`  ${DIM}npx tsx scripts/test-cev-session-isolation.ts${R}\n`);
    process.exit(1);
  }

  if (VOWINT_A === VOWINT_B) {
    fail("CEV_TEST_VOWINT_A et CEV_TEST_VOWINT_B doivent être DIFFÉRENTS pour tester l'isolation");
    process.exit(1);
  }

  section("CEV — Test d'isolation de session (deux dossiers en parallèle)");
  console.log(`\n  ${BOLD}Compte VOWINT :${R}  ${EMAIL}`);
  console.log(`  ${BOLD}Dossier A     :${R}  ${MAG}${VOWINT_A}${R}`);
  console.log(`  ${BOLD}Dossier B     :${R}  ${BLUE}${VOWINT_B}${R}`);
  console.log(`  ${BOLD}Probe slot    :${R}  ${DO_PROBE ? "activé" : "désactivé (dry-run)"}`);
  console.log(`  ${BOLD}Client ID     :${R}  ${DIM}${CLIENT_ID}${R}`);

  // Invalider le cache VOWINT pour forcer deux logins frais
  invalidateVowintCache(EMAIL);
  info("Cache VOWINT invalidé — deux logins frais vont être émis");

  // ─── PHASE 1 : Setup parallèle des deux sessions ──────────────────────────

  section("PHASE 1 — Setup parallèle (même email, deux VOWINT refs distincts)");
  info("Lancement simultané de setupCevSessionHttp pour les deux dossiers...");

  const t0 = Date.now();

  const [resultA, resultB] = await Promise.allSettled([
    setupCevSessionHttp(EMAIL, PASSWORD, VOWINT_A, CLIENT_ID, VOWINT_A, undefined),
    setupCevSessionHttp(EMAIL, PASSWORD, VOWINT_B, CLIENT_ID, VOWINT_B, undefined),
  ]);

  const elapsedMs = Date.now() - t0;
  info(`Durée parallèle : ${elapsedMs}ms (~${Math.round(elapsedMs / 1000)}s)`);

  // Extraire les valeurs (ou null si rejeté)
  const sesA = resultA.status === "fulfilled" ? resultA.value : null;
  const sesB = resultB.status === "fulfilled" ? resultB.value : null;
  const errA = resultA.status === "rejected" ? resultA.reason : null;
  const errB = resultB.status === "rejected" ? resultB.reason : null;

  // ─── PHASE 2 : Vérification des résultats bruts ───────────────────────────

  section("PHASE 2 — Résultats des setup");

  subsection(`Dossier A — ${VOWINT_A}`);
  if (errA) {
    fail(`Setup crash A: ${errA}`);
  } else if (!sesA?.success) {
    warn(`Setup échoué A: ${sesA?.error ?? "unknown"}`);
  } else {
    ok(`Setup réussi A`);
    dim(`  integrationUrl : ${sesA.integrationUrl?.slice(0, 80) ?? "(absent)"}…`);
    dim(`  selectSlotHtml : ${sesA.selectSlotHtml?.length ?? 0} chars`);
    dim(`  cookies (clés) : ${cookieFingerprint(sesA.sessionCookie)}`);
  }

  subsection(`Dossier B — ${VOWINT_B}`);
  if (errB) {
    fail(`Setup crash B: ${errB}`);
  } else if (!sesB?.success) {
    warn(`Setup échoué B: ${sesB?.error ?? "unknown"}`);
  } else {
    ok(`Setup réussi B`);
    dim(`  integrationUrl : ${sesB.integrationUrl?.slice(0, 80) ?? "(absent)"}…`);
    dim(`  selectSlotHtml : ${sesB.selectSlotHtml?.length ?? 0} chars`);
    dim(`  cookies (clés) : ${cookieFingerprint(sesB.sessionCookie)}`);
  }

  // ─── PHASE 3 : Assertions d'isolation ────────────────────────────────────

  section("PHASE 3 — Assertions d'isolation");

  // 3.1 — Les deux setups ont abouti
  assert(!!sesA?.success, "Dossier A — setup réussi");
  assert(!!sesB?.success, "Dossier B — setup réussi");

  if (!sesA?.success || !sesB?.success) {
    fail("Impossible de tester l'isolation : un ou deux setups ont échoué");
    printSummary();
    process.exit(1);
  }

  // 3.2 — ASP.NET_SessionId différents (isolation côté serveur CEV)
  const aspA = extractCookie(sesA.sessionCookie, "ASP.NET_SessionId");
  const aspB = extractCookie(sesB.sessionCookie, "ASP.NET_SessionId");
  subsection("ASP.NET_SessionId (clé d'isolation serveur CEV)");
  console.log(`    ${MAG}A${R} : ${aspA}`);
  console.log(`    ${BLUE}B${R} : ${aspB}`);
  assert(
    aspA !== "(absent)" && aspB !== "(absent)",
    "Les deux sessions ont un ASP.NET_SessionId"
  );
  assert(
    aspA !== aspB,
    "ASP.NET_SessionId DIFFÉRENTS → isolation côté serveur confirmée",
    `A=${aspA.slice(0, 20)}… B=${aspB.slice(0, 20)}…`
  );

  // 3.3 — Cookie de session VOWINT différent (loginInfo / authentification)
  const vowA = extractCookie(sesA.sessionCookie, "loginInfo") ||
               extractCookie(sesA.sessionCookie, ".AspNet.ApplicationCookie") ||
               extractCookie(sesA.sessionCookie, "auth");
  const vowB = extractCookie(sesB.sessionCookie, "loginInfo") ||
               extractCookie(sesB.sessionCookie, ".AspNet.ApplicationCookie") ||
               extractCookie(sesB.sessionCookie, "auth");
  subsection("Cookie VOWINT d'authentification");
  const shortA = vowA.length > 40 ? vowA.slice(0, 40) + "…" : vowA;
  const shortB = vowB.length > 40 ? vowB.slice(0, 40) + "…" : vowB;
  console.log(`    ${MAG}A${R} : ${shortA}`);
  console.log(`    ${BLUE}B${R} : ${shortB}`);
  assert(
    vowA !== "(absent)" && vowB !== "(absent)",
    "Les deux sessions ont un cookie d'authentification VOWINT"
  );
  assert(
    vowA !== vowB,
    "Cookies VOWINT DIFFÉRENTS → pas de partage de session de login"
  );

  // 3.4 — integrationUrl différentes (flux applicatif isolé)
  subsection("integrationUrl (URL d'application CEV)");
  console.log(`    ${MAG}A${R} : ${sesA.integrationUrl?.slice(0, 80) ?? "(absent)"}…`);
  console.log(`    ${BLUE}B${R} : ${sesB.integrationUrl?.slice(0, 80) ?? "(absent)"}…`);
  assert(
    !!sesA.integrationUrl && !!sesB.integrationUrl,
    "Les deux sessions ont une integrationUrl"
  );
  assert(
    sesA.integrationUrl !== sesB.integrationUrl,
    "integrationUrl DIFFÉRENTES → chaque dossier a son propre flux applicatif"
  );

  // 3.5 — Cookies totalement disjoints (aucun cookie identique dans les deux jars)
  subsection("Disjonction totale des cookie jars");
  const cookiesA = new Map<string, string>();
  const cookiesB = new Map<string, string>();
  for (const part of (sesA.sessionCookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k?.trim()) cookiesA.set(k.trim().toLowerCase(), v?.trim() ?? "");
  }
  for (const part of (sesB.sessionCookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=", 2);
    if (k?.trim()) cookiesB.set(k.trim().toLowerCase(), v?.trim() ?? "");
  }
  const sharedKeys   = [...cookiesA.keys()].filter(k => cookiesB.has(k));
  const sharedValues = sharedKeys.filter(k => cookiesA.get(k) === cookiesB.get(k) && cookiesA.get(k) !== "");
  if (sharedKeys.length > 0) {
    dim(`  Clés communes : ${sharedKeys.join(", ")}`);
    if (sharedValues.length > 0) {
      warn(`  ${sharedValues.length} valeur(s) identiques entre A et B : ${sharedValues.join(", ")}`);
    } else {
      ok(`  Clés communes mais valeurs TOUTES DIFFÉRENTES → isolation correcte`);
    }
  } else {
    ok(`  Zéro clé de cookie commune entre A et B → jars totalement disjoints`);
  }
  assert(
    sharedValues.length === 0,
    "Aucun cookie avec la même valeur dans les deux sessions"
  );

  // ─── PHASE 4 : Probe de slot (optionnel) ─────────────────────────────────

  if (DO_PROBE) {
    section("PHASE 4 — Probe de slot (les deux sessions, en parallèle)");
    info("pollCevSlot sur chaque session — dry-run, aucun booking");

    const t1 = Date.now();
    const [probeA, probeB] = await Promise.allSettled([
      pollCevSlot(sesA.integrationUrl!, sesA.sessionCookie!, undefined),
      pollCevSlot(sesB.integrationUrl!, sesB.sessionCookie!, undefined),
    ]);
    const probeMs = Date.now() - t1;
    info(`Durée probe parallèle : ${probeMs}ms`);

    subsection(`Probe A — ${VOWINT_A}`);
    if (probeA.status === "rejected") {
      fail(`Probe A crash: ${probeA.reason}`);
    } else {
      const r = probeA.value;
      if (r.status === "slot_found") {
        ok(`SLOT TROUVÉ sur dossier A ! (${VOWINT_A})`);
      } else {
        info(`Probe A → ${r.status} (pas de créneau actuellement)`);
      }
    }

    subsection(`Probe B — ${VOWINT_B}`);
    if (probeB.status === "rejected") {
      fail(`Probe B crash: ${probeB.reason}`);
    } else {
      const r = probeB.value;
      if (r.status === "slot_found") {
        ok(`SLOT TROUVÉ sur dossier B ! (${VOWINT_B})`);
      } else {
        info(`Probe B → ${r.status} (pas de créneau actuellement)`);
      }
    }

    // Assertion : les deux probes ont pu s'exécuter indépendamment (pas de crash de session)
    assert(
      probeA.status === "fulfilled" && probeB.status === "fulfilled",
      "Les deux sessions ont pu être utilisées en parallèle sans crash"
    );
  }

  // ─── Résumé ───────────────────────────────────────────────────────────────

  printSummary(elapsedMs);
}

function printSummary(elapsedMs?: number) {
  section("RÉSUMÉ");
  const total = passCount + failCount;
  console.log(`\n  Résultats : ${GREEN}${passCount} PASS${R}  /  ${RED}${failCount} FAIL${R}  /  ${total} total`);
  if (elapsedMs !== undefined) {
    const seqEstMs = elapsedMs * 2; // estimé si séquentiel
    console.log(`  Durée parallèle : ${elapsedMs}ms  (vs ~${seqEstMs}ms en séquentiel estimé)`);
  }

  if (failCount === 0) {
    console.log(`\n  ${GREEN}${BOLD}✅ Isolation de session CONFIRMÉE${R}`);
    console.log(`  ${DIM}Chaque dossier a sa propre session HTTP indépendante.${R}`);
    console.log(`  ${DIM}Le portail CEV ne verra pas d'erreur "multiple session".${R}\n`);
  } else {
    console.log(`\n  ${RED}${BOLD}❌ ${failCount} assertion(s) échouée(s) — vérifier les logs ci-dessus${R}\n`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error(`\n${RED}CRASH: ${e}${R}\n`);
  process.exit(1);
});
