// CEV Polling — vérifie un endpoint /Integration/VOW/.../en-US avec un cookie
// session déjà validé (captcha résolu manuellement par l'admin).
//
// Stratégie :
//   1. GET URL d'entrée → 302 vers /Integration/VOW/SelectSlot (si session valide)
//                       → 302 vers /Captcha (si pas validée)
//                       → 302 vers login (si cookie mort)
//   2. GET /Integration/VOW/SelectSlot → 302 NoAvailability   = no_slot
//                                       → 200 OK              = slot_found
//                                       → 302 SessionExpired  = session_expired
//
// Coût : ~50ms par check, zéro captcha, zéro Playwright.

const BASE = "https://appointment.cloud.diplomatie.be";
const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

export type CevPollResult =
  | { status: "no_slot" }
  | { status: "slot_found"; bodyPreview: string }
  | { status: "session_expired" }
  | { status: "error"; error: string };

function fetchManual(url: string, cookie: string): Promise<Response> {
  return fetch(url, {
    method: "GET",
    headers: {
      Cookie: `ASP.NET_SessionId=${cookie}; PreferredCulture=en-US`,
      "User-Agent": USER_AGENT,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Upgrade-Insecure-Requests": "1",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
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
const POSITIVE_SLOT_MARKERS = [
  "selectslot",         // form ou bloc de sélection de créneau
  "available-slot",      // class CSS spécifique
  "datepicker",          // calendrier interactif
  "appointment-slot",    // wording slot
  "ng-controller=\"slotctrl",  // AngularJS controller (CEV utilise AngularJS)
  "data-slot-time",      // attribut data
  "id=\"slotform\"",     // form id classique
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

export async function pollCevSlot(
  integrationUrl: string,
  sessionCookie: string,
): Promise<CevPollResult> {
  try {
    // Étape 1 : URL d'entrée
    const r1 = await fetchManual(integrationUrl, sessionCookie);

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
        const r2 = await fetchManual(next, sessionCookie);

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
