/**
 * Pillar 4 — Reporting Admin Automatisé via Resend
 *
 * À la fin de chaque Daily Bundle Check, envoie un rapport email à l'admin via Resend.
 * Le rapport confirme :
 *  - Si l'extraction AES a réussi
 *  - Quelle est la clé actuelle
 *  - L'état de santé global des scanners (jobs actifs, en pause, en erreur)
 *
 * L'email admin est récupéré via Convex (admin actuel du système).
 */

import { botLog } from "./convexClient.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "bot@joventy.cd";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";

export interface BundleCheckReport {
  /** Nom du bundle Angular actuel (ex: main.dc91e3f7b5f67caa.js) */
  bundleName: string;
  /** true si la clé AES est toujours présente et valide */
  aesKeyValid: boolean;
  /** true si la clé a été auto-extraite (changement détecté et corrigé) */
  aesKeyAutoExtracted: boolean;
  /** Clé AES actuelle (base64) */
  currentAesKey: string;
  /** Ancienne clé (si changée) */
  previousAesKey?: string;
  /** Nombre total de jobs actifs */
  activeJobsCount: number;
  /** Nombre de jobs en pause (login failures, restrictions) */
  pausedJobsCount: number;
  /** Nombre de jobs terminés (slot_found) */
  completedJobsCount: number;
  /** Nombre de jobs avec erreurs récentes */
  errorJobsCount: number;
  /** Détails par job actif */
  jobDetails: Array<{
    applicantName: string;
    urgencyTier: string;
    lastResult: string;
    lastCheckAt: number | null;
  }>;
  /** Timestamp du check */
  checkedAt: number;
  /** État du proxy pool */
  proxyPoolStatus: string;
  /** IP de sortie actuelle */
  serverIp: string | null;
}

/**
 * Récupère l'email de l'admin actuel via Convex.
 * Le backend Convex expose un endpoint /hunter/admin-email qui retourne l'email
 * de l'admin principal (premier admin actif dans la table users).
 */
async function getAdminEmail(): Promise<string | null> {
  if (!CONVEX_SITE_URL || !HUNTER_API_KEY) return null;

  try {
    const url = `${CONVEX_SITE_URL}/hunter/admin-email`;
    const res = await fetch(url, {
      method: "GET",
      headers: { "X-Hunter-Key": HUNTER_API_KEY },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[admin-report] Impossible de récupérer l'email admin: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch (err) {
    console.warn(`[admin-report] Erreur récupération email admin: ${err}`);
    return null;
  }
}

/**
 * Envoie le rapport admin via l'API Resend.
 *
 * @param report — Données du rapport à envoyer
 * @returns true si l'envoi a réussi
 */
export async function sendAdminBundleCheckReport(report: BundleCheckReport): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log("[admin-report] RESEND_API_KEY non configuré — rapport email ignoré");
    return false;
  }

  // Récupérer l'email admin depuis Convex
  const adminEmail = await getAdminEmail();
  if (!adminEmail) {
    console.warn("[admin-report] Email admin introuvable — rapport non envoyé");
    return false;
  }

  const subject = report.aesKeyValid
    ? `✅ [Joventy Hunter] Daily Report — Bundle OK (${new Date(report.checkedAt).toISOString().slice(0, 10)})`
    : `🚨 [Joventy Hunter] ALERTE — Clé AES changée! (${new Date(report.checkedAt).toISOString().slice(0, 10)})`;

  const htmlBody = buildReportHtml(report);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [adminEmail],
        subject,
        html: htmlBody,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[admin-report] Resend API erreur HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return false;
    }

    const result = (await res.json()) as { id?: string };
    console.log(`[admin-report] ✅ Rapport envoyé à ${adminEmail} (id: ${result.id ?? "?"})`);

    botLog({
      applicationId: "system",
      step: "admin_report_sent",
      status: "ok",
      data: {
        to: adminEmail,
        subject,
        resendId: result.id,
        aesKeyValid: report.aesKeyValid,
        activeJobs: report.activeJobsCount,
      },
    });

    return true;
  } catch (err) {
    console.warn(`[admin-report] Erreur envoi Resend: ${err}`);
    return false;
  }
}

/**
 * Construit le HTML du rapport email.
 */
function buildReportHtml(report: BundleCheckReport): string {
  const statusEmoji = report.aesKeyValid ? "✅" : "🚨";
  const aesStatus = report.aesKeyValid
    ? (report.aesKeyAutoExtracted ? "Auto-extracted (NEW KEY)" : "Valid — No Change")
    : "INVALID — Manual Action Required";

  const jobRows = report.jobDetails
    .map(
      (j) =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${j.applicantName}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${j.urgencyTier}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${j.lastResult || "—"}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${j.lastCheckAt ? new Date(j.lastCheckAt).toLocaleTimeString("fr-CD") : "—"}</td>
        </tr>`,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:700px;margin:0 auto;padding:20px;color:#1a1a2e">
  <h1 style="color:#16213e;border-bottom:3px solid #0f3460;padding-bottom:10px">
    ${statusEmoji} Joventy Hunter — Daily Bundle Report
  </h1>

  <div style="background:#f8f9fa;border-radius:8px;padding:16px;margin:16px 0">
    <h2 style="margin-top:0;color:#0f3460">🔐 AES Encryption Status</h2>
    <table style="width:100%">
      <tr><td><strong>Bundle:</strong></td><td><code>${report.bundleName}</code></td></tr>
      <tr><td><strong>Status:</strong></td><td><strong style="color:${report.aesKeyValid ? "#28a745" : "#dc3545"}">${aesStatus}</strong></td></tr>
      <tr><td><strong>Current Key:</strong></td><td><code style="font-size:11px">${report.currentAesKey.slice(0, 20)}…</code></td></tr>
      ${report.previousAesKey ? `<tr><td><strong>Previous Key:</strong></td><td><code style="font-size:11px;color:#888">${report.previousAesKey.slice(0, 20)}…</code></td></tr>` : ""}
    </table>
  </div>

  <div style="background:#f0f7ff;border-radius:8px;padding:16px;margin:16px 0">
    <h2 style="margin-top:0;color:#0f3460">📊 Scanner Health</h2>
    <table style="width:100%">
      <tr><td><strong>Active Jobs:</strong></td><td>${report.activeJobsCount}</td></tr>
      <tr><td><strong>Paused:</strong></td><td style="color:${report.pausedJobsCount > 0 ? "#e67e22" : "#28a745"}">${report.pausedJobsCount}</td></tr>
      <tr><td><strong>Completed:</strong></td><td style="color:#28a745">${report.completedJobsCount}</td></tr>
      <tr><td><strong>Errors:</strong></td><td style="color:${report.errorJobsCount > 0 ? "#dc3545" : "#28a745"}">${report.errorJobsCount}</td></tr>
      <tr><td><strong>Proxy Pool:</strong></td><td>${report.proxyPoolStatus}</td></tr>
      <tr><td><strong>Server IP:</strong></td><td><code>${report.serverIp ?? "Unknown"}</code></td></tr>
    </table>
  </div>

  ${
    report.jobDetails.length > 0
      ? `
  <div style="margin:16px 0">
    <h2 style="color:#0f3460">📋 Job Details</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead>
        <tr style="background:#e9ecef">
          <th style="padding:8px 12px;text-align:left">Applicant</th>
          <th style="padding:8px 12px;text-align:left">Tier</th>
          <th style="padding:8px 12px;text-align:left">Last Result</th>
          <th style="padding:8px 12px;text-align:left">Last Check</th>
        </tr>
      </thead>
      <tbody>${jobRows}</tbody>
    </table>
  </div>`
      : ""
  }

  <div style="margin-top:24px;padding-top:12px;border-top:1px solid #dee2e6;font-size:12px;color:#6c757d">
    Report generated at ${new Date(report.checkedAt).toISOString()} — Joventy Hunter v2
  </div>
</body>
</html>`;
}
