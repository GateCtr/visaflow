/**
 * cevHttpCancel.ts — Annulation d'un RDV CEV via HTTP
 *
 * Flow réel CEV (découvert par reverse engineering du bundle JS 2026-08-02) :
 *
 *  1. La page Overview (/Integration/VOW/Overview) affiche les RDV confirmés
 *     sous forme de boutons <button class="btnSendCancellationLink" data-id="<uuid>">
 *
 *  2. Cliquer le bouton → modal "Souhaitez-vous annuler votre rendez-vous?"
 *     → cliquer "Confirmer" → AJAX POST :
 *       POST https://appointment.cloud.diplomatie.be/Shared/DoCancelRequestAppointment
 *       Body: uniqueToken=<uuid>&cultureCode=fr-BE
 *       Réponse: { succeeded: true, message: "Un email vous a été envoyé..." }
 *
 *  3. CEV envoie un email avec un lien d'annulation one-time.
 *     L'utilisateur doit cliquer ce lien pour finaliser l'annulation.
 *
 * IMPORTANT : Ce module déclenche l'envoi de l'email d'annulation (étape 2).
 * L'annulation effective nécessite ensuite que l'utilisateur clique le lien dans l'email.
 * Pour une annulation entièrement automatisée, il faudrait aussi lire l'email (IMAP).
 */

import { cevImpitFetch, getCevBrowserHeaders } from "./cev-shared-impit.js";
import { botLog } from "./convexClient.js";

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const CANCEL_REQUEST_ENDPOINT = `${CEV_BASE}/Shared/DoCancelRequestAppointment`;

export interface BookedAppointment {
  /** UUID interne CEV de ce rendez-vous (data-id du bouton) */
  uniqueToken: string;
  /** Texte affiché sur le bouton — ex. "mardi 22 décembre 2026 (14:20)" */
  label: string;
  /** Données additionnelles — ex. "visa passeport diplomatique - Prénom NOM - VOWINT..." */
  additionalData: string;
}

export interface CancelRequestResult {
  /** true si le POST a réussi et CEV a envoyé l'email d'annulation */
  emailSent: boolean;
  /** Message de confirmation retourné par CEV (affiché à l'utilisateur) */
  message?: string;
  /** Rendez-vous pour lequel la demande d'annulation a été envoyée */
  appointment?: BookedAppointment;
  /** Liste complète des RDV trouvés sur la page Overview */
  allAppointments: BookedAppointment[];
  error?: string;
}

/**
 * Extrait tous les rendez-vous confirmés depuis la page Overview/Booked.
 * Retourne un tableau de { uniqueToken, label, additionalData }.
 */
export function extractBookedAppointments(html: string): BookedAppointment[] {
  const appointments: BookedAppointment[] = [];

  // Pattern : <button class="btnSendCancellationLink ... " data-id="<uuid>">
  //             <i ...></i>&nbsp; mardi 22 décembre 2026 (14:20)
  //             <span class="additionalData">visa ... - VOWINT...</span>
  //           </button>
  const btnRe = /<button[^>]*class="[^"]*btnSendCancellationLink[^"]*"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/button>/gi;
  let m: RegExpExecArray | null;

  while ((m = btnRe.exec(html)) !== null) {
    const uniqueToken = m[1].trim();
    const inner = m[2];

    // Extraire le texte principal (date/heure) — texte direct hors des tags
    const textContent = inner
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&#[0-9]+;/g, c => String.fromCharCode(parseInt(c.slice(2, -1), 10)))
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();

    // Extraire additionalData de la <span class="additionalData">
    const spanM = /<span[^>]*class="additionalData"[^>]*>([\s\S]*?)<\/span>/i.exec(inner);
    const additionalData = spanM
      ? spanM[1]
          .replace(/&#[0-9]+;/g, c => String.fromCharCode(parseInt(c.slice(2, -1), 10)))
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim()
      : "";

    // Label = texte principal sans additionalData
    const label = textContent.replace(additionalData, "").trim();

    appointments.push({ uniqueToken, label, additionalData });
  }

  return appointments;
}

/**
 * Déclenche la demande d'annulation d'un rendez-vous CEV.
 *
 * Envoie le POST `Shared/DoCancelRequestAppointment` → CEV envoie un email
 * avec le lien d'annulation à l'adresse email du compte.
 *
 * @param overviewHtml    HTML de la page Overview (depuis setupCevSessionHttp)
 * @param cookies         Cookies complets (overviewCookies depuis le setup)
 * @param vowintRef       Référence VOWINT du dossier à annuler (filtre parmi plusieurs RDV)
 * @param clientId        ID du dossier (pour botLog)
 * @param cultureCode     Code de langue CEV (défaut: "fr-BE")
 */
export async function cancelCevAppointment(
  overviewHtml: string,
  cookies: string,
  vowintRef: string | undefined,
  clientId: string,
  cultureCode = "fr-BE",
): Promise<CancelRequestResult> {

  try {
    // ── Étape 1 : Parser les boutons de la page Overview ─────────────────
    const allAppointments = extractBookedAppointments(overviewHtml);

    botLog({
      applicationId: clientId,
      step: "cev_cancel_appointments_found",
      status: allAppointments.length > 0 ? "ok" : "warn",
      data: {
        count: allAppointments.length,
        appointments: allAppointments.map(a => ({
          token: a.uniqueToken.slice(0, 8) + "...",
          label: a.label,
          additionalData: a.additionalData,
        })),
        vowintRef,
      },
    });

    if (allAppointments.length === 0) {
      return {
        emailSent: false,
        allAppointments: [],
        error: "NO_APPOINTMENTS_FOUND_IN_OVERVIEW",
      };
    }

    // ── Étape 2 : Sélectionner le bon RDV (filtrer par VOWINT ref si fourni) ─
    let target: BookedAppointment | undefined;

    if (vowintRef) {
      // Chercher le RDV qui correspond à ce VOWINT ref dans additionalData
      target = allAppointments.find(a =>
        a.additionalData.toUpperCase().includes(vowintRef.toUpperCase()),
      );
    }

    // Si pas trouvé par VOWINT ou pas de filtre → prendre le premier
    if (!target) {
      target = allAppointments[0];
      if (vowintRef) {
        console.log(`[CEV-CANCEL] ⚠️ VOWINT ref ${vowintRef} non trouvée dans les RDV — annulation du premier RDV`);
      }
    }

    console.log(`[CEV-CANCEL] 🗑️ Demande d'annulation pour: ${target.label} — ${target.additionalData}`);

    // ── Étape 3 : POST /Shared/DoCancelRequestAppointment ────────────────
    const body = new URLSearchParams({
      uniqueToken: target.uniqueToken,
      cultureCode,
    }).toString();

    // Cet endpoint est appelé via jQuery.ajax (AJAX, non form-navigate)
    // → Sec-Fetch-Mode: cors, X-Requested-With: XMLHttpRequest,
    //   Content-Type: application/x-www-form-urlencoded; charset=UTF-8
    const res = await cevImpitFetch(CANCEL_REQUEST_ENDPOINT, {
      method: "POST",
      redirect: "follow",
      headers: getCevBrowserHeaders({
        fetchSite: "same-origin",
        cookie: cookies,
        referer: `${CEV_BASE}/Integration/VOW/Overview`,
        contentType: "application/x-www-form-urlencoded",
        xRequestedWith: true,
      }),
      body,
      signal: AbortSignal.timeout(30_000),
    }, "[CEV-CANCEL]");

    let json: { succeeded?: boolean; message?: string } = {};
    const rawBody = await res.text();

    try {
      json = JSON.parse(rawBody) as typeof json;
    } catch {
      // Pas du JSON — probablement une erreur HTML
      botLog({
        applicationId: clientId,
        step: "cev_cancel_non_json_response",
        status: "warn",
        data: { httpStatus: res.status, rawBody: rawBody.slice(0, 500) },
      });
      return {
        emailSent: false,
        allAppointments,
        appointment: target,
        error: `NON_JSON_RESPONSE: ${rawBody.slice(0, 200)}`,
      };
    }

    const emailSent = json.succeeded === true;

    botLog({
      applicationId: clientId,
      step: "cev_cancel_request_sent",
      status: emailSent ? "ok" : "warn",
      data: {
        httpStatus: res.status,
        succeeded: json.succeeded,
        message: json.message,
        appointment: {
          token: target.uniqueToken.slice(0, 8) + "...",
          label: target.label,
          additionalData: target.additionalData,
        },
      },
    });

    if (emailSent) {
      console.log(`[CEV-CANCEL] ✅ Email d'annulation envoyé: ${json.message}`);
    } else {
      console.log(`[CEV-CANCEL] ❌ Échec de la demande: ${JSON.stringify(json)}`);
    }

    return {
      emailSent,
      message: json.message,
      appointment: target,
      allAppointments,
      error: emailSent ? undefined : `SERVER_RETURNED_FAILED: ${JSON.stringify(json)}`,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    botLog({ applicationId: clientId, step: "cev_cancel_error", status: "fail", data: { error: msg } });
    return { emailSent: false, allAppointments: [], error: msg };
  }
}
