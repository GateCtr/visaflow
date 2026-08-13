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
          "Vous avez beaucoup de questions, c'est excellent ! Pour aller plus loin, contactez directement un conseiller Joventy sur WhatsApp.\n[CTA:💬 Contacter sur WhatsApp:https://wa.me/243840808122?text=Bonjour%2C%20je%20souhaite%20%C3%AAtre%20accompagn%C3%A9%20pour%20mon%20visa]",
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

/**
 * Enregistre un clic CTA (intention) sans marquer l'utilisateur comme "convaincu".
 * Un clic n'est qu'une intention — le succès réel est confirmé par markConvinced.
 */
export const recordCTAClick = mutation({
  args: {
    sessionId: v.string(),
    cta: v.string(), // ex: "cta_register", "cta_new_application", "cta_prix"
  },
  handler: async (ctx, { sessionId, cta }) => {
    const now = Date.now();
    const conv = await ctx.db
      .query("victorConversations")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();

    if (!conv) return;

    await ctx.db.patch(conv._id, {
      ctaClicks: [...(conv.ctaClicks ?? []), cta],
      updatedAt: now,
    });
  },
});

/**
 * Marque une session comme "convaincue" — UNIQUEMENT lorsque l'utilisateur
 * a réellement complété une action (dossier créé, contrat signé, etc.).
 * Ne pas appeler sur simple clic CTA.
 */
export const markConvinced = mutation({
  args: {
    sessionId: v.string(),
    action: v.string(), // ex: "dossier_created", "contrat_signed"
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

// ─── Stats traitement (pour le prompt Victor) ─────────────────────────────────

/**
 * Calcule les statistiques de traitement réelles depuis la table applications.
 * Utilisé par l'action HTTP chat.ts pour enrichir le prompt de Victor.
 */
export const getProcessingStats = internalQuery({
  args: {},
  handler: async (ctx) => {
    const apps = await ctx.db.query("applications").collect();
    const now = Date.now();

    // Regrouper par destination
    const statsByDest: Record<string, { totalDays: number; count: number; completed: number }> = {};

    for (const app of apps) {
      const dest = (app as Record<string, unknown>).destination as string | undefined;
      if (!dest) continue;
      if (!statsByDest[dest]) statsByDest[dest] = { totalDays: 0, count: 0, completed: 0 };

      statsByDest[dest].count++;

      // Si le dossier a une date de RDV obtenu, calculer le délai
      const apptDetails = (app as Record<string, unknown>).appointmentDetails as
        | { date?: string } | undefined;
      const createdAt = (app as Record<string, unknown>).createdAt as number | undefined;
      if (apptDetails?.date && createdAt) {
        const apptMs = new Date(apptDetails.date).getTime();
        if (apptMs > createdAt) {
          const days = Math.round((apptMs - createdAt) / (1000 * 60 * 60 * 24));
          if (days > 0 && days < 365) {
            statsByDest[dest].totalDays += days;
            statsByDest[dest].completed++;
          }
        }
      }
    }

    // Calculer la moyenne par destination
    const avgDaysByDest: Record<string, number | null> = {};
    for (const [dest, s] of Object.entries(statsByDest)) {
      avgDaysByDest[dest] = s.completed > 0 ? Math.round(s.totalDays / s.completed) : null;
    }

    // Compter les dossiers actifs par destination
    const activeCounts: Record<string, number> = {};
    for (const app of apps) {
      const dest = (app as Record<string, unknown>).destination as string | undefined;
      const status = (app as Record<string, unknown>).status as string | undefined;
      if (!dest || !status) continue;
      const isActive = ["pending_payment", "in_progress", "docs_submitted"].includes(status);
      if (isActive) activeCounts[dest] = (activeCounts[dest] ?? 0) + 1;
    }

    // Taux de succès global
    const completed = apps.filter(
      (a) => (a as Record<string, unknown>).status === "completed"
    ).length;
    const successRate = apps.length > 0 ? Math.round((completed / apps.length) * 100) : 94;

    return { avgDaysByDest, activeCounts, totalApps: apps.length, successRate, _ts: now };
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
        ctaClicks: c.ctaClicks ?? [],
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
