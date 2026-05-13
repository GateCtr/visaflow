import { mutation, query, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import { Doc } from "./_generated/dataModel";

export const add = mutation({
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

/** Supprime tous les logs bot (global). */
export const clearAll = mutation({
  args: {},
  handler: async (ctx) => {
    const logs = await ctx.db
      .query("botLogs")
      .withIndex("by_ts")
      .order("desc")
      .collect();
    for (const log of logs) {
      await ctx.db.delete(log._id);
    }
    return { deleted: logs.length };
  },
});
