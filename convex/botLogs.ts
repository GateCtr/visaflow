import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

export const add = internalMutation({
  args: {
    applicationId: v.id("applications"),
    step: v.string(),
    status: v.union(v.literal("ok"), v.literal("warn"), v.literal("fail")),
    data: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("botLogs", {
      applicationId: args.applicationId,
      ts: Date.now(),
      step: args.step,
      status: args.status,
      data: args.data,
    });
  },
});

export const listByApplication = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("botLogs")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", args.applicationId)
      )
      .order("desc")
      .take(1000);
  },
});

export const listRecent = query({
  args: {
    limit: v.optional(v.number()),
    statusFilter: v.optional(v.string()),
    stepFilter: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<(Doc<"botLogs"> & { appFirstName?: string; appLastName?: string; appDestination?: string })[]> => {
    const limit = Math.min(args.limit ?? 200, 500);
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .order("desc")
      .take(limit * 3);

    const filtered = logs.filter(l => {
      if (args.statusFilter && l.status !== args.statusFilter) return false;
      if (args.stepFilter && !l.step.toLowerCase().includes(args.stepFilter.toLowerCase())) return false;
      return true;
    }).slice(0, limit);

    const appIds = [...new Set(filtered.map(l => l.applicationId))];
    const apps = await Promise.all(appIds.map(id => ctx.db.get(id)));
    const appMap = new Map(apps.filter(Boolean).map(a => [a!._id, a!]));

    return filtered.map(l => {
      const app = appMap.get(l.applicationId);
      return {
        ...l,
        appFirstName: app?.applicantName?.split(" ")[0] ?? app?.userFirstName,
        appLastName: app?.applicantName?.split(" ").slice(1).join(" ") ?? app?.userLastName,
        appDestination: app?.destination,
      };
    });
  },
});

export const countRecentFails = query({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts", (q) => q.gte("ts", args.since))
      .order("desc")
      .take(500);
    return logs.filter((l) => l.status === "fail").length;
  },
});

/** Supprime tous les logs d'une application spécifique. */
export const clearByApplication = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_application", (q) =>
        q.eq("applicationId", args.applicationId)
      )
      .collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    return { deleted: logs.length };
  },
});

/**
 * Supprime les logs bot par batch (max 500 par appel pour éviter les timeouts Convex).
 * Retourne { deleted, remaining } — si remaining > 0, le frontend doit rappeler.
 */
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    // Prendre un batch de 500 max pour rester dans les limites de temps Convex
    const BATCH_SIZE = 500;
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .order("desc")
      .take(BATCH_SIZE);

    for (const log of logs) {
      await ctx.db.delete(log._id);
    }

    // Vérifier s'il reste des logs (peek 1)
    const remaining = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .take(1);

    return { deleted: logs.length, remaining: remaining.length > 0 };
  },
});


/**
 * Supprime les logs bot filtrés par "flow" (usa, cev, ou autre).
 * Le flow est déterminé par le préfixe du step ou le champ flow dans data.
 * Retourne { deleted, remaining } pour pagination batch.
 */
export const clearByFlow = mutation({
  args: { flow: v.union(v.literal("usa"), v.literal("cev"), v.literal("other")) },
  handler: async (ctx, args) => {
    const BATCH_SIZE = 500;
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .order("desc")
      .take(BATCH_SIZE * 2); // Take more to filter

    const isUsaStep = (step: string) =>
      !step.startsWith("cev_") && !step.startsWith("cev ") &&
      (step.startsWith("usa_") || ["login", "session_start", "session_end", "appointment_status", "payment_check", "ofc_list", "scan", "scan_cutoff", "cooldown", "slots_found", "booking_attempt", "booking_success", "booking_fail", "confirmation_letter", "not_found", "error", "human_behavior", "anti_detection", "execution_time", "rate_limit", "blocked", "restricted", "token_expired", "restriction_skip", "keep_alive", "proxy_preflight_abort", "proxy_health_check", "409_retry_start", "409_retry_exhausted", "409_retry_success"].includes(step));

    const isCevStep = (step: string) => step.startsWith("cev_") || step.startsWith("cev ");

    const toDelete = logs.filter(log => {
      if (args.flow === "usa") return isUsaStep(log.step);
      if (args.flow === "cev") return isCevStep(log.step);
      // "other" = neither usa nor cev
      return !isUsaStep(log.step) && !isCevStep(log.step);
    }).slice(0, BATCH_SIZE);

    for (const log of toDelete) {
      await ctx.db.delete(log._id);
    }

    // Check if there are more of this flow to delete
    const remainingLogs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .order("desc")
      .take(10);
    const remainingOfFlow = remainingLogs.some(log => {
      if (args.flow === "usa") return isUsaStep(log.step);
      if (args.flow === "cev") return isCevStep(log.step);
      return !isUsaStep(log.step) && !isCevStep(log.step);
    });

    return { deleted: toDelete.length, remaining: remainingOfFlow };
  },
});
