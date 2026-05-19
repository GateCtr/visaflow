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
const RESEND_FROM_EMAIL = "Hunter Bot <bot@joventy.cd>";
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL ?? "";
const HUNTER_API_KEY = process.env.HUNTER_API_KEY ?? "";
const LOGO_URL = "https://joventy.cd/icon.png";
const APP_URL = "https://joventy.cd";

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
 * Récupère l'email de l'admin depuis la variable d'environnement.
 * Pattern identique à convex/emails.ts (JOVENTY_ADMIN_EMAIL).
 * Pas besoin d'appel HTTP — l'email admin est configuré en env Railway.
 */
function getAdminEmail(): string | null {
  const email = process.env.JOVENTY_ADMIN_EMAIL;
  if (!email) {
    console.warn(`[admin-report] JOVENTY_ADMIN_EMAIL non configurée — rapport non envoyé`);
    console.warn(`[admin-report] → Ajoutez JOVENTY_ADMIN_EMAIL dans les variables d'environnement Railway`);
    return null;
  }
  return email;
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

  // Récupérer l'email admin depuis la variable d'environnement
  const adminEmail = getAdminEmail();
  if (!adminEmail) {
    console.warn("[admin-report] Email admin introuvable — rapport non envoyé");
    return false;
  }

  const subject = report.aesKeyValid
    ? `[Hunter Bot] Rapport quotidien — Système OK (${new Date(report.checkedAt).toLocaleDateString("fr-FR")})`
    : `[Hunter Bot] ALERTE — Clé AES changée ! Action requise (${new Date(report.checkedAt).toLocaleDateString("fr-FR")})`;

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

    // Log system-level event — the HTTP handler will gracefully skip it
    // if "system" is not a valid Convex ID (returns 200 with skipped flag)
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
 * Construit le HTML du rapport email — même design pattern que convex/emails.ts
 */
function buildReportHtml(report: BundleCheckReport): string {
  const statusEmoji = report.aesKeyValid ? "✅" : "🚨";
  const aesStatus = report.aesKeyValid
    ? (report.aesKeyAutoExtracted ? "Auto-extraite (NOUVELLE CLÉ)" : "Valide — Aucun changement")
    : "INVALIDE — Action manuelle requise";

  const aesColor = report.aesKeyValid ? "#16a34a" : "#dc2626";

  const jobRows = report.jobDetails
    .map(
      (j) =>
        `<tr>
          <td style="padding:10px 14px;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${j.applicantName}</td>
          <td style="padding:10px 14px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">${j.urgencyTier}</td>
          <td style="padding:10px 14px;color:#0f172a;font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${j.lastResult || "—"}</td>
          <td style="padding:10px 14px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">${j.lastCheckAt ? new Date(j.lastCheckAt).toLocaleTimeString("fr-CD") : "—"}</td>
        </tr>`,
    )
    .join("");

  const infoRow = (label: string, value: string, color?: string) =>
    `<tr>
      <td style="padding:10px 14px;color:#64748b;font-size:13px;width:160px;border-bottom:1px solid #f1f5f9;vertical-align:top;">${label}</td>
      <td style="padding:10px 14px;color:${color ?? "#0f172a"};font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${value}</td>
    </tr>`;

  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">
      ${statusEmoji} Rapport Hunter Bot
    </h1>
    <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
      Vérification quotidienne du bundle Angular et état de santé des scanners.
    </p>

    <!-- AES STATUS -->
    <table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;">
      <tr>
        <td style="background:${report.aesKeyValid ? "#f0fdf4" : "#fef2f2"};border:1px solid ${report.aesKeyValid ? "#bbf7d0" : "#fecaca"};border-radius:10px;padding:16px 20px;">
          <p style="margin:0 0 6px;color:${report.aesKeyValid ? "#166534" : "#991b1b"};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">🔐 Chiffrement AES</p>
          <p style="margin:0;color:${report.aesKeyValid ? "#14532d" : "#7f1d1d"};font-size:14px;font-weight:600;">${aesStatus}</p>
        </td>
      </tr>
    </table>

    <!-- BUNDLE DETAILS -->
    <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      ${infoRow("Bundle", `<code style="font-size:11px;background:#f1f5f9;padding:2px 6px;border-radius:4px;">${report.bundleName}</code>`)}
      ${infoRow("Statut AES", aesStatus, aesColor)}
      ${infoRow("Clé actuelle", `<code style="font-size:11px;">${report.currentAesKey.slice(0, 24)}…</code>`)}
      ${report.previousAesKey ? infoRow("Clé précédente", `<code style="font-size:11px;color:#94a3b8;">${report.previousAesKey.slice(0, 24)}…</code>`) : ""}
    </table>

    <!-- SCANNER HEALTH -->
    <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      ${infoRow("Jobs actifs", String(report.activeJobsCount))}
      ${infoRow("En pause", String(report.pausedJobsCount), report.pausedJobsCount > 0 ? "#d97706" : "#16a34a")}
      ${infoRow("Complétés", String(report.completedJobsCount), "#16a34a")}
      ${infoRow("Erreurs", String(report.errorJobsCount), report.errorJobsCount > 0 ? "#dc2626" : "#16a34a")}
      ${infoRow("Proxy Pool", report.proxyPoolStatus)}
      ${infoRow("IP serveur", `<code style="font-size:12px;">${report.serverIp ?? "Inconnue"}</code>`)}
    </table>

    ${report.jobDetails.length > 0 ? `
    <!-- JOB DETAILS TABLE -->
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">📋 Détails par dossier</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Client</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Tier</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Résultat</th>
          <th style="padding:10px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Dernier check</th>
        </tr>
      </thead>
      <tbody>${jobRows}</tbody>
    </table>` : ""}

    <p style="margin:28px 0 0;color:#94a3b8;font-size:11px;">
      Rapport généré le ${new Date(report.checkedAt).toLocaleString("fr-FR")} — Hunter Bot v2
    </p>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Rapport Hunter Bot</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 0;">
    <tr><td align="center" style="padding:0 16px;">
      <table width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">

        <!-- LOGO HEADER -->
        <tr>
          <td style="background:#ffffff;padding:28px 40px 24px;border-radius:16px 16px 0 0;border:1px solid #e2e8f0;border-bottom:none;">
            <table cellpadding="0" cellspacing="0">
              <tr>
                <td>
                  <img src="${LOGO_URL}" alt="Joventy" height="38" style="display:block;height:38px;border:0;outline:none;text-decoration:none;"/>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- ACCENT LINE -->
        <tr>
          <td style="background:#1d4ed8;height:3px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="background:#ffffff;padding:36px 40px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">
            ${body}
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f8fafc;padding:20px 40px;border:1px solid #e2e8f0;border-top:1px solid #e2e8f0;border-radius:0 0 16px 16px;">
            <p style="margin:0;color:#94a3b8;font-size:11px;line-height:1.8;text-align:center;">
              Akollad Groupe &nbsp;&middot;&nbsp; RCCM CD/KNG/RCCM/25-A-07960 &nbsp;&middot;&nbsp; N&deg; Imp&ocirc;t A2557944L &nbsp;&middot;&nbsp; ID 01-J6100-N86614P<br/>
              <a href="${APP_URL}" style="color:#64748b;text-decoration:none;">joventy.cd</a>
              &nbsp;&middot;&nbsp;
              <a href="https://akollad.com" style="color:#64748b;text-decoration:none;">akollad.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
