import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { VISA_PRICING, SLOT_URGENCY_TIERS, getAvailablePackages, type Destination, type ServicePackage, type SlotUrgencyTier } from "./constants";
import { getVisaCategory, getVisaClassForBroadcast } from "./visaClassifications";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  if (identity.role) return identity.role as string;
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  const pubSnake = identity["public_metadata"] as { role?: string } | undefined;
  if (pubSnake?.role) return pubSnake.role;
  return "client";
}

function makeLog(msg: string, author?: string) {
  return { msg, time: Date.now(), author: author ?? "système" };
}

/**
 * Vérifie si l'identité Clerk est propriétaire d'un dossier.
 * Gère les 3 variantes historiques de Clerk ID stockées dans userId.
 */
function isOwner(appUserId: string, identitySubject: string): boolean {
  const getClerkId = (subject: string) =>
    subject.includes("|") ? subject.split("|").pop()! : subject;
  const clerkId = getClerkId(identitySubject);
  return (
    appUserId === clerkId ||
    appUserId === `https://clerk.joventy.cd|${clerkId}` ||
    appUserId === `https://active-midge-3.clerk.accounts.dev|${clerkId}`
  );
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
      const getClerkId = (subject: string) => {
        if (subject.includes("|")) {
          return subject.split("|").pop()!;
        }
        return subject;
      };
      const clerkId = getClerkId(identity.subject);
      const variations = [
        clerkId,
        `https://clerk.joventy.cd|${clerkId}`,
        `https://active-midge-3.clerk.accounts.dev|${clerkId}`
      ];
      const allApps = [];
      for (const v of variations) {
        const appsForVar = await ctx.db
          .query("applications")
          .withIndex("by_user", (q) => q.eq("userId", v))
          .collect();
        allApps.push(...appsForVar);
      }
      apps = allApps.sort((a, b) => b.updatedAt - a.updatedAt);
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

export const getByTrackingToken = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const app = await ctx.db
      .query("applications")
      .withIndex("by_tracking_token", (q) => q.eq("trackingToken", args.token))
      .unique();
    if (!app) return null;
    const {
      userEmail: _e,
      userPhone: _p,
      userWhatsapp: _w,
      passportNumber: _n,
      adminNotes: _an,
      price: _pr,
      priceDetails: _pd,
      paymentProofUrl: _pp,
      successFeeProofUrl: _sf,
      visaDocumentStorageId: _vd,
      logs: _l,
      remindersSent: _rs,
      trackingToken: _tt,
      ...publicFields
    } = app;
    return publicFields;
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

    if (!isAdmin && !isOwner(app.userId, identity.subject)) return null;

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
    servicePackage: v.optional(v.union(
      v.literal("full_service"),
      v.literal("slot_only"),
      v.literal("dossier_only")
    )),
    slotUrgencyTier: v.optional(v.union(
      v.literal("standard"),
      v.literal("prioritaire"),
      v.literal("urgent"),
      v.literal("tres_urgent")
    )),
    slotBookingRefs: v.optional(v.object({
      ds160Confirmation: v.optional(v.string()),
      mrvReceiptNumber: v.optional(v.string()),
      sevisId: v.optional(v.string()),
      petitionReceiptNumber: v.optional(v.string()),
      petitionerName: v.optional(v.string()),
      vfsRefNumber: v.optional(v.string()),
      cevAccountEmail: v.optional(v.string()),
      cevAccountPassword: v.optional(v.string()),
      vowintAppId: v.optional(v.string()),
    })),
    cevVisaClass: v.optional(v.union(v.literal("A"), v.literal("C"), v.literal("D"))),
    cevApplicantAgeCategory: v.optional(v.union(
      v.literal("adult"),
      v.literal("child_6_12"),
      v.literal("child_under_6"),
    )),
    cevTargetCountry: v.optional(v.string()),
    userWhatsapp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const destKey = args.destination as Destination;
    const pricing = VISA_PRICING[destKey];
    if (!pricing) throw new Error("Destination non supportée");

    const pkg: ServicePackage = args.servicePackage ?? "full_service";

    const allowedPackages = getAvailablePackages(destKey);
    if (!allowedPackages.includes(pkg)) {
      throw new Error(
        `Le package "${pkg}" n'est pas disponible pour la destination "${args.destination}". Packages disponibles : ${allowedPackages.join(", ")}.`
      );
    }

    const isDossierOnly = pkg === "dossier_only";
    const isSlotOnly = pkg === "slot_only";

    // Slot-only uses urgency-tier pricing (prime split into deposit + success)
    let engagementFee: number;
    let successFee: number;
    let totalPrice: number;

    if (isSlotOnly) {
      // Tous les nouveaux dossiers créneaux utilisent le tier "standard" ($60/$90/$150 promo).
      // La valeur envoyée par le client est ignorée pour éviter tout contournement de prix.
      const tierData = SLOT_URGENCY_TIERS["standard"];
      engagementFee = tierData.depositAmount;
      successFee = tierData.successAmount;
      totalPrice = tierData.total;
    } else {
      engagementFee = pricing.engagementFee;
      successFee = isDossierOnly ? 0 : pricing.successFee;
      totalPrice = isDossierOnly ? pricing.engagementFee : pricing.total;
    }

    const priceDetails = {
      engagementFee,
      successFee,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: isDossierOnly,
    };

    const {
      servicePackage: _sp,
      slotUrgencyTier: _sut,
      slotBookingRefs: _sbr,
      cevVisaClass,
      cevApplicantAgeCategory,
      cevTargetCountry,
      ...appArgs
    } = args;

    const tierLabel = isSlotOnly
      ? ` — Créneau standard. Dépôt : ${engagementFee}$ / Solde : ${successFee}$`
      : isDossierOnly ? " (tarif fixe, pas de prime de succès)" : "";

    const trackingToken = Array.from({ length: 12 }, () =>
      "abcdefghjkmnpqrstuvwxyz23456789"[Math.floor(Math.random() * 31)]
    ).join("");

    // ═══ Segmentation Visa USA — dérivation automatique du canal de broadcast ═══
    // Extrait le code visa depuis le label textuel (ex: "B1/B2 (Tourisme/Affaires)" → "B1/B2")
    let usVisaCode: string | undefined;
    let usVisaCategory: "NIV" | "IV" | undefined;
    let broadcastVisaClass: string | undefined;

    if (destKey === "usa") {
      // Pattern: "CODE (Description)" — le code est avant la première parenthèse
      const codeMatch = args.visaType.match(/^([A-Z0-9/]+)/i);
      if (codeMatch) {
        usVisaCode = codeMatch[1].toUpperCase();
        usVisaCategory = getVisaCategory(usVisaCode) ?? undefined;
        broadcastVisaClass = getVisaClassForBroadcast(usVisaCode);
      }
    }

    const id = await ctx.db.insert("applications", {
      ...appArgs,
      userId: identity.subject,
      trackingToken,
      userFirstName: identity.givenName,
      userLastName: identity.familyName,
      userEmail: identity.email,
      status: "awaiting_engagement_payment",
      isPaid: false,
      price: totalPrice,
      priceDetails,
      successModel: pricing.successModel,
      servicePackage: pkg,
      slotUrgencyTier: isSlotOnly ? "standard" : undefined,
      slotBookingRefs: args.slotBookingRefs ?? undefined,
      cevVisaClass: cevVisaClass ?? undefined,
      cevApplicantAgeCategory: cevApplicantAgeCategory ?? undefined,
      cevTargetCountry: cevTargetCountry ?? undefined,
      // Segmentation visa USA (micro-meutes homogènes)
      usVisaCode: usVisaCode ?? undefined,
      usVisaCategory: usVisaCategory ?? undefined,
      broadcastVisaClass: broadcastVisaClass ?? undefined,
      logs: [
        makeLog(
          `Dossier créé pour ${pricing.label} — ${args.visaType}. Package : ${pkg}.${tierLabel}`,
          identity.name ?? "client"
        ),
      ],
      updatedAt: Date.now(),
    });

    const userFullName = [identity.givenName, identity.familyName].filter(Boolean).join(" ");
    const userEmail = identity.email as string | undefined;

    await ctx.scheduler.runAfter(0, internal.emails.sendNewApplicationAdmin, {
      applicantName: args.applicantName,
      destination: args.destination,
      visaType: args.visaType,
      userEmail,
      userFullName: userFullName || undefined,
      servicePackage: pkg,
      applicationId: id,
    });

    if (userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendApplicationConfirmationClient, {
        to: userEmail,
        applicantName: args.applicantName,
        destination: args.destination,
        visaType: args.visaType,
        engagementFee,
        applicationId: id,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: "ADMIN",
      type: "new_application",
      title: "Nouveau dossier créé",
      body: `${args.applicantName} — ${args.destination.toUpperCase()} ${args.visaType}`,
      applicationId: id,
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
    if (!isOwner(app.userId, identity.subject)) throw new Error("Accès non autorisé");

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

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: "ADMIN",
      type: "payment_proof_submitted",
      title: "Preuve de paiement soumise",
      body: `${app.applicantName} a soumis un justificatif pour les ${label} (${app.destination.toUpperCase()}).`,
      applicationId: args.id,
    });

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


/**
 * Admin : assigner/modifier la classe de visa pour la meute (broadcast channel).
 *
 * Permet à l'admin de définir explicitement le canal de broadcast d'un dossier.
 * C'est le champ clé qui détermine dans quelle micro-meute homogène le dossier
 * sera placé pour le blind booking.
 *
 * Exemples :
 *   - broadcastVisaClass = "F1"   → éclaireurs F1 → confinés F1
 *   - broadcastVisaClass = "B1/B2" → éclaireurs B1/B2 → confinés B1/B2
 *   - broadcastVisaClass = "H"    → éclaireurs H1B/H2A/H2B → confinés H
 */
// ─── Migration : anciens dossiers créneaux → nouveau système ($60/$90/$150) ───
// Éligible : package slot_only, statut non final, tier ≠ standard ou prix ≠ $60
const FINAL_STATUSES = ["slot_found_awaiting_success_fee", "completed", "rejected"] as const;

export const migrateToNewSlotSystem = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    // ── Ownership check avec Clerk-ID legacy variations ──
    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";
    if (!isAdmin && !isOwner(app.userId, identity.subject)) throw new Error("Accès non autorisé");

    // ── Vérifier éligibilité (package + statut) ──
    if (app.servicePackage !== "slot_only") throw new Error("Ce dossier n'est pas un dossier créneau");
    if ((FINAL_STATUSES as readonly string[]).includes(app.status)) {
      throw new Error("Ce dossier est dans un état final et ne peut pas être migré");
    }

    const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
    const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
    const paidAmount = app.priceDetails?.paidAmount ?? 0;

    // La prime de succès déjà réglée est un état financier final — ne pas modifier
    if (isSuccessFeePaid) {
      throw new Error("La prime de succès de ce dossier est déjà réglée — aucune migration nécessaire");
    }

    // ── Vérifier éligibilité pricing (server-side) — évite les migrations inutiles ──
    const currentTierIsStandard = app.slotUrgencyTier === "standard";
    const currentFeeIsPromo = (app.priceDetails?.engagementFee ?? 0) === 60;
    if (currentTierIsStandard && currentFeeIsPromo) {
      throw new Error("Ce dossier est déjà sur le nouveau système de tarification");
    }

    const NEW_DEPOSIT = SLOT_URGENCY_TIERS["standard"].depositAmount; // $60
    const NEW_SUCCESS = SLOT_URGENCY_TIERS["standard"].successAmount;  // $90

    let newPriceDetails: typeof app.priceDetails;
    let newPrice: number;
    let logMsg: string;

    if (!isEngagementPaid) {
      // Acompte non encore payé : normaliser à la nouvelle tarification promo complète
      newPriceDetails = {
        engagementFee: NEW_DEPOSIT,
        successFee: NEW_SUCCESS,
        paidAmount: 0,
        isEngagementPaid: false,
        isSuccessFeePaid: false,
      };
      newPrice = NEW_DEPOSIT + NEW_SUCCESS; // $150
      logMsg = "Migration nouveau système créneaux — nouveau tarif promo : $60 acompte / $90 solde (total $150).";
    } else {
      // Acompte déjà payé : conserver le montant versé, ajuster uniquement le solde à $90
      const actualPaidEngagement = app.priceDetails?.engagementFee ?? paidAmount;
      newPriceDetails = {
        engagementFee: actualPaidEngagement,  // ce qui a été réellement facturé et versé
        successFee: NEW_SUCCESS,               // solde normalisé à $90
        paidAmount,
        isEngagementPaid: true,
        isSuccessFeePaid: false,
      };
      newPrice = actualPaidEngagement + NEW_SUCCESS; // acompte versé + $90 solde
      logMsg = `Migration nouveau système créneaux — acompte de $${actualPaidEngagement} conservé (déjà versé). Solde normalisé : $90 (total : $${newPrice}).`;
    }

    const logs = app.logs ?? [];
    await ctx.db.patch(args.applicationId, {
      slotUrgencyTier: "standard",
      price: newPrice,
      priceDetails: newPriceDetails,
      updatedAt: Date.now(),
      logs: [...logs, makeLog(logMsg, identity.name ?? "client")],
    });

    return args.applicationId;
  },
});

export const assignVisaClass = mutation({
  args: {
    applicationId: v.id("applications"),
    usVisaCode: v.optional(v.string()),
    usVisaCategory: v.optional(v.union(v.literal("NIV"), v.literal("IV"))),
    broadcastVisaClass: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const role = getRole(identity as Record<string, unknown>);
    console.log("[assignVisaClass] identity.subject:", identity.subject, "role:", role, "broadcastVisaClass:", args.broadcastVisaClass);

    if (role !== "admin")
      throw new Error("Unauthorized — réservé aux administrateurs");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const logs = app.logs ?? [];

    await ctx.db.patch(args.applicationId, {
      broadcastVisaClass: args.broadcastVisaClass,
      usVisaCode: args.usVisaCode ?? app.usVisaCode,
      usVisaCategory: args.usVisaCategory ?? app.usVisaCategory,
      updatedAt: Date.now(),
      logs: [...logs, makeLog(
        `Canal visa assigné : ${args.broadcastVisaClass} (${args.usVisaCategory ?? "?"}) — code: ${args.usVisaCode ?? "auto"}`,
        "admin"
      )],
    });

    console.log("[assignVisaClass] ✅ Patch applied successfully for app:", args.applicationId, "→ broadcastVisaClass:", args.broadcastVisaClass);
    return args.applicationId;
  },
});
