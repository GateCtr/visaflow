/**
 * spain-slot-explorer.ts — Exploration des créneaux disponibles (lecture seule)
 *
 * Quand le watcher détecte un "found", cette fonction navigue les APIs JSONP
 * Bookitit pour récupérer les dates/heures exactes de chaque service sans booker.
 *
 * Flow : services (depuis HTML) → getagendas/ → datetime/ (3 mois) → slots structurés
 *
 * Coût : 0 (réutilise la session CF existante, pas de solve supplémentaire)
 * Durée : ~2-3s (quelques appels JSONP)
 */

import {
  spainCfFetch,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import type { ExtractedSlotInfo } from "./spain-http-booking.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExploredSlot {
  date: string;       // "2026-07-15"
  time: string;       // "10:30"
  freeSlots: number;  // nombre de places dispo (-1 si inconnu)
  agendaId?: string;
}

export interface ExploredService {
  serviceId: string;
  serviceName: string;
  agendaIds: string[];
  slots: ExploredSlot[];
}

export interface SlotExplorationResult {
  services: ExploredService[];
  totalSlots: number;
  explorationDurationMs: number;
}

// ─── JSONP Helper ───────────────────────────────────────────────────────────

function parseJsonp(text: string): unknown | null {
  const src = text.trim();
  if (!src) return null;
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try { return JSON.parse(src); } catch { return null; }
  }
  try { return JSON.parse(m[1].trim()); } catch { return null; }
}

async function callJsonp(
  session: SpainCfSession,
  endpoint: string,
  params: Record<string, string>,
  portalUrl: string,
): Promise<unknown | null> {
  const baseUrl = "https://www.citaconsular.es/onlinebookings/";
  const q = new URLSearchParams(params);
  q.set("callback", `cb${Date.now()}${Math.floor(Math.random() * 10000)}`);
  q.set("_", String(Date.now()));
  const url = `${baseUrl}${endpoint}?${q.toString()}`;

  const res = await spainCfFetch(url, session, {
    Referer: portalUrl,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  });

  if (!res || !res.ok) return null;
  const body = await res.text();
  return parseJsonp(body);
}

// ─── ID Extraction ──────────────────────────────────────────────────────────

function collectIds(value: unknown, keyHint: RegExp): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return; }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === "object") { walk(v); continue; }
      if ((typeof v === "string" || typeof v === "number") && keyHint.test(k)) {
        const s = String(v).trim();
        if (s.length > 0) out.add(s);
      }
    }
  };
  walk(value);
  return [...out];
}

// ─── Slot Extraction from datetime/ payload ─────────────────────────────────

function extractSlotsFromDatetime(payload: unknown): ExploredSlot[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  const slots: ExploredSlot[] = [];

  if (Array.isArray(obj.Slots)) {
    for (const day of obj.Slots) {
      if (!day || typeof day !== "object") continue;
      const dayObj = day as Record<string, unknown>;
      const date = typeof dayObj.date === "string" ? dayObj.date : "";
      if (!date) continue;

      const agendaId =
        typeof dayObj.agenda === "string" ? dayObj.agenda
        : typeof dayObj.agenda === "number" ? String(dayObj.agenda)
        : undefined;

      const times = dayObj.times;
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;

      for (const v of Object.values(times as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;
        const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
        const free = typeof freeRaw === "number" ? freeRaw
          : typeof freeRaw === "string" ? parseInt(freeRaw, 10)
          : -1;

        // Skip explicitly empty slots
        if (free === 0) continue;

        const time = typeof t.time === "string" ? t.time
          : typeof t.hour === "string" ? t.hour
          : "09:00";

        slots.push({ date, time, freeSlots: free, agendaId });
      }
    }
  }

  return slots;
}

// ─── Main Explorer ──────────────────────────────────────────────────────────

/**
 * Explore les créneaux disponibles pour chaque service détecté.
 * Appelle getagendas/ puis datetime/ sur 3 mois pour chaque service.
 *
 * @param session - Session CF active
 * @param portalUrl - URL du widget
 * @param services - Services extraits du HTML (via extractServicesFromHtml)
 * @returns Détail des créneaux par service
 */
export async function exploreAvailableSlots(
  session: SpainCfSession,
  portalUrl: string,
  services: ExtractedSlotInfo[],
): Promise<SlotExplorationResult> {
  const t0 = Date.now();
  const publickey = portalUrl.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const baseParams: Record<string, string> = { publickey, lang: "es" };
  const results: ExploredService[] = [];

  for (const service of services.slice(0, 5)) { // Max 5 services pour ne pas surcharger
    const explored: ExploredService = {
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      agendaIds: [],
      slots: [],
    };

    // 1. Récupérer les agendas
    const agPayload = await callJsonp(session, "getagendas/", {
      ...baseParams,
      services: service.serviceId,
      selectedPeople: "1",
    }, portalUrl);

    if (agPayload) {
      explored.agendaIds = collectIds(agPayload, /(agenda.*id|agendas.*id|^id$)/i).slice(0, 5);
    }

    const agendaParam = explored.agendaIds.join(",") || "";

    // 2. Scanner datetime sur 3 mois
    const now = new Date();
    for (let m = 0; m < 3; m++) {
      const targetMonth = new Date(now.getFullYear(), now.getMonth() + m, 1);
      const dateFrom = targetMonth.toISOString().slice(0, 10);
      const dateTo = new Date(targetMonth.getFullYear(), targetMonth.getMonth() + 1, 0).toISOString().slice(0, 10);

      const dtPayload = await callJsonp(session, "datetime/", {
        ...baseParams,
        services: service.serviceId,
        agendas: agendaParam,
        selectedPeople: "1",
        date_from: dateFrom,
        date_to: dateTo,
      }, portalUrl);

      if (dtPayload) {
        const monthSlots = extractSlotsFromDatetime(dtPayload);
        explored.slots.push(...monthSlots);

        // Si on a trouvé des slots ce mois-ci, pas besoin de scanner plus loin
        // (sauf si on veut tout voir — on continue quand même pour 3 mois)
      }
    }

    results.push(explored);
  }

  const totalSlots = results.reduce((sum, svc) => sum + svc.slots.length, 0);

  return {
    services: results,
    totalSlots,
    explorationDurationMs: Date.now() - t0,
  };
}

/**
 * Formate le résultat d'exploration pour les logs Railway.
 */
export function formatExplorationForLogs(result: SlotExplorationResult): string[] {
  const lines: string[] = [];
  lines.push(`[SPAIN-EXPLORER] 📊 Exploration terminée en ${result.explorationDurationMs}ms — ${result.totalSlots} créneau(x) trouvé(s)`);

  for (const svc of result.services) {
    lines.push(`[SPAIN-EXPLORER]    🎯 "${svc.serviceName}" (ID: ${svc.serviceId}) — ${svc.slots.length} créneau(x)`);
    // Afficher max 10 slots par service
    for (const slot of svc.slots.slice(0, 10)) {
      const places = slot.freeSlots > 0 ? `(${slot.freeSlots} place${slot.freeSlots > 1 ? "s" : ""})` : "";
      lines.push(`[SPAIN-EXPLORER]       📅 ${slot.date} ${slot.time} ${places}`);
    }
    if (svc.slots.length > 10) {
      lines.push(`[SPAIN-EXPLORER]       ... et ${svc.slots.length - 10} autre(s)`);
    }
  }

  return lines;
}

/**
 * Sérialise le résultat pour stockage dans Convex (champ detectedSlots).
 * Format compact JSON.
 */
export function serializeExplorationForConvex(result: SlotExplorationResult): string {
  return JSON.stringify(result.services.map((svc) => ({
    id: svc.serviceId,
    name: svc.serviceName,
    slots: svc.slots.slice(0, 20).map((s) => ({
      d: s.date,
      t: s.time,
      n: s.freeSlots,
    })),
  })));
}
