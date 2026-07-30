/**
 * test-saopola-live.ts — Test live du watcher Spain contre le portail Saopola
 *
 * Portail : retrait de passeports (Saopola → citaconsular.es)
 * URL     : https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/
 *
 * Phase 1 : Scan — détection de créneaux via /main/ + datetime/
 * Phase 2 : Booking avec faux identifiants → attendu signin_failed ou booking_failed
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/test-saopola-live.ts
 */

process.env.CHROMIUM_EXECUTABLE_PATH =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  "/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { ensureSpainCfSession } from "./spain-soax-solver.js";
import { scanSpainHttp } from "./spain-http-scanner.js";
import { executeHttpBooking } from "./spain-http-booking.js";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sep(label: string) {
  console.log("\n" + "═".repeat(70));
  console.log(`  ${label}`);
  console.log("═".repeat(70));
}

function elapsed(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  sep("TEST LIVE — Saopola retrait passeport");
  console.log(`  Portail : ${PORTAL_URL}`);
  console.log(`  Redis   : ${process.env.REDIS_URL}`);
  console.log(`  Mode    : ${process.env.SPAIN_SESSION_MODE}`);
  console.log(
    `  Chromium: ${process.env.CHROMIUM_EXECUTABLE_PATH?.slice(0, 80)}`,
  );
  console.log(
    `  Proxy   : ${process.env.DECODO_PROXY_URL ? "configuré ✅" : "⚠️  DECODO_PROXY_URL absent"}`,
  );
  console.log(
    `  CapSolver: ${process.env.CAPSOLVER_API_KEY ? "configuré ✅" : "⚠️  CAPSOLVER_API_KEY absent"}`,
  );

  // ── Phase 1 : Scan (boucle comme la prod — max 5 cycles de 15s) ────────────
  //
  // En prod, la session se construit progressivement :
  //   Cycle 1 → browser lancé, CF résolu, PHPSESSID obtenu, /main/ peut être 0B
  //   Cycle 2+ → ♻️ Session CF réutilisée → page.evaluate() sur same-origin → /main/ OK
  // Notre test simule ce comportement en boucle au lieu de sortir sur le premier échec.

  sep("PHASE 1 — Scan (boucle prod-like, max 5 cycles × 15s)");
  const MAX_CYCLES = 5;
  const CYCLE_DELAY_MS = 15_000;

  let scanResult = null as Awaited<ReturnType<typeof scanSpainHttp>> | null;
  let scanDuration = 0;
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    console.log(`\n  ── Cycle ${cycle}/${MAX_CYCLES} ──`);
    const t0Scan = Date.now();
    scanResult = await scanSpainHttp(PORTAL_URL);
    scanDuration = Date.now() - t0Scan;

    console.log(`  ⏱  Durée : ${elapsed(scanDuration)}`);
    console.log(`  📊 Status : ${scanResult.status}`);
    if (scanResult.slotInfo) console.log(`  🕐 Créneau : ${scanResult.slotInfo}`);
    if (scanResult.errorMessage) console.log(`  ⚠️  Erreur : ${scanResult.errorMessage}`);
    if (scanResult._services?.length) {
      console.log(`  🗂  Services (${scanResult._services.length}) :`);
      for (const s of scanResult._services) {
        console.log(`       - [${s.serviceId}] ${s.serviceName}`);
      }
    }

    if (scanResult.status === "found" || scanResult.status === "not_found") {
      console.log(`\n  ✅ Scan stable (status=${scanResult.status}) — session chaude confirmée.`);
      // ── Créneaux disponibles (avec nombre de places) ──────────────────────
      if (scanResult._allSlots?.length) {
        console.log(`\n  📅 Tous les créneaux (${scanResult._allSlots.length}) :`);
        for (const s of scanResult._allSlots) {
          const places = s.freeslots < 0 ? "?" : String(s.freeslots);
          console.log(`       ${s.date} ${s.time}  [${places} place(s)]${s.agendaId ? `  agenda=${s.agendaId}` : ""}`);
        }
      }
      // ── Config widget (captcha, registration_type, confirmation…) ─────────
      if (scanResult._widgetConfig) {
        const wc = scanResult._widgetConfig;
        console.log(`\n  🔧 widgetConfig :`);
        console.log(`       captcha           : ${wc.captcha ?? "n/a"}  ${wc.captcha === "0" || wc.captcha === 0 ? "✅ pas de captcha" : wc.captcha === "1" || wc.captcha === 1 ? "⚠️  hCaptcha requis" : ""}`);
        console.log(`       registration_type : ${wc.registration_type ?? "n/a"}  ${wc.registration_type === "1" ? "(login seul)" : wc.registration_type === "2" ? "(inscription uniquement)" : wc.registration_type === "3" ? "(login + inscription)" : ""}`);
        console.log(`       waiting_list      : ${wc.waiting_list ?? "n/a"}`);
        console.log(`       confirmation      : ${wc.confirmation ?? "n/a"}  ${wc.confirmation === "1" ? "⚠️  OTP email requis" : ""}`);
      }
      break;
    }

    if (cycle < MAX_CYCLES) {
      console.log(`  🔄 Résultat transitoire (${scanResult.status}) — attente ${CYCLE_DELAY_MS / 1000}s avant retry (simulation prod)…`);
      await new Promise((r) => setTimeout(r, CYCLE_DELAY_MS));
    }
  }

  if (!scanResult || (scanResult.status !== "found" && scanResult.status !== "not_found")) {
    console.log(`\n  ⛔ Session CF instable après ${MAX_CYCLES} cycles — fin du test.`);
    process.exit(1);
  }

  if (scanResult.status === "not_found") {
    console.log(`\n  ℹ️  Aucun créneau disponible en ce moment (portal répond correctement).`);
    console.log("  Le watcher fonctionne. Réessaie quand des créneaux sont visibles.");
    process.exit(0);
  }

  // ── Phase 2 : Booking avec faux identifiants ─────────────────────────────

  sep("PHASE 2 — Booking (faux identifiants)");
  console.log("  Objectif : parcourir le flow complet jusqu'au rejet serveur");
  console.log("  Login    : MAT00000000 (faux matricule — Saopola = numéro matricule)");
  console.log("  Password : FakePassword_Incorrect_2026");

  // La session CF est déjà cachée en mémoire depuis le scan
  const session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) {
    console.error("  ❌ Session CF non disponible pour le booking — abandon.");
    process.exit(1);
  }

  const mainHtml = scanResult._mainHtml ?? "";
  if (!mainHtml) {
    console.error(
      "  ❌ _mainHtml absent du résultat scan — booking impossible sans HTML.",
    );
    process.exit(1);
  }

  console.log(`  HTML /main/ disponible (${mainHtml.length} chars)`);

  // Pour les portails client-side render (Backbone.js), les services ne sont pas dans
  // le HTML /main/. On passe les services déjà découverts par le scan via getservices/.
  const availableServices = scanResult._services?.length ? scanResult._services : undefined;
  if (availableServices) {
    console.log(`  Services injectés depuis scan (${availableServices.length}) :`);
    for (const s of availableServices) {
      console.log(`       - [${s.serviceId}] ${s.serviceName}`);
    }
  }

  // Passer le créneau pré-confirmé par le scan pour sauter le re-fetch datetime/
  // (le portail bloque impit — seul le browser peut appeler ces endpoints)
  const targetDate = scanResult.slot?.date;
  const targetTime = scanResult.slot?.time;
  if (targetDate && targetTime) {
    console.log(`  Créneau pré-confirmé : ${targetDate} à ${targetTime}`);
  }

  // Saopola (retrait passeport São Paulo) : logintype=document → matricule numérique.
  // Le login n'est PAS un email mais un numéro de matricule (ex: passeport DRC 00000000).
  // Credentials faux → attendu signin_failed ou booking_failed (rejet serveur).
  const t0Book = Date.now();
  const bookResult = await executeHttpBooking(session, PORTAL_URL, mainHtml, {
    login: "00000001",
    password: "FakePassword_2026",
    applicantName: "TEST SAOPOLA FAKE",
    applicantEmail: "test.saopola.fake@gmail.com",
    availableServices,
    targetDate,
    targetTime,
  });
  const bookDuration = Date.now() - t0Book;

  console.log(`\n  ⏱  Durée booking : ${elapsed(bookDuration)}`);
  console.log(`  📊 Status booking : ${bookResult.status}`);
  if (bookResult.locator)
    console.log(`  🎫 Locator       : ${bookResult.locator}`);
  if (bookResult.errorMessage)
    console.log(`  ℹ️  Message       : ${bookResult.errorMessage}`);

  sep("RÉSUMÉ");
  const scanIcon = scanResult.status === "found" ? "✅" : "❌";
  console.log(`  ${scanIcon} Scan   : ${scanResult.status} — ${elapsed(scanDuration)}`);
  const bookIcon =
    bookResult.status === "signin_failed" ||
    bookResult.status === "booking_failed"
      ? "✅ (rejet attendu)"
      : bookResult.status === "booked"
        ? "⚠️  RÉSERVÉ POUR DE VRAI — à annuler !"
        : "ℹ️ ";
  console.log(
    `  ${bookIcon} Booking: ${bookResult.status} — ${elapsed(bookDuration)}`,
  );
  console.log();
}

main().catch((err) => {
  console.error("\n💥 Erreur non gérée :", err);
  process.exit(1);
});
