/**
 * cev-cancel-test.ts — Test E2E de l'annulation CEV via HTTP
 *
 * Flux :
 *  1. setupCevSessionHttp → doit retourner isLimitReached=true (dossier déjà booké)
 *  2. cancelCevAppointment(overviewHtml, overviewCookies, overviewUrl)
 *  3. Vérifier que le RDV est bien annulé
 *
 * PRÉ-REQUIS : Le dossier VOWINT6321793 doit avoir un RDV confirmé
 * (après le run de cev-e2e-test.ts qui a booké le 2026-12-22 14:20).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { setupCevSessionHttp } from "../artifacts/slot-hunter/src/cevHttpSetup.ts";
import { cancelCevAppointment } from "../artifacts/slot-hunter/src/cevHttpCancel.ts";

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
  const outDir = path.join(process.cwd(), "captured", "cev", `cancel-test-${stamp}`);

  const email = process.env.CEV_EMAIL?.trim();
  const password = process.env.CEV_PASSWORD?.trim();
  const vowintRef = process.env.CEV_VOWINT_REF?.trim() || "VOWINT6321793";

  if (!email || !password) {
    throw new Error("Variables requises: CEV_EMAIL et CEV_PASSWORD");
  }

  const appId = `cev-cancel-${stamp}`;
  const report: Record<string, unknown> = {
    startedAt,
    input: { email, vowintRef, appId },
    steps: [] as unknown[],
  };
  const pushStep = (step: string, data: Record<string, unknown>) => {
    (report.steps as Array<unknown>).push({ t: nowIso(), step, ...data });
    console.log(`[CEV-CANCEL-TEST] [${step}]`, JSON.stringify(data).slice(0, 200));
  };

  // ─── Étape 1 : Setup ─────────────────────────────────────────────────────
  pushStep("setup_start", {});
  console.log(`[CEV-CANCEL-TEST] 🔄 Login + captcha pour ${email} / ${vowintRef}...`);
  const setup = await setupCevSessionHttp(email, password, appId, appId, vowintRef);

  const setupAny = setup as unknown as Record<string, unknown>;
  pushStep("setup_done", {
    success: setup.success,
    error: setup.success ? undefined : setup.error,
    slotsAvailable: setup.slotsAvailable,
    isLimitReached: setupAny.isLimitReached ?? false,
    hasOverviewHtml: !!(setupAny.overviewHtml),
    hasOverviewCookies: !!(setupAny.overviewCookies),
    overviewUrl: setupAny.overviewUrl ?? null,
    overviewHtmlPreview: typeof setupAny.overviewHtml === "string"
      ? (setupAny.overviewHtml as string)
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400)
      : null,
  });

  if (!setup.success) {
    report.result = "setup_failed";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    // Sauvegarder aussi le HTML brut si disponible pour debug
    if (setupAny.overviewHtml) {
      await fs.promises.writeFile(path.join(outDir, "overview.html"), setupAny.overviewHtml as string, "utf8");
    }
    console.log(`[CEV-CANCEL-TEST] ❌ Setup échoué. Rapport: ${path.join(outDir, "report.json")}`);
    return;
  }

  // ── Sauvegarder le HTML Overview pour analyse ──
  if (setupAny.overviewHtml) {
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(path.join(outDir, "overview.html"), setupAny.overviewHtml as string, "utf8");
    console.log(`[CEV-CANCEL-TEST] 💾 HTML Overview sauvegardé → ${path.join(outDir, "overview.html")}`);
  }

  if (!setupAny.isLimitReached) {
    console.log(`[CEV-CANCEL-TEST] ⚠️  Le dossier n'a PAS de RDV confirmé (isLimitReached=false).`);
    console.log(`[CEV-CANCEL-TEST]    slotsAvailable=${setup.slotsAvailable}`);
    console.log(`[CEV-CANCEL-TEST]    Exécuter d'abord cev-e2e-test.ts pour booker un créneau.`);
    report.result = "no_appointment_to_cancel";
    report.endedAt = nowIso();
    await saveJSON(path.join(outDir, "report.json"), report);
    return;
  }

  console.log(`[CEV-CANCEL-TEST] ✅ Dossier avec RDV confirmé détecté — tentative d'annulation...`);

  // ─── Étape 2 : Annulation ────────────────────────────────────────────────
  pushStep("cancel_start", {
    overviewUrl: setupAny.overviewUrl ?? null,
  });

  const cancelResult = await cancelCevAppointment(
    setupAny.overviewHtml as string,
    setupAny.overviewCookies as string,
    vowintRef,
    appId,
  );

  pushStep("cancel_done", {
    emailSent: cancelResult.emailSent,
    message: cancelResult.message,
    appointment: cancelResult.appointment,
    allAppointments: cancelResult.allAppointments.map(a => ({ label: a.label, additionalData: a.additionalData })),
    error: cancelResult.error,
  });

  report.result = cancelResult.emailSent ? "cancel_email_sent" : "cancel_failed";
  report.endedAt = nowIso();

  await saveJSON(path.join(outDir, "report.json"), report);

  if (cancelResult.emailSent) {
    console.log(`[CEV-CANCEL-TEST] ✅ Email d'annulation envoyé!`);
    console.log(`[CEV-CANCEL-TEST]    Message CEV: ${cancelResult.message}`);
    console.log(`[CEV-CANCEL-TEST]    RDV: ${cancelResult.appointment?.label} — ${cancelResult.appointment?.additionalData}`);
    console.log(`[CEV-CANCEL-TEST]    ⚠️  L'utilisateur doit cliquer le lien dans son email pour confirmer.`);
  } else {
    console.log(`[CEV-CANCEL-TEST] ❌ Demande d'annulation échouée: ${cancelResult.error}`);
    console.log(`[CEV-CANCEL-TEST]    Appointments trouvés: ${cancelResult.allAppointments.length}`);
  }
  console.log(`[CEV-CANCEL-TEST] 📄 Rapport: ${path.join(outDir, "report.json")}`);
}

main().catch(async (err) => {
  const stamp = Date.now();
  const outDir = path.join(process.cwd(), "captured", "cev", `cancel-test-${stamp}`);
  const report = {
    startedAt: nowIso(),
    endedAt: nowIso(),
    result: "crash",
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
    await fs.promises.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  } catch { /* noop */ }
  console.error("[CEV-CANCEL-TEST] Erreur:", err);
  process.exitCode = 1;
});
