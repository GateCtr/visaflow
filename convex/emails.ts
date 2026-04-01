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

function htmlWrapper(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f7fb;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fb;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr>
          <td style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:32px 40px;">
            <h1 style="margin:0;color:#ffffff;font-size:26px;font-weight:700;letter-spacing:-0.5px;">Joventy</h1>
            <p style="margin:4px 0 0;color:#93c5fd;font-size:13px;">Visa Premium · République Démocratique du Congo</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 28px;">
            ${body}
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 40px;">
            <p style="margin:0;color:#64748b;font-size:11px;line-height:1.6;">
              Akollad Groupe — RCCM&nbsp;: CD/KNG/RCCM/25-A-07960 · N°&nbsp;Impôt&nbsp;: A2557944L · ID&nbsp;: 01-J6100-N86614P<br/>
              <a href="https://akollad.com" style="color:#2563eb;text-decoration:none;">akollad.com</a> ·
              <a href="${APP_URL}" style="color:#2563eb;text-decoration:none;">joventy.cd</a>
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
  return `<a href="${href}" style="display:inline-block;margin-top:20px;padding:14px 28px;background:#2563eb;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">${text}</a>`;
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
    <td style="padding:6px 0;color:#64748b;font-size:13px;width:160px;">${label}</td>
    <td style="padding:6px 0;color:#1e293b;font-size:13px;font-weight:500;">${value}</td>
  </tr>`;
}

function infoTable(rows: string): string {
  return `<table style="width:100%;border-collapse:collapse;margin:16px 0;">${rows}</table>`;
}

function urgentBanner(text: string): string {
  return `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:20px 0;">
    <p style="margin:0;color:#92400e;font-size:14px;font-weight:600;">⏰ ${text}</p>
  </div>`;
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Nouveau dossier reçu</p>
      <h2 style="margin:0 0 24px;color:#1e293b;font-size:22px;">Un client vient de déposer un dossier</h2>
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Confirmation de dépôt</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Votre dossier a bien été créé</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Merci d'avoir fait confiance à Joventy. Votre demande de visa est enregistrée. La prochaine étape consiste à régler les <strong>frais d'engagement (${args.engagementFee}&nbsp;USD)</strong> pour activer votre dossier.</p>
      ${infoTable(rows)}
      <p style="color:#64748b;font-size:13px;margin:16px 0 0;">Paiements acceptés : M-Pesa <strong>+243 840 808 122</strong> · Airtel <strong>0820 344 541</strong> · Orange <strong>0990 775 880</strong></p>
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
  },
  handler: async (_ctx, args) => {
    const body = `
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Paiement validé</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Votre paiement a été confirmé ✅</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Excellent ! Vos frais d'engagement pour le visa <strong>${destLabel(args.destination)}</strong> de <strong>${args.applicantName}</strong> ont été validés par notre équipe. Votre dossier est maintenant <strong>actif</strong>.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;">L'équipe Joventy va maintenant examiner votre dossier. Préparez vos documents — nous vous contacterons via la messagerie de votre espace client.</p>
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Chasse aux créneaux</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Notre bot surveille l'ambassade 🔍</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Notre système de surveillance automatique est maintenant <strong>actif</strong> pour votre visa <strong>${destLabel(args.destination)}</strong>. Nous vérifions en continu la disponibilité des créneaux de rendez-vous à l'ambassade.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Dès qu'un créneau est disponible, vous serez alerté immédiatement par email. <strong>Restez connecté à votre espace Joventy</strong> pour suivre l'évolution en temps réel.</p>
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
      <p style="margin:0 0 4px;color:#16a34a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Créneau trouvé</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Un rendez-vous est disponible pour vous ! 🎉</h2>
      ${urgentBanner("Vous avez 48 heures pour régler la prime de succès et sécuriser ce créneau.")}
      <p style="color:#475569;font-size:15px;line-height:1.7;">Notre système a capturé un créneau d'entretien à l'ambassade pour votre visa <strong>${destLabel(args.destination)}</strong>${args.slotDate ? ` (le <strong>${args.slotDate}</strong>)` : ""}.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Pour débloquer tous les détails du rendez-vous et recevoir votre kit d'entretien, réglez la <strong>prime de succès de ${args.successFee}&nbsp;USD</strong> dans les 48 heures.</p>
      <p style="color:#64748b;font-size:13px;margin:16px 0 8px;"><strong>Paiements :</strong> M-Pesa <strong>+243 840 808 122</strong> · Airtel <strong>0820 344 541</strong> · Orange <strong>0990 775 880</strong></p>
      ${cta(`${APP_URL}/dashboard`, "Payer et débloquer mon rendez-vous")}
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
      <p style="margin:0 0 4px;color:#16a34a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Visa obtenu</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Votre visa ${destLabel(args.destination)} est prêt ! 🎉</h2>
      ${urgentBanner("Réglez la prime de succès pour recevoir votre document officiel.")}
      <p style="color:#475569;font-size:15px;line-height:1.7;">Excellente nouvelle ! L'équipe Joventy a obtenu votre visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong>.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Pour télécharger votre document officiel, réglez la <strong>prime de succès de ${args.successFee}&nbsp;USD</strong>.</p>
      <p style="color:#64748b;font-size:13px;margin:16px 0 8px;"><strong>Paiements :</strong> M-Pesa <strong>+243 840 808 122</strong> · Airtel <strong>0820 344 541</strong> · Orange <strong>0990 775 880</strong></p>
      ${cta(`${APP_URL}/dashboard`, "Payer et télécharger mon visa")}
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
      <p style="margin:0 0 4px;color:#16a34a;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Dossier complété</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Félicitations, votre dossier est finalisé ! 🏆</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Votre dossier visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong> est <strong>entièrement complété</strong>. Vous pouvez maintenant télécharger votre kit complet depuis votre espace Joventy.</p>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Merci de nous avoir fait confiance. Nous vous souhaitons un excellent voyage !</p>
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
      <p style="margin:0 0 4px;color:#dc2626;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Dossier refusé</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Information concernant votre dossier</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Après examen, votre dossier de visa <strong>${destLabel(args.destination)}</strong> pour <strong>${args.applicantName}</strong> n'a pas pu être traité pour la raison suivante :</p>
      <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:14px 18px;margin:16px 0;border-radius:0 6px 6px 0;">
        <p style="margin:0;color:#991b1b;font-size:14px;">${escHtml(args.reason)}</p>
      </div>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Si vous pensez qu'il s'agit d'une erreur ou si vous souhaitez plus d'informations, contactez-nous via la messagerie de votre espace client.</p>
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Nouveau message</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">L'équipe Joventy vous a écrit</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">Vous avez reçu un nouveau message concernant votre dossier <strong>${destLabel(args.destination)}</strong> :</p>
      <div style="background:#f1f5f9;border-radius:8px;padding:16px 20px;margin:16px 0;">
        <p style="margin:0;color:#1e293b;font-size:14px;line-height:1.7;font-style:italic;">"${preview}"</p>
      </div>
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Message client</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Nouveau message d'un client</h2>
      <p style="color:#475569;font-size:15px;">De : <strong>${escHtml(args.senderName)}</strong> — Dossier : <strong>${escHtml(args.applicantName)}</strong> (${destLabel(args.destination)})</p>
      <div style="background:#f1f5f9;border-radius:8px;padding:16px 20px;margin:16px 0;">
        <p style="margin:0;color:#1e293b;font-size:14px;line-height:1.7;font-style:italic;">"${preview}"</p>
      </div>
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
      <p style="margin:0 0 4px;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Bienvenue sur Joventy</p>
      <h2 style="margin:0 0 16px;color:#1e293b;font-size:22px;">Bienvenue ${prenom} ! 🎉</h2>
      <p style="color:#475569;font-size:15px;line-height:1.7;">
        Votre compte Joventy est maintenant actif. Vous pouvez dès à présent déposer votre demande de visa et suivre l'avancement de votre dossier en temps réel.
      </p>
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px 20px;margin:20px 0;">
        <p style="margin:0;color:#1e3a5f;font-size:14px;line-height:1.7;">
          <strong>Ce que vous pouvez faire :</strong><br/>
          ✅ Déposer une demande de visa (USA, Dubaï, Turquie, Inde)<br/>
          ✅ Suivre votre dossier en temps réel<br/>
          ✅ Échanger directement avec notre équipe<br/>
          ✅ Recevoir une alerte dès qu'un créneau est trouvé
        </p>
      </div>
      <p style="color:#475569;font-size:14px;line-height:1.7;">
        En cas de question, notre équipe est disponible via la messagerie intégrée ou par WhatsApp au <strong>+243 840 808 122</strong>.
      </p>
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
