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

import { randomUserAgent } from "./browser.js";
import { ProxyAgent } from "undici";

const BASE = "https://appointment.cloud.diplomatie.be";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";

// Proxy pour le polling API — évite que l'IP Railway soit flaggée
const IPROYAL_PROXY_URL = process.env.IPROYAL_PROXY_URL;
let _pollProxyAgent: ProxyAgent | undefined;
if (IPROYAL_PROXY_URL) {
  _pollProxyAgent = new ProxyAgent(IPROYAL_PROXY_URL);
}

function cevFetch(url: string, options: RequestInit): Promise<Response> {
  if (_pollProxyAgent) {
    // @ts-expect-error — dispatcher est une option undici
    return fetch(url, { ...options, dispatcher: _pollProxyAgent });
  }
  return fetch(url, options);
}

export type CevPollResult =
  | { status: "no_slot" }
  | { status: "slot_found"; bodyPreview: string }
  | { status: "session_expired" }
  | { status: "error"; error: string };

// UA généré une fois par appel à pollCevSlot — reste stable dans la même session HTTP
// mais tourne entre sessions pour éviter les fingerprints répétitifs (desktop uniquement).
function fetchManual(url: string, cookie: string, userAgent: string): Promise<Response> {
  return cevFetch(url, {
    method: "GET",
    headers: {
      Cookie: `ASP.NET_SessionId=${cookie}; PreferredCulture=en-US`,
      "User-Agent": userAgent,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

function isVowintEAppointmentUrl(url: string): boolean {
  return /^https:\/\/visaonweb\.diplomatie\.be\/Common\/GetEAppointmentUrl\?/i.test(url);
}

async function resolveEntryUrl(entryUrl: string, cookie: string, ua: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  // Déjà une URL CEV directe: /Integration/VOW/... => pas besoin de résolution.
  if (entryUrl.startsWith(`${BASE}/Integration/VOW/`)) {
    return { ok: true, url: entryUrl };
  }

  // Option B: accepter un lien VOWINT /Common/GetEAppointmentUrl?id=...
  // et tenter de récupérer la redirection CEV en lisant l'en-tête Location.
  if (isVowintEAppointmentUrl(entryUrl)) {
    try {
      const r = await fetch(entryUrl, {
        method: "GET",
        headers: {
          Cookie: `ASP.NET_SessionId=${cookie}; PreferredCulture=en-US`,
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          Referer: `${VOWINT_BASE}/`,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
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
async function pollViaApi(sessionCookie: string, ua: string): Promise<CevPollResult | null> {
  const now = new Date();
  // Vérifier mois courant + mois suivant (comme pollCevSlotsMultiMonth)
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const body = { month: d.getMonth() + 1, year: d.getFullYear() };

    try {
      const res = await cevFetch(`${BASE}/Home/AvailableTimeSlots`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cookie": sessionCookie,
          "User-Agent": ua,
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
          "Referer": `${BASE}/Integration/VOW/SelectSlot`,
          "Origin": BASE,
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });

      // 403/401 = session expirée (captcha non résolu ou cookie mort)
      if (res.status === 403 || res.status === 401) {
        return { status: "session_expired" };
      }

      // 302 redirect = session expirée ou NoAvailability
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        if (loc.includes("SessionExpired") || loc.includes("Captcha")) {
          return { status: "session_expired" };
        }
        // Autre redirect — fallback vers stratégie 2
        return null;
      }

      if (!res.ok) {
        // Erreur serveur inattendue — fallback
        return null;
      }

      // Réponse JSON — parser les slots
      const raw = await res.json() as unknown;

      // Réponse vide ou tableau vide = pas de créneaux ce mois
      if (raw === null || (Array.isArray(raw) && raw.length === 0)) {
        continue; // essayer le mois suivant
      }

      // Si c'est un tableau non-vide ou un objet avec des données → slots trouvés !
      if (Array.isArray(raw) && raw.length > 0) {
        const preview = JSON.stringify(raw).slice(0, 2000);
        return { status: "slot_found", bodyPreview: preview };
      }

      // Objet avec des clés → probablement des slots
      if (typeof raw === "object" && raw !== null && Object.keys(raw as object).length > 0) {
        const preview = JSON.stringify(raw).slice(0, 2000);
        return { status: "slot_found", bodyPreview: preview };
      }

    } catch (err) {
      // Erreur réseau/timeout — fallback vers stratégie 2
      return null;
    }
  }

  // Les deux mois sont vides → pas de créneaux
  return { status: "no_slot" };
}

export async function pollCevSlot(
  integrationUrl: string,
  sessionCookie: string,
): Promise<CevPollResult> {
  try {
    const ua = randomUserAgent();

    // ── Stratégie 1 : POST /Home/AvailableTimeSlots (API JSON directe) ──────
    // Plus fiable que le GET redirect — retourne les slots en JSON
    // Fonctionne tant que le cookie est valide (pas besoin de l'integrationUrl)
    const apiResult = await pollViaApi(sessionCookie, ua);
    if (apiResult !== null) return apiResult;

    // ── Stratégie 2 (fallback) : GET integrationUrl → suivre redirections ───
    const resolved = await resolveEntryUrl(integrationUrl, sessionCookie, ua);
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
          // 3. 200 sans marqueur ni erreur connue → on ne risque PAS un faux positif
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
      // Pas de marqueur — pas de faux positif
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
