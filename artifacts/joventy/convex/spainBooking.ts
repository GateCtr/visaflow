import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "guest";
  const roles: unknown = identity["https://joventy.cd/roles"] ?? identity.role;
  if (Array.isArray(roles)) return roles[0] ?? "guest";
  if (typeof roles === "string") return roles;
  return "guest";
}

// ─── Mutation interne ─────────────────────────────────────────────────────────

/**
 * Insère un log de tentative de booking Bookitit et planifie l'email admin
 * correspondant (attempted / booked / failed).
 * Appelé depuis la route HTTP /hunter/spain-booking-log.
 */
export const recordBookingLog = internalMutation({
  args: {
    applicationId: v.string(),
    dossierId: v.string(),
    applicantName: v.string(),
    date: v.string(),
    time: v.string(),
    status: v.union(v.literal("attempted"), v.literal("booked"), v.literal("failed")),
    reason: v.optional(v.string()),
    locator: v.optional(v.string()),
    serviceName: v.optional(v.string()),
    attemptedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("spainBookingLogs", {
      applicationId: args.applicationId as Id<"applications">,
      dossierId: args.dossierId,
      applicantName: args.applicantName,
      date: args.date,
      time: args.time,
      status: args.status,
      reason: args.reason,
      locator: args.locator,
      serviceName: args.serviceName,
      attemptedAt: args.attemptedAt,
    });

    if (args.status === "attempted") {
      await ctx.scheduler.runAfter(0, internal.emails.sendSpainBookingAttemptAdmin, {
        applicantName: args.applicantName,
        date: args.date,
        time: args.time,
        serviceName: args.serviceName ?? "",
        applicationId: args.applicationId,
      });
    } else if (args.status === "booked") {
      await ctx.scheduler.runAfter(0, internal.emails.sendSpainBookingSuccessAdmin, {
        applicantName: args.applicantName,
        date: args.date,
        time: args.time,
        locator: args.locator ?? "",
        serviceName: args.serviceName ?? "",
        applicationId: args.applicationId,
      });
    } else if (args.status === "failed") {
      await ctx.scheduler.runAfter(0, internal.emails.sendSpainBookingFailedAdmin, {
        applicantName: args.applicantName,
        date: args.date,
        time: args.time,
        reason: args.reason ?? "Raison inconnue",
        serviceName: args.serviceName ?? "",
        applicationId: args.applicationId,
      });
    }
  },
});

// ─── Query publique (admin) ───────────────────────────────────────────────────

/**
 * Retourne les 200 derniers logs de tentatives de booking (30 jours).
 * Utilisé par la page Calendrier pour l'onglet "Bookings".
 */
export const getRecentBookingLogs = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const logs = await ctx.db
      .query("spainBookingLogs")
      .withIndex("by_attemptedAt")
      .filter((q) => q.gte(q.field("attemptedAt"), since))
      .order("desc")
      .take(200);

    return logs;
  },
});
