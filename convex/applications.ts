import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { VISA_PRICING, type Destination, type ServicePackage } from "./constants";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  return (identity.role as string) || "client";
}

function makeLog(msg: string, author?: string) {
  return { msg, time: Date.now(), author: author ?? "système" };
}

export const list = query({
  args: { status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";

    let apps;
    if (isAdmin) {
      apps = await ctx.db.query("applications").order("desc").collect();
    } else {
      apps = await ctx.db
        .query("applications")
        .withIndex("by_user", (q) => q.eq("userId", identity.subject))
        .order("desc")
        .collect();
    }

    if (args.status) {
      apps = apps.filter((a) => a.status === args.status);
    }

    // For client users, strip paywalled data from unresolved applications
    if (!isAdmin) {
      return apps.map((app) => {
        const successFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
        if (app.status === "slot_found_awaiting_success_fee" && !successFeePaid) {
          const { appointmentDetails: _a, visaDocumentStorageId: _v, ...safeApp } = app;
          return { ...safeApp, appointmentDetails: undefined, visaDocumentStorageId: undefined };
        }
        return app;
      });
    }

    return apps;
  },
});

export const get = query({
  args: { id: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const app = await ctx.db.get(args.id);
    if (!app) return null;

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && app.userId !== identity.subject) return null;

    // Admins always receive full data.
    if (isAdmin) return app;

    // For clients: enforce paywall on appointment details before success fee payment.
    const successFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
    const isSlotFound = app.status === "slot_found_awaiting_success_fee";

    if (isSlotFound && !successFeePaid) {
      // Strip appointment details and visa document, redact any log entry that might contain sensitive specifics.
      const { appointmentDetails: _a, visaDocumentStorageId: _v, ...safeApp } = app;
      const redactedLogs = (safeApp.logs ?? []).map((log) => {
        const containsDate = /\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}|rendez-vous le \d/i.test(log.msg);
        const containsTime = /\d{2}:\d{2}/i.test(log.msg);
        if (containsDate || containsTime) {
          return {
            ...log,
            msg: "🔒 Détails disponibles après règlement de la prime de succès.",
          };
        }
        return log;
      });
      return { ...safeApp, appointmentDetails: undefined, visaDocumentStorageId: undefined, logs: redactedLogs };
    }

    return app;
  },
});

export const create = mutation({
  args: {
    destination: v.string(),
    visaType: v.string(),
    applicantName: v.string(),
    passportNumber: v.optional(v.string()),
    travelDate: v.string(),
    returnDate: v.optional(v.string()),
    purpose: v.string(),
    notes: v.optional(v.string()),
    servicePackage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const destKey = args.destination as Destination;
    const pricing = VISA_PRICING[destKey];
    if (!pricing) throw new Error("Destination non supportée");

    const pkg = (args.servicePackage ?? "full_service") as ServicePackage;
    const isDossierOnly = pkg === "dossier_only";

    const priceDetails = {
      engagementFee: pricing.engagementFee,
      successFee: isDossierOnly ? 0 : pricing.successFee,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: isDossierOnly,
    };

    const { servicePackage: _sp, ...appArgs } = args;

    const id = await ctx.db.insert("applications", {
      ...appArgs,
      userId: identity.subject,
      userFirstName: identity.givenName,
      userLastName: identity.familyName,
      userEmail: identity.email,
      status: "awaiting_engagement_payment",
      isPaid: false,
      price: isDossierOnly ? pricing.engagementFee : pricing.total,
      priceDetails,
      successModel: pricing.successModel,
      servicePackage: pkg,
      logs: [
        makeLog(
          `Dossier créé pour ${pricing.label} — ${args.visaType}. Package : ${pkg}. Frais d'engagement : ${pricing.engagementFee}$${isDossierOnly ? " (tarif fixe, pas de prime de succès)" : ""}`,
          identity.name ?? "client"
        ),
      ],
      updatedAt: Date.now(),
    });

    return id;
  },
});

export const uploadPaymentProof = mutation({
  args: {
    id: v.id("applications"),
    proofUrl: v.string(),
    paymentType: v.union(v.literal("engagement"), v.literal("success_fee")),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const app = await ctx.db.get(args.id);
    if (!app) throw new Error("Dossier introuvable");
    if (app.userId !== identity.subject) throw new Error("Accès non autorisé");

    const logs = app.logs ?? [];
    const label = args.paymentType === "engagement" ? "frais d'engagement" : "prime de succès";

    // Enforce allowed payment type per current application status
    if (args.paymentType === "engagement" && app.status !== "awaiting_engagement_payment") {
      throw new Error("Paiement d'engagement non applicable au statut actuel du dossier.");
    }
    if (args.paymentType === "success_fee" && app.status !== "slot_found_awaiting_success_fee") {
      throw new Error("Prime de succès non applicable au statut actuel du dossier.");
    }

    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      logs: [
        ...logs,
        makeLog(
          `Reçu de paiement uploadé pour les ${label}. En attente de validation par Joventy.`,
          identity.name ?? "client"
        ),
      ],
    };

    if (args.paymentType === "engagement") {
      patch.paymentProofUrl = args.proofUrl;
    } else {
      patch.successFeeProofUrl = args.proofUrl;
    }

    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});

export const generateReceiptUploadUrl = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return await ctx.storage.generateUploadUrl();
  },
});

export const update = mutation({
  args: {
    id: v.id("applications"),
    status: v.optional(v.string()),
    appointmentDate: v.optional(v.union(v.string(), v.null())),
    adminNotes: v.optional(v.union(v.string(), v.null())),
    price: v.optional(v.union(v.number(), v.null())),
    isPaid: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    if (getRole(identity as Record<string, unknown>) !== "admin")
      throw new Error("Unauthorized");

    const app = await ctx.db.get(args.id);
    if (!app) throw new Error("Dossier introuvable");

    const { id, ...fields } = args;
    const logs = app.logs ?? [];

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (fields.status !== undefined) {
      patch.status = fields.status;
      if (fields.status) {
        patch.logs = [...logs, makeLog(`Statut mis à jour : ${fields.status}`, "admin")];
      }
    }
    if (fields.appointmentDate !== undefined)
      patch.appointmentDate = fields.appointmentDate ?? undefined;
    if (fields.adminNotes !== undefined)
      patch.adminNotes = fields.adminNotes ?? undefined;
    if (fields.price !== undefined) patch.price = fields.price ?? undefined;
    if (fields.isPaid !== undefined) patch.isPaid = fields.isPaid;

    await ctx.db.patch(id, patch);
    return id;
  },
});
