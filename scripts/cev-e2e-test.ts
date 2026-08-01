/**
 * cev-e2e-test.ts — Test E2E AUTOMATISÉ du hunter CEV (sans ouverture manuelle navigateur)
 *
 * Flux:
 * 1) Login VisaOnWeb + "Prendre rendez-vous" via setupCevSessionHttp
 * 2) Résolution captcha via Anti-Captcha (dans le setup hunter)
 * 3) bookCevViaHttp — utilise le HTML préchargé du setup (availability[]):
 *    - Groupe les entrées par (date, time) → free = nombre de places disponibles
 *    - Préfère les créneaux avec ≥3 places (moins de contention)
 *    - Trie par free décroissant, soumet le meilleur créneau
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setupCevSessionHttp } from "../artifacts/slot-hunter/src/cevHttpSetup.ts";
import { pollCevSlot } from "../artifacts/slot-hunter/src/cevPolling.ts";
import { bookCevViaHttp } from "../artifacts/slot-hunter/src/cevHttpBooking.ts";

function nowIso(): string {
  return new Date().toISOString();
}

async function saveJSON(filePath: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

async function main(): Promise<void> {
  const startedAt = nowIso();
  const stamp = Date.now();
  const outDir = path.join(process.cwd(), "captured", "cev", `e2e-auto-${stamp}`);

  const email = process.env.CEV_EMAIL?.trim();
  const password = process.env.CEV_PASSWORD?.trim();
  const vowintRef = process.env.CEV_VOWINT_REF?.trim() || "VOWINT6321793";

  if (!email || !password) {
    throw new Error("Variables requises: CEV_EMAIL et CEV_PASSWORD");
  }

  const appId = process.env.CEV_APPLICATION_ID?.trim() || `cev-e2e-${stamp}`;
  const report: Record<string, unknown> = {
    startedAt,
    input: { email, vowintRef, appId },
    steps: [] as unknown[],
  };
  const pushStep = (step: string, data: Record<string, unknown>) => {
    (report.steps as Array<unknown>).push({ t: nowIso(), step, ...data });
  };

  // ─── Étape 1 : Setup (login + captcha + navigation vers SelectSlot) ───────
  pushStep("setup_start", {});
  const setup = await setupCevSessionHttp(email, password, appId, appId, vowintRef);
  pushStep("setup_done", {
    success: setup.success,
    error: setup.success ? undefined : setup.error,
    slotsAvailable: setup.success ? setup.slotsAvailable : undefined,
    hasSessionCookie: !!setup.sessionCookie,
    hasIntegrationUrl: !!setup.integrationUrl,
    hasSelectSlotHtml: !!(setup as unknown as Record<string, unknown>).selectSlotHtml,
    hasSelectSlotCookies: !!(setup as unknown as Record<string, unknown>).selectSlotCookies,
  });

  if (!setup.success || !setup.sessionCookie || !setup.integrationUrl) {
    report.result = "setup_failed";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    console.log(`[CEV-E2E-AUTO] ❌ Setup échoué. Rapport: ${path.join(outDir, "report.json")}`);
    return;
  }

  // ─── Étape 2 : Vérification slot (seulement si setup n'a pas déjà confirmé) ─
  let slotDetected = !!setup.slotsAvailable;
  if (!slotDetected) {
    pushStep("poll_start", {});
    const poll = await pollCevSlot(setup.integrationUrl, setup.sessionCookie);
    pushStep("poll_done", poll as unknown as Record<string, unknown>);
    slotDetected = poll.status === "slot_found";
  } else {
    pushStep("poll_skipped", { reason: "slotsAvailable=true depuis le setup" });
  }

  if (!slotDetected) {
    report.result = "no_slot_detected";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    console.log(`[CEV-E2E-AUTO] ℹ️ Aucun créneau détecté. Rapport: ${path.join(outDir, "report.json")}`);
    return;
  }

  // ─── Étape 3 : Réservation ────────────────────────────────────────────────
  // bookCevViaHttp utilise le HTML préchargé (availability[]) pour :
  //   - Compter les places libres par créneau (une entrée = une place)
  //   - Préférer les créneaux avec ≥3 places (min. contention)
  //   - Trier par free décroissant, soumettre le meilleur
  const setupAny = setup as unknown as Record<string, string | undefined>;
  pushStep("booking_start", {
    strategy: "bookCevViaHttp_with_preloaded_html",
    hasPreloadedHtml: !!setupAny.selectSlotHtml,
    hasSelectSlotCookies: !!setupAny.selectSlotCookies,
  });

  const booking = await bookCevViaHttp(
    setup.integrationUrl,
    setup.sessionCookie,
    appId,
    undefined,                   // siphoned
    undefined,                   // sessionUa
    setupAny.selectSlotHtml,     // HTML préchargé → fast-path, évite 2ème requête
    setupAny.selectSlotUrl,      // URL finale SelectSlot
    setupAny.selectSlotCookies,  // cookies complets incluant __RequestVerificationToken
  );

  pushStep("booking_done", booking as unknown as Record<string, unknown>);

  report.result = booking.success ? "booked" : "booking_failed";
  report.endedAt = nowIso();

  await saveJSON(path.join(outDir, "report.json"), report);
  console.log(`[CEV-E2E-AUTO] ✅ Terminé. Résultat=${report.result} Rapport: ${path.join(outDir, "report.json")}`);
}

main().catch(async (err) => {
  const stamp = Date.now();
  const outDir = path.join(process.cwd(), "captured", "cev", `e2e-auto-${stamp}`);
  const report = {
    startedAt: nowIso(),
    endedAt: nowIso(),
    result: "crash",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  try {
    await saveJSON(path.join(outDir, "report.json"), report);
  } catch {
    // noop
  }
  console.error("[CEV-E2E-AUTO] Erreur:", err);
  process.exitCode = 1;
});
