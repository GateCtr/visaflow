import { internalMutation, mutation, internalQuery } from "./_generated/server";
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
  return { msg, time: Date.now(), author: author ?? "hunter" };
}

export const setHunterConfig = mutation({
  args: {
    applicationId: v.id("applications"),
    embassyUsername: v.string(),
    embassyPassword: v.string(),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const existing = (app as { hunterConfig?: { checkCount?: number; lastCheckAt?: number; lastResult?: string } }).hunterConfig;

    await ctx.db.patch(args.applicationId, {
      hunterConfig: {
        embassyUsername: args.embassyUsername,
        embassyPassword: args.embassyPassword,
        isActive: args.isActive,
        lastCheckAt: existing?.lastCheckAt,
        checkCount: existing?.checkCount ?? 0,
        lastResult: existing?.lastResult,
      },
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

export const resetHunterConfig = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      hunterConfig: undefined,
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

export const getActiveJobs = internalQuery({
  handler: async (ctx) => {
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_status", (q) => q.eq("status", "slot_hunting"))
      .collect();

    return apps
      .filter((app) => {
        const hc = (app as { hunterConfig?: { isActive?: boolean } }).hunterConfig;
        return hc?.isActive === true;
      })
      .map((app) => ({
        id: app._id,
        destination: app.destination,
        visaType: app.visaType,
        applicantName: app.applicantName,
        travelDate: app.travelDate,
        slotBookingRefs: (app as { slotBookingRefs?: unknown }).slotBookingRefs,
        hunterConfig: (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string } }).hunterConfig,
      }));
  },
});

export const markSlotFoundByHunter = internalMutation({
  args: {
    applicationId: v.id("applications"),
    date: v.string(),
    time: v.string(),
    location: v.string(),
    confirmationCode: v.optional(v.string()),
    screenshotStorageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    if (app.status !== "slot_hunting") {
      throw new Error("Le dossier n'est plus en recherche de créneau");
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

    const existing = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; checkCount?: number; lastCheckAt?: number; lastResult?: string } }).hunterConfig;

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
      hunterConfig: existing ? {
        ...existing,
        isActive: false,
        lastResult: "slot_captured",
        lastCheckAt: Date.now(),
        checkCount: (existing.checkCount ?? 0) + 1,
      } : undefined,
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `Créneau capturé par le robot Joventy Hunter ! Date : ${args.date} à ${args.time} (${args.location}). Prime de succès (${priceDetails.successFee}$) à régler pour débloquer la confirmation. Réservé pour ${SLOT_HOLD_HOURS}h.`,
          "Joventy Hunter"
        ),
      ],
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

export const recordHeartbeat = internalMutation({
  args: {
    applicationId: v.id("applications"),
    result: v.union(v.literal("not_found"), v.literal("captcha"), v.literal("error")),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;

    const existing = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; checkCount?: number; lastCheckAt?: number; lastResult?: string } }).hunterConfig;
    if (!existing) return;

    await ctx.db.patch(args.applicationId, {
      hunterConfig: {
        ...existing,
        lastCheckAt: Date.now(),
        checkCount: (existing.checkCount ?? 0) + 1,
        lastResult: args.result,
      },
      updatedAt: Date.now(),
    });
  },
});
