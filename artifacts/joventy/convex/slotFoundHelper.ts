import { GenericMutationCtx } from "convex/server";
import { DataModel, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { VISA_PRICING } from "./constants";

export function getEffectiveSuccessModel(app: { successModel?: string; destination?: string }): string {
  if (app.successModel) return app.successModel;
  const pricing = app.destination ? VISA_PRICING[app.destination as keyof typeof VISA_PRICING] : undefined;
  return pricing?.successModel ?? "appointment";
}

export async function coreMarkSlotFound(
  ctx: GenericMutationCtx<DataModel>,
  args: {
    applicationId: Id<"applications">;
    date: string;
    time: string;
    location: string;
    confirmationCode?: string;
    screenshotStorageId?: string;
    logAuthor?: string;
  }
): Promise<Id<"applications">> {
  const app = await ctx.db.get(args.applicationId);
  if (!app) throw new Error("Dossier introuvable");

  if (app.status !== "slot_hunting") {
    throw new Error("Le dossier doit être au statut 'slot_hunting' pour enregistrer un créneau.");
  }

  if (app.servicePackage === "dossier_only") {
    throw new Error("Ce dossier est en mode 'Constitution uniquement' — il n'a pas de créneau.");
  }

  const effectiveModel = getEffectiveSuccessModel(app);
  if (effectiveModel === "evisa") {
    throw new Error("Ce dossier utilise le modèle e-Visa — utilisez 'Visa Obtenu' plutôt que 'Créneau'.");
  }

  const priceDetails = app.priceDetails ?? {
    engagementFee: 0,
    successFee: 0,
    paidAmount: 0,
    isEngagementPaid: false,
    isSuccessFeePaid: false,
  };

  const SLOT_HOLD_HOURS = 48;
  const slotExpiresAt = Date.now() + SLOT_HOLD_HOURS * 3600 * 1000;
  const logAuthor = args.logAuthor ?? "admin";

  await ctx.db.patch(args.applicationId, {
    status: "slot_found_awaiting_success_fee",
    slotExpiresAt,
    appointmentDetails: {
      date: args.date,
      time: args.time,
      location: args.location,
      confirmationCode: args.confirmationCode,
      screenshotStorageId: args.screenshotStorageId,
    },
    priceDetails,
    logs: [
      ...(app.logs ?? []),
      {
        msg: `Créneau capturé ! Réglez la prime de succès (${priceDetails.successFee}$) pour débloquer le PDF de confirmation. Ce créneau est réservé pour ${SLOT_HOLD_HOURS}h.`,
        time: Date.now(),
        author: logAuthor,
      },
    ],
    updatedAt: Date.now(),
  });

  if (app.userEmail) {
    await ctx.scheduler.runAfter(0, internal.emails.sendSlotFoundClient, {
      to: app.userEmail,
      applicantName: app.applicantName,
      destination: app.destination,
      successFee: priceDetails.successFee,
      slotDate: args.date,
      applicationId: args.applicationId,
    });
  }

  if ((app as { userWhatsapp?: string }).userWhatsapp) {
    await ctx.scheduler.runAfter(0, internal.whatsapp.sendSlotFoundWhatsApp, {
      to: (app as { userWhatsapp?: string }).userWhatsapp!,
      applicantName: app.applicantName,
      destination: app.destination,
      slotDate: args.date,
      slotTime: args.time,
      slotLocation: args.location,
      successFee: priceDetails.successFee,
      applicationId: args.applicationId,
    });
  }

  await ctx.scheduler.runAfter(0, internal.notifications.create, {
    userId: app.userId,
    type: "slot_found",
    title: "🎯 Créneau capturé — Action requise !",
    body: `Un créneau ${app.destination.toUpperCase()} a été réservé ! Réglez la prime de succès (${priceDetails.successFee}$) dans les 48h pour confirmer votre rendez-vous.`,
    applicationId: args.applicationId,
  });

  return args.applicationId;
}
