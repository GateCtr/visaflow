/**
 * Classifications des visas américains — segmentation pour le blind booking.
 *
 * Le serveur USA retourne les slots par visaClass. Un slotId F1 n'est PAS valide pour un compte B1/B2.
 * → Le blind booking cross-visaClass est IMPOSSIBLE.
 * → Les meutes doivent être homogènes par visaClass.
 *
 * Deux grandes catégories :
 *   - NIV (Non-Immigrant Visa) : séjour temporaire
 *   - IV  (Immigrant Visa)     : résidence permanente
 */

// ═══════════════════════════════════════════════════════════════════════════════
// CATÉGORIE : NON-IMMIGRANT VISA (NIV)
// ═══════════════════════════════════════════════════════════════════════════════

export const NIV_VISA_TYPES = [
  // ─── Visiteurs ───
  { code: "B1", label: "B1 — Affaires temporaires", category: "Visiteur" },
  { code: "B1/B2", label: "B1/B2 — Tourisme / Affaires", category: "Visiteur" },
  { code: "B2", label: "B2 — Tourisme / Médical", category: "Visiteur" },

  // ─── Étudiants & Échanges ───
  { code: "F1", label: "F1 — Étudiant académique", category: "Étudiant" },
  { code: "F2", label: "F2 — Conjoint/Enfant d'étudiant F1", category: "Étudiant" },
  { code: "M1", label: "M1 — Étudiant professionnel/technique", category: "Étudiant" },
  { code: "M2", label: "M2 — Conjoint/Enfant d'étudiant M1", category: "Étudiant" },
  { code: "J1", label: "J1 — Visiteur d'échange", category: "Échange" },
  { code: "J2", label: "J2 — Conjoint/Enfant de J1", category: "Échange" },

  // ─── Travail temporaire ───
  { code: "H1B", label: "H1B — Travailleur spécialisé", category: "Travail" },
  { code: "H2A", label: "H2A — Travailleur agricole saisonnier", category: "Travail" },
  { code: "H2B", label: "H2B — Travailleur non-agricole saisonnier", category: "Travail" },
  { code: "H3", label: "H3 — Stagiaire / Éducation spéciale", category: "Travail" },
  { code: "H4", label: "H4 — Conjoint/Enfant de H1B/H2/H3", category: "Travail" },
  { code: "L1A", label: "L1A — Transfert intra-entreprise (cadre)", category: "Travail" },
  { code: "L1B", label: "L1B — Transfert intra-entreprise (connaissances spécialisées)", category: "Travail" },
  { code: "L2", label: "L2 — Conjoint/Enfant de L1", category: "Travail" },
  { code: "O1", label: "O1 — Aptitudes extraordinaires", category: "Travail" },
  { code: "O2", label: "O2 — Accompagnateur de O1", category: "Travail" },
  { code: "O3", label: "O3 — Conjoint/Enfant de O1/O2", category: "Travail" },
  { code: "P1", label: "P1 — Athlète/Artiste reconnu internationalement", category: "Travail" },
  { code: "P2", label: "P2 — Artiste (programme d'échange)", category: "Travail" },
  { code: "P3", label: "P3 — Artiste (programme culturellement unique)", category: "Travail" },
  { code: "Q1", label: "Q1 — Échange culturel international", category: "Travail" },
  { code: "R1", label: "R1 — Travailleur religieux", category: "Travail" },
  { code: "R2", label: "R2 — Conjoint/Enfant de R1", category: "Travail" },
  { code: "E1", label: "E1 — Commerçant (Treaty Trader)", category: "Travail" },
  { code: "E2", label: "E2 — Investisseur (Treaty Investor)", category: "Travail" },
  { code: "E3", label: "E3 — Australien spécialisé", category: "Travail" },
  { code: "TN", label: "TN — USMCA/NAFTA professionnel", category: "Travail" },

  // ─── Fiancé(e) & Mariage ───
  { code: "K1", label: "K1 — Fiancé(e) de citoyen US", category: "Fiancé" },
  { code: "K2", label: "K2 — Enfant de fiancé(e) K1", category: "Fiancé" },
  { code: "K3", label: "K3 — Conjoint de citoyen US (en attente d'IV)", category: "Fiancé" },
  { code: "K4", label: "K4 — Enfant de K3", category: "Fiancé" },

  // ─── Transit ───
  { code: "C1", label: "C1 — Transit", category: "Transit" },
  { code: "C1/D", label: "C1/D — Équipage de transport (Crew)", category: "Transit" },
  { code: "D", label: "D — Membre d'équipage", category: "Transit" },

  // ─── Diplomatie & Gouvernement ───
  { code: "A1", label: "A1 — Ambassadeur / Diplomate", category: "Diplomatique" },
  { code: "A2", label: "A2 — Autre officiel gouvernemental", category: "Diplomatique" },
  { code: "A3", label: "A3 — Employé de A1/A2", category: "Diplomatique" },
  { code: "G1", label: "G1 — Représentant gouvernement auprès d'org. internationale", category: "Diplomatique" },
  { code: "G2", label: "G2 — Représentant (autre) auprès d'org. internationale", category: "Diplomatique" },
  { code: "G3", label: "G3 — Représentant de gouvernement non-membre", category: "Diplomatique" },
  { code: "G4", label: "G4 — Fonctionnaire d'org. internationale", category: "Diplomatique" },
  { code: "G5", label: "G5 — Employé de G1-G4", category: "Diplomatique" },
  { code: "NATO", label: "NATO — Personnel OTAN", category: "Diplomatique" },

  // ─── Média ───
  { code: "I", label: "I — Représentant des médias / Journaliste", category: "Média" },

  // ─── Victimes & Protection ───
  { code: "T", label: "T — Victime de traite de personnes", category: "Protection" },
  { code: "U", label: "U — Victime d'activité criminelle", category: "Protection" },
  { code: "V", label: "V — Conjoint/Enfant de résident permanent (LIFE Act)", category: "Protection" },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// CATÉGORIE : IMMIGRANT VISA (IV)
// ═══════════════════════════════════════════════════════════════════════════════

export const IV_VISA_TYPES = [
  // ─── Famille (Immediate Relatives) ───
  { code: "IR1", label: "IR1 — Conjoint de citoyen US", category: "Famille immédiate" },
  { code: "IR2", label: "IR2 — Enfant non-marié (<21) de citoyen US", category: "Famille immédiate" },
  { code: "IR3", label: "IR3 — Orphelin adopté à l'étranger", category: "Famille immédiate" },
  { code: "IR4", label: "IR4 — Orphelin à adopter aux USA", category: "Famille immédiate" },
  { code: "IR5", label: "IR5 — Parent de citoyen US (21+)", category: "Famille immédiate" },
  { code: "CR1", label: "CR1 — Conjoint de citoyen US (mariage < 2 ans)", category: "Famille immédiate" },
  { code: "CR2", label: "CR2 — Enfant de CR1", category: "Famille immédiate" },

  // ─── Famille (Preference Categories) ───
  { code: "F1-IV", label: "F1 — Enfant non-marié (21+) de citoyen US", category: "Famille préférence" },
  { code: "F2A", label: "F2A — Conjoint/Enfant (<21) de résident permanent", category: "Famille préférence" },
  { code: "F2B", label: "F2B — Enfant non-marié (21+) de résident permanent", category: "Famille préférence" },
  { code: "F3-IV", label: "F3 — Enfant marié de citoyen US", category: "Famille préférence" },
  { code: "F4-IV", label: "F4 — Frère/Sœur de citoyen US (21+)", category: "Famille préférence" },

  // ─── Emploi (Employment-Based) ───
  { code: "EB1", label: "EB1 — Prioritaire (aptitudes extraordinaires, cadres, chercheurs)", category: "Emploi" },
  { code: "EB2", label: "EB2 — Professionnel diplômé / Aptitudes exceptionnelles", category: "Emploi" },
  { code: "EB3", label: "EB3 — Travailleur qualifié / Professionnel / Autre", category: "Emploi" },
  { code: "EB4", label: "EB4 — Immigrant spécial (religieux, militaire, etc.)", category: "Emploi" },
  { code: "EB5", label: "EB5 — Investisseur (création d'emplois)", category: "Emploi" },

  // ─── Diversité (Lottery) ───
  { code: "DV", label: "DV — Visa diversité (Loterie)", category: "Diversité" },

  // ─── Autres IV ───
  { code: "SB1", label: "SB1 — Résident de retour", category: "Autre IV" },
  { code: "SE", label: "SE — Immigrant spécial (catégories diverses)", category: "Autre IV" },
  { code: "SQ", label: "SQ — Immigrant spécial Irak/Afghanistan", category: "Autre IV" },
] as const;

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES DÉRIVÉS & HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Catégorie principale de visa */
export type VisaCategory = "NIV" | "IV";

/** Code de visa NIV (ex: "F1", "B1/B2", "H1B") */
export type NivVisaCode = (typeof NIV_VISA_TYPES)[number]["code"];

/** Code de visa IV (ex: "IR1", "DV", "EB1") */
export type IvVisaCode = (typeof IV_VISA_TYPES)[number]["code"];

/** Tout code de visa US */
export type UsVisaCode = NivVisaCode | IvVisaCode;

/** Tous les types de visa combinés */
export const ALL_US_VISA_TYPES = [...NIV_VISA_TYPES, ...IV_VISA_TYPES] as const;

/**
 * Détermine la catégorie (NIV ou IV) à partir du code visa.
 * Utilisé pour segmenter les canaux de broadcast.
 */
export function getVisaCategory(code: string): VisaCategory | null {
  if (NIV_VISA_TYPES.some((v) => v.code === code)) return "NIV";
  if (IV_VISA_TYPES.some((v) => v.code === code)) return "IV";
  return null;
}

/**
 * Récupère la définition complète d'un visa par son code.
 */
export function getVisaByCode(code: string) {
  return ALL_US_VISA_TYPES.find((v) => v.code === code) ?? null;
}

/**
 * Codes NIV les plus courants à Kinshasa (portail USVISAAPPT).
 * Utilisés pour l'affichage priorisé dans les selects UI.
 */
export const COMMON_NIV_KINSHASA = ["B1/B2", "F1", "J1", "K1", "H1B"] as const;

/**
 * Codes IV les plus courants à Kinshasa.
 */
export const COMMON_IV_KINSHASA = ["IR1", "CR1", "DV", "F2A", "IR2"] as const;

/**
 * Pour le filtrage des canaux de broadcast :
 * Le code visaClass utilisé sur le portail USA (ce que le serveur retourne).
 * Il correspond au code PRINCIPAL du type de visa (pas le suffixe dérivé).
 *
 * Règle : deux comptes partagent un canal SI ET SEULEMENT SI ils ont le MÊME visaClass.
 * Un éclaireur F1 ne peut broadcaster qu'aux confinés F1.
 * Un éclaireur B1/B2 ne peut broadcaster qu'aux confinés B1/B2.
 */
export function getVisaClassForBroadcast(code: string): string {
  // Le portail USA groupe certains visas ensemble :
  // - B1 et B2 sont toujours groupés comme "B1/B2"
  // - F1 et F2 sont groupés comme "F1" (même rendez-vous)
  // - H1B, H2A, H2B, H3, H4 sont groupés comme "H" (même catégorie)
  // - L1A, L1B, L2 sont groupés comme "L"
  // - K1, K2, K3, K4 sont groupés comme "K"

  const normalizations: Record<string, string> = {
    "B1": "B1/B2",
    "B2": "B1/B2",
    "B1/B2": "B1/B2",
    "F1": "F1",
    "F2": "F1",
    "M1": "M1",
    "M2": "M1",
    "J1": "J1",
    "J2": "J1",
    "H1B": "H",
    "H2A": "H",
    "H2B": "H",
    "H3": "H",
    "H4": "H",
    "L1A": "L",
    "L1B": "L",
    "L2": "L",
    "O1": "O",
    "O2": "O",
    "O3": "O",
    "P1": "P",
    "P2": "P",
    "P3": "P",
    "K1": "K",
    "K2": "K",
    "K3": "K",
    "K4": "K",
    "E1": "E",
    "E2": "E",
    "E3": "E",
    "R1": "R",
    "R2": "R",
    // IV — chaque famille a sa propre classe
    "IR1": "IR",
    "IR2": "IR",
    "IR3": "IR",
    "IR4": "IR",
    "IR5": "IR",
    "CR1": "CR",
    "CR2": "CR",
    "DV": "DV",
    "EB1": "EB",
    "EB2": "EB",
    "EB3": "EB",
    "EB4": "EB",
    "EB5": "EB",
  };

  return normalizations[code] ?? code;
}
