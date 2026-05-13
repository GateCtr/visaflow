import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

/**
 * Ajoute un événement de découverte de créneau.
 * Appelé par le bot via HTTP (fire-and-forget).
 */
export const add = mutation({
  args: {
    applicationId: v.id("applications"),
    destination: v.string(),
    office: v.string(),
    dateFound: v.string(),
    timeFound: v.optional(v.string()),
    outcome: v.union(v.literal("captured"), v.literal("ignored")),
    reason: v.optional(v.string()),
    context: v.optional(v.string()),
    discoveredAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("slotDiscoveries", {
      applicationId: args.applicationId,
      destination: args.destination,
      office: args.office,
      dateFound: args.dateFound,
      timeFound: args.timeFound,
      outcome: args.outcome,
      reason: args.reason,
      context: args.context,
      discoveredAt: args.discoveredAt,
    });
  },
});

/**
 * Ajoute un batch d'événements (optimisé pour éviter N appels HTTP).
 */
export const addBatch = mutation({
  args: {
    events: v.array(v.object({
      applicationId: v.id("applications"),
      destination: v.string(),
      office: v.string(),
      dateFound: v.string(),
      timeFound: v.optional(v.string()),
      outcome: v.union(v.literal("captured"), v.literal("ignored")),
      reason: v.optional(v.string()),
      context: v.optional(v.string()),
      discoveredAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      await ctx.db.insert("slotDiscoveries", event);
    }
  },
});

/**
 * Internal mutation pour insertion depuis les HTTP actions.
 */
export const internalAdd = internalMutation({
  args: {
    applicationId: v.id("applications"),
    destination: v.string(),
    office: v.string(),
    dateFound: v.string(),
    timeFound: v.optional(v.string()),
    outcome: v.union(v.literal("captured"), v.literal("ignored")),
    reason: v.optional(v.string()),
    context: v.optional(v.string()),
    discoveredAt: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("slotDiscoveries", args);
  },
});

export const internalAddBatch = internalMutation({
  args: {
    events: v.array(v.object({
      applicationId: v.id("applications"),
      destination: v.string(),
      office: v.string(),
      dateFound: v.string(),
      timeFound: v.optional(v.string()),
      outcome: v.union(v.literal("captured"), v.literal("ignored")),
      reason: v.optional(v.string()),
      context: v.optional(v.string()),
      discoveredAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      await ctx.db.insert("slotDiscoveries", event);
    }
  },
});

/**
 * Récupère les stats de découverte pour une destination et un bureau donnés.
 * Utilisé par la page calendrier admin pour afficher la heatmap.
 */
export const getStats = query({
  args: {
    destination: v.optional(v.string()),
    office: v.optional(v.string()),
    since: v.optional(v.number()), // timestamp — par défaut 30 derniers jours
  },
  handler: async (ctx, args) => {
    const since = args.since ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);

    let q = ctx.db
      .query("slotDiscoveries")
      .withIndex("by_discovered", (qb) => qb.gte("discoveredAt", since))
      .order("desc");

    const all = await q.take(5000);

    // Filtrer par destination/office en mémoire (index ne couvre pas combo)
    const filtered = all.filter((d) => {
      if (args.destination && d.destination !== args.destination) return false;
      if (args.office && d.office !== args.office) return false;
      return true;
    });

    // Calculer stats agrégées
    const totalCaptured = filtered.filter((d) => d.outcome === "captured").length;
    const totalIgnored = filtered.filter((d) => d.outcome === "ignored").length;

    // Regrouper par date trouvée (pour heatmap calendrier)
    const byDateFound: Record<string, { captured: number; ignored: number; reasons: Record<string, number> }> = {};
    for (const d of filtered) {
      if (!byDateFound[d.dateFound]) {
        byDateFound[d.dateFound] = { captured: 0, ignored: 0, reasons: {} };
      }
      const entry = byDateFound[d.dateFound];
      if (d.outcome === "captured") entry.captured++;
      else entry.ignored++;
      if (d.reason) {
        entry.reasons[d.reason] = (entry.reasons[d.reason] ?? 0) + 1;
      }
    }

    // Regrouper par heure de découverte (heatmap horaire — quand le portail libère des créneaux)
    const byHour: Record<number, { captured: number; ignored: number }> = {};
    for (const d of filtered) {
      const hour = new Date(d.discoveredAt).getUTCHours();
      if (!byHour[hour]) byHour[hour] = { captured: 0, ignored: 0 };
      if (d.outcome === "captured") byHour[hour].captured++;
      else byHour[hour].ignored++;
    }

    // Regrouper par jour de la semaine (0=dimanche, 6=samedi)
    const byDayOfWeek: Record<number, { captured: number; ignored: number }> = {};
    for (const d of filtered) {
      const dow = new Date(d.discoveredAt).getUTCDay();
      if (!byDayOfWeek[dow]) byDayOfWeek[dow] = { captured: 0, ignored: 0 };
      if (d.outcome === "captured") byDayOfWeek[dow].captured++;
      else byDayOfWeek[dow].ignored++;
    }

    // Regrouper par raison d'ignorement
    const byReason: Record<string, number> = {};
    for (const d of filtered) {
      if (d.outcome === "ignored" && d.reason) {
        byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
      }
    }

    return {
      totalCaptured,
      totalIgnored,
      totalDiscoveries: filtered.length,
      byDateFound,
      byHour,
      byDayOfWeek,
      byReason,
      // Dernières découvertes brutes (pour le feed temps réel)
      recent: filtered.slice(0, 50).map((d) => ({
        _id: d._id,
        destination: d.destination,
        office: d.office,
        dateFound: d.dateFound,
        timeFound: d.timeFound,
        outcome: d.outcome,
        reason: d.reason,
        discoveredAt: d.discoveredAt,
      })),
    };
  },
});

/**
 * Récupère les découvertes récentes pour un dossier spécifique.
 */
export const listByApplication = query({
  args: {
    applicationId: v.id("applications"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 100, 500);
    return await ctx.db
      .query("slotDiscoveries")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .order("desc")
      .take(limit);
  },
});
