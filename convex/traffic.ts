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
    referrer: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, path, referrer }) => {
    const now = Date.now();
    const month = monthKey(now);
    await ctx.db.insert("pageViews", { sessionId, path, month, timestamp: now, referrer });
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

function classifyReferrerSource(referrer: string | undefined): string {
  if (!referrer) return "Direct";
  let host: string;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "Direct";
  }
  if (!host || host.includes("joventy")) return "Direct";
  if (host.includes("google")) return "Google";
  if (host.includes("bing")) return "Bing";
  if (host.includes("yahoo")) return "Yahoo";
  if (host.includes("duckduckgo")) return "DuckDuckGo";
  if (host.includes("facebook") || host.includes("fb.com") || host.includes("l.facebook")) return "Facebook";
  if (host.includes("instagram")) return "Instagram";
  if (host.includes("wa.me") || host.includes("whatsapp")) return "WhatsApp";
  if (host.includes("t.co") || host.includes("twitter") || host.includes("x.com")) return "Twitter/X";
  if (host.includes("tiktok")) return "TikTok";
  if (host.includes("linkedin")) return "LinkedIn";
  if (host.includes("youtube")) return "YouTube";
  return host;
}

async function collectRecentPageViews(
  ctx: { db: { query: (t: "pageViews") => any } },
  days: number
) {
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const months = new Set([monthKey(now), monthKey(cutoff)]);

  const batches = await Promise.all(
    Array.from(months).map((month) =>
      ctx.db
        .query("pageViews")
        .withIndex("by_month", (q: any) => q.eq("month", month))
        .collect()
    )
  );

  return batches.flat().filter((r: any) => r.timestamp >= cutoff);
}

export const getTopPages = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const rows = await collectRecentPageViews(ctx, 30);

    const byPath: Record<string, { views: number; sessions: Set<string> }> = {};
    for (const row of rows) {
      if (!byPath[row.path]) byPath[row.path] = { views: 0, sessions: new Set() };
      byPath[row.path].views += 1;
      byPath[row.path].sessions.add(row.sessionId);
    }

    return Object.entries(byPath)
      .map(([path, v]) => ({ path, views: v.views, visitors: v.sessions.size }))
      .sort((a, b) => b.views - a.views)
      .slice(0, 10);
  },
});

export const getTrafficSources = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const rows = await collectRecentPageViews(ctx, 30);

    const bySource: Record<string, Set<string>> = {};
    for (const row of rows) {
      const source = classifyReferrerSource(row.referrer);
      if (!bySource[source]) bySource[source] = new Set();
      bySource[source].add(row.sessionId);
    }

    const total = Object.values(bySource).reduce((s, set) => s + set.size, 0) || 1;

    return Object.entries(bySource)
      .map(([source, set]) => ({
        source,
        visitors: set.size,
        pct: Math.round((set.size / total) * 100),
      }))
      .sort((a, b) => b.visitors - a.visitors)
      .slice(0, 8);
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
