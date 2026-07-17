/**
 * Victor — Agent commercial IA Joventy
 * Tables: chatSessions (rate limiting), victorConversations (historique + stats)
 */
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { v } from "convex/values";

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/** Vérifie et incrémente le compteur pour une session. Retourne true si autorisé. */
export const checkAndIncrement = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;
    const oneHourAgo = now - 3_600_000;

    const session = await ctx.db
      .query("chatSessions")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (!session) {
      await ctx.db.insert("chatSessions", {
        sessionId,
        messagesLastMinute: 1,
        messagesLastHour: 1,
        windowMinuteStart: now,
        windowHourStart: now,
        createdAt: now,
        updatedAt: now,
      });
      return { allowed: true, reason: null };
    }

    // Reset fenêtres si expirées
    const minuteCount =
      session.windowMinuteStart > oneMinuteAgo ? session.messagesLastMinute : 0;
    const hourCount =
      session.windowHourStart > oneHourAgo ? session.messagesLastHour : 0;

    if (minuteCount >= 5) {
      return {
        allowed: false,
        reason:
          "Laissez-moi juste un instant… Je reviens vers vous dans une minute.",
      };
    }
    if (hourCount >= 30) {
      return {
        allowed: false,
        reason:
          "Vous avez beaucoup de questions, c'est excellent ! Un assistant validateur avec un niveau de validation élevé va prendre la relève et vous contacter sous peu.",
      };
    }

    await ctx.db.patch(session._id, {
      messagesLastMinute:
        session.windowMinuteStart > oneMinuteAgo ? minuteCount + 1 : 1,
      messagesLastHour:
        session.windowHourStart > oneHourAgo ? hourCount + 1 : 1,
      windowMinuteStart:
        session.windowMinuteStart > oneMinuteAgo
          ? session.windowMinuteStart
          : now,
      windowHourStart:
        session.windowHourStart > oneHourAgo ? session.windowHourStart : now,
      updatedAt: now,
    });

    return { allowed: true, reason: null };
  },
});

// ─── Suivi des conversations ──────────────────────────────────────────────────

export const saveMessage = internalMutation({
  args: {
    sessionId: v.string(),
    userMessage: v.string(),
    victorResponse: v.string(),
    pageContext: v.string(),
    isAuth: v.boolean(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existing = await ctx.db
      .query("victorConversations")
      .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
      .first();

    if (!existing) {
      await ctx.db.insert("victorConversations", {
        sessionId: args.sessionId,
        pageContext: args.pageContext,
        isAuth: args.isAuth,
        messages: [
          { role: "user" as const, content: args.userMessage, ts: now },
          { role: "victor" as const, content: args.victorResponse, ts: now + 1 },
        ],
        convinced: false,
        convincedAt: undefined,
        actionsTaken: [],
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        messages: [
          ...existing.messages,
          { role: "user" as const, content: args.userMessage, ts: now },
          { role: "victor" as const, content: args.victorResponse, ts: now + 1 },
        ],
        updatedAt: now,
      });
    }
  },
});

/** Marque une session comme "convaincue" avec l'action prise */
export const markConvinced = mutation({
  args: {
    sessionId: v.string(),
    action: v.string(), // ex: "click_cta_prix", "started_dossier", "contrat_signed"
  },
  handler: async (ctx, { sessionId, action }) => {
    const now = Date.now();
    const conv = await ctx.db
      .query("victorConversations")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (!conv) return;

    await ctx.db.patch(conv._id, {
      convinced: true,
      convincedAt: now,
      actionsTaken: [...(conv.actionsTaken ?? []), action],
      updatedAt: now,
    });
  },
});

// ─── Helpers auth ─────────────────────────────────────────────────────────────

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  const pubSnake = identity["public_metadata"] as { role?: string } | undefined;
  if (pubSnake?.role) return pubSnake.role;
  return "client";
}

// ─── Requêtes admin ───────────────────────────────────────────────────────────

export const getVictorStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      throw new Error("Unauthorized: admin access required");
    }
    const all = await ctx.db.query("victorConversations").collect();
    const totalConversations = all.length;
    const totalMessages = all.reduce((acc, c) => acc + c.messages.length, 0);
    const convinced = all.filter((c) => c.convinced);
    const conversionRate =
      totalConversations > 0
        ? Math.round((convinced.length / totalConversations) * 100)
        : 0;

    // Top pages
    const pageCount: Record<string, number> = {};
    for (const c of all) {
      pageCount[c.pageContext] = (pageCount[c.pageContext] ?? 0) + 1;
    }
    const topPages = Object.entries(pageCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([page, count]) => ({ page, count }));

    // Top actions prises
    const actionCount: Record<string, number> = {};
    for (const c of convinced) {
      for (const a of c.actionsTaken ?? []) {
        actionCount[a] = (actionCount[a] ?? 0) + 1;
      }
    }
    const topActions = Object.entries(actionCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([action, count]) => ({ action, count }));

    // Conversations récentes (20 dernières)
    const recent = all
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
      .map((c) => ({
        _id: c._id,
        sessionId: c.sessionId,
        pageContext: c.pageContext,
        isAuth: c.isAuth,
        messageCount: c.messages.length,
        convinced: c.convinced,
        convincedAt: c.convincedAt,
        actionsTaken: c.actionsTaken ?? [],
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        preview:
          c.messages.find((m) => m.role === "user")?.content?.slice(0, 80) ??
          "",
      }));

    // Évolution 30 derniers jours
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const dailyMap: Record<string, { convs: number; convinced: number }> = {};
    for (const c of all) {
      if (c.createdAt < thirtyDaysAgo) continue;
      const day = new Date(c.createdAt).toISOString().substring(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { convs: 0, convinced: 0 };
      dailyMap[day].convs += 1;
      if (c.convinced) dailyMap[day].convinced += 1;
    }
    const dailyTrend = Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, ...v }));

    return {
      totalConversations,
      totalMessages,
      convincedCount: convinced.length,
      conversionRate,
      topPages,
      topActions,
      recent,
      dailyTrend,
    };
  },
});

export const getConversationMessages = query({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      throw new Error("Unauthorized: admin access required");
    }
    const conv = await ctx.db
      .query("victorConversations")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    return conv ?? null;
  },
});
