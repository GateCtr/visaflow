// CEV Polling — deux stratégies :
//
// Stratégie 1 (PRIORITAIRE) : POST /Home/AvailableTimeSlots (API JSON)
//   - Vérifie directement les créneaux disponibles
//   - Fonctionne tant que le cookie ASP.NET_SessionId est valide (validUntil)
//   - Coût : ~50ms, zéro clic VOWINT, illimité pendant la durée de la session
//   - Retourne les slots en JSON ou 403 si session expirée
//
// Stratégie 2 (FALLBACK) : GET integrationUrl → suivre les redirections
//   - Utilisée si l'API retourne une erreur inattendue
//   - Détecte NoAvailability, SessionExpired, ou page calendrier
//
// Coût total : ~50ms par check, zéro captcha, zéro Playwright.

import { cevImpitFetch, setCevExternalUserAgent, getCevExternalUserAgent, getCevBrowserHeaders, getCevSessionUa } from "./cev-shared-impit.js";
import { F5CookieManager } from "./cev-f5-cookie-manager.js";

const BASE = "https://appointment.cloud.diplomatie.be";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";

/** Fetch CEV avec fingerprint TLS Chrome via impit partagé (setup + polling = même instance) */
function cevFetch(url: string, options: RequestInit): Promise<Response> {
  return cevImpitFetch(url, options, "[CEV-POLL]");
}

interface SiphonedCookies {
  f5CookieValue?: string;
  f5CookieName?: string;
  aspNetSessionId?: string;
  userAgent?: string;
  validUntil?: number;
  preferredCulture?: string;
}

/** Construit le cookie header enrichi avec le F5 si disponible (siphonné > manager) */
function buildEnrichedCookieHeader(
  sessionCookie: string,
  siphoned?: SiphonedCookies
): string {
  // Use siphoned ASP.NET Session ID if available and valid
  const aspNetCookie = siphoned?.aspNetSessionId || sessionCookie;
  // FIX Faille #2 : fr-BE cohérent avec Accept-Language: fr-BE et l'URL /fr-BE (siphoned garde sa valeur)
  const culture = siphoned?.preferredCulture ?? "fr-BE";
  const baseCookie = aspNetCookie.includes("ASP.NET_SessionId")
    ? aspNetCookie
    : `ASP.NET_SessionId=${aspNetCookie}; PreferredCulture=${culture}`;

  // Check if siphoned F5 cookie is available and valid
  if (siphoned?.f5CookieValue && siphoned?.f5CookieName) {
    if (!siphoned.validUntil || Date.now() < siphoned.validUntil) {
      return `${siphoned.f5CookieName}=${siphoned.f5CookieValue}; ${baseCookie}`;
    }
  }

  // Fallback to F5 manager
  const f5Manager = F5CookieManager.getInstance();
  const f5Session = f5Manager.getValidSession();
  if (f5Session) {
    return `${f5Session.tsCookie.name}=${f5Session.tsCookie.value}; ${baseCookie}`;
  }

  return baseCookie;
}

/** Retourne le UA effectif (siphonné > external > random) */
function getEffectiveUa(siphoned?: SiphonedCookies): string {
  return siphoned?.userAgent ?? getCevExternalUserAgent() ?? getCevSessionUa();
}

export type CevPollResult =
  | { status: "no_slot" }
  | { status: "slot_found"; bodyPreview: string }
  | { status: "session_expired" }
  | { status: "error"; error: string };

// UA généré une fois par appel à pollCevSlot — reste stable dans la même session HTTP
// mais tourne entre sessions pour éviter les fingerprints répétitifs (desktop uniquement).
function fetchManual(
  url: string,
  cookie: string,
  userAgent: string,
  siphoned?: SiphonedCookies
): Promise<Response> {
  const cookieHeader = buildEnrichedCookieHeader(cookie, siphoned);
  // FIX polling-A/B/C : utiliser getCevBrowserHeaders (mode document navigate) pour
  // aligner sec-ch-ua*, Accept Chrome complet, absence Cache-Control/Pragma — confirmés
  // par capture réelle 05_integration.json (NoAvailability GET, Chrome 148).
  return cevFetch(url, {
    method: "GET",
    headers: getCevBrowserHeaders({
      fetchSite: "same-origin",
      cookie: cookieHeader,
      userAgent,
    }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

function isVowintEAppointmentUrl(url: string): boolean {
  return /^https:\/\/visaonweb\.diplomatie\.be\/Common\/GetEAppointmentUrl\?/i.test(url);
}

async function resolveEntryUrl(entryUrl: string, cookie: string, ua: string, siphoned?: SiphonedCookies): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  // Déjà une URL CEV directe: /Integration/VOW/... => pas besoin de résolution.
  if (entryUrl.startsWith(`${BASE}/Integration/VOW/`)) {
    return { ok: true, url: entryUrl };
  }

  // Option B: accepter un lien VOWINT /Common/GetEAppointmentUrl?id=...
  // et tenter de récupérer la redirection CEV en lisant l'en-tête Location.
  if (isVowintEAppointmentUrl(entryUrl)) {
    try {
      const cookieHeader = buildEnrichedCookieHeader(cookie, siphoned);
      // FIX polling-F : getCevBrowserHeaders pour aligner sec-ch-ua*, Accept Chrome complet.
      // Referer = VOWINT_BASE/ (même domaine diplomatie.be = same-origin depuis VOWINT).
      const r = await cevFetch(entryUrl, {
        method: "GET",
        headers: getCevBrowserHeaders({
          fetchSite: "same-origin",
          referer: `${VOWINT_BASE}/`,
          cookie: cookieHeader,
          userAgent: ua,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });

      const loc = r.headers.get("location");
      if (loc && /appointment\.cloud\.diplomatie\.be\/Integration\/VOW\//i.test(loc)) {
        const resolved = loc.startsWith("http") ? loc : `${BASE}${loc}`;
        return { ok: true, url: resolved };
      }

      return {
        ok: false,
        error:
          "GetEAppointmentUrl non résolu vers Integration/VOW (session VOWINT probablement requise).",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Échec résolution GetEAppointmentUrl: ${msg}` };
    }
  }

  return {
    ok: false,
    error:
      "URL d'entrée invalide. Attendu: https://appointment.cloud.diplomatie.be/Integration/VOW/... ou https://visaonweb.diplomatie.be/Common/GetEAppointmentUrl?...",
  };
}

function classifyLocation(loc: string | null): "slot" | "no_slot" | "expired" | "captcha" | "login" | "unknown" {
  if (!loc) return "unknown";
  const lower = loc.toLowerCase();
  if (lower.includes("/integration/error/noavailability")) return "no_slot";
  if (lower.includes("/integration/error/sessionexpired")) return "expired";
  if (lower.includes("/captcha")) return "captcha";
  if (lower.includes("/integration/vow/selectslot")) return "slot"; // intermédiaire
  if (lower.includes("/account/login") || lower.includes("/integration/error/")) return "login";
  return "unknown";
}

// Marqueurs DOM positifs prouvant qu'on est sur une page calendrier de slots
// (et pas une page erreur 200). On exige AU MOINS UN match avant de déclarer slot_found.
//
// Confirmé par analyse du bundle JS (appointment.cloud.diplomatie.be, v1.0.249.0) :
//  - CEV est ASP.NET MVC + jQuery + Bootstrap — PAS AngularJS
//  - La page SelectSlot charge le bundle partagé sharedScripts et appelle inline
//    getAvailableTimeSlotsForPublic() → POST /Home/AvailableTimeSlots (JSON)
//  - Les pages d'erreur ne contiennent JAMAIS ces marqueurs
const POSITIVE_SLOT_MARKERS = [
  "getavailabletimeslotsforpublic",  // appel inline JS depuis la page calendrier (bundle sharedScripts)
  "home/availabletimeslots",          // URL de l'endpoint slot dans le JS inline de la page
  "availabletimeslots",               // occurrence partielle de l'endpoint
  "integration/vow/",                 // chemin URL des pages slot (toujours /Integration/VOW/...)
  "selectslot",                       // ID de formulaire ou segment d'URL dans le HTML rendu
  "data-slot-time",                   // attribut data sur les éléments horaires
];

function bodyHasSlotMarkers(body: string): boolean {
  const lower = body.toLowerCase();
  return POSITIVE_SLOT_MARKERS.some(m => lower.includes(m));
}

function bodyIsErrorPage(body: string): boolean {
  const lower = body.toLowerCase();
  return (
    lower.includes("noavailability") ||
    lower.includes("sessionexpired") ||
    lower.includes("session expired") ||
    lower.includes("session has expired") ||
    lower.includes("hcaptcha") ||
    lower.includes("h-captcha")
  );
}

/**
 * Poll via POST /Home/AvailableTimeSlots — API JSON directe.
 * Retourne null si l'API n'est pas accessible (fallback vers GET redirect).
 * Retourne CevPollResult si on a une réponse claire.
 *
 * Bundle JS confirmé : callPost("/Home/AvailableTimeSlots", {month, year}, success, error)
 * Content-Type: application/json (pas form-urlencoded)
 */
async function pollViaApi(
  sessionCookie: string,
  ua: string,
  siphoned?: SiphonedCookies
): Promise<CevPollResult | null> {
  // sessionCookie = valeur brute ou format complet (legacy)
  const cookieHeader = buildEnrichedCookieHeader(sessionCookie, siphoned);
  const now = new Date();
  // Vérifier mois courant + mois suivant (comme pollCevSlotsMultiMonth)
  for (let i = 0; i < 2; i++) {
    // FIX Faille #3 : délai inter-mois 0.8–2s.
    // Un vrai utilisateur clique "mois suivant" dans le calendrier — pas deux POST en <10ms.
    // Sans ce délai, deux requêtes quasi-simultanées vers le même endpoint sont détectables.
    if (i > 0) {
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200)); // 0.8–2s
    }
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const body = { month: d.getMonth() + 1, year: d.getFullYear() };

    try {
      // FIX polling-D : getCevBrowserHeaders (mode XHR/AJAX) pour aligner
      // sec-ch-ua*, Sec-Fetch-Dest/Mode/Site, absence Cache-Control/Pragma.
      // Origin + Referer + X-Requested-With conservés (jQuery AJAX same-origin).
      const res = await cevFetch(`${BASE}/Home/AvailableTimeSlots`, {
        method: "POST",
        headers: getCevBrowserHeaders({
          fetchSite: "same-origin",
          origin: BASE,
          referer: `${BASE}/Integration/VOW/SelectSlot`,
          cookie: cookieHeader,
          userAgent: ua,
          contentType: "application/json",
          xRequestedWith: true,
          accept: "application/json, text/javascript, */*; q=0.01",
        }),
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });

      // 403/401 = session expirée (captcha non résolu ou cookie mort)
      if (res.status === 403 || res.status === 401) {
        return { status: "session_expired" };
      }

      // 302 redirect = session expirée ou NoAvailability
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        // LOG: capturer le redirect pour comprendre le comportement
        console.log(`[CEV-POLL-API] 🔀 Redirect ${res.status} → ${loc} (month=${body.month}/${body.year})`);
        if (loc.includes("SessionExpired") || loc.includes("Captcha")) {
          return { status: "session_expired" };
        }
        if (loc.includes("NoAvailability")) {
          // NoAvailability via redirect — pas de slots mais session peut être encore valide
          continue; // essayer le mois suivant avant de conclure
        }
        // Autre redirect inconnu — LOG complet pour discovery
        console.log(`[CEV-POLL-API] ⚠️  Redirect inconnu: ${loc}`);
        return null;
      }

      if (!res.ok) {
        // Erreur serveur inattendue — LOG le status et le body
        let errorBody = "";
        try { errorBody = await res.text(); } catch { /* ignore */ }
        console.log(`[CEV-POLL-API] ❌ HTTP ${res.status} — body: ${errorBody.slice(0, 500)}`);
        return null;
      }

      // Réponse OK — capturer le CONTENU BRUT pour discovery
      const rawText = await res.text();
      let raw: unknown;
      try {
        raw = JSON.parse(rawText);
      } catch {
        // Pas du JSON — LOG complet pour comprendre
        console.log(`[CEV-POLL-API] 🔍 Réponse non-JSON (month=${body.month}/${body.year}): ${rawText.slice(0, 2000)}`);
        // Si c'est du HTML (page d'erreur renvoyée en 200)
        if (rawText.toLowerCase().includes("noavailability") || rawText.toLowerCase().includes("session")) {
          return { status: "session_expired" };
        }
        return null;
      }

      // LOG: toujours logger la réponse brute pour reverse-engineering
      const rawType = Array.isArray(raw) ? "array" : (raw === null ? "null" : typeof raw);
      const rawPreview = rawText.slice(0, 2000);
      console.log(`[CEV-POLL-API] 📊 Réponse (month=${body.month}/${body.year}): type=${rawType} len=${rawText.length} preview=${rawPreview.slice(0, 200)}`);

      // Réponse vide ou tableau vide = pas de créneaux ce mois
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
        continue; // essayer le mois suivant
      }

      // Si c'est un tableau non-vide ou un objet avec des données → slots trouvés !
      if (Array.isArray(raw) && raw.length > 0) {
        console.log(`[CEV-POLL-API] 🚨 SLOTS TROUVÉS! (month=${body.month}/${body.year}) count=${raw.length} raw=${rawPreview}`);
        return { status: "slot_found", bodyPreview: rawPreview };
      }

      if (typeof raw === "object" && raw !== null && Object.keys(raw as object).length > 0) {
        const preview = JSON.stringify(raw).slice(0, 2000);
        console.log(`[CEV-POLL-API] 🚨 SLOTS (objet)! (month=${body.month}/${body.year}) keys=${Object.keys(raw as object).join(",")} raw=${preview}`);
        return { status: "slot_found", bodyPreview: preview };
      }

    } catch (err) {
      // Erreur réseau/timeout — LOG et fallback vers stratégie 2
      console.log(`[CEV-POLL-API] ⚡ Erreur réseau (month=${body.month}/${body.year}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // Les deux mois sont vides → pas de créneaux
  return { status: "no_slot" };
}

export async function pollCevSlot(
  integrationUrl: string,
  sessionCookie: string,
  siphoned?: SiphonedCookies,
): Promise<CevPollResult> {
  try {
    if (siphoned?.userAgent) {
      setCevExternalUserAgent(siphoned.userAgent);
    }
    const ua = getEffectiveUa(siphoned);

    // ─── Stratégie 1 : POST /Home/AvailableTimeSlots (API JSON directe) ──────
    // Plus fiable que le GET redirect — retourne les slots en JSON
    // Fonctionne tant que le cookie est valide (pas besoin de l'integrationUrl)
    const apiResult = await pollViaApi(sessionCookie, ua, siphoned);
    if (apiResult !== null) return apiResult;

    // ── Stratégie 2 (fallback) : GET integrationUrl → suivre redirections ───
    // Si l'integrationUrl est absente ou invalide, ne pas tenter le fallback —
    // retourner session_expired pour déclencher un re-setup propre (avec lock 3 min).
    if (!integrationUrl || integrationUrl === "pending" || integrationUrl === "non_capturee") {
      console.log(`[CEV-POLL] ⚠️  API retourna null ET integrationUrl invalide (${integrationUrl ?? 'undefined'}) — session_expired`);
      return { status: "session_expired" };
    }

    const resolved = await resolveEntryUrl(integrationUrl, sessionCookie, ua, siphoned);
    if (!resolved.ok) {
      return { status: "error", error: resolved.error };
    }

    const entryUrl = resolved.url;

    // Étape 1 : URL d'entrée
    const r1 = await fetchManual(entryUrl, sessionCookie, ua);

    if (r1.status === 302) {
      const loc1 = r1.headers.get("location");
      const kind1 = classifyLocation(loc1);

      if (kind1 === "expired" || kind1 === "captcha" || kind1 === "login") {
        return { status: "session_expired" };
      }
      if (kind1 === "no_slot") return { status: "no_slot" };

      // Si redirige vers SelectSlot, on suit
      if (kind1 === "slot" && loc1) {
        const next = loc1.startsWith("http") ? loc1 : `${BASE}${loc1}`;
        const r2 = await fetchManual(next, sessionCookie, ua);

        if (r2.status === 302) {
          const kind2 = classifyLocation(r2.headers.get("location"));
          if (kind2 === "no_slot") return { status: "no_slot" };
          if (kind2 === "expired" || kind2 === "captcha" || kind2 === "login") {
            return { status: "session_expired" };
          }
          return { status: "error", error: `SelectSlot redirect inconnu: ${r2.headers.get("location")}` };
        }

        if (r2.status === 200) {
          const body = await r2.text();
          // 1. Page erreur déguisée en 200 → expired/no_slot selon contenu
          if (bodyIsErrorPage(body)) {
            const lower = body.toLowerCase();
            if (lower.includes("sessionexpired") || lower.includes("session expired") || lower.includes("hcaptcha")) {
              return { status: "session_expired" };
            }
            return { status: "no_slot" };
          }
          // 2. Marqueur DOM positif requis pour confirmer slot_found
          if (bodyHasSlotMarkers(body)) {
            return { status: "slot_found", bodyPreview: body.slice(0, 2000) };
          }
          // 3. 200 sans marqueur ni erreur connue → LOG complet pour discovery
          console.log(`[CEV-POLL-FALLBACK] 🔍 Page 200 inconnue (url=${r2.url ?? next}):`);
          console.log(`[CEV-POLL-FALLBACK]   bodyLen=${body.length}`);
          console.log(`[CEV-POLL-FALLBACK]   htmlPreview=${body.slice(0, 3000)}`);
          return {
            status: "error",
            error: "Page 200 sans marqueur de créneau ni erreur connue (à investiguer)",
          };
        }

        return {
          status: "error",
          error: `Réponse inattendue à SelectSlot: ${r2.status}`,
        };
      }

      return {
        status: "error",
        error: `Redirection non reconnue: ${loc1}`,
      };
    }

    if (r1.status === 200) {
      // Page directe — peut être captcha (session pas validée) ou slot calendrier
      const body = await r1.text();
      if (bodyIsErrorPage(body)) {
        return { status: "session_expired" };
      }
      if (bodyHasSlotMarkers(body)) {
        return { status: "slot_found", bodyPreview: body.slice(0, 2000) };
      }
      // Pas de marqueur — LOG complet pour discovery
      console.log(`[CEV-POLL-FALLBACK] 🔍 Page 200 directe inconnue (url=${entryUrl}):`);
      console.log(`[CEV-POLL-FALLBACK]   bodyLen=${body.length}`);
      console.log(`[CEV-POLL-FALLBACK]   htmlPreview=${body.slice(0, 3000)}`);
      return {
        status: "error",
        error: "Page 200 directe sans marqueur (captcha probable, session à rafraîchir)",
      };
    }

    return {
      status: "error",
      error: `HTTP ${r1.status} inattendu`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: msg };
  }
}


/**
 * Capture le contenu de SelectSlot sans suivre la redirection automatique.
 * Utilise redirect: 'manual' pour capturer la réponse 302 et son éventuel body.
 */
export async function captureSelectSlotWithoutRedirect(
  integrationUrl: string,
  sessionCookie: string,
): Promise<{
  status: number;
  statusText: string;
  redirectLocation: string | null;
  body: string | null;
  headers: Record<string, string>;
  error?: string;
}> {
  try {
    const ua = getCevSessionUa();
    const cookieHeader = sessionCookie.includes("ASP.NET_SessionId")
      ? sessionCookie
      : `ASP.NET_SessionId=${sessionCookie}; PreferredCulture=en-US`;

    // Résoudre l'URL d'entrée si nécessaire
    const resolved = await resolveEntryUrl(integrationUrl, sessionCookie, ua);
    if (!resolved.ok) {
      return {
        status: 0,
        statusText: 'URL_RESOLUTION_FAILED',
        redirectLocation: null,
        body: null,
        headers: {},
        error: resolved.error,
      };
    }

    const entryUrl = resolved.url;
    
    // Faire la requête avec redirect: 'manual' pour capturer la 302
    // FIX polling-E : getCevBrowserHeaders (mode navigate) — aligne sec-ch-ua*,
    // Accept Chrome complet, supprime Cache-Control/Pragma parasites.
    const response = await cevFetch(entryUrl, {
      method: "GET",
      headers: getCevBrowserHeaders({
        fetchSite: "same-origin",
        cookie: cookieHeader,
        userAgent: ua,
      }),
      redirect: "manual", // IMPORTANT: ne pas suivre automatiquement
      signal: AbortSignal.timeout(30_000),
    });

    // Capturer tous les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Capturer le body même pour les 302
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      // Certaines réponses 302 n'ont pas de body lisible
    }

    const redirectLocation = response.headers.get("location");

    return {
      status: response.status,
      statusText: response.statusText,
      redirectLocation,
      body,
      headers,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 0,
      statusText: 'FETCH_ERROR',
      redirectLocation: null,
      body: null,
      headers: {},
      error: msg,
    };
  }
}

/**
 * Analyse détaillée d'une réponse SelectSlot pour comprendre pourquoi
 * la redirection se produit et ce qu'il y a dans le body.
 */
export async function analyzeSelectSlotRedirect(
  integrationUrl: string,
  sessionCookie: string,
): Promise<{
  capture: ReturnType<typeof captureSelectSlotWithoutRedirect> extends Promise<infer T> ? T : never;
  analysis: {
    isRedirect: boolean;
    redirectTarget: string | null;
    hasBody: boolean;
    bodyLength: number;
    bodyContainsSelectSlot: boolean;
    bodyContainsNoAvailability: boolean;
    bodyContainsHcaptcha: boolean;
    bodyContainsSessionExpired: boolean;
    markersFound: string[];
    suggestedAction: 'follow_redirect' | 'inspect_body' | 'session_expired' | 'error';
  };
}> {
  const capture = await captureSelectSlotWithoutRedirect(integrationUrl, sessionCookie);
  
  const analysis = {
    isRedirect: capture.status >= 300 && capture.status < 400,
    redirectTarget: capture.redirectLocation,
    hasBody: !!capture.body && capture.body.length > 0,
    bodyLength: capture.body?.length || 0,
    bodyContainsSelectSlot: false,
    bodyContainsNoAvailability: false,
    bodyContainsHcaptcha: false,
    bodyContainsSessionExpired: false,
    markersFound: [] as string[],
    suggestedAction: 'error' as 'follow_redirect' | 'inspect_body' | 'session_expired' | 'error',
  };

  if (capture.body) {
    const lowerBody = capture.body.toLowerCase();
    
    analysis.bodyContainsSelectSlot = lowerBody.includes('selectslot');
    analysis.bodyContainsNoAvailability = lowerBody.includes('noavailability');
    analysis.bodyContainsHcaptcha = lowerBody.includes('hcaptcha');
    analysis.bodyContainsSessionExpired = lowerBody.includes('sessionexpired') || lowerBody.includes('session expired');
    
    // Chercher des marqueurs CEV
    const markers = [
      'getavailabletimeslotsforpublic',
      'home/availabletimeslots',
      'data-slot-time',
      'integration/vow/',
      'bootstrap-datetimepicker',
      'sharedscripts',
      'availabletimeslots',
      'selectslot',
      'noavailability',
      'sessionexpired',
      'hcaptcha',
    ];
    
    markers.forEach(marker => {
      if (lowerBody.includes(marker)) {
        analysis.markersFound.push(marker);
      }
    });
  }

  // Déterminer l'action suggérée
  if (capture.error) {
    analysis.suggestedAction = 'error';
  } else if (analysis.bodyContainsSessionExpired) {
    analysis.suggestedAction = 'session_expired';
  } else if (analysis.isRedirect && analysis.redirectTarget) {
    if (analysis.hasBody && analysis.bodyContainsSelectSlot) {
      analysis.suggestedAction = 'inspect_body'; // Body intéressant à inspecter
    } else {
      analysis.suggestedAction = 'follow_redirect'; // Redirection normale
    }
  } else if (analysis.hasBody) {
    analysis.suggestedAction = 'inspect_body';
  }

  return { capture, analysis };
}