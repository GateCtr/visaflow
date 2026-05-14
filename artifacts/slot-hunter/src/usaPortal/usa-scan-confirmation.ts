/**
 * Téléchargement lettre de confirmation PDF.
 */
import type { UsaSession } from "./types.js";
import {
  USA_SANITY_CHECK_URL,
  USA_CONFIRMATION_LETTER_URL,
  REFERER_REQUESTS,
} from "./config.js";
import { usaFetch, sessionHeaders } from "./usa-http.js";

/**
 * Télécharge la lettre de confirmation de RDV au format PDF.
 * POST /visanotificationapi/template/appointmentLetter
 *
 * Séquence Angular (capture réseau 13/05/2026) :
 *   1. POST sanityCheck(appId, "appointmentLetter")  → fire-and-forget, body vide, Content-Length: 0
 *   2. POST /template/appointmentLetter              → blob PDF
 *   3. createObjectURL(blob) + a.download            → téléchargement navigateur
 *
 * Payload réel capturé : { languageId: 1, applicationId, applicantId }
 *   - languageId: 1 (anglais)
 *   - applicationId: format court "fa68-6780-e96e-c8eb"
 *   - applicantId: format GSS string "RQUP3HHVQHOD"
 *   - PAS de missionId ni appointmentId dans le payload (contrairement à ce qu'on pensait)
 *
 * Referer réel : /visaapplicantui/home/dashboard/requests (pas create-appointment)
 * Headers : Accept: application/pdf  +  cookies missionId/APP_ID_TOBE via sessionHeaders.
 * Retourne le contenu PDF en Buffer, ou null en cas d'erreur.
 */
export async function downloadUsaConfirmationPdf(
  session: UsaSession,
  applicationId: string,
  _appointmentId?: number | string
): Promise<Buffer | null> {
  console.log(`[usa] Téléchargement confirmation PDF — applicationId=${applicationId}, applicantId=${session.applicantId ?? "n/a"}...`);

  // Étape 1 : sanityCheck avec stepType="appointmentLetter" (fire-and-forget, comme le bundle Angular)
  // Le portail l'appelle juste avant de générer la lettre, sans attendre la réponse.
  // Capture réseau : POST avec Content-Length: 0 (pas de body), Referer = dashboard/requests
  if (session.applicationId) {
    const sanityUrl = USA_SANITY_CHECK_URL(session.applicationId, "appointmentLetter");
    const sanityHeaders = sessionHeaders(session.accessToken, session.applicationId, session.missionId, REFERER_REQUESTS, true);
    usaFetch(sanityUrl, { method: "POST", headers: sanityHeaders })
      .then(r => console.log(`[usa] sanityCheck(appointmentLetter) → HTTP ${r.status}`))
      .catch(e => console.warn("[usa] sanityCheck(appointmentLetter) ignoré:", e));
  }

  // Étape 2 : POST appointmentLetter → blob PDF
  // Payload aligné sur la capture réseau réelle (13/05/2026) :
  //   { "languageId": 1, "applicationId": "fa68-6780-e96e-c8eb", "applicantId": "RQUP3HHVQHOD" }
  // Content-Length capturé : 83 bytes — correspond exactement à ce payload.
  const letterPayload: Record<string, unknown> = {
    languageId: 1,
    applicationId,
    applicantId: session.applicantId ?? session.userID,
  };

  try {
    const res = await usaFetch(USA_CONFIRMATION_LETTER_URL, {
      method: "POST",
      // Referer = dashboard/requests (pas create-appointment) — capturé dans les logs réseau.
      // Accept: application/pdf écrase le "application/json" de sessionHeaders.
      headers: {
        ...sessionHeaders(session.accessToken, applicationId, session.missionId, REFERER_REQUESTS),
        "Accept": "application/pdf",
      },
      body: JSON.stringify(letterPayload),
    });

    if (!res.ok) {
      console.warn(`[usa] downloadConfirmationPdf HTTP ${res.status}`);
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("pdf") && !contentType.includes("octet-stream")) {
      const text = await res.text();
      console.warn(`[usa] Réponse inattendue (non-PDF): ${text.slice(0, 200)}`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    console.log(`[usa] Confirmation PDF téléchargée: ${buf.length} bytes`);
    return buf;
  } catch (err) {
    console.warn(`[usa] downloadConfirmationPdf erreur: ${err}`);
    return null;
  }
}
