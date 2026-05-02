import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

const H = 3_600_000;

// ── Mutation interne : envoyer les relances dues ──────────────────────────────
export const sendDueReminders = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("applications").collect();

    for (const app of all) {
      // ── 1. Relances frais d'engagement (dossier créé mais non payé) ──────────
      if (app.status === "awaiting_engagement_payment" && app.userEmail) {
        const ageMs = now - app._creationTime;
        const ageHours = ageMs / H;
        const sent = app.remindersSent ?? [];

        // Relance 1 : après 24h
        if (ageHours >= 24 && !sent.includes("engagement_24h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendPaymentReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            visaType: app.visaType,
            engagementFee: app.priceDetails?.engagementFee ?? (app.price ?? 0),
            applicationId: app._id,
            hoursElapsed: Math.round(ageHours),
            reminderNumber: 1,
          });
          await ctx.db.patch(app._id, {
            remindersSent: [...sent, "engagement_24h"],
          });
          console.log(`[Cron] Relance engagement_24h → ${app._id} (${app.applicantName})`);
        }

        // Relance 2 : après 48h
        if (ageHours >= 48 && !sent.includes("engagement_48h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendPaymentReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            visaType: app.visaType,
            engagementFee: app.priceDetails?.engagementFee ?? (app.price ?? 0),
            applicationId: app._id,
            hoursElapsed: Math.round(ageHours),
            reminderNumber: 2,
          });
          await ctx.db.patch(app._id, {
            remindersSent: [...(app.remindersSent ?? []), "engagement_48h"],
          });
          console.log(`[Cron] Relance engagement_48h → ${app._id} (${app.applicantName})`);
        }
      }

      // ── 2. Relances prime de succès (créneau trouvé mais prime non payée) ───
      if (
        app.status === "slot_found_awaiting_success_fee" &&
        app.userEmail &&
        app.slotExpiresAt &&
        app.appointmentDetails?.date
      ) {
        const slotFoundAt = app.updatedAt; // updatedAt = moment où le créneau a été enregistré
        const ageMs = now - slotFoundAt;
        const ageHours = ageMs / H;
        const sent = app.remindersSent ?? [];

        // Relance 1 : après 6h
        if (ageHours >= 6 && !sent.includes("slot_6h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendSuccessFeeReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            slotDate: app.appointmentDetails.date,
            slotTime: app.appointmentDetails.time,
            slotLocation: app.appointmentDetails.location,
            successFee: app.priceDetails?.successFee ?? 0,
            applicationId: app._id,
            hoursElapsed: Math.round(ageHours),
            slotExpiresAt: app.slotExpiresAt,
            reminderNumber: 1,
          });
          await ctx.db.patch(app._id, {
            remindersSent: [...sent, "slot_6h"],
          });
          console.log(`[Cron] Relance slot_6h → ${app._id} (${app.applicantName})`);
        }

        // Relance 2 : après 24h (urgente)
        if (ageHours >= 24 && !sent.includes("slot_24h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendSuccessFeeReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            slotDate: app.appointmentDetails.date,
            slotTime: app.appointmentDetails.time,
            slotLocation: app.appointmentDetails.location,
            successFee: app.priceDetails?.successFee ?? 0,
            applicationId: app._id,
            hoursElapsed: Math.round(ageHours),
            slotExpiresAt: app.slotExpiresAt,
            reminderNumber: 2,
          });
          await ctx.db.patch(app._id, {
            remindersSent: [...(app.remindersSent ?? []), "slot_24h"],
          });
          console.log(`[Cron] Relance slot_24h → ${app._id} (${app.applicantName})`);
        }

        // Relance 3 : à 36h (dernière chance, 12h avant expiration)
        if (ageHours >= 36 && !sent.includes("slot_36h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendSuccessFeeReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            slotDate: app.appointmentDetails.date,
            slotTime: app.appointmentDetails.time,
            slotLocation: app.appointmentDetails.location,
            successFee: app.priceDetails?.successFee ?? 0,
            applicationId: app._id,
            hoursElapsed: Math.round(ageHours),
            slotExpiresAt: app.slotExpiresAt,
            reminderNumber: 3,
          });
          await ctx.db.patch(app._id, {
            remindersSent: [...(app.remindersSent ?? []), "slot_36h"],
          });
          console.log(`[Cron] Relance slot_36h → ${app._id} (${app.applicantName})`);
        }
      }
    }
  },
});

// ── Planification : toutes les heures ─────────────────────────────────────────
const crons = cronJobs();
crons.hourly("send-due-reminders", { minuteUTC: 15 }, internal.crons.sendDueReminders);

export default crons;
