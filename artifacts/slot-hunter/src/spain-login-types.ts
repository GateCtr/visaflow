/**
 * Type de login utilisé par le booking.
 *
 * Le flux de réservation ne passe pas par la section historique/annulations :
 * il utilise directement le contrat `signin/`. `document` est la valeur
 * confirmée sur Kinshasa, Saopolo et Cuba ; un override reste possible pour
 * un futur portail divergent.
 */
export type SpainLoginType = string;

function isEnabled(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/**
 * Extrait les options de login depuis la réponse booking de
 * getsigninfields/ (CustomFields.Clients). Le même parseur reste compatible
 * avec la réponse account-login, sans que le booking ait besoin de l'appeler.
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

export function getSpainBookingLoginType(): SpainLoginType {
  const configured = process.env.SPAIN_LOGIN_TYPE?.trim();
  return configured || "document";
}