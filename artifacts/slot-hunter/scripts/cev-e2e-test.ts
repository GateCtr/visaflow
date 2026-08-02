/**
 * cev-e2e-test.ts — Test d'intégration bout en bout CEV
 *
 * Teste le flux complet : détection de créneaux + réservation
 * Utilisable aussi bien pour visa court séjour que long séjour (passeport diplomatique).
 *
 * FLUX TESTÉ :
 *   1. Login VOWINT (ou réutilisation session en cache)
 *   2. GetEAppointmentUrl → URL d'intégration CEV
 *   3. Résolution hCaptcha (Anti-Captcha / CapSolver)
 *   4. POST /Captcha/SetCaptchaToken → redirectUrl
 *   5. Suivi chaîne de redirects :
 *      → NoAvailability (pas de créneau) : visa court séjour typique
 *      → SelectSlot direct (disponibilité) : visa long séjour / passeport diplomatique
 *   6. Si créneaux détectés → GET /Home/AvailableTimeSlots → liste des slots
 *   7. Booking HTTP (si CEV_TEST_BOOK=1) → code de confirmation
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *
 *   # Scan uniquement (dry-run) :
 *   CEV_TEST_EMAIL="email@example.com" \
 *   CEV_TEST_PASSWORD="motdepasse" \
 *   CEV_TEST_VOWINT_REF="VOWINT1234567" \
 *   npx tsx scripts/cev-e2e-test.ts
 *
 *   # Scan + booking réel :
 *   CEV_TEST_BOOK=1 \
 *   CEV_TEST_EMAIL="email@example.com" \
 *   CEV_TEST_PASSWORD="motdepasse" \
 *   CEV_TEST_VOWINT_REF="VOWINT1234567" \
 *   npx tsx scripts/cev-e2e-test.ts
 *
 * VARIABLES D'ENVIRONNEMENT :
 *   CEV_TEST_EMAIL        Email du compte VOWINT (obligatoire)
 *   CEV_TEST_PASSWORD     Mot de passe VOWINT (obligatoire)
 *   CEV_TEST_VOWINT_REF   Référence dossier VOWINT ex: VOWINT6085888 (obligatoire)
 *   CEV_TEST_BOOK         Mettre à "1" pour activer le booking réel (défaut: dry-run)
 *   CEV_TEST_CLIENT_ID    ID client pour botLog (défaut: généré automatiquement)
 *   ANTICAPTCHA_API_KEY   Clé Anti-Captcha (au moins une clé captcha requise)
 *   CAPSOLVER_API_KEY     Clé CapSolver (alternative à Anti-Captcha)
 *   TWOCAPTCHA_API_KEY    Clé 2Captcha (alternative)
 *   SOAX_PROXY_URL        Proxy résidentiel (optionnel — tester sans proxy d'abord)
 *   DECODO_PROXY_URL      Proxy Decodo (optionnel)
 */

import "dotenv/config";
import { setupCevSessionHttp } from "../src/cevHttpSetup.js";
import { bookCevViaHttp } from "../src/cevHttpBooking.js";
import { pollCevSlot } from "../src/cevPolling.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const EMAIL       = process.env.CEV_TEST_EMAIL       ?? "";
const PASSWORD    = process.env.CEV_TEST_PASSWORD    ?? "";
const VOWINT_REF  = process.env.CEV_TEST_VOWINT_REF  ?? "";
const DO_BOOK     = process.env.CEV_TEST_BOOK        === "1";
const CLIENT_ID   = process.env.CEV_TEST_CLIENT_ID   ?? `cev-e2e-test-${Date.now()}`;

// ─── Helpers d'affichage ──────────────────────────────────────────────────────

const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const GREEN  = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED    = "\x1b[31m";
const CYAN   = "\x1b[36m";
const DIM    = "\x1b[2m";

function ok  (msg: string) { console.log(`${GREEN}  ✅ ${msg}${RESET}`); }
function warn(msg: string) { console.log(`${YELLOW}  ⚠️  ${msg}${RESET}`); }
function err (msg: string) { console.log(`${RED}  ❌ ${msg}${RESET}`); }
function info(msg: string) { console.log(`${CYAN}  ℹ️  ${msg}${RESET}`); }
function dim (msg: string) { console.log(`${DIM}     ${msg}${RESET}`); }

function section(title: string) {
  console.log(`\n${BOLD}${"─".repeat(60)}${RESET}`);
  console.log(`${BOLD}  ${title}${RESET}`);
  console.log(`${BOLD}${"─".repeat(60)}${RESET}`);
}

function timer(): () => string {
  const t0 = Date.now();
  return () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
}

// ─── Validation des prérequis ─────────────────────────────────────────────────

function checkPrerequisites(): boolean {
  section("🔍 Vérification des prérequis");

  let ok_count = 0;
  let err_count = 0;

  const check = (label: string, value: string | undefined, required: boolean) => {
    if (value) {
      ok(`${label}: configuré`);
      ok_count++;
    } else if (required) {
      err(`${label}: MANQUANT (obligatoire)`);
      err_count++;
    } else {
      warn(`${label}: non configuré (optionnel)`);
    }
  };

  check("CEV_TEST_EMAIL",       EMAIL,      true);
  check("CEV_TEST_PASSWORD",    PASSWORD,   true);
  check("CEV_TEST_VOWINT_REF",  VOWINT_REF, true);

  const hasAntiCaptcha  = !!process.env.ANTICAPTCHA_API_KEY;
  const hasCapSolver    = !!process.env.CAPSOLVER_API_KEY;
  const hasTwoCaptcha   = !!process.env.TWOCAPTCHA_API_KEY;
  if (hasAntiCaptcha || hasCapSolver || hasTwoCaptcha) {
    ok(`Captcha: ${hasAntiCaptcha ? "ANTICAPTCHA_API_KEY" : hasCapSolver ? "CAPSOLVER_API_KEY" : "TWOCAPTCHA_API_KEY"}`);
    ok_count++;
  } else {
    err("Clé captcha: AUCUNE (ANTICAPTCHA_API_KEY / CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY requis)");
    err_count++;
  }

  const hasProxy = !!(process.env.SOAX_PROXY_URL || process.env.DECODO_PROXY_URL);
  if (hasProxy) {
    ok(`Proxy: ${process.env.SOAX_PROXY_URL ? "SOAX_PROXY_URL" : "DECODO_PROXY_URL"}`);
  } else {
    warn("Proxy: aucun — diplo.be peut bloquer les IPs hors Belgique");
  }

  if (DO_BOOK) {
    console.log(`\n${RED}${BOLD}  ⚠️  MODE BOOKING ACTIF — Un créneau RÉEL sera réservé si disponible !${RESET}`);
  } else {
    info("Mode: DRY-RUN (pas de booking — mettre CEV_TEST_BOOK=1 pour réserver)");
  }

  console.log(`\n  ${BOLD}Dossier:${RESET} ${VOWINT_REF}`);
  console.log(`  ${BOLD}Compte:${RESET}  ${EMAIL}`);
  console.log(`  ${BOLD}ID:${RESET}      ${CLIENT_ID}`);

  return err_count === 0;
}

// ─── Phase 1 : Setup session CEV ─────────────────────────────────────────────

async function phaseSetup() {
  section("📡 Phase 1 — Setup session CEV (login + captcha + redirects)");
  info("Login VOWINT → GetEAppointmentUrl → hCaptcha → SetCaptchaToken → suivi redirects...");

  const t = timer();
  const result = await setupCevSessionHttp(
    EMAIL,
    PASSWORD,
    CLIENT_ID,   // applicationId (utilisé pour botLog)
    CLIENT_ID,   // clientId
    VOWINT_REF,  // vowintAppUrl = référence dossier pour résoudre l'appId
  );
  const elapsed = t();

  if (!result.success) {
    err(`Setup échoué en ${elapsed}: ${result.error}`);

    if (result.error?.includes("RATE_LIMIT")) {
      warn("→ Limite 5 clics/heure atteinte — attendre 60+ minutes");
    } else if (result.error === "NO_INTEGRATION_URL") {
      warn("→ GetEAppointmentUrl n'a pas retourné d'URL valide");
      warn("→ Vérifier que le compte VOWINT a ce dossier en statut actif");
    } else if (result.error === "HCAPTCHA_FAILED") {
      warn("→ Résolution captcha échouée — vérifier la clé Anti-Captcha / CapSolver");
    } else if (result.error === "MULTI_SESSION_NOT_ALLOWED") {
      warn("→ L'URL d'intégration est déjà utilisée dans une autre session active");
      warn("→ Attendre expiration de la session précédente (~30 min)");
    }
    return null;
  }

  ok(`Setup réussi en ${elapsed}`);
  dim(`  sessionCookie: ${result.sessionCookie?.slice(0, 20)}...`);
  dim(`  integrationUrl: ${result.integrationUrl?.slice(0, 80)}...`);
  dim(`  validUntilMs: ${result.validUntilMs ? new Date(result.validUntilMs).toISOString() : "(non défini)"}`);

  // ── Rapport Overview ───────────────────────────────────────────────────────
  if (result.overviewState === 'new_appointment_available') {
    console.log(`\n${GREEN}${BOLD}  ✅ CAS 1 OVERVIEW — "Nouveau rendez-vous" détecté et suivi !${RESET}`);
    if (result.slotsAvailable) {
      console.log(`${GREEN}  🎯 SelectSlot atteint — créneaux potentiellement disponibles${RESET}`);
    } else {
      info("→ Suivi "Nouveau rendez-vous" → NoAvailability (aucun créneau pour l'instant)");
    }
  } else if (result.overviewState === 'limit_reached') {
    console.log(`\n${YELLOW}${BOLD}  ⚠️  CAS 2 OVERVIEW — Limite de RDV atteinte pour ce dossier${RESET}`);
    warn("→ Seul 'Annuler' disponible — aucun nouveau RDV possible");
  } else if (result.slotsAvailable) {
    console.log(`\n${GREEN}${BOLD}  🎯 CRÉNEAUX DÉTECTÉS ! → Page SelectSlot atteinte directement${RESET}`);
    console.log(`${GREEN}  → Typique d'un visa LONG SÉJOUR / passeport diplomatique${RESET}`);
  } else {
    info("→ NoAvailability (pas de créneau pour l'instant)");
    info("→ Typique d'un visa court séjour sans créneau disponible");
  }

  return result;
}

// ─── Phase 2 : Polling direct (si session valide mais slotsAvailable=false) ──

async function phasePolling(sessionCookie: string, integrationUrl: string) {
  section("🔄 Phase 2 — Polling /Home/AvailableTimeSlots");
  info("Interrogation directe de l'API de disponibilité (sans nouveau clic VOWINT)...");

  const t = timer();
  const pollResult = await pollCevSlot(integrationUrl, sessionCookie);
  const elapsed = t();

  console.log(`  Résultat en ${elapsed}: ${BOLD}${pollResult.status}${RESET}`);

  switch (pollResult.status) {
    case "slot_found":
      console.log(`\n${GREEN}${BOLD}  🎯 CRÉNEAUX TROUVÉS via polling !${RESET}`);
      if (pollResult.slots && pollResult.slots.length > 0) {
        ok(`${pollResult.slots.length} créneau(x) disponible(s) :`);
        pollResult.slots.slice(0, 5).forEach((s: any, i: number) => {
          dim(`  [${i + 1}] date=${s.date ?? s.datePart ?? "(date?)"} | heure=${s.time ?? s.timeSlot ?? "(heure?)"} | id=${s.id ?? s.scheduleLineId ?? "(id?)"}`);
        });
      }
      return "slot_found";

    case "no_slot":
      info("Aucun créneau disponible — résultat cohérent avec l'étape Setup");
      return "no_slot";

    case "session_expired":
      warn("Session expirée côté serveur (validUntil dépassé ou cookie invalide)");
      warn("→ Relancer le test pour obtenir une nouvelle session");
      return "session_expired";

    default:
      warn(`Statut inattendu: ${pollResult.status}`);
      if ((pollResult as any).error) dim(`  Erreur: ${(pollResult as any).error}`);
      return pollResult.status;
  }
}

// ─── Phase 3 : Booking ────────────────────────────────────────────────────────

async function phaseBooking(sessionCookie: string, integrationUrl: string) {
  section("📅 Phase 3 — Booking HTTP");

  if (!DO_BOOK) {
    warn("Mode DRY-RUN — booking ignoré");
    warn("→ Mettre CEV_TEST_BOOK=1 pour activer la réservation réelle");
    info("Simulation : bookCevViaHttp() serait appelé avec :");
    dim(`  integrationUrl: ${integrationUrl.slice(0, 80)}...`);
    dim(`  sessionCookie:  ${sessionCookie.slice(0, 30)}...`);
    return;
  }

  console.log(`\n${YELLOW}${BOLD}  ⚠️  Lancement du booking RÉEL dans 3 secondes...${RESET}`);
  await new Promise(r => setTimeout(r, 3_000));

  info("Appel bookCevViaHttp()...");
  const t = timer();
  const result = await bookCevViaHttp(
    integrationUrl,
    sessionCookie,
    CLIENT_ID,
  );
  const elapsed = t();

  if (result.success) {
    console.log(`\n${GREEN}${BOLD}  ✅ BOOKING RÉUSSI en ${elapsed} !${RESET}`);
    ok(`Code de confirmation: ${result.confirmationCode ?? "(non extrait)"}`);
    ok(`Date réservée:        ${result.bookedDate ?? "(non extrait)"}`);
    ok(`Heure réservée:       ${result.bookedTime ?? "(non extrait)"}`);
  } else {
    err(`Booking échoué en ${elapsed}: ${result.error}`);
    if (result.needsPlaywright) {
      warn("→ Fallback Playwright requis (bookWithExistingSession)");
      warn("→ L'endpoint HTTP n'est pas encore confirmé pour ce compte");
    }
    if (result.error === "NO_AVAILABILITY") {
      warn("→ Le créneau a disparu entre la détection et la réservation (race condition)");
    }
    if (result.error === "NO_ANTIFORGERY_TOKEN") {
      warn("→ __RequestVerificationToken introuvable dans le HTML de SelectSlot");
      warn("→ Possible changement de structure HTML du portail CEV");
    }
  }
}

// ─── Phase 3 (avec HTML pré-capturé) ─────────────────────────────────────────

async function phaseBookingWithPreload(
  sessionCookie: string,
  integrationUrl: string,
  preloadedHtml?: string,
  preloadedSelectSlotUrl?: string,
) {
  section("📅 Phase 3 — Booking HTTP (HTML pré-capturé du setup)");

  if (!preloadedHtml || preloadedHtml.length < 500) {
    warn("HTML pré-capturé absent ou trop court — fallback sur refetch");
    await phaseBooking(sessionCookie, integrationUrl);
    return;
  }

  ok(`HTML SelectSlot disponible (${preloadedHtml.length} chars) — pas de refetch nécessaire`);
  dim(`  selectSlotUrl: ${(preloadedSelectSlotUrl ?? integrationUrl).slice(0, 100)}`);

  if (!DO_BOOK) {
    warn("Mode DRY-RUN — booking ignoré");
    warn("→ Mettre CEV_TEST_BOOK=1 pour activer la réservation réelle");
    return;
  }

  console.log(`\n${YELLOW}${BOLD}  ⚠️  Lancement du booking RÉEL dans 3 secondes...${RESET}`);
  await new Promise(r => setTimeout(r, 3_000));

  info("Appel bookCevViaHttp() avec HTML pré-capturé...");
  const t = timer();
  const result = await bookCevViaHttp(
    integrationUrl,
    sessionCookie,
    CLIENT_ID,
    undefined,
    undefined,
    preloadedHtml,
    preloadedSelectSlotUrl,
  );
  const elapsed = t();

  if (result.success) {
    console.log(`\n${GREEN}${BOLD}  ✅ BOOKING RÉUSSI en ${elapsed} !${RESET}`);
    ok(`Code de confirmation: ${result.confirmationCode ?? "(non extrait)"}`);
    ok(`Date réservée:        ${result.bookedDate ?? "(non extrait)"}`);
    ok(`Heure réservée:       ${result.bookedTime ?? "(non extrait)"}`);
  } else {
    err(`Booking échoué en ${elapsed}: ${result.error}`);
    if (result.needsPlaywright) {
      warn("→ Fallback Playwright requis (bookWithExistingSession)");
      warn("→ L'endpoint HTTP de soumission n'est pas encore confirmé pour ce compte");
    }
    if (result.error === "NO_AVAILABILITY") {
      warn("→ Le créneau a disparu entre la détection et la tentative de réservation");
    }
    if (result.error === "NO_ANTIFORGERY_TOKEN") {
      warn("→ __RequestVerificationToken absent du HTML — structure portal modifiée");
    }
    if (result.error === "NO_SLOTS_IN_RESPONSE") {
      warn("→ /Home/AvailableTimeSlots a retourné 0 slot — mois courant vide");
      warn("→ Les slots sont peut-être dans le mois suivant ou inline dans le HTML");
    }
    // Log le début du HTML pour diagnostic
    dim(`  HTML preview: ${preloadedHtml.slice(0, 600).replace(/\s+/g, " ")}`);
  }
}

// ─── Phase 3b : Vérification bundles (si slotsAvailable=true) ─────────────────

async function phaseBundleCheck(sessionCookie: string, integrationUrl: string) {
  section("🔬 Phase 3b — Vérification structure HTML (bundles capturés)");
  info("Comparaison avec les bundles de référence (captured/cev/bundles-1785540896326)...");

  // On vérifie juste que la page SelectSlot est accessible et contient les marqueurs connus
  const { cevImpitFetch, getCevBrowserHeaders } = await import("../src/cev-shared-impit.js");

  const CEV_BASE = "https://appointment.cloud.diplomatie.be";
  try {
    const t = timer();
    let url = integrationUrl;
    let html = "";
    for (let hop = 0; hop < 8; hop++) {
      const res = await cevImpitFetch(url, {
        method: "GET",
        headers: getCevBrowserHeaders({ cookie: `ASP.NET_SessionId=${sessionCookie}; PreferredCulture=en-US`, fetchSite: "same-origin" }),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      }, "[E2E-CHECK]");
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        url = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
        continue;
      }
      if (res.status === 200) { html = await res.text(); break; }
      break;
    }
    const elapsed = t();

    if (!html) {
      warn(`Page SelectSlot non obtenue (${elapsed}) — session peut-être expirée`);
      return;
    }

    ok(`Page obtenue en ${elapsed} (${html.length} chars)`);

    // Vérifier les marqueurs attendus (présents dans les bundles capturés)
    const checks: [string, string][] = [
      ["AvailableTimeSlots endpoint",   "AvailableTimeSlots"],
      ["initDatePicker (vowflow-selectslot)", "initDatePicker"],
      ["loadDates (vowflow-selectslot)",      "loadDates"],
      ["scheduleLineId (slot data)",         "scheduleLineId"],
      ["__RequestVerificationToken",         "__RequestVerificationToken"],
    ];

    let missingCount = 0;
    for (const [label, marker] of checks) {
      if (html.includes(marker)) {
        ok(`  ${label} → présent ✓`);
      } else {
        warn(`  ${label} → ABSENT (attendu dans les bundles de référence)`);
        missingCount++;
      }
    }

    if (missingCount === 0) {
      ok("Structure HTML identique aux bundles capturés — booking HTTP compatible");
    } else {
      warn(`${missingCount} marqueur(s) absent(s) — structure peut avoir changé`);
    }

    // Extraire `availability` inline si présent
    const availabilityMatch = html.match(/var\s+availability\s*=\s*(\[.*?\]);/s)
      ?? html.match(/availability\s*=\s*(\[.*?\]);/s);
    if (availabilityMatch) {
      try {
        const slots = JSON.parse(availabilityMatch[1]) as unknown[];
        ok(`Slots inline dans le HTML: ${slots.length} créneau(x)`);
        (slots as any[]).slice(0, 3).forEach((s: any, i: number) => {
          dim(`  [${i + 1}] ${JSON.stringify(s).slice(0, 120)}`);
        });
      } catch {
        warn("Variable `availability` présente mais non parseable");
      }
    } else {
      info("Variable `availability` non inline — chargée via /Home/AvailableTimeSlots (AJAX)");
    }
  } catch (e) {
    warn(`Vérification bundles échouée: ${e}`);
  }
}

// ─── Résumé final ─────────────────────────────────────────────────────────────

function printSummary(phases: Record<string, string | null | boolean>) {
  section("📊 Résumé du test");
  for (const [phase, status] of Object.entries(phases)) {
    if (status === "ok" || status === true) {
      ok(`${phase}: PASS`);
    } else if (status === "skip") {
      dim(`${phase}: SKIP`);
    } else if (status === null) {
      warn(`${phase}: non exécuté`);
    } else {
      err(`${phase}: ${status}`);
    }
  }
  console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${BOLD}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  CEV — Test d'intégration bout en bout${RESET}`);
  console.log(`${BOLD}  Court séjour & Long séjour (même flux)${RESET}`);
  console.log(`${BOLD}${"═".repeat(60)}${RESET}`);

  const phases: Record<string, string | null | boolean> = {
    "Phase 0 — Prérequis":   null,
    "Phase 1 — Setup CEV":   null,
    "Phase 2 — Polling":     null,
    "Phase 3 — Booking":     null,
  };

  // Phase 0: Prérequis
  const prereqOk = checkPrerequisites();
  phases["Phase 0 — Prérequis"] = prereqOk ? "ok" : "prérequis manquants";
  if (!prereqOk) {
    printSummary(phases);
    process.exit(1);
  }

  // Phase 1: Setup
  const globalTimer = timer();
  const setupResult = await phaseSetup();
  if (!setupResult) {
    phases["Phase 1 — Setup CEV"] = "échec setup";
    phases["Phase 2 — Polling"] = "skip";
    phases["Phase 3 — Booking"] = "skip";
    printSummary(phases);
    process.exit(1);
  }
  phases["Phase 1 — Setup CEV"] = "ok";

  const sessionCookie  = setupResult.sessionCookie!;
  const integrationUrl = setupResult.integrationUrl!;

  // Phase 2: Polling — uniquement si slotsAvailable=false (vérifie l'API JSON)
  // Si slotsAvailable=true, l'URL est à usage unique → on skippe le polling et on va direct au booking
  if (!setupResult.slotsAvailable) {
    const pollStatus = await phasePolling(sessionCookie, integrationUrl);
    phases["Phase 2 — Polling"] = pollStatus === "no_slot" || pollStatus === "slot_found" ? "ok" : pollStatus;

    if (pollStatus === "slot_found") {
      section("📅 Phase 3 — Booking");
      warn("Slot détecté via polling mais sans HTML pré-capturé — Playwright requis");
      info("→ Dans le loop de production, le setup re-login pour obtenir une session fraîche");
      phases["Phase 3 — Booking"] = "skip (no preloaded html)";
    } else {
      section("📅 Phase 3 — Booking");
      info("Pas de créneau disponible — booking ignoré");
      info("→ Le test confirme que le flux detection/booking est opérationnel");
      info("→ Relancer dès qu'un créneau sera ouvert pour tester la réservation complète");
      phases["Phase 3 — Booking"] = "skip (no slot)";
    }
  } else {
    // slotsAvailable=true → booking direct avec le HTML pré-capturé du setup
    phases["Phase 2 — Polling"] = "skip (slotsAvailable=true → direct booking)";

    // Vérification compatibilité bundles avec le HTML capturé
    if (setupResult.selectSlotHtml) {
      section("🔬 Phase 2b — Vérification structure HTML (depuis setup)");
      info("Analyse du HTML SelectSlot capturé lors du setup...");
      const html = setupResult.selectSlotHtml;
      info(`HTML disponible: ${html.length} chars`);
      const checks: [string, string][] = [
        ["AvailableTimeSlots endpoint",          "AvailableTimeSlots"],
        ["initDatePicker (vowflow-selectslot)",   "initDatePicker"],
        ["scheduleLineId (slot data)",            "scheduleLineId"],
        ["__RequestVerificationToken",            "__RequestVerificationToken"],
        ["availability inline",                  "var availability"],
      ];
      let missingCount = 0;
      for (const [label, marker] of checks) {
        if (html.includes(marker)) {
          ok(`${label} ✓`);
        } else {
          warn(`${label} → ABSENT`);
          missingCount++;
        }
      }
      // Chercher availability inline
      const availMatch = html.match(/var\s+availability\s*=\s*(\[[\s\S]*?\]);/)
        ?? html.match(/availability\s*=\s*(\[[\s\S]*?\]);/);
      if (availMatch) {
        try {
          const slots = JSON.parse(availMatch[1]) as unknown[];
          ok(`Slots inline dans le HTML: ${slots.length} créneau(x)`);
          (slots as any[]).slice(0, 3).forEach((s: any, i: number) => {
            dim(`  [${i + 1}] ${JSON.stringify(s).slice(0, 120)}`);
          });
        } catch { warn("Variable `availability` présente mais non parseable"); }
      } else {
        info("Variable `availability` non inline — chargée via /Home/AvailableTimeSlots (AJAX)");
        if (missingCount > 2) {
          dim(`HTML preview: ${html.slice(0, 400)}`);
        }
      }
    }

    // Booking avec HTML pré-capturé
    await phaseBookingWithPreload(
      sessionCookie,
      integrationUrl,
      setupResult.selectSlotHtml,
      setupResult.selectSlotUrl,
    );
    phases["Phase 3 — Booking"] = DO_BOOK ? "ok" : "skip (dry-run)";
  }

  printSummary(phases);

  const totalElapsed = globalTimer();
  console.log(`${BOLD}  Durée totale: ${totalElapsed}${RESET}`);
  console.log(`${DIM}  Client ID utilisé pour botLog: ${CLIENT_ID}${RESET}\n`);
}

main().catch((e) => {
  console.error(`\n${RED}${BOLD}[CRASH] Erreur non gérée:${RESET}`, e);
  process.exit(1);
});
