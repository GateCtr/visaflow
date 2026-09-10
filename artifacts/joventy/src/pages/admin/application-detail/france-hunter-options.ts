export const FRANCE_CONSULATE_SLUG = "ambassade-de-france-a-kinshasa";

export interface FranceServiceOption {
  id: string;
  name: string;
  motifKey: string;
  motifs: readonly string[];
}

/**
 * Valeurs exactes exposées par consulat.gouv.fr pour Kinshasa.
 * Les espaces finaux de certains motifs font partie de la valeur API.
 */
export const FRANCE_SERVICES: readonly FranceServiceOption[] = [
  {
    id: "6346e242c47b29722d5f5f4e",
    name: "ADF - Demande d'inscription au Registre, de CNI/ passeport/déclaration de vol ou perte de documents",
    motifKey: "ce05f27d741e0918",
    motifs: [
      "Passeport ",
      "Carte nationale d'identité ",
      "Inscription au Registre ",
      "Passeport et CNI ",
      "Déclaration de vol ou de perte de documents ",
    ],
  },
  {
    id: "6346e242c47b29722d5f5f50",
    name: "ADF - Dépôt des Légalisations",
    motifKey: "",
    motifs: [],
  },
  {
    id: "6346e242c47b29722d5f5f51",
    name: "Etat civil",
    motifKey: "0d70a0061c16b9a4",
    motifs: [
      "Acte de naissance ",
      "Acte de mariage ",
      "Acte de reconnaissance ",
      "Acte de décès ",
    ],
  },
  {
    id: "6346e242c47b29722d5f5f52",
    name: "Visas",
    motifKey: "fc24d7ef7972e5cb",
    motifs: [
      "Regroupement familial",
      "Visa retour",
      "Reunification familial",
      "Stagiaire associé",
      "Conjoint de Français - Installation ",
      "Etudiant ",
      "Autres ",
    ],
  },
] as const;