// ─── CEV Sessions polling — boucle parallèle indépendante ───────────────────
// Extracted from index.ts
// Tourne en background sans bloquer la boucle principale du bot Playwright.

import { getActiveCevSessions, recordCevSessionCheck, reportSlotFound, tryClaimCevSlot } from "../convexClient.js";
import { bookWithExistingSession } from "../cevBooking.js";
import { bookCevViaHttp, bookCevSelectedSlotViaHttp } from "../cevHttpBooking.js";
import { pollCevSlot, getCevCapacitySnapshot } from "../cevPolling.js";

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
            // Sécurité capacité: récupérer compteurs et éviter d'attaquer si free ≤ 2
            const cap = await getCevCapacitySnapshot(s.sessionCookie, siphoned);
            if ((cap as any)?.error === "session_expired") {
              console.log(`[CEV-POLL] ⛔ Capacité inaccessible (session_expired) session=${s.sessionId}, on passe`);
              await recordCevSessionCheck(s.sessionId, "session_expired", "capacity_session_expired");
              continue;
            }
            if ((cap as any)?.parsed && Array.isArray((cap as any).parsed)) {
              const parsed = (cap as any).parsed as Array<{date:string;times:Array<{time:string;free:number|null}>}>;
              const maxFree = Math.max(
                -Infinity,
                ...parsed.flatMap(d => d.times.map(t => (typeof t.free === 'number' ? t.free : -Infinity)))
              );
              if (Number.isFinite(maxFree) && maxFree <= 2) {
                console.log(`[CEV-POLL] 🛡️  Skip booking (max free <=2) session=${s.sessionId} maxFree=${maxFree}`);
                await recordCevSessionCheck(s.sessionId, "no_slot", "capacity_guard_free<=2");
                continue;
              }
            }

            let booked = false;
            let bookedDate: string | undefined;
            let bookedTime: string | undefined;
            let bookedCode: string | undefined;
            let bookedScreenshot: string | undefined;

            // Allocation multi‑dossiers (free-1) : sélectionner les créneaux avec le plus de places
            let allocatedTarget: { date: string; time: string } | null = null;
            if ((cap as any)?.parsed && Array.isArray((cap as any).parsed)) {
              const parsed = (cap as any).parsed as Array<{date:string;times:Array<{time:string;free:number|null}>}>;
              // Construire la liste des candidats triés par free décroissant
              const candidates: Array<{ date: string; time: string; free: number }> = [];
              for (const d of parsed) {
                for (const t of d.times) {
                  const free = typeof t.free === 'number' && Number.isFinite(t.free) ? t.free : 0;
                  if (free > 2) candidates.push({ date: d.date, time: t.time, free });
                }
              }
              candidates.sort((a, b) => b.free - a.free);

              for (const c of candidates) {
                const slotKey = `CEV:${c.date}:${c.time}`; // centre/catégorie implicites côté intégration
                const maxClaims = Math.max(0, c.free - 1);
                const claim = await tryClaimCevSlot(slotKey, maxClaims, 10);
                if (claim.ok) {
                  allocatedTarget = { date: c.date, time: c.time };
                  console.log(`[CEV-POLL] 🔒 Claim slot OK key=${slotKey} count=${claim.count}/${claim.max}`);
                  break;
                } else {
                  console.log(`[CEV-POLL] ⛔ Claim refusé key=${slotKey}`);
                }
              }
            }

            // Tentative 1 : HTTP pur (rapide, zéro browser)
            console.log(`[CEV-POLL] 🌐 Tentative booking HTTP session=${s.sessionId}...`);
            const siphoned = s.siphonedF5CookieValue ? {
              f5CookieValue: s.siphonedF5CookieValue,
              f5CookieName: s.siphonedF5CookieName,
              aspNetSessionId: s.siphonedAspNetSessionId,
              userAgent: s.siphonedUserAgent,
              validUntil: s.siphonedValidUntil
            } : undefined;
            // Si un créneau précis a été alloué, tente le booking direct ciblé
            const httpResult = allocatedTarget
              ? await bookCevSelectedSlotViaHttp(
                  s.integrationUrl,
                  s.sessionCookie,
                  s.applicationId,
                  { date: allocatedTarget.date, time: allocatedTarget.time },
                  siphoned,
                  s.siphonedUserAgent,
                )
              : await bookCevViaHttp(s.integrationUrl, s.sessionCookie, s.applicationId, siphoned);

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
