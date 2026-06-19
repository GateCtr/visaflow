import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  const pubSnake = identity["public_metadata"] as { role?: string } | undefined;
  if (pubSnake?.role) return pubSnake.role;
  return "client";
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const recordPageView = mutation({
  args: {
    sessionId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, { sessionId, path }) => {
    const now = Date.now();
    const month = monthKey(now);
    await ctx.db.insert("pageViews", { sessionId, path, month, timestamp: now });
  },
});

export const updatePresence = mutation({
  args: {
    sessionId: v.string(),
    path: v.string(),
  },
  handler: async (ctx, { sessionId, path }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { path, lastSeen: now });
    } else {
      await ctx.db.insert("presence", { sessionId, path, lastSeen: now });
    }
    // Purge stale entries (> 5 min) to keep table small
    const stale = await ctx.db
      .query("presence")
      .withIndex("by_lastSeen", (q) => q.lt("lastSeen", now - 5 * 60 * 1000))
      .collect();
    await Promise.all(stale.map((s) => ctx.db.delete(s._id)));
  },
});

export const getLiveVisitors = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const cutoff = Date.now() - 2 * 60 * 1000;
    const active = await ctx.db
      .query("presence")
      .withIndex("by_lastSeen", (q) => q.gte("lastSeen", cutoff))
      .collect();

    const byPath: Record<string, number> = {};
    for (const row of active) {
      byPath[row.path] = (byPath[row.path] ?? 0) + 1;
    }

    return {
      total: active.length,
      byPath: Object.entries(byPath)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([path, count]) => ({ path, count })),
    };
  },
});

export const getMonthlyStats = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const now = Date.now();
    // Build last 6 months keys
    const months: string[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - i);
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
    }

    const results = await Promise.all(
      months.map(async (month) => {
        const rows = await ctx.db
          .query("pageViews")
          .withIndex("by_month", (q) => q.eq("month", month))
          .collect();
        const uniqueSessions = new Set(rows.map((r) => r.sessionId)).size;
        return { month, views: rows.length, visitors: uniqueSessions };
      })
    );

    return results;
  },
});
