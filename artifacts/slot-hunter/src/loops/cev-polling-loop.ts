// ─── CEV Sessions polling — boucle parallèle indépendante ───────────────────
// Extracted from index.ts
// Tourne en background sans bloquer la boucle principale du bot Playwright.

import { getActiveCevSessions, recordCevSessionCheck, reportSlotFound } from "../convexClient.js";
import { bookWithExistingSession } from "../cevBooking.js";
import { bookCevViaHttp } from "../cevHttpBooking.js";
import { pollCevSlot } from "../cevPolling.js";

export async function startCevPollingLoop(): Promise<void> {
  console.log("[CEV-POLL] Boucle de polling sessions CEV démarrée");
  while (true) {
    try {
      const due = await getActiveCevSessions();

      if (due.length > 0) {
        console.log(`[CEV-POLL] ${due.length} session(s) claimée(s) à checker`);
      }

      // Check séquentiel — évite les bursts parallèles qui génèrent des 500 Convex
      for (const s of due) {
        const t0 = Date.now();
        const siphoned = s.siphonedF5CookieValue ? {
          f5CookieValue: s.siphonedF5CookieValue,
          f5CookieName: s.siphonedF5CookieName,
          aspNetSessionId: s.siphonedAspNetSessionId,
          userAgent: s.siphonedUserAgent,
          validUntil: s.siphonedValidUntil
        } : undefined;
        const r = await pollCevSlot(s.integrationUrl, s.sessionCookie, siphoned);
        const ms = Date.now() - t0;

        if (r.status === "slot_found") {
          console.log(`[CEV-POLL] 🚨 SLOT TROUVÉ session=${s.sessionId} (${ms}ms) — lancement booking Playwright`);
          await recordCevSessionCheck(s.sessionId, "slot_found");

          try {
            let booked = false;
            let bookedDate: string | undefined;
            let bookedTime: string | undefined;
            let bookedCode: string | undefined;
            let bookedScreenshot: string | undefined;

            // Tentative 1 : HTTP pur (rapide, zéro browser)
            console.log(`[CEV-POLL] 🌐 Tentative booking HTTP session=${s.sessionId}...`);
            const siphoned = s.siphonedF5CookieValue ? {
              f5CookieValue: s.siphonedF5CookieValue,
              f5CookieName: s.siphonedF5CookieName,
              aspNetSessionId: s.siphonedAspNetSessionId,
              userAgent: s.siphonedUserAgent,
              validUntil: s.siphonedValidUntil
            } : undefined;
            const httpResult = await bookCevViaHttp(s.integrationUrl, s.sessionCookie, s.applicationId, siphoned);

            if (httpResult.success) {
              booked        = true;
              bookedDate    = httpResult.bookedDate;
              bookedTime    = httpResult.bookedTime;
              bookedCode    = httpResult.confirmationCode;
              console.log(`[CEV-POLL] ✅ BOOKING HTTP RÉUSSI session=${s.sessionId} code=${bookedCode ?? 'N/A'} date=${bookedDate ?? '?'}`);
            } else if (httpResult.needsPlaywright !== false) {
              console.log(`[CEV-POLL] 🎭 HTTP insuffisant (${httpResult.error}) — fallback Playwright session=${s.sessionId}...`);
              const playwrightResult = await bookWithExistingSession(
                s.integrationUrl,
                s.sessionCookie,
                s.applicationId,
              );
              if (playwrightResult.success) {
                booked           = true;
                bookedDate       = playwrightResult.bookedDate;
                bookedTime       = playwrightResult.bookedTime;
                bookedCode       = playwrightResult.confirmationCode;
                bookedScreenshot = playwrightResult.screenshotStorageId;
                console.log(`[CEV-POLL] ✅ BOOKING PLAYWRIGHT RÉUSSI session=${s.sessionId} code=${bookedCode ?? 'N/A'} date=${bookedDate ?? '?'}`);
              } else {
                console.log(`[CEV-POLL] ❌ Playwright aussi échoué session=${s.sessionId}: ${playwrightResult.error}`);
              }
            } else {
              console.log(`[CEV-POLL] ❌ Booking HTTP erreur définitive session=${s.sessionId}: ${httpResult.error}`);
            }

            if (booked) {
              await reportSlotFound({
                applicationId:       s.applicationId,
                date:                bookedDate          ?? '',
                time:                bookedTime          ?? '',
                location:            'CEV - Ambassade de Belgique',
                confirmationCode:    bookedCode,
                screenshotStorageId: bookedScreenshot,
              });
            }
          } catch (bookErr) {
            console.warn(`[CEV-POLL] Crash booking session=${s.sessionId}:`, bookErr);
          }
        } else if (r.status === "session_expired") {
          console.log(`[CEV-POLL] ⏱️  Session expirée session=${s.sessionId} (${ms}ms) — demande re-setup...`);
          await recordCevSessionCheck(s.sessionId, "session_expired", "auto_renewal_requested");
        } else if (r.status === "error") {
          console.log(`[CEV-POLL] ❌ Erreur session=${s.sessionId}: ${r.error} (${ms}ms)`);
          if (r.error?.includes("URL d'entrée invalide")) {
            await recordCevSessionCheck(s.sessionId, "session_expired", "auto_renewal_requested");
          } else {
            await recordCevSessionCheck(s.sessionId, "error", r.error);
          }
        } else {
          // no_slot — log discret
          await recordCevSessionCheck(s.sessionId, "no_slot");
        }
      }
    } catch (err) {
      console.warn("[CEV-POLL] Erreur boucle:", err);
    }

    // Polling fréquent (5s) — la condition "due" filtre selon pollIntervalMs de chaque session
    await new Promise((r) => setTimeout(r, 5_000));
  }
}
