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

const LOGO_URL = `${APP_URL}/images/logo.png`;

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
              <tr><td style="padding:4px 0;color:#1e3a5f;font-size:14px;">✅&nbsp; Déposer une demande de visa (USA, Dubaï, Turquie, Inde)</td></tr>
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
