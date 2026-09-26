const CHINA_TYPE_LABELS: Array<[RegExp, string]> = [
  [/^visa\s*l\b/i, "Visa L — Tourisme"],
  [/^visa\s*m\b/i, "Visa M — Affaires / Commerce"],
  [/^visa\s*f\b/i, "Visa F — Échange / Visite"],
  [/^visa\s*x2\b/i, "Visa X2 — Études court séjour"],
];

/**
 * Keep historical China applications readable without changing their stored data.
 * The previous flow saved e-Visa/VFS labels that do not match the current Kinshasa route.
 */
export function getDisplayVisaType(destination: string, visaType: string): string {
  if (destination !== "china") return visaType;

  const value = visaType.trim();
  if (/e-?visa\s*chine/i.test(value)) return "Visa classique Chine — catégorie à confirmer";

  const category = CHINA_TYPE_LABELS.find(([pattern]) => pattern.test(value));
  if (category) return category[1];

  const cleaned = value
    .replace(/\s*\([^)]*VFS[^)]*\)/gi, "")
    .replace(/\s*\([^)]*sans rendez-vous[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "Visa classique Chine — catégorie à confirmer";
}