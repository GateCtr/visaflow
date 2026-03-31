export const VISA_PRICING = {
  usa: {
    label: "États-Unis",
    flag: "🇺🇸",
    engagementFee: 150,
    successFee: 450,
    total: 600,
    successModel: "appointment" as const,
    visaTypes: ["B1/B2 (Tourisme/Affaires)", "F1 (Étudiant)", "K1 (Fiancé(e))", "H1B (Travail)", "J1 (Échange)"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité 5x5 fond blanc", required: true },
      { key: "proof_of_funds", label: "Relevés bancaires (3 derniers mois)", required: true },
      { key: "employment_letter", label: "Attestation de travail / RCCM", required: true },
      { key: "ds160_confirmation", label: "Confirmation DS-160", required: true },
      { key: "mrv_receipt", label: "Reçu paiement MRV (185$)", required: true },
    ],
    embassyAddress: "502 Gombe, Kinshasa, Ambassade des États-Unis",
    portalUrl: "https://www.usvisaappt.com/visaapplicantui/login",
    portalName: "AVITS / VISAPP (usvisaappt.com)",
    portalDashboardUrl: "https://www.usvisaappt.com/visaapplicantui/home/dashboard/requests",
    portalAppointmentUrl: "https://www.usvisaappt.com/visaapplicantui/home/appointment/myappointment",
    portalScheduleUrl: "https://www.usvisaappt.com/visaapplicantui/home/dashboard/Appointment-scheduled",
    apiBaseUrl: "https://www.usvisaappt.com/visauserapi",
    apiAdminBaseUrl: "https://www.usvisaappt.com/visaadministrationapi/v1",
    apiAuthProvider: "aws-cognito",
    apiUserProfileEndpoint: "/portal/getuser",
    apiAppointmentsEndpoint: "/portal/getappointments",
    apiAppointmentRequestsEndpoint: "/appointmentrequest/getallbyuser",
    missionId: 323,
    appointmentStatusCodes: {
      pending: 2,
      scheduled: 1,
      cancelled: 0,
    },
    processingType: "appointment",
    successCopy: {
      triggerLabel: "Créneau capturé",
      clientCtaTitle: "Créneau trouvé !",
      clientCtaBody: "Joventy a verrouillé un rendez-vous à l'ambassade. Réglez la prime de succès pour recevoir le PDF de confirmation officiel (indispensable pour l'entretien).",
      completedNote: "Téléchargez votre kit d'entretien complet ci-dessous.",
    },
    notes: "Les frais consulaires MRV (185$) sont payés séparément par le client directement à la banque.",
  },
  dubai: {
    label: "Dubaï (EAU)",
    flag: "🇦🇪",
    engagementFee: 50,
    successFee: 70,
    total: 120,
    successModel: "evisa" as const,
    visaTypes: ["Touriste 30j", "Touriste 60j", "Résidence", "Affaires"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité fond blanc (JPEG < 100kb)", required: true },
      { key: "travel_dates", label: "Billets d'avion (réservation)", required: true },
      { key: "hotel_booking", label: "Réservation hôtel confirmée", required: false },
    ],
    embassyAddress: "Portail GDRFA / ICP — 100% électronique",
    portalUrl: "https://smartservices.ica.gov.ae/echannels/web/client/default.html",
    portalName: "ICA UAE Smart Services (e-Visa EAU)",
    portalDashboardUrl: "https://smartservices.ica.gov.ae/echannels/web/client/default.html#/user/login",
    portalAppointmentUrl: "https://smartservices.ica.gov.ae/echannels/web/client/default.html#/eVisa/apply",
    portalScheduleUrl: "https://smartservices.ica.gov.ae/echannels/web/client/default.html#/eVisa/apply",
    processingType: "evisa",
    successCopy: {
      triggerLabel: "Visa obtenu",
      clientCtaTitle: "Votre visa est prêt !",
      clientCtaBody: "Les autorités des Émirats ont accordé votre visa électronique. Réglez la prime de succès pour recevoir votre e-Visa PDF prêt à imprimer.",
      completedNote: "Votre visa électronique est disponible ci-dessous — prêt à imprimer avant le départ.",
    },
    notes: "E-Visa 100% électronique. Résultat en 48-72h ouvrables. Les frais gouvernementaux e-Visa EAU (~90$) sont payés séparément par le client.",
  },
  turkey: {
    label: "Turquie",
    flag: "🇹🇷",
    engagementFee: 50,
    successFee: 70,
    total: 120,
    successModel: "appointment" as const,
    visaTypes: ["E-Visa (si visa USA/Schengen)", "Visa Sticker (VFS Kinshasa)"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité", required: true },
      { key: "bank_statements", label: "Relevés bancaires (3 derniers mois)", required: true },
      { key: "employment_letter", label: "Certificat de travail / RCCM", required: true },
      { key: "hotel_booking", label: "Réservation hôtel confirmée (normes turques)", required: true },
      { key: "travel_insurance", label: "Assurance voyage (normes turques)", required: true },
    ],
    embassyAddress: "VFS Global — Avenue de la Gombe, Kinshasa",
    portalUrl: "https://visa.vfsglobal.com/cod/fr/tur",
    portalName: "VFS Global Turquie (COD → TUR)",
    portalDashboardUrl: "https://visa.vfsglobal.com/cod/fr/tur/application-detail",
    portalAppointmentUrl: "https://visa.vfsglobal.com/cod/fr/tur/book-an-appointment",
    portalScheduleUrl: "https://visa.vfsglobal.com/cod/fr/tur/book-an-appointment",
    processingType: "hybrid",
    successCopy: {
      triggerLabel: "Créneau VFS capturé",
      clientCtaTitle: "Créneau VFS trouvé !",
      clientCtaBody: "Joventy a réservé un créneau au centre de dépôt VFS Global. Réglez la prime de succès pour recevoir votre convocation de dépôt.",
      completedNote: "Votre convocation VFS et les instructions de dépôt sont disponibles ci-dessous.",
    },
    notes: "E-Visa uniquement si le client possède déjà un visa USA ou Schengen valide. Sinon : Visa Sticker via VFS. Les frais consulaires (100$ entrée unique / 300$ multi-entrées) et frais VFS sont payés séparément par le client.",
  },
  india: {
    label: "Inde",
    flag: "🇮🇳",
    engagementFee: 100,
    successFee: 150,
    total: 250,
    successModel: "evisa" as const,
    visaTypes: ["e-Visa Touriste", "Médical (e-Medical)", "Études (Regular Visa)"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité fond blanc", required: true },
      { key: "invitation_letter", label: "Lettre d'invitation (hôpital/université)", required: true },
      { key: "proof_of_funds", label: "Relevés bancaires", required: true },
      { key: "medical_recommendation", label: "Lettre de recommandation médecin RDC (Médical)", required: false },
    ],
    embassyAddress: "Ambassade de l'Inde — Avenue de la Gombe, Kinshasa",
    portalUrl: "https://indianvisaonline.gov.in/evisa/tvoa.html",
    portalName: "Indian Visa Online (e-Visa Inde)",
    portalDashboardUrl: "https://indianvisaonline.gov.in/evisa/tvoa.html",
    portalAppointmentUrl: "https://indianvisaonline.gov.in/evisa/tvoa.html",
    portalScheduleUrl: "https://indianvisaonline.gov.in/evisa/StatusEnquiry.html",
    processingType: "evisa",
    successCopy: {
      triggerLabel: "E-Visa obtenu",
      clientCtaTitle: "Votre e-Visa Inde est prêt !",
      clientCtaBody: "Le gouvernement indien a accordé votre e-Visa. Réglez la prime de succès pour recevoir votre document officiel à imprimer avant l'embarquement.",
      completedNote: "Votre e-Visa Inde est disponible ci-dessous — à imprimer et présenter à l'embarquement.",
    },
    notes: "Pour le Médical : vérification accréditation hôpital incluse. Pour les Études longue durée : entretien physique à l'Ambassade possible. Les frais e-Visa gouvernement indien (~25-80$ selon durée) sont payés séparément par le client.",
  },
} as const;

export type Destination = keyof typeof VISA_PRICING;
export type SuccessModel = "appointment" | "evisa";
export type ServicePackage = "full_service" | "slot_only" | "dossier_only";

export const SLOT_URGENCY_TIERS = {
  standard: {
    key: "standard" as const,
    label: "Standard",
    tagline: "> 3 mois",
    desc: "Date souhaitée dans plus de 3 mois",
    depositAmount: 50,
    successAmount: 100,
    total: 150,
    variableNote: null,
  },
  prioritaire: {
    key: "prioritaire" as const,
    label: "Prioritaire",
    tagline: "1 à 3 mois",
    desc: "Date souhaitée dans 1 à 3 mois",
    depositAmount: 80,
    successAmount: 170,
    total: 250,
    variableNote: null,
  },
  urgent: {
    key: "urgent" as const,
    label: "Urgent",
    tagline: "3 à 6 semaines",
    desc: "Date souhaitée dans 3 à 6 semaines",
    depositAmount: 100,
    successAmount: 250,
    total: 350,
    variableNote: null,
  },
  tres_urgent: {
    key: "tres_urgent" as const,
    label: "Très Urgent",
    tagline: "< 3 semaines / ASAP",
    desc: "Date souhaitée dans moins de 3 semaines ou dès que possible",
    depositAmount: 150,
    successAmount: 300,
    total: 450,
    variableNote: "Prime indicative — peut dépasser 450 $ selon disponibilité. Confirmée par Joventy.",
  },
} as const;

export type SlotUrgencyTier = keyof typeof SLOT_URGENCY_TIERS;

export const SERVICE_PACKAGES = {
  full_service: {
    key: "full_service" as const,
    label: "Service Complet",
    tagline: "Recommandé",
    description: "Joventy remplit les formulaires officiels, vérifie les pièces que vous fournissez et gère la recherche de créneau ou la soumission du visa électronique.",
    hasSuccessFee: true,
    availableFor: "all" as const,
  },
  slot_only: {
    key: "slot_only" as const,
    label: "Créneau Uniquement",
    tagline: "Dossier prêt",
    description: "Vos formulaires sont remplis et vos pièces prêtes ? Joventy se concentre uniquement sur l'obtention d'un créneau de rendez-vous consulaire.",
    hasSuccessFee: true,
    availableFor: ["usa", "turkey"] as const,
  },
  dossier_only: {
    key: "dossier_only" as const,
    label: "Formulaires & Vérification",
    tagline: "Tarif fixe",
    description: "Joventy remplit les formulaires requis et vérifie les pièces que vous fournissez. Vous gérez ensuite votre rendez-vous ou soumission de façon autonome. Tarif fixe.",
    hasSuccessFee: false,
    availableFor: "all" as const,
  },
} as const;

export function getAvailablePackages(destination: string): ServicePackage[] {
  const result: ServicePackage[] = ["full_service", "dossier_only"];
  const slotPkg = SERVICE_PACKAGES.slot_only;
  if ((slotPkg.availableFor as readonly string[]).includes(destination)) {
    result.splice(1, 0, "slot_only");
  }
  return result;
}

export const APPLICATION_STATUSES = {
  awaiting_engagement_payment: {
    label: "En attente de paiement",
    description: "Frais d'engagement à régler pour activer le dossier",
    color: "orange",
    step: 1,
  },
  documents_pending: {
    label: "Documents requis",
    description: "Veuillez uploader vos documents dans le coffre-fort",
    color: "blue",
    step: 2,
  },
  in_review: {
    label: "En traitement",
    description: "Votre dossier est en cours d'examen par Joventy",
    color: "blue",
    step: 3,
  },
  slot_hunting: {
    label: "En cours de traitement",
    description: "Notre équipe travaille activement sur votre dossier",
    color: "purple",
    step: 3,
  },
  slot_found_awaiting_success_fee: {
    label: "Résultat obtenu !",
    description: "Réglez la prime de succès pour débloquer votre document",
    color: "green",
    step: 4,
  },
  completed: {
    label: "Dossier complété",
    description: "Votre document est disponible — félicitations !",
    color: "green",
    step: 5,
  },
  rejected: {
    label: "Dossier rejeté",
    description: "Votre dossier n'a pas pu être traité",
    color: "red",
    step: 0,
  },
} as const;

export type ApplicationStatus = keyof typeof APPLICATION_STATUSES;

export const MOBILE_MONEY_INFO = {
  mpesa: { name: "M-Pesa", number: "+243 840 808 122", instructions: "Envoyez le montant exact au numéro ci-dessus, puis uploadez la capture d'écran du reçu." },
  airtel: { name: "Airtel Money", number: "0820 344 541", instructions: "Envoyez le montant exact au numéro ci-dessus, puis uploadez la capture d'écran du reçu." },
  orange: { name: "Orange Money", number: "0990 775 880", instructions: "Envoyez le montant exact au numéro ci-dessus, puis uploadez la capture d'écran du reçu." },
};
