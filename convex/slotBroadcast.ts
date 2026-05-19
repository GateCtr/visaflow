/**
 * Slot Broadcast — mutations pour le Blind Booking V3.
 *
 * Table : slotBroadcasts
 * TTL logique : 5 min (les confinés ne réagissent pas après 5 min)
 *
 * ═══ SEGMENTATION VISA CLASS ═══
 * Le serveur USA retourne les slots par visaClass. Un slotId détecté par un
 * compte F1 n'est PAS valide pour un compte B1/B2 (409 "No free slots").
 * → Chaque broadcast porte un tag visaClass.
 * → Les confinés ne reçoivent QUE les broadcasts de leur propre visaClass.
 */

import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

/** Enregistre un nouveau slot broadcast (appelé par l'éclaireur via HTTP). */
export const internalCreate = internalMutation({
  args: {
    sourceUsername: v.string(),
    /** Classe de visa normalisée de l'éclaireur (ex: "F1", "B1/B2", "H", "K"). */
    visaClass: v.string(),
    office: v.string(),
    postUserId: v.number(),
    date: v.string(),
    time: v.string(),
    slotId: v.string(),
    startTime: v.string(),
    discoveredAt: v.number(),
    sourceBooked: v.boolean(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("slotBroadcasts", {
      ...args,
      processedBy: [],
      results: [],
    });
    return id;
  },
});

/**
 * Récupère les événements non traités par un compte donné (< 5 min).
 * FILTRE STRICT par visaClass : un confiné B1/B2 ne voit QUE les broadcasts B1/B2.
 */
export const internalGetPending = internalQuery({
  args: {
    username: v.string(),
    /** Classe de visa du confiné qui demande — filtrage obligatoire. */
    visaClass: v.string(),
  },
  handler: async (ctx, args) => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const username = args.username.toLowerCase();

    // Utiliser l'index composé (visaClass, discoveredAt) pour un scan ciblé
    const events = await ctx.db
      .query("slotBroadcasts")
      .withIndex("by_visa_class_discovered", (q) =>
        q.eq("visaClass", args.visaClass).gte("discoveredAt", fiveMinAgo)
      )
      .collect();

    // Filtrer : pas encore traité par ce compte + pas émis par ce compte
    const pending = events.filter((e) => {
      if (e.sourceUsername.toLowerCase() === username) return false;
      const processed = e.processedBy ?? [];
      return !processed.includes(username);
    });

    return pending.map((e) => ({
      eventId: e._id,
      sourceUsername: e.sourceUsername,
      visaClass: e.visaClass,
      office: e.office,
      postUserId: e.postUserId,
      date: e.date,
      time: e.time,
      slotId: e.slotId,
      startTime: e.startTime,
      discoveredAt: e.discoveredAt,
      sourceBooked: e.sourceBooked,
    }));
  },
});

/** Marque un événement comme traité par un compte (ACK). */
export const internalAck = internalMutation({
  args: {
    eventId: v.id("slotBroadcasts"),
    username: v.string(),
    result: v.union(v.literal("booked"), v.literal("failed"), v.literal("expired")),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event) return;

    const username = args.username.toLowerCase();
    const processedBy = event.processedBy ?? [];
    const results = event.results ?? [];

    // Ne pas dupliquer si déjà traité
    if (processedBy.includes(username)) return;

    await ctx.db.patch(args.eventId, {
      processedBy: [...processedBy, username],
      results: [...results, {
        username,
        result: args.result,
        processedAt: Date.now(),
      }],
    });
  },
});
