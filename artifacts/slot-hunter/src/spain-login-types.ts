/**
 * Types de login Bookitit essayés dans un ordre strict.
 *
 * Le portail Kinshasa a historiquement utilisé `document`. Les autres valeurs
 * ne sont des fallbacks que lorsque signin/ ne renvoie aucune réponse exploitable;
 * une erreur métier explicite ne doit jamais déclencher une nouvelle tentative.
 */

export type SpainLoginType = "document" | "passport" | "email" | "dni" | "nationalid";

const DEFAULT_LOGIN_TYPES: readonly SpainLoginType[] = ["document", "passport", "email"];
const ALLOWED_LOGIN_TYPES = new Set<SpainLoginType>([
  "document",
  "passport",
  "email",
  "dni",
  "nationalid",
]);

/**
 * Permet d'ajuster l'ordre sans modifier le code, tout en restant limité aux
 * valeurs connues. Le premier type reste `document` par défaut.
 */
export function getSpainLoginTypes(): SpainLoginType[] {
  const configured = (process.env.SPAIN_LOGIN_TYPES ?? DEFAULT_LOGIN_TYPES.join(","))
    .split(",")
    .map((value) => value.trim().toLowerCase() as SpainLoginType)
    .filter((value) => ALLOWED_LOGIN_TYPES.has(value));

  const unique = [...new Set(configured)];
  return unique.length > 0 ? unique : [...DEFAULT_LOGIN_TYPES];
}