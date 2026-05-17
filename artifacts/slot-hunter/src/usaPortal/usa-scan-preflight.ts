/**
 * Warm-up API : landing, sanity check, FCS (pré-scan).
 */
import type { UsaSession } from "./types.js";
import {
  USA_LANDING_PAGE_URL,
  USA_SANITY_CHECK_URL,
  USA_FCS_CHECK_URL,
  REFERER_DASHBOARD,
  REFERER_CREATE_APT,
} from "./config.js";
import { usaFetch, sessionHeaders, resetCorrelationOnAction } from "./usa-http.js";

/**
 * Warm-up : appelé par le portail Angular dès l'ouverture du tableau de bord.
 * Reproduire cet appel rend le robot indiscernable d'un utilisateur légitime.
 * Erreurs ignorées silencieusement (non bloquant).
 */
export async function callLandingPage(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  // FIX 6: Reset correlation key on warm-up call (simulates page reload)
  resetCorrelationOnAction(REFERER_DASHBOARD);
  // GET depuis le dashboard — pas de Content-Type, Referer = dashboard parent
  // Bundle intercepteur : /getLandingPageDeatils reçoit LanguageId:{Ue} en plus des headers standards.
  // Toutes les AUTRES requêtes NE reçoivent PAS LanguageId — c'est une condition explicite dans l'intercepteur.
  const headers = {
    ...sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_DASHBOARD, false),
    "LanguageId": "1",
  };
  try {
    const res = await usaFetch(USA_LANDING_PAGE_URL, { method: "GET", headers });
    console.log(`[usa] getLandingPageDeatils → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] getLandingPageDeatils ignoré :", err);
  }
}

/**
 * Sanity check : POST /visaintegrationapi/visa/sanitycheck/{appId}?stepType=slotBooking
 * Appelé par le portail Angular à chaque init de page de booking.
 * Fire-and-forget (n'attend pas la réponse pour continuer).
 */
export async function callSanityCheck(session: UsaSession): Promise<void> {
  if (!session.applicationId) return;
  // FIX 6: Reset correlation key on page transition (dashboard → create-appointment)
  resetCorrelationOnAction(REFERER_CREATE_APT);
  const url = USA_SANITY_CHECK_URL(session.applicationId, "slotBooking");
  // POST sans corps — le portail envoie Content-Type mais pas de body
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, true);
  try {
    const res = await usaFetch(url, { method: "POST", headers });
    console.log(`[usa] sanityCheck(slotBooking) → HTTP ${res.status}`);
  } catch (err) {
    console.warn("[usa] sanityCheck ignoré :", err);
  }
}

/**
 * Vérification du paiement FCS : GET /visapaymentapi/v1/feecollection/checkFcs/{appId}
 * Appelé par le portail avant la réservation de créneau.
 * Retourne true si le paiement est confirmé côté FCS.
 * En cas d'erreur réseau, on laisse le scan continuer (bénéfice du doute).
 */
export async function checkFcsPayment(session: UsaSession): Promise<boolean> {
  if (!session.applicationId) return true; // laisser passer si pas d'appId
  const url = USA_FCS_CHECK_URL(session.applicationId);
  // GET — pas de Content-Type
  const headers = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_CREATE_APT, false);
  try {
    const res = await usaFetch(url, { method: "GET", headers });
    if (!res.ok) {
      console.warn(`[usa] checkFcs → HTTP ${res.status} — scan maintenu par prudence`);
      return true; // scan quand même
    }
    const data = await res.json() as { fcsStatus?: string; isPaid?: boolean; paymentStatus?: string };
    const paid = data.isPaid === true
      || data.fcsStatus === "1"
      || data.fcsStatus === "paid"
      || data.paymentStatus === "paid";
    console.log(`[usa] checkFcs → ${JSON.stringify(data)} → paid=${paid}`);
    return paid !== false; // tolérant si le format change
  } catch (err) {
    console.warn("[usa] checkFcs erreur réseau — scan maintenu :", err);
    return true;
  }
}
