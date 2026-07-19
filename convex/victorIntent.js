export function stripAccents(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function countHits(flags) {
  return flags.filter(Boolean).length;
}

export function inferQuestionFocus(message) {
  const normalized = stripAccents(message.toLowerCase());
  const mentionsAppointment = /(rendez[- ]?vous|creneau|rdv|appointment|slot)/.test(normalized);
  const mentionsPrice = /(prix|tarif|cout|combien|frais|payer|paye|combien ca coute)/.test(normalized);
  const mentionsDocument = /(document|passeport|formulaire|ds-160|vowint|sevis|mrv|assurance|photo|dossier)/.test(normalized);
  const mentionsTimeline = /(delai|temps|quand|combien de temps|attente|disponibilit|date)/.test(normalized);
  const mentionsPaymentTiming = /(quand payer|a quel moment payer|à quel moment payer|paiement.*(avant|apres|après)|(avant|apres|après).*(paiement|payer|paye)|avant ou apres|avant ou après|avant le rendez[- ]?vous|après le rendez[- ]?vous)/.test(normalized);
  const mentionsPaymentStructure = /(partiel|total|acompte|solde|en plusieurs fois|versement|avance)/.test(normalized);
  const mentionsEligibility = /(eligib|peux[- ]?je|est[- ]?ce que|peut[- ]?on|conditions|conditions d[' ]?acces)/.test(normalized);
  const mentionsFullService = /(service complet|dossier complet|accompagnement complet|tout faire|prise en charge complete|de bout en bout|du debut a la fin)/.test(normalized);

  const topicCount = countHits([
    mentionsAppointment,
    mentionsPrice,
    mentionsDocument,
    mentionsTimeline,
    mentionsPaymentTiming,
    mentionsPaymentStructure,
    mentionsEligibility,
    mentionsFullService,
  ]);

  if (mentionsAppointment && mentionsPaymentTiming) return "appointment_payment_terms";
  if (topicCount > 2) return "mixed_multi";
  if (mentionsAppointment && mentionsPrice) return "appointment_price";
  if (mentionsDocument && mentionsPrice) return "document_price";
  if (mentionsAppointment && mentionsTimeline) return "appointment_timeline";
  if (mentionsDocument && mentionsTimeline) return "document_timeline";
  if (mentionsPrice && mentionsTimeline) return "price_timeline";
  if (mentionsPaymentTiming && mentionsPaymentStructure) return "payment_terms";
  if (mentionsPaymentStructure) return "payment_structure";
  if (mentionsPaymentTiming) return "payment_terms";
  if (mentionsAppointment) return "appointment_only";
  if (mentionsPrice) return "price_only";
  if (mentionsDocument) return "document";
  if (mentionsTimeline) return "timeline";
  if (mentionsEligibility) return "eligibility";
  if (mentionsFullService) return "full_service";

  if (topicCount > 1) return "mixed_multi";
  return "general";
}

export function buildQuestionFocusBlock(message) {
  switch (inferQuestionFocus(message)) {
    case "appointment_payment_terms":
      return "La demande porte sur le paiement lié au rendez-vous. Réponds clairement si le paiement se fait avant ou après le rendez-vous, sans parler d'un autre service ou du dossier complet.";
    case "appointment_price":
      return "La demande porte sur le prix d'un rendez-vous ou d'un créneau. Réponds uniquement sur le service de rendez-vous concerné, pas sur le visa complet ni sur le dossier complet.";
    case "document_price":
      return "La demande mélange un document et son prix. Réponds sur le prix du document demandé, sans basculer vers le dossier complet. Si le prix varie selon le document, demande une seule précision.";
    case "appointment_timeline":
      return "La demande mélange un rendez-vous et un délai. Réponds sur le délai du rendez-vous ou du créneau demandé, pas sur le visa complet.";
    case "document_timeline":
      return "La demande mélange un document et un délai. Réponds sur le délai lié à ce document, pas sur tout le dossier.";
    case "price_timeline":
      return "La demande mélange un prix et un délai. Réponds d'abord au prix demandé, puis au délai si la question le demande explicitement.";
    case "payment_terms":
      return "La demande porte sur le moment du paiement. Réponds clairement si le paiement se fait avant ou après, sans parler d'un autre service ou du dossier complet.";
    case "payment_structure":
      return "La demande porte sur la structure du paiement. Réponds clairement si c'est partiel, total, en acompte ou en solde, sans élargir au visa complet.";
    case "appointment_only":
      return "La demande porte sur un rendez-vous, un créneau ou une prise de slot. Réponds uniquement sur ce sujet et ne bascule pas vers le visa complet sauf si le visiteur le demande ensuite.";
    case "price_only":
      return "La demande porte sur un prix ou un tarif. Donne le prix de l'objet demandé précisément, sans élargir à un autre service.";
    case "document":
      return "La demande porte sur un document, un formulaire ou une pièce à fournir. Réponds uniquement sur ce point précis, pas sur le dossier complet.";
    case "timeline":
      return "La demande porte sur un délai, une attente ou une disponibilité. Réponds uniquement sur le délai ou l'état d'avancement demandé.";
    case "eligibility":
      return "La demande porte sur l'éligibilité ou les conditions d'accès. Réponds directement à la condition demandée, sans vendre un autre service.";
    case "full_service":
      return "La demande porte explicitement sur une prise en charge complète. Tu peux alors parler du dossier complet et du parcours global.";
    case "mixed_multi":
      return "La question mélange plusieurs sujets sans priorité claire. Réponds au premier sujet cité en une phrase, puis pose une seule question de clarification sur le reste.";
    default:
      return "La demande semble générale. Réponds d'abord à la question exacte posée, puis seulement si c'est utile propose la prochaine étape la plus pertinente.";
  }
}
