import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { VISA_PRICING } from "./constants";
import { coreMarkSlotFound, getEffectiveSuccessModel as getSuccessModel } from "./slotFoundHelper";

function getRole(identity: { [key: string]: unknown } | null): string {
  if (!identity) return "client";
  // Direct claim from JWT template: "role": "{{user.public_metadata.role}}"
  if (identity.role) return identity.role as string;
  // Nested publicMetadata object in JWT: "publicMetadata": "{{user.public_metadata}}"
  const pub = identity.publicMetadata as { role?: string } | undefined;
  if (pub?.role) return pub.role;
  return "client";
}

function requireAdmin(identity: { [key: string]: unknown } | null) {
  if (!identity || getRole(identity) !== "admin") {
    throw new Error("Accès refusé — réservé aux administrateurs Joventy");
  }
}

function makeLog(msg: string, author?: string) {
  return { msg, time: Date.now(), author: author ?? "admin" };
}

function getEffectiveSuccessModel(app: { successModel?: string; destination?: string }): string {
  return getSuccessModel(app);
}

export const getStats = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      return null;
    }

    const all = await ctx.db.query("applications").collect();
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const uniqueUserIds = new Set(all.map((a) => a.userId));

    const byDestination = all.reduce(
      (acc, a) => {
        acc[a.destination] = (acc[a.destination] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const recentApplications = [...all]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10)
      .map((a) => ({
        _id: a._id,
        applicantName: a.applicantName,
        destination: a.destination,
        visaType: a.visaType,
        status: a.status,
        updatedAt: a.updatedAt,
        priceDetails: a.priceDetails,
      }));

    const totalRevenue = all.reduce((sum, a) => {
      return sum + (a.priceDetails?.paidAmount ?? 0);
    }, 0);

    const pendingPaymentValidation = all.filter(
      (a) =>
        (a.paymentProofUrl && !a.priceDetails?.isEngagementPaid) ||
        (a.successFeeProofUrl && !a.priceDetails?.isSuccessFeePaid)
    ).length;

    return {
      totalApplications: all.length,
      pendingReview: all.filter((a) => a.status === "in_review").length,
      approvedThisMonth: all.filter(
        (a) => a.status === "completed" && a.updatedAt >= startOfMonth
      ).length,
      totalClients: uniqueUserIds.size,
      byDestination,
      recentApplications,
      totalRevenue,
      pendingPaymentValidation,
      slotHunting: all.filter((a) => a.status === "slot_hunting").length,
    };
  },
});

export const listClients = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") {
      return [];
    }

    const all = await ctx.db.query("applications").collect();

    const clientMap = new Map<
      string,
      {
        userId: string;
        firstName: string;
        lastName: string;
        email: string;
        applicationCount: number;
        firstSeen: number;
      }
    >();

    for (const app of all) {
      if (!clientMap.has(app.userId)) {
        clientMap.set(app.userId, {
          userId: app.userId,
          firstName: app.userFirstName || "",
          lastName: app.userLastName || "",
          email: app.userEmail || "",
          applicationCount: 1,
          firstSeen: app._creationTime,
        });
      } else {
        const existing = clientMap.get(app.userId)!;
        existing.applicationCount += 1;
        if (app._creationTime < existing.firstSeen) {
          existing.firstSeen = app._creationTime;
        }
      }
    }

    return Array.from(clientMap.values()).sort(
      (a, b) => a.firstSeen - b.firstSeen
    );
  },
});

export const validateEngagementPayment = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    if (priceDetails.isEngagementPaid) {
      throw new Error("Les frais d'engagement ont déjà été validés pour ce dossier.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "documents_pending",
      priceDetails: {
        ...priceDetails,
        isEngagementPaid: true,
        paidAmount: priceDetails.paidAmount + priceDetails.engagementFee,
      },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          app.servicePackage === "slot_only"
            ? `✅ Frais d'engagement (${priceDetails.engagementFee}$) validés. Dossier activé — recherche de créneaux en cours.`
            : app.servicePackage === "dossier_only"
              ? `✅ Frais d'engagement (${priceDetails.engagementFee}$) validés. Dossier activé — préparation des formulaires.`
              : `✅ Frais d'engagement (${priceDetails.engagementFee}$) validés. Dossier activé — en attente des documents client.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendEngagementValidatedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
        servicePackage: app.servicePackage,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "engagement_validated",
      title: "Paiement d'engagement validé ✓",
      body:
        app.servicePackage === "slot_only"
          ? "Votre dépôt a été validé. La chasse aux créneaux est en cours."
          : app.servicePackage === "dossier_only"
            ? "Votre paiement a été validé. Nous préparons votre dossier."
            : "Votre paiement d'engagement a été validé. Vous pouvez maintenant soumettre vos documents.",
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const markSlotFound = mutation({
  args: {
    applicationId: v.id("applications"),
    date: v.string(),
    time: v.string(),
    location: v.string(),
    confirmationCode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);
    return await coreMarkSlotFound(ctx, { ...args, logAuthor: "admin" });
  },
});

export const markVisaObtained = mutation({
  args: {
    applicationId: v.id("applications"),
    storageId: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.status !== "slot_hunting") {
      throw new Error("Le dossier doit être au statut 'slot_hunting' pour enregistrer un visa obtenu.");
    }

    if (app.servicePackage === "dossier_only") {
      throw new Error("Ce dossier est en mode 'Constitution uniquement' — il n'a pas de visa e-Visa.");
    }

    const effectiveModel = getEffectiveSuccessModel(app);
    if (effectiveModel !== "evisa") {
      throw new Error("Ce dossier utilise le modèle rendez-vous — utilisez 'Créneau' plutôt que 'Visa Obtenu'.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    await ctx.db.patch(args.applicationId, {
      status: "slot_found_awaiting_success_fee",
      visaDocumentStorageId: args.storageId,
      priceDetails,
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `🎉 Visa obtenu ! Réglez la prime de succès (${priceDetails.successFee}$) pour recevoir votre document officiel.${args.notes ? ` Note : ${args.notes}` : ""}`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendVisaObtainedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        successFee: priceDetails.successFee,
        applicationId: args.applicationId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "visa_obtained",
      title: "🎉 Visa obtenu !",
      body: `Votre visa ${app.destination.toUpperCase()} a été accordé. Réglez la prime de succès (${priceDetails.successFee}$) pour télécharger votre document officiel.`,
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const getVisaDocumentUrl = query({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const app = await ctx.db.get(args.applicationId);
    if (!app) return null;

    const isAdmin = getRole(identity as Record<string, unknown>) === "admin";

    if (!isAdmin) {
      if (app.userId !== identity.subject) return null;
      const successFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
      if (!successFeePaid) return null;
    }

    if (!app.visaDocumentStorageId) return null;

    return await ctx.storage.getUrl(app.visaDocumentStorageId as import("./_generated/dataModel").Id<"_storage">);
  },
});

export const validateSuccessFee = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.status !== "slot_found_awaiting_success_fee") {
      throw new Error("Le dossier doit être au statut 'slot_found_awaiting_success_fee' pour valider la prime de succès.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: false,
    };

    if (priceDetails.isSuccessFeePaid) {
      throw new Error("La prime de succès a déjà été validée pour ce dossier.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "completed",
      isPaid: true,
      priceDetails: {
        ...priceDetails,
        isSuccessFeePaid: true,
        paidAmount: priceDetails.paidAmount + priceDetails.successFee,
      },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `✅ Prime de succès (${priceDetails.successFee}$) validée. Dossier complété — le client peut télécharger son kit d'entretien.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendDossierCompletedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "success_fee_validated",
      title: "Dossier finalisé ✓",
      body: "Votre prime de succès a été validée. Votre kit d'entretien consulaire est maintenant disponible.",
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const rejectApplication = mutation({
  args: {
    applicationId: v.id("applications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      status: "rejected",
      rejectionReason: args.reason,
      logs: [
        ...(app.logs ?? []),
        makeLog(`❌ Dossier rejeté. Raison : ${args.reason}`, "admin"),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendApplicationRejectedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        reason: args.reason,
        applicationId: args.applicationId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "rejected",
      title: "Dossier refusé",
      body: `Votre dossier ${app.destination.toUpperCase()} n'a pas pu être traité. Raison : ${args.reason}`,
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const setSlotHunting = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.servicePackage === "dossier_only") {
      throw new Error("Ce dossier est en mode 'Constitution uniquement' — utilisez 'Marquer dossier complété' à la place.");
    }

    await ctx.db.patch(args.applicationId, {
      status: "slot_hunting",
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `🔍 Surveillance des créneaux activée. Notre système vérifie les disponibilités de l'ambassade en continu.`,
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendSlotHuntingStartedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });

      if (app.destination === "spain") {
        const travelDateFormatted = app.travelDate
          ? (() => {
              const d = new Date(app.travelDate + "T12:00:00");
              const dd = String(d.getDate()).padStart(2, "0");
              const mm = String(d.getMonth() + 1).padStart(2, "0");
              const yyyy = d.getFullYear();
              return `${dd}${mm}${yyyy}`;
            })()
          : undefined;
        await ctx.scheduler.runAfter(2000, internal.emails.sendSpainPreRegistrationClient, {
          to: app.userEmail,
          applicantName: app.applicantName,
          applicationId: args.applicationId,
          travelDate: travelDateFormatted,
        });
        const travelDateDisplay = travelDateFormatted ?? "JJMMAAAA";
        const spainSystemMsg =
`🇪🇸 ACTION REQUISE — Inscription auprès de l'ambassade d'Espagne

Notre robot de surveillance est actif. Pour qu'il puisse réserver votre créneau sur citaconsular.es, vous devez d'abord obtenir vos identifiants auprès de l'ambassade en 2 étapes :

─── ÉTAPE 1 — Envoyer un email à l'ambassade ───

📧 Adresse : emb.kinshasa.citasvis@maec.es
📌 Objet : RENDEZ-VOUS VISA EST

Corps du message (copiez ce modèle, séparateurs point-virgule) :
NOM PRÉNOM EN MAJUSCULES SANS ACCENTS;NUMÉRO PASSEPORT;${travelDateDisplay};EST

Exemple : JEAN KABILA;AB123456;${travelDateDisplay};EST

📎 Pièces jointes obligatoires :
• Photo de vous tenant votre passeport ouvert (JPEG/PDF, lisible, sans lunettes ni visage couvert)
• Formulaire de candidature officiel (avec votre photo)
• Réservation de vol confirmée
• Assurance santé/voyage Schengen (min. 30 000 €)

⚠️ Ne renvoyez pas l'email avant 14 jours. Un email par personne. Max 1 Mo de pièces jointes.

─── ÉTAPE 2 — Transmettez vos identifiants à Joventy ───

Dès que l'ambassade vous envoie votre identifiant et mot de passe, répondez à ce message avec ces informations. Notre robot les utilisera pour réserver automatiquement le premier créneau disponible.

ℹ️ Horaires ambassade : lun–ven 8h30–14h (Kinshasa)
🔍 Suivi de dossier : sutramiteconsular.maec.es
💶 Frais consulaires (90 €/adulte) payés directement à l'ambassade — non inclus dans le tarif Joventy`;
        await ctx.scheduler.runAfter(3000, internal.messages.sendSystemMessage, {
          applicationId: args.applicationId,
          content: spainSystemMsg,
        });
      }
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "hunting_started",
      title: "Chasse aux créneaux lancée 🔍",
      body: `Notre système surveille les disponibilités de l'ambassade ${app.destination.toUpperCase()} en continu. Vous serez notifié dès qu'un créneau est capturé.`,
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const completeDossierOnly = mutation({
  args: { applicationId: v.id("applications") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    if (app.servicePackage !== "dossier_only") {
      throw new Error("Cette action est réservée aux dossiers 'Constitution uniquement'.");
    }

    if (app.status === "completed") {
      throw new Error("Ce dossier est déjà complété.");
    }

    if (!app.priceDetails?.isEngagementPaid) {
      throw new Error("Les frais d'engagement doivent être validés avant de compléter le dossier.");
    }

    const priceDetails = app.priceDetails ?? {
      engagementFee: 0,
      successFee: 0,
      paidAmount: 0,
      isEngagementPaid: false,
      isSuccessFeePaid: true,
    };

    await ctx.db.patch(args.applicationId, {
      status: "completed",
      isPaid: true,
      priceDetails: { ...priceDetails, isSuccessFeePaid: true },
      logs: [
        ...(app.logs ?? []),
        makeLog(
          "✅ Dossier constitué et validé par Joventy. Le client peut télécharger l'ensemble des documents du dossier.",
          "admin"
        ),
      ],
      updatedAt: Date.now(),
    });

    if (app.userEmail) {
      await ctx.scheduler.runAfter(0, internal.emails.sendDossierCompletedClient, {
        to: app.userEmail,
        applicantName: app.applicantName,
        destination: app.destination,
        applicationId: args.applicationId,
      });
    }

    await ctx.scheduler.runAfter(0, internal.notifications.create, {
      userId: app.userId,
      type: "dossier_completed",
      title: "Dossier constitué ✓",
      body: "Votre dossier de demande de visa est prêt. Vous pouvez télécharger l'ensemble des documents.",
      applicationId: args.applicationId,
    });

    return args.applicationId;
  },
});

export const getCalendarData = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const all = await ctx.db.query("applications").collect();

    const withAppointment = all.filter(
      (a) => a.appointmentDetails?.date && (
        a.status === "slot_found_awaiting_success_fee" ||
        a.status === "completed"
      )
    );

    return withAppointment.map((a) => ({
      _id: a._id,
      applicantName: a.applicantName,
      destination: a.destination,
      visaType: a.visaType,
      status: a.status,
      date: a.appointmentDetails!.date,
      time: a.appointmentDetails?.time,
      location: a.appointmentDetails?.location,
      confirmationCode: a.appointmentDetails?.confirmationCode,
      priceDetails: a.priceDetails,
      userEmail: a.userEmail,
      userWhatsapp: (a as { userWhatsapp?: string }).userWhatsapp,
    }));
  },
});

export const getAnalytics = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || getRole(identity as Record<string, unknown>) !== "admin") return null;

    const all = await ctx.db.query("applications").collect();
    const now = Date.now();

    // ── Revenus par mois (6 derniers mois) ────────────────────────────────────
    const months: { label: string; revenu: number; dossiers: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const start = d.getTime();
      const end = i === 0 ? now : (() => {
        const e = new Date(d);
        e.setMonth(e.getMonth() + 1);
        return e.getTime();
      })();
      const label = d.toLocaleDateString("fr-FR", { month: "short" });
      const slice = all.filter(a => a._creationTime >= start && a._creationTime < end);
      months.push({
        label,
        revenu: slice.reduce((s, a) => s + (a.priceDetails?.paidAmount ?? 0), 0),
        dossiers: slice.length,
      });
    }

    // ── Taux de succès par destination ─────────────────────────────────────────
    const destMap: Record<string, { total: number; success: number }> = {};
    for (const a of all) {
      if (!destMap[a.destination]) destMap[a.destination] = { total: 0, success: 0 };
      destMap[a.destination].total += 1;
      if (a.status === "completed" || a.status === "slot_found" || a.status === "slot_found_awaiting_success_fee") {
        destMap[a.destination].success += 1;
      }
    }
    const successByDest = Object.entries(destMap).map(([dest, d]) => ({
      dest: dest.toUpperCase(),
      taux: d.total > 0 ? Math.round((d.success / d.total) * 100) : 0,
      total: d.total,
      success: d.success,
    })).sort((a, b) => b.total - a.total);

    // ── Répartition des statuts ────────────────────────────────────────────────
    const statusMap: Record<string, number> = {};
    for (const a of all) {
      statusMap[a.status] = (statusMap[a.status] ?? 0) + 1;
    }
    const STATUS_LABELS: Record<string, string> = {
      pending: "En attente",
      in_review: "En révision",
      documents_pending: "Docs requis",
      slot_hunting: "Chasse active",
      slot_found: "Créneau trouvé",
      slot_found_awaiting_success_fee: "Prime en attente",
      completed: "Complété",
      rejected: "Rejeté",
    };
    const statusDist = Object.entries(statusMap).map(([s, n]) => ({
      label: STATUS_LABELS[s] ?? s,
      value: n,
    }));

    // ── Activité hebdomadaire (8 dernières semaines) ───────────────────────────
    const weeks: { label: string; crees: number; resolus: number }[] = [];
    for (let i = 7; i >= 0; i--) {
      const start = now - (i + 1) * 7 * 24 * 60 * 60 * 1000;
      const end = now - i * 7 * 24 * 60 * 60 * 1000;
      const d = new Date(start);
      const label = `${d.getDate()}/${d.getMonth() + 1}`;
      weeks.push({
        label,
        crees: all.filter(a => a._creationTime >= start && a._creationTime < end).length,
        resolus: all.filter(a => a.updatedAt >= start && a.updatedAt < end &&
          (a.status === "completed" || a.status === "slot_found")).length,
      });
    }

    // ── KPIs globaux ───────────────────────────────────────────────────────────
    const totalRevenue = all.reduce((s, a) => s + (a.priceDetails?.paidAmount ?? 0), 0);
    const completed = all.filter(a => a.status === "completed" || a.status === "slot_found" || a.status === "slot_found_awaiting_success_fee");
    const globalSuccessRate = all.length > 0 ? Math.round((completed.length / all.length) * 100) : 0;
    const activeBots = all.filter(a => a.status === "slot_hunting" && a.hunterConfig?.isActive).length;

    // Délai moyen de traitement (création → complétion) en jours
    const completedWithTime = completed.filter(a => a._creationTime);
    const avgProcessingDays = completedWithTime.length > 0
      ? Math.round(completedWithTime.reduce((s, a) => s + (a.updatedAt - a._creationTime), 0) / completedWithTime.length / (1000 * 60 * 60 * 24))
      : 0;

    // ── Revenu par destination ─────────────────────────────────────────────────
    const revenueByDest = Object.entries(
      all.reduce((acc, a) => {
        acc[a.destination] = (acc[a.destination] ?? 0) + (a.priceDetails?.paidAmount ?? 0);
        return acc;
      }, {} as Record<string, number>)
    ).map(([dest, rev]) => ({ dest: dest.toUpperCase(), revenu: rev }))
      .sort((a, b) => b.revenu - a.revenu);

    return {
      months,
      successByDest,
      statusDist,
      weeks,
      kpis: { totalRevenue, globalSuccessRate, activeBots, avgProcessingDays, totalDossiers: all.length },
      revenueByDest,
    };
  },
});

export const setInReview = mutation({
  args: {
    applicationId: v.id("applications"),
    adminNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    const patch: Record<string, unknown> = {
      status: "in_review",
      updatedAt: Date.now(),
      logs: [
        ...(app.logs ?? []),
        makeLog("📋 Dossier pris en charge — examen en cours par l'équipe Joventy.", "admin"),
      ],
    };
    if (args.adminNotes) patch.adminNotes = args.adminNotes;

    await ctx.db.patch(args.applicationId, patch);
    return args.applicationId;
  },
});

export const adjustSlotSuccessFee = mutation({
  args: {
    applicationId: v.id("applications"),
    newSuccessFee: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    if (args.newSuccessFee < 0) throw new Error("La prime ne peut pas être négative");

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");
    if ((app as { servicePackage?: string }).servicePackage !== "slot_only") {
      throw new Error("Ajustement uniquement disponible pour les dossiers Créneau Uniquement");
    }
    if (app.priceDetails?.isSuccessFeePaid) {
      throw new Error("La prime de succès a déjà été réglée — ajustement impossible");
    }

    const prevFee = app.priceDetails?.successFee ?? 0;
    const engagementFee = app.priceDetails?.engagementFee ?? 0;

    await ctx.db.patch(args.applicationId, {
      priceDetails: {
        ...(app.priceDetails ?? {
          engagementFee,
          successFee: prevFee,
          paidAmount: 0,
          isEngagementPaid: false,
          isSuccessFeePaid: false,
        }),
        successFee: args.newSuccessFee,
      },
      price: engagementFee + args.newSuccessFee,
      updatedAt: Date.now(),
      logs: [
        ...(app.logs ?? []),
        makeLog(
          `Prime de succès ajustée : ${prevFee} $ → ${args.newSuccessFee} $${args.reason ? ` (${args.reason})` : ""}.`,
          identity?.name ?? "admin"
        ),
      ],
    });

    return args.applicationId;
  },
});

export const saveAdminNotes = mutation({
  args: {
    applicationId: v.id("applications"),
    adminNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireAdmin(identity as Record<string, unknown>);

    const app = await ctx.db.get(args.applicationId);
    if (!app) throw new Error("Dossier introuvable");

    await ctx.db.patch(args.applicationId, {
      adminNotes: args.adminNotes,
      updatedAt: Date.now(),
    });

    return args.applicationId;
  },
});
