import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  return "client";
}

function resolveUserId(identity: { [key: string]: unknown }): string {
  const isAdmin = getRole(identity) === "admin";
  return isAdmin ? "ADMIN" : (identity.subject as string);
}

/**
 * Crée une notification interne.
 * Appelée en interne (scheduler) depuis admin.ts, applications.ts, slotFoundHelper.ts, messages.ts.
 * userId = Clerk subject du client, ou "ADMIN" pour les notifications destinées aux admins.
 */
export const create = internalMutation({
  args: {
    userId: v.string(),
    type: v.string(),
    title: v.string(),
    body: v.string(),
    applicationId: v.optional(v.id("applications")),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      applicationId: args.applicationId,
      read: false,
      createdAt: Date.now(),
    });
  },
});

/** Les 30 dernières notifications de l'utilisateur connecté (ou de tous les admins). */
export const list = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const userId = resolveUserId(identity as Record<string, unknown>);
    return ctx.db
      .query("notifications")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(30);
  },
});

/** Nombre de notifications non lues — utilisé pour le badge de la cloche. */
export const getUnreadCount = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return 0;
    const userId = resolveUserId(identity as Record<string, unknown>);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_unread", (q) => q.eq("userId", userId).eq("read", false))
      .collect();
    return unread.length;
  },
});

/** Marque une notification spécifique comme lue. */
export const markRead = mutation({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const userId = resolveUserId(identity as Record<string, unknown>);
    const notif = await ctx.db.get(args.notificationId);
    if (!notif || notif.userId !== userId) return;
    await ctx.db.patch(args.notificationId, { read: true });
  },
});

/** Marque toutes les notifications non lues comme lues. */
export const markAllRead = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return;
    const userId = resolveUserId(identity as Record<string, unknown>);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_unread", (q) => q.eq("userId", userId).eq("read", false))
      .collect();
    for (const notif of unread) {
      await ctx.db.patch(notif._id, { read: true });
    }
  },
});
