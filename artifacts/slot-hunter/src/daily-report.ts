/**
 * Daily Report — Rapport quotidien automatique envoyé par email en fin de journée.
 *
 * Contenu :
 * - Période couverte (démarrage → rapport)
 * - Uptime
 * - Scans totaux + scans/heure effectifs
 * - Slots trouvés (dossier + heure)
 * - Rate-limits (combien et sur quels dossiers)
 * - Re-logins (préventifs vs réactifs)
 * - Dossiers actifs (liste avec scans/dossier)
 * - Dossiers en pause (lesquels et pourquoi)
 * - Proxy (SOAX OK / fallback direct utilisé X fois)
 * - Heures creuses (périodes où tous les dossiers étaient épuisés)
 * - Couverture (% du temps où au moins 1 scan était actif)
 *
 * Envoyé à sabowaryan@gmail.com via Resend (domaine joventy.cd).
 */

import { getDailySnapshot, resetDailyStats, checkIdleState, type DailyStatsSnapshot } from "./daily-stats.js";
import { log } from "./scheduler-utils.js";
import { botLog } from "./convexClient.js";
import { proxyPool } from "./browser.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = "Hunter Bot <bot@joventy.cd>";
const REPORT_RECIPIENT = "sabowaryan@gmail.com";
const LOGO_URL = "https://joventy.cd/icon.png";
const APP_URL = "https://joventy.cd";

// Heure d'envoi : 23h00 Kinshasa (UTC+1) = 22h00 UTC
const REPORT_HOUR_UTC = 22;
const REPORT_MINUTE_UTC = 0;

// ─── Scheduler State ────────────────────────────────────────────────────────

let lastReportSentDate: string = ""; // "YYYY-MM-DD" de la dernière date envoyée
let reportLoopRunning = false;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Démarre la boucle de vérification du rapport quotidien.
 * Vérifie toutes les 5 minutes si l'heure d'envoi est atteinte.
 */
export function startDailyReportLoop(): void {
  if (reportLoopRunning) return;
  reportLoopRunning = true;
  log("INFO", `[daily-report] Boucle activée — envoi prévu à 23h00 Kinshasa (${REPORT_HOUR_UTC}:${String(REPORT_MINUTE_UTC).padStart(2, "0")} UTC)`);

  const CHECK_INTERVAL_MS = 5 * 60_000; // Vérifier toutes les 5 min

  const loop = async () => {
    while (reportLoopRunning) {
      try {
        await checkAndSendReport();
      } catch (err) {
        log("WARN", `[daily-report] Erreur dans la boucle: ${err}`);
      }
      await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    }
  };

  // Lancer en background (non-bloquant)
  loop().catch(err => {
    log("ERROR", `[daily-report] Boucle crashée: ${err}`);
    reportLoopRunning = false;
  });
}

/** Arrête la boucle du rapport quotidien */
export function stopDailyReportLoop(): void {
  reportLoopRunning = false;
}

/**
 * Force l'envoi immédiat du rapport (utile pour debug/test).
 */
export async function sendDailyReportNow(): Promise<boolean> {
  return await generateAndSendReport();
}

// ─── Internal Logic ─────────────────────────────────────────────────────────

async function checkAndSendReport(): Promise<void> {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const todayStr = now.toISOString().slice(0, 10); // "YYYY-MM-DD"

  // Vérifier si on est dans la fenêtre d'envoi ET qu'on n'a pas déjà envoyé aujourd'hui
  if (utcHour === REPORT_HOUR_UTC && utcMinute >= REPORT_MINUTE_UTC && utcMinute < REPORT_MINUTE_UTC + 10) {
    if (lastReportSentDate === todayStr) return; // Déjà envoyé

    log("INFO", "[daily-report] Heure d'envoi atteinte — génération du rapport...");
    const success = await generateAndSendReport();
    if (success) {
      lastReportSentDate = todayStr;
      // Reset les stats pour le jour suivant
      resetDailyStats();
      log("INFO", "[daily-report] Stats réinitialisées pour le jour suivant");
    }
  }
}

async function generateAndSendReport(): Promise<boolean> {
  if (!RESEND_API_KEY) {
    log("WARN", "[daily-report] RESEND_API_KEY non configuré — rapport ignoré");
    return false;
  }

  // Mettre à jour l'état idle avant le snapshot
  checkIdleState();

  // Collecter le statut proxy
  const proxyState = proxyPool.getState?.() ?? {};
  const proxyStatusStr = proxyPool.isConfigured
    ? `SOAX OK — Gateway 2captcha (eu.proxy.2captcha.com:2334)`
    : (process.env.SOAX_PROXY_URL ? "SOAX configuré" : "Direct (aucun proxy)");

  const snapshot = getDailySnapshot(proxyStatusStr);
  const subject = buildSubject(snapshot);
  const html = buildDailyReportHtml(snapshot);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [REPORT_RECIPIENT],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log("WARN", `[daily-report] Resend API erreur HTTP ${res.status}: ${errText.slice(0, 200)}`);
      return false;
    }

    const result = (await res.json()) as { id?: string };
    log("INFO", `[daily-report] Rapport envoyé à ${REPORT_RECIPIENT} (id: ${result.id ?? "?"})`);

    // Log dans Convex
    botLog({
      applicationId: "system",
      step: "daily_report_sent",
      status: "ok",
      data: {
        to: REPORT_RECIPIENT,
        subject,
        resendId: result.id,
        totalScans: snapshot.totalScans,
        slotsFound: snapshot.slotsFound.length,
        coverage: snapshot.coveragePercent,
      },
    });

    return true;
  } catch (err) {
    log("ERROR", `[daily-report] Erreur envoi: ${err}`);
    return false;
  }
}

// ─── Subject Builder ────────────────────────────────────────────────────────

function buildSubject(snapshot: DailyStatsSnapshot): string {
  const date = new Date(snapshot.reportGeneratedAt).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const slotsCount = snapshot.slotsFound.length;
  const emoji = slotsCount > 0 ? "🎯" : "📊";
  return `${emoji} Rapport quotidien Hunter Bot — ${date} | ${snapshot.totalScans} scans, ${slotsCount} slot(s)`;
}

// ─── HTML Template Builder ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, "0")}min`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Kinshasa" });
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString("fr-FR", { timeZone: "Africa/Kinshasa", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function infoRow(label: string, value: string, color?: string): string {
  return `<tr>
    <td style="padding:10px 14px;color:#64748b;font-size:13px;width:180px;border-bottom:1px solid #f1f5f9;vertical-align:top;">${label}</td>
    <td style="padding:10px 14px;color:${color ?? "#0f172a"};font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${value}</td>
  </tr>`;
}

function buildDailyReportHtml(snapshot: DailyStatsSnapshot): string {
  const periodStart = formatTime(snapshot.startedAt);
  const periodEnd = formatTime(snapshot.reportGeneratedAt);
  const coverageColor = snapshot.coveragePercent >= 80 ? "#16a34a" : snapshot.coveragePercent >= 50 ? "#d97706" : "#dc2626";
  const slotsColor = snapshot.slotsFound.length > 0 ? "#16a34a" : "#64748b";

  // ── Section : Résumé global ──
  const summaryRows = [
    infoRow("Période couverte", `${periodStart} → ${periodEnd} (Kinshasa)`),
    infoRow("Uptime", formatDuration(snapshot.uptimeMs)),
    infoRow("Scans totaux", String(snapshot.totalScans)),
    infoRow("Scans/heure effectifs", String(snapshot.effectiveScansPerHour)),
    infoRow("Slots trouvés", snapshot.slotsFound.length > 0
      ? `${snapshot.slotsFound.length} slot(s)`
      : "0", slotsColor),
    infoRow("Couverture", `${snapshot.coveragePercent}%`, coverageColor),
  ].join("");

  // ── Section : Slots trouvés (détail) ──
  let slotsSection = "";
  if (snapshot.slotsFound.length > 0) {
    const slotRows = snapshot.slotsFound.map(s =>
      `<tr>
        <td style="padding:8px 14px;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${s.applicantName}</td>
        <td style="padding:8px 14px;color:#16a34a;font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${s.slotDate ?? "—"} ${s.slotTime ?? ""}</td>
        <td style="padding:8px 14px;color:#64748b;font-size:12px;border-bottom:1px solid #f1f5f9;">${formatTime(s.foundAt)}</td>
      </tr>`
    ).join("");

    slotsSection = `
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">🎯 Slots Trouvés</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f0fdf4;">
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#166534;font-weight:600;">Dossier</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#166534;font-weight:600;">Créneau</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#166534;font-weight:600;">Heure</th>
      </tr></thead>
      <tbody>${slotRows}</tbody>
    </table>`;
  }

  // ── Section : Rate-limits ──
  let rateLimitSection = "";
  if (snapshot.rateLimits.length > 0) {
    // Grouper par dossier
    const byDossier = new Map<string, number>();
    for (const rl of snapshot.rateLimits) {
      byDossier.set(rl.applicantName, (byDossier.get(rl.applicantName) ?? 0) + 1);
    }
    const rlRows = [...byDossier.entries()].map(([name, count]) =>
      `<tr>
        <td style="padding:8px 14px;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${name}</td>
        <td style="padding:8px 14px;color:#d97706;font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${count}x</td>
      </tr>`
    ).join("");

    rateLimitSection = `
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">⚠️ Rate-Limits (${snapshot.rateLimits.length} total)</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#fffbeb;">
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#92400e;font-weight:600;">Dossier</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#92400e;font-weight:600;">Occurrences</th>
      </tr></thead>
      <tbody>${rlRows}</tbody>
    </table>`;
  }

  // ── Section : Re-logins ──
  const reloginRow = infoRow("Re-logins", [
    `${snapshot.relogins.preventive} préventif(s)`,
    `${snapshot.relogins.reactive} réactif(s)`,
    `${snapshot.relogins.emergency} urgence(s)`,
  ].join(" · "), snapshot.relogins.total > 5 ? "#d97706" : "#0f172a");

  // ── Section : Dossiers actifs ──
  let activeDossiersSection = "";
  if (snapshot.activeDossiers.length > 0) {
    const activeRows = snapshot.activeDossiers.map(d =>
      `<tr>
        <td style="padding:8px 14px;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${d.applicantName}</td>
        <td style="padding:8px 14px;color:#0f172a;font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${d.count} scans</td>
      </tr>`
    ).join("");

    activeDossiersSection = `
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">📂 Dossiers Actifs (${snapshot.activeDossiers.length})</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Client</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Scans</th>
      </tr></thead>
      <tbody>${activeRows}</tbody>
    </table>`;
  }

  // ── Section : Dossiers en pause ──
  let pausedSection = "";
  if (snapshot.pausedDossiers.length > 0) {
    const pausedRows = snapshot.pausedDossiers.map(d =>
      `<tr>
        <td style="padding:8px 14px;color:#0f172a;font-size:13px;border-bottom:1px solid #f1f5f9;">${d.applicantName}</td>
        <td style="padding:8px 14px;color:#dc2626;font-size:13px;border-bottom:1px solid #f1f5f9;">${d.reason}</td>
      </tr>`
    ).join("");

    pausedSection = `
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">⏸️ Dossiers en Pause (${snapshot.pausedDossiers.length})</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#fef2f2;">
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#991b1b;font-weight:600;">Client</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#991b1b;font-weight:600;">Raison</th>
      </tr></thead>
      <tbody>${pausedRows}</tbody>
    </table>`;
  }

  // ── Section : Proxy ──
  const proxyRow = infoRow("Proxy", snapshot.proxyStatus);
  const proxyFallbackRow = snapshot.proxyFallbackCount > 0
    ? infoRow("Fallback direct", `${snapshot.proxyFallbackCount}x`, "#d97706")
    : infoRow("Fallback direct", "0 (stable)", "#16a34a");

  // ── Section : Heures creuses ──
  let idleSection = "";
  if (snapshot.idlePeriods.length > 0) {
    const idleRows = snapshot.idlePeriods.map(p =>
      `<tr>
        <td style="padding:8px 14px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">${formatTime(p.start)} → ${formatTime(p.end)}</td>
        <td style="padding:8px 14px;color:#64748b;font-size:13px;border-bottom:1px solid #f1f5f9;">${formatDuration(p.end - p.start)}</td>
      </tr>`
    ).join("");

    idleSection = `
    <p style="margin:24px 0 12px;font-size:14px;font-weight:700;color:#0f172a;">💤 Heures Creuses</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      <thead><tr style="background:#f8fafc;">
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Période</th>
        <th style="padding:8px 14px;text-align:left;font-size:12px;color:#64748b;font-weight:600;">Durée</th>
      </tr></thead>
      <tbody>${idleRows}</tbody>
    </table>`;
  } else {
    idleSection = `<p style="margin:24px 0 8px;font-size:13px;color:#16a34a;font-weight:600;">💤 Aucune heure creuse — couverture continue</p>`;
  }

  // ── Assemblage final ──
  const body = `
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#0f172a;">
      📊 Rapport Quotidien Hunter Bot
    </h1>
    <p style="margin:0 0 24px;font-size:14px;color:#64748b;line-height:1.6;">
      Résumé d'activité du ${new Date(snapshot.reportGeneratedAt).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Kinshasa" })}
    </p>

    <!-- RÉSUMÉ GLOBAL -->
    <table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
      ${summaryRows}
      ${reloginRow}
      ${proxyRow}
      ${proxyFallbackRow}
    </table>

    ${slotsSection}
    ${rateLimitSection}
    ${activeDossiersSection}
    ${pausedSection}
    ${idleSection}

    <p style="margin:28px 0 0;color:#94a3b8;font-size:11px;">
      Rapport généré le ${new Date(snapshot.reportGeneratedAt).toLocaleString("fr-FR", { timeZone: "Africa/Kinshasa" })} (Kinshasa) — Hunter Bot v2
    </p>`;

  // ── Wrapper HTML complet (même design que adminReporting.ts) ──
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Rapport Quotidien Hunter Bot</title>
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
