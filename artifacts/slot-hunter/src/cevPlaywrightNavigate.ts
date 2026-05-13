/**
 * cevPlaywrightNavigate.ts — Navigation Playwright vers redirectUrl CEV
 *
 * Stratégie hybride :
 *   - Le cookie ASP.NET_SessionId est déjà obtenu via HTTP (cevHttpSetup.ts)
 *   - Le captcha est déjà résolu (pas de re-captcha)
 *   - On lance Playwright UNIQUEMENT pour naviguer vers redirectUrl
 *   - On intercepte les requêtes réseau pour capturer /Home/AvailableTimeSlots
 *   - Si la page calendrier apparaît → slots disponibles → booking
 *   - Si NoAvailability → pas de slots, session consommée
 *
 * Coût : 0 clic VOWINT, 0 captcha, juste ~5-10s de browser headless
 */

import { launchBrowser } from "./browser.js";
import { botLog } from "./convexClient.js";
import { bookCevViaHttp } from "./cevHttpBooking.js";

const CEV_BASE = "https://appointment.cloud.diplomatie.be";

export interface CevNavigationResult {
  status: "slot_found" | "no_availability" | "error";
  /** JSON brut de /Home/AvailableTimeSlots si intercepté */
  slotsJson?: string;
  /** URL finale après navigation */
  finalUrl?: string;
  /** HTML de la page finale (premiers 8000 chars) */
  pageHtml?: string;
  /** Erreur si status=error */
  error?: string;
}

/**
 * Navigue vers la redirectUrl CEV avec Playwright en injectant le cookie existant.
 * Intercepte les appels réseau pour capturer /Home/AvailableTimeSlots.
 *
 * NE FAIT PAS :
 * - Login VOWINT (cookie déjà fourni)
 * - Résolution hCaptcha (déjà fait par cevHttpSetup)
 * - Clic bouton RDV (redirectUrl déjà obtenue)
 *
 * FAIT :
 * - Ouvre un browser stealth
 * - Injecte le cookie ASP.NET_SessionId
 * - Navigue vers redirectUrl
 * - Intercepte toutes les réponses réseau (surtout /Home/AvailableTimeSlots)
 * - Attend que la page se stabilise
 * - Retourne slot_found / no_availability / error
 */
export async function navigateCevRedirectWithPlaywright(
  sessionCookie: string,
  redirectUrl: string,
  clientId: string,
): Promise<CevNavigationResult> {
  const fullRedirectUrl = redirectUrl.startsWith("http")
    ? redirectUrl
    : `${CEV_BASE}${redirectUrl}`;

  botLog({
    applicationId: clientId,
    step: "cev_playwright_nav_start",
    status: "ok",
    data: { redirectUrl: fullRedirectUrl.slice(0, 100) },
  });

  const { browser, context, page } = await launchBrowser({
    locale: "fr-BE",
    timezoneId: "Africa/Kinshasa",
  });

  // Intercepter les réponses réseau
  const interceptedSlots: { url: string; status: number; body: string }[] = [];
  const allResponses: { url: string; status: number }[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    const status = response.status();
    allResponses.push({ url: url.slice(0, 120), status });

    // Capturer spécifiquement /Home/AvailableTimeSlots
    if (url.includes("/Home/AvailableTimeSlots")) {
      try {
        const body = await response.text();
        interceptedSlots.push({ url, status, body });
        console.log(`[CEV-NAV] 🎯 Intercepté /Home/AvailableTimeSlots — status=${status} bodyLen=${body.length}`);
      } catch {
        interceptedSlots.push({ url, status, body: "" });
      }
    }
  });

  try {
    // Injecter le cookie AVANT la navigation
    const cookieValue = sessionCookie.includes("=")
      ? sessionCookie.split("=").slice(1).join("=").split(";")[0]
      : sessionCookie;

    await context.addCookies([
      {
        name: "ASP.NET_SessionId",
        value: cookieValue,
        domain: "appointment.cloud.diplomatie.be",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "PreferredCulture",
        value: "en-US",
        domain: "appointment.cloud.diplomatie.be",
        path: "/",
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      },
    ]);

    // Naviguer vers la redirectUrl
    console.log(`[CEV-NAV] Navigation → ${fullRedirectUrl.slice(0, 80)}...`);
    await page.goto(fullRedirectUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Attendre que la page se stabilise (JS inline peut appeler getAvailableTimeSlotsForPublic)
    await page.waitForTimeout(5_000);

    // Vérifier l'URL finale
    const finalUrl = page.url();
    const pageTitle = await page.title().catch(() => "");
    const pageHtml = await page.content().catch(() => "");

    botLog({
      applicationId: clientId,
      step: "cev_playwright_nav_result",
      status: "ok",
      data: {
        finalUrl,
        pageTitle,
        interceptedSlotsCount: interceptedSlots.length,
        allResponsesCount: allResponses.length,
        pageHtmlPreview: pageHtml.slice(0, 3000),
        hasAvailableTimeSlots: pageHtml.toLowerCase().includes("availabletimeslots"),
        hasGetAvailableTimeSlotsForPublic: pageHtml.toLowerCase().includes("getavailabletimeslotsforpublic"),
        hasNoAvailability: finalUrl.includes("NoAvailability") || pageHtml.toLowerCase().includes("noavailability"),
        hasCalendar: pageHtml.toLowerCase().includes("calendar") || pageHtml.toLowerCase().includes("datepicker"),
        networkCapture: allResponses.slice(-20),
      },
    });

    // ── Analyser le résultat ────────────────────────────────────────────────

    // Cas 1 : NoAvailability
    if (finalUrl.includes("NoAvailability") || pageHtml.toLowerCase().includes("no free time slots")) {
      console.log("[CEV-NAV] → NoAvailability");
      return { status: "no_availability", finalUrl, pageHtml: pageHtml.slice(0, 8000) };
    }

    // Cas 2 : Session expirée / erreur
    if (finalUrl.includes("SessionExpired") || finalUrl.includes("/Captcha") || finalUrl.includes("MultiSession")) {
      console.log(`[CEV-NAV] → Erreur session: ${finalUrl}`);
      return { status: "error", finalUrl, error: `SESSION_ERROR: ${finalUrl}` };
    }

    // Cas 3 : /Home/AvailableTimeSlots intercepté avec des données
    if (interceptedSlots.length > 0) {
      for (const slot of interceptedSlots) {
        if (slot.status === 200 && slot.body.length > 2) {
          try {
            const parsed = JSON.parse(slot.body);
            if (Array.isArray(parsed) && parsed.length > 0) {
              console.log(`[CEV-NAV] 🚨 SLOTS TROUVÉS! count=${parsed.length}`);
              botLog({
                applicationId: clientId,
                step: "cev_playwright_slots_found",
                status: "ok",
                data: {
                  slotsCount: parsed.length,
                  slotsPreview: JSON.stringify(parsed).slice(0, 3000),
                  finalUrl,
                },
              });
              return { status: "slot_found", slotsJson: slot.body, finalUrl, pageHtml: pageHtml.slice(0, 8000) };
            }
          } catch { /* not JSON */ }
        }
      }
      // Slots interceptés mais vides ([] ou erreur)
      console.log("[CEV-NAV] → AvailableTimeSlots intercepté mais vide/erreur");
    }

    // Cas 4 : Page calendrier chargée (marqueurs positifs) mais pas d'appel API intercepté
    // Peut arriver si le JS n'a pas encore exécuté ou si le calendrier est vide ce mois
    if (
      pageHtml.toLowerCase().includes("getavailabletimeslotsforpublic") ||
      pageHtml.toLowerCase().includes("selectslot")
    ) {
      // La page calendrier est chargée — tenter un poll API depuis le browser
      console.log("[CEV-NAV] Page calendrier détectée — tentative poll depuis browser...");
      const now = new Date();
      const browserPollResult = await page.evaluate(async (body: { month: number; year: number }) => {
        try {
          const res = await fetch("/Home/AvailableTimeSlots", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Requested-With": "XMLHttpRequest",
            },
            body: JSON.stringify(body),
            credentials: "include",
          });
          const text = await res.text();
          return { status: res.status, body: text, url: res.url };
        } catch (e) {
          return { status: 0, body: String(e), url: "" };
        }
      }, { month: now.getMonth() + 1, year: now.getFullYear() });

      botLog({
        applicationId: clientId,
        step: "cev_playwright_browser_poll",
        status: "ok",
        data: {
          httpStatus: browserPollResult.status,
          bodyPreview: browserPollResult.body.slice(0, 2000),
          bodyLength: browserPollResult.body.length,
          finalUrl: browserPollResult.url,
        },
      });

      if (browserPollResult.status === 200) {
        try {
          const parsed = JSON.parse(browserPollResult.body);
          if (Array.isArray(parsed) && parsed.length > 0) {
            console.log(`[CEV-NAV] 🚨 SLOTS TROUVÉS (browser poll)! count=${parsed.length}`);
            return { status: "slot_found", slotsJson: browserPollResult.body, finalUrl, pageHtml: pageHtml.slice(0, 8000) };
          }
          // Tableau vide → pas de slots ce mois, essayer mois suivant
          const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
          const nextResult = await page.evaluate(async (body: { month: number; year: number }) => {
            try {
              const res = await fetch("/Home/AvailableTimeSlots", {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
                body: JSON.stringify(body),
                credentials: "include",
              });
              return { status: res.status, body: await res.text() };
            } catch (e) {
              return { status: 0, body: String(e) };
            }
          }, { month: nextMonth.getMonth() + 1, year: nextMonth.getFullYear() });

          if (nextResult.status === 200) {
            try {
              const nextParsed = JSON.parse(nextResult.body);
              if (Array.isArray(nextParsed) && nextParsed.length > 0) {
                console.log(`[CEV-NAV] 🚨 SLOTS TROUVÉS (mois suivant)! count=${nextParsed.length}`);
                return { status: "slot_found", slotsJson: nextResult.body, finalUrl, pageHtml: pageHtml.slice(0, 8000) };
              }
            } catch { /* not JSON */ }
          }
        } catch { /* not JSON */ }
      }

      // Calendrier chargé mais 0 slot → no_availability (mais la page est le calendrier, pas la page erreur)
      console.log("[CEV-NAV] → Calendrier chargé, 0 créneau disponible");
      return { status: "no_availability", finalUrl, pageHtml: pageHtml.slice(0, 8000) };
    }

    // Cas 5 : Page inconnue — loguer tout pour diagnostic
    console.log(`[CEV-NAV] → Page inconnue: ${finalUrl}`);
    return { status: "error", finalUrl, pageHtml: pageHtml.slice(0, 8000), error: `UNKNOWN_PAGE: ${finalUrl}` };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CEV-NAV] Erreur: ${msg.slice(0, 200)}`);
    botLog({
      applicationId: clientId,
      step: "cev_playwright_nav_error",
      status: "fail",
      data: { error: msg.slice(0, 500) },
    });
    return { status: "error", error: msg };
  } finally {
    await browser.close().catch(() => {});
  }
}
