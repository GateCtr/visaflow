import { query, mutation, internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

const WATCHER_KEY = "default";
const MAX_SCANS = 200;

/**
 * Rétention des scans Spain (historique par dossier).
 *
 * Avant : prune par écriture (garder les 200 derniers) à l'intérieur de
 * internalRecordScan — contention sur spainWatcherScans à chaque cycle.
 * Après : rétention basée sur l'âge, exécutée hors chemin d'écriture par le cron
 * internalPruneOldScans (voir crons.ts). Les inserts ne prunent plus.
 */
const SPAIN_SCAN_RETENTION_HOURS = Math.max(
  1,
  Math.min(720, Number(process.env.SPAIN_SCAN_RETENTION_HOURS ?? 48)),
);
const RETENTION_MS = SPAIN_SCAN_RETENTION_HOURS * 3_600_000;

/**
 * Throttle du patch du singleton `spainWatcher` dans internalRecordScan.
 *
 * PROBLÈME résolu : avec N dossiers actifs (ex. 18), chaque worker appelle
 * internalRecordScan à chaque cycle et patchait le MÊME document singleton
 * (lastScanAt/lastResult). N écritures concurrentes sur un seul document →
 * conflits OCC (« Documents ... changed while this mutation was being run »)
 * que Convex ne peut pas résoudre par retry → erreurs 422 + perte de télémétrie.
 *
 * FIX : on ne patche le singleton QUE si (a) le dernier patch date de plus de
 * SINGLETON_PATCH_THROTTLE_MS, OU (b) l'événement est important (found/error qu'on
 * veut toujours refléter dans le dashboard). L'INSERT du scan (historique par
 * dossier, sans conflit car chaque insert crée un doc unique) reste inconditionnel.
 * Ça réduit d'un facteur ~N×(cycles) le nombre d'écritures concurrentes sur le
 * singleton → les rares collisions restantes sont résolues par le retry Convex.
 */
const SINGLETON_PATCH_THROTTLE_MS = 5_000;

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
    applicationId: v.optional(v.string()), // filter by dossier
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const pageSize = Math.min(args.pageSize ?? 20, 50);
    const page = Math.max(0, args.page ?? 0);
    const statusFilter = args.statusFilter;
    const applicationId = args.applicationId;

    // Pagination réelle via index : by_application quand un dossier est ciblé,
    // sinon by_ts (desc). Le filtre statut est appliqué DANS la requête.
    // On matérialise la liste filtrée via .collect() sur l'index approprié
    // (plus de .take(200) global + slice post-filtre) puis on découpe la page.
    const matched = applicationId
      ? await ctx.db
          .query("spainWatcherScans")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .filter((q) =>
            statusFilter ? q.eq(q.field("status"), statusFilter) : true,
          )
          .collect()
      : await ctx.db
          .query("spainWatcherScans")
          .withIndex("by_ts")
          .order("desc")
          .filter((q) =>
            statusFilter ? q.eq(q.field("status"), statusFilter) : true,
          )
          .collect();

    // by_application est ordonné par insertion ; forcer le tri desc par ts pour
    // garder un affichage « plus récent d'abord » cohérent avec le mode by_ts.
    const ordered = applicationId
      ? [...matched].sort((a, b) => b.ts - a.ts)
      : matched;

    const totalCount = ordered.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    const start = page * pageSize;
    const pageScans = ordered.slice(start, start + pageSize);

    // Resolve screenshot URLs
    const scans = await Promise.all(
      pageScans.map(async (scan) => {
        const screenshotUrl = scan.screenshotStorageId
          ? await ctx.storage.getUrl(scan.screenshotStorageId)
          : null;
        return { ...scan, screenshotUrl };
      }),
    );

    // Stats summary — calculées sur l'ensemble filtré (hors statut) pour refléter
    // la ventilation found/not_found/error du périmètre courant.
    const statsSource = applicationId
      ? await ctx.db
          .query("spainWatcherScans")
          .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
          .collect()
      : ordered;
    const stats = {
      total: statsSource.length,
      found: statsSource.filter((s) => s.status === "found").length,
      notFound: statsSource.filter((s) => s.status === "not_found").length,
      errors: statsSource.filter((s) => s.status === "error").length,
    };

    return { watcher: watcher ?? null, scans, page, pageSize, totalCount, totalPages, stats };
  },
});

// ─── Query: liste des dossiers ayant des scans Spain ────────────────────────────

export const getDossierList = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const scans = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_ts")
      .order("desc")
      .take(MAX_SCANS);

    // Dédupliquer par applicationId — retourner nom + ID unique
    const seen = new Map<string, { applicationId: string; dossierName: string; lastScan: number }>();
    for (const scan of scans) {
      if (!scan.applicationId) continue;
      if (!seen.has(scan.applicationId)) {
        seen.set(scan.applicationId, {
          applicationId: scan.applicationId,
          dossierName: scan.dossierName ?? scan.applicationId,
          lastScan: scan.ts,
        });
      }
    }
    return [...seen.values()].sort((a, b) => b.lastScan - a.lastScan);
  },
});

// ─── Query: scans d'un seul dossier (vue per-dossier avec cycles) ───────────────

export const getScansForDossier = query({
  args: {
    applicationId: v.string(),
    page: v.optional(v.number()),
    pageSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown> | null);

    const pageSize = Math.min(args.pageSize ?? 50, 100);
    const page = Math.max(0, args.page ?? 0);

    const all = await ctx.db
      .query("spainWatcherScans")
      .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
      .collect();

    const ordered = [...all].sort((a, b) => b.ts - a.ts);
    const totalCount = ordered.length;
    const totalPages = Math.ceil(totalCount / pageSize);

    const start = page * pageSize;
    const pageScans = ordered.slice(start, start + pageSize);

    const scans = await Promise.all(
      pageScans.map(async (scan) => {
        const screenshotUrl = scan.screenshotStorageId
          ? await ctx.storage.getUrl(scan.screenshotStorageId)
          : null;
        return { ...scan, screenshotUrl };
      }),
    );

    return { scans, page, pageSize, totalCount, totalPages };
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
    applicationId: v.optional(v.string()),  // Dossier associé (worker multi-dossier)
    dossierName: v.optional(v.string()),    // Nom du demandeur
    pageCaptures: v.optional(v.string()),
    detectedServices: v.optional(v.string()),  // JSON array of {serviceId, serviceName}
    detectedSlots: v.optional(v.string()),     // JSON array of {id, name, slots: [{d, t, n}]}
    scanTrace: v.optional(v.string()),         // JSON: SpainScanTrace — main/initConfig/service/agenda/datetime/booking
    cycleNumber: v.optional(v.number()),
    windowId: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();

    const now = Date.now();

    // Insert scan record (historique). Le prune par écriture a été retiré :
    // la rétention est désormais gérée par le cron internalPruneOldScans.
    await ctx.db.insert("spainWatcherScans", {
      ts: now,
      status: args.status,
      slotInfo: args.slotInfo,
      screenshotStorageId: args.screenshotStorageId,
      errorMessage: args.errorMessage,
      applicationId: args.applicationId,
      dossierName: args.dossierName,
      pageCaptures: args.pageCaptures,
      detectedServices: args.detectedServices,
      detectedSlots: args.detectedSlots,
      scanTrace: args.scanTrace,
      cycleNumber: args.cycleNumber,
      windowId: args.windowId,
      idempotencyKey: args.idempotencyKey,
    });

    // Update watcher singleton — THROTTLÉ pour éviter les conflits OCC (voir constante).
    // On ne patche que si un événement important (found) OU si le dernier patch
    // date d'assez longtemps. Sinon on saute le patch (l'insert du scan suffit à
    // l'historique).
    if (watcher) {
      const sinceLastPatch = now - (watcher.updatedAt ?? 0);
      const shouldPatchTelemetry = sinceLastPatch >= SINGLETON_PATCH_THROTTLE_MS;

      const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
      const cooldownOk = now - (watcher.lastAlertSentAt ?? 0) > ALERT_COOLDOWN_MS;
      const shouldAlert = args.status === "found" && !!watcher.adminEmail && cooldownOk;

      if (shouldPatchTelemetry || shouldAlert) {
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
          ...(shouldAlert ? { lastAlertSentAt: now } : {}),
        });

        if (shouldAlert) {
          await ctx.scheduler.runAfter(0, internal.spainWatcher.internalSendWatcherAlert, {
            adminEmail: watcher.adminEmail!,
            slotInfo: args.slotInfo ?? "Créneau disponible",
            portalUrl: watcher.portalUrl,
            screenshotStorageId: args.screenshotStorageId,
            detectedSlots: args.detectedSlots,
            dossierName: args.dossierName,
            serviceName: args.detectedServices,
          });
        }
      }
    }
  },
});

// ─── Internal: INSERT-only batch (sans singleton) ────────────────────────────
//
// Chemin d'écriture principal du worker Spain. CHAQUE élément du batch crée un
// document unique dans spainWatcherScans — aucun accès au singleton `spainWatcher`
// (ni query ni patch) → pas de contention OCC. La dédup par idempotencyKey évite
// les doublons si un batch est rejoué (retry réseau / OCC côté client).

export const internalRecordScanBatch = internalMutation({
  args: {
    scans: v.array(
      v.object({
        status: v.union(v.literal("found"), v.literal("not_found"), v.literal("error")),
        slotInfo: v.optional(v.string()),
        screenshotStorageId: v.optional(v.string()),
        errorMessage: v.optional(v.string()),
        applicationId: v.optional(v.string()),
        dossierName: v.optional(v.string()),
        pageCaptures: v.optional(v.string()),
        detectedServices: v.optional(v.string()),
        detectedSlots: v.optional(v.string()),
        scanTrace: v.optional(v.string()),
        cycleNumber: v.optional(v.number()),
        windowId: v.optional(v.number()),
        idempotencyKey: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ inserted: number; skipped: number }> => {
    let inserted = 0;
    let skipped = 0;

    for (const scan of args.scans) {
      // Dédup : si une clé idempotente est fournie et déjà présente, on saute.
      if (scan.idempotencyKey) {
        const existing = await ctx.db
          .query("spainWatcherScans")
          .withIndex("by_idempotency", (q) => q.eq("idempotencyKey", scan.idempotencyKey))
          .first();
        if (existing) {
          skipped++;
          continue;
        }
      }

      await ctx.db.insert("spainWatcherScans", {
        ts: Date.now(),
        status: scan.status,
        slotInfo: scan.slotInfo,
        screenshotStorageId: scan.screenshotStorageId,
        errorMessage: scan.errorMessage,
        applicationId: scan.applicationId,
        dossierName: scan.dossierName,
        pageCaptures: scan.pageCaptures,
        detectedServices: scan.detectedServices,
        detectedSlots: scan.detectedSlots,
        scanTrace: scan.scanTrace,
        cycleNumber: scan.cycleNumber,
        windowId: scan.windowId,
        idempotencyKey: scan.idempotencyKey,
      });
      inserted++;
    }

    return { inserted, skipped };
  },
});

// ─── Internal: patch télémétrie singleton + alerte email (best-effort) ────────
//
// Extrait de l'ancien internalRecordScan. Appelé séparément (best-effort) après
// l'insert batch pour rafraîchir le résumé dashboard sans bloquer l'historique.
// Conserve le throttle SINGLETON_PATCH_THROTTLE_MS et le cooldown found 30 min.

export const internalTouchSingleton = internalMutation({
  args: {
    status: v.union(v.literal("found"), v.literal("not_found"), v.literal("error")),
    slotInfo: v.optional(v.string()),
    detectedSlots: v.optional(v.string()),
    detectedServices: v.optional(v.string()),
    dossierName: v.optional(v.string()),
    screenshotStorageId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<void> => {
    const watcher = await ctx.db
      .query("spainWatcher")
      .withIndex("by_key", (q) => q.eq("key", WATCHER_KEY))
      .first();
    if (!watcher) return;

    const now = Date.now();
    const sinceLastPatch = now - (watcher.updatedAt ?? 0);
    const shouldPatchTelemetry = sinceLastPatch >= SINGLETON_PATCH_THROTTLE_MS;

    const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
    const cooldownOk = now - (watcher.lastAlertSentAt ?? 0) > ALERT_COOLDOWN_MS;
    const shouldAlert = args.status === "found" && !!watcher.adminEmail && cooldownOk;

    if (!shouldPatchTelemetry && !shouldAlert) return;

    const consecutiveErrors =
      args.status === "error" ? (watcher.consecutiveErrors ?? 0) + 1 : 0;

    await ctx.db.patch(watcher._id, {
      lastScanAt: now,
      lastResult: args.status,
      lastSlotInfo: args.slotInfo,
      consecutiveErrors,
      updatedAt: now,
      ...(shouldAlert ? { lastAlertSentAt: now } : {}),
    });

    if (shouldAlert) {
      await ctx.scheduler.runAfter(0, internal.spainWatcher.internalSendWatcherAlert, {
        adminEmail: watcher.adminEmail!,
        slotInfo: args.slotInfo ?? "Créneau disponible",
        portalUrl: watcher.portalUrl,
        screenshotStorageId: args.screenshotStorageId,
        detectedSlots: args.detectedSlots,
        dossierName: args.dossierName,
        serviceName: args.detectedServices,
      });
    }
  },
});

// ─── Internal: rétention basée sur l'âge (appelée par cron) ───────────────────

export const internalPruneOldScans = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ deleted: number }> => {
    const cutoff = Date.now() - RETENTION_MS;
    let deleted = 0;

    // Boucle batchée : les rows les plus anciennes d'abord (by_ts asc), on
    // supprime tant que ts < cutoff.
    for (;;) {
      const batch = await ctx.db
        .query("spainWatcherScans")
        .withIndex("by_ts", (q) => q.lt("ts", cutoff))
        .order("asc")
        .take(200);
      if (batch.length === 0) break;

      for (const scan of batch) {
        if (scan.screenshotStorageId) {
          try {
            await ctx.storage.delete(scan.screenshotStorageId as any);
          } catch { /* ignore si déjà supprimé */ }
        }
        await ctx.db.delete(scan._id);
        deleted++;
      }

      if (batch.length < 200) break;
    }

    return { deleted };
  },
});

// ─── Internal: email alert via Resend ────────────────────────────────────────

export const internalSendWatcherAlert = internalAction({
  args: {
    adminEmail: v.string(),
    slotInfo: v.string(),
    portalUrl: v.string(),
    screenshotStorageId: v.optional(v.string()),
    detectedSlots: v.optional(v.string()),
    dossierName: v.optional(v.string()),
    serviceName: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn("[SpainWatcher] RESEND_API_KEY non configurée — alerte email ignorée");
      return;
    }

    // Parse detectedSlots pour le tableau HTML
    let slotsTable = "";
    if (args.detectedSlots) {
      try {
        const slots = JSON.parse(args.detectedSlots) as Array<{ d: string; t: string; n: number }>;
        if (slots.length > 0) {
          // Extraire le nom du service si disponible
          let serviceName = "TRAMITACIÓN DE VISADOS";
          if (args.serviceName) {
            try {
              const svcs = JSON.parse(args.serviceName) as Array<{ serviceName: string }>;
              if (svcs[0]?.serviceName) serviceName = svcs[0].serviceName;
            } catch { /* ignore */ }
          }

          const rows = slots.map((s) => `
            <tr>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${s.d}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb;">${s.t || "—"}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; text-align: center;">${s.n > 0 ? s.n : "—"}</td>
              <td style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #6b7280; font-size: 12px;">${serviceName}</td>
            </tr>`).join("");

          slotsTable = `
          <div style="margin: 20px 0;">
            <h3 style="font-size: 14px; color: #374151; margin-bottom: 8px;">📅 Créneaux détectés (${slots.length})</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
              <thead>
                <tr style="background: #f9fafb;">
                  <th style="padding: 8px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Date</th>
                  <th style="padding: 8px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Heure</th>
                  <th style="padding: 8px 12px; text-align: center; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Places</th>
                  <th style="padding: 8px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e7eb;">Service</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
        }
      } catch { /* ignore parse errors */ }
    }

    const dossierLine = args.dossierName
      ? `<p style="color: #6b7280; font-size: 12px; margin: 4px 0 0;">Dossier : <strong>${args.dossierName}</strong></p>`
      : "";

    const html = `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><title>Créneau Espagne trouvé</title></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
  <div style="background: linear-gradient(135deg, #c60b1e 0%, #f1bf00 100%); border-radius: 12px; padding: 24px; margin-bottom: 24px; text-align: center;">
    <h1 style="color: white; margin: 0; font-size: 24px;">🇪🇸 Créneau Espagne Disponible !</h1>
  </div>

  <div style="background: #f0fdf4; border: 2px solid #16a34a; border-radius: 10px; padding: 20px; margin-bottom: 20px;">
    <h2 style="color: #15803d; margin-top: 0; font-size: 18px;">✅ Créneau trouvé</h2>
    <p style="font-size: 16px; font-weight: 600; margin: 0 0 4px;">${args.slotInfo}</p>
    ${dossierLine}
  </div>

  ${slotsTable}

  <p style="color: #444; font-size: 14px; margin-bottom: 16px;">
    Le veilleur automatique Espagne a détecté une disponibilité sur le portail <a href="${args.portalUrl}" style="color: #c60b1e;">citaconsular.es</a>.
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
      // Singleton doesn't exist yet — create a minimal one
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
    result: v.string(), // "ok" | "error: <message>"
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
