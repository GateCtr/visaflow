import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { VISA_PRICING } from "./constants";
import { coreMarkSlotFound, getEffectiveSuccessModel as getSuccessModel } from "./slotFoundHelper";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  // Direct claim from JWT template: "role": "{{user.public_metadata.role}}"
  if (identity.role) return identity.role as string;
  // Nested publicMetadata object in JWT: "publicMetadata": "{{user.public_metadata}}"
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  return "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}

function makeLog(msg: string, author?: string) {
  return { msg, time: Date.now(), author: author ?? "admin" };
}

function getEffectiveSuccessModel(app: { successModel?: string; destination?: string }): string {
  return getSuccessModel(app);
}

export const getStats = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      return null;
    }

    const all = await ctx.db.query("applications").collect();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const uniqueUserIds = new Set(all.map((a) => a.userId));

    const byDestination = all.reduce(
      (acc, a) => {
        acc[a.destination] = (acc[a.destination] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const recentApplications = [...all]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map((a) => ({
        _id: a._id,
        applicantName: a.applicantName,
        destination: a.destination,
        visaType: a.visaType,
        status: a.status,
        updatedAt: a.updatedAt,
        priceDetails: a.priceDetails,
      }));

    const totalRevenue = all.reduce((sum, a) => {
      return sum + (a.priceDetails?.paidAmount ?? 0);
    }, 0);

    const pendingPaymentValidation = all.filter(
      (a) =>
        (a.paymentProofUrl && !a.priceDetails?.isEngagementPaid) ||
        (a.successFeeProofUrl && !a.priceDetails?.isSuccessFeePaid)
    ).length;

    return {
      totalApplications: all.length,
      pendingReview: all.filter((a) => a.status === "in_review").length,
      approvedThisMonth: all.filter(
        (a) => a.status === "completed" && a.updatedAt >= startOfMonth
      ).length,
      totalClients: uniqueUserIds.size,
      byDestination,
      recentApplications,
      totalRevenue,
      pendingPaymentValidation,
      slotHunting: all.filter((a) => a.status === "slot_hunting").length,
    };
  },
});

export const listClients = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      return [];
    }

    const all = await ctx.db.query("applications").collect();

    const clientMap = new Map<
      string,
      {
        userId: string;
        firstName: string;
        lastName: string;
        email: string;
        applicationCount: number;
        firstSeen: number;
      }
    >();

    for (const app of all) {
      if (!clientMap.has(app.userId)) {
        clientMap.set(app.userId, {
          userId: app.userId,
          firstName: app.userFirstName || "",
          lastName: app.userLastName || "",
          email: app.userEmail || "",
          applicationCount: 1,
          firstSeen: app._creationTime,
        });
      } else {
        const existing = clientMap.get(app.userId)!;
        existing.applicationCount += 1;
        if (app._creationTime < existing.firstSeen) {
          existing.firstSeen = app._creationTime;
        }
      }
    }

    return Array.from(clientMap.values()).sort(
      (a, b) => a.firstSeen - b.firstSeen
    );
  },
});

export const validateEngagementPayment = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    if (priceDetails.isEngagementPaid) {
      throw new Error("Les frais d'engagement ont déjà été validés pour ce dossier.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "documents_pending",
      priceDetails: {
        ...priceDetails,
        isEngagementPaid: true,
        paidAmount: priceDetails.paidAmount + priceDetails.engagementFee,
      },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `✅ Frais d'engagement (${priceDetails.engagementFee}$) validés. Dossier activé — envoi des documents requis.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendEngagementValidatedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const markSlotFound = mutation({
  args: {
    applicationId: v.id("applications"),
    date: v.string(),
    time: v.string(),
    location: v.string(),
    confirmationCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);
    return await coreMarkSlotFound(ctx, { ...args, logAuthor: "admin" });
  },
});

export const markVisaObtained = mutation({
  args: {
    applicationId: v.id("applications"),
    storageId: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.status !== "slot_hunting") {
      throw new Error("Le dossier doit être au statut 'slot_hunting' pour enregistrer un visa obtenu.");
    }

    if (app.servicePackage === "dossier_only") {
      throw new Error("Ce dossier est en mode 'Constitution uniquement' — il n'a pas de visa e-Visa.");
    }

    const effectiveModel = getEffectiveSuccessModel(app);
    if (effectiveModel !== "evisa") {
      throw new Error("Ce dossier utilise le modèle rendez-vous — utilisez 'Créneau' plutôt que 'Visa Obtenu'.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    await ctx.db.patch(args.applicationId, {
      status: "slot_found_awaiting_success_fee",
      visaDocumentStorageId: args.storageId,
      priceDetails,
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `🎉 Visa obtenu ! Réglez la prime de succès (${priceDetails.successFee}$) pour recevoir votre document officiel.${args.notes ? ` Note : ${args.notes}` : ""}`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendVisaObtainedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        successFee: priceDetails.successFee,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const getVisaDocumentUrl = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const app = await ctx.db.get(args.applicationId);
    if (!app) return null;

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";

    if (!isAdmin) {
      if (app.userId !== identity.subject) return null;
      const successFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
      if (!successFeePaid) return null;
    }

    if (!app.visaDocumentStorageId) return null;

    return await ctx.storage.getUrl(app.visaDocumentStorageId as import("./_generated/dataModel").Id<"_storage">);
  },
});

export const validateSuccessFee = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.status !== "slot_found_awaiting_success_fee") {
      throw new Error("Le dossier doit être au statut 'slot_found_awaiting_success_fee' pour valider la prime de succès.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    if (priceDetails.isSuccessFeePaid) {
      throw new Error("La prime de succès a déjà été validée pour ce dossier.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "completed",
      isPaid: true,
      priceDetails: {
        ...priceDetails,
        isSuccessFeePaid: true,
        paidAmount: priceDetails.paidAmount + priceDetails.successFee,
      },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `✅ Prime de succès (${priceDetails.successFee}$) validée. Dossier complété — le client peut télécharger son kit d'entretien.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendDossierCompletedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const rejectApplication = mutation({
  args: {
    applicationId: v.id("applications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      status: "rejected",
      rejectionReason: args.reason,
      logs: [
        ...(app.logs ?? []),
        makeLog(`❌ Dossier rejeté. Raison : ${args.reason}`, "admin"),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendApplicationRejectedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        reason: args.reason,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const setSlotHunting = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.servicePackage === "dossier_only") {
      throw new Error("Ce dossier est en mode 'Constitution uniquement' — utilisez 'Marquer dossier complété' à la place.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "slot_hunting",
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `🔍 Surveillance des créneaux activée. Notre système vérifie les disponibilités de l'ambassade en continu.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendSlotHuntingStartedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const completeDossierOnly = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.servicePackage !== "dossier_only") {
      throw new Error("Cette action est réservée aux dossiers 'Constitution uniquement'.");
    }

    if (app.status === "completed") {
      throw new Error("Ce dossier est déjà complété.");
    }

    if (!app.priceDetails?.isEngagementPaid) {
      throw new Error("Les frais d'engagement doivent être validés avant de compléter le dossier.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: true,
    };

    await ctx.db.patch(args.applicationId, {
      status: "completed",
      isPaid: true,
      priceDetails: { ...priceDetails, isSuccessFeePaid: true },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          "✅ Dossier constitué et validé par Joventy. Le client peut télécharger l'ensemble des documents du dossier.",
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendDossierCompletedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    return args.applicationId;
  },
});

export const setInReview = mutation({
  args: {
    applicationId: v.id("applications"),
    adminNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const patch: Record<string, unknown> = {
      status: "in_review",
      updatedAt: Date.now(),
      logs: [
        ...(app.logs ?? []),
        makeLog("📋 Dossier pris en charge — examen en cours par l'équipe Joventy.", "admin"),
      ],
    };
    if (args.adminNotes) patch.adminNotes = args.adminNotes;

    await ctx.db.patch(args.applicationId, patch);
    return args.applicationId;
  },
});

export const adjustSlotSuccessFee = mutation({
  args: {
    applicationId: v.id("applications"),
    newSuccessFee: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    if (args.newSuccessFee < 0) throw new Error("La prime ne peut pas être négative");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    if ((app as { servicePackage?: string }).servicePackage !== "slot_only") {
      throw new Error("Ajustement uniquement disponible pour les dossiers Créneau Uniquement");
    }
    if (app.priceDetails?.isSuccessFeePaid) {
      throw new Error("La prime de succès a déjà été réglée — ajustement impossible");
    }

    const prevFee = app.priceDetails?.successFee ?? 0;
    const engagementFee = app.priceDetails?.engagementFee ?? 0;

    await ctx.db.patch(args.applicationId, {
      priceDetails: {
        ...(app.priceDetails ?? {
          engagementFee,
          successFee: prevFee,
          paidAmount: 0,
          isEngagementPaid: false,
          isSuccessFeePaid: false,
        }),
        successFee: args.newSuccessFee,
      },
      price: engagementFee + args.newSuccessFee,
      updatedAt: Date.now(),
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `Prime de succès ajustée : ${prevFee} $ → ${args.newSuccessFee} $${args.reason ? ` (${args.reason})` : ""}.`,
          identity?.name ?? "admin"
        ),
      ],
    });

    return args.applicationId;
  },
});

export const saveAdminNotes = mutation({
  args: {
    applicationId: v.id("applications"),
    adminNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      adminNotes: args.adminNotes,
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});
