import { internalMutation, mutation, internalQuery, query, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { coreMarkSlotFound } from "./slotFoundHelper";
import { VISA_PRICING } from "./constants";

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


export const setHunterConfig = mutation({
  args: {
    applicationId: v.id("applications"),
    embassyUsername: v.string(),
    embassyPassword: v.string(),
    isActive: v.boolean(),
    twoCaptchaApiKey: v.optional(v.string()),
    scheduleUrl: v.optional(v.string()),
    portalApplicationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const existing = (app as { hunterConfig?: { checkCount?: number; lastCheckAt?: number; lastResult?: string; twoCaptchaApiKey?: string; scheduleUrl?: string; portalApplicationId?: string } }).hunterConfig;

    await ctx.db.patch(args.applicationId, {
      hunterConfig: {
        embassyUsername: args.embassyUsername,
        embassyPassword: args.embassyPassword,
        isActive: args.isActive,
        twoCaptchaApiKey: args.twoCaptchaApiKey ?? existing?.twoCaptchaApiKey,
        scheduleUrl: args.scheduleUrl || existing?.scheduleUrl,
        portalApplicationId: args.portalApplicationId || existing?.portalApplicationId,
        lastCheckAt: existing?.lastCheckAt,
        checkCount: existing?.checkCount ?? 0,
        lastResult: existing?.lastResult,
      },
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

export const resetHunterConfig = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      hunterConfig: undefined,
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});

export const getActiveJobs = internalQuery({
  handler: async (ctx) => {
    const apps = await ctx.db
      .query("applications")
      .withIndex("by_status", (q) => q.eq("status", "slot_hunting"))
      .collect();

    return apps
      .filter((app) => {
        const hc = (app as { hunterConfig?: { isActive?: boolean } }).hunterConfig;
        return hc?.isActive === true;
      })
      .map((app) => {
        const pricing = app.destination ? VISA_PRICING[app.destination as keyof typeof VISA_PRICING] : undefined;
        return {
          id: app._id,
          destination: app.destination,
          visaType: app.visaType,
          applicantName: app.applicantName,
          travelDate: app.travelDate,
          urgencyTier: (app as { slotUrgencyTier?: string }).slotUrgencyTier ?? "standard",
          slotBookingRefs: (app as { slotBookingRefs?: unknown }).slotBookingRefs,
          hunterConfig: (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string } }).hunterConfig,
          portalUrl: (pricing as { portalUrl?: string } | undefined)?.portalUrl ?? null,
          portalName: (pricing as { portalName?: string } | undefined)?.portalName ?? null,
          portalDashboardUrl: (pricing as { portalDashboardUrl?: string } | undefined)?.portalDashboardUrl ?? null,
          portalAppointmentUrl: (pricing as { portalAppointmentUrl?: string } | undefined)?.portalAppointmentUrl ?? null,
          portalScheduleUrl: (pricing as { portalScheduleUrl?: string } | undefined)?.portalScheduleUrl ?? null,
          lastCheckAt: (app as { hunterConfig?: { lastCheckAt?: number } }).hunterConfig?.lastCheckAt ?? null,
        };
      });
  },
});

export const getApplicationHunterKey = internalQuery({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return null;
    const hc = (app as { hunterConfig?: { twoCaptchaApiKey?: string } }).hunterConfig;
    return { twoCaptchaApiKey: hc?.twoCaptchaApiKey ?? null };
  },
});

export const markSlotFoundByHunter = internalMutation({
  args: {
    applicationId: v.id("applications"),
    date: v.string(),
    time: v.string(),
    location: v.string(),
    confirmationCode: v.optional(v.string()),
    screenshotStorageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await coreMarkSlotFound(ctx, { ...args, logAuthor: "Joventy Hunter" });

    const app = await ctx.db.get(args.applicationId);
    const existing = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; checkCount?: number; lastCheckAt?: number; lastResult?: string; twoCaptchaApiKey?: string } } | null)?.hunterConfig;
    if (existing) {
      await ctx.db.patch(args.applicationId, {
        hunterConfig: {
          ...existing,
          isActive: false,
          lastResult: "slot_captured",
          lastCheckAt: Date.now(),
          checkCount: (existing.checkCount ?? 0) + 1,
        },
        updatedAt: Date.now(),
      });
    }

    return args.applicationId;
  },
});

export const recordHeartbeat = internalMutation({
  args: {
    applicationId: v.id("applications"),
    result: v.union(
      v.literal("not_found"),
      v.literal("captcha"),
      v.literal("error"),
      v.literal("payment_required"),
    ),
    errorMessage: v.optional(v.string()),
    shouldPause: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const app = await ctx.db.get(args.applicationId);
    if (!app) return;

    const existing = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; checkCount?: number; lastCheckAt?: number; lastResult?: string } }).hunterConfig;
    if (!existing) return;

    await ctx.db.patch(args.applicationId, {
      hunterConfig: {
        ...existing,
        isActive: args.shouldPause ? false : existing.isActive,
        lastCheckAt: Date.now(),
        checkCount: (existing.checkCount ?? 0) + 1,
        lastResult: args.result,
      },
      updatedAt: Date.now(),
    });

    if (args.shouldPause) {
      await ctx.db.patch(args.applicationId, {
        logs: [
          ...((app as { logs?: Array<{ msg: string; time: number; author: string }> }).logs ?? []),
          { msg: "Hunter auto-paused: 3 login failures consécutives", time: Date.now(), author: "Joventy Hunter" },
        ],
        updatedAt: Date.now(),
      });
    }

    if (args.result === "payment_required") {
      const msg = args.errorMessage
        ? `⚠️ Paiement portail requis : ${args.errorMessage}`
        : "⚠️ Le portail exige le paiement des frais consulaires avant d'accéder au calendrier des créneaux.";
      await ctx.db.patch(args.applicationId, {
        logs: [
          ...((app as { logs?: Array<{ msg: string; time: number; author: string }> }).logs ?? []),
          { msg, time: Date.now(), author: "Joventy Hunter" },
        ],
        updatedAt: Date.now(),
      });
    }
  },
});

export const checkTwoCaptchaBalance = action({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as { [key: string]: unknown } | null);

    const app = await ctx.runQuery(internal.hunter.getApplicationHunterKey, {
      applicationId: args.applicationId,
    });

    if (!app) throw new Error("Dossier introuvable");
    if (!app.twoCaptchaApiKey) throw new Error("Aucune clé 2captcha configurée pour ce dossier");

    const res = await fetch(
      `https://2captcha.com/res.php?action=getbalance&key=${encodeURIComponent(app.twoCaptchaApiKey)}`
    );
    const text = (await res.text()).trim();
    const balance = parseFloat(text);

    if (isNaN(balance)) {
      throw new Error(`Réponse 2captcha inattendue: ${text}`);
    }

    return { balance, checkedAt: Date.now() };
  },
});

export const checkTwoCaptchaBalanceRaw = action({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as { [key: string]: unknown } | null);

    const res = await fetch(
      `https://2captcha.com/res.php?action=getbalance&key=${encodeURIComponent(args.apiKey.trim())}`
    );
    const text = (await res.text()).trim();
    const balance = parseFloat(text);

    if (isNaN(balance)) {
      return { ok: false, error: text, balance: null };
    }

    return { ok: true, error: null, balance };
  },
});

export const pingPortal = action({
  args: { destination: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as { [key: string]: unknown } | null);

    const pricing = VISA_PRICING[args.destination as keyof typeof VISA_PRICING];
    if (!pricing) throw new Error("Destination inconnue");

    const url = (pricing as { portalUrl: string }).portalUrl;
    const portalName = (pricing as { portalName: string }).portalName;
    const startMs = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startMs;

      return {
        ok: res.status < 500,
        status: res.status,
        latencyMs,
        url,
        portalName,
        error: null as string | null,
      };
    } catch (err) {
      const latencyMs = Date.now() - startMs;
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const isTimeout = errMsg.includes("abort") || errMsg.includes("timeout") || errMsg.includes("timed out");
      return {
        ok: false,
        status: null as number | null,
        latencyMs,
        url,
        portalName,
        error: isTimeout ? "Timeout (>9s) — portail inaccessible ou très lent" : errMsg,
      };
    }
  },
});

export const createBotTest = mutation({
  args: {
    destination: v.string(),
    testUsername: v.optional(v.string()),
    testPassword: v.optional(v.string()),
    twoCaptchaApiKey: v.optional(v.string()),
    testType: v.optional(v.string()),  // "login" (défaut) | "logout"
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as { [key: string]: unknown } | null);

    const pricing = VISA_PRICING[args.destination as keyof typeof VISA_PRICING];
    if (!pricing) throw new Error("Destination inconnue");

    const testId = await ctx.db.insert("botTests", {
      destination: args.destination,
      portalUrl: (pricing as { portalUrl: string }).portalUrl,
      portalName: (pricing as { portalName: string }).portalName,
      testUsername: args.testUsername,
      testPassword: args.testPassword,
      twoCaptchaApiKey: args.twoCaptchaApiKey,
      testType: args.testType ?? "login",
      status: "pending",
      requestedAt: Date.now(),
      requestedBy: identity!.subject,
    });

    return testId;
  },
});

export const listBotTests = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as { [key: string]: unknown } | null);

    const tests = await ctx.db
      .query("botTests")
      .withIndex("by_requested")
      .order("desc")
      .take(50);

    return tests;
  },
});

export const claimPendingBotTest = internalMutation({
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("botTests")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("asc")
      .first();

    if (!pending) return null;

    await ctx.db.patch(pending._id, { status: "running" });
    return pending;
  },
});

export const completeBotTest = internalMutation({
  args: {
    testId: v.id("botTests"),
    result: v.string(),
    latencyMs: v.optional(v.number()),
    httpStatus: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.testId, {
      status: "done",
      result: args.result,
      latencyMs: args.latencyMs,
      httpStatus: args.httpStatus,
      errorMessage: args.errorMessage,
      completedAt: Date.now(),
    });
  },
});
