/**
 * Types et utilitaires purs pour le scan de créneaux / booking portail USA.
 * Extrait de scan-slot-booking.ts (découpage maintenance).
 */

// ─────────────────────────────────────────────────────────────
// Types pour les réponses des endpoints de slot (bundle Angular)
// ─────────────────────────────────────────────────────────────

export interface UsaOfc {
  postUserId: number;
  postName: string;
  officeType: string;  // "OFC" | "POST"
  postCode?: string;
}

/** Réponse brute de l'API /lookupcdt/wizard/getpost — champs réels du serveur.
 * Le portail renvoie `ofcName` et `code`, pas `postName`/`postCode`. */
export interface UsaOfcRaw {
  postUserId: number;
  missionId?: number;
  ofcName?: string;
  postName?: string;  // Certaines missions renvoient postName au lieu de ofcName
  ofcAddress?: string;
  countryCode?: string;
  stateCode?: string;
  city?: string;
  officeType: string;
  code?: string;
  status?: string;
}

/** Normalise la réponse brute de l'API OFC en UsaOfc interne. */
export function normalizeOfc(raw: UsaOfcRaw): UsaOfc {
  return {
    postUserId: raw.postUserId,
    postName: raw.ofcName ?? raw.postName ?? raw.city ?? `OFC-${raw.postUserId}`,
    officeType: raw.officeType,
    postCode: raw.code,
  };
}

export interface UsaAppDetails {
  applicantId: number | string;
  applicationId: string;
  /** visaType envoyé dans les payloads slot (getFirstAvailableMonth, getSlotDates, etc.)
   * Ex: "NIV" (Non-Immigrant Visa). Différent de visaCategory! */
  visaType: string;
  visaClass: string;
  /** visaCategory envoyé dans l'URL getpost (OFC list).
   * Ex: "VisitorVisas". Le portail Angular l'envoie comme param ?visaCategory= dans getFilteredOfcPostList.
   * Distinct de visaType ("NIV") qui va dans les payloads de slot. */
  visaCategory?: string;
  locationType?: string;
  /** appointmentStatus — bundle Angular filtre sur "NEW" pour obtenir selectedSlotDetails. */
  appointmentStatus?: string;
  /** appointmentLocationType — "OFC" | "POST" */
  appointmentLocationType?: string;
  /** appointmentId — obligatoire dans le payload de booking (bundle Angular : selectedSlotDetails.appointmentId).
   * Vient de la réponse tableau de getApplicationDetails, filtrée sur appointmentStatus === "NEW". */
  appointmentId?: number;
  /** UUID de l'applicant — inclus dans le payload de booking (bundle Angular : selectedSlotDetails.applicantUUID).
   * Peut être string (sessionStorage) ou number (parseInt). On stocke string, parseInt au booking. */
  applicantUUID?: string | number;
  /** visaTypeKey — short code format from /appointments/search (e.g. "NIV", "IV").
   * Used directly in slot payloads (getFirstAvailableMonth, getSlotDates, etc.). */
  visaTypeKey?: string;
}

export interface UsaFirstAvailableMonthResponse {
  present: boolean;
  date: string;  // "YYYY-MM-DD"
}

export interface UsaSlotDate {
  date: string;        // "YYYY-MM-DD"
  slotsAvailable: number;
  [key: string]: unknown;
}

export interface UsaTimeSlot {
  slotId: number | string;  // Le portail retourne un string alphanumérique (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  date?: string;       // peut être absent si l'API retourne slotDate à la place
  slotDate?: string;   // champ retourné par getSlotTime (utilisé comme appointmentDt au booking)
  startTime: string;   // "HH:mm" ou "YYYY-MM-DDTHH:mm:ss"
  endTime: string;
  slotsAvailable?: number;
  [key: string]: unknown;
}


export interface SlotFound {
  date: string;
  time: string;
  slotId: number | string;  // string alphanumérique retourné par le portail (ex: "hHPzm1VQyGRMhPR8ihQMlvOx2oN2Gt")
  ofcName: string;
  slot: UsaTimeSlot;
  bookingBase: Record<string, unknown>;
}

export function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function lastDayOfMonth(d: Date): string {
  return toYMD(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
