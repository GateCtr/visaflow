import { mutation, query, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  return "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}

const GUID_REGEX = /\/Integration\/VOW\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([0-9a-f-]{36})\//i;

function validateIntegrationUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://appointment.cloud.diplomatie.be/")) {
    throw new Error("L'URL doit commencer par https://appointment.cloud.diplomatie.be/");
  }
  if (!GUID_REGEX.test(trimmed)) {
    throw new Error("L'URL doit contenir 4 identifiants GUID (format /Integration/VOW/{guid}/{guid}/{guid}/{guid}/...)");
  }
  return trimmed;
}

function sanitizeCookie(cookie: string): string {
  let value = cookie.trim();
  // Si le user colle "ASP.NET_SessionId=xxx", on extrait juste xxx
  const eqIdx = value.indexOf("=");
  if (eqIdx > 0 && value.slice(0, eqIdx).trim().toLowerCase() === "asp.net_sessionid") {
    value = value.slice(eqIdx + 1).trim();
  }
  // Enlever un éventuel `;` final
  if (value.endsWith(";")) value = value.slice(0, -1).trim();
  if (!/^[a-z0-9]{16,40}$/i.test(value)) {
    throw new Error("Format cookie invalide (attendu: ~24 caractères alphanumériques)");
  }
  return value;
}

// ─── ADMIN: créer ou rafraîchir une session CEV ─────────────────────────────
export const upsertSession = mutation({
  args: {
    applicationId: v.id("applications"),
    integrationUrl: v.string(),
    sessionCookie: v.string(),
    notes: v.optional(v.string()),
    pollIntervalMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const url = validateIntegrationUrl(args.integrationUrl);
    const cookie = sanitizeCookie(args.sessionCookie);
    const now = Date.now();

    // Une seule session active par dossier — on remplace l'existante si présente
    const existing = await ctx.db
      .query("cevSessions")
      .withIndex("by_application", q => q.eq("applicationId", args.applicationId))
      .collect();

    for (const s of existing) {
      if (s.status === "active") {
        await ctx.db.patch(s._id, { status: "expired", expiredAt: now });
      }
    }

    // Borner pollIntervalMs : min 10s (anti-DoS), max 10min, défaut 30s
    const POLL_MIN = 10_000;
    const POLL_MAX = 600_000;
    const requested = args.pollIntervalMs ?? 30_000;
    const pollIntervalMs = Math.max(POLL_MIN, Math.min(POLL_MAX, requested));

    const id = await ctx.db.insert("cevSessions", {
      applicationId: args.applicationId,
      integrationUrl: url,
      sessionCookie: cookie,
      status: "active",
      checkCount: 0,
      consecutiveErrors: 0,
      pollIntervalMs,
      createdAt: now,
      notes: args.notes,
    });

    return { sessionId: id };
  },
});

// ─── ADMIN: pause / reprise / suppression ───────────────────────────────────
export const setSessionStatus = mutation({
  args: {
    sessionId: v.id("cevSessions"),
    status: v.union(v.literal("active"), v.literal("expired"), v.literal("paused")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session introuvable");

    const patch: Record<string, unknown> = { status: args.status };
    if (args.status === "expired" && !session.expiredAt) {
      patch.expiredAt = Date.now();
    }
    await ctx.db.patch(args.sessionId, patch);
  },
});

export const deleteSession = mutation({
  args: { sessionId: v.id("cevSessions") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);
    await ctx.db.delete(args.sessionId);
  },
});

// ─── ADMIN: liste de toutes les sessions (UI dashboard) ─────────────────────
export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const sessions = await ctx.db.query("cevSessions").order("desc").collect();
    const enriched = await Promise.all(sessions.map(async (s) => {
      const app = await ctx.db.get(s.applicationId);
      return {
        ...s,
        // Ne JAMAIS renvoyer le cookie complet à l'UI (sécurité)
        sessionCookie: undefined,
        sessionCookiePreview: s.sessionCookie.slice(0, 4) + "…" + s.sessionCookie.slice(-3),
        applicantName: app?.applicantName ?? "(dossier supprimé)",
        destination: app?.destination ?? "",
        visaType: app?.visaType ?? "",
      };
    }));
    return enriched;
  },
});

// ─── INTERNAL: claim atomique des sessions dues (anti-doublon multi-instance) ─
// On retourne uniquement les sessions :
// - status === "active"
// - dont l'intervalle de poll est échu (lastCheckAt + pollIntervalMs < now)
// - non lockées (lockedUntil < now ou absent)
// Et on pose un lock de 30s pour empêcher un autre worker de la prendre.
export const internalClaimDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const LOCK_DURATION_MS = 30_000;

    const sessions = await ctx.db
      .query("cevSessions")
      .withIndex("by_status", q => q.eq("status", "active"))
      .collect();

    const claimed: Array<{
      sessionId: Id<"cevSessions">;
      applicationId: Id<"applications">;
      integrationUrl: string;
      sessionCookie: string;
      pollIntervalMs: number;
    }> = [];

    for (const s of sessions) {
      const interval = s.pollIntervalMs ?? 30_000;
      const lastCheck = s.lastCheckAt ?? 0;
      const due = now - lastCheck >= interval;
      const locked = (s.lockedUntil ?? 0) > now;
      if (!due || locked) continue;

      // Claim atomique
      await ctx.db.patch(s._id, { lockedUntil: now + LOCK_DURATION_MS });
      claimed.push({
        sessionId: s._id,
        applicationId: s.applicationId,
        integrationUrl: s.integrationUrl,
        sessionCookie: s.sessionCookie,
        pollIntervalMs: interval,
      });
    }
    return claimed;
  },
});

// ─── INTERNAL: enregistrer le résultat d'un check ───────────────────────────
export const internalRecordCheck = internalMutation({
  args: {
    sessionId: v.id("cevSessions"),
    result: v.union(
      v.literal("no_slot"),
      v.literal("slot_found"),
      v.literal("session_expired"),
      v.literal("error")
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;

    const now = Date.now();
    const checkCount = (session.checkCount ?? 0) + 1;
    let consecutiveErrors = session.consecutiveErrors ?? 0;
    if (args.result === "error") consecutiveErrors += 1;
    else consecutiveErrors = 0;

    const patch: Record<string, unknown> = {
      lastResult: args.result,
      lastCheckAt: now,
      checkCount,
      consecutiveErrors,
      lastError: args.error,
      // Toujours libérer le lock après un check
      lockedUntil: 0,
    };

    // Auto-expire la session si cookie mort ou trop d'erreurs
    if (args.result === "session_expired") {
      patch.status = "expired";
      patch.expiredAt = now;
    } else if (consecutiveErrors >= 10) {
      patch.status = "expired";
      patch.expiredAt = now;
    }

    // Anti-spam slot : dès qu'un slot est trouvé, on PAUSE la session
    // et on marque slotNotifiedAt. Admin doit la réactiver après réservation.
    let shouldNotifySlot = false;
    if (args.result === "slot_found") {
      if (!session.slotNotifiedAt) {
        shouldNotifySlot = true;
        patch.slotNotifiedAt = now;
        patch.status = "paused"; // stoppe le polling
      }
      // Si déjà notifié → on n'envoie rien et on a quand-même posé status=paused
      // (l'admin devra la réactiver explicitement)
    }

    await ctx.db.patch(args.sessionId, patch);

    // Notifier l'admin si nouveau slot OU session expirée
    if (shouldNotifySlot || args.result === "session_expired") {
      const app = await ctx.db.get(session.applicationId);
      if (app) {
        // Trouver tous les admins
        const admins = await ctx.db
          .query("users")
          .filter(q => q.eq(q.field("role"), "admin"))
          .collect();

        const isSlot = args.result === "slot_found";
        for (const admin of admins) {
          await ctx.db.insert("notifications", {
            userId: admin.clerkId,
            type: isSlot ? "cev_slot_found" : "cev_session_expired",
            title: isSlot
              ? `🚨 Créneau CEV trouvé — ${app.applicantName}`
              : `⏱️ Session CEV expirée — ${app.applicantName}`,
            body: isSlot
              ? `Un créneau est disponible pour ${app.applicantName} (${app.destination}). Connectez-vous immédiatement au portail VOWINT pour réserver.`
              : `Le cookie de session pour ${app.applicantName} a expiré. Re-fournissez un nouveau cookie depuis l'admin pour relancer le polling.`,
            applicationId: session.applicationId,
            read: false,
            createdAt: now,
          });
        }
      }
    }
  },
});
