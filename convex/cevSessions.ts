import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
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
const GET_EAPPOINTMENT_REGEX = /^https:\/\/visaonweb\.diplomatie\.be\/Common\/GetEAppointmentUrl\?id=[0-9a-f-]{36}$/i;

function validateIntegrationUrl(url: string): string {
  const trimmed = url.trim();
  const isDirectIntegration =
    trimmed.startsWith("https://appointment.cloud.diplomatie.be/") && GUID_REGEX.test(trimmed);
  const isVowintRedirect = GET_EAPPOINTMENT_REGEX.test(trimmed);

  if (!isDirectIntegration && !isVowintRedirect) {
    throw new Error(
      "URL invalide. Formats acceptés: " +
      "1) https://appointment.cloud.diplomatie.be/Integration/VOW/{guid}/{guid}/{guid}/{guid}/... " +
      "2) https://visaonweb.diplomatie.be/Common/GetEAppointmentUrl?id={guid}",
    );
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
// Mode VOWINT credentials (recommandé) : fournir vowintEmail + vowintPassword.
//   → le bot se connecte à VOWINT, clique RDV, résout hCaptcha, stocke le cookie.
//   → status "needs_setup" ; integrationUrl sera rempli automatiquement après setup.
// Mode URL legacy (compatibilité) : fournir integrationUrl + optionnellement sessionCookie.
//   → si cookie fourni : status "active" immédiat.
//   → si cookie absent : le bot navigue vers l'URL directe, résout hCaptcha.
export const upsertSession = mutation({
  args: {
    applicationId: v.id("applications"),
    // Mode credentials VOWINT (prioritaire)
    vowintEmail: v.optional(v.string()),
    vowintPassword: v.optional(v.string()),
    vowintAppUrl: v.optional(v.string()), // URL dossier (vide = auto-détection)
    // Mode URL legacy
    integrationUrl: v.optional(v.string()),
    sessionCookie: v.optional(v.string()),
    notes: v.optional(v.string()),
    pollIntervalMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const now = Date.now();
    const useCredentials = !!(args.vowintEmail && args.vowintPassword);

    let url: string;
    let cookie: string;
    let status: "active" | "needs_setup";

    if (useCredentials) {
      // Mode credentials : le bot découvrira l'URL après login VOWINT
      if (!args.vowintEmail?.trim()) throw new Error("Email VOWINT requis");
      if (!args.vowintPassword?.trim()) throw new Error("Mot de passe VOWINT requis");
      url = "pending"; // sera rempli par le bot après setup
      cookie = "";
      status = "needs_setup";
    } else {
      // Mode URL legacy
      const rawUrl = args.integrationUrl?.trim() ?? "";
      if (!rawUrl) throw new Error("URL d'intégration ou identifiants VOWINT requis");
      url = validateIntegrationUrl(rawUrl);
      cookie = args.sessionCookie ? sanitizeCookie(args.sessionCookie) : "";
      status = cookie ? "active" : "needs_setup";
    }

    // Expirer les sessions actives/needs_setup existantes pour ce dossier
    const existing = await ctx.db
      .query("cevSessions")
      .withIndex("by_application", q => q.eq("applicationId", args.applicationId))
      .collect();

    for (const s of existing) {
      if (s.status === "active" || s.status === "needs_setup") {
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
      status,
      checkCount: 0,
      consecutiveErrors: 0,
      pollIntervalMs,
      createdAt: now,
      notes: args.notes,
      vowintEmail: args.vowintEmail?.trim(),
      vowintPassword: args.vowintPassword?.trim(),
      vowintAppUrl: args.vowintAppUrl?.trim() || undefined,
    });

    return { sessionId: id, status };
  },
});

// ─── ADMIN: pause / reprise / suppression ───────────────────────────────────
export const setSessionStatus = mutation({
  args: {
    sessionId: v.id("cevSessions"),
    status: v.union(v.literal("active"), v.literal("needs_setup"), v.literal("expired"), v.literal("paused")),
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
    // Quand l'ADMIN relance manuellement le setup, on remet les compteurs à zéro
    // (action volontaire après vérification des identifiants)
    if (args.status === "needs_setup") {
      patch.loginFailCount = 0;
      patch.lastError = undefined;
      patch.lockedUntil = 0;
      patch.consecutiveErrors = 0;
    }
    await ctx.db.patch(args.sessionId, patch);
  },
});

// ─── ADMIN: corriger les identifiants VOWINT et relancer le setup ────────────
// Met à jour email/mot de passe, remet loginFailCount à 0 et repasse en needs_setup.
// L'admin utilise ce bouton après avoir corrigé des identifiants incorrects.
export const updateVowintCredentials = mutation({
  args: {
    sessionId: v.id("cevSessions"),
    vowintEmail: v.string(),
    vowintPassword: v.string(),
    vowintAppUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error("Session introuvable");

    if (!args.vowintEmail.trim()) throw new Error("Email VOWINT requis");
    if (!args.vowintPassword.trim()) throw new Error("Mot de passe VOWINT requis");

    await ctx.db.patch(args.sessionId, {
      vowintEmail: args.vowintEmail.trim(),
      vowintPassword: args.vowintPassword.trim(),
      vowintAppUrl: args.vowintAppUrl?.trim() || undefined,
      // Remettre les compteurs à zéro + relancer le setup
      loginFailCount: 0,
      consecutiveErrors: 0,
      lastError: undefined,
      lockedUntil: 0,
      status: "needs_setup",
    });
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
        sessionCookiePreview: s.sessionCookie && s.sessionCookie.length >= 4
          ? s.sessionCookie.slice(0, 4) + "…" + s.sessionCookie.slice(-3)
          : s.sessionCookie
            ? s.sessionCookie
            : "(en attente bot)",
        applicantName: app?.applicantName ?? "(dossier supprimé)",
        destination: app?.destination ?? "",
        visaType: app?.visaType ?? "",
      };
    }));
    return enriched;
  },
});

// ─── INTERNAL: activer une session après setup bot (cookie nouvellement établi) ─
export const internalActivateSession = internalMutation({
  args: {
    sessionId: v.id("cevSessions"),
    sessionCookie: v.string(),
    validUntilMs: v.optional(v.number()),      // timestamp UTC ms d'expiration estimée
    integrationUrl: v.optional(v.string()),    // URL découverte par le bot lors du login VOWINT
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return;

    const now = Date.now();
    
    // Calculer la durée de polling cumulée si la session avait déjà été active
    const previousDuration = session.totalPollingDurationMs ?? 0;
    const lastActiveDuration = session.lastCheckAt && session.activatedAt 
      ? session.lastCheckAt - session.activatedAt 
      : 0;
    
    // Incrémenter le compteur de renouvellements si ce n'est pas la première activation
    const renewalCount = session.activatedAt 
      ? (session.autoRenewalCount ?? 0) + 1 
      : (session.autoRenewalCount ?? 0);

    const patch: Record<string, unknown> = {
      sessionCookie: args.sessionCookie,
      status: "active",
      lastCheckAt: now,
      consecutiveErrors: 0,
      lockedUntil: 0,
      activatedAt: now,
      validUntilMs: args.validUntilMs,
      lastSuccessfulSetupAt: now,
      autoRenewalCount: renewalCount,
      lastAutoRenewalAt: renewalCount > 0 ? now : undefined,
      totalPollingDurationMs: previousDuration + lastActiveDuration,
      // Reset loginFailCount sur activation réussie — le setup a fonctionné,
      // donc les identifiants sont bons et VOWINT n'est pas en rate-limit.
      loginFailCount: 0,
    };

    // Si le bot a découvert l'URL d'intégration (mode credentials), la stocker
    if (args.integrationUrl && args.integrationUrl !== "pending") {
      patch.integrationUrl = args.integrationUrl;
    }

    await ctx.db.patch(args.sessionId, patch);
  },
});

// ─── INTERNAL: claim atomique des sessions needs_setup (bot doit établir la session)
export const internalClaimNeedsSetup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const LOCK_DURATION_MS = 13 * 60_000; // 13 min — respecte la limite VOWINT de 5 clics/heure (60/5=12 min)

    const sessions = await ctx.db
      .query("cevSessions")
      .withIndex("by_status", q => q.eq("status", "needs_setup"))
      .collect();

    const claimed: Array<{
      sessionId: Id<"cevSessions">;
      applicationId: Id<"applications">;
      integrationUrl: string;
      pollIntervalMs: number;
      // Identifiants VOWINT (mode credentials) — présents si l'admin a choisi ce mode
      vowintEmail?: string;
      vowintPassword?: string;
      vowintAppUrl?: string;
      siphonedF5CookieValue?: string;
      siphonedF5CookieName?: string;
      siphonedAspNetSessionId?: string;
      siphonedUserAgent?: string;
      siphonedAt?: number;
      siphonedValidUntil?: number;
    }> = [];

    for (const s of sessions) {
      const locked = (s.lockedUntil ?? 0) > now;
      if (locked) continue;

      // ── Guard rate-limit : ne pas claim si la session a été rate-limitée récemment ──
      // Même si lockedUntil a expiré (13 min), vérifier si la dernière erreur indique
      // un rate-limit VOWINT et si le temps écoulé depuis est < 60 min.
      // Cela protège contre les cas où le lock de 13 min expire avant le blocage
      // VOWINT réel de 60 min (ex: si recordCevSetupLoginFail n'a pas été appelé
      // correctement, ou si le bot a redémarré et le lock a été reset par erreur).
      const lastError = (s.lastError ?? "") + " " + (s.lastSetupError ?? "");
      const isRecentRateLimit = (
        lastError.includes("RATE_LIMIT") ||
        lastError.includes("TooManyAttempts") ||
        lastError.includes("IMPLICIT_RATE_LIMIT")
      );
      if (isRecentRateLimit) {
        // Calculer le temps depuis la dernière tentative ratée
        const lastAttemptAt = s.lastCheckAt ?? s.lockedUntil ?? 0;
        const timeSinceLastAttempt = now - lastAttemptAt;
        const RATE_LIMIT_COOLDOWN_MS = 60 * 60_000; // 60 min = durée blocage VOWINT
        if (timeSinceLastAttempt < RATE_LIMIT_COOLDOWN_MS) {
          // Encore dans la fenêtre de cooldown VOWINT → skip ET re-poser le lock
          // pour éviter que le prochain cycle ne le claim
          const remainingMs = RATE_LIMIT_COOLDOWN_MS - timeSinceLastAttempt;
          await ctx.db.patch(s._id, { lockedUntil: now + remainingMs });
          continue;
        }
        // 60 min écoulées → le rate-limit VOWINT est expiré, on peut retenter
        // Reset lastError pour ne pas re-trigger cette garde au prochain cycle
        // (si le setup réussit, loginFailCount sera reset par internalActivateSession)
      }

      await ctx.db.patch(s._id, { lockedUntil: now + LOCK_DURATION_MS });
      claimed.push({
        sessionId: s._id,
        applicationId: s.applicationId,
        integrationUrl: s.integrationUrl,
        pollIntervalMs: s.pollIntervalMs ?? 30_000,
        vowintEmail: s.vowintEmail,
        vowintPassword: s.vowintPassword,
        vowintAppUrl: s.vowintAppUrl,
        siphonedF5CookieValue: s.siphonedF5CookieValue,
        siphonedF5CookieName: s.siphonedF5CookieName,
        siphonedAspNetSessionId: s.siphonedAspNetSessionId,
        siphonedUserAgent: s.siphonedUserAgent,
        siphonedAt: s.siphonedAt,
        siphonedValidUntil: s.siphonedValidUntil,
      });
    }

    return claimed;
  },
});

// ─── INTERNAL: déverrouiller une session needs_setup après timeout bot ────────
// Permet au bot de re-tenter immédiatement après un crash/timeout Playwright.
export const internalResetSetupLock = internalMutation({
  args: { sessionId: v.id("cevSessions") },
  handler: async (ctx, { sessionId }) => {
    const s = await ctx.db.get(sessionId);
    if (!s || s.status !== "needs_setup") return;
    await ctx.db.patch(sessionId, { lockedUntil: 0 });
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
      vowintEmail?: string;
      vowintPassword?: string;
      vowintAppUrl?: string;
      siphonedF5CookieValue?: string;
      siphonedF5CookieName?: string;
      siphonedAspNetSessionId?: string;
      siphonedUserAgent?: string;
      siphonedAt?: number;
      siphonedValidUntil?: number;
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
        vowintEmail: s.vowintEmail,
        vowintPassword: s.vowintPassword,
        vowintAppUrl: s.vowintAppUrl,
        siphonedF5CookieValue: s.siphonedF5CookieValue,
        siphonedF5CookieName: s.siphonedF5CookieName,
        siphonedAspNetSessionId: s.siphonedAspNetSessionId,
        siphonedUserAgent: s.siphonedUserAgent,
        siphonedAt: s.siphonedAt,
        siphonedValidUntil: s.siphonedValidUntil,
      });
    }
    return claimed;
  },
});

// ─── INTERNAL: enregistrer un échec de login VOWINT lors du setup ────────────
// Incrémente loginFailCount (persisté → survie aux redémarrages Railway).
// Après MAX_LOGIN_FAILS (3) → status = "paused" + notification admin.
const MAX_LOGIN_FAILS = 3;
export const internalRecordSetupLoginFail = internalMutation({
  args: {
    sessionId: v.id("cevSessions"),
    errorDetail: v.optional(v.string()),
  },
  handler: async (ctx, { sessionId, errorDetail }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return { loginFailCount: 0, paused: false };

    const now = Date.now();
    const loginFailCount = (session.loginFailCount ?? 0) + 1;
    const setupAttempts = (session.setupAttempts ?? 0) + 1;
    const shouldPause = loginFailCount >= MAX_LOGIN_FAILS;

    const patch: Record<string, unknown> = {
      loginFailCount,
      setupAttempts,
      // Backoff progressif selon le type d'erreur et le nombre d'échecs :
      // - TooManyAttempts/RATE_LIMIT : lock 60 min (durée du blocage VOWINT)
      // - Autres échecs : lock progressif 2min → 5min → 10min selon le nombre d'échecs
      lockedUntil: (() => {
        const isTooManyAttempts = errorDetail && (
          errorDetail.includes("TooManyAttempts") || errorDetail.includes("RATE_LIMIT")
        );
        if (isTooManyAttempts) {
          return now + 60 * 60_000; // 60 min — VOWINT bloque pendant 1 heure
        }
        // Backoff progressif pour les autres erreurs
        const backoffMinutes = loginFailCount === 1 ? 2 : loginFailCount === 2 ? 5 : 10;
        return now + backoffMinutes * 60_000;
      })(),
      lastError: errorDetail ?? `VOWINT login failed (attempt ${loginFailCount})`,
      lastSetupError: errorDetail ?? `VOWINT login failed (attempt ${loginFailCount})`,
    };

    if (shouldPause) {
      patch.status = "paused";
      patch.notes = [
        session.notes,
        `[Auto-pause] ${loginFailCount} échecs de login VOWINT consécutifs depuis le dernier reset — vérifier les identifiants VOWINT dans Convex.`,
      ].filter(Boolean).join('\n');
    }

    await ctx.db.patch(sessionId, patch);

    // Notifier les admins si session auto-pausée
    if (shouldPause) {
      const app = await ctx.db.get(session.applicationId);
      if (app) {
        const admins = await ctx.db
          .query("users")
          .filter(q => q.eq(q.field("role"), "admin"))
          .collect();
        for (const admin of admins) {
          await ctx.db.insert("notifications", {
            userId: admin.clerkId,
            type: "cev_setup_login_failed",
            title: `🔐 Session CEV pausée — ${app.applicantName}`,
            body: `${loginFailCount} tentatives de login VOWINT ont échoué pour ${app.applicantName}. Vérifiez les identifiants VOWINT dans la section CEV Sessions.${errorDetail ? ` Erreur: ${errorDetail}` : ''}`,
            applicationId: session.applicationId,
            read: false,
            createdAt: now,
          });
        }
      }
    }

    return { loginFailCount, paused: shouldPause };
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
      // Calculer la durée de polling avant expiration
      const pollingDuration = session.activatedAt 
        ? now - session.activatedAt 
        : 0;
      patch.totalPollingDurationMs = (session.totalPollingDurationMs ?? 0) + pollingDuration;
      
      // Si le bot demande un auto-renewal (credentials VOWINT disponibles),
      // remettre en needs_setup au lieu d'expirer définitivement.
      if (args.error === "auto_renewal_requested" && session.vowintEmail) {
        patch.status = "needs_setup";
        // NE PAS remettre loginFailCount à 0 ici — sinon le compteur d'échecs
        // ne s'accumule jamais et l'auto-pause (3 échecs) ne se déclenche pas
        // quand VOWINT rate-limit le compte (TooManyAttempts).
        // Le loginFailCount n'est remis à 0 que manuellement par l'admin
        // (updateVowintCredentials) ou après un setup RÉUSSI.
        // Ajouter un délai de 3 min entre auto-renewals pour éviter de spam VOWINT.
        patch.lockedUntil = now + 3 * 60_000;
      } else {
        patch.status = "expired";
        patch.expiredAt = now;
      }
    } else if (consecutiveErrors >= 10) {
      patch.status = "expired";
      patch.expiredAt = now;
    }

    // Anti-spam slot : dès qu'un slot est trouvé, on PAUSE la session
    // et on marque slotNotifiedAt. Admin doit la réactiver après réservation.
    let shouldNotifySlot = false;
    if (args.result === "slot_found") {
      // Incrémenter le compteur de slots trouvés
      const slotsFoundCount = (session.slotsFoundCount ?? 0) + 1;
      patch.slotsFoundCount = slotsFoundCount;
      patch.lastSlotFoundAt = now;
      
      if (!session.slotNotifiedAt) {
        shouldNotifySlot = true;
        patch.slotNotifiedAt = now;
        patch.status = "paused"; // stoppe le polling
      }
      // Si déjà notifié → on n'envoie rien et on a quand-même posé status=paused
      // (l'admin devra la réactiver explicitement)
    }

    await ctx.db.patch(args.sessionId, patch);

    // Notifier l'admin si nouveau slot OU session expirée définitivement (pas auto-renewal)
    const isDefinitiveExpiry = args.result === "session_expired" && args.error !== "auto_renewal_requested";
    if (shouldNotifySlot || isDefinitiveExpiry) {
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
              : session.vowintEmail
                ? `La session CEV pour ${app.applicantName} a expiré. Le bot va tenter une reconnexion automatique via VOWINT.`
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



// ─── INTERNAL: lecture des credentials VOWINT SANS lock ──────────────────────
// Utilisé par le dossier-loop pour obtenir les identifiants VOWINT sans
// poser de lock ni vérifier les conditions de timing/rate-limit.
// Retourne le premier couple vowintEmail/vowintPassword trouvé parmi
// toutes les sessions CEV (tous statuts sauf expired).
export const internalGetCredentials = internalQuery({
  args: {},
  handler: async (ctx) => {
    const allSessions = await ctx.db
      .query("cevSessions")
      .collect();

    for (const s of allSessions) {
      if (s.status === "expired") continue;
      if (s.vowintEmail && s.vowintPassword) {
        return {
          vowintEmail: s.vowintEmail,
          vowintPassword: s.vowintPassword,
          vowintAppUrl: s.vowintAppUrl,
          sessionId: s._id,
          applicationId: s.applicationId,
          status: s.status,
        };
      }
    }

    return null;
  },
});

// ─── INTERNAL: injecter des cookies F5 siphonnés pour une session CEV ───────────
export const internalInjectF5Cookies = internalMutation({
  args: {
    sessionId: v.id("cevSessions"),
    f5CookieValue: v.string(), // from sessionWorker.ts
    f5CookieName: v.string(), // from sessionWorker.ts
    aspNetSessionId: v.optional(v.string()),
    userAgent: v.string(),
    validityMinutes: v.optional(v.number()),
    // Also support the original name for backwards compatibility
    f5TsCookieValue: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { ok: false, error: "Session not found" };

    const now = Date.now();
    const actualF5Value = args.f5CookieValue ?? args.f5TsCookieValue;
    const actualF5Name = args.f5CookieName ?? "TS0110ceb4";
    const validityMs = (args.validityMinutes ?? 480) * 60 * 1000; // default 8h = 480 min

    if (!actualF5Value) {
      return { ok: false, error: "f5CookieValue or f5TsCookieValue is required" };
    }

    await ctx.db.patch(args.sessionId, {
      siphonedF5CookieValue: actualF5Value,
      siphonedF5CookieName: actualF5Name,
      siphonedAspNetSessionId: args.aspNetSessionId,
      siphonedUserAgent: args.userAgent,
      siphonedAt: now,
      siphonedValidUntil: now + validityMs,
    });

    return { ok: true };
  },
});
