import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  const pubSnake = identity["public_metadata"] as { role?: string } | undefined;
  if (pubSnake?.role) return pubSnake.role;
  return "client";
}

/** Génère une URL d'upload Convex Storage (public, pas besoin d'être connecté). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/** Soumet une commande Alerte Schengen (page publique). */
export const submitOrder = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    proofStorageId: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("schengenAlertOrders", {
      name: args.name,
      email: args.email,
      phone: args.phone,
      proofStorageId: args.proofStorageId,
      status: "pending",
      createdAt: Date.now(),
    });

    // Notifier l'admin par email
    await ctx.scheduler.runAfter(0, internal.emails.sendSchengenAlertNewOrderAdmin, {
      orderId: id,
      name: args.name,
      email: args.email,
      phone: args.phone ?? "",
    });

    return id;
  },
});

/** Liste toutes les commandes (admin). */
export const listOrders = query({
  args: {
    status: v.optional(v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("rejected"),
    )),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return [];

    let orders = await ctx.db.query("schengenAlertOrders").order("desc").collect();
    if (args.status) {
      orders = orders.filter((o) => o.status === args.status);
    }

    // Résoudre les URLs des preuves
    const withUrls = await Promise.all(
      orders.map(async (order) => {
        const proofUrl = await ctx.storage.getUrl(order.proofStorageId);
        return { ...order, proofUrl };
      })
    );

    return withUrls;
  },
});

/** Confirme un paiement et envoie le lien WhatsApp au client (admin). */
export const confirmOrder = mutation({
  args: {
    orderId: v.id("schengenAlertOrders"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      throw new Error("Non autorisé");
    }

    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Commande introuvable");
    if (order.status === "confirmed") throw new Error("Déjà confirmé");

    await ctx.db.patch(args.orderId, {
      status: "confirmed",
      confirmedAt: Date.now(),
    });

    // Envoyer l'email avec le lien groupe + lien admin WhatsApp
    await ctx.scheduler.runAfter(0, internal.emails.sendSchengenAlertConfirmed, {
      to: order.email,
      name: order.name,
    });
  },
});

/** Rejette une commande (admin). */
export const rejectOrder = mutation({
  args: {
    orderId: v.id("schengenAlertOrders"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      throw new Error("Non autorisé");
    }

    const order = await ctx.db.get(args.orderId);
    if (!order) throw new Error("Commande introuvable");

    await ctx.db.patch(args.orderId, {
      status: "rejected",
      rejectedAt: Date.now(),
      adminNote: args.reason,
    });
  },
});

/** Stats globales pour le dashboard admin. */
export const getStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const all = await ctx.db.query("schengenAlertOrders").collect();
    const pending = all.filter((o) => o.status === "pending").length;
    const confirmed = all.filter((o) => o.status === "confirmed").length;
    const rejected = all.filter((o) => o.status === "rejected").length;

    // Visites sur /alerte-schengen (via pageViews)
    const views = await ctx.db
      .query("pageViews")
      .filter((q) => q.eq(q.field("path"), "/alerte-schengen"))
      .collect();
    const uniqueSessions = new Set(views.map((v) => v.sessionId)).size;

    // Conversions 7 derniers jours
    const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recent = all.filter((o) => o.createdAt >= since7d).length;

    return {
      total: all.length,
      pending,
      confirmed,
      rejected,
      pageViews: views.length,
      uniqueSessions,
      recent7d: recent,
      conversionRate: uniqueSessions > 0 ? Math.round((all.length / uniqueSessions) * 100) : 0,
    };
  },
});

/** Compte les commandes en attente (badge admin). */
export const countPending = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return 0;
    const orders = await ctx.db
      .query("schengenAlertOrders")
      .filter((q) => q.eq(q.field("status"), "pending"))
      .collect();
    return orders.length;
  },
});
