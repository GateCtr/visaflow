import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  return (identity.role as string) || "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}

function makeLog(msg: string, author?: string) {
  return { msg, time: Date.now(), author: author ?? "admin" };
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

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.status !== "slot_hunting") {
      throw new Error("Le dossier doit être au statut 'slot_hunting' pour enregistrer un créneau.");
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

    await ctx.db.patch(args.applicationId, {
      status: "slot_found_awaiting_success_fee",
      slotExpiresAt,
      appointmentDetails: {
        date: args.date,
        time: args.time,
        location: args.location,
        confirmationCode: args.confirmationCode,
      },
      priceDetails,
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `🎉 Créneau consulaire capturé avec succès ! Réglez la prime de succès (${priceDetails.successFee}$) pour débloquer les détails du rendez-vous. Ce créneau est réservé pour ${SLOT_HOLD_HOURS}h.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    return args.applicationId;
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
