import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const CONTRACT_VERSION = "v1.0-2025";

export const hasSignedContract = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const userId = identity.subject;
    const sig = await ctx.db
      .query("contractSignatures")
      .withIndex("by_user_version", (q) =>
        q.eq("userId", userId).eq("contractVersion", CONTRACT_VERSION)
      )
      .first();
    return sig !== null;
  },
});

export const getContractSignature = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const userId = identity.subject;
    return ctx.db
      .query("contractSignatures")
      .withIndex("by_user_version", (q) =>
        q.eq("userId", userId).eq("contractVersion", CONTRACT_VERSION)
      )
      .first();
  },
});

export const signContract = mutation({
  args: {
    signedName: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const userId = identity.subject;

    const existing = await ctx.db
      .query("contractSignatures")
      .withIndex("by_user_version", (q) =>
        q.eq("userId", userId).eq("contractVersion", CONTRACT_VERSION)
      )
      .first();

    if (existing) return existing._id;

    return ctx.db.insert("contractSignatures", {
      userId,
      signedName: args.signedName.trim(),
      contractVersion: CONTRACT_VERSION,
      signedAt: Date.now(),
      userAgent: args.userAgent,
    });
  },
});
