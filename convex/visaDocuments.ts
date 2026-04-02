export type DocCategory =
  | "upload"    // Client scanne et uploade sur Joventy
  | "joventy"   // Joventy remplit / prépare / soumet
  | "direct"    // Client obtient / règle directement (frais, assurance...)
  | "embassy";  // À présenter physiquement à l'ambassade / centre VFS

export interface VisaDoc {
  key?: string;       // Clé stable pour le stockage (obligatoire pour category "upload")
  label: string;
  category: DocCategory;
  required: boolean;
  notes?: string;
}

export interface VisaDocGroup {
  category: DocCategory;
  title: string;
  color: string;
  icon: string;
  docs: VisaDoc[];
}

export type VisaDocMap = Record<string, VisaDoc[]>; // key = visa type label

function group(docs: VisaDoc[]): VisaDocGroup[] {
  const cats: { category: DocCategory; title: string; color: string; icon: string }[] = [
    { category: "upload",  title: "Documents à uploader sur Joventy",       color: "blue",   icon: "📤" },
    { category: "joventy", title: "Pris en charge par Joventy",             color: "green",  icon: "✅" },
    { category: "direct",  title: "À régler / obtenir directement par vous", color: "orange", icon: "💳" },
    { category: "embassy", title: "À présenter sur place",                  color: "purple", icon: "🏛️" },
  ];
  return cats
    .map(c => ({ ...c, docs: docs.filter(d => d.category === c.category) }))
    .filter(g => g.docs.length > 0);
}

// ─────────────────────────────────────────────
// USA
// ─────────────────────────────────────────────
const USA_B1B2: VisaDoc[] = [
  { key: "passport_scan",      category: "upload",  required: true,  label: "Scan passeport HD (validité 6 mois minimum après la date d'entrée prévue)" },
  { key: "photo_id",           category: "upload",  required: true,  label: "Photo d'identité 5×5 cm, fond blanc, récente (< 6 mois)" },
  { key: "proof_of_funds",     category: "upload",  required: true,  label: "Relevés bancaires des 3 à 6 derniers mois (solde minimum conseillé : 5 000 $)" },
  { key: "employment_letter",  category: "upload",  required: true,  label: "Attestation de travail sur papier en-tête (avec salaire, poste, ancienneté) ou RCCM pour les indépendants" },
  { key: "invitation_letter",  category: "upload",  required: false, label: "Lettre d'invitation d'un proche résidant aux USA (si applicable)", notes: "Nom, adresse, statut légal du contact aux USA" },
  { key: "ties_rdc",           category: "upload",  required: false, label: "Preuves d'attaches en RDC : titre de propriété, acte de mariage, acte de naissance d'enfants", notes: "Démontre que vous avez des raisons de revenir en RDC" },
  { key: "hotel_reservation",  category: "upload",  required: false, label: "Réservation d'hôtel ou itinéraire de voyage aux USA" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire DS-160 (demande de visa non-immigrant USA)" },
  { category: "joventy", required: true,  label: "Vérification complète de la conformité du dossier avant soumission" },
  { category: "joventy", required: true,  label: "Réservation du créneau de rendez-vous à l'ambassade des États-Unis (Kinshasa)" },
  { category: "direct",  required: true,  label: "Frais MRV : 265 $ — payés via la banque partenaire désignée par l'ambassade", notes: "Le reçu MRV est obligatoire pour le rendez-vous. Joventy vous indique la procédure." },
  { category: "direct",  required: false, label: "Assurance voyage (recommandée mais non exigée pour le B1/B2)" },
  { category: "embassy", required: true,  label: "Passeport original (+ anciens passeports si vous en avez)" },
  { category: "embassy", required: true,  label: "Imprimé de la confirmation de rendez-vous" },
  { category: "embassy", required: true,  label: "Originaux des documents financiers et professionnels uploadés" },
  { category: "embassy", required: false, label: "Lettre explicative sur l'objet du voyage (recommandée)" },
];

const USA_F1: VisaDoc[] = [
  { key: "passport_scan",       category: "upload",  required: true,  label: "Scan passeport HD (validité 6 mois minimum)" },
  { key: "photo_id",            category: "upload",  required: true,  label: "Photo d'identité 5×5 cm, fond blanc, récente" },
  { key: "i20_form",            category: "upload",  required: true,  label: "Formulaire I-20 délivré par l'université américaine", notes: "Le I-20 contient votre numéro SEVIS, indispensable pour les frais SEVIS" },
  { key: "admission_letter",    category: "upload",  required: true,  label: "Lettre d'admission officielle de l'établissement américain" },
  { key: "proof_of_funds",      category: "upload",  required: true,  label: "Relevés bancaires couvrant au moins 1 an de frais de scolarité + vie (ou garant financier)" },
  { key: "diplomas_transcripts",category: "upload",  required: true,  label: "Diplômes et relevés de notes des 2-3 dernières années d'études" },
  { key: "language_tests",      category: "upload",  required: false, label: "Résultats TOEFL / IELTS / DELF (si exigés par l'université)" },
  { key: "motivation_letter",   category: "upload",  required: false, label: "Lettre de motivation (Statement of Purpose) expliquant votre projet d'études" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire DS-160 (demande de visa étudiant F1)" },
  { category: "joventy", required: true,  label: "Vérification complète du dossier avant soumission" },
  { category: "joventy", required: true,  label: "Réservation du créneau de rendez-vous à l'ambassade des États-Unis" },
  { category: "direct",  required: true,  label: "Frais SEVIS (I-901) : 350 $ — réglés sur fmjfee.com avec votre numéro SEVIS (du I-20)", notes: "À payer avant le rendez-vous consulaire" },
  { category: "direct",  required: true,  label: "Frais MRV : 265 $ — via banque partenaire de l'ambassade" },
  { category: "embassy", required: true,  label: "Passeport original" },
  { category: "embassy", required: true,  label: "Original du I-20 signé par vous et l'université" },
  { category: "embassy", required: true,  label: "Reçu de paiement SEVIS (I-901)" },
  { category: "embassy", required: true,  label: "Originaux des diplômes et relevés financiers" },
];

const USA_K1: VisaDoc[] = [
  { key: "passport_scan",       category: "upload",  required: true,  label: "Scan passeport HD (validité 6 mois minimum)" },
  { key: "photo_id",            category: "upload",  required: true,  label: "Photo d'identité 5×5 cm, fond blanc, récente" },
  { key: "i129f_approval",      category: "upload",  required: true,  label: "Avis d'approbation I-129F de l'USCIS (envoyé par votre fiancé(e) américain(e))", notes: "Ce document prouve que votre pétition est approuvée par le gouvernement américain" },
  { key: "birth_certificate",   category: "upload",  required: true,  label: "Acte de naissance (traduit en anglais si nécessaire)" },
  { key: "criminal_record",     category: "upload",  required: true,  label: "Extrait de casier judiciaire / Certificat de bonne vie et mœurs (PNC Kinshasa, validité 6 mois)" },
  { key: "relationship_proof",  category: "upload",  required: true,  label: "Preuves de la relation romantique : photos ensemble, historique de communications (WhatsApp, emails, appels)" },
  { key: "meeting_proof",       category: "upload",  required: true,  label: "Preuve de rencontre physique dans les 2 années précédant la demande (billets d'avion, tampons passeport, photos datées)" },
  { key: "petitioner_financial",category: "upload",  required: true,  label: "Documents financiers du pétitionnaire US : formulaire I-864 (Affidavit of Support), W-2 ou tax returns, relevés bancaires" },
  { key: "divorce_death_cert",  category: "upload",  required: false, label: "Acte de divorce ou acte de décès (si l'un ou l'autre a déjà été marié(e))" },
  { key: "marriage_intent",     category: "upload",  required: false, label: "Preuve d'intention de se marier dans les 90 jours (invitation de mariage, etc.)" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire DS-160 (demande de visa K1)" },
  { category: "joventy", required: true,  label: "Vérification complète et coordination du dossier K1 (très complexe)" },
  { category: "joventy", required: true,  label: "Réservation du créneau de rendez-vous à l'ambassade des États-Unis à Kinshasa" },
  { category: "direct",  required: true,  label: "Frais MRV visa K1 : 265 $ — via banque partenaire de l'ambassade" },
  { category: "direct",  required: true,  label: "Examen médical chez un médecin Panel Physician agréé par l'ambassade US à Kinshasa (~200-400 $)", notes: "Obligatoire AVANT le rendez-vous consulaire. Le médecin agréé délivre un certificat médical officiel (scellé) incluant bilan sanguin, radio pulmonaire, et vérification des vaccinations. Joventy vous communique la liste des médecins agréés à Kinshasa." },
  { category: "direct",  required: true,  label: "Vaccins obligatoires (ex. fièvre jaune, polio) mis à jour si non à jour — prescrits par le Panel Physician" },
  { category: "embassy", required: true,  label: "Passeport original" },
  { category: "embassy", required: true,  label: "Certificat médical original scellé (Panel Physician) — ne pas ouvrir l'enveloppe" },
  { category: "embassy", required: true,  label: "Originaux de tous les documents uploadés" },
  { category: "embassy", required: false, label: "Lettre manuscrite expliquant votre relation et votre projet de mariage" },
];

const USA_H1B: VisaDoc[] = [
  { key: "passport_scan",       category: "upload",  required: true,  label: "Scan passeport HD" },
  { key: "photo_id",            category: "upload",  required: true,  label: "Photo 5×5 fond blanc" },
  { key: "i797_approval",       category: "upload",  required: true,  label: "Formulaire I-797 (Notice of Action) d'approbation H1-B délivré par l'USCIS", notes: "Fourni par votre employeur américain" },
  { key: "employer_letter",     category: "upload",  required: true,  label: "Lettre de l'employeur américain détaillant le poste, salaire, durée du contrat" },
  { key: "diplomas_transcripts",category: "upload",  required: true,  label: "Diplômes universitaires et relevés de notes (le H1-B exige une licence ou équivalent)" },
  { key: "cv",                  category: "upload",  required: true,  label: "CV complet avec expériences professionnelles" },
  { key: "proof_of_funds",      category: "upload",  required: false, label: "Relevés bancaires personnels" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire DS-160" },
  { category: "joventy", required: true,  label: "Vérification et coordination du dossier" },
  { category: "joventy", required: true,  label: "Réservation du créneau de rendez-vous à l'ambassade" },
  { category: "direct",  required: true,  label: "Frais MRV : 190 $ (visa de travail)" },
  { category: "embassy", required: true,  label: "Passeport original, I-797 original, originaux des diplômes" },
];

// ─────────────────────────────────────────────
// TURKEY
// ─────────────────────────────────────────────
const TURKEY_VFS: VisaDoc[] = [
  { key: "passport_scan",     category: "upload",  required: true,  label: "Scan passeport HD (validité minimale 7 mois après la date d'entrée prévue)" },
  { key: "photo_id",          category: "upload",  required: true,  label: "Photo d'identité conforme aux normes turques (fond blanc, récente)" },
  { key: "proof_of_funds",    category: "upload",  required: true,  label: "Relevés bancaires des 3 derniers mois (solde minimum : 5 000 $)", notes: "Compte personnel ou professionnel — originaux ou relevés officiel de la banque" },
  { key: "employment_letter", category: "upload",  required: true,  label: "Attestation de travail sur en-tête (avec salaire et poste) ou RCCM / Identification nationale pour les entrepreneurs" },
  { key: "flight_reservation",category: "upload",  required: true,  label: "Réservation de billet d'avion aller-retour (confirmation de réservation, pas forcément payée)" },
  { key: "hotel_reservation", category: "upload",  required: true,  label: "Réservation hôtel confirmée pour toute la durée du séjour" },
  { key: "criminal_record",   category: "upload",  required: false, label: "Certificat de casier judiciaire (Certificat de bonne vie et mœurs — recommandé)", notes: "Validité 6 mois, délivré par la PNC ou la commune" },
  { category: "joventy", required: true,  label: "Vérification complète de la conformité du dossier selon les exigences VFS Turquie" },
  { category: "joventy", required: true,  label: "Réservation du créneau de dépôt au centre VFS Global à Kinshasa" },
  { category: "joventy", required: true,  label: "Accompagnement et suivi du statut de la demande" },
  { category: "direct",  required: true,  label: "Frais consulaires : 100 $ (entrée unique) ou 300 $ (multi-entrées) — payés au centre VFS" },
  { category: "direct",  required: true,  label: "Frais de service VFS : 95 $ (tarif Normal) ou 180 $ (tarif VIP) — payés au centre VFS" },
  { category: "direct",  required: true,  label: "Assurance maladie internationale : 65 $ (3 mois) / 110 $ (12 mois) — souscrite avant le dépôt", notes: "Couverture minimale exigée : 30 000 €. Doit couvrir toute la durée du séjour en Turquie." },
  { category: "embassy", required: true,  label: "Passeport original (+ anciens passeports si disponibles)" },
  { category: "embassy", required: true,  label: "Formulaire de demande VFS dûment rempli et signé" },
  { category: "embassy", required: true,  label: "Originaux de tous les documents uploadés (relevés bancaires, attestation, réservations)" },
  { category: "embassy", required: true,  label: "Photos d'identité supplémentaires (2 exemplaires, format passeport)" },
];

const TURKEY_EVISA: VisaDoc[] = [
  { key: "passport_scan",     category: "upload",  required: true,  label: "Scan passeport HD (validité 6+ mois)", notes: "Vous devez déjà posséder un visa USA ou Schengen valide pour être éligible à l'e-Visa turc" },
  { key: "existing_visa_scan",category: "upload",  required: true,  label: "Scan de votre visa USA ou Schengen valide (condition sine qua non)" },
  { category: "joventy", required: true,  label: "Soumission du dossier e-Visa sur le portail officiel turque (evisa.gov.tr)" },
  { category: "joventy", required: true,  label: "Suivi et transmission de l'e-Visa dès approbation (généralement 24-72h)" },
  { category: "direct",  required: true,  label: "Frais e-Visa Turquie : ~60 $ — payés sur le portail officiel evisa.gov.tr", notes: "Tarif susceptible de changer selon la nationalité et la période" },
];

// ─────────────────────────────────────────────
// DUBAI (EAU)
// ─────────────────────────────────────────────
const DUBAI_TOURIST: VisaDoc[] = [
  { key: "passport_scan",    category: "upload",  required: true,  label: "Scan passeport HD (page principale + pages tampons), validité 6 mois minimum" },
  { key: "photo_id",         category: "upload",  required: true,  label: "Photo d'identité fond blanc JPEG, taille inférieure à 100 ko (format exigé par le portail ICA UAE)" },
  { key: "flight_reservation",category: "upload", required: true,  label: "Réservation de billet d'avion aller-retour (confirmation de réservation)" },
  { key: "hotel_reservation",category: "upload",  required: false, label: "Réservation hôtel (recommandée, parfois exigée selon profil)", notes: "Renforce votre dossier si votre profil est jugé à risque" },
  { key: "proof_of_funds",   category: "upload",  required: false, label: "Relevés bancaires des 3 derniers mois (si demandés lors de l'examen du dossier)" },
  { category: "joventy", required: true,  label: "Soumission du dossier e-Visa sur le portail officiel ICA UAE" },
  { category: "joventy", required: true,  label: "Suivi du statut de la demande (résultat attendu en 48-72h ouvrables)" },
  { category: "joventy", required: true,  label: "Transmission du e-Visa PDF officiel dès approbation" },
  { category: "direct",  required: true,  label: "Frais e-Visa EAU : environ 90-100 $ selon la durée (30j / 60j) — à régler via le portail officiel", notes: "Joventy soumet le dossier sur le portail avec vos informations. Les frais sont réglés au moment de la soumission." },
  { category: "direct",  required: false, label: "Assurance voyage (recommandée, exigée à l'entrée dans certains cas)" },
];

const DUBAI_BUSINESS: VisaDoc[] = [
  ...DUBAI_TOURIST.filter(d => d.label !== "Réservation hôtel (recommandée, parfois exigée selon profil)"),
  { key: "business_invitation",   category: "upload",  required: true,  label: "Lettre d'invitation d'une société basée aux EAU ou attestation de participation à un événement professionnel" },
  { key: "business_registration", category: "upload",  required: true,  label: "RCCM ou documents d'enregistrement de votre entreprise en RDC" },
];

// ─────────────────────────────────────────────
// INDE
// ─────────────────────────────────────────────
const INDIA_TOURIST: VisaDoc[] = [
  { key: "passport_scan",    category: "upload",  required: true,  label: "Scan passeport HD (validité 6 mois minimum, au moins 2 pages vierges)" },
  { key: "photo_id",         category: "upload",  required: true,  label: "Photo d'identité fond blanc récente (format numérique, JPG, 10-300 ko)" },
  { key: "flight_reservation",category: "upload", required: true,  label: "Réservation de billet d'avion aller-retour" },
  { key: "hotel_reservation",category: "upload",  required: true,  label: "Réservation hôtel pour au moins la première nuit" },
  { key: "proof_of_funds",   category: "upload",  required: false, label: "Relevés bancaires (recommandés pour appuyer le dossier)" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire officiel e-Visa Inde (indianvisaonline.gov.in)" },
  { category: "joventy", required: true,  label: "Soumission et suivi du dossier" },
  { category: "joventy", required: true,  label: "Transmission du e-Visa PDF approuvé (imprimer avant l'embarquement)" },
  { category: "direct",  required: true,  label: "Frais e-Visa gouvernement indien : ~25 $ (30j) / ~40 $ (1 an) / ~80 $ (5 ans) — payés sur le portail officiel" },
];

const INDIA_MEDICAL: VisaDoc[] = [
  { key: "passport_scan",       category: "upload",  required: true,  label: "Scan passeport HD (validité 6 mois minimum)" },
  { key: "photo_id",            category: "upload",  required: true,  label: "Photo d'identité fond blanc (format numérique)" },
  { key: "medical_referral",    category: "upload",  required: true,  label: "Lettre de recommandation médicale du médecin traitant en RDC (en anglais ou avec traduction)" },
  { key: "hospital_invitation", category: "upload",  required: true,  label: "Lettre d'admission / invitation de l'hôpital ou de la clinique indienne agréée", notes: "Doit mentionner : nom de l'établissement, type de traitement, durée estimée, coût prévisionnel" },
  { key: "medical_records",     category: "upload",  required: true,  label: "Documents médicaux récents : comptes-rendus, analyses, imageries médicales" },
  { key: "proof_of_funds",      category: "upload",  required: false, label: "Preuves de moyens financiers pour couvrir les frais médicaux" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire e-Medical Visa Inde" },
  { category: "joventy", required: true,  label: "Vérification accréditation de l'hôpital indien (service inclus)" },
  { category: "joventy", required: true,  label: "Soumission et suivi — transmission du e-Visa dès approbation" },
  { category: "direct",  required: true,  label: "Frais e-Visa médical : ~50 $ — via portail officiel indianvisaonline.gov.in" },
  { category: "direct",  required: true,  label: "Billet d'avion aller-retour pour l'Inde" },
];

const INDIA_STUDENT: VisaDoc[] = [
  { key: "passport_scan",       category: "upload",  required: true,  label: "Scan passeport HD" },
  { key: "photo_id",            category: "upload",  required: true,  label: "Photo d'identité fond blanc" },
  { key: "admission_letter",    category: "upload",  required: true,  label: "Lettre d'admission de l'université ou de l'institution indienne" },
  { key: "proof_of_funds",      category: "upload",  required: true,  label: "Relevés bancaires couvrant les frais de scolarité + vie (1 an minimum)" },
  { key: "diplomas_transcripts",category: "upload",  required: true,  label: "Diplômes et relevés de notes précédents" },
  { category: "joventy", required: true,  label: "Remplissage du formulaire de visa étudiant Inde" },
  { category: "joventy", required: true,  label: "Coordination et vérification du dossier" },
  { category: "joventy", required: true,  label: "Note : pour les études longues durée (Regular Visa), un entretien physique à l'Ambassade de l'Inde à Kinshasa est possible" },
  { category: "direct",  required: true,  label: "Frais de visa étudiant Inde : variable selon durée (~100-200 $)" },
];

// ─────────────────────────────────────────────
// Export principal
// ─────────────────────────────────────────────
export const VISA_DOCUMENTS: Record<string, Record<string, VisaDoc[]>> = {
  usa: {
    "B1/B2 (Tourisme/Affaires)": USA_B1B2,
    "F1 (Étudiant)":             USA_F1,
    "K1 (Fiancé(e))":            USA_K1,
    "H1B (Travail)":             USA_H1B,
    "J1 (Échange)":              USA_F1, // similar requirements
  },
  turkey: {
    "Visa Sticker (VFS Kinshasa)":      TURKEY_VFS,
    "E-Visa (si visa USA/Schengen)":    TURKEY_EVISA,
  },
  dubai: {
    "Touriste 30j":  DUBAI_TOURIST,
    "Touriste 60j":  DUBAI_TOURIST,
    "Affaires":      DUBAI_BUSINESS,
    "Résidence":     DUBAI_TOURIST,
  },
  india: {
    "e-Visa Touriste":        INDIA_TOURIST,
    "Médical (e-Medical)":    INDIA_MEDICAL,
    "Études (Regular Visa)":  INDIA_STUDENT,
  },
};

export function getVisaDocs(destination: string, visaType: string): VisaDoc[] {
  return VISA_DOCUMENTS[destination]?.[visaType] ?? [];
}

export function getVisaDocGroups(destination: string, visaType: string): VisaDocGroup[] {
  return group(getVisaDocs(destination, visaType));
}

/** Retourne uniquement les documents de catégorie "upload" avec une clé stable. */
export function getUploadDocs(destination: string, visaType: string): Array<{ key: string; label: string; required: boolean; notes?: string }> {
  return getVisaDocs(destination, visaType)
    .filter(d => d.category === "upload" && d.key)
    .map(d => ({ key: d.key!, label: d.label, required: d.required, notes: d.notes }));
}
