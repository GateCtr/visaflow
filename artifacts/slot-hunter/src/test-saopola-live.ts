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
  "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";

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

  // ── Phase 1 : Scan ───────────────────────────────────────────────────────

  sep("PHASE 1 — Scan (détection créneaux)");
  const t0Scan = Date.now();
  const scanResult = await scanSpainHttp(PORTAL_URL);
  const scanDuration = Date.now() - t0Scan;

  console.log(`\n  ⏱  Durée : ${elapsed(scanDuration)}`);
  console.log(`  📊 Status : ${scanResult.status}`);
  if (scanResult.slotInfo) console.log(`  🕐 Créneau : ${scanResult.slotInfo}`);
  if (scanResult.errorMessage)
    console.log(`  ⚠️  Erreur : ${scanResult.errorMessage}`);
  if (scanResult._services?.length) {
    console.log(`  🗂  Services (${scanResult._services.length}) :`);
    for (const s of scanResult._services) {
      console.log(`       - [${s.serviceId}] ${s.serviceName}`);
    }
  }

  if (scanResult.status !== "found") {
    console.log(
      `\n  ⛔ Pas de créneaux détectés (status=${scanResult.status}) — fin du test.`,
    );
    process.exit(0);
  }

  // ── Phase 2 : Booking avec faux identifiants ─────────────────────────────

  sep("PHASE 2 — Booking (faux identifiants)");
  console.log("  Objectif : parcourir le flow complet jusqu'au rejet serveur");
  console.log("  Login    : test.saopola.fake@gmail.com");
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

  const t0Book = Date.now();
  const bookResult = await executeHttpBooking(session, PORTAL_URL, mainHtml, {
    login: "test.saopola.fake@gmail.com",
    password: "FakePassword_Incorrect_2026",
    applicantName: "TEST SAOPOLA",
    applicantEmail: "test.saopola.fake@gmail.com",
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
