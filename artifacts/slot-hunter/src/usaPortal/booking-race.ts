/**
 * Booking Race — Course parallèle au booking quand un slot est détecté.
 *
 * CONCEPT :
 *   Le OFC Watcher détecte qu'un slot est disponible (getFirstAvailableMonth → present:true).
 *   Immédiatement, TOUS les dossiers inscrits sur cet OFC lancent en parallèle :
 *     1. Récupérer les dates précises (getSlotDates)
 *     2. Récupérer les heures (getSlotTime)
 *     3. Booker le créneau (PUT /appointments/schedule ou /reschedule)
 *
 *   Le PREMIER dossier qui réussit le booking gagne. Les autres reçoivent un 409
 *   (slot already taken) → échec propre, pas de problème.
 *
 * AVANTAGES :
 *   - N tentatives simultanées au lieu d'une seule
 *   - Chaque dossier utilise son propre proxy/fetcher (pas de conflit)
 *   - Temps de réaction : < 5s après détection (tokens déjà en cache via keep-alive)
 *
 * PROTECTION :
 *   - Timeout global de 60s par race (si un dossier bloque, les autres continuent)
 *   - Si le token d'un dossier est expiré → skip (pas de re-login pendant la race)
 *   - 409 Conflict → retry-409-logic existant
 */

import { createSessionFetcher, type UsaFetcher } from "./usa-fetcher.js";
import { tokenCache, authHeaders, setUsaSessionProxy } from "./usa-http.js";
import { reportSlotFound, sendHeartbeat, botLog, uploadFile } from "../convexClient.js";
import type { SlotDiscoveryEvent } from "../convexClient.js";
import { findFirstSlotForOfc } from "./usa-scan-find.js";
import { bookUsaSlot, rescheduleUsaSlot, reportSlotDiscovery_batch } from "./usa-scan-book.js";
import type { UsaBookingResult } from "./usa-scan-book.js";
import { recordSlotObservation } from "./slot-prediction.js";
import { recordSlotAppearance } from "./competitive-intelligence.js";
import { downloadUsaConfirmationPdf } from "./usa-scan-confirmation.js";
import type { SlotDetectedEvent, OfcWatcherSubscriber } from "./ofc-watcher.js";
import type { UsaOfc, UsaAppDetails, SlotFound } from "./usa-scan-types.js";
import type { UsaSession } from "./types.js";
import { USA_MISSION_ID } from "./config.js";

// ─── Configuration ──────────────────────────────────────────────────────────

/** Timeout global pour l'ensemble de la race (ms). */
const RACE_TIMEOUT_MS = 60_000; // 60s

/** Délai aléatoire entre les départs (évite burst exact simultané). */
const RACE_STAGGER_MAX_MS = 2_000; // 0-2s de décalage entre les participants

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BookingRaceResult {
  /** Nombre total de participants à la race. */
  totalParticipants: number;
  /** Nombre de bookings réussis (normalement 0 ou 1). */
  successCount: number;
  /** JobId du dossier qui a réussi le booking (ou null). */
  winnerJobId: string | null;
  /** Erreurs par participant (jobId → message). */
  errors: Record<string, string>;
  /** Durée totale de la race (ms). */
  durationMs: number;
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Lance la booking race pour tous les subscribers éligibles.
 * Appelé par le callback onSlotDetected du OFC Watcher.
 *
 * @param event - Détails du slot détecté (OFC, date, etc.)
 * @param subscribers - Dossiers éligibles qui participent à la race
 * @returns Résultat de la race (winner, erreurs, durée)
 */
export async function runBookingRace(
  event: SlotDetectedEvent,
  subscribers: OfcWatcherSubscriber[],
): Promise<BookingRaceResult> {
  const raceStart = Date.now();
  const result: BookingRaceResult = {
    totalParticipants: subscribers.length,
    successCount: 0,
    winnerJobId: null,
    errors: {},
    durationMs: 0,
  };

  console.log(
    `[booking-race] 🏁 RACE LANCÉE — ${subscribers.length} participants pour ${event.ofcName} (date: ${event.firstAvailableMonth})`,
  );

  // Flag partagé : dès qu'un participant réussit, les autres s'arrêtent
  let raceWon = false;

  // Lancer TOUS les participants en parallèle
  const racePromises = subscribers.map(async (sub, idx) => {
    // Petit stagger aléatoire pour éviter un burst exact
    if (idx > 0) {
      const stagger = Math.random() * RACE_STAGGER_MAX_MS;
      await new Promise(r => setTimeout(r, stagger));
    }

    // Si la race est déjà gagnée, abandonner
    if (raceWon) {
      result.errors[sub.jobId] = "RACE_ALREADY_WON";
      return;
    }

    try {
      const success = await participateInRace(sub, event, () => raceWon);
      if (success) {
        raceWon = true;
        result.successCount++;
        result.winnerJobId = sub.jobId;
        console.log(`[booking-race] 🏆 WINNER: ${sub.username.slice(0, 12)}… (job: ${sub.jobId.slice(-6)})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors[sub.jobId] = msg.slice(0, 200);
      console.warn(`[booking-race] ❌ [${sub.username.slice(0, 12)}…] ${msg.slice(0, 100)}`);
    }
  });

  // Attendre la fin avec timeout global
  await Promise.race([
    Promise.allSettled(racePromises),
    new Promise<void>(r => setTimeout(r, RACE_TIMEOUT_MS)),
  ]);

  result.durationMs = Date.now() - raceStart;

  console.log(
    `[booking-race] 🏁 RACE TERMINÉE en ${Math.round(result.durationMs / 1000)}s — ` +
    `winner=${result.winnerJobId?.slice(-6) ?? "AUCUN"} | success=${result.successCount} | errors=${Object.keys(result.errors).length}`,
  );

  // Log dans Convex pour le dashboard admin
  botLog({
    applicationId: subscribers[0]?.jobId ?? "unknown",
    step: "booking_race_complete",
    status: result.successCount > 0 ? "ok" : "warn",
    data: {
      ofcName: event.ofcName,
      firstAvailableMonth: event.firstAvailableMonth,
      totalParticipants: result.totalParticipants,
      successCount: result.successCount,
      winnerJobId: result.winnerJobId,
      durationMs: result.durationMs,
      errorCount: Object.keys(result.errors).length,
    },
  });

  return result;
}

// ─── Logique d'un participant ───────────────────────────────────────────────

async function participateInRace(
  sub: OfcWatcherSubscriber,
  event: SlotDetectedEvent,
  isRaceWon: () => boolean,
): Promise<boolean> {
  const { username, proxyUrl, job, appDetails, rescheduleYN, dateFrom, dateDeadline } = sub;
  const logPrefix = `[race:${username.slice(0, 8)}]`;

  // 1. Vérifier que le token est en cache et valide
  //    Si le token est expiré (compte en repos), tenter un re-login d'urgence.
  //    Le slot reste dispo ~30-60s, le login prend ~3-5s → acceptable.
  let cached = tokenCache.get(username.toLowerCase());
  if (!cached || Date.now() >= cached.expiresAt) {
    console.log(`${logPrefix} ⚡ Token expiré — re-login d'urgence pour la race...`);
    try {
      const { getUsaSession } = await import("./usa-session.js");
      const session = await getUsaSession(username, job.hunterConfig.embassyPassword);
      if (!session) {
        throw new Error("TOKEN_EXPIRED — re-login d'urgence échoué (cooldown/restriction)");
      }
      cached = tokenCache.get(username.toLowerCase());
      if (!cached || Date.now() >= cached.expiresAt) {
        throw new Error("TOKEN_EXPIRED — re-login réussi mais token invalide");
      }
      console.log(`${logPrefix} ✅ Re-login d'urgence réussi — participation à la race!`);
    } catch (loginErr) {
      const msg = loginErr instanceof Error ? loginErr.message : String(loginErr);
      throw new Error(`TOKEN_EXPIRED — ${msg}`);
    }
  }

  // 2. Construire la session à partir du cache
  const session: UsaSession = {
    accessToken: cached.accessToken,
    refreshToken: cached.refreshToken,
    csrfToken: cached.csrfToken,
    userID: cached.userID,
    fullName: cached.fullName,
    applicationId: appDetails.applicationId,
    pendingAppoStatus: null,
    missionId: USA_MISSION_ID,
    allowedOfcs: cached.allowedOfcs ?? [],
    appointmentId: appDetails.appointmentId,
    applicantUUID: appDetails.applicantUUID,
    isReschedule: rescheduleYN,
  };

  // FIX-20: Collecteur de découvertes — déclaré ici pour être accessible dans finally
  const discoveryEvents: SlotDiscoveryEvent[] = [];

  // 3. Créer un fetcher dédié pour ce participant
  const fetcher = createSessionFetcher({
    proxyUrl,
    username,
    label: `race:${event.ofcName.slice(0, 6)}`,
  });

  try {
    // 4. Activer le proxy legacy pour ce participant (usaFetch global utilisé par findFirstSlotForOfc)
    // NOTE: C'est le point de contention legacy — en parallèle vrai, il faudra passer
    // le fetcher à findFirstSlotForOfc. Pour l'instant on utilise setUsaSessionProxy
    // car findFirstSlotForOfc utilise encore usaFetch global.
    // TODO Phase 5: migrer findFirstSlotForOfc pour accepter un fetcher
    setUsaSessionProxy(proxyUrl);

    if (isRaceWon()) return false;

    // 5. Trouver le slot (dates → times → premier créneau disponible)
    const ofc: UsaOfc = {
      postUserId: (appDetails as any).postUserId ?? cached.allowedOfcs?.[0]?.postUserId ?? 0,
      postName: event.ofcName,
      officeType: rescheduleYN ? (appDetails.appointmentLocationType ?? "POST") : "OFC",
    };

    // Utiliser le premier OFC connu du subscriber
    if (cached.allowedOfcs && cached.allowedOfcs.length > 0) {
      ofc.postUserId = cached.allowedOfcs[0].postUserId;
      ofc.officeType = cached.allowedOfcs[0].officeType;
    }

    console.log(`${logPrefix} 🔍 Recherche slot détaillé (dates+times)...`);
    const found = await findFirstSlotForOfc(
      session, ofc, appDetails, dateFrom, dateDeadline, rescheduleYN,
      undefined, // referer (défaut)
      discoveryEvents,
    );

    if (!found) {
      console.log(`${logPrefix} ⚠️ Slot disparu avant booking (race perdue ou créneau expiré)`);
      return false;
    }

    if (isRaceWon()) {
      console.log(`${logPrefix} 🏳️ Race déjà gagnée — abandon avant booking`);
      return false;
    }

    // 6. BOOKING!
    console.log(`${logPrefix} 📝 Tentative booking: ${found.date} ${found.time} @ ${found.ofcName}`);

    const useReschedule = rescheduleYN || session.isReschedule === true;
    let booking: UsaBookingResult;

    if (useReschedule) {
      booking = await rescheduleUsaSlot(session, found);
    } else {
      booking = await bookUsaSlot(session, found);
    }

    if (booking.success) {
      const appointmentId = (booking as any).appointmentId;
      console.log(`${logPrefix} ✅ BOOKING RÉUSSI! appointmentId=${appointmentId ?? "N/A"}`);

      // ── 1. botLog booking_success (comme l'ancien système) ──
      botLog({
        applicationId: job.id,
        step: "booking_success",
        status: "ok",
        data: {
          flow: "usa",
          ofc: found.ofcName,
          date: found.date,
          time: found.time,
          slotId: found.slotId,
          appointmentId,
          responseMsg: (booking as any).responseMsg,
          via: "parallel_booking_race",
        },
      });

      // ── 2. Télécharger + uploader le PDF de confirmation ──
      let pdfStorageId: string | undefined;
      try {
        const pdf = await downloadUsaConfirmationPdf(session, appDetails.applicationId, appointmentId);
        if (pdf) {
          console.log(`${logPrefix} 📄 Confirmation PDF (${pdf.length} bytes) — upload vers Convex...`);
          const b64 = pdf.toString("base64");
          pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
          if (pdfStorageId) {
            console.log(`${logPrefix} ✅ PDF uploadé → storageId: ${pdfStorageId}`);
            botLog({
              applicationId: job.id,
              step: "confirmation_letter",
              status: "ok",
              data: { flow: "usa", pdfSizeBytes: pdf.length, storageId: pdfStorageId, appointmentId },
            });
          }
        }
      } catch (pdfErr) {
        console.warn(`${logPrefix} PDF confirmation échoué (non-bloquant):`, pdfErr);
      }

      // ── 3. Enregistrer les observations (Early Bird + Competitive Intelligence) ──
      recordSlotObservation(username, event.ofcName);
      recordSlotAppearance(event.ofcName, found.date, found.time);

      // ── 4. Reporter à Convex (avec le PDF storageId et location formatée) ──
      await reportSlotFound({
        applicationId: job.id,
        date: found.date,
        time: found.time,
        location: `${found.ofcName} — Ambassade USA (slotId=${found.slotId}, appointmentId=${appointmentId ?? "N/A"})`,
        confirmationCode: appointmentId?.toString(),
        screenshotStorageId: pdfStorageId,
      });

      // ── 5. botLog pour le dashboard race ──
      botLog({
        applicationId: job.id,
        step: "booking_race_success",
        status: "ok",
        data: {
          flow: "usa",
          phase: "parallel_booking_race",
          ofc: found.ofcName,
          date: found.date,
          time: found.time,
          slotId: found.slotId,
          appointmentId,
          pdfStorageId,
          raceParticipants: event.watcherUsername ? "multi" : "single",
        },
      });

      // ── 6. Envoyer les événements de découverte vers Convex (stats/analytics) ──
      if (discoveryEvents.length > 0) {
        reportSlotDiscovery_batch(discoveryEvents, job.id);
      }

      return true;
    } else if (booking.statusCode === 409) {
      // FIX-20: 409 = slot pris par quelqu'un d'autre → retenter avec un autre slot
      // L'ancien système avait retry-409-logic pour retenter avec le prochain créneau.
      // En booking race, on tente UNE FOIS de plus avec un re-scan (le slot peut avoir changé de time).
      console.log(`${logPrefix} ⚠️ Booking 409 (slot pris) — retry avec re-scan...`);
      if (isRaceWon()) return false;

      const retryFound = await findFirstSlotForOfc(
        session, ofc, appDetails, dateFrom, dateDeadline, rescheduleYN,
      );
      if (!retryFound) {
        console.log(`${logPrefix} ❌ Retry 409: plus aucun slot disponible`);
        throw new Error("409_RETRY_NO_SLOT");
      }

      console.log(`${logPrefix} 📝 Retry booking: ${retryFound.date} ${retryFound.time}`);
      const retryBooking = useReschedule
        ? await rescheduleUsaSlot(session, retryFound)
        : await bookUsaSlot(session, retryFound);

      if (retryBooking.success) {
        const retryAppointmentId = (retryBooking as any).appointmentId;
        console.log(`${logPrefix} ✅ RETRY BOOKING RÉUSSI! appointmentId=${retryAppointmentId ?? "N/A"}`);

        // botLog booking success via retry
        botLog({
          applicationId: job.id,
          step: "booking_success",
          status: "ok",
          data: { flow: "usa", ofc: retryFound.ofcName, date: retryFound.date, time: retryFound.time, appointmentId: retryAppointmentId, via: "409_retry" },
        });

        // Download + upload PDF
        let retryPdfStorageId: string | undefined;
        try {
          const pdf = await downloadUsaConfirmationPdf(session, appDetails.applicationId, retryAppointmentId);
          if (pdf) {
            const b64 = pdf.toString("base64");
            retryPdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
            if (retryPdfStorageId) {
              botLog({
                applicationId: job.id,
                step: "confirmation_letter",
                status: "ok",
                data: { flow: "usa", pdfSizeBytes: pdf.length, storageId: retryPdfStorageId, appointmentId: retryAppointmentId },
              });
            }
          }
        } catch { /* non-bloquant */ }

        recordSlotObservation(username, event.ofcName);
        recordSlotAppearance(event.ofcName, retryFound.date, retryFound.time);

        await reportSlotFound({
          applicationId: job.id,
          date: retryFound.date,
          time: retryFound.time,
          location: `${retryFound.ofcName} — Ambassade USA (slotId=${retryFound.slotId}, appointmentId=${retryAppointmentId ?? "N/A"}, via 409-retry)`,
          confirmationCode: retryAppointmentId?.toString(),
          screenshotStorageId: retryPdfStorageId,
        });
        return true;
      }
      throw new Error(`409_RETRY_FAILED: ${retryBooking.error}`);
    } else {
      // Booking échoué (autre raison)
      const errMsg = booking.error ?? "Booking échoué (raison inconnue)";
      console.log(`${logPrefix} ❌ Booking échoué: ${errMsg}`);
      throw new Error(errMsg);
    }
  } finally {
    // Envoyer les événements de découverte même si le booking a échoué
    // (slot vu mais pas booké = discovery avec outcome "captured" ou "ignored")
    if (discoveryEvents.length > 0) {
      reportSlotDiscovery_batch(discoveryEvents, job.id);
    }
    fetcher.dispose();
    setUsaSessionProxy(undefined);
  }
}
