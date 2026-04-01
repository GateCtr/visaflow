import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const submit = mutation({
  args: {
    applicationId: v.id("applications"),
    displayName: v.string(),
    city: v.string(),
    destination: v.string(),
    rating: v.number(),
    comment: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    if (app.userId !== identity.subject) throw new Error("Accès refusé");

    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .unique();
    if (existing) throw new Error("Vous avez déjà laissé un avis pour ce dossier");

    if (args.rating < 1 || args.rating > 5) throw new Error("Note invalide");
    if (args.comment.trim().length < 10) throw new Error("Avis trop court (10 caractères minimum)");

    await ctx.db.insert("reviews", {
      applicationId: args.applicationId,
      userId: identity.subject,
      displayName: args.displayName.trim(),
      city: args.city.trim(),
      destination: args.destination.trim(),
      rating: args.rating,
      comment: args.comment.trim(),
      isApproved: false,
      createdAt: Date.now(),
    });
  },
});

export const getForApplication = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.db
      .query("reviews")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .unique();
  },
});

export const listApproved = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("reviews")
      .withIndex("by_approved", (q) => q.eq("isApproved", true))
      .order("desc")
      .take(20);
  },
});

export const listAll = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user || user.role !== "admin") return null;

    const reviews = await ctx.db.query("reviews").order("desc").collect();
    return await Promise.all(
      reviews.map(async (r) => {
        const app = await ctx.db.get(r.applicationId);
        return { ...r, applicantName: app?.applicantName ?? "—" };
      })
    );
  },
});

export const approve = mutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user || user.role !== "admin") throw new Error("Accès refusé");
    await ctx.db.patch(args.reviewId, { isApproved: true });
  },
});

export const reject = mutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user || user.role !== "admin") throw new Error("Accès refusé");
    await ctx.db.patch(args.reviewId, { isApproved: false });
  },
});

export const remove = mutation({
  args: { reviewId: v.id("reviews") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();
    if (!user || user.role !== "admin") throw new Error("Accès refusé");
    await ctx.db.delete(args.reviewId);
  },
});
