import { cronJobs } from "convex/server";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { CONTRACT_VERSION } from "./contracts";

const H = 3_600_000;
const D = 24 * H;

// ── Mutation interne : envoyer les relances dues ──────────────────────────────
export const sendDueReminders = internalMutation({
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("applications").collect();

    for (const app of all) {
      if (!app.userEmail) continue;
      const sent = app.remindersSent ?? [];

      // ── 1. Relances frais d'engagement (dossier créé mais non payé) ──────────
      if (app.status === "awaiting_engagement_payment") {
        const ageHours = (now - app._creationTime) / H;

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
          await ctx.db.patch(app._id, { remindersSent: [...sent, "engagement_24h"] });
          console.log(`[Cron] engagement_24h → ${app._id}`);
        }

        // Relance 2 : après 48h (urgente)
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
          await ctx.db.patch(app._id, { remindersSent: [...(app.remindersSent ?? []), "engagement_48h"] });
          console.log(`[Cron] engagement_48h → ${app._id}`);
        }
      }

      // ── 2. Relances documents en attente ──────────────────────────────────────
      if (app.status === "documents_pending") {
        // updatedAt = moment où l'engagement a été validé (statut changé)
        const ageHours = (now - app.updatedAt) / H;

        // Relance 1 : après 48h
        if (ageHours >= 48 && !sent.includes("docs_48h")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendDocumentsPendingReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            applicationId: app._id,
            daysElapsed: Math.round(ageHours / 24),
            reminderNumber: 1,
          });
          await ctx.db.patch(app._id, { remindersSent: [...sent, "docs_48h"] });
          console.log(`[Cron] docs_48h → ${app._id}`);
        }

        // Relance 2 : après 5 jours (urgente)
        if (ageHours >= 120 && !sent.includes("docs_5d")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendDocumentsPendingReminderClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            applicationId: app._id,
            daysElapsed: Math.round(ageHours / 24),
            reminderNumber: 2,
          });
          await ctx.db.patch(app._id, { remindersSent: [...(app.remindersSent ?? []), "docs_5d"] });
          console.log(`[Cron] docs_5d → ${app._id}`);
        }
      }

      // ── 3. Mise à jour dossier en traitement (in_review) ─────────────────────
      if (app.status === "in_review") {
        const ageDays = (now - app.updatedAt) / D;

        // Point de situation à J+3
        if (ageDays >= 3 && !sent.includes("review_3d")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendInReviewUpdateClient, {
            to: app.userEmail,
            applicantName: app.applicantName,
            destination: app.destination,
            applicationId: app._id,
            daysElapsed: Math.round(ageDays),
          });
          await ctx.db.patch(app._id, { remindersSent: [...sent, "review_3d"] });
          console.log(`[Cron] review_3d → ${app._id}`);
        }
      }

      // ── 4. Points de situation pendant la chasse (slot_hunting) ──────────────
      if (app.status === "slot_hunting") {
        const ageDays = (now - app.updatedAt) / D;

        const weekChecks: Array<{ days: number; key: string; week: number }> = [
          { days: 7,  key: "hunt_w1", week: 1 },
          { days: 14, key: "hunt_w2", week: 2 },
          { days: 21, key: "hunt_w3", week: 3 },
          { days: 28, key: "hunt_w4", week: 4 },
        ];

        for (const wc of weekChecks) {
          if (ageDays >= wc.days && !sent.includes(wc.key)) {
            await ctx.scheduler.runAfter(0, internal.emails.sendSlotHuntingUpdateClient, {
              to: app.userEmail,
              applicantName: app.applicantName,
              destination: app.destination,
              applicationId: app._id,
              daysHunting: Math.round(ageDays),
              weekNumber: wc.week,
            });
            await ctx.db.patch(app._id, { remindersSent: [...(app.remindersSent ?? []), wc.key] });
            console.log(`[Cron] ${wc.key} → ${app._id}`);
            break; // une seule relance par passage de cron
          }
        }
      }

      // ── 5. Relances prime de succès (créneau trouvé mais prime non payée) ────
      if (
        app.status === "slot_found_awaiting_success_fee" &&
        app.slotExpiresAt &&
        app.appointmentDetails?.date
      ) {
        const ageHours = (now - app.updatedAt) / H;

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
          await ctx.db.patch(app._id, { remindersSent: [...sent, "slot_6h"] });
          console.log(`[Cron] slot_6h → ${app._id}`);
        }

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
          await ctx.db.patch(app._id, { remindersSent: [...(app.remindersSent ?? []), "slot_24h"] });
          console.log(`[Cron] slot_24h → ${app._id}`);
        }

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
          await ctx.db.patch(app._id, { remindersSent: [...(app.remindersSent ?? []), "slot_36h"] });
          console.log(`[Cron] slot_36h → ${app._id}`);
        }
      }
    }

    // ── 6. Relances contrat non signé + re-engagement sans dossier ───────────
    const allUsers = await ctx.db.query("users").collect();
    for (const user of allUsers) {
      if (!user.email || user.role === "admin") continue;
      const ageDays = (now - user.createdAt) / D;
      const userSent = user.remindersSent ?? [];

      // ── 6a. Relances contrat non signé ──────────────────────────────────────
      // Cherche une signature pour le contrat courant (le userId peut avoir
      // plusieurs formats selon la méthode de connexion).
      const sigVariants = [
        user.clerkId,
        `https://clerk.joventy.cd|${user.clerkId}`,
        `https://active-midge-3.clerk.accounts.dev|${user.clerkId}`,
      ];
      let hasSigned = false;
      for (const variant of sigVariants) {
        const sig = await ctx.db
          .query("contractSignatures")
          .withIndex("by_user_version", (q) =>
            q.eq("userId", variant).eq("contractVersion", CONTRACT_VERSION)
          )
          .first();
        if (sig) { hasSigned = true; break; }
      }

      if (!hasSigned) {
        // Relance 1 : J+3
        if (ageDays >= 3 && !userSent.includes("contract_3d")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendContractReminderClient, {
            to: user.email,
            firstName: user.firstName,
            daysSinceSignup: Math.round(ageDays),
            reminderNumber: 1,
          });
          const next = [...userSent, "contract_3d"];
          await ctx.db.patch(user._id, { remindersSent: next });
          userSent.push("contract_3d");
          console.log(`[Cron] contract_3d → user ${user._id} (${user.email})`);
        }

        // Relance 2 : J+7 (urgente)
        if (ageDays >= 7 && !userSent.includes("contract_7d")) {
          await ctx.scheduler.runAfter(0, internal.emails.sendContractReminderClient, {
            to: user.email,
            firstName: user.firstName,
            daysSinceSignup: Math.round(ageDays),
            reminderNumber: 2,
          });
          await ctx.db.patch(user._id, { remindersSent: [...userSent, "contract_7d"] });
          userSent.push("contract_7d");
          console.log(`[Cron] contract_7d → user ${user._id} (${user.email})`);
        }
      }

      // ── 6b. Re-engagement utilisateurs sans aucun dossier ───────────────────
      if (ageDays < 3) continue;
      if (userSent.includes("no_app_3d")) continue;

      const firstApp = await ctx.db
        .query("applications")
        .withIndex("by_user", (q) => q.eq("userId", user.clerkId))
        .first();

      if (firstApp !== null) continue; // a déjà un dossier

      await ctx.scheduler.runAfter(0, internal.emails.sendReEngagementNoApplicationClient, {
        to: user.email,
        firstName: user.firstName,
        daysSinceSignup: Math.round(ageDays),
      });
      await ctx.db.patch(user._id, { remindersSent: [...userSent, "no_app_3d"] });
      console.log(`[Cron] no_app_3d → user ${user._id} (${user.email})`);
    }
  },
});

// ── Planification : toutes les heures (à :15) ─────────────────────────────────
const crons = cronJobs();
crons.hourly("send-due-reminders", { minuteUTC: 15 }, internal.crons.sendDueReminders);

export default crons;
