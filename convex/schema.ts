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
  // RK-Termin Allemagne — noms séparés pour le formulaire de booking (prioritaires sur applicantName)
  applicantFirstname: v.optional(v.string()),
  applicantLastname: v.optional(v.string()),
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
  // Session CEV active persistée — survie aux crashs/redémarrages Railway
  cevActiveSessionCookie: v.optional(v.string()),      // Cookies ASP.NET_SessionId
  cevActiveSessionValidUntil: v.optional(v.string()),  // ISO string de validUntil (depuis SetCaptchaToken)
  cevActiveSessionRedirectUrl: v.optional(v.string()), // redirectUrl (Referer pour AvailableTimeSlots)
  // Mode reporter USA — cherche un créneau antérieur au RDV existant
  rescheduleMode: v.optional(v.boolean()),
  rescheduleExistingDate: v.optional(v.string()),      // "YYYY-MM-DD" — date du RDV actuel (deadline = veille)
  // Proxy résidentiel USA (sticky 60 min — désactivé par défaut)
  useResidentialProxy: v.optional(v.boolean()),
  // ═══ V3 Chasseur — nouveaux champs admin ═══
  // Rôle du compte dans la stratégie multi-compte
  accountRole: v.optional(v.union(v.literal("eclaireur"), v.literal("confine"), v.literal("hybride"))),
  // Date du RDV actuel (auto-détection rôle : < 6 mois = éclaireur, > 6 mois = confiné)
  currentAppointmentDate: v.optional(v.string()),
  // Override budget login journalier (défaut: 9, max: 10)
  maxLoginsPerDay: v.optional(v.number()),
  // Fenêtres rush personnalisées par dossier (JSON string parsé au runtime)
  rushWindows: v.optional(v.string()),
  // Activer le blind booking cross-account (éclaireur broadcast aux confinés)
  blindBookingEnabled: v.optional(v.boolean()),
  // Dates préférées pour le booking (patterns wildcard ex: "2026-09-*")
  slotPriorityDates: v.optional(v.array(v.string())),
  // Nombre max de mois à scanner dans le calendrier (défaut: 3)
  maxMonthsToScan: v.optional(v.number()),
  // Activer le mode nuit (1 login nocturne à 02:00 UTC)
  nightModeEnabled: v.optional(v.boolean()),
  // Proxy préféré pour ce dossier ("iproyal" | "brightdata" | "2captcha")
  preferredProxy: v.optional(v.string()),
  // ═══ CEV Dossier Loop v3 — Multi-comptes ═══
  // Pool de dossiers VOWINT pour ce compte (ex: "VOWINT1,VOWINT2,VOWINT3")
  // Si vide, utilise vowintAppId comme seul dossier
  cevDossierPool: v.optional(v.string()),
  // Dossiers qui tentent le booking quand un créneau est détecté (vide = tous les dossiers du pool)
  cevBookingTargetPool: v.optional(v.string()),
  // Activer/désactiver proxy pour ce compte (hérite de la config globale si null)
  cevUseProxy: v.optional(v.boolean()),
  // Intervalle de scan personnalisé (secondes, défaut: 225 = 3min45)
  cevScanIntervalSec: v.optional(v.number()),
  // Nombre minimum de places libres requis par créneau (group booking)
  // CEV: remplace le seuil hardcodé 3 ; Spain: filtre freeslots≥N ; Germany: slots dispo/jour≥N
  // Absent ou 0 = comportement par défaut (solo booking, aucun filtre)
  groupSize: v.optional(v.number()),
  // ══════════════════════════════════════════════════════════════════════════
  // SIPHONNAGE F5 — Cookies WAF BIG-IP injectés depuis l'extérieur
  // ══════════════════════════════════════════════════════════════════════════
  /** Cookie WAF F5 BIG-IP (valeur du TS01*) siphonné depuis un vrai navigateur */
  cevSiphonedF5CookieValue: v.optional(v.string()),
  /** Nom du cookie F5 (ex: "TS0110ceb4") */
  cevSiphonedF5CookieName: v.optional(v.string()),
  /** ASP.NET_SessionId siphonné */
  cevSiphonedAspNetSessionId: v.optional(v.string()),
  /** User-Agent EXACT du navigateur qui a généré les cookies siphonnés */
  cevSiphonedUserAgent: v.optional(v.string()),
  /** Timestamp de l'injection des cookies siphonnés */
  cevSiphonedAt: v.optional(v.number()),
  /** Timestamp d'expiration estimé des cookies siphonnés */
  cevSiphonedValidUntil: v.optional(v.number()),
  // Annulation automatique du RDV existant quand la limite Overview est atteinte (Cas 2)
  // Quand true : détecte overviewState='limit_reached' → extrait le lien Annuler → suit le flow d'annulation
  cevAutoCancelOnLimitReached: v.optional(v.boolean()),
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
    onboardingCompletedAt: v.optional(v.number()),
    /** Suivi des relances d'engagement (ex: "no_app_3d") */
    remindersSent: v.optional(v.array(v.string())),
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
    trackingToken: v.optional(v.string()),
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
    // Spain — config OTP automatique (email/SMS pour interception code portail)
    spainOtpConfig: v.optional(v.object({
      channel: v.union(v.literal("email"), v.literal("sms"), v.literal("manual")),
      email: v.optional(v.string()),
      imapPassword: v.optional(v.string()),
      phone: v.optional(v.string()),
      configuredAt: v.number(),
      lastUsedAt: v.optional(v.number()),
    })),
    // Schengen / CEV spécifique (drive le calcul des frais consulaires)
    cevVisaClass: v.optional(v.union(v.literal("A"), v.literal("C"), v.literal("D"))),
    cevApplicantAgeCategory: v.optional(v.union(
      v.literal("adult"),
      v.literal("child_6_12"),
      v.literal("child_under_6"),
    )),
    cevTargetCountry: v.optional(v.string()), // ex: "BE", "FR", "DE"
    // ═══ Segmentation Visa USA — micro-meutes homogènes ═══
    // Code visa normalisé pour le portail (ex: "F1", "B1/B2", "H1B", "IR1", "DV")
    usVisaCode: v.optional(v.string()),
    // Catégorie macro : "NIV" (Non-Immigrant) ou "IV" (Immigrant)
    usVisaCategory: v.optional(v.union(v.literal("NIV"), v.literal("IV"))),
    // Classe de broadcast normalisée (groupement portail : "F1", "B1/B2", "H", "K", "IR", "DV"...)
    // Deux comptes partagent un canal de broadcast SSI ils ont le MÊME broadcastVisaClass.
    broadcastVisaClass: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_status", ["status"])
    .index("by_updated", ["updatedAt"])
    .index("by_tracking_token", ["trackingToken"])
    .index("by_broadcast_visa_class", ["broadcastVisaClass"]),

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
  })
    .index("by_application", ["applicationId"])
    .index("by_is_from_admin", ["isFromAdmin"]),

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
    // active       = polling en cours
    // needs_setup  = URL fournie, cookie absent → bot doit établir la session
    // expired      = cookie mort, bot tentera un re-setup automatique si possible
    // paused       = admin a arrêté manuellement
    status: v.union(v.literal("active"), v.literal("needs_setup"), v.literal("expired"), v.literal("paused")),
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
    // Identifiants VOWINT pour que le bot puisse se connecter et régénérer
    // l'URL d'intégration de manière autonome quand la session expire.
    vowintEmail: v.optional(v.string()),
    vowintPassword: v.optional(v.string()),
    vowintAppUrl: v.optional(v.string()), // URL dossier spécifique (vide = auto-détection)
    // Nombre cumulé d'échecs de login VOWINT (survie aux redémarrages Railway)
    // Quand loginFailCount >= 3, la session est automatiquement passée en "paused"
    loginFailCount: v.optional(v.number()),
    // Note libre admin (ex: "session pour Marie Dupont, dossier urgent")
    notes: v.optional(v.string()),
    // Verrouillage atomique anti-doublon (timestamp jusqu'à quand la session
    // est "claimée" par un worker — empêche multi-instances de la check en parallèle)
    lockedUntil: v.optional(v.number()),
    // Marqueur "déjà notifié pour ce slot" — évite le spam admin tant que la
    // session n'a pas été expirée/recréée par l'admin
    slotNotifiedAt: v.optional(v.number()),
    // ══════════════════════════════════════════════════════════════════════════
    // NOUVEAUX CHAMPS - Statistiques détaillées et monitoring
    // ══════════════════════════════════════════════════════════════════════════
    // Timestamp d'expiration de la session (retourné par SetCaptchaToken)
    validUntilMs: v.optional(v.number()),
    // Moment où la session a été activée (passage de needs_setup → active)
    activatedAt: v.optional(v.number()),
    // Nombre total de slots trouvés depuis le début
    slotsFoundCount: v.optional(v.number()),
    // Timestamp du dernier slot trouvé
    lastSlotFoundAt: v.optional(v.number()),
    // Nombre de renouvellements automatiques via VOWINT (sessions recréées)
    autoRenewalCount: v.optional(v.number()),
    // Timestamp du dernier renouvellement automatique
    lastAutoRenewalAt: v.optional(v.number()),
    // Temps total de polling en ms (cumulé sur tous les cycles de vie)
    totalPollingDurationMs: v.optional(v.number()),
    // Nombre de tentatives de setup (login VOWINT + hCaptcha)
    setupAttempts: v.optional(v.number()),
    // Dernière erreur de setup détaillée
    lastSetupError: v.optional(v.string()),
    // Timestamp du dernier setup réussi
    lastSuccessfulSetupAt: v.optional(v.number()),
    // ══════════════════════════════════════════════════════════════════════════
    // SIPHONNAGE F5 — Cookies WAF BIG-IP injectés depuis l'extérieur
    // ══════════════════════════════════════════════════════════════════════════
    /** Cookie WAF F5 BIG-IP (valeur du TS01*) siphonné depuis un vrai navigateur */
    siphonedF5CookieValue: v.optional(v.string()),
    /** Nom du cookie F5 (ex: "TS0110ceb4") */
    siphonedF5CookieName: v.optional(v.string()),
    /** ASP.NET_SessionId siphonné (remplace le sessionCookie normal si présent) */
    siphonedAspNetSessionId: v.optional(v.string()),
    /** User-Agent EXACT du navigateur qui a généré les cookies siphonnés */
    siphonedUserAgent: v.optional(v.string()),
    /** Timestamp de l'injection des cookies siphonnés */
    siphonedAt: v.optional(v.number()),
    /** Timestamp d'expiration estimé des cookies siphonnés */
    siphonedValidUntil: v.optional(v.number()),
  })
    .index("by_application", ["applicationId"])
    .index("by_status", ["status"]),

  // Configuration auto-découverte par le bot lors du premier booking réussi.
  // Clé-valeur JSON persisté — survit aux redémarrages Railway sans redéploiement.
  // Clé typique : "cev_booking_config_v1"
  botConfig: defineTable({
    key: v.string(),
    value: v.string(),    // JSON.stringify'd
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Spain Watcher — singleton config + scan history (no applicationId needed)
  spainWatcher: defineTable({
    key: v.string(),            // toujours "default" (singleton)
    isActive: v.boolean(),
    portalUrl: v.string(),      // URL Bookitit citaconsular.es à surveiller
    adminEmail: v.string(),     // email de l'admin à alerter lors d'un créneau trouvé
    intervalMin: v.optional(v.number()), // ancien réglage en minutes (compatibilité)
    intervalSec: v.optional(v.number()), // intervalle HTTP entre débuts de probe (défaut 60)
    lastScanAt: v.optional(v.number()),
    lastResult: v.optional(v.union(
      v.literal("found"),
      v.literal("not_found"),
      v.literal("error"),
    )),
    lastSlotInfo: v.optional(v.string()),
    consecutiveErrors: v.optional(v.number()),
    updatedAt: v.number(),
    // Admin rush-prep commands (CF re-solve + session pre-warm)
    rushPrepCommand: v.optional(v.union(v.literal("cf_resolve"), v.literal("session_prep"))),
    rushPrepAt: v.optional(v.number()),
    rushPrepResult: v.optional(v.string()),   // "ok" | "error: <msg>" — set by bot on ack
    rushPrepAckedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  spainWatcherScans: defineTable({
    ts: v.number(),
    status: v.union(v.literal("found"), v.literal("not_found"), v.literal("error")),
    slotInfo: v.optional(v.string()),
    screenshotStorageId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    // Page capture data (network requests, headers, responses, cookies, HTML)
    pageCaptures: v.optional(v.string()), // JSON-encoded array of captured requests
    detectedServices: v.optional(v.string()), // JSON: [{serviceId, serviceName}] when status=found
    detectedSlots: v.optional(v.string()),    // JSON: [{id, name, slots: [{d, t, n}]}] — dates/heures exactes
  }).index("by_ts", ["ts"]),

  // OTP challenges for portal flows requiring user one-time code (e.g. Spain confirmclient)
  otpChallenges: defineTable({
    applicationId: v.id("applications"),
    flow: v.string(), // e.g. "spain"
    channel: v.string(), // e.g. "telegram"
    status: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("consumed"),
      v.literal("expired"),
      v.literal("cancelled"),
    ),
    code: v.optional(v.string()),
    chatId: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    submittedAt: v.optional(v.number()),
    consumedAt: v.optional(v.number()),
  })
    .index("by_application", ["applicationId"])
    .index("by_status", ["status"]),

  // Slot discoveries — chaque date captée/ignorée par le bot (analyse fréquence disponibilité)
  // Dédupliquées par (applicationId + office + dateFound + outcome) sur 24h.
  // seenCount/seenAt trackent combien de fois et quand le créneau a été vu (heatmap heures).
  slotDiscoveries: defineTable({
    applicationId: v.id("applications"),
    destination: v.string(),        // "usa", "schengen", "spain"
    office: v.string(),             // nom du bureau (ex: "Kinshasa", "Bruxelles")
    dateFound: v.string(),          // date découverte au format YYYY-MM-DD
    timeFound: v.optional(v.string()), // heure si disponible (ex: "8:00")
    outcome: v.union(v.literal("captured"), v.literal("ignored")),
    reason: v.optional(v.string()), // raison si ignoré (after_deadline, before_from_date, no_time_slots)
    context: v.optional(v.string()), // JSON stringifié avec contexte additionnel
    /** Mode de scan : "schedule" (nouveau booking) ou "reschedule" (reporter un RDV existant). */
    mode: v.optional(v.union(v.literal("schedule"), v.literal("reschedule"))),
    discoveredAt: v.number(),       // timestamp de la PREMIÈRE découverte
    /** Nombre de fois où ce créneau a été vu (dédupliqué sur 24h). */
    seenCount: v.optional(v.number()),
    /** Timestamps de chaque observation (alimente le graphe "heures de disponibilité"). */
    seenAt: v.optional(v.array(v.number())),
    /** Timestamp de la dernière observation. */
    lastSeenAt: v.optional(v.number()),
  })
    .index("by_application", ["applicationId"])
    .index("by_destination", ["destination"])
    .index("by_discovered", ["discoveredAt"])
    .index("by_destination_office", ["destination", "office"])
    .index("by_date_found", ["dateFound"]),

  // ─── Slot Broadcast (V3 Blind Booking) ──────────────────────────────────────
  // Événements de slots détectés par un éclaireur et partagés aux confinés.
  // TTL court (5 min) — les confinés doivent réagir rapidement.
  slotBroadcasts: defineTable({
    /** Compte éclaireur qui a détecté le slot. */
    sourceUsername: v.string(),
    /** Classe de visa normalisée pour le filtrage de canal (ex: "F1", "B1/B2", "H", "K"). */
    visaClass: v.optional(v.string()),
    /** Bureau (OFC/POST). */
    office: v.string(),
    /** postUserId du bureau. */
    postUserId: v.number(),
    /** Date du slot (YYYY-MM-DD). */
    date: v.string(),
    /** Heure formatée (ex: "9:00 AM"). */
    time: v.string(),
    /** slotId brut (alphanumérique). */
    slotId: v.string(),
    /** startTime brut du slot. */
    startTime: v.string(),
    /** Timestamp de la découverte par l'éclaireur. */
    discoveredAt: v.number(),
    /** L'éclaireur a-t-il déjà booké ce slot ? */
    sourceBooked: v.boolean(),
    /** Comptes qui ont déjà traité cet événement (ACK). */
    processedBy: v.optional(v.array(v.string())),
    /** Résultat par compte (pour stats). */
    results: v.optional(v.array(v.object({
      username: v.string(),
      result: v.union(v.literal("booked"), v.literal("failed"), v.literal("expired")),
      processedAt: v.number(),
    }))),
  })
    .index("by_discovered", ["discoveredAt"])
    .index("by_source", ["sourceUsername"])
    .index("by_visa_class", ["visaClass"])
    .index("by_visa_class_discovered", ["visaClass", "discoveredAt"]),

  // ─── Relay System (V3 Auto-Relay) ───────────────────────────────────────────
  // Système de relais automatique éclaireur → confiné au sein d'une même meute.
  // Quand un éclaireur épuise son budget (ou atteint une fenêtre planifiée),
  // il passe le relais à un autre compte de la même broadcastVisaClass.
  // Le successeur promeut son rôle en "eclaireur" et l'ancien se confine.
  contractSignatures: defineTable({
    userId: v.string(),
    signedName: v.string(),
    contractVersion: v.string(),
    signedAt: v.number(),
    userAgent: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_user_version", ["userId", "contractVersion"]),

  slotRelayState: defineTable({
    /** Classe de visa de la meute (ex: "F1", "B1/B2"). */
    visaClass: v.string(),
    /** Username du compte actuellement éclaireur. */
    currentEclaireur: v.string(),
    /** ApplicationId du dossier éclaireur actif. */
    currentEclaireurAppId: v.id("applications"),
    /** Timestamp de prise de relais. */
    activeeSince: v.number(),
    /** Fenêtres de relais planifiées (heures Kinshasa en décimal). */
    relayWindows: v.optional(v.array(v.object({
      hour: v.number(),
      durationMinutes: v.optional(v.number()),
    }))),
    /** Historique des relais (pour stats/debug). */
    history: v.optional(v.array(v.object({
      from: v.string(),
      to: v.string(),
      reason: v.string(),
      at: v.number(),
    }))),
    updatedAt: v.number(),
  })
    .index("by_visa_class", ["visaClass"])
    .index("by_current_eclaireur", ["currentEclaireur"]),

  // ─── Traffic Analytics ────────────────────────────────────────────────────
  pageViews: defineTable({
    sessionId: v.string(),
    path: v.string(),
    month: v.string(),      // "YYYY-MM" pour grouper par mois
    timestamp: v.number(),
    referrer: v.optional(v.string()), // document.referrer capturé au 1er chargement de la session
  })
    .index("by_month", ["month"])
    .index("by_session_month", ["sessionId", "month"]),

  presence: defineTable({
    sessionId: v.string(),
    path: v.string(),
    lastSeen: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_lastSeen", ["lastSeen"]),

  // ─── Agent Victor ─────────────────────────────────────────────────────────
  chatSessions: defineTable({
    sessionId: v.string(),
    messagesLastMinute: v.number(),
    messagesLastHour: v.number(),
    windowMinuteStart: v.number(),
    windowHourStart: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_session", ["sessionId"]),

  // ─── Alerte Rendez-vous Espagne ───────────────────────────────────────────
  // Commandes d'accès au groupe WhatsApp d'alerte créneaux Espagne (10 USD lifetime).
  spainAlertOrders: defineTable({
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    proofStorageId: v.string(),       // Capture preuve de paiement (Convex Storage)
    status: v.union(
      v.literal("pending"),           // En attente de confirmation admin
      v.literal("confirmed"),         // Paiement validé — email groupe envoyé
      v.literal("rejected"),          // Paiement rejeté
    ),
    createdAt: v.number(),
    confirmedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    adminNote: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_email", ["email"])
    .index("by_created", ["createdAt"]),

  // ─── Alerte Rendez-vous Schengen ──────────────────────────────────────────
  // Commandes d'accès au groupe WhatsApp d'alerte créneaux Schengen (10 USD lifetime).
  schengenAlertOrders: defineTable({
    name: v.string(),
    email: v.string(),
    phone: v.optional(v.string()),
    proofStorageId: v.string(),       // Capture preuve de paiement (Convex Storage)
    status: v.union(
      v.literal("pending"),           // En attente de confirmation admin
      v.literal("confirmed"),         // Paiement validé — email groupe envoyé
      v.literal("rejected"),          // Paiement rejeté
    ),
    createdAt: v.number(),
    confirmedAt: v.optional(v.number()),
    rejectedAt: v.optional(v.number()),
    adminNote: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_email", ["email"])
    .index("by_created", ["createdAt"]),

  victorConversations: defineTable({
    sessionId: v.string(),
    pageContext: v.string(),
    isAuth: v.boolean(),
    messages: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("victor")),
        content: v.string(),
        ts: v.number(),
      })
    ),
    // convinced = true UNIQUEMENT si l'utilisateur a réellement complété une action (dossier créé, etc.)
    // N'est PAS mis à true sur simple clic CTA
    convinced: v.boolean(),
    convincedAt: v.optional(v.number()),
    // Actions réellement complétées (ex: "dossier_created", "contrat_signed")
    actionsTaken: v.optional(v.array(v.string())),
    // Clics CTA (intention, non completion) — pour distinguer intent vs succès réel
    ctaClicks: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_session", ["sessionId"]),
});
