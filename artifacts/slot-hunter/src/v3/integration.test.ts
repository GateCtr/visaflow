/**
 * Test d'intégration V3 — Vérifie que tous les modules fonctionnent ensemble.
 *
 * NE FAIT PAS d'appels réseau (pas de login réel, pas de proxy réel).
 * Vérifie les interactions entre les modules :
 *   - session-pool ↔ scan-orchestrator
 *   - prediction-engine ↔ scan-orchestrator
 *   - config-schema ↔ session-pool
 *   - booking-payload (schedule + reschedule)
 *   - discovery-enrichment ↔ booking-blind
 *   - fingerprint ↔ human-timing
 *   - stealth-alternation
 *
 * Usage : npx tsx src/v3/integration.test.ts
 */

import {
  canLogin,
  recordLogin,
  recordProxyDeath,
  getRemainingLogins,
  getBudgetSnapshot,
  isRushHour,
  _resetForTesting as resetSessionPool,
  updateConfig,
} from "./core/session-pool.js";

import {
  getNextScanDecision,
  getCurrentPhaseLabel,
} from "./scan/scan-orchestrator.js";

import {
  getSlotPattern,
  getCurrentPredictionScore,
  getCompetitionMedianMs,
  recordSlotDetected,
  recordSlotGone,
  recordBlindBookingResult,
  _resetForTesting as resetPrediction,
} from "./intelligence/prediction-engine.js";

import {
  extractBudgetFromConfig,
  resolveAccountRole,
  parseRushWindowsFromBotConfig,
  matchesPriorityDate,
  validateConfigV3,
} from "./admin/config-schema.js";

import {
  buildBookingRequest,
  formatUItime,
  summarizeBookingPayload,
} from "./booking/booking-payload.js";

import {
  getFingerprintForToday,
  clearFingerprint,
  buildHeadersFromFingerprint,
} from "./anti-detection/fingerprint.js";

import {
  pickNextEndpoint,
  resetAlternation,
  getAlternationStats,
} from "./anti-detection/stealth-alternation.js";

import { resolveAccountRole as resolveRole } from "./admin/config-schema.js";

import type { OrchestratorContext } from "./scan/scan-orchestrator.js";
import type { BookingPayloadConfig } from "./booking/booking-payload.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

section("1. Session Pool ↔ Config Schema");
resetSessionPool();
updateConfig({ minInterLoginMs: 0 });
{
  // Extraire un budget custom depuis un hunterConfig
  const budget = extractBudgetFromConfig({ maxLoginsPerDay: 7 });
  assert(budget.maxPerDay === 7, "Budget custom maxPerDay=7");
  assert(budget.allocation.rush + budget.allocation.standard + budget.allocation.emergency <= 7, "Allocation ≤ 7");

  // Utiliser ce budget dans canLogin
  const d = canLogin("integration-test@test.com", budget);
  assert(d.allowed === true, "Login autorisé avec budget custom");
  assert(d.remaining === 6, "Remaining = 6 (7-1)");

  // Consommer 7 logins
  for (let i = 0; i < 7; i++) {
    recordLogin("integration-test@test.com", "standard");
  }
  const d2 = canLogin("integration-test@test.com", budget);
  assert(d2.allowed === false, "Login refusé après 7 (budget custom épuisé)");
  assert(d2.reason!.includes("épuisé"), "Raison: budget épuisé");
}

section("2. Prediction Engine ↔ Scan Orchestrator");
resetPrediction();
resetSessionPool();
updateConfig({ minInterLoginMs: 0 });
{
  // Simuler 10 slots détectés pour alimenter la heatmap
  for (let i = 0; i < 10; i++) {
    recordSlotDetected("pred-test@test.com", "Kinshasa", "2026-09-15");
  }

  const score = getCurrentPredictionScore("pred-test@test.com");
  assert(score > 0, `Prediction score > 0 après 10 observations (got ${score.toFixed(2)})`);

  // Le pattern doit avoir des données
  const pattern = getSlotPattern("pred-test@test.com");
  assert(pattern.totalObservations === 10, "10 observations enregistrées");
  assert(pattern.bestDays.length > 0, "bestDays non vide");

  // Le scan-orchestrator doit utiliser le score
  recordLogin("pred-test@test.com", "standard"); // Pour avoir un token "valide"
  const ctx: OrchestratorContext = {
    accountRole: "eclaireur",
    predictionScore: score,
    competitionMedianMs: 0,
    loginsRemaining: 8,
    hasValidToken: true,
    scanIntensity: "normal",
    nightMode: "minimal",
  };
  const decision = getNextScanDecision(ctx);
  assert(decision.shouldScan === true, "Éclaireur doit scanner");
  assert(decision.intervalMs > 0, `Intervalle > 0 (got ${decision.intervalMs}ms)`);
}

section("3. Scan Orchestrator — Confiné ne scanne JAMAIS");
{
  const ctx: OrchestratorContext = {
    accountRole: "confine",
    predictionScore: 0.9, // Même avec score max
    competitionMedianMs: 10_000,
    loginsRemaining: 9,
    hasValidToken: true,
    scanIntensity: "aggressive",
    nightMode: "full",
  };
  const decision = getNextScanDecision(ctx);
  assert(decision.shouldScan === false, "Confiné ne scanne PAS");
  assert(decision.isConfined === true, "isConfined = true");
  assert(decision.reason.includes("confiné"), "Raison mentionne 'confiné'");
}

section("4. Scan Orchestrator — Compétition extrême → burst 15-20s (ou nuit)");
{
  const ctx: OrchestratorContext = {
    accountRole: "eclaireur",
    predictionScore: 0.3,
    competitionMedianMs: 25_000, // < 30s = extrême
    loginsRemaining: 5,
    hasValidToken: true,
    scanIntensity: "normal",
    nightMode: "minimal",
  };
  const decision = getNextScanDecision(ctx);
  assert(decision.shouldScan === true, "Doit scanner en compétition extrême");
  // En mode nuit, la compétition n'override pas (le bot est en mode économie)
  // En mode rush/standard, la compétition override à burst
  const currentPhase = getCurrentPhaseLabel();
  if (currentPhase === "night") {
    assert(decision.phase === "night", `Phase = night (mode nocturne actif, got ${decision.phase})`);
    assert(decision.intervalMs > 0, `Intervalle nuit > 0 (got ${decision.intervalMs}ms)`);
  } else {
    assert(decision.phase === "burst", `Phase = burst (got ${decision.phase})`);
    assert(decision.intervalMs >= 15_000 && decision.intervalMs <= 20_000, `Intervalle 15-20s (got ${decision.intervalMs}ms)`);
  }
}

section("5. Booking Payload — Schedule vs Reschedule");
{
  const baseConfig: BookingPayloadConfig = {
    mode: "schedule",
    slot: { slotId: "ABC123XYZ", startTime: "09:00", endTime: "09:30" },
    slotDate: "2026-09-15",
    applicationId: "app-001",
    applicantId: "RQUP3HHVQHOD",
    postUserId: 42,
    appointmentId: 999,
    applicantUUID: 777,
    targetLocationType: "POST",
    accessToken: "eyJhbGciOiJSUzI1NiJ9.fake.token",
    missionId: 323,
    csrfToken: "", // Vide — le serveur l'ignore
  };

  // Schedule
  const schedule = buildBookingRequest(baseConfig);
  assert(schedule.endpoint.includes("/schedule"), "Endpoint = /schedule");
  const scheduleBody = JSON.parse(schedule.body);
  assert(typeof scheduleBody === "object" && !Array.isArray(scheduleBody), "Body schedule = objet (pas array)");
  assert(scheduleBody.appointmentStatus === "SCHEDULED", "appointmentStatus = SCHEDULED");
  assert(scheduleBody.slotId === "ABC123XYZ", "slotId correct");
  assert(scheduleBody.appointmentTime === "9:00 AM", "appointmentTime format 12h AM");

  // Reschedule
  const rescheduleConfig: BookingPayloadConfig = {
    ...baseConfig,
    mode: "reschedule",
    existingLocationType: "POST",
  };
  const reschedule = buildBookingRequest(rescheduleConfig);
  assert(reschedule.endpoint.includes("/reschedule"), "Endpoint = /reschedule");
  const rescheduleBody = JSON.parse(reschedule.body);
  assert(Array.isArray(rescheduleBody), "Body reschedule = ARRAY");
  assert(rescheduleBody[0].rescheduleType === "POST", "rescheduleType = POST");
  assert(rescheduleBody[0].slotId === "ABC123XYZ", "slotId dans l'array");

  // Headers CSRF vides
  assert(schedule.headers["X-XSRF-TOKEN"] === "", "CSRF vide (schedule)");
  assert(reschedule.headers["CookieName"] === "XSRF-TOKEN=", "CookieName vide (reschedule)");
}

section("6. formatUItime — conversion 24h → 12h AM/PM");
{
  assert(formatUItime("09:00") === "9:00 AM", "09:00 → 9:00 AM");
  assert(formatUItime("14:30") === "2:30 PM", "14:30 → 2:30 PM");
  assert(formatUItime("00:00") === "12:00 AM", "00:00 → 12:00 AM");
  assert(formatUItime("12:00") === "12:00 PM", "12:00 → 12:00 PM");
  assert(formatUItime("2026-09-15T08:30:00") === "8:30 AM", "ISO → 8:30 AM");
}

section("7. Config Schema — resolveAccountRole");
{
  assert(resolveRole({ accountRole: "eclaireur" }) === "eclaireur", "Rôle explicite: eclaireur");
  assert(resolveRole({ accountRole: "confine" }) === "confine", "Rôle explicite: confine");

  // Auto-détection depuis date RDV
  const now = new Date();
  const proche = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // +2 mois
  const lointain = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // +1 an
  assert(resolveRole({ currentAppointmentDate: proche.toISOString().slice(0, 10) }) === "eclaireur", "RDV +2 mois = éclaireur");
  assert(resolveRole({ currentAppointmentDate: lointain.toISOString().slice(0, 10) }) === "confine", "RDV +1 an = confiné");

  // Fallback
  assert(resolveRole({}) === "hybride", "Pas de config = hybride");
}

section("8. Config Schema — parseRushWindows");
{
  const windows = parseRushWindowsFromBotConfig('[{"start":7,"end":9.5,"days":[1,2,3,4,5]},{"start":12,"end":14}]');
  assert(windows !== null, "Parse OK");
  assert(windows!.length === 2, "2 fenêtres");
  assert(windows![0].start === 7, "Première fenêtre start=7");
  assert(windows![0].days?.length === 5, "5 jours");
  assert(windows![1].days === undefined, "Deuxième fenêtre: tous les jours");

  assert(parseRushWindowsFromBotConfig("") === null, "String vide → null");
  assert(parseRushWindowsFromBotConfig("invalid json") === null, "JSON invalide → null");
}

section("9. Config Schema — matchesPriorityDate");
{
  assert(matchesPriorityDate("2026-09-15", ["2026-09-*"]) === true, "Wildcard mois match");
  assert(matchesPriorityDate("2026-10-01", ["2026-09-*"]) === false, "Wildcard mois no match");
  assert(matchesPriorityDate("2026-09-15", ["2026-09-15"]) === true, "Date exacte match");
  assert(matchesPriorityDate("2026-09-16", ["2026-09-15"]) === false, "Date exacte no match");
  assert(matchesPriorityDate("2026-09-15", []) === false, "Patterns vides → false");
}

section("10. Fingerprint — sticky par session, cycling par jour");
{
  clearFingerprint("fp-test@test.com");
  const fp1 = getFingerprintForToday("fp-test@test.com");
  const fp2 = getFingerprintForToday("fp-test@test.com");
  assert(fp1.ua === fp2.ua, "Même UA dans la même session (sticky)");
  assert(fp1.secChUa.length > 0, "Sec-CH-UA non vide");
  assert(fp1.acceptLanguage.includes("fr"), "Accept-Language contient 'fr'");

  // Headers complets
  const headers = buildHeadersFromFingerprint(fp1, "https://www.usvisaappt.com/");
  assert(headers["User-Agent"] === fp1.ua, "Header UA = fingerprint UA");
  assert(headers["Sec-CH-UA"] === fp1.secChUa, "Header Sec-CH-UA = fingerprint");
  assert(headers["Sec-Fetch-Mode"] === "cors", "Sec-Fetch-Mode = cors");
}

section("11. Stealth Alternation — ratio ~2/3 main + 1/3 landing");
{
  resetAlternation("alt-test@test.com");
  let mainCount = 0;
  let landingCount = 0;
  for (let i = 0; i < 30; i++) {
    const endpoint = pickNextEndpoint("alt-test@test.com");
    if (endpoint === "firstAvailableMonth") mainCount++;
    else landingCount++;
  }
  const ratio = landingCount / 30;
  assert(ratio >= 0.2 && ratio <= 0.5, `Ratio landing ${(ratio * 100).toFixed(0)}% dans [20-50%] (got ${landingCount}/30)`);
  assert(mainCount > landingCount, `Plus de main (${mainCount}) que landing (${landingCount})`);
}

section("12. Prediction Engine — competition tracking");
resetPrediction();
{
  // Simuler un slot qui apparaît et disparaît en 20s
  recordSlotDetected("comp-test@test.com", "Kinshasa", "2026-09-15");
  // Simuler le passage de 20s
  const state = (globalThis as any); // Pas propre mais pour le test
  await new Promise(r => setTimeout(r, 50)); // Petit délai
  recordSlotGone("comp-test@test.com", "Kinshasa", "2026-09-15");

  const pattern = getSlotPattern("comp-test@test.com");
  // La durée de vie sera très courte (quelques ms dans le test)
  assert(pattern.totalObservations === 1, "1 observation");
  // Le lifespan sera ~50ms (pas réaliste mais le mécanisme fonctionne)
  assert(pattern.medianLifespanSec >= 0, `Lifespan mesuré (${pattern.medianLifespanSec}s)`);
}

section("13. Prediction Engine — blind booking tracking");
resetPrediction();
{
  recordBlindBookingResult("blind-test@test.com", true);
  recordBlindBookingResult("blind-test@test.com", false);
  recordBlindBookingResult("blind-test@test.com", true);

  const pattern = getSlotPattern("blind-test@test.com");
  assert(Math.abs(pattern.blindBookingSuccessRate - 0.666) < 0.01, `Blind success rate ~66% (got ${(pattern.blindBookingSuccessRate * 100).toFixed(0)}%)`);
}

section("14. Budget + Proxy Death — diagnostic sans consommer de login");
resetSessionPool();
updateConfig({ minInterLoginMs: 0 });
{
  recordProxyDeath("proxy-int@test.com");
  recordProxyDeath("proxy-int@test.com");
  recordProxyDeath("proxy-int@test.com");

  const snap = getBudgetSnapshot("proxy-int@test.com");
  assert(snap.totalUsed === 0, "0 logins consommés malgré 3 proxy deaths");
  assert(snap.proxyDeaths === 3, "3 proxy deaths trackés");
  assert(snap.remaining === 9, "Budget intact");
}

section("15. validateConfigV3 — détection erreurs");
{
  const warnings1 = validateConfigV3({ maxLoginsPerDay: 15 });
  assert(warnings1.length > 0, "maxLoginsPerDay=15 → warning");

  const warnings2 = validateConfigV3({ accountRole: "invalid" as any });
  assert(warnings2.length > 0, "accountRole invalide → warning");

  const warnings3 = validateConfigV3({ maxMonthsToScan: 0 });
  assert(warnings3.length > 0, "maxMonthsToScan=0 → warning");

  const warnings4 = validateConfigV3({ embassyUsername: "test", isActive: true });
  assert(warnings4.length === 0, "Config valide → 0 warnings");
}

// ─── Résultat final ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
console.log(` INTÉGRATION V3: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(60)}`);

if (failed > 0) {
  process.exit(1);
}
