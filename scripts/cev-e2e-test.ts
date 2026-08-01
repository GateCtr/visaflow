/**
 * cev-e2e-test.ts — Test E2E AUTOMATISÉ du hunter CEV (sans ouverture manuelle navigateur)
 *
 * Flux:
 * 1) Login VisaOnWeb + "Prendre rendez-vous" via setupCevSessionHttp
 * 2) Résolution captcha via Anti-Captcha (dans le setup hunter)
 * 3) Détection créneaux via pollCevSlot + snapshot de capacité
 * 4) Tentative réservation (créneau ciblé si free>2, sinon booking standard)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setupCevSessionHttp } from "../artifacts/slot-hunter/src/cevHttpSetup.ts";
import { pollCevSlot, getCevCapacitySnapshot } from "../artifacts/slot-hunter/src/cevPolling.ts";
import { bookCevViaHttp, bookCevSelectedSlotViaHttp } from "../artifacts/slot-hunter/src/cevHttpBooking.ts";

type Capacity = Array<{ date: string; times: Array<{ time: string; free: number | null }> }>;

function nowIso(): string {
  return new Date().toISOString();
}

async function saveJSON(filePath: string, data: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function pickBestSlot(parsed?: Capacity): { date: string; time: string; free: number } | null {
  if (!parsed?.length) return null;
  const candidates: Array<{ date: string; time: string; free: number }> = [];
  for (const d of parsed) {
    for (const t of d.times) {
      const free = typeof t.free === "number" && Number.isFinite(t.free) ? t.free : 0;
      if (free > 2) candidates.push({ date: d.date, time: t.time, free });
    }
  }
  candidates.sort((a, b) => b.free - a.free);
  return candidates[0] ?? null;
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

  pushStep("setup_start", {});
  const setup = await setupCevSessionHttp(email, password, appId, appId, vowintRef);
  pushStep("setup_done", {
    success: setup.success,
    error: setup.success ? undefined : setup.error,
    slotsAvailable: setup.success ? setup.slotsAvailable : undefined,
    hasSessionCookie: !!setup.sessionCookie,
    hasIntegrationUrl: !!setup.integrationUrl,
  });

  if (!setup.success || !setup.sessionCookie || !setup.integrationUrl) {
    report.result = "setup_failed";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    console.log(`[CEV-E2E-AUTO] ❌ Setup échoué. Rapport: ${path.join(outDir, "report.json")}`);
    return;
  }

  let slotDetected = !!setup.slotsAvailable;
  if (!slotDetected) {
    pushStep("poll_start", {});
    const poll = await pollCevSlot(setup.integrationUrl, setup.sessionCookie);
    pushStep("poll_done", poll as unknown as Record<string, unknown>);
    slotDetected = poll.status === "slot_found";
  }

  if (!slotDetected) {
    report.result = "no_slot_detected";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    console.log(`[CEV-E2E-AUTO] ℹ️ Aucun créneau détecté. Rapport: ${path.join(outDir, "report.json")}`);
    return;
  }

  pushStep("capacity_start", {});
  const capacity = await getCevCapacitySnapshot(setup.sessionCookie);
  pushStep("capacity_done", capacity as unknown as Record<string, unknown>);

  const parsed = (capacity as { parsed?: Capacity }).parsed;
  const target = pickBestSlot(parsed);

  pushStep("booking_start", {
    strategy: target ? "selected_slot" : "standard",
    target,
  });

  const booking = target
    ? await bookCevSelectedSlotViaHttp(
        setup.integrationUrl,
        setup.sessionCookie,
        appId,
        { date: target.date, time: target.time },
      )
    : await bookCevViaHttp(setup.integrationUrl, setup.sessionCookie, appId);

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
