/**
 * CEV HTTP Cancel — Annulation de rendez-vous depuis la page Overview
 *
 * CONTEXTE :
 *   Quand un dossier atteint sa limite (overviewState: 'limit_reached'),
 *   la page /Integration/VOW/Overview n'affiche qu'un bouton "Annuler".
 *   Ce module extrait ce lien et suit le flow d'annulation :
 *     1. GET lien "Annuler" → confirmation ou page directe
 *     2. Si formulaire ASP.NET MVC avec CSRF token → POST pour confirmer
 *     3. Logger le résultat via botLog
 *
 * ACTIVATION :
 *   hunterConfig.cevAutoCancelOnLimitReached = true
 */

import { cevImpitFetch, getCevBrowserHeaders } from './cev-shared-impit.js';
import { botLog } from './convexClient.js';

const CEV_BASE = "https://appointment.cloud.diplomatie.be";

export interface CancelResult {
  success: boolean;
  /** URL finale atteinte après annulation */
  cancelFinalUrl?: string;
  error?: string;
}

/**
 * Extrait le href du lien "Annuler" / "Annuler le rendez-vous" depuis la page Overview CEV.
 *
 * Patterns couverts :
 *   <a href="...">Annuler</a>
 *   <a href="...">Annuler le rendez-vous</a>
 *   <a href="...">Cancel</a>
 *   <a href="...">Annuleren</a>
 *   href="..." suivi du texte dans les 300 chars
 *   Variantes avec bouton wrappé (button/span à l'intérieur du lien)
 *   Tout lien dont le href contient /VOW/Cancel ou /VOW/Delete
 */
export function extractCancelLink(html: string): string | null {
  const patterns: RegExp[] = [
    // <a href="...">Annuler ...
    /<a[^>]+href="([^"]+)"[^>]*>\s*(?:Annuler|Cancel|Annuleren)(?:\s+le\s+rendez-vous|(?:\s+l['']appointment)?)?/i,
    // href suivi de texte Annuler dans les 300 chars
    /href="([^"]+)"[^>]*>[\s\S]{0,300}(?:Annuler\s+le\s+rendez-vous|Annuler(?!\s+(?:une|un|ce)\s+(?:autre|nouveau)))/i,
    // Texte Annuler avant un href dans les 200 chars (ordre inversé dans le DOM)
    /(?:Annuler|Cancel)[\s\S]{0,200}href="([^"]+)"/i,
    // Fallback : n'importe quel href contenant Cancel/Delete/Annul dans le chemin VOW
    /href="([^"]*\/(?:VOW\/Cancel|VOW\/Delete|VOW\/Annul|CancelAppointment|DeleteAppointment)[^"]*)"/i,
  ];

  for (const p of patterns) {
    const m = html.match(p);
    if (m?.[1] && (m[1].startsWith('/') || m[1].startsWith('http'))) {
      return m[1];
    }
  }
  return null;
}

/**
 * Annule un rendez-vous CEV depuis le HTML de la page Overview.
 *
 * @param overviewHtml  - HTML brut de la page /Integration/VOW/Overview
 * @param overviewUrl   - URL finale de la page Overview (utilisée comme Referer)
 * @param cookies       - Cookie string de la session CEV courante
 * @param clientId      - applicationId Convex pour les botLogs
 */
export async function cancelCevAppointment(
  overviewHtml: string,
  overviewUrl: string,
  cookies: string,
  clientId: string,
): Promise<CancelResult> {
  const cancelHref = extractCancelLink(overviewHtml);
  if (!cancelHref) {
    console.log("[CEV-CANCEL] ❌ Aucun lien Annuler trouvé dans le HTML Overview");
    botLog({
      applicationId: clientId,
      step: "cev_cancel_no_link",
      status: "fail",
      data: {
        overviewUrl,
        htmlLen: overviewHtml.length,
        htmlPreview: overviewHtml.slice(0, 800),
      },
    });
    return { success: false, error: "NO_CANCEL_LINK" };
  }

  const cancelUrl = cancelHref.startsWith("http") ? cancelHref : `${CEV_BASE}${cancelHref}`;
  console.log(`[CEV-CANCEL] 🔗 Lien Annuler extrait: ${cancelUrl}`);

  botLog({
    applicationId: clientId,
    step: "cev_cancel_start",
    status: "ok",
    data: { cancelUrl, overviewUrl },
  });

  // ── Étape 1 : GET la page d'annulation ────────────────────────────────────
  // Peut être : confirmation directe, formulaire de confirmation, ou page intermédiaire
  let cancelPageHtml = "";
  let cancelPageUrl = cancelUrl;
  let currentCookies = cookies;

  try {
    for (let hop = 0; hop < 8; hop++) {
      const res = await cevImpitFetch(cancelPageUrl, {
        method: "GET",
        redirect: "manual",
        headers: getCevBrowserHeaders({
          fetchSite: "same-origin",
          cookie: currentCookies,
          referer: hop === 0 ? overviewUrl : cancelPageUrl,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      // Accumuler les Set-Cookie de chaque hop
      const setCookies = res.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) {
        const pair = sc.split(";")[0]?.trim();
        if (!pair) continue;
        const eqIdx = pair.indexOf("=");
        if (eqIdx <= 0) continue;
        const k = pair.slice(0, eqIdx).trim();
        const escapedK = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(^|;\\s*)${escapedK}=[^;]*`, "i");
        if (regex.test(currentCookies)) {
          currentCookies = currentCookies.replace(regex, `$1${pair}`);
        } else {
          currentCookies += `; ${pair}`;
        }
      }

      // Redirect → suivre
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        const nextUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
        console.log(`[CEV-CANCEL] ↪ Redirect hop ${hop + 1}: ${nextUrl.slice(0, 120)}`);
        cancelPageUrl = nextUrl;
        continue;
      }

      try { cancelPageHtml = await res.text(); } catch { /* ignore */ }

      // Vérifier confirmation directe via URL ou contenu
      const urlLower = cancelPageUrl.toLowerCase();
      const bodyLower = cancelPageHtml.toLowerCase();
      if (
        urlLower.includes("cancelled") ||
        urlLower.includes("deleted") ||
        urlLower.includes("annulé") ||
        bodyLower.includes("rendez-vous annulé") ||
        bodyLower.includes("appointment cancelled") ||
        bodyLower.includes("successfully cancelled") ||
        bodyLower.includes("has been cancelled") ||
        bodyLower.includes("afspraak geannuleerd")
      ) {
        console.log(`[CEV-CANCEL] ✅ Annulation confirmée directement (GET → ${cancelPageUrl.slice(0, 100)})`);
        botLog({
          applicationId: clientId,
          step: "cev_cancel_confirmed_get",
          status: "ok",
          data: { cancelFinalUrl: cancelPageUrl, httpStatus: res.status },
        });
        return { success: true, cancelFinalUrl: cancelPageUrl };
      }

      break; // On a la page — analyser si c'est un formulaire
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[CEV-CANCEL] ❌ Erreur GET: ${msg}`);
    botLog({
      applicationId: clientId,
      step: "cev_cancel_get_error",
      status: "fail",
      data: { error: msg, cancelUrl },
    });
    return { success: false, error: `GET_ERROR: ${msg}` };
  }

  // ── Étape 2 : si la page contient un formulaire de confirmation → POST ─────
  // ASP.NET MVC exige le __RequestVerificationToken CSRF en POST
  const csrfMatch =
    cancelPageHtml.match(/<input[^>]+name="__RequestVerificationToken"[^>]+value="([^"]+)"/i) ??
    cancelPageHtml.match(/<input[^>]+value="([^"]+)"[^>]+name="__RequestVerificationToken"/i);

  if (csrfMatch?.[1]) {
    const csrfToken = csrfMatch[1];
    console.log(`[CEV-CANCEL] 📋 Formulaire de confirmation détecté — POST CSRF token`);

    // Déterminer l'action du formulaire
    const formActionMatch = cancelPageHtml.match(/<form[^>]+action="([^"]+)"/i);
    const postUrl = formActionMatch?.[1]
      ? (formActionMatch[1].startsWith("http") ? formActionMatch[1] : `${CEV_BASE}${formActionMatch[1]}`)
      : cancelPageUrl;

    // Construire le corps du formulaire
    const formBody = new URLSearchParams();
    formBody.append("__RequestVerificationToken", csrfToken);

    // Capturer les autres champs hidden (ex: confirm=true, appointmentId=...)
    const hiddenFieldMatches = [
      ...cancelPageHtml.matchAll(/<input[^>]+type="hidden"[^>]+name="([^"]+)"[^>]+value="([^"]*)"/gi),
      ...cancelPageHtml.matchAll(/<input[^>]+value="([^"]*)"[^>]+type="hidden"[^>]+name="([^"]+)"/gi),
    ];
    for (const m of hiddenFieldMatches) {
      const [, nameOrVal, valOrName] = m;
      // Déterminer lequel est le nom et lequel la valeur selon le pattern
      const [fieldName, fieldValue] = m[0].toLowerCase().indexOf('name=') < m[0].toLowerCase().indexOf('value=')
        ? [nameOrVal, valOrName]
        : [valOrName, nameOrVal];
      if (fieldName && fieldName !== "__RequestVerificationToken") {
        formBody.append(fieldName, fieldValue ?? "");
      }
    }

    botLog({
      applicationId: clientId,
      step: "cev_cancel_post_attempt",
      status: "ok",
      data: { postUrl, csrfTokenLen: csrfToken.length, formFields: [...formBody.keys()] },
    });

    try {
      const postRes = await cevImpitFetch(postUrl, {
        method: "POST",
        redirect: "manual",
        headers: getCevBrowserHeaders({
          fetchSite: "same-origin",
          cookie: currentCookies,
          referer: cancelPageUrl,
          isFormPost: true,
          contentType: "application/x-www-form-urlencoded",
        }),
        body: formBody.toString(),
        signal: AbortSignal.timeout(30_000),
      });

      let postFinalUrl = postUrl;
      let postBody = "";

      if (postRes.status >= 300 && postRes.status < 400) {
        const loc = postRes.headers.get("location") ?? "";
        postFinalUrl = loc.startsWith("http") ? loc : (loc ? `${CEV_BASE}${loc}` : postUrl);
      } else {
        try { postBody = await postRes.text(); } catch { /* ignore */ }
        postFinalUrl = postUrl;
      }

      const postUrlLower = postFinalUrl.toLowerCase();
      const postBodyLower = postBody.toLowerCase();

      // Vérification de succès
      const isSuccess =
        postUrlLower.includes("cancelled") ||
        postUrlLower.includes("deleted") ||
        postUrlLower.includes("annulé") ||
        postBodyLower.includes("rendez-vous annulé") ||
        postBodyLower.includes("appointment cancelled") ||
        postBodyLower.includes("successfully cancelled") ||
        postBodyLower.includes("has been cancelled") ||
        // HTTP 302 après POST = pattern classique PRG (Post/Redirect/Get) → annulation réussie
        (postRes.status >= 300 && postRes.status < 400) ||
        // HTTP 200 sans message d'erreur apparent
        (postRes.status === 200 && !postBodyLower.includes("error") && !postBodyLower.includes("erreur"));

      if (isSuccess) {
        console.log(`[CEV-CANCEL] ✅ Annulation confirmée via POST (HTTP ${postRes.status} → ${postFinalUrl.slice(0, 100)})`);
        botLog({
          applicationId: clientId,
          step: "cev_cancel_confirmed_post",
          status: "ok",
          data: { cancelFinalUrl: postFinalUrl, httpStatus: postRes.status },
        });
        return { success: true, cancelFinalUrl: postFinalUrl };
      }

      console.log(`[CEV-CANCEL] ⚠️ POST réponse inattendue: HTTP ${postRes.status} → ${postFinalUrl.slice(0, 100)}`);
      botLog({
        applicationId: clientId,
        step: "cev_cancel_post_unexpected",
        status: "warn",
        data: {
          postFinalUrl,
          httpStatus: postRes.status,
          bodyPreview: postBody.slice(0, 500),
        },
      });
      return { success: false, error: `UNEXPECTED_POST_RESPONSE: ${postRes.status}` };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[CEV-CANCEL] ❌ Erreur POST: ${msg}`);
      botLog({
        applicationId: clientId,
        step: "cev_cancel_post_error",
        status: "fail",
        data: { error: msg, postUrl },
      });
      return { success: false, error: `POST_ERROR: ${msg}` };
    }
  }

  // ── Étape 3 : Pas de CSRF — GET a quand même peut-être annulé ─────────────
  // Certains portails annulent directement via GET sans confirmation
  if (cancelPageHtml.length > 200) {
    console.log(`[CEV-CANCEL] ✅ Aucun formulaire CSRF — annulation via GET présumée (${cancelPageHtml.length}B)`);
    botLog({
      applicationId: clientId,
      step: "cev_cancel_get_presumed",
      status: "ok",
      data: {
        cancelFinalUrl: cancelPageUrl,
        htmlLen: cancelPageHtml.length,
        htmlPreview: cancelPageHtml.slice(0, 600),
      },
    });
    return { success: true, cancelFinalUrl: cancelPageUrl };
  }

  // Aucune réponse exploitable
  console.log("[CEV-CANCEL] ❌ Annulation échouée — aucune réponse exploitable");
  botLog({
    applicationId: clientId,
    step: "cev_cancel_failed",
    status: "fail",
    data: {
      cancelUrl,
      cancelFinalUrl: cancelPageUrl,
      htmlLen: cancelPageHtml.length,
    },
  });
  return { success: false, error: "NO_RESPONSE" };
}
