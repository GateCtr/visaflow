import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const RESEND_API_URL = "https://api.resend.com/emails";
const FROM = "Joventy <hello@joventy.cd>";
const APP_URL = "https://joventy.cd";

function getAdminEmail(): string {
  return process.env.JOVENTY_ADMIN_EMAIL ?? "admin@joventy.cd";
}

async function sendEmail(payload: {
  from: string;
  to: string;
  subject: string;
  html: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Emails] RESEND_API_KEY non configurée — email ignoré");
    return;
  }
  if (!payload.to || !payload.to.includes("@")) {
    console.warn("[Emails] Adresse destinataire invalide — email ignoré");
    return;
  }
  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[Emails] Erreur Resend", res.status, err);
    }
  } catch (e) {
    console.error("[Emails] Exception fetch", e);
  }
}

function destLabel(destination: string): string {
  const map: Record<string, string> = {
    usa: "États-Unis",
    dubai: "Dubaï",
    turkey: "Turquie",
    india: "Inde",
  };
  return map[destination] ?? destination;
}

const LOGO_URL = `${APP_URL}/icon.png`;

function htmlWrapper(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
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
              Akollad Groupe &nbsp;·&nbsp; RCCM CD/KNG/RCCM/25-A-07960 &nbsp;·&nbsp; N° Impôt A2557944L &nbsp;·&nbsp; ID 01-J6100-N86614P<br/>
              <a href="https://joventy.cd" style="color:#64748b;text-decoration:none;">joventy.cd</a>
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

function cta(href: string, text: string): string {
  return `<table cellpadding="0" cellspacing="0" style="margin-top:28px;">
    <tr>
      <td style="background:#1d4ed8;border-radius:8px;">
        <a href="${href}" style="display:inline-block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.1px;">${text} →</a>
      </td>
    </tr>
  </table>`;
}

function escHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function info(label: string, value: string): string {
  return `<tr>
    <td style="padding:10px 14px;color:#64748b;font-size:13px;width:150px;border-bottom:1px solid #f1f5f9;vertical-align:top;">${label}</td>
    <td style="padding:10px 14px;color:#0f172a;font-size:13px;font-weight:600;border-bottom:1px solid #f1f5f9;">${value}</td>
  </tr>`;
}

function infoTable(rows: string): string {
  return `<table style="width:100%;border-collapse:collapse;margin:20px 0;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">${rows}</table>`;
}

function paymentBox(): string {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;">
    <tr>
      <td style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:16px 20px;">
        <p style="margin:0 0 6px;color:#0369a1;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">Modes de paiement</p>
        <p style="margin:0;color:#0c4a6e;font-size:13px;line-height:1.8;">
          M-Pesa &nbsp;<strong>0820 344 541</strong><br/>
          Airtel Money &nbsp;<strong>0990 775 880</strong><br/>
          Orange Money &nbsp;<strong>+243 840 808 122</strong>
        </p>
      </td>
    </tr>
  </table>`;
}

function urgentBanner(text: string): string {
  return `<table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;">
    <tr>
      <td style="background:#fffbeb;border:1.5px solid #fbbf24;border-radius:10px;padding:16px 20px;">
        <p style="margin:0;color:#78350f;font-size:14px;font-weight:600;line-height:1.6;">⏱&nbsp; ${text}</p>
      </td>
    </tr>
  </table>`;
}

/* ─────────────────────────── 0. RELANCE PAIEMENT → CLIENT ─── */
export const sendPaymentReminderClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    visaType: v.string(),
    engagementFee: v.number(),
    applicationId: v.string(),
    hoursElapsed: v.number(),
    reminderNumber: v.number(),
  },
  handler: async (_ctx, args) => {
    const isUrgent = args.reminderNumber >= 2;
    const subjectPrefix = isUrgent ? "⚠️ Dernière relance" : "🔔 Rappel";
    const rows =
      info("Demandeur", escHtml(args.applicantName)) +
      info("Destination", destLabel(args.destination)) +
      info("Type de visa", escHtml(args.visaType)) +
      info("Frais d'engagement", `${args.engagementFee} USD`);

    const urgencyText = isUrgent
      ? `Votre dossier ${destLabel(args.destination)} risque d'être annulé si le paiement n'est pas reçu dans les prochaines heures.`
      : `Votre dossier ${destLabel(args.destination)} est en attente de votre paiement depuis ${args.hoursElapsed} heures.`;

    const body = `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">
        ${isUrgent ? "⚠️ Action requise — Paiement en attente" : "🔔 Rappel — Votre dossier vous attend"}
      </h2>
      <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7;">
        Bonjour <strong>${escHtml(args.applicantName)}</strong>,<br/><br/>
        ${urgencyText}<br/><br/>
        Réglez les <strong>frais d'engagement de ${args.engagementFee} USD</strong> pour activer le traitement de votre dossier.
      </p>
      ${infoTable(rows)}
      ${urgentBanner("Paiement via M-Pesa, Airtel Money ou Orange Money — aucune carte internationale requise.")}
      ${paymentBox()}
      ${cta(`${APP_URL}/dashboard/applications/${args.applicationId}/payment`, "Régler maintenant")}
      <p style="margin:20px 0 0;color:#94a3b8;font-size:12px;line-height:1.7;">
        Si vous avez déjà effectué le paiement, ignorez ce message — notre équipe traitera votre reçu dans les 2 heures ouvrables.
      </p>
    `;

    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `${subjectPrefix} — Paiement en attente pour votre dossier ${destLabel(args.destination)}`,
      html: htmlWrapper("Rappel paiement — Joventy", body),
    });
  },
});

/* ─────────────────────── 0b. RELANCE PRIME DE SUCCÈS → CLIENT ─── */
export const sendSuccessFeeReminderClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    slotDate: v.string(),
    slotTime: v.optional(v.string()),
    slotLocation: v.optional(v.string()),
    successFee: v.number(),
    applicationId: v.string(),
    hoursElapsed: v.number(),
    slotExpiresAt: v.number(),
    reminderNumber: v.number(),
  },
  handler: async (_ctx, args) => {
    const isUrgent = args.reminderNumber >= 2;
    const expiresDate = new Date(args.slotExpiresAt).toLocaleDateString("fr-FR", {
      day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
    });
    const rows =
      info("Demandeur", escHtml(args.applicantName)) +
      info("Destination", destLabel(args.destination)) +
      info("Date RDV", escHtml(args.slotDate)) +
      (args.slotTime ? info("Heure RDV", escHtml(args.slotTime)) : "") +
      (args.slotLocation ? info("Lieu", escHtml(args.slotLocation)) : "") +
      info("Prime de succès", `${args.successFee} USD`) +
      info("Expire le", expiresDate);

    const body = `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">
        ${isUrgent ? "⚠️ Créneau en danger — Prime requise d'urgence" : "🎯 Rappel — Votre créneau est réservé"}
      </h2>
      <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7;">
        Bonjour <strong>${escHtml(args.applicantName)}</strong>,<br/><br/>
        Un créneau de rendez-vous <strong>${destLabel(args.destination)}</strong> a été réservé pour vous.
        ${isUrgent
          ? `<br/><strong style="color:#dc2626;">Ce créneau sera libéré le ${expiresDate} si la prime n'est pas réglée.</strong>`
          : `<br/>Réglez la prime de succès pour le confirmer définitivement.`
        }
      </p>
      ${infoTable(rows)}
      ${urgentBanner(`Créneau réservé — expire le ${expiresDate}. Réglez la prime avant cette échéance pour ne pas perdre votre place.`)}
      ${paymentBox()}
      ${cta(`${APP_URL}/dashboard/applications/${args.applicationId}`, "Confirmer mon créneau")}
    `;

    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `${isUrgent ? "⚠️ URGENT" : "🎯 Rappel"} — Prime de succès en attente (${destLabel(args.destination)})`,
      html: htmlWrapper("Rappel prime de succès — Joventy", body),
    });
  },
});

/* ─────────────────────────────── 1. NOUVEAU DOSSIER → ADMIN ─── */
export const sendNewApplicationAdmin = internalAction({
  args: {
    applicantName: v.string(),
    destination: v.string(),
    visaType: v.string(),
    userEmail: v.optional(v.string()),
    userFullName: v.optional(v.string()),
    servicePackage: v.optional(v.string()),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const rows =
      info("Demandeur", args.applicantName) +
      info("Destination", destLabel(args.destination)) +
      info("Type de visa", args.visaType) +
      info("Package", args.servicePackage ?? "full_service") +
      (args.userFullName ? info("Client", args.userFullName) : "") +
      (args.userEmail ? info("Email client", args.userEmail) : "");

    const body = `
      <h2 style="margin:0 0 24px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Nouveau dossier reçu</h2>
      ${infoTable(rows)}
      ${cta(`${APP_URL}/admin/applications/${args.applicationId}`, "Voir le dossier")}
    `;
    await sendEmail({
      from: FROM,
      to: getAdminEmail(),
      subject: `📋 Nouveau dossier — ${args.applicantName} (${destLabel(args.destination)})`,
      html: htmlWrapper("Nouveau dossier Joventy", body),
    });
  },
});

/* ─────────────────────────── 2. CONFIRMATION CRÉATION → CLIENT ─── */
export const sendApplicationConfirmationClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    visaType: v.string(),
    engagementFee: v.number(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const rows =
      info("Demandeur", args.applicantName) +
      info("Destination", destLabel(args.destination)) +
      info("Type de visa", args.visaType) +
      info("Frais d'engagement", `${args.engagementFee} USD`);

    const body = `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Votre dossier a bien été créé</h2>
      <p style="margin:0 0 20px;color:#64748b;font-size:14px;">Référence : JOV-${args.applicationId.slice(-5).toUpperCase()}</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px;">Merci de faire confiance à Joventy. Votre demande de visa est enregistrée. La prochaine étape est de régler les <strong>frais d'engagement (${args.engagementFee}&nbsp;USD)</strong> pour activer votre dossier.</p>
      ${infoTable(rows)}
      ${paymentBox()}
      ${cta(`${APP_URL}/dashboard`, "Accéder à mon espace")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: "Joventy — Votre dossier visa est créé",
      html: htmlWrapper("Dossier créé — Joventy", body),
    });
  },
});

/* ──────────────────────── 3. PAIEMENT ENGAGEMENT VALIDÉ → CLIENT ─── */
export const sendEngagementValidatedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    applicationId: v.string(),
    servicePackage: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const isSlotOnly = args.servicePackage === "slot_only";
    const isDossierOnly = args.servicePackage === "dossier_only";

    const nextStepText = isSlotOnly
      ? "Notre système de surveillance va maintenant rechercher un créneau de rendez-vous à l'ambassade. Vous serez alerté dès qu'un créneau est disponible — restez connecté à votre espace Joventy."
      : isDossierOnly
        ? "L'équipe Joventy va maintenant préparer et vérifier vos formulaires officiels. Nous vous contacterons via la messagerie de votre espace client."
        : "L'équipe Joventy va maintenant examiner votre dossier. Préparez vos documents et uploadez-les dans votre espace client — nous vous contacterons pour la suite.";

    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Paiement confirmé ✅</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 12px;">Vos frais d'engagement pour le visa <strong>${destLabel(args.destination)}</strong> de <strong>${args.applicantName}</strong> ont été validés. Votre dossier est maintenant <strong>actif</strong>.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">${nextStepText}</p>
      ${cta(`${APP_URL}/dashboard`, "Voir mon dossier")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `Joventy — Paiement validé, dossier ${destLabel(args.destination)} activé`,
      html: htmlWrapper("Paiement validé", body),
    });
  },
});

/* ──────────────────────────── 4. CHASSE CRÉNEAUX LANCÉE → CLIENT ─── */
export const sendSlotHuntingStartedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Surveillance activée 🔍</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 12px;">Notre système est maintenant <strong>actif</strong> pour votre visa <strong>${destLabel(args.destination)}</strong>. Nous vérifions en continu la disponibilité des créneaux à l'ambassade.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">Dès qu'un créneau est disponible, vous serez alerté immédiatement. <strong>Restez connecté à votre espace Joventy</strong> pour suivre l'évolution en temps réel.</p>
      ${cta(`${APP_URL}/dashboard`, "Suivre mon dossier")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `Joventy — Surveillance des créneaux activée (${destLabel(args.destination)})`,
      html: htmlWrapper("Chasse aux créneaux démarrée", body),
    });
  },
});

/* ───────────────────────────── 5. CRÉNEAU TROUVÉ → CLIENT (URGENT) ─── */
export const sendSlotFoundClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    successFee: v.number(),
    slotDate: v.optional(v.string()),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Un rendez-vous est disponible 🎉</h2>
      ${urgentBanner("Vous avez 48 heures pour régler la prime de succès et sécuriser ce créneau.")}
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 12px;">Notre système a capturé un créneau d'entretien à l'ambassade pour votre visa <strong>${destLabel(args.destination)}</strong>${args.slotDate ? ` — date : <strong>${args.slotDate}</strong>` : ""}.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 4px;">Pour débloquer tous les détails et recevoir votre kit d'entretien, réglez la <strong>prime de succès de ${args.successFee}&nbsp;USD</strong> dans les 48 heures.</p>
      ${paymentBox()}
      ${cta(`${APP_URL}/dashboard`, "Débloquer mon rendez-vous")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `🎉 URGENT — Créneau ${destLabel(args.destination)} trouvé ! 48h pour confirmer`,
      html: htmlWrapper("Créneau trouvé — Action requise", body),
    });
  },
});

/* ──────────────────────── 6. VISA OBTENU (e-Visa) → CLIENT (URGENT) ─── */
export const sendVisaObtainedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    successFee: v.number(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Votre visa ${destLabel(args.destination)} est prêt 🎉</h2>
      ${urgentBanner("Réglez la prime de succès pour recevoir votre document officiel.")}
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 12px;">Excellente nouvelle ! L'équipe Joventy a obtenu votre visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong>.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 4px;">Pour télécharger votre document officiel, réglez la <strong>prime de succès de ${args.successFee}&nbsp;USD</strong>.</p>
      ${paymentBox()}
      ${cta(`${APP_URL}/dashboard`, "Télécharger mon visa")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `🎉 Votre visa ${destLabel(args.destination)} est prêt — Prime de succès à régler`,
      html: htmlWrapper("Visa obtenu", body),
    });
  },
});

/* ──────────────────────── 7. DOSSIER COMPLÉTÉ → CLIENT ─── */
export const sendDossierCompletedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Félicitations, dossier complété ! 🏆</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 12px;">Votre dossier visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong> est <strong>entièrement finalisé</strong>. Votre kit complet est disponible dans votre espace Joventy.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">Merci de nous avoir fait confiance. Nous vous souhaitons un excellent voyage ! ✈️</p>
      ${cta(`${APP_URL}/dashboard`, "Accéder à mon kit")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `Joventy — Dossier ${destLabel(args.destination)} complété avec succès`,
      html: htmlWrapper("Dossier complété", body),
    });
  },
});

/* ──────────────────────── 8. DOSSIER REJETÉ → CLIENT ─── */
export const sendApplicationRejectedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    reason: v.string(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Information sur votre dossier</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px;">Après examen, votre dossier de visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong> n'a pas pu être traité pour la raison suivante :</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;">
        <tr>
          <td style="background:#fef2f2;border-left:4px solid #ef4444;border-radius:0 8px 8px 0;padding:14px 18px;">
            <p style="margin:0;color:#991b1b;font-size:14px;line-height:1.6;">${escHtml(args.reason)}</p>
          </td>
        </tr>
      </table>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0;">Si vous pensez qu'il s'agit d'une erreur, contactez-nous via la messagerie de votre espace client.</p>
      ${cta(`${APP_URL}/dashboard`, "Contacter Joventy")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `Joventy — Information sur votre dossier ${destLabel(args.destination)}`,
      html: htmlWrapper("Information dossier", body),
    });
  },
});

/* ──────────────────────── 9. NOUVEAU MESSAGE ADMIN → CLIENT ─── */
export const sendNewMessageClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    messagePreview: v.string(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const preview = escHtml(
      args.messagePreview.length > 160
        ? args.messagePreview.slice(0, 157) + "..."
        : args.messagePreview
    );

    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Nouveau message de Joventy</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px;">L'équipe Joventy vous a envoyé un message concernant votre dossier <strong>${destLabel(args.destination)}</strong> :</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 8px;">
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;">
            <p style="margin:0;color:#334155;font-size:14px;line-height:1.8;font-style:italic;">"${preview}"</p>
          </td>
        </tr>
      </table>
      ${cta(`${APP_URL}/dashboard`, "Lire et répondre")}
    `;
    await sendEmail({
      from: FROM,
      to: args.to,
      subject: `Joventy — Nouveau message concernant votre dossier ${destLabel(args.destination)}`,
      html: htmlWrapper("Nouveau message Joventy", body),
    });
  },
});

/* ────────────────────────────── 10. NOUVEAU MESSAGE CLIENT → ADMIN ─── */
export const sendNewMessageAdmin = internalAction({
  args: {
    applicantName: v.string(),
    destination: v.string(),
    senderName: v.string(),
    messagePreview: v.string(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const preview = escHtml(
      args.messagePreview.length > 200
        ? args.messagePreview.slice(0, 197) + "..."
        : args.messagePreview
    );

    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Message d'un client</h2>
      ${infoTable(
        info("Expéditeur", escHtml(args.senderName)) +
        info("Dossier", escHtml(args.applicantName)) +
        info("Destination", destLabel(args.destination))
      )}
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 8px;">
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;">
            <p style="margin:0;color:#334155;font-size:14px;line-height:1.8;font-style:italic;">"${preview}"</p>
          </td>
        </tr>
      </table>
      ${cta(`${APP_URL}/admin/applications/${args.applicationId}`, "Répondre au client")}
    `;
    await sendEmail({
      from: FROM,
      to: getAdminEmail(),
      subject: `💬 Message de ${args.senderName} — ${args.applicantName} (${destLabel(args.destination)})`,
      html: htmlWrapper("Nouveau message client", body),
    });
  },
});

/* ──────────────── 11b. ESPAGNE — INSTRUCTIONS PRÉ-INSCRIPTION AMBASSADE ─── */
export const sendSpainPreRegistrationClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    applicationId: v.string(),
    travelDate: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const name = escHtml(args.applicantName);
    const travelDateExample = args.travelDate
      ? escHtml(args.travelDate)
      : "JJMMAAAA (ex : 15092025)";

    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Action requise — Inscription auprès de l'ambassade d'Espagne 🇪🇸</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 16px;">Bonjour <strong>${name}</strong>, notre robot de surveillance est maintenant actif. Pour qu'il puisse réserver votre créneau sur citaconsular.es, vous devez d'abord <strong>obtenir vos identifiants auprès de l'ambassade</strong> en suivant les 2 étapes ci-dessous.</p>

      <!-- ÉTAPE 1 -->
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
        <tr>
          <td style="background:#fef9ee;border:1.5px solid #f59e0b;border-radius:12px;padding:22px 24px;">
            <p style="margin:0 0 10px;color:#92400e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;">Étape 1 — Envoyer un email à l'ambassade</p>
            <p style="margin:0 0 10px;color:#78350f;font-size:14px;line-height:1.7;">Envoyez un email à :</p>
            <p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1d4ed8;">emb.kinshasa.citasvis@maec.es</p>
            <p style="margin:0 0 6px;color:#78350f;font-size:14px;">Objet de l'email :</p>
            <p style="margin:0 0 14px;background:#fff;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;font-family:monospace;font-size:14px;font-weight:700;color:#92400e;letter-spacing:0.5px;">RENDEZ-VOUS VISA EST</p>
            <p style="margin:0 0 8px;color:#78350f;font-size:14px;font-weight:600;">Corps du message (copiez ce modèle) :</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 14px;">
              <tr>
                <td style="background:#0f172a;border-radius:8px;padding:14px 16px;">
                  <p style="margin:0;font-family:monospace;font-size:13px;color:#86efac;line-height:2;">
                    NOM PRÉNOM EN MAJUSCULES SANS ACCENTS;<br/>
                    NUMÉRO DE PASSEPORT (sans tirets);<br/>
                    DATE DE DÉPART (${travelDateExample});<br/>
                    EST
                  </p>
                  <p style="margin:10px 0 0;font-family:monospace;font-size:11px;color:#64748b;">Exemple : JEAN KABILA;AB123456;15092025;EST</p>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;color:#78350f;font-size:14px;font-weight:600;">Pièces jointes obligatoires :</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;">
              <tr><td style="padding:3px 0;color:#92400e;font-size:13px;line-height:1.6;">📎&nbsp; <strong>Photo de vous tenant votre passeport ouvert</strong> (JPEG ou PDF, lisible, sans lunettes noires ni visage couvert)</td></tr>
              <tr><td style="padding:3px 0;color:#92400e;font-size:13px;line-height:1.6;">📎&nbsp; Formulaire de candidature officiel <strong>avec votre photo</strong></td></tr>
              <tr><td style="padding:3px 0;color:#92400e;font-size:13px;line-height:1.6;">📎&nbsp; Réservation de vol (confirmée)</td></tr>
              <tr><td style="padding:3px 0;color:#92400e;font-size:13px;line-height:1.6;">📎&nbsp; Assurance santé / voyage (min. 30 000 €)</td></tr>
            </table>
            <p style="margin:12px 0 0;color:#b45309;font-size:12px;line-height:1.6;">⚠️ Ne renvoyez pas l'email avant 14 jours de délai. Un email séparé par personne. Taille totale des pièces jointes : max 1 Mo.</p>
          </td>
        </tr>
      </table>

      <!-- ÉTAPE 2 -->
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
        <tr>
          <td style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:22px 24px;">
            <p style="margin:0 0 10px;color:#14532d;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px;">Étape 2 — Transmettez vos identifiants à Joventy</p>
            <p style="margin:0 0 10px;color:#166534;font-size:14px;line-height:1.7;">Une fois que l'ambassade vous a envoyé votre <strong>identifiant et mot de passe</strong> par email de confirmation, transmettez-les à votre conseiller Joventy via la messagerie de votre dossier.</p>
            <p style="margin:0;color:#166534;font-size:14px;line-height:1.7;">Notre robot se connectera à citaconsular.es avec ces identifiants et réservera <strong>automatiquement</strong> le premier créneau disponible correspondant à vos dates.</p>
          </td>
        </tr>
      </table>

      <!-- INFOS PRATIQUES -->
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
        <tr>
          <td style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:18px 22px;">
            <p style="margin:0 0 10px;color:#475569;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">À savoir</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;">
              <tr><td style="padding:3px 0;color:#475569;font-size:13px;line-height:1.6;">🕗&nbsp; Ambassade ouverte lun–ven 8h30–14h (Kinshasa)</td></tr>
              <tr><td style="padding:3px 0;color:#475569;font-size:13px;line-height:1.6;">📋&nbsp; Délai de traitement : 15 à 45 jours après dépôt</td></tr>
              <tr><td style="padding:3px 0;color:#475569;font-size:13px;line-height:1.6;">🗓&nbsp; Demandez entre 6 mois et 15 jours avant votre voyage</td></tr>
              <tr><td style="padding:3px 0;color:#475569;font-size:13px;line-height:1.6;">🔍&nbsp; Suivi de dossier : <a href="https://sutramiteconsular.maec.es" style="color:#1d4ed8;">sutramiteconsular.maec.es</a></td></tr>
              <tr><td style="padding:3px 0;color:#475569;font-size:13px;line-height:1.6;">💶&nbsp; Frais consulaires (90 €/adulte) payés directement à l'ambassade — non inclus dans le tarif Joventy</td></tr>
            </table>
          </td>
        </tr>
      </table>

      <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0 0 4px;">Des questions ? Contactez-nous via la messagerie de votre dossier ou sur WhatsApp au <strong>+243 840 808 122</strong>.</p>
      ${cta(`${APP_URL}/dashboard`, "Accéder à mon dossier")}
    `;

    await sendEmail({
      from: FROM,
      to: args.to,
      subject: "🇪🇸 Action requise — Inscription visa Espagne (étape obligatoire avant rendez-vous)",
      html: htmlWrapper("Visa Espagne — Instructions d'inscription", body),
    });
  },
});

/* ─────────────── 10b. OTP ESPAGNE — CONFIG ACTIVÉE → CLIENT ─── */
export const sendSpainOtpConfiguredClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    channel: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    applicationId: v.id("applications"),
  },
  handler: async (_ctx, args) => {
    const channelLabel =
      args.channel === "email"
        ? `Email (interception IMAP automatique)`
        : args.channel === "sms"
        ? `SMS (assistance manuelle)`
        : `Manuel (vous serez notifié pour saisir le code)`;

    const channelDetail =
      args.channel === "email" && args.email
        ? info("Adresse configurée", escHtml(args.email))
        : args.channel === "sms" && args.phone
        ? info("Numéro configuré", escHtml(args.phone))
        : "";

    const removalWarning = `<table cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;">
      <tr>
        <td style="background:#fefce8;border:1.5px solid #fbbf24;border-radius:10px;padding:16px 20px;">
          <p style="margin:0 0 8px;color:#78350f;font-size:14px;font-weight:700;">Important — Suppression après opération</p>
          <p style="margin:0;color:#78350f;font-size:13px;line-height:1.7;">
            Une fois votre rendez-vous obtenu, supprimez vos identifiants depuis votre espace client :<br/>
            <strong>Dossier → section OTP Espagne → bouton "Supprimer mes identifiants"</strong><br/>
            Vos données seront effacées immédiatement de nos serveurs.
          </p>
        </td>
      </tr>
    </table>`;

    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Configuration OTP Espagne activée ✅</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px;">
        Bonjour <strong>${escHtml(args.applicantName)}</strong>,<br/><br/>
        Votre configuration pour l'interception automatique des codes OTP du portail espagnol est bien enregistrée.
        Notre système utilisera ces informations uniquement lors des sessions de réservation de créneau.
      </p>
      ${infoTable(
        info("Canal configuré", channelLabel) +
        channelDetail
      )}
      ${removalWarning}
      <p style="color:#64748b;font-size:13px;line-height:1.7;margin:16px 0 0;">
        En cas de doute ou si vous souhaitez mettre à jour ces informations, rendez-vous dans votre espace client à tout moment.
      </p>
      ${cta(`${APP_URL}/dashboard/applications/${args.applicationId}`, "Voir mon dossier")}
    `;

    await sendEmail({
      from: FROM,
      to: args.to,
      subject: "Joventy — Configuration OTP Espagne enregistrée",
      html: htmlWrapper("OTP Espagne configuré", body),
    });
  },
});

/* ─────────────── 10c. OTP ESPAGNE — CONFIG SUPPRIMÉE → CLIENT ─── */
export const sendSpainOtpRemovedClient = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    applicationId: v.id("applications"),
  },
  handler: async (_ctx, args) => {
    const body = `
      <h2 style="margin:0 0 16px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Identifiants OTP supprimés 🗑️</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;margin:0 0 20px;">
        Bonjour <strong>${escHtml(args.applicantName)}</strong>,<br/><br/>
        Vos identifiants OTP pour le dossier Espagne ont été <strong>définitivement supprimés</strong> de nos serveurs.
        Aucune information d'accès n'est plus stockée par Joventy pour ce dossier.
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
        <tr>
          <td style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:10px;padding:16px 20px;">
            <p style="margin:0;color:#166534;font-size:14px;line-height:1.7;">
              ✅ &nbsp;Données d'accès effacées<br/>
              ✅ &nbsp;Interception automatique désactivée<br/>
              ✅ &nbsp;Aucune donnée résiduelle conservée
            </p>
          </td>
        </tr>
      </table>
      <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0;">
        Si vous devez reprendre l'automatisation OTP, vous pouvez reconfigurer vos identifiants depuis votre dossier à tout moment.
      </p>
      ${cta(`${APP_URL}/dashboard/applications/${args.applicationId}`, "Voir mon dossier")}
    `;

    await sendEmail({
      from: FROM,
      to: args.to,
      subject: "Joventy — Identifiants OTP Espagne supprimés",
      html: htmlWrapper("OTP Espagne supprimé", body),
    });
  },
});

/* ───────────────────────────── 11. BIENVENUE NOUVELLE INSCRIPTION ─── */
export const sendWelcomeClient = internalAction({
  args: {
    email: v.string(),
    firstName: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const prenom = args.firstName ? escHtml(args.firstName) : "là";

    const body = `
      <h2 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;letter-spacing:-0.3px;">Bienvenue sur Joventy${prenom !== "là" ? `, ${prenom}` : ""} 👋</h2>
      <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.7;">Votre compte est actif. Déposez votre demande de visa et suivez l'avancement de votre dossier en temps réel depuis votre espace personnel.</p>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 20px;">
        <tr>
          <td style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:18px 22px;">
            <p style="margin:0 0 10px;color:#1e40af;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;">Avec Joventy vous pouvez</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;">
              <tr><td style="padding:4px 0;color:#1e3a5f;font-size:14px;">✅&nbsp; Déposer une demande de visa (USA, Espagne, Dubaï, Turquie, Inde)</td></tr>
              <tr><td style="padding:4px 0;color:#1e3a5f;font-size:14px;">✅&nbsp; Suivre votre dossier en temps réel</td></tr>
              <tr><td style="padding:4px 0;color:#1e3a5f;font-size:14px;">✅&nbsp; Échanger directement avec notre équipe</td></tr>
              <tr><td style="padding:4px 0;color:#1e3a5f;font-size:14px;">✅&nbsp; Être alerté dès qu'un créneau est trouvé</td></tr>
            </table>
          </td>
        </tr>
      </table>
      <p style="color:#64748b;font-size:13px;line-height:1.7;margin:0;">Besoin d'aide ? Écrivez-nous via la messagerie intégrée ou sur WhatsApp au <strong>+243 840 808 122</strong>.</p>
      ${cta(`${APP_URL}/dashboard`, "Accéder à mon espace")}
    `;

    await sendEmail({
      from: FROM,
      to: args.email,
      subject: "Bienvenue sur Joventy — votre compte est actif",
      html: htmlWrapper("Bienvenue sur Joventy", body),
    });
  },
});
