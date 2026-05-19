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

// ─── PRIORITY 1: Scan Scenario Selector (19/05/2026) ────────────────────────
// PROBLEM: The preflight sequence was ALWAYS identical:
//   landingPage → transformData → search → sanityCheck → OFC list
// This deterministic ordering is a fingerprint detectable by ML-based WAF.
//
// FIX: Randomly select from 5 "human behavior scenarios" that vary:
//   - Whether to call getLandingPage (browser cache hit = skip 20% of time)
//   - Whether sanityCheck comes before or after search (user clicking fast)
//   - Whether to add a micro-pause "distraction" mid-sequence
//   - Whether to skip OFC list (already cached from previous scan ~80% of time)
//
// CONSTRAINTS:
//   - getTransformData MUST run before search (provides applicantId fallback)
//   - /appointments/search is ALWAYS required (provides IDs for booking)
//   - OFC list can be skipped if caller provides a cached version

/** Scan scenario — determines preflight behavior variation. */
type ScanScenario = "full" | "skip_landing" | "fast_click" | "distracted" | "cached_ofc";

/** Weighted random scenario selection.
 *  Mimics real human behavior distribution:
 *  - full (40%): normal page load, all steps
 *  - skip_landing (20%): browser cached landing page, skips warm-up
 *  - fast_click (15%): user clicks "Create Appointment" before page fully loads → sanityCheck first
 *  - distracted (15%): user pauses mid-flow (checks phone) → longer pause between steps
 *  - cached_ofc (10%): OFC list cached from previous navigation → skip getpost
 */
function pickScanScenario(): ScanScenario {
  const r = Math.random();
  if (r < 0.40) return "full";
  if (r < 0.60) return "skip_landing";
  if (r < 0.75) return "fast_click";
  if (r < 0.90) return "distracted";
  return "cached_ofc";
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Exécute la séquence preflight avec VARIABILITÉ DE SÉQUENCE (Priority 1).
 *
 * 5 scénarios comportementaux humains réalistes :
 *   - "full": landingPage → transformData → search → sanityCheck → OFC (40%)
 *   - "skip_landing": transformData → search → sanityCheck → OFC (20%) — browser cache hit
 *   - "fast_click": sanityCheck → transformData → search → OFC (15%) — click before page loads
 *   - "distracted": landingPage → [long pause] → transformData → search → OFC (15%)
 *   - "cached_ofc": landingPage → transformData → search (10%) — OFC cached from last nav
 *
 * RÈGLE ABSOLUE : /appointments/search est TOUJOURS exécuté (fournit les vrais IDs).
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

  // ── PRIORITY 1: Pick a random scan scenario ──
  const scenario = pickScanScenario();
  console.log(`[scan-preflight] 🎲 Scénario: ${scenario}`);

  // ── Helper: run getTransformData ──
  const doTransformData = async () => {
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
  };

  // ── Helper: run /appointments/search ──
  const doSearch = async () => {
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
  };

  // ── Execute based on scenario ──
  switch (scenario) {
    case "full":
      // Standard: landing → transform → search → sanity → OFC
      try { await callLandingPage(session); } catch { /* non-bloquant */ }
      await interStepPause();
      await doTransformData();
      await interStepPause();
      await doSearch();
      await interStepPause();
      try { await callSanityCheck(session); } catch { /* non-bloquant */ }
      break;

    case "skip_landing":
      // Browser cached landing page — skip warm-up (20% of real users)
      // A real Chrome with Service Worker doesn't re-fetch the landing page every time
      await doTransformData();
      await interStepPause();
      await doSearch();
      await interStepPause();
      try { await callSanityCheck(session); } catch { /* non-bloquant */ }
      break;

    case "fast_click":
      // User clicked "Create Appointment" before page fully loaded
      // → sanityCheck fires BEFORE getTransformData resolves (Angular race condition)
      try { await callSanityCheck(session); } catch { /* non-bloquant */ }
      await interStepPause();
      try { await callLandingPage(session); } catch { /* non-bloquant */ }
      await interStepPause();
      await doTransformData();
      await interStepPause();
      await doSearch();
      break;

    case "distracted":
      // User got distracted mid-flow (checked phone, read notification)
      try { await callLandingPage(session); } catch { /* non-bloquant */ }
      // Long distraction pause (5-12s instead of normal 0.5-2s)
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 7000));
      await doTransformData();
      await interStepPause();
      await doSearch();
      // Maybe skip sanityCheck entirely (user navigated away briefly)
      if (Math.random() > 0.4) {
        await interStepPause();
        try { await callSanityCheck(session); } catch { /* non-bloquant */ }
      }
      break;

    case "cached_ofc":
      // OFC list still in Angular sessionStorage from previous navigation
      // Shorter preflight — landing + transform + search only
      try { await callLandingPage(session); } catch { /* non-bloquant */ }
      await interStepPause();
      await doTransformData();
      await interStepPause();
      await doSearch();
      // Skip sanityCheck (already done on previous page load)
      break;
  }

  // Validation minimale
  if (!applicantId) {
    throw new PreflightError("search", "applicantId introuvable (ni getTransformData ni /appointments/search)");
  }

  await interStepPause();

  // ── 5. getpost → OFC list (skipped in "cached_ofc" scenario 10% of time) ──
  let ofcList: UsaOfc[];

  // In "cached_ofc" scenario, we still need the OFC list but we use a shorter path
  // (the real Angular app would already have it in sessionStorage)
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
