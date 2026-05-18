/**
 * Scan Preflight V3 — Warm-up + extraction des IDs obligatoires avant scan.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Exécuter la séquence preflight OBLIGATOIRE qui précède tout scan :
 *     1. getTransformData → stateCode, visaTypeKey, paymentStatus, applicantId GSS
 *     2. /appointments/search → appointmentId, applicantId, visaType, visaClass, applicantUUID
 *     3. getpost (OFC list) → liste des bureaux à scanner
 *
 *   Retourne un PreflightResult prêt à être consommé par scan-session.ts.
 *
 * RÈGLE ABSOLUE (doc V3) :
 *   `/appointments/search` est OBLIGATOIRE avant tout scan — fournit les vrais IDs.
 *
 * INTÉGRATION :
 *   Appelé par scan-session.ts au début de chaque cycle de scan.
 *   Réutilise les helpers existants de V2 (usaFetch, authHeaders, etc.)
 *   mais avec une interface propre et typée.
 */

import {
  USA_SEARCH_URL,
  USA_MISSION_ID,
  REFERER_CREATE_APT,
} from "../../usaPortal/config.js";
import { usaFetch, authHeaders } from "../../usaPortal/usa-http.js";
import { getUsaTransformData, getUsaOfcList } from "../../usaPortal/usa-scan-details.js";
import { callLandingPage, callSanityCheck } from "../../usaPortal/usa-scan-preflight.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "../../usaPortal/errors.js";
import type { UsaSession } from "../../usaPortal/types.js";
import type { UsaOfc, UsaAppDetails } from "../../usaPortal/usa-scan-types.js";
import { interStepPause } from "../anti-detection/human-timing.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Résultat du preflight — toutes les données nécessaires au scan. */
export interface PreflightResult {
  /** Détails de l'applicant (prêts pour les payloads slot). */
  appDetails: UsaAppDetails;
  /** Liste des OFCs à scanner. */
  ofcList: UsaOfc[];
  /** Le paiement MRV est-il vérifié ? */
  paymentVerified: boolean;
  /** stateCode extrait de getTransformData (pour les logs). */
  stateCode?: string;
}

/** Erreur spécifique au preflight. */
export class PreflightError extends Error {
  constructor(
    public readonly stage: "transform" | "search" | "ofc_list",
    message: string,
  ) {
    super(message);
    this.name = "PreflightError";
  }
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Exécute la séquence preflight complète.
 *
 * Flow :
 *   1. callLandingPage (warm-up anti-détection)
 *   2. getTransformData → paymentStatus, stateCode, visaTypeKey, applicantId
 *   3. /appointments/search → appointmentId, applicantId, visaType, visaClass
 *   4. callSanityCheck (anti-détection)
 *   5. getpost → OFC list
 *
 * Lève RateLimitError / AccountBlockedError / TokenExpiredError si critique.
 * Lève PreflightError si les données minimales sont introuvables.
 */
export async function runPreflight(
  session: UsaSession,
  applicationId: string,
  missionId?: number,
): Promise<PreflightResult> {
  const effectiveMissionId = missionId ?? session.missionId ?? USA_MISSION_ID;
  let stateCode: string | undefined;
  let appointmentPriority: string | undefined;
  let visaTypeKey: string | undefined;
  let visaClass: string | undefined;
  let visaCategory: string | undefined;
  let visaCategoryKey: string | undefined;
  let applicantId: string | undefined;
  let appointmentId: number | undefined;
  let applicantUUID: number | string | undefined;
  let appointmentLocationType: string | undefined;
  let paymentVerified = true; // optimiste par défaut

  // ── 1. Warm-up (landing page) — anti-détection ──
  try {
    await callLandingPage(session);
  } catch { /* non-bloquant */ }

  await interStepPause();

  // ── 2. getTransformData → stateCode, visaTypeKey, paymentStatus ──
  try {
    const td = await getUsaTransformData(session, applicationId);
    if (td) {
      stateCode = td.stateCode;
      appointmentPriority = td.appointmentPriority;
      visaTypeKey = td.visaTypeKey;
      if (td.visaClass) visaClass = td.visaClass;
      if (td.visaCategoryKey) visaCategoryKey = td.visaCategoryKey;
      else if (td.visaCategory) visaCategory = td.visaCategory;
      if (td.applicantId) applicantId = td.applicantId;
      if (td.paymentStatus === "VERIFIED") {
        paymentVerified = true;
      } else if (td.paymentStatus) {
        paymentVerified = false;
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[scan-preflight] getTransformData échoué — continuera avec les valeurs du search`);
  }

  await interStepPause();

  // ── 3. /appointments/search → applicantId, visaType, visaClass, appointmentId ──
  try {
    const searchPayload = {
      operation: "AND",
      searchObjects: [
        { key: "applicationId", value: applicationId, feildType: "STRING", operation: "EQUAL" },
      ],
    };
    const hdrs = authHeaders(session.accessToken, REFERER_CREATE_APT, true);
    const res = await usaFetch(USA_SEARCH_URL, {
      method: "POST",
      headers: hdrs,
      body: JSON.stringify(searchPayload),
    });

    if (res.status === 429) throw new RateLimitError("/appointments/search", 60_000);
    if (res.status === 403) throw new AccountBlockedError("/appointments/search");
    if (res.status === 401) throw new TokenExpiredError();

    if (res.ok) {
      const rows = await res.json() as Record<string, unknown>[];
      // Filtrer pour appointmentStatus === "NEW" (logique bundle Angular)
      const newEntries = rows.filter(r => r.appointmentStatus === "NEW");
      const target = newEntries[0] ?? rows[0];

      if (target) {
        if (typeof target.applicantId === "string") applicantId = target.applicantId;
        if (typeof target.visaType === "string") visaTypeKey = visaTypeKey ?? target.visaType as string;
        if (typeof target.visaClass === "string") visaClass = target.visaClass as string;
        if (typeof target.appointmentId === "number") appointmentId = target.appointmentId as number;
        if (typeof target.appointmentLocationType === "string") appointmentLocationType = target.appointmentLocationType as string;
        if (typeof target.visaCategory === "string") visaCategory = target.visaCategory as string;
        if (typeof target.applicantUUID === "number") applicantUUID = target.applicantUUID as number;
        else if (typeof target.applicantUUID === "string") applicantUUID = target.applicantUUID as string;
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    console.warn(`[scan-preflight] /appointments/search échoué: ${err}`);
  }

  // Validation minimale
  if (!applicantId) {
    throw new PreflightError("search", "applicantId introuvable (ni getTransformData ni /appointments/search)");
  }

  await interStepPause();

  // ── 4. Sanity check (anti-détection) ──
  try {
    await callSanityCheck(session);
  } catch { /* non-bloquant */ }

  await interStepPause();

  // ── 5. getpost → OFC list ──
  let ofcList: UsaOfc[];
  try {
    ofcList = await getUsaOfcList(
      session,
      effectiveMissionId,
      visaClass,
      visaCategoryKey ?? visaCategory,
      stateCode,
      appointmentPriority,
    );
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof AccountBlockedError ||
        err instanceof TokenExpiredError || err instanceof AccountRestrictedError) throw err;
    throw new PreflightError("ofc_list", `getpost échoué: ${err}`);
  }

  if (ofcList.length === 0) {
    throw new PreflightError("ofc_list", "Aucun OFC trouvé pour cette mission/visaClass");
  }

  // ── Construire le résultat ──
  const appDetails: UsaAppDetails = {
    applicantId,
    applicationId,
    visaType: visaTypeKey ?? "NIV",
    visaClass: visaClass ?? "B1/B2",
    visaCategory: visaCategoryKey ?? visaCategory,
    appointmentId,
    applicantUUID,
    appointmentLocationType,
    visaTypeKey,
  };

  console.log(
    `[scan-preflight] ✅ Preflight OK — applicant=${applicantId} ` +
    `visaType=${appDetails.visaType} visaClass=${appDetails.visaClass} ` +
    `OFCs=${ofcList.length} payment=${paymentVerified ? "OK" : "NOT_VERIFIED"}`
  );

  return {
    appDetails,
    ofcList,
    paymentVerified,
    stateCode,
  };
}
