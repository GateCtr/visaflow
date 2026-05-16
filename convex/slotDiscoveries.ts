import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

// Fenêtre de déduplication : si un event identique (même office+dateFound+outcome+applicationId)
// existe dans les dernières 24h, on met à jour au lieu de créer un doublon.
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Logique upsert commune : cherche un doublon récent, met à jour ou crée.
 * Retourne true si un nouveau document a été créé, false si mis à jour.
 */
async function upsertDiscovery(
  ctx: { db: any },
  args: {
    applicationId: Id<"applications">;
    destination: string;
    office: string;
    dateFound: string;
    timeFound?: string;
    outcome: "captured" | "ignored";
    reason?: string;
    context?: string;
    mode?: "schedule" | "reschedule";
    discoveredAt: number;
  }
): Promise<boolean> {
  const cutoff = args.discoveredAt - DEDUP_WINDOW_MS;

  // Chercher un doublon récent (même applicationId + office + dateFound + outcome)
  const existing = await ctx.db
    .query("slotDiscoveries")
    .withIndex("by_application", (q: any) => q.eq("applicationId", args.applicationId))
    .filter((q: any) =>
      q.and(
        q.eq(q.field("office"), args.office),
        q.eq(q.field("dateFound"), args.dateFound),
        q.eq(q.field("outcome"), args.outcome),
        q.gte(q.field("discoveredAt"), cutoff)
      )
    )
    .first();

  if (existing) {
    // Doublon trouvé → mettre à jour seenCount + seenAt + lastSeenAt
    const currentSeenAt: number[] = existing.seenAt ?? [existing.discoveredAt];
    // Limiter seenAt à 100 entrées max pour éviter un document trop gros
    const updatedSeenAt = [...currentSeenAt, args.discoveredAt].slice(-100);

    await ctx.db.patch(existing._id, {
      seenCount: (existing.seenCount ?? 1) + 1,
      seenAt: updatedSeenAt,
      lastSeenAt: args.discoveredAt,
      // Mettre à jour le timeFound si on en a un nouveau et pas l'ancien
      ...(args.timeFound && !existing.timeFound ? { timeFound: args.timeFound } : {}),
    });
    return false; // pas de nouveau document
  }

  // Pas de doublon → créer un nouveau document
  await ctx.db.insert("slotDiscoveries", {
    ...args,
    seenCount: 1,
    seenAt: [args.discoveredAt],
    lastSeenAt: args.discoveredAt,
  });
  return true; // nouveau document créé
}

/**
 * Ajoute un événement de découverte de créneau (avec déduplication 24h).
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
    mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
    discoveredAt: v.number(),
  },
  handler: async (ctx, args) => {
    await upsertDiscovery(ctx, args);
  },
});

/**
 * Ajoute un batch d'événements (avec déduplication 24h par event).
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
      mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
      discoveredAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      await upsertDiscovery(ctx, event);
    }
  },
});

/**
 * Internal mutation pour insertion depuis les HTTP actions (avec déduplication).
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
    mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
    discoveredAt: v.number(),
  },
  handler: async (ctx, args) => {
    await upsertDiscovery(ctx, args);
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
      mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
      discoveredAt: v.number(),
    })),
  },
  handler: async (ctx, args) => {
    for (const event of args.events) {
      await upsertDiscovery(ctx, event);
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
    mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
    since: v.optional(v.number()), // timestamp — par défaut 30 derniers jours
  },
  handler: async (ctx, args) => {
    const since = args.since ?? (Date.now() - 30 * 24 * 60 * 60 * 1000);

    let q = ctx.db
      .query("slotDiscoveries")
      .withIndex("by_discovered", (qb) => qb.gte("discoveredAt", since))
      .order("desc");

    const all = await q.take(5000);

    // Filtrer par destination/office/mode en mémoire (index ne couvre pas combo)
    const filtered = all.filter((d) => {
      if (args.destination && d.destination !== args.destination) return false;
      if (args.office && d.office !== args.office) return false;
      if (args.mode && d.mode !== args.mode) return false;
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
    // Utilise seenAt[] quand disponible (toutes les observations), sinon discoveredAt seul.
    const byHour: Record<number, { captured: number; ignored: number }> = {};
    for (const d of filtered) {
      const timestamps: number[] = (d as any).seenAt ?? [d.discoveredAt];
      for (const ts of timestamps) {
        const hour = new Date(ts).getUTCHours();
        if (!byHour[hour]) byHour[hour] = { captured: 0, ignored: 0 };
        if (d.outcome === "captured") byHour[hour].captured++;
        else byHour[hour].ignored++;
      }
    }

    // Regrouper par jour de la semaine (0=dimanche, 6=samedi)
    // Utilise seenAt[] pour plus de précision sur les jours actifs.
    const byDayOfWeek: Record<number, { captured: number; ignored: number }> = {};
    for (const d of filtered) {
      const timestamps: number[] = (d as any).seenAt ?? [d.discoveredAt];
      for (const ts of timestamps) {
        const dow = new Date(ts).getUTCDay();
        if (!byDayOfWeek[dow]) byDayOfWeek[dow] = { captured: 0, ignored: 0 };
        if (d.outcome === "captured") byDayOfWeek[dow].captured++;
        else byDayOfWeek[dow].ignored++;
      }
    }

    // Regrouper par raison d'ignorement
    const byReason: Record<string, number> = {};
    for (const d of filtered) {
      if (d.outcome === "ignored" && d.reason) {
        byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
      }
    }

    // Regrouper par mode (schedule vs reschedule)
    const byMode: Record<string, number> = {};
    for (const d of filtered) {
      const m = d.mode ?? "unknown";
      byMode[m] = (byMode[m] ?? 0) + 1;
    }

    return {
      totalCaptured,
      totalIgnored,
      totalDiscoveries: filtered.length,
      byDateFound,
      byHour,
      byDayOfWeek,
      byReason,
      byMode,
      // Dernières découvertes brutes (pour le feed temps réel) — dédupliquées avec seenCount
      recent: filtered.slice(0, 50).map((d) => ({
        _id: d._id,
        destination: d.destination,
        office: d.office,
        dateFound: d.dateFound,
        timeFound: d.timeFound,
        outcome: d.outcome,
        reason: d.reason,
        mode: d.mode,
        discoveredAt: d.discoveredAt,
        seenCount: (d as any).seenCount ?? 1,
        lastSeenAt: (d as any).lastSeenAt ?? d.discoveredAt,
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



/**
 * Exporte les decouvertes brutes pour une periode donnee (CSV export).
 * Retourne jusqu'a 10000 rows pour couvrir 1 an de donnees.
 */
export const exportForPeriod = query({
  args: {
    since: v.number(), // timestamp debut
    until: v.optional(v.number()), // timestamp fin (defaut: maintenant)
    destination: v.optional(v.string()),
    office: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
  },
  handler: async (ctx, args) => {
    const until = args.until ?? Date.now();

    const all = await ctx.db
      .query("slotDiscoveries")
      .withIndex("by_discovered", (qb) => qb.gte("discoveredAt", args.since))
      .order("asc")
      .take(10000);

    const filtered = all.filter((d) => {
      if (d.discoveredAt > until) return false;
      if (args.destination && d.destination !== args.destination) return false;
      if (args.office && d.office !== args.office) return false;
      if (args.mode && d.mode !== args.mode) return false;
      return true;
    });

    return filtered.map((d) => ({
      dateFound: d.dateFound,
      timeFound: d.timeFound ?? "",
      office: d.office,
      destination: d.destination,
      outcome: d.outcome,
      reason: d.reason ?? "",
      mode: d.mode ?? "",
      discoveredAt: new Date(d.discoveredAt).toISOString(),
      seenCount: (d as any).seenCount ?? 1,
    }));
  },
});
