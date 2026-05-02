import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const APP_URL = "https://joventy.cd";

function destLabel(destination: string): string {
  const map: Record<string, string> = {
    usa: "États-Unis 🇺🇸",
    schengen: "Schengen 🇪🇺",
    dubai: "Dubaï 🇦🇪",
    turkey: "Turquie 🇹🇷",
    india: "Inde 🇮🇳",
  };
  return map[destination] ?? destination;
}

function normalizePhone(raw: string): string {
  let p = raw.replace(/\s+/g, "").replace(/[-().]/g, "");
  if (!p.startsWith("+")) {
    if (p.startsWith("00")) p = "+" + p.slice(2);
    else if (p.startsWith("0")) p = "+243" + p.slice(1);
    else p = "+" + p;
  }
  return p;
}

async function sendViaTwilio(
  to: string,
  body: string,
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM ?? "whatsapp:+14155238886";

  if (!accountSid || !authToken) {
    console.warn("[WhatsApp] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN absents — message ignoré");
    return;
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params = new URLSearchParams({
    From: from,
    To: `whatsapp:${to}`,
    Body: body,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("[WhatsApp] Erreur Twilio", res.status, err);
    } else {
      const data = await res.json() as { sid?: string };
      console.log("[WhatsApp] ✅ Message envoyé —", data.sid);
    }
  } catch (e) {
    console.error("[WhatsApp] Exception fetch", e);
  }
}

export const sendSlotFoundWhatsApp = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    slotDate: v.string(),
    slotTime: v.string(),
    slotLocation: v.string(),
    successFee: v.number(),
    applicationId: v.string(),
  },
  handler: async (_ctx, args) => {
    const phone = normalizePhone(args.to);
    const dest = destLabel(args.destination);

    const body =
      `🎯 *Joventy — Créneau capturé !*\n\n` +
      `Bonjour *${args.applicantName}*,\n\n` +
      `Un créneau de rendez-vous a été réservé pour votre visa *${dest}* !\n\n` +
      `📅 Date : ${args.slotDate}\n` +
      `⏰ Heure : ${args.slotTime}\n` +
      `📍 Lieu : ${args.slotLocation}\n\n` +
      `⚠️ Vous avez *48 heures* pour régler la prime de succès (*${args.successFee} USD*) et confirmer votre rendez-vous.\n\n` +
      `👉 ${APP_URL}/dashboard/applications/${args.applicationId}\n\n` +
      `— L'équipe Joventy`;

    await sendViaTwilio(phone, body);
  },
});

export const sendStatusUpdateWhatsApp = internalAction({
  args: {
    to: v.string(),
    applicantName: v.string(),
    destination: v.string(),
    message: v.string(),
  },
  handler: async (_ctx, args) => {
    const phone = normalizePhone(args.to);
    const dest = destLabel(args.destination);

    const body =
      `📋 *Joventy — Mise à jour dossier*\n\n` +
      `Bonjour *${args.applicantName}* (${dest}),\n\n` +
      `${args.message}\n\n` +
      `👉 ${APP_URL}/dashboard\n\n` +
      `— L'équipe Joventy`;

    await sendViaTwilio(phone, body);
  },
});
