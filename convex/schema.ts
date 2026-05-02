import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const logEntry = v.object({
  msg: v.string(),
  time: v.number(),
  author: v.optional(v.string()),
});

const priceDetails = v.object({
  engagementFee: v.number(),
  successFee: v.number(),
  paidAmount: v.number(),
  isEngagementPaid: v.boolean(),
  isSuccessFeePaid: v.boolean(),
});

const appointmentDetails = v.object({
  date: v.string(),
  time: v.optional(v.string()),
  location: v.optional(v.string()),
  confirmationCode: v.optional(v.string()),
  notes: v.optional(v.string()),
  screenshotStorageId: v.optional(v.string()),
});

const slotBookingRefs = v.object({
  ds160Confirmation: v.optional(v.string()),
  mrvReceiptNumber: v.optional(v.string()),
  sevisId: v.optional(v.string()),
  petitionReceiptNumber: v.optional(v.string()),
  petitionerName: v.optional(v.string()),
  vfsRefNumber: v.optional(v.string()),
  // Schengen / CEV
  cevAccountEmail: v.optional(v.string()),
  cevAccountPassword: v.optional(v.string()),
  vowintAppId: v.optional(v.string()),
});

const hunterConfig = v.object({
  embassyUsername: v.string(),
  embassyPassword: v.string(),
  isActive: v.boolean(),
  twoCaptchaApiKey: v.optional(v.string()),
  capsolverApiKey: v.optional(v.string()),    // CapSolver API key (préféré pour hCaptcha CEV)
  scheduleUrl: v.optional(v.string()),
  // ID du dossier spécifique sur le portail (ex: "APP-2024-001234")
  // Obligatoire quand un compte portail gère plusieurs personnes.
  // S'il est absent, le robot prend automatiquement le premier dossier actif.
  portalApplicationId: v.optional(v.string()),
  // Plage de dates de recherche : ne réserver que dans cette fenêtre
  // Format ISO "YYYY-MM-DD". slotDateFrom = date minimum (ex: dans 14 jours).
  // slotDateDeadline = date limite absolue (ex: date de voyage - 15 jours).
  slotDateFrom: v.optional(v.string()),
  slotDateDeadline: v.optional(v.string()),
  lastCheckAt: v.optional(v.number()),
  checkCount: v.optional(v.number()),
  lastResult: v.optional(v.string()),
  // CEV / Schengen spécifique
  vowintAppId: v.optional(v.string()),        // ID dossier VOWINT (ex: "APP-2024-001234")
  cevCountry: v.optional(v.string()),         // Pays cible (ex: "BE", "FR", "DE")
  cevClickCount: v.optional(v.number()),      // Nombre de clics VOWINT dans la fenêtre en cours
  cevClickWindowStart: v.optional(v.number()), // Timestamp début de la fenêtre de 5 clics/heure
});

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    role: v.string(),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"]),

  applications: defineTable({
    userId: v.string(),
    userFirstName: v.optional(v.string()),
    userLastName: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    userPhone: v.optional(v.string()),
    userWhatsapp: v.optional(v.string()),
    destination: v.string(),
    visaType: v.string(),
    applicantName: v.string(),
    passportNumber: v.optional(v.string()),
    travelDate: v.string(),
    returnDate: v.optional(v.string()),
    purpose: v.string(),
    notes: v.optional(v.string()),
    status: v.string(),
    appointmentDate: v.optional(v.string()),
    adminNotes: v.optional(v.string()),
    price: v.optional(v.number()),
    isPaid: v.boolean(),
    updatedAt: v.number(),
    priceDetails: v.optional(priceDetails),
    logs: v.optional(v.array(logEntry)),
    paymentProofUrl: v.optional(v.string()),
    successFeeProofUrl: v.optional(v.string()),
    appointmentDetails: v.optional(appointmentDetails),
    rejectionReason: v.optional(v.string()),
    slotExpiresAt: v.optional(v.number()),
    successModel: v.optional(v.string()),
    remindersSent: v.optional(v.array(v.string())),
    visaDocumentStorageId: v.optional(v.string()),
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
    slotBookingRefs: v.optional(slotBookingRefs),
    hunterConfig: v.optional(hunterConfig),
    // Schengen / CEV spécifique (drive le calcul des frais consulaires)
    cevVisaClass: v.optional(v.union(v.literal("A"), v.literal("C"), v.literal("D"))),
    cevApplicantAgeCategory: v.optional(v.union(
      v.literal("adult"),
      v.literal("child_6_12"),
      v.literal("child_under_6"),
    )),
    cevTargetCountry: v.optional(v.string()), // ex: "BE", "FR", "DE"
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_updated", ["updatedAt"]),

  reviews: defineTable({
    applicationId: v.id("applications"),
    userId: v.string(),
    displayName: v.string(),
    city: v.string(),
    destination: v.string(),
    rating: v.number(),
    comment: v.string(),
    isApproved: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_application", ["applicationId"])
    .index("by_approved", ["isApproved"]),

  messages: defineTable({
    applicationId: v.id("applications"),
    senderId: v.string(),
    senderName: v.string(),
    content: v.string(),
    isFromAdmin: v.boolean(),
    readBy: v.optional(v.array(v.string())),
  }).index("by_application", ["applicationId"]),

  botTests: defineTable({
    destination: v.string(),
    portalUrl: v.string(),
    portalName: v.string(),
    testUsername: v.optional(v.string()),
    testPassword: v.optional(v.string()),
    twoCaptchaApiKey: v.optional(v.string()),
    testType: v.optional(v.string()),  // "login" (défaut) | "logout"
    status: v.string(),
    result: v.optional(v.string()),
    latencyMs: v.optional(v.number()),
    httpStatus: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    requestedAt: v.number(),
    completedAt: v.optional(v.number()),
    requestedBy: v.string(),
  })
    .index("by_status", ["status"])
    .index("by_destination", ["destination"])
    .index("by_requested", ["requestedAt"]),

  notifications: defineTable({
    userId: v.string(),
    type: v.string(),
    title: v.string(),
    body: v.string(),
    applicationId: v.optional(v.id("applications")),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_unread", ["userId", "read"]),

  documents: defineTable({
    applicationId: v.id("applications"),
    docKey: v.string(),
    label: v.string(),
    storageId: v.string(),
    uploadedBy: v.string(),
    uploadedAt: v.number(),
    verifiedByAdmin: v.boolean(),
    isAdminUpload: v.optional(v.boolean()),
    adminNote: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_application_key", ["applicationId", "docKey"]),

  botLogs: defineTable({
    applicationId: v.id("applications"),
    ts: v.number(),
    step: v.string(),
    status: v.union(v.literal("ok"), v.literal("warn"), v.literal("fail")),
    data: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_ts", ["ts"]),

  // Sessions CEV — cookie + URL d'intégration capturés manuellement par l'admin
  // après résolution captcha sur le portail. Le bot poll ces sessions sans captcha.
  cevSessions: defineTable({
    applicationId: v.id("applications"),
    // URL complète d'intégration avec les 4 GUIDs
    // ex: /Integration/VOW/{partner}/{app}/{location}/{visa}/en-US
    integrationUrl: v.string(),
    // Cookie ASP.NET_SessionId (juste la valeur, sans le préfixe "ASP.NET_SessionId=")
    sessionCookie: v.string(),
    // active = polling en cours, expired = cookie mort, paused = admin a arrêté
    status: v.union(v.literal("active"), v.literal("expired"), v.literal("paused")),
    // Dernier résultat du poll
    lastResult: v.optional(v.union(
      v.literal("no_slot"),
      v.literal("slot_found"),
      v.literal("session_expired"),
      v.literal("error")
    )),
    lastCheckAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    checkCount: v.optional(v.number()),
    consecutiveErrors: v.optional(v.number()),
    // Intervalle de polling en ms (défaut 30000, min 10000, max 600000)
    pollIntervalMs: v.optional(v.number()),
    createdAt: v.number(),
    expiredAt: v.optional(v.number()),
    // Note libre admin (ex: "session pour Marie Dupont, dossier urgent")
    notes: v.optional(v.string()),
    // Verrouillage atomique anti-doublon (timestamp jusqu'à quand la session
    // est "claimée" par un worker — empêche multi-instances de la check en parallèle)
    lockedUntil: v.optional(v.number()),
    // Marqueur "déjà notifié pour ce slot" — évite le spam admin tant que la
    // session n'a pas été expirée/recréée par l'admin
    slotNotifiedAt: v.optional(v.number()),
  })
    .index("by_application", ["applicationId"])
    .index("by_status", ["status"]),
});
