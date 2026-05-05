import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  return "client";
}

export const getOtpConfig = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const app = await ctx.db.get(args.applicationId);
    if (!app) return null;
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) return null;
    if (!app.spainOtpConfig) return null;
    const cfg = app.spainOtpConfig;
    return {
      channel: cfg.channel,
      email: cfg.email
        ? cfg.email.replace(/(.{2})(.*)(@.*)/, "$1***$3")
        : undefined,
      phone: cfg.phone
        ? cfg.phone.replace(/(\+?\d{3})\d+(\d{2})$/, "$1***$2")
        : undefined,
      configuredAt: cfg.configuredAt,
      lastUsedAt: cfg.lastUsedAt,
      hasImapPassword: !!cfg.imapPassword,
    };
  },
});

export const saveOtpConfig = mutation({
  args: {
    applicationId: v.id("applications"),
    channel: v.union(v.literal("email"), v.literal("sms"), v.literal("manual")),
    email: v.optional(v.string()),
    imapPassword: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) throw new Error("Accès refusé");

    await ctx.db.patch(args.applicationId, {
      spainOtpConfig: {
        channel: args.channel,
        email: args.email,
        imapPassword: args.imapPassword,
        phone: args.phone,
        configuredAt: Date.now(),
      },
    });

    const clientEmail = app.userEmail;
    const clientName = app.applicantName;
    const appId = args.applicationId;

    if (clientEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendSpainOtpConfiguredClient, {
        to: clientEmail,
        applicantName: clientName,
        channel: args.channel,
        email: args.email,
        phone: args.phone,
        applicationId: appId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "spain_otp_configured",
      title: "Configuration OTP Espagne activée",
      body:
        args.channel === "email"
          ? `L'interception automatique des codes OTP par email est active pour votre dossier Espagne.`
          : args.channel === "sms"
          ? `L'assistance OTP par SMS est configurée pour votre dossier Espagne.`
          : `Le mode OTP manuel est activé — vous recevrez un message dès qu'un code est requis.`,
      applicationId: appId,
    });
  },
});

export const removeOtpConfig = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Non authentifié");
    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) throw new Error("Accès refusé");

    await ctx.db.patch(args.applicationId, {
      spainOtpConfig: undefined,
    });

    const clientEmail = app.userEmail;
    const appId = args.applicationId;

    if (clientEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendSpainOtpRemovedClient, {
        to: clientEmail,
        applicantName: app.applicantName,
        applicationId: appId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "spain_otp_removed",
      title: "Credentials OTP supprimés",
      body: "Vos informations d'accès OTP pour le dossier Espagne ont été supprimées de nos serveurs.",
      applicationId: appId,
    });
  },
});
