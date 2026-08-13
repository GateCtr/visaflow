import { query, mutation, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const WATCHER_KEY = "default";
const MAX_SCANS = 200;

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

export const getWatcherPaginated = query({
  args: {
    page: v.optional(v.number()),     // 0-indexed page number (default 0)
    pageSize: v.optional(v.number()), // items per page (default 20)
    statusFilter: v.optional(v.string()), // "found" | "not_found" | "error" | "" (all)
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const pageSize = Math.min(args.pageSize ?? 20, 50);
    const page = args.page ?? 0;

    // Fetch all scans for counting + filtering
    const allScans = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_ts")
      .order("desc")
      .take(MAX_SCANS);

    // Apply status filter
    const filtered = args.statusFilter
      ? allScans.filter((s) => s.status === args.statusFilter)
      : allScans;

    const totalCount = filtered.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    // Paginate
    const start = page * pageSize;
    const pageScans = filtered.slice(start, start + pageSize);

    // Resolve screenshot URLs
    const scans = await Promise.all(
      pageScans.map(async (scan) => {
        const screenshotUrl = scan.screenshotStorageId
          ? await ctx.storage.getUrl(scan.screenshotStorageId)
          : null;
        return { ...scan, screenshotUrl };
      }),
    );

    // Stats summary
    const stats = {
      total: allScans.length,
      found: allScans.filter((s) => s.status === "found").length,
      notFound: allScans.filter((s) => s.status === "not_found").length,
      errors: allScans.filter((s) => s.status === "error").length,
    };

    return { watcher: watcher ?? null, scans, page, pageSize, totalCount, totalPages, stats };
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

export const setWatcher = mutation({
  args: {
    isActive: v.boolean(),
    portalUrl: v.string(),
    adminEmail: v.string(),
    intervalMin: v.optional(v.number()),
    intervalSec: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    // Keep the legacy minute setting for old clients, but make HTTP cadence
    // explicit in seconds so a 60-second scan is representable.
    const intervalMin = args.intervalMin !== undefined
      ? Math.max(5, Math.min(120, Math.round(args.intervalMin)))
      : undefined;
    const intervalSec = args.intervalSec !== undefined
      ? Math.max(10, Math.min(3600, Math.round(args.intervalSec)))
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
        intervalSec,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("spainWatcher", {
        key: WATCHER_KEY,
        isActive: args.isActive,
        portalUrl: args.portalUrl,
        adminEmail: args.adminEmail,
        intervalMin,
        intervalSec,
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
    detectedServices: v.optional(v.string()),  // JSON array of {serviceId, serviceName}
    detectedSlots: v.optional(v.string()),     // JSON array of {id, name, slots: [{d, t, n}]}
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
      detectedServices: args.detectedServices,
      detectedSlots: args.detectedSlots,
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
          // Déjà calculé par le scan — aucun coût supplémentaire côté bot.
          detectedSlots: args.detectedSlots,
        });
      }
    }
  },
});

// ─── Rendu du tableau de créneaux pour l'email admin ─────────────────────────

/** Nombre maximum de lignes rendues dans l'email (garde-fou taille/temps). */
const MAX_SLOT_ROWS = 40;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Construit le tableau HTML « date / heure / places libres » à partir du JSON
 * `detectedSlots` produit par le scan (`[{id, name, slots:[{d, t, n}]}]`).
 *
 * Coût : purement local (parse + concat borné à MAX_SLOT_ROWS). Aucune requête,
 * aucun accès base — l'envoi de l'alerte reste hors du chemin critique de
 * réservation (scheduler.runAfter(0), action asynchrone).
 * Retourne "" si aucune donnée exploitable → l'email garde son ancien format.
 */
function buildSlotsTableHtml(detectedSlots?: string): string {
  if (!detectedSlots) return "";

  let parsed: Array<{ id?: string; name?: string; slots?: Array<{ d?: string; t?: string; n?: number }> }>;
  try {
    parsed = JSON.parse(detectedSlots);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";

  const rows: string[] = [];
  let total = 0;
  let truncated = false;

  for (const service of parsed) {
    const slots = Array.isArray(service?.slots) ? service.slots : [];
    total += slots.length;
    for (const slot of slots) {
      if (!slot?.d) continue;
      if (rows.length >= MAX_SLOT_ROWS) {
        truncated = true;
        continue;
      }
      const places =
        typeof slot.n === "number" && slot.n >= 0 ? String(slot.n) : "—";
      rows.push(`
      <tr>
        <td style="padding: 7px 10px; border-bottom: 1px solid #e5e7eb; font-variant-numeric: tabular-nums;">${escapeHtml(slot.d)}</td>
        <td style="padding: 7px 10px; border-bottom: 1px solid #e5e7eb; font-variant-numeric: tabular-nums;">${escapeHtml(slot.t ?? "—")}</td>
        <td style="padding: 7px 10px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600;">${places}</td>
        <td style="padding: 7px 10px; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">${escapeHtml(service?.name ?? "")}</td>
      </tr>`);
    }
  }

  if (rows.length === 0) return "";

  return `
  <div style="margin-bottom: 24px;">
    <h3 style="font-size: 15px; margin: 0 0 8px; color: #1a1a1a;">📅 Créneaux détectés (${total})</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
      <thead>
        <tr style="background: #f9fafb; text-align: left;">
          <th style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">Date</th>
          <th style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">Heure</th>
          <th style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb; text-align: right;">Places</th>
          <th style="padding: 8px 10px; border-bottom: 1px solid #e5e7eb;">Service</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}
      </tbody>
    </table>
    ${truncated ? `<p style="color: #6b7280; font-size: 12px; margin: 8px 0 0;">… et ${total - rows.length} autre(s) créneau(x) non affiché(s).</p>` : ""}
  </div>`;
}

// ─── Internal: email alert via Resend ────────────────────────────────────────

export const internalSendWatcherAlert = internalAction({
  args: {
    adminEmail: v.string(),
    slotInfo: v.string(),
    portalUrl: v.string(),
    screenshotStorageId: v.optional(v.string()),
    detectedSlots: v.optional(v.string()), // JSON [{id, name, slots:[{d,t,n}]}]
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[SpainWatcher] RESEND_API_KEY non configurée — alerte email ignorée");
      return;
    }

    // ─── Tableau des créneaux (date / heure / places libres) ──────────────────
    // Les données proviennent du scan déjà effectué (champ detectedSlots) :
    // aucun appel réseau supplémentaire, aucun impact sur la latence de booking.
    // Le rendu est purement local et borné à MAX_ROWS lignes.
    const slotsTableHtml = buildSlotsTableHtml(args.detectedSlots);

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

  ${slotsTableHtml}

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


// ─── Mutation: admin lance une commande rush-prep ─────────────────────────────

export const requestRushPrep = mutation({
  args: {
    command: v.union(v.literal("cf_resolve"), v.literal("session_prep")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const existing = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const now = Date.now();
    const patch = {
      rushPrepCommand: args.command,
      rushPrepAt: now,
      rushPrepResult: undefined as string | undefined,
      rushPrepAckedAt: undefined as number | undefined,
      updatedAt: now,
    };

    if (existing) {
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("spainWatcher", {
        key: WATCHER_KEY,
        isActive: false,
        portalUrl: "",
        adminEmail: "",
        updatedAt: now,
        rushPrepCommand: args.command,
        rushPrepAt: now,
      });
    }
  },
});

// ─── Internal: bot acknowledges a rush-prep command ──────────────────────────

export const internalAckRushPrep = internalMutation({
  args: {
    result: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();
    if (!existing) return;

    await ctx.db.patch(existing._id, {
      rushPrepCommand: undefined,
      rushPrepResult: args.result,
      rushPrepAckedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

// ─── Internal: bot polls for pending rush-prep command ────────────────────────

export const internalGetRushPrepCommand = internalMutation({
  args: {},
  handler: async (ctx) => {
    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();
    return watcher?.rushPrepCommand ?? null;
  },
});
