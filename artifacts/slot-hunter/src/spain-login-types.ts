/**
 * Types de login fournis dynamiquement par Bookitit.
 *
 * Ne pas maintenir de liste locale (`document`, `passport`, etc.) : chaque
 * portail renvoie ses valeurs autorisées via getsigninaccountfields/.
 */
export type SpainLoginType = string;

function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/**
 * Extrait les options réellement exposées par le formulaire de connexion
 * historique/annulations.
 */
export function extractSpainLoginTypes(payload: unknown): SpainLoginType[] {
  const root = payload as {
    CustomFields?: { Clients?: unknown };
    Clients?: unknown;
  } | null;

  const clients = root?.CustomFields && typeof root.CustomFields === "object"
    ? (root.CustomFields as { Clients?: unknown }).Clients
    : root?.Clients;

  if (!Array.isArray(clients)) return [];

  return [...new Set(
    clients
      .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === "object")
      .filter((field) => isEnabled(field.show_widget) && isEnabled(field.validate))
      .map((field) => typeof field.input_text === "string" ? field.input_text.trim() : "")
      .filter((value) => value.length > 0),
  )];
}