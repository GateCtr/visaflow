import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
