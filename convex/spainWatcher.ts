import { query, mutation, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const WATCHER_KEY = "default";
const MAX_SCANS = 20;

// ─── Auth helpers (même pattern que admin.ts) ─────────────────────────────────

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  const pubSnake = identity["public_metadata"] as { role?: string } | undefined;
  if (pubSnake?.role) return pubSnake.role;
  return "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}

// ─── Queries ─────────────────────────────────────────────────────────────────

export const getWatcher = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const rawScans = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_ts")
      .order("desc")
      .take(MAX_SCANS);

    // Resolve screenshot URLs for scans that have a screenshotStorageId
    const scans = await Promise.all(
      rawScans.map(async (scan) => {
        const screenshotUrl = scan.screenshotStorageId
          ? await ctx.storage.getUrl(scan.screenshotStorageId)
          : null;
        return { ...scan, screenshotUrl };
      }),
    );

    return { watcher: watcher ?? null, scans };
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const setWatcher = mutation({
  args: {
    isActive: v.boolean(),
    portalUrl: v.string(),
    adminEmail: v.string(),
    intervalMin: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    // Clamp intervalMin between 5 and 120 minutes
    const intervalMin = args.intervalMin !== undefined
      ? Math.max(5, Math.min(120, Math.round(args.intervalMin)))
      : undefined;

    const existing = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        isActive: args.isActive,
        portalUrl: args.portalUrl,
        adminEmail: args.adminEmail,
        intervalMin,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("spainWatcher", {
        key: WATCHER_KEY,
        isActive: args.isActive,
        portalUrl: args.portalUrl,
        adminEmail: args.adminEmail,
        intervalMin,
        updatedAt: Date.now(),
      });
    }
  },
});

// ─── Internal: called by HTTP endpoint from bot ───────────────────────────────

export const internalRecordScan = internalMutation({
  args: {
    status: v.union(v.literal("found"), v.literal("not_found"), v.literal("error")),
    slotInfo: v.optional(v.string()),
    screenshotStorageId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    pageCaptures: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const now = Date.now();

    // Insert scan record
    await ctx.db.insert("spainWatcherScans", {
      ts: now,
      status: args.status,
      slotInfo: args.slotInfo,
      screenshotStorageId: args.screenshotStorageId,
      errorMessage: args.errorMessage,
      pageCaptures: args.pageCaptures,
    });

    // Prune old scans (keep last MAX_SCANS)
    const old = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_ts")
      .order("asc")
      .take(1000);
    if (old.length > MAX_SCANS) {
      const toDelete = old.slice(0, old.length - MAX_SCANS);
      for (const scan of toDelete) {
        await ctx.db.delete(scan._id);
      }
    }

    // Update watcher singleton
    if (watcher) {
      const consecutiveErrors =
        args.status === "error"
          ? (watcher.consecutiveErrors ?? 0) + 1
          : 0;

      await ctx.db.patch(watcher._id, {
        lastScanAt: now,
        lastResult: args.status,
        lastSlotInfo: args.slotInfo,
        consecutiveErrors,
        updatedAt: now,
      });

      // Send email alert if slot found
      if (args.status === "found" && watcher.adminEmail) {
        await ctx.scheduler.runAfter(0, internal.spainWatcher.internalSendWatcherAlert, {
          adminEmail: watcher.adminEmail,
          slotInfo: args.slotInfo ?? "Créneau disponible",
          portalUrl: watcher.portalUrl,
          screenshotStorageId: args.screenshotStorageId,
        });
      }
    }
  },
});

// ─── Internal: email alert via Resend ────────────────────────────────────────

export const internalSendWatcherAlert = internalAction({
  args: {
    adminEmail: v.string(),
    slotInfo: v.string(),
    portalUrl: v.string(),
    screenshotStorageId: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[SpainWatcher] RESEND_API_KEY non configurée — alerte email ignorée");
      return;
    }

    const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Créneau Espagne trouvé</title></head>
<body style="font-family: sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <div style="background: linear-gradient(135deg, #c60b1e 0%, #f1bf00 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">🇪🇸 Créneau Espagne Disponible !</h1>
  </div>

  <div style="background: #f0fdf4; border: 2px solid #16a34a; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
    <h2 style="color: #15803d; margin-top: 0; font-size: 18px;">✅ Créneau trouvé</h2>
    <p style="font-size: 16px; font-weight: 600; margin: 0 0 8px;">${args.slotInfo}</p>
  </div>

  <p style="color: #444; font-size: 14px; margin-bottom: 16px;">
    Le veilleur automatique Espagne a détecté une disponibilité sur le portail citaconsular.es.
    Cliquez rapidement pour le réserver avant qu'il ne disparaisse.
  </p>

  <a href="${args.portalUrl}" style="display: inline-block; background: #c60b1e; color: white; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; margin-bottom: 24px;">
    Voir le créneau →
  </a>

  <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
  <p style="color: #9ca3af; font-size: 11px; text-align: center; margin: 0;">
    Joventy Veilleur Espagne — alerte automatique • ${new Date().toLocaleString("fr-FR")}
  </p>
</body>
</html>
    `.trim();

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Joventy Watcher <hello@joventy.cd>",
          to: args.adminEmail,
          subject: "🇪🇸 Créneau Espagne disponible !",
          html,
        }),
      });
      if (!res.ok) {
        const err = await res.text();
        console.error("[SpainWatcher] Erreur Resend:", res.status, err);
      } else {
        console.log("[SpainWatcher] Alerte email envoyée à", args.adminEmail);
      }
    } catch (e) {
      console.error("[SpainWatcher] Erreur réseau Resend:", e);
    }
  },
});

// ─── Internal: GET config for bot ─────────────────────────────────────────────

export const internalGetConfig = internalMutation({
  args: {},
  handler: async (ctx) => {
    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();
    return watcher ?? null;
  },
});



// ─── Mutation: suppression des scans historiques ──────────────────────────────

export const clearScans = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const scans = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_ts")
      .collect();

    for (const scan of scans) {
      // Supprimer le screenshot du storage si présent
      if (scan.screenshotStorageId) {
        try {
          await ctx.storage.delete(scan.screenshotStorageId as any);
        } catch { /* ignore si déjà supprimé */ }
      }
      await ctx.db.delete(scan._id);
    }

    return { deleted: scans.length };
  },
});
