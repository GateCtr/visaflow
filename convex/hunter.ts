import { internalMutation, mutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { coreMarkSlotFound } from "./slotFoundHelper";
import { VISA_PRICING } from "./constants";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  return (identity.role as string) || "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}


export const setHunterConfig = mutation({
  args: {
    applicationId: v.id("applications"),
    embassyUsername: v.string(),
    embassyPassword: v.string(),
    isActive: v.boolean(),
    twoCaptchaApiKey: v.optional(v.string()),
    scheduleUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const existing = (app as { hunterConfig?: { checkCount?: number; lastCheckAt?: number; lastResult?: string; twoCaptchaApiKey?: string; scheduleUrl?: string } }).hunterConfig;

    await ctx.db.patch(args.applicationId, {
      hunterConfig: {
        embassyUsername: args.embassyUsername,
        embassyPassword: args.embassyPassword,
        isActive: args.isActive,
        twoCaptchaApiKey: args.twoCaptchaApiKey ?? existing?.twoCaptchaApiKey,
        scheduleUrl: args.scheduleUrl || existing?.scheduleUrl,
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
      .map((app) => {
        const pricing = app.destination ? VISA_PRICING[app.destination as keyof typeof VISA_PRICING] : undefined;
        return {
          id: app._id,
          destination: app.destination,
          visaType: app.visaType,
          applicantName: app.applicantName,
          travelDate: app.travelDate,
          urgencyTier: (app as { urgencyTier?: string }).urgencyTier ?? "standard",
          slotBookingRefs: (app as { slotBookingRefs?: unknown }).slotBookingRefs,
          hunterConfig: (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string } }).hunterConfig,
          portalUrl: (pricing as { portalUrl?: string } | undefined)?.portalUrl ?? null,
          portalName: (pricing as { portalName?: string } | undefined)?.portalName ?? null,
          portalDashboardUrl: (pricing as { portalDashboardUrl?: string } | undefined)?.portalDashboardUrl ?? null,
          portalAppointmentUrl: (pricing as { portalAppointmentUrl?: string } | undefined)?.portalAppointmentUrl ?? null,
          portalScheduleUrl: (pricing as { portalScheduleUrl?: string } | undefined)?.portalScheduleUrl ?? null,
        };
      });
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
    await coreMarkSlotFound(ctx, { ...args, logAuthor: "Joventy Hunter" });

    const app = await ctx.db.get(args.applicationId);
    const existing = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; checkCount?: number; lastCheckAt?: number; lastResult?: string; twoCaptchaApiKey?: string } } | null)?.hunterConfig;
    if (existing) {
      await ctx.db.patch(args.applicationId, {
        hunterConfig: {
          ...existing,
          isActive: false,
          lastResult: "slot_captured",
          lastCheckAt: Date.now(),
          checkCount: (existing.checkCount ?? 0) + 1,
        },
        updatedAt: Date.now(),
      });
    }

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
