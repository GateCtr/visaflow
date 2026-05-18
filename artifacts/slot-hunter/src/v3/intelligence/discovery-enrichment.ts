/**
 * Discovery Enrichment V3 — Enrichit le calendrier admin avec les dates trouvées.
 *
 * RESPONSABILITÉ :
 *   - Collecter TOUTES les dates trouvées pendant un scan (même hors fenêtre)
 *   - Enrichir avec monthScanned, allDatesInMonth, scanSource
 *   - Déclencher le broadcast pour le blind booking (si éclaireur + blindBookingEnabled)
 *   - Reporter en batch vers Convex (fire-and-forget)
 *
 * USAGE :
 *   const collector = createDiscoveryCollector(config);
 *   collector.addDate({ ... });
 *   collector.flush(); // envoie le batch à Convex
 */

import type { SlotDiscoveryEvent } from "../../convexClient.js";
import { reportSlotDiscoveryBatch } from "../../convexClient.js";
import { broadcastSlotDiscovery, type SlotBroadcastEvent } from "../booking/booking-blind.js";
import type { AccountRole } from "../core/types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveryCollectorConfig {
  /** Job ID Convex (applicationId dans les events). */
  jobId: string;
  /** Nom de l'OFC scanné. */
  office: string;
  /** Username du compte (pour déterminer le rôle). */
  username: string;
  /** Rôle du compte (éclaireur = broadcast, confiné = ne reçoit que). */
  accountRole: AccountRole;
  /** Blind booking activé pour ce compte ? */
  blindBookingEnabled: boolean;
  /** Mode scan (schedule ou reschedule). */
  mode: "schedule" | "reschedule";
  /** Convex URL + API key (pour le broadcast). */
  convexSiteUrl: string;
  hunterApiKey: string;
}

export interface EnrichedDiscoveryEvent extends SlotDiscoveryEvent {
  /** Quel mois a été scanné (YYYY-MM). */
  monthScanned?: string;
  /** Toutes les dates trouvées ce mois (même hors fenêtre). */
  allDatesInMonth?: string[];
  /** Source du scan. */
  scanSource?: "eclaireur" | "confine" | "direct";
}

// ─── Collector ──────────────────────────────────────────────────────────────

export interface DiscoveryCollector {
  /** Ajoute une date découverte. */
  addDate(event: Omit<SlotDiscoveryEvent, "applicationId" | "destination">): void;
  /** Ajoute un slot trouvé (captured) — déclenche le broadcast si éclaireur. */
  addSlotFound(params: {
    date: string;
    time: string;
    slotId: string | number;
    startTime: string;
    postUserId: number;
  }): void;
  /** Flush : envoie le batch vers Convex (fire-and-forget). */
  flush(): void;
  /** Nombre d'événements collectés. */
  get count(): number;
  /** Statistiques rapides. */
  getSummary(): {
    datesFound: number;
    datesIgnored: number;
    datesCaptured: number;
    reasons: Record<string, number>;
  };
}

/**
 * Crée un collecteur de discovery pour un cycle de scan.
 * À instancier au début de chaque scan, flush() à la fin.
 */
export function createDiscoveryCollector(config: DiscoveryCollectorConfig): DiscoveryCollector {
  const events: SlotDiscoveryEvent[] = [];

  return {
    addDate(event) {
      events.push({
        ...event,
        applicationId: config.jobId,
        destination: "usa",
      });
    },

    addSlotFound(params) {
      // Ajouter l'événement captured
      events.push({
        applicationId: config.jobId,
        destination: "usa",
        office: config.office,
        dateFound: params.date,
        timeFound: params.time,
        outcome: "captured",
        context: { slotId: params.slotId },
        mode: config.mode,
      });

      // Si éclaireur + blind booking activé → broadcast aux confinés
      if (config.accountRole === "eclaireur" && config.blindBookingEnabled) {
        const broadcastEvent: SlotBroadcastEvent = {
          sourceUsername: config.username,
          office: config.office,
          postUserId: params.postUserId,
          date: params.date,
          time: params.time,
          slotId: String(params.slotId),
          startTime: params.startTime,
          discoveredAt: Date.now(),
          sourceBooked: false, // Sera mis à true après booking réussi
        };
        broadcastSlotDiscovery(broadcastEvent, config.convexSiteUrl, config.hunterApiKey);
      }
    },

    flush() {
      if (events.length === 0) return;
      // Fire-and-forget vers Convex
      reportSlotDiscoveryBatch(events.map(e => ({ ...e, applicationId: config.jobId })));
    },

    get count() {
      return events.length;
    },

    getSummary() {
      const captured = events.filter(e => e.outcome === "captured").length;
      const ignored = events.filter(e => e.outcome === "ignored").length;
      const reasons: Record<string, number> = {};
      for (const e of events) {
        if (e.outcome === "ignored" && e.reason) {
          reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
        }
      }
      return {
        datesFound: events.length,
        datesIgnored: ignored,
        datesCaptured: captured,
        reasons,
      };
    },
  };
}
