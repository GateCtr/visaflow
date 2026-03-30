export const VISA_PRICING = {
  usa: {
    label: "États-Unis",
    flag: "🇺🇸",
    engagementFee: 150,
    successFee: 450,
    total: 600,
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
    processingType: "appointment",
    notes: "Les frais consulaires MRV (185$) sont payés séparément par le client directement à la banque.",
  },
  dubai: {
    label: "Dubaï (EAU)",
    flag: "🇦🇪",
    engagementFee: 50,
    successFee: 50,
    total: 100,
    visaTypes: ["Touriste 30j", "Touriste 60j", "Résidence", "Affaires"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité fond blanc (JPEG < 100kb)", required: true },
      { key: "travel_dates", label: "Billets d'avion (réservation)", required: true },
      { key: "hotel_booking", label: "Réservation hôtel confirmée", required: false },
    ],
    embassyAddress: "Portail GDRFA / ICP — 100% électronique",
    processingType: "evisa",
    notes: "E-Visa 100% électronique. Résultat en 48-72h ouvrables.",
  },
  turkey: {
    label: "Turquie",
    flag: "🇹🇷",
    engagementFee: 50,
    successFee: 70,
    total: 120,
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
    processingType: "hybrid",
    notes: "E-Visa uniquement si le client possède déjà un visa USA ou Schengen valide. Sinon : Visa Sticker via VFS.",
  },
  india: {
    label: "Inde",
    flag: "🇮🇳",
    engagementFee: 100,
    successFee: 150,
    total: 250,
    visaTypes: ["e-Visa Touriste", "Médical (e-Medical)", "Études (Regular Visa)"],
    requiredDocuments: [
      { key: "passport_scan", label: "Passeport (scan HD)", required: true },
      { key: "photo_id", label: "Photo d'identité fond blanc", required: true },
      { key: "invitation_letter", label: "Lettre d'invitation (hôpital/université)", required: true },
      { key: "proof_of_funds", label: "Relevés bancaires", required: true },
      { key: "medical_recommendation", label: "Lettre de recommandation médecin RDC (Médical)", required: false },
    ],
    embassyAddress: "Ambassade de l'Inde — Avenue de la Gombe, Kinshasa",
    processingType: "evisa",
    notes: "Pour le Médical : vérification accréditation hôpital incluse. Pour les Études longue durée : entretien physique à l'Ambassade possible.",
  },
} as const;

export type Destination = keyof typeof VISA_PRICING;

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
    label: "Recherche de créneau",
    description: "Notre système surveille les disponibilités de l'ambassade",
    color: "purple",
    step: 3,
  },
  slot_found_awaiting_success_fee: {
    label: "Créneau trouvé !",
    description: "Un rendez-vous a été capturé — réglez la prime de succès",
    color: "green",
    step: 4,
  },
  completed: {
    label: "Dossier complété",
    description: "Rendez-vous confirmé — téléchargez votre kit d'entretien",
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
  mpesa: { name: "M-Pesa", number: "+243 XX XXX XXXX", instructions: "Envoyez le montant exact au numéro ci-dessus, puis uploadez la capture d'écran du reçu." },
  airtel: { name: "Airtel Money", number: "+243 XX XXX XXXX", instructions: "Envoyez le montant exact au numéro ci-dessus, puis uploadez la capture d'écran du reçu." },
};
