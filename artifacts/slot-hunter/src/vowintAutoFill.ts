/**
 * vowintAutoFill.ts — Remplissage automatique d'un dossier VOWINT
 *
 * Fait le pont entre les données Joventy (profil demandeur) et les champs VA VOWINT.
 * Usage :
 *   const api = new VowintApi(email, password);
 *   await api.login();
 *   const result = await fillVowintDossier(api, vacoreId, profile);
 *
 * Toutes les valeurs de référence (IDs listes) proviennent de :
 *   debug_dumps/reference-lists/  (capturées 2026-06-09 — VAC Belgium Brussels)
 */

import { VowintApi, VowintVA, VowintReference } from './vowintApi.js';

// ─── Constantes de référence ──────────────────────────────────────────────────
// Capturées depuis debug_dumps/reference-lists/ (contexte VAC=1 Belgium Brussels)

export const REF = {
  // Pays
  country: {
    DRC: 58,         // Congo (Rép. Dém.)
    Belgium: 32,
    France: 86,
    Germany: 79,
    Netherlands: 160,
    UK: 235,
    USA: 242,
    Italy: 112,
    Spain: 210,
    Switzerland: 215,
  },

  // Nationalités
  nationality: {
    DRC: 116,
    Belgian: 90,
    French: 85,
    German: 78,
    British: 233,
  },

  // Sexe (SexTypes)
  gender: { Male: 1, Female: 2, Unidentified: 3 } as const,

  // Situation civile (CivilStateTypes)
  civilState: {
    Single: 1, Married: 2, Separated: 3,
    Divorced: 4, Widowed: 5, Cohabitant: 6, RegisteredPartnership: 7,
  } as const,

  // Type document voyage (TravelDocumentTypes)
  docType: {
    OrdinaryPassport: 1, CollectivePassport: 2, ProtectionPassport: 3,
    DiplomaticPassport: 4, ServicePassport: 5, OfficialLicence: 6,
    SpecialPassport: 7, ForeignersPassport: 8,
  } as const,

  // Type de visa (VisaTypes)
  visaType: {
    A_AirportTransit: 1,
    C_ShortStay: 2,
    D_LongStay: 3,
  } as const,

  // Catégorie de motif de voyage
  purposeCategory: {
    Leisure: 1, Academic: 2, Family: 3,
    Humanitarian: 4, Business: 5, Return: 6, Transit: 7,
  } as const,

  // Motif de voyage (PurposeOfTravelTypes) — sélection courante DRC→Belgique
  purpose: {
    BusinessTravel: 1, CulturalEvent: 2, FamilyVisit: 3,
    FriendshipVisit: 4, OfficialTravel: 5, BusinessTrip: 6,
    SportingEvent: 7, InternshipTraining: 8, TouristTravel: 9,
    MedicalReasons: 10, AirportTransit: 11,
    LegalCohabitationBelgium: 13, HigherEducationPublic: 14,
    PrivateInstitution: 15,
  } as const,

  // Nombre d'entrées (NumberOfEntryTypes)
  entries: { One: 1, Two: 2, Multiple: 3 } as const,

  // Moyen de transport (MainTransportationTypes)
  transport: { Car: 1, Airplane: 2, Train: 3, Boat: 4, Bus: 7 } as const,

  // Profession (OccupationTypes — 28 types)
  occupation: {
    Farmer: 1, LegalProfessions: 2, Artist: 3, TraderSelfEmployed: 4,
    Clergy: 5, Driver: 6, Teacher: 7, EmployeePrivate: 8, CivilServant: 9,
    Politician: 10, Military: 11, Police: 12, Student: 13, Retired: 14,
    WithoutProfession: 15, Doctor: 17, Engineer: 18, Journalist: 19,
    Nurse: 20, Pharmacist: 21, Researcher: 22, SocialWorker: 23,
    Manager: 24, IT: 25, FinancialAdvisor: 26, Entrepreneur: 27, Other: 28,
  } as const,

  // Gratuité (GratuityTypes — 16 types)
  gratuity: {
    None: 1,          // Standard (payant — 80 EUR, réglé le jour du RDV)
    Diplomatic: 2,
    Indigence: 3,
    GrantHolder: 5,
    FamilyEU: 7,
    ChildUnder6: 9,
    ChildUnder12: 16,
  } as const,

  // Type de voyage en groupe (TravellerGroupQuestion)
  groupTravel: { None: 0, Alone: 1, Group: 2, Family: 3 } as const,

  // VAC / Langue
  vac: { BelgiumBrussels: 1 } as const,
  language: { EN: 'en-US', FR: 'fr-FR', NL: 'nl-NL', DE: 'de-DE' } as const,
  languageDossierId: { EN: 1, FR: 2, NL: 3, DE: 4 } as const,

  // Type d'acteur (ActorTypes) — pour References
  actorType: {
    Employer: 1, School: 2, Host: 3, Sponsor: 4,
    EUFamilyMember: 5, InvitingOrganisation: 6, Other: 7,
  } as const,
} as const;

// ─── Type profil demandeur ────────────────────────────────────────────────────

/**
 * Profil demandeur structuré — à remplir depuis les données Joventy / Convex.
 * Correspond 1-pour-1 aux questions du formulaire VOWINT visuel.
 */
export interface ApplicantProfile {
  // ── Infos de base ─────────────────────────────────────────────────────────
  /** Langue pour la notification de décision (défaut: FR) */
  notificationLanguage?: 'EN' | 'FR' | 'NL' | 'DE';
  /** Membre de la famille d'un citoyen UE/EEA/CH/UK (défaut: false) */
  isEUFamilyMember?: boolean;

  // ── Données personnelles ──────────────────────────────────────────────────
  /** 1. Nom de famille (en majuscules sur le passeport) */
  lastName: string;
  /** 2. Nom de famille à la naissance si différent */
  birthLastName?: string;
  /** 3. Prénom(s) */
  firstName: string;
  /** 4. Date de naissance — "YYYY-MM-DD" */
  birthDate: string;
  /** Mineur prolongé (extendedMinor) */
  extendedMinor?: boolean;
  /** 5. Lieu de naissance (ville) */
  birthCity?: string;
  /** 6. Pays de naissance — countryId (ex: REF.country.DRC = 58) */
  birthCountryId?: number;
  /** 7. Nationalité actuelle — nationalityId (ex: REF.nationality.DRC = 116) */
  nationalityId: number;
  /** 7. Nationalité à la naissance si différente — nationalityId */
  birthNationalityId?: number;
  /** Autres nationalités — tableau de nationalityIds */
  otherNationalities?: number[];
  /** 8. Sexe */
  gender: 1 | 2 | 3;   // 1=Male, 2=Female, 3=Unidentified
  /** 9. Situation civile */
  civilStateId?: number;  // REF.civilState.*
  /** 11. Numéro d'identité nationale (optionnel) */
  nationalId?: string;

  // ── Document de voyage ────────────────────────────────────────────────────
  /** 12. Type de document */
  docTypeId?: number;   // REF.docType.* (défaut: OrdinaryPassport=1)
  /** 13. Numéro du document */
  docNumber?: string;
  /** 14. Date de délivrance — "YYYY-MM-DD" */
  docDateOfIssue?: string;
  /** 15. Date d'expiration — "YYYY-MM-DD" */
  docValidUntil?: string;
  /** 16. Délivré par (lieu/autorité) */
  docIssuedBy?: string;
  /** 16. Pays émetteur — countryId */
  docIssuingCountryId?: number;

  // ── Adresse personnelle (19) ──────────────────────────────────────────────
  address?: {
    street?: string;
    houseNumber?: string;
    city?: string;
    postalCode?: string;
    countryId?: number;
  };
  phone?: string;
  mobile?: string;
  email?: string;

  // ── Profession actuelle (21) ──────────────────────────────────────────────
  /** OccupationId — REF.occupation.* */
  occupationId?: number;
  /** Détails employeur/école (optionnel) */
  employer?: {
    name?: string;
    street?: string;
    houseNumber?: string;
    city?: string;
    postalCode?: string;
    countryId?: number;
    phone?: string;
    email?: string;
  };

  // ── Voyage (type, motif, destination) ────────────────────────────────────
  /** Type de visa demandé — REF.visaType.* (défaut: C=ShortStay=2) */
  visaTypeId?: number;
  /** Catégorie du motif — REF.purposeCategory.* */
  purposeCategoryId?: number;
  /** Motif principal — REF.purpose.* */
  purposeId?: number;
  /** 24. Informations supplémentaires sur le motif */
  purposeInfo?: string;
  /** 25. État membre de destination — countryId (défaut: Belgium=32) */
  destinationMemberStateId?: number;
  /** 26. État membre de première entrée — countryId (défaut: Belgium=32) */
  firstEntryMemberStateId?: number;
  /** 27. Nombre d'entrées — REF.entries.* (défaut: Multiple=3) */
  entriesId?: number;
  /** Durée de séjour prévue (jours) */
  durationDays?: number;
  /** 27. Date d'arrivée prévue — "YYYY-MM-DD" */
  arrivalDate?: string;
  /** 27. Date de départ prévue — "YYYY-MM-DD" */
  departureDate?: string;
  /** Moyen de transport — REF.transport.* (défaut: Airplane=2) */
  transportId?: number;

  // ── Visa Schengen précédent ───────────────────────────────────────────────
  previousSchengenVisa?: {
    visaNumber: string;
    dateOfIssue: string;   // "YYYY-MM-DD"
    validUntil: string;    // "YYYY-MM-DD"
    countryId: number;
  };

  // ── Empreintes biométriques ───────────────────────────────────────────────
  hadPreviousFingerprints?: boolean;
  previousFingerprintDate?: string;   // "YYYY-MM-DD"
  previousFingerprintVisa?: string;
  /** Exemption empreintes — FingerprintExemptionTypes */
  fingerprintExemptionId?: number;
  fingerprintExemptionReason?: string;

  // ── Références ────────────────────────────────────────────────────────────
  /** Hébergeur / personne invitante */
  host?: {
    actorType?: number;   // REF.actorType.Host=3 | EUFamilyMember=5 | Employer=1
    lastName?: string;
    firstName?: string;
    birthDate?: string;   // "YYYY-MM-DD"
    nationalityId?: number;
    address?: {
      street?: string; houseNumber?: string; city?: string;
      postalCode?: string; countryId?: number;
    };
    phone?: string;
    email?: string;
    // Si organisation :
    orgName?: string;
    orgVatNumber?: string;
    orgPhone?: string;
    orgEmail?: string;
    orgContactPerson?: string;
    orgAddress?: {
      street?: string; houseNumber?: string; city?: string;
      postalCode?: string; countryId?: number;
    };
  };

  // ── Financement séjour ────────────────────────────────────────────────────
  /** L'occupant finance lui-même (Personal_Data_Sponsor=true, aucune référence sponsor) */
  selfFinanced?: boolean;

  // ── Groupe ────────────────────────────────────────────────────────────────
  /** Voyage en groupe — REF.groupTravel.* */
  groupTravel?: 0 | 1 | 2 | 3;

  // ── Frais ─────────────────────────────────────────────────────────────────
  /** Gratuité — REF.gratuity.* (défaut: None=1, standard 80 EUR payé le jour du RDV) */
  gratuityId?: number;
}

// ─── Mapping profil → VowintVA ────────────────────────────────────────────────

/**
 * Convertit un ApplicantProfile en objet VowintVA prêt à envoyer.
 * L'objet VA de base doit être chargé depuis `api.loadApplication()` — cette
 * fonction ne fait que surcharger les champs applicatifs.
 *
 * @param baseVA  VA retourné par `loadApplication()` (contient AppId, VacId, etc.)
 * @param profile Profil demandeur à appliquer
 */
export function mapProfileToVA(baseVA: VowintVA, profile: ApplicantProfile): VowintVA {
  const va: VowintVA = { ...baseVA };

  // ── Langue ──────────────────────────────────────────────────────────────
  const langKey = profile.notificationLanguage ?? 'FR';
  va.Application_LanguageForDossierId = REF.languageDossierId[langKey];
  va.Language = REF.language[langKey];

  // ── Membre famille UE ──────────────────────────────────────────────────
  va.Application_FreeMovement = profile.isEUFamilyMember ?? false;

  // ── Données personnelles ───────────────────────────────────────────────
  va.Personal_Data_LastName = profile.lastName.toUpperCase();
  va.Personal_Data_FirstName = profile.firstName;
  va.Personal_Data_BirthLastName = profile.birthLastName ?? null;
  va.Personal_Data_BirthDate = profile.birthDate;
  va.Personal_Data_ExtendedMinor = profile.extendedMinor ?? null;
  va.Personal_Data_BirthCity = profile.birthCity ?? null;
  va.Personal_Data_BirthCountryId = profile.birthCountryId ?? null;
  va.Personal_Data_NationalityId = profile.nationalityId;
  va.Personal_Data_BirthNationalityId = profile.birthNationalityId ?? null;
  va.Personal_Data_GenderId = profile.gender;
  va.Personal_Data_CivilStateId = profile.civilStateId ?? null;
  va.Personal_Data_PersonNumber = profile.nationalId ?? null;
  va.Personal_Data_Other_Nationalities = (profile.otherNationalities ?? []).map(id => ({ NationalityId: id }));

  // ── Adresse ────────────────────────────────────────────────────────────
  va.Personal_Data_Address = {
    Street: profile.address?.street ?? null,
    HouseNumber: profile.address?.houseNumber ?? null,
    City: profile.address?.city ?? null,
    PostalCode: profile.address?.postalCode ?? null,
    CountryId: profile.address?.countryId ?? null,
  };
  va.Personal_Data_Telephonenumber = profile.phone ?? null;
  va.Personal_Data_Mobilenumber = profile.mobile ?? null;
  va.Personal_Data_Email = profile.email ?? null;
  va.Confirm_Email = profile.email ?? null;
  va.PhoneValid = true;

  // ── Profession ─────────────────────────────────────────────────────────
  va.Personal_Data_OccupationId = profile.occupationId ?? null;
  va.Personal_Data_Sponsor = profile.selfFinanced ? true : null;
  if (profile.employer) {
    va.Personal_Occupation = {
      Name: profile.employer.name ?? null,
      Address: {
        Street: profile.employer.street ?? null,
        HouseNumber: profile.employer.houseNumber ?? null,
        City: profile.employer.city ?? null,
        PostalCode: profile.employer.postalCode ?? null,
        CountryId: profile.employer.countryId ?? null,
      },
      Email: profile.employer.email ?? null,
      Telephonenumber: profile.employer.phone ?? null,
      Sponsor: null,
      ActorSubTypeId: 0,
      Occupation_StatusId: 0,
    };
  }

  // ── Document de voyage ─────────────────────────────────────────────────
  va.TravelDocument_DocumentTypeId = profile.docTypeId ?? REF.docType.OrdinaryPassport;
  va.TravelDocument_DocumentNumber = profile.docNumber ?? null;
  va.TravelDocument_DateOfIssue = profile.docDateOfIssue ?? null;
  va.TravelDocument_ValidUntil = profile.docValidUntil ?? null;
  va.TravelDocument_IssuingAuthorityPlace = profile.docIssuedBy ?? null;
  va.TravelDocument_IssuingAuthorityCountryId = profile.docIssuingCountryId ?? null;

  // ── Voyage ─────────────────────────────────────────────────────────────
  va.Application_VisaTypeRequestedId = profile.visaTypeId ?? REF.visaType.C_ShortStay;
  va.Application_PurposeOfTravelCategoryId = profile.purposeCategoryId ?? null;
  va.Application_PurposeOfTravelId = profile.purposeId ?? null;
  va.Application_PurposeOfTravelInfo = profile.purposeInfo ?? null;
  va.Application_MemberStateOfDestinationId = profile.destinationMemberStateId ?? REF.country.Belgium;
  va.Application_MemberStateOfFirstEntryId = profile.firstEntryMemberStateId ?? REF.country.Belgium;
  va.Application_NumberOfEntriesRequestedId = profile.entriesId ?? REF.entries.Multiple;
  va.Application_DurationOfIntendedStay = profile.durationDays ?? null;
  va.Application_IntendedDateOfArrival = profile.arrivalDate ?? null;
  va.Application_IntendedDateOfDeparture = profile.departureDate ?? null;
  va.Application_MainTransportationId = profile.transportId ?? REF.transport.Airplane;

  // ── Visa Schengen précédent ────────────────────────────────────────────
  if (profile.previousSchengenVisa) {
    const pv = profile.previousSchengenVisa;
    va.PreviousSchengenVisa_VisaNumber = pv.visaNumber;
    va.PreviousSchengenVisa_DateOfIssue = pv.dateOfIssue;
    va.PreviousSchengenVisa_ValidUntil = pv.validUntil;
    va.PreviousSchengenVisa_DeliveredByCountryId = pv.countryId;
  } else {
    va.PreviousSchengenVisa_VisaNumber = null;
    va.PreviousSchengenVisa_DateOfIssue = null;
    va.PreviousSchengenVisa_ValidUntil = null;
    va.PreviousSchengenVisa_DeliveredByCountryId = null;
  }

  // ── Empreintes ─────────────────────────────────────────────────────────
  va.PreviousFingerPrint = profile.hadPreviousFingerprints ?? null;
  va.PreviousFingerprint_CaptureDate = profile.previousFingerprintDate ?? null;
  va.PreviousFingerprint_VisaNumber = profile.previousFingerprintVisa ?? null;
  va.Application_FingerprintExemptionId = profile.fingerprintExemptionId ?? null;
  va.Application_FingerprintExemptionReason = profile.fingerprintExemptionReason ?? null;

  // ── Références (hébergement / invitation) ──────────────────────────────
  if (profile.host) {
    const h = profile.host;
    const existingRef = va.References?.[0];
    const ref: VowintReference = {
      Id: existingRef?.Id ?? crypto.randomUUID(),
      ActorType: h.actorType ?? REF.actorType.Host,
      ActorSubType: 0,
      Invitation: true,
      SponsorType: null, ReferenceType: null, Sponsor: null,
      SchoolID: null, Accompany: null, Signaled: null,
      Deleted: false, SameAddress: false, Guarantor: false,
      // Personne physique
      Person_LastName: h.lastName ?? null,
      Person_FirstName: h.firstName ?? null,
      Person_BirthDate: h.birthDate ?? null,
      Person_NationalityId: h.nationalityId ?? null,
      Person_Address: {
        Street: h.address?.street ?? null,
        HouseNumber: h.address?.houseNumber ?? null,
        City: h.address?.city ?? null,
        PostalCode: h.address?.postalCode ?? null,
        CountryId: h.address?.countryId ?? null,
      },
      Person_Telephonenumber: h.phone ?? null,
      Person_Email: h.email ?? null,
      // Organisation
      Organisation_Number: null,
      Organisation_Name: h.orgName ?? null,
      Organisation_Address: {
        Street: h.orgAddress?.street ?? null,
        HouseNumber: h.orgAddress?.houseNumber ?? null,
        City: h.orgAddress?.city ?? null,
        PostalCode: h.orgAddress?.postalCode ?? null,
        CountryId: h.orgAddress?.countryId ?? null,
      },
      Organisation_VATNumber: h.orgVatNumber ?? null,
      Organisation_TelephoneNumber: h.orgPhone ?? null,
      Organisation_EMailAddress: h.orgEmail ?? null,
      Organisation_ContactPerson: h.orgContactPerson ?? null,
    };
    va.References = [ref];
    va.ReferencePersonId = ref.Id;
  }

  // ── Groupe ─────────────────────────────────────────────────────────────
  va.IsTravellerGroupQuestion = profile.groupTravel ?? REF.groupTravel.Alone;

  // ── Frais (standard = payable le jour du RDV — NE PAS modifier Application_Fee) ──
  // Gratuité uniquement si l'applicant est exempté (enfant <6, <12, diplo...)
  va.Application_GratuityId = profile.gratuityId ?? REF.gratuity.None;

  return va;
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Remplit et sauvegarde un dossier VOWINT depuis un profil demandeur.
 *
 * Flux :
 *   1. loadApplication(vacoreId)  — charge VA + Lists
 *   2. mapProfileToVA()           — applique le profil
 *   3. saveApplication(va)        — POST /VisaApplication/Save
 *
 * @param api      VowintApi déjà loggé (api.login() appelé avant)
 * @param vacoreId VACoreId du dossier VOWINT (GUID)
 * @param profile  Profil demandeur structuré
 * @param submit   Si true, appelle aussi Submit après Save (défaut: false)
 */
export async function fillVowintDossier(
  api: VowintApi,
  vacoreId: string,
  profile: ApplicantProfile,
  submit = false,
): Promise<{ saved: boolean; submitted: boolean; errors?: string[] }> {
  const loaded = await api.loadApplication(vacoreId);
  const va = mapProfileToVA(loaded.VA, profile);

  const saveResult = await api.saveApplication(va);

  if (!saveResult.Success) {
    const errors = saveResult.ModelErrors?.map(e => `${e.Key}: ${e.Value.join(', ')}`) ?? ['unknown'];
    console.error(`[vowint-fill] Save échoué — ${errors.join(' | ')}`);
    return { saved: false, submitted: false, errors };
  }

  if (!submit) {
    return { saved: true, submitted: false };
  }

  const submitResult = await api.submitApplication(saveResult.VA ?? va);
  if (!submitResult.Success) {
    const errors = submitResult.ModelErrors?.map(e => `${e.Key}: ${e.Value.join(', ')}`) ?? ['unknown'];
    console.error(`[vowint-fill] Submit échoué — ${errors.join(' | ')}`);
    return { saved: true, submitted: false, errors };
  }

  return { saved: true, submitted: true };
}

// ─── Helpers d'utilité ────────────────────────────────────────────────────────

/**
 * Calcule la durée de séjour en jours entre deux dates "YYYY-MM-DD".
 */
export function computeDurationDays(arrivalDate: string, departureDate: string): number {
  const arrival = new Date(arrivalDate);
  const departure = new Date(departureDate);
  const ms = departure.getTime() - arrival.getTime();
  return Math.max(1, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/**
 * Détermine le type de visa approprié depuis une chaîne Joventy.
 * visaType Joventy: "Touriste 30j" | "Touriste 60j" | "Résidence" | "Affaires" | etc.
 */
export function mapJoventyVisaType(joventyType: string): number {
  const t = joventyType.toLowerCase();
  if (t.includes('transit') || t.includes('aéroport')) return REF.visaType.A_AirportTransit;
  if (t.includes('long') || t.includes('résidence') || t.includes('résid')) return REF.visaType.D_LongStay;
  return REF.visaType.C_ShortStay;
}

/**
 * Détermine le motif de voyage depuis une chaîne Joventy (purpose).
 */
export function mapJoventyPurpose(purpose: string): { categoryId: number; purposeId: number } {
  const p = purpose.toLowerCase();
  if (p.includes('tourist') || p.includes('touriste') || p.includes('loisir') || p.includes('vacances')) {
    return { categoryId: REF.purposeCategory.Leisure, purposeId: REF.purpose.TouristTravel };
  }
  if (p.includes('famille') || p.includes('family') || p.includes('parent') || p.includes('conjoint')) {
    return { categoryId: REF.purposeCategory.Family, purposeId: REF.purpose.FamilyVisit };
  }
  if (p.includes('affaires') || p.includes('business') || p.includes('professionnel')) {
    return { categoryId: REF.purposeCategory.Business, purposeId: REF.purpose.BusinessTrip };
  }
  if (p.includes('étude') || p.includes('étudiant') || p.includes('université') || p.includes('académique')) {
    return { categoryId: REF.purposeCategory.Academic, purposeId: REF.purpose.HigherEducationPublic };
  }
  if (p.includes('médical') || p.includes('soin') || p.includes('traitement')) {
    return { categoryId: REF.purposeCategory.Humanitarian, purposeId: REF.purpose.MedicalReasons };
  }
  if (p.includes('ami') || p.includes('friend') || p.includes('visite')) {
    return { categoryId: REF.purposeCategory.Leisure, purposeId: REF.purpose.FriendshipVisit };
  }
  if (p.includes('transit')) {
    return { categoryId: REF.purposeCategory.Transit, purposeId: REF.purpose.AirportTransit };
  }
  // Défaut : tourisme
  return { categoryId: REF.purposeCategory.Leisure, purposeId: REF.purpose.TouristTravel };
}
