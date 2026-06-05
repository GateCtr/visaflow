import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const CONTRACT_VERSION = "v1.1-2025";

export function getClerkId(subject: string): string {
  if (subject.includes("|")) {
    return subject.split("|").pop()!;
  }
  return subject;
}

export async function findSignature(ctx: any, clerkId: string) {
  const variations = [
    clerkId,
    `https://clerk.joventy.cd|${clerkId}`,
    `https://active-midge-3.clerk.accounts.dev|${clerkId}`,
  ];
  for (const v of variations) {
    const sig = await ctx.db
      .query("contractSignatures")
      .withIndex("by_user_version", (q: any) =>
        q.eq("userId", v).eq("contractVersion", CONTRACT_VERSION)
      )
      .first();
    if (sig) return sig;
  }
  return null;
}

export const hasSignedContract = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return false;
    const clerkId = getClerkId(identity.subject);
    const sig = await findSignature(ctx, clerkId);
    return sig !== null;
  },
});

export const getContractSignature = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const clerkId = getClerkId(identity.subject);
    return findSignature(ctx, clerkId);
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
