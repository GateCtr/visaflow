/**
 * test-saopolo-e2e-signin.ts — E2E São Paulo en appelant DIRECTEMENT le code prod
 *
 * Utilise exactement les mêmes fonctions que runDossierWorker :
 *   initWorkerSession → initPhpState → scanDatetimeDirect → getsigninfields/ → signin/ → summary/
 *
 * Objectif : détecter à quelle étape le flux casse, avec les mêmes logs que la prod.
 * Les faux identifiants permettent de tester jusqu'à signin/ sans réellement booker.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-saopolo-e2e-signin.ts
 */

import "dotenv/config";
import { initWorkerSession }        from "../spain-soax-solver.js";
import { initPhpState, scanDatetimeDirect, type SpainDossierConfig, type WorkerPhpState } from "../spain-dossier-worker.js";
import { buildDynamicSession, callDirect, CALL_DIRECT_NETWORK_ERROR } from "../spain-bookitit-direct.js";

// ─── Config du dossier de test (simule un vrai dossier en prod) ───────────────

const PORTAL_URL   = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const FAKE_LOGIN    = process.env.TEST_SPAIN_LOGIN    ?? "TESTPASSPORT123";
const FAKE_PASSWORD = process.env.TEST_SPAIN_PASSWORD ?? "testpass123";

// SpainDossierConfig minimal pour les fonctions prod
const TEST_CONFIG: SpainDossierConfig = {
  id:              "test-e2e-saopolo",
  applicantName:   "TEST E2E SAOPOLO",
  visaType:        "schengen",
  login:           FAKE_LOGIN,
  password:        FAKE_PASSWORD,
  applicationId:   "TEST-APP-000",
  otpChannel:      "manual",
  portalUrl:       PORTAL_URL,
  slotDateFrom:    process.env.TEST_SLOT_DATE_FROM     ?? undefined,
  slotDateDeadline:process.env.TEST_SLOT_DATE_DEADLINE ?? undefined,
  groupSize:       Number(process.env.TEST_GROUP_SIZE  ?? "1"),
};

// ─── Helpers de log ───────────────────────────────────────────────────────────

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(tag: string, msg: string): void { console.log(`[${ts()}] [${tag}] ${msg}`); }
function section(title: string): void { console.log(`\n${"═".repeat(70)}\n  ${title}\n${"═".repeat(70)}`); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  section("E2E São Paulo — flux complet prod (faux identifiants)");

  const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY;

  // Proxy : lire depuis le CSV es.decodo.com (même source que le worker via pickDedicatedProxy)
  let PROXY_URL: string | undefined;
  try {
    const fs = await import("fs/promises");
    const csv = await fs.readFile("decodo-proxies.csv", "utf-8");
    const proxies = csv.trim().split("\n").filter(l => l.trim());
    if (proxies.length > 0) {
      const idx = Math.floor(Math.random() * Math.min(10, proxies.length));
      PROXY_URL = proxies[idx].trim();
      log("INFO", `Proxy CSV es.decodo.com #${idx + 1}/${proxies.length}: ${PROXY_URL.replace(/:([^@:]+)@/, ":***@")}`);
    }
  } catch {
    PROXY_URL = process.env.SPAIN_ISP_PROXY_URL ?? process.env.DECODO_PROXY_URL;
    log("INFO", `Proxy .env: ${PROXY_URL?.replace(/:([^@:]+)@/, ":***@") ?? "(aucun)"}`);
  }

  if (!CAPSOLVER_API_KEY) { log("ERR", "CAPSOLVER_API_KEY manquant"); process.exit(1); }
  if (!PROXY_URL)          { log("ERR", "Aucun proxy disponible");     process.exit(1); }

  log("INFO", `Portail: ${PORTAL_URL}`);
  log("INFO", `Login: ${FAKE_LOGIN} | Password: ${FAKE_PASSWORD}`);
  log("INFO", `slotDateFrom=${TEST_CONFIG.slotDateFrom ?? "(aucune)"} | slotDateDeadline=${TEST_CONFIG.slotDateDeadline ?? "(aucune)"} | groupSize=${TEST_CONFIG.groupSize}`);

  // ── ÉTAPE 1 : initWorkerSession — CF solve + PHPSESSID (code prod exact) ──
  section("ÉTAPE 1 — initWorkerSession (CF + PHPSESSID)");
  const initResult = await initWorkerSession(PROXY_URL, PORTAL_URL.split("#")[0], CAPSOLVER_API_KEY);
  if (!initResult) {
    log("ERR", "❌ initWorkerSession échoué — proxy mort ou CF bloqué");
    process.exit(1);
  }
  const { session, cfFromCache } = initResult;
  log("OK", `✅ Session CF établie | cfFromCache=${cfFromCache} | /main/=${session.prefetchedMainHtml?.length ?? 0}B`);

  // ── ÉTAPE 2 : initPhpState — getwidgetconfigurations/ + getservices/ + getagendas/ ──
  section("ÉTAPE 2 — initPhpState (cfg + svc + agenda)");
  const phpState: WorkerPhpState | null = await initPhpState(session, TEST_CONFIG, "[TEST]");
  if (!phpState) {
    log("ERR", "❌ initPhpState échoué — getservices/ 0B ou aucun service");
    process.exit(1);
  }
  log("OK", `✅ PHP init OK`);
  log("INFO", `  services (${phpState.services.length}):`);
  for (const s of phpState.services) {
    const marker = s.serviceId === phpState.bestServiceId ? " ← sélectionné" : "";
    log("INFO", `    • ${s.serviceId} : "${s.serviceName}"${marker}`);
  }
  log("INFO", `  bestService = ${phpState.bestServiceId} ("${phpState.bestServiceName}")`);
  log("INFO", `  agendaId    = ${phpState.agendaId || "(vide)"}`);
  log("INFO", `  allowAppointment = ${phpState.allowAppointment}`);

  if (!phpState.agendaId) {
    log("WARN", "⚠️ agendaId vide — portail fermé ou pas de créneaux (getagendas/ retourne vide)");
    log("INFO", "→ Le scan datetime/ retournera not_found — comportement normal si portail fermé");
    process.exit(0);
  }

  // ── ÉTAPE 3 : scanDatetimeDirect — boucle datetime/ multi-mois (code prod exact) ──
  section("ÉTAPE 3 — scanDatetimeDirect (boucle datetime/)");
  const scanResult = await scanDatetimeDirect(phpState, TEST_CONFIG, "[TEST]");
  log("INFO", `Scan status: ${scanResult.status}`);

  if (scanResult.status === "proxy_error") {
    log("ERR", `❌ proxy_error — ${scanResult.errorMessage ?? "proxy CONNECT cassé"}`);
    process.exit(1);
  }
  if (scanResult.status === "session_dead") {
    log("WARN", "⚠️ session_dead — datetime/ retourne 0B sur tous les mois (PHPSESSID expiré)");
    process.exit(0);
  }
  if (scanResult.status === "not_found" || !scanResult.slots || scanResult.slots.length === 0) {
    log("INFO", "ℹ️ Aucun créneau disponible pour ce dossier (not_found)");
    if (scanResult.monthTraces) {
      for (const mt of scanResult.monthTraces) {
        log("INFO", `  ${mt.month} → ${mt.slots} créneau(x) | ${mt.bytes}B | ok=${mt.ok}`);
      }
    }
    process.exit(0);
  }

  // Slots trouvés — afficher le résumé comme en prod
  log("OK", `✅ ${scanResult.slots.length} créneau(x) trouvé(s)`);
  if (scanResult.monthTraces) {
    for (const mt of scanResult.monthTraces) {
      log("INFO", `  ${mt.month} → ${mt.slots} créneau(x) | ${mt.bytes}B`);
    }
  }
  log("INFO", `Top 10 slots bruts:`);
  for (const s of scanResult.slots.slice(0, 10)) {
    log("INFO", `  • ${s.date} ${s.time} | freeSlots=${s.freeslots} | agenda=${s.agendaId ?? "(none)"}`);
  }

  // Filtre eligible — même logique que runDossierWorker
  // (isSlotInDateWindow est interne à spain-dossier-worker, on la reproduit ici depuis les configs)
  const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
  const eligible = scanResult.slots.filter(s => {
    if (!s.date) return false;
    const d = new Date(s.date);
    if (isNaN(d.getTime()) || d < todayMidnight) return false;
    if (s.freeslots <= 0) return false;
    // slotDateDeadline
    if (TEST_CONFIG.slotDateDeadline) {
      const dl = new Date(TEST_CONFIG.slotDateDeadline);
      if (!isNaN(dl.getTime()) && d > dl) return false;
    }
    // slotDateFrom avec tolérance 45j
    if (TEST_CONFIG.slotDateFrom) {
      const from = new Date(TEST_CONFIG.slotDateFrom);
      const tol = Number(process.env.SPAIN_SLOT_FROM_TOLERANCE_DAYS ?? "45");
      if (!isNaN(from.getTime()) && d < new Date(from.getTime() - tol * 86_400_000)) return false;
    }
    return true;
  });

  log("INFO", `Éligibles après filtre fenêtre: ${eligible.length}/${scanResult.slots.length}`);
  if (eligible.length === 0) {
    log("WARN", "⚠️ Aucun créneau dans la fenêtre de dates — vérifier slotDateFrom/Deadline");
    process.exit(0);
  }

  // Premier éligible — même logique que runDossierWorker (eligible[0] après sort)
  const slot = eligible[0];
  log("OK", `Créneau sélectionné: ${slot.date} ${slot.time} | freeSlots=${slot.freeslots} | agenda=${slot.agendaId}`);

  // ── ÉTAPE 4 : getsigninfields/ — amorce le nonce PHP (code prod exact) ────
  section("ÉTAPE 4 — getsigninfields/");
  // IMPORTANT : utiliser le ds de phpState, pas buildDynamicSession(session)
  // Le ds de phpState a le jar à jour après initPhpState + scanDatetimeDirect.
  // Recréer un ds depuis session.allCookies donnerait le vieux PHPSESSID.
  const ds = phpState.ds;

  const gsfPayload = await callDirect(ds, "getsigninfields/", {
    "services[]": phpState.bestServiceId,
    "agendas[]":  slot.agendaId ?? "",
    date:         slot.date,
    time:         slot.time,
    selectedPeople: String(TEST_CONFIG.groupSize ?? 1),
  }, "[TEST]");

  if (gsfPayload === CALL_DIRECT_NETWORK_ERROR) {
    log("WARN", "⚠️ getsigninfields/ → erreur réseau (proxy?)");
  } else if (!gsfPayload) {
    log("WARN", "⚠️ getsigninfields/ → 0B — signin/ risque aussi 0B");
  } else {
    log("OK", `✅ getsigninfields/ OK`);
    const gsf = gsfPayload as any;
    const captcha = gsf?.WidgetConfiguration?.captcha ?? gsf?.captcha ?? 0;
    log("INFO", `  captcha=${captcha} | raw: ${JSON.stringify(gsfPayload).slice(0, 120)}`);
  }

  // ── ÉTAPE 5 : signin/ — retry 3× comme en prod ────────────────────────────
  section("ÉTAPE 5 — signin/ (faux identifiants — retry 3×)");
  log("INFO", `Params: services[]=${phpState.bestServiceId} agendas[]=${slot.agendaId}`);
  log("INFO", `        date=${slot.date} time=${slot.time} selectedPeople=${TEST_CONFIG.groupSize ?? 1}`);
  log("INFO", `        logintype=document login=${FAKE_LOGIN} password=${FAKE_PASSWORD}`);

  let signinPayload: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = 3_000 * attempt;
      log("INFO", `Retry signin/ ${attempt}/2 (délai ${delay}ms)…`);
      await new Promise(r => setTimeout(r, delay));
    }
    const raw = await callDirect(ds, "signin/", {
      "services[]":   phpState.bestServiceId,
      "agendas[]":    slot.agendaId ?? "",
      date:           slot.date,
      time:           slot.time,
      selectedPeople: String(TEST_CONFIG.groupSize ?? 1),
      logintype:      "document",
      login:          FAKE_LOGIN,
      password:       FAKE_PASSWORD,
      comments:       "",
    }, "[TEST]");

    if (raw === null) {
      log("WARN", `signin/ tentative ${attempt + 1}/3 → 0B`);
      if (attempt < 2) continue;
      break;
    }
    if (raw === CALL_DIRECT_NETWORK_ERROR) {
      log("ERR", "❌ signin/ → erreur réseau");
      process.exit(1);
    }
    signinPayload = raw as Record<string, unknown>;
    break;
  }

  // Analyser la réponse signin/ exactement comme en prod
  section("RÉSULTAT signin/");
  if (!signinPayload) {
    log("WARN", "⚠️ signin/ → 0B après 3 tentatives");
    log("INFO", "→ En prod : cela déclenche signin_failed (pas de bktToken)");
    process.exit(0);
  }

  log("INFO", `Raw (400 chars): ${JSON.stringify(signinPayload).slice(0, 400)}`);

  const signinInner = (signinPayload as any)?.Client ?? signinPayload;
  // bktToken peut être dans Access.bktToken (app.bookitit.com) ou Client.bktToken (citaconsular.es)
  const bktToken = String(
    (signinPayload as any)?.Access?.bktToken ??
    signinInner?.bktToken ??
    (signinPayload as any)?.bktToken ??
    ""
  );
  const signinErrors: Array<{ message?: string }> = Array.isArray(signinInner?.errors) ? signinInner.errors : [];

  if (bktToken) {
    log("WARN", `⚠️ bktToken obtenu avec faux identifiants: ${bktToken.slice(0, 20)}…`);
    log("WARN", "INATTENDU — le portail a accepté les faux identifiants");

    // ── ÉTAPE 6 : summary/ — confirmation finale (code prod exact) ──────────
    // En prod : si bktToken présent → appel summary/ → locator = booking confirmé
    section("ÉTAPE 6 — summary/ (ne devrait pas arriver avec faux identifiants)");
    const summaryPayload = await callDirect(ds, "summary/", {
      "services[]": phpState.bestServiceId,
      "agendas[]":  slot.agendaId ?? "",
      date:         slot.date,
      time:         slot.time,
      bktToken,
      login:        FAKE_LOGIN,
      password:     FAKE_PASSWORD,
      logintype:    "document",
      comments:     "",
      client_signin: "true",
      event_created: "true",
    }, "[TEST]") as any;

    log("INFO", `summary/ raw: ${JSON.stringify(summaryPayload).slice(0, 300)}`);

    const eventList: any[] = Array.isArray(summaryPayload?.Event) ? summaryPayload.Event
      : summaryPayload?.Event ? [summaryPayload.Event] : [];
    const locator = eventList[0]?.Event?.locator ?? eventList[0]?.locator ?? summaryPayload?.locator ?? "";
    if (locator) {
      log("WARN", `🚨 BOOKING RÉEL avec faux identifiants — locator: ${locator} (ANNULER IMMÉDIATEMENT)`);
    } else {
      log("INFO", "summary/ sans locator — booking non confirmé (attendu)");
    }

  } else if (signinErrors.length > 0) {
    const msgs = signinErrors.map(e => e.message ?? "?").join(", ");
    log("OK", `✅ Erreur signin attendue: "${msgs}"`);
    log("OK", "Le portail rejette correctement les faux identifiants");
    log("OK", "→ Avec vrais identifiants : bktToken obtenu → summary/ → locator = booking confirmé");

  } else {
    log("INFO", "ℹ️ Réponse signin/ ambiguë — ni bktToken ni erreur");
    log("INFO", `Payload complet: ${JSON.stringify(signinPayload).slice(0, 600)}`);
  }

  // ── Résumé final ──────────────────────────────────────────────────────────
  section("RÉSUMÉ FLUX PROD");
  log("OK", "1. initWorkerSession     ✅ CF solve + /main/");
  log("OK", "2. initPhpState          ✅ cfg + svc + agenda");
  log("OK", `3. scanDatetimeDirect    ✅ ${eligible.length} créneau(x) éligible(s)`);
  log("OK", `4. getsigninfields/      ${!gsfPayload ? "⚠️ 0B" : "✅"}`);
  log("OK", `5. signin/               ${bktToken ? "⚠️ bktToken (inattendu)" : signinErrors.length ? "✅ erreur credentials" : "⚠️ 0B"}`);
  log("INFO", "6. summary/            → appelé uniquement si bktToken présent (prod uniquement)");
  log("OK", "Flux complet traversé sans crash — prêt pour vrais identifiants");

  process.exit(0);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
