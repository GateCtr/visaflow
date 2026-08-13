// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Extracted from index.ts
// Boucle indépendante, tourne en background.
//
// MODES :
//   - SPAIN_HTTP_MODE=1 → scan HTTP pur (impit + proxy + CapSolver CF cookie)
//     ✅ 10x plus rapide, 0 RAM browser, scan toutes les 30-60s
//     Prérequis : DECODO_PROXY_URL (ou SOAX_PROXY_URL) + CAPSOLVER_API_KEY
//   - SPAIN_HTTP_MODE=0 (défaut) → Playwright stealth (ancien mode)
//
// AUTO-BOOKING :
//   Quand un créneau est détecté :
//   1. Interroge Convex pour les dossiers Espagne actifs (destination="spain", hunterConfig.isActive=true)
//   2. Pour chaque dossier, mappe le visaType au service Bookitit via spain-service-mapping
//   3. Exécute le booking HTTP pour chaque dossier éligible
//   → Pas de env vars SPAIN_BOOK_LOGIN/PASSWORD — tout vient de Convex (comme le bot USA)

import { getSpainWatcherConfig, getActiveJobs, uploadFile, reportSpainWatcherScan, reportSlotFound, sendHeartbeat, attachConfirmationDoc, reportSlotDiscoveryBatch, pollRushPrepCommand, ackRushPrepCommand, type HunterJob, type SlotDiscoveryEvent } from "../convexClient.js";
import { runSpainWatcherProbe } from "../spainPortal.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { isSpainCfSessionExpiringSoon, ensureSpainCfSession, getActiveSpainCfSession, restoreSpainSoaxStateFromRedis } from "../spain-soax-solver.js";
import {
  ensureSpainPersistentBrowserSession,
  isSpainPersistentBrowserSessionExpiringSoon,
  getActiveSpainPersistentBrowserSession,
  tryRenewSpainPersistentBrowserSession,
} from "../spain-persistent-browser.js";
import { initSpainRedis, acquireSpainScannerLock, releaseSpainScannerLock, SPAIN_INSTANCE_ID } from "../spain-redis-persistence.js";
import { executeHttpBooking, extractServicesFromHtml, createIsolatedBookingSession, type SpainBookingConfig, type ExtractedSlotInfo } from "../spain-http-booking.js";
import { matchServiceForVisa } from "../spain-service-mapping.js";
import { exploreAvailableSlots, formatExplorationForLogs, serializeExplorationForConvex, type SlotExplorationResult } from "../spain-slot-explorer.js";
import { log } from "../scheduler-utils.js";

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";
const SPAIN_HTTP_SCAN_INTERVAL_SEC = (() => {
  const configured = Number(process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "10");
  if (!Number.isFinite(configured) || configured < 10) return 10;
  return Math.round(configured);
})();

// ─── Mode persistent-browser ──────────────────────────────────────────────────
// SPAIN_SESSION_MODE=persistent-browser → Chromium persistant + profil disque
//   Avantages : vrai fingerprint TLS/HTTP2, localStorage/cache conservés,
//               pas de coût CapSolver pour résoudre CF
//   Prérequis : DECODO_PROXY_URL (ou SOAX_PROXY_URL)
// Toutes les autres valeurs → comportement HTTP-only existant (capsolver / playwright)
const SPAIN_PERSISTENT_BROWSER = process.env.SPAIN_SESSION_MODE === "persistent-browser";

/**
 * Cooldown minimum entre deux tentatives de re-solve proactif.
 * Évite qu'un solve échoué soit retenté à chaque cycle (10s) pendant 10 minutes,
 * ce qui bloquerait le scan lock pendant toute la fenêtre d'expiration.
 */
const PROACTIVE_RETRY_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/**
 * Timestamp de la dernière tentative de re-solve proactif.
 * Remis à 0 après un re-solve réussi (la session fraîche ne déclenchera pas
 * isActiveSessionExpiringSoon() avant ~105 min).
 */
let lastProactiveAttemptAt = 0;

/** Abstraction de isSpainCfSessionExpiringSoon selon le mode actif. */
function isActiveSessionExpiringSoon(): boolean {
  return SPAIN_PERSISTENT_BROWSER
    ? isSpainPersistentBrowserSessionExpiringSoon()
    : isSpainCfSessionExpiringSoon();
}

/** Abstraction de ensureSpainCfSession selon le mode actif. */
async function ensureActiveSession(portalUrl: string) {
  return SPAIN_PERSISTENT_BROWSER
    ? ensureSpainPersistentBrowserSession(portalUrl)
    : ensureSpainCfSession(portalUrl);
}

/** Abstraction de getActiveSpainCfSession selon le mode actif. */
function getActiveSession() {
  return SPAIN_PERSISTENT_BROWSER
    ? getActiveSpainPersistentBrowserSession()
    : getActiveSpainCfSession();
}

/**
 * Re-solve proactif conditionnel.
 *
 * Mode persistent-browser → tryRenewSpainPersistentBrowserSession :
 *   tente un nouveau solve SANS détruire la session courante ;
 *   remplace uniquement si le nouveau solve retourne du prefetchedMainHtml.
 *
 * Mode HTTP/soax → comportement inchangé (ensureSpainCfSession gère déjà
 *   le fallback sur la session courante en interne).
 */
async function tryRenewActiveSession(portalUrl: string) {
  return SPAIN_PERSISTENT_BROWSER
    ? tryRenewSpainPersistentBrowserSession(portalUrl)
    : ensureSpainCfSession(portalUrl);
}

// ─── Types internes ──────────────────────────────────────────────────────────

interface SpainDossier {
  id: string;
  applicantName: string;
  visaType: string;
  login: string;
  password: string;
  applicationId: string;
  otpChannel: "email" | "sms" | "manual";
  slotDateFrom?: string;
  slotDateDeadline?: string;
  /** URL Bookitit du dossier — portalUrl ou hunterConfig.scheduleUrl */
  portalUrl: string;
  /**
   * Nombre minimum de places libres requises par créneau (group booking).
   * Si défini et > 1, le booking est skippé si aucun créneau n'a freeslots ≥ groupSize.
   */
  groupSize?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Récupère les dossiers Espagne actifs depuis Convex (via getActiveJobs).
 * Filtre : destination="spain"|"espagne"|"es", hunterConfig.isActive=true, credentials présents.
 */
async function getActiveSpainDossiers(): Promise<SpainDossier[]> {
  try {
    const jobs = await getActiveJobs();

    // ─── Diagnostic : décompose chaque étape du filtre ────────────────────────
    const spainDestinations = ["spain", "espagne", "es"];
    const byDestination = jobs.filter((j: HunterJob) => spainDestinations.includes(j.destination));
    const byActive      = byDestination.filter((j: HunterJob) => j.hunterConfig?.isActive === true);
    const byCreds       = byActive.filter((j: HunterJob) => !!j.hunterConfig.embassyUsername && !!j.hunterConfig.embassyPassword);

    if (byDestination.length === 0 && jobs.length > 0) {
      const dests = [...new Set(jobs.map((j: HunterJob) => j.destination))].join(", ");
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${jobs.length} job(s) total, 0 Espagne — destinations trouvées: [${dests}]`);
    } else if (byDestination.length > 0 && byActive.length === 0) {
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${byDestination.length} dossier(s) Espagne trouvé(s) mais hunterConfig.isActive=false pour tous`);
    } else if (byActive.length > 0 && byCreds.length === 0) {
      log("INFO", `[SPAIN-WATCHER] 🔍 Diagnostic dossiers: ${byActive.length} dossier(s) Espagne actifs mais sans credentials (embassyUsername/embassyPassword vides) — dossiers: ${byActive.map((j: HunterJob) => j.applicantName).join(", ")}`);
    }
    // ──────────────────────────────────────────────────────────────────────────

    return byCreds
      .filter((j: HunterJob) => !!(j.portalUrl || (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl))
      .map((j: HunterJob) => ({
        id: j.id,
        applicantName: j.applicantName,
        visaType: j.visaType,
        login: j.hunterConfig.embassyUsername,
        password: j.hunterConfig.embassyPassword,
        applicationId: j.id,
        otpChannel: (j.spainOtpConfig?.channel ?? "email") as "email" | "sms" | "manual",
        slotDateFrom: j.hunterConfig.slotDateFrom,
        slotDateDeadline: j.hunterConfig.slotDateDeadline,
        portalUrl: j.portalUrl ?? (j.hunterConfig as { scheduleUrl?: string }).scheduleUrl ?? "",
        groupSize: j.hunterConfig.groupSize,
      }));
  } catch (err) {
    log("WARN", `[SPAIN-WATCHER] Échec récupération dossiers Espagne: ${err}`);
    return [];
  }
}

/**
 * Tolérance (en jours) appliquée à `slotDateFrom`.
 *
 * POURQUOI : sur Bookitit les créneaux durent quelques secondes. Rejeter un
 * créneau parce qu'il tombe quelques jours avant la date souhaitée revient à
 * ne jamais rien réserver — alors qu'un RDV légèrement anticipé reste
 * exploitable (le dossier peut être avancé / le RDV reprogrammé).
 * `slotDateDeadline` reste strict : un RDV après la deadline est inutile.
 *
 * Override : SPAIN_SLOT_FROM_TOLERANCE_DAYS (0 = strict, -1 = ignorer slotDateFrom).
 */
const SLOT_FROM_TOLERANCE_DAYS = (() => {
  const raw = Number(process.env.SPAIN_SLOT_FROM_TOLERANCE_DAYS ?? "45");
  if (!Number.isFinite(raw)) return 45;
  return Math.round(raw);
})();

/**
 * Vérifie si un créneau est dans la fenêtre de dates acceptable pour un dossier.
 *
 * `slotDateFrom` est traité comme une PRÉFÉRENCE (avec tolérance), pas comme un
 * mur : seul un créneau déjà passé ou très en amont de la date souhaitée est
 * écarté. `slotDateDeadline` reste une contrainte dure.
 */
function isSlotInDateWindow(slotDate: string, dossier: SpainDossier): boolean {
  if (!slotDate) return true; // Pas de date connue → on tente quand même

  const slot = new Date(slotDate);
  if (isNaN(slot.getTime())) return true;

  // Un créneau dans le passé n'a jamais de sens.
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (slot < todayMidnight) {
    log("INFO", `[SPAIN-WATCHER] ⏭️ ${dossier.applicantName}: créneau ${slotDate} déjà passé — skip`);
    return false;
  }

  if (dossier.slotDateFrom && SLOT_FROM_TOLERANCE_DAYS >= 0) {
    const from = new Date(dossier.slotDateFrom);
    if (!isNaN(from.getTime())) {
      const fromWithTolerance = new Date(from.getTime() - SLOT_FROM_TOLERANCE_DAYS * 86_400_000);
      if (slot < fromWithTolerance) {
        log("INFO", `[SPAIN-WATCHER] ⏭️ ${dossier.applicantName}: créneau ${slotDate} trop en amont de slotDateFrom ${dossier.slotDateFrom} (tolérance ${SLOT_FROM_TOLERANCE_DAYS}j) — skip`);
        return false;
      }
      if (slot < from) {
        log("INFO", `[SPAIN-WATCHER] ✅ ${dossier.applicantName}: créneau ${slotDate} avant slotDateFrom ${dossier.slotDateFrom} mais dans la tolérance (${SLOT_FROM_TOLERANCE_DAYS}j) — accepté`);
      }
    }
  }

  if (dossier.slotDateDeadline) {
    const deadline = new Date(dossier.slotDateDeadline);
    if (!isNaN(deadline.getTime()) && slot > deadline) {
      log("INFO", `[SPAIN-WATCHER] ⏭️ ${dossier.applicantName}: créneau ${slotDate} après deadline ${dossier.slotDateDeadline} — skip`);
      return false;
    }
  }

  return true;
}

/**
 * Construit des SlotDiscoveryEvents à partir du résultat d'exploration.
 * Chaque slot exploré = 1 event par dossier actif, groupé par service (office = serviceName).
 * Les dossiers actifs déterminent si un slot est "captured" (dans la fenêtre) ou "ignored" (hors fenêtre).
 * Si aucun dossier actif → pas d'events (pas d'applicationId valide pour Convex).
 */
function buildDiscoveryEventsFromExploration(
  exploration: SlotExplorationResult,
  dossiers: SpainDossier[],
): SlotDiscoveryEvent[] {
  if (dossiers.length === 0) return [];

  const events: SlotDiscoveryEvent[] = [];

  for (const service of exploration.services) {
    for (const slot of service.slots) {
      for (const dossier of dossiers) {
        const inWindow = isSlotInDateWindow(slot.date, dossier);
        events.push({
          applicationId: dossier.applicationId,
          destination: "spain",
          office: service.serviceName || `service_${service.serviceId}`,
          dateFound: slot.date,
          timeFound: slot.time || undefined,
          outcome: inWindow ? "captured" : "ignored",
          reason: inWindow ? undefined : getDateWindowReason(slot.date, dossier),
          context: { serviceId: service.serviceId, freeSlots: slot.freeSlots, applicant: dossier.applicantName },
          mode: "schedule",
        });
      }
    }
  }

  return events;
}

/**
 * Nombre maximum d'events de découverte envoyés par cycle de scan.
 * Garde-fou : 40 créneaux × N dossiers peut exploser en volume. L'envoi est
 * fire-and-forget mais la mutation Convex reste facturée.
 */
const MAX_DISCOVERY_EVENTS_PER_CYCLE = 200;

/**
 * Construit les SlotDiscoveryEvents directement à partir des créneaux du scan
 * (`_allSlots`, produit par datetime/).
 *
 * POURQUOI : l'exploration détaillée (`exploreAvailableSlots`) est optionnelle,
 * lancée en arrière-plan et souvent vide — résultat : l'interface admin
 * « découvertes » ne recevait aucune date alors que le scan en avait confirmé
 * plusieurs dizaines. Les données utilisées ici sont DÉJÀ en mémoire : aucun
 * appel réseau supplémentaire, aucun impact sur la latence de réservation.
 *
 * La déduplication 24h côté Convex (applicationId + office + dateFound +
 * outcome) évite les doublons avec les events issus de l'exploration/booking.
 */
function buildDiscoveryEventsFromScanSlots(
  slots: Array<{ date: string; time: string; agendaId?: string; freeslots: number }>,
  dossiers: SpainDossier[],
  service: { serviceId: string; serviceName: string } | undefined,
): SlotDiscoveryEvent[] {
  if (dossiers.length === 0 || slots.length === 0) return [];

  const office = service?.serviceName || "TRAMITACIÓN DE VISADOS";
  const sorted = [...slots].sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );

  const events: SlotDiscoveryEvent[] = [];
  for (const slot of sorted) {
    if (!slot.date) continue;
    for (const dossier of dossiers) {
      if (events.length >= MAX_DISCOVERY_EVENTS_PER_CYCLE) return events;
      const inWindow = isSlotInDateWindow(slot.date, dossier);
      events.push({
        applicationId: dossier.applicationId,
        destination: "spain",
        office,
        dateFound: slot.date,
        timeFound: slot.time || undefined,
        outcome: inWindow ? "captured" : "ignored",
        reason: inWindow ? undefined : getDateWindowReason(slot.date, dossier),
        context: {
          serviceId: service?.serviceId,
          freeSlots: slot.freeslots,
          agendaId: slot.agendaId,
          applicant: dossier.applicantName,
          source: "scan_datetime",
        },
        mode: "schedule",
      });
    }
  }
  return events;
}

/**
 * Assigne équitablement les créneaux disponibles aux dossiers actifs (round-robin).
 *
 * Algorithme :
 *  1. Trier allSlots par date ASC puis heure ASC.
 *  2. Pour chaque dossier (dans l'ordre), avancer dans la liste triée jusqu'au
 *     prochain créneau éligible (fenêtre date + freeSlots >= groupSize).
 *  3. Si plus de dossiers que de slots disponibles, les dossiers restants reçoivent
 *     le premier créneau éligible depuis le début de la liste (partage).
 *
 * Résultat : Map dossierId → slot assigné.
 * Un dossier absent de la Map n'a pas de créneau éligible dans `allSlots` ;
 * executeHttpBooking fera alors son propre re-scan datetime/ (comportement de repli).
 */
function assignSlotsRoundRobin(
  dossiers: SpainDossier[],
  allSlots: Array<{ date: string; time: string; agendaId?: string; freeslots: number }>,
): Map<string, { date: string; time: string; agendaId?: string }> {
  const assignments = new Map<string, { date: string; time: string; agendaId?: string }>();
  if (allSlots.length === 0 || dossiers.length === 0) return assignments;

  // 1. Trier par date ASC puis heure ASC
  const sorted = [...allSlots].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.time.localeCompare(b.time);
  });

  let slotCursor = 0; // indice courant dans sorted

  for (const dossier of dossiers) {
    const minFree = dossier.groupSize && dossier.groupSize > 1 ? dossier.groupSize : 1;

    // 2a. Chercher le premier créneau éligible depuis slotCursor
    let assigned = false;
    for (let i = slotCursor; i < sorted.length; i++) {
      const slot = sorted[i];
      if (slot.freeslots !== -1 && slot.freeslots < minFree) continue;
      if (!isSlotInDateWindow(slot.date, dossier)) continue;
      assignments.set(dossier.id, { date: slot.date, time: slot.time, agendaId: slot.agendaId });
      slotCursor = i + 1; // le prochain dossier commence après ce créneau
      assigned = true;
      break;
    }

    // 2b. Plus de créneaux inédits — repartir du début (partage de créneau)
    if (!assigned) {
      for (let i = 0; i < sorted.length; i++) {
        const slot = sorted[i];
        if (slot.freeslots !== -1 && slot.freeslots < minFree) continue;
        if (!isSlotInDateWindow(slot.date, dossier)) continue;
        assignments.set(dossier.id, { date: slot.date, time: slot.time, agendaId: slot.agendaId });
        // Pas de mise à jour de slotCursor : les dossiers suivants peuvent choisir un créneau différent
        assigned = true;
        break;
      }
    }

    // Si toujours pas de créneau : aucun slot éligible pour ce dossier dans _allSlots.
    // executeHttpBooking fera son propre re-scan datetime/ comme repli.
  }

  return assignments;
}

/**
 * Détermine la raison d'ignorement pour un slot hors fenêtre.
 */
function getDateWindowReason(slotDate: string, dossier: SpainDossier): string {
  const slot = new Date(slotDate);
  if (isNaN(slot.getTime())) return "invalid_date";

  if (dossier.slotDateFrom) {
    const from = new Date(dossier.slotDateFrom);
    if (!isNaN(from.getTime()) && slot < from) return "before_from_date";
  }
  if (dossier.slotDateDeadline) {
    const deadline = new Date(dossier.slotDateDeadline);
    if (!isNaN(deadline.getTime()) && slot > deadline) return "after_deadline";
  }
  return "out_of_window";
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

export async function startSpainWatcherLoop(): Promise<void> {
  // ─── Guard : désactivation explicite de cette instance ────────────────────
  // Mettre SPAIN_SCAN_DISABLED=1 sur une instance pour qu'elle n'intervienne pas
  // quand une autre instance (ex : Railway) gère déjà le scan Spain.
  // Retirer la variable si Railway est arrêté et que cette instance doit prendre le relai.
  if (process.env.SPAIN_SCAN_DISABLED === "1") {
    log("INFO", "[SPAIN-WATCHER] ⏸️ SPAIN_SCAN_DISABLED=1 — scan Spain désactivé sur cette instance (Railway actif)");
    log("INFO", "[SPAIN-WATCHER]    → Retirer SPAIN_SCAN_DISABLED pour activer ce backup si Railway tombe");
    return;
  }

  const modeLabel = SPAIN_PERSISTENT_BROWSER ? "persistent-browser 🌐" : (SPAIN_HTTP_MODE ? "HTTP-ONLY 🚀" : "Playwright");
  log("INFO", `[SPAIN-WATCHER] Boucle démarrée (mode: ${modeLabel}, auto-booking: Convex dossiers)`);
  if (SPAIN_HTTP_MODE) {
    const decodoConfigured = Boolean(process.env.DECODO_PROXY_URL);
    const soaxConfigured = Boolean(process.env.SOAX_PROXY_URL);
    log(
      "INFO",
      `[SPAIN-WATCHER] HTTP proxy: ` +
      `${decodoConfigured ? "Decodo ISP ✅" : "Decodo ISP ❌ (DECODO_PROXY_URL absent)"}` +
      `${!decodoConfigured && soaxConfigured ? " | SOAX fallback ✅" : ""}`,
    );
  }

  // En mode HTTP ou persistent-browser : initialiser Redis avant le pre-warm
  if (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) {
    // 1. Connecter Redis (persistence CF session + SOAX rotation)
    const redisOk = await initSpainRedis().catch((e) => {
      log("WARN", `[SPAIN-WATCHER] Redis init échoué (non-fatal): ${e}`);
      return false;
    });
    if (redisOk) {
      log("INFO", "[SPAIN-WATCHER] ✅ Redis Spain connecté — session CF persistée entre redéploiements");
    }

    // 2. Restaurer le rotation count SOAX (seulement en mode HTTP-only, pas persistent-browser)
    if (SPAIN_HTTP_MODE && !SPAIN_PERSISTENT_BROWSER) {
      await restoreSpainSoaxStateFromRedis().catch((e) => {
        log("WARN", `[SPAIN-WATCHER] Restauration SOAX rotation échouée (non-fatal): ${e}`);
      });
    }

    // 3. Pre-warm la session CF uniquement si un dossier Espagne peut réellement
    // déclencher un booking. On se base directement sur les dossiers actifs —
    // plus de dépendance au singleton spainWatcher (comme la CEV dossier loop).
    const preWarmDossiers = await getActiveSpainDossiers();
    if (preWarmDossiers.length === 0) {
      log("INFO", "[SPAIN-WATCHER] Pre-warm CF différé — aucun dossier Espagne actif avec identifiants (voir diagnostic ci-dessus)");
    } else {
      const preWarmUrl = preWarmDossiers[0].portalUrl;
      const preWarmLabel = SPAIN_PERSISTENT_BROWSER ? "Chromium persistant" : "proxy Espagne + CapSolver";
      log("INFO", `[SPAIN-WATCHER] Pre-warm session CF pour ${preWarmDossiers.length} dossier(s) → ${preWarmUrl} (${preWarmLabel})…`);
      const session = await ensureActiveSession(preWarmUrl).catch((e) => {
        log("WARN", `[SPAIN-WATCHER] Pre-warm CF échoué: ${e} — retry au prochain cycle`);
        return null;
      });
      if (session) {
        log("INFO", `[SPAIN-WATCHER] ✅ Session CF prête (expire: ${new Date(session.expiresAt).toISOString()})`);
      }
    }
  }

  while (true) {
    try {
      const cycleStartedAt = Date.now();

      // ─── Commandes admin (rush-prep : CF re-solve / session pre-warm) ─────────
      if (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) {
        const cmd = await pollRushPrepCommand().catch(() => null);
        if (cmd) {
          log("INFO", `[SPAIN-WATCHER] 🎯 Commande admin reçue: ${cmd}`);
          try {
            if (cmd === "cf_resolve") {
              // Re-solve CF session proactif immédiat
              const configForCmd = await getSpainWatcherConfig().catch(() => null);
              const dossierList = await getActiveSpainDossiers();
              const urlForCmd = configForCmd?.portalUrl || dossierList[0]?.portalUrl || "";
              if (!urlForCmd) throw new Error("Aucune portalUrl disponible pour le re-solve CF");
              const session = await ensureActiveSession(urlForCmd);
              if (!session) throw new Error("ensureActiveSession a retourné null");
              log("INFO", `[SPAIN-WATCHER] ✅ Re-solve CF OK (expire: ${new Date(session.expiresAt).toISOString()})`);
              await ackRushPrepCommand("ok");
            } else if (cmd === "session_prep") {
              // Pré-créer la isolated booking session pour chaque dossier actif
              const cfSession = getActiveSession();
              if (!cfSession) throw new Error("Pas de session CF active — lancez d'abord un re-solve CF");
              const dossierList = await getActiveSpainDossiers();
              if (dossierList.length === 0) throw new Error("Aucun dossier Espagne actif");
              let ok = 0;
              for (const d of dossierList) {
                const iso = await createIsolatedBookingSession(cfSession, d.portalUrl).catch((e: unknown) => {
                  log("WARN", `[SPAIN-WATCHER] session_prep/${d.applicantName}: ${e}`);
                  return null;
                });
                if (iso) ok++;
              }
              if (ok === 0) throw new Error("Toutes les sessions isolées ont échoué");
              log("INFO", `[SPAIN-WATCHER] ✅ session_prep OK — ${ok}/${dossierList.length} session(s) pré-créée(s)`);
              await ackRushPrepCommand("ok");
            }
          } catch (cmdErr: unknown) {
            const msg = cmdErr instanceof Error ? cmdErr.message : String(cmdErr);
            log("WARN", `[SPAIN-WATCHER] ❌ Commande ${cmd} échouée: ${msg}`);
            await ackRushPrepCommand(`error: ${msg}`).catch(() => {});
          }
        }
      }

      // Aucun dossier actif = aucun besoin de scanner ni de résoudre Cloudflare.
      // getActiveSpainDossiers + getSpainWatcherConfig en parallèle (indépendants).
      const [activeDossiers, singletonConfig] = await Promise.all([
        getActiveSpainDossiers(),
        getSpainWatcherConfig().catch(() => null),
      ]);

      if (activeDossiers.length === 0) {
        log("INFO", "[SPAIN-WATCHER] Aucun dossier Espagne actif — probe différé de 2 min");
        await new Promise((r) => setTimeout(r, 2 * 60_000));
        continue;
      }

      // portalUrl = premier dossier actif (tous partagent la même ambassade)
      const portalUrl = activeDossiers[0].portalUrl;

      // Intervalle : singleton spainWatcher optionnel pour override, sinon env var
      const configuredHttpIntervalSec = singletonConfig?.intervalSec ?? SPAIN_HTTP_SCAN_INTERVAL_SEC;
      const intervalMs = (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)
        ? Math.max(10, configuredHttpIntervalSec) * 1000
        : (singletonConfig?.intervalMin ?? 3) * 60_000;

      const cycleModeLabel = SPAIN_PERSISTENT_BROWSER ? "PB" : (SPAIN_HTTP_MODE ? "HTTP" : "PW");

      // ─── Re-solve proactif AVANT le lock ──────────────────────────────────────
      // Le solve Turnstile prend 30–90s. Si on le fait DANS le lock (TTL=50s),
      // Redis auto-expire le lock mid-solve → collision avec Railway possible.
      // On résout ici, sans lock, puis on acquiert le lock uniquement pour le probe.
      //
      // Rate-limit : PROACTIVE_RETRY_COOLDOWN_MS entre deux tentatives.
      // Sans ça, un solve échoué serait retenté toutes les 10s pendant 10 min,
      // bloquant le scan lock sur chaque tentative.
      if ((SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) && isActiveSessionExpiringSoon()) {
        const sinceLastAttempt = Date.now() - lastProactiveAttemptAt;
        if (sinceLastAttempt < PROACTIVE_RETRY_COOLDOWN_MS) {
          log(
            "INFO",
            `[SPAIN-WATCHER] ⏰ Re-solve proactif différé (cooldown: ${Math.ceil((PROACTIVE_RETRY_COOLDOWN_MS - sinceLastAttempt) / 60_000)}min)`,
          );
        } else {
          log("INFO", "[SPAIN-WATCHER] ⏰ Cookie CF expire bientôt → re-solve proactif conditionnel (hors lock)");
          lastProactiveAttemptAt = Date.now();
          const renewed = await tryRenewActiveSession(portalUrl).catch((e: unknown) => {
            log("WARN", `[SPAIN-WATCHER] Re-solve proactif échoué: ${e}`);
            return null;
          });
          // Réinitialise le cooldown si le renouvellement a réussi.
          // La nouvelle session (~115 min) ne déclenchera plus isActiveSessionExpiringSoon()
          // pendant longtemps — le compteur ne sert qu'à protéger les cycles suivants si B échoue.
          if (renewed && !isActiveSessionExpiringSoon()) {
            lastProactiveAttemptAt = 0;
          }
        }
      }

      // ─── Distributed lock : une seule instance scanne à la fois ─────────────
      // Évite que Railway et Replit scannent simultanément avec le même proxy IP,
      // ce qui amène CF à retourner /main/ body vide pour l'un des deux.
      if (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) {
        const lockAcquired = await acquireSpainScannerLock();
        if (!lockAcquired) {
          log("INFO", `[SPAIN-WATCHER] [${cycleModeLabel}] 🔒 Verrou détenu par une autre instance — cycle ignoré (retry dans ${Math.round(intervalMs / 1000)}s)`);
          const elapsed = Date.now() - cycleStartedAt;
          const wait = Math.max(0, intervalMs - elapsed);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
      }

      let scanLockReleased = false;
      const releaseScanLock = async () => {
        if (!scanLockReleased) {
          scanLockReleased = true;
          await releaseSpainScannerLock();
        }
      };

      log("INFO", `[SPAIN-WATCHER] [${cycleModeLabel}] Probe → ${portalUrl} | ${activeDossiers.length} dossier(s) actif(s) | intervalle: ${Math.round(intervalMs / 1000)}s`);

      // Exécuter le probe selon le mode
      // persistent-browser utilise le même probe HTTP que SPAIN_HTTP_MODE
      // (la session CF vient du Chromium persistant mais les scans restent HTTP-only)
      const result = (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)
        ? await runSpainHttpProbe(portalUrl)
        : await runSpainWatcherProbe(portalUrl);

      // Libérer le verrou dès que le probe est terminé (avant le booking)
      await releaseScanLock();

      log(
        "INFO",
        `[SPAIN-WATCHER] [${cycleModeLabel}] Résultat: ${result.status}${result.slotInfo ? ` — ${result.slotInfo}` : ""}${result.errorMessage ? ` (${result.errorMessage})` : ""}`,
      );

      // ─── Pool IP épuisé : toutes les IPs Decodo sont bloquées par Bookitit ──
      // Le bloc Bookitit est typiquement transitoire (quelques minutes).
      // Inutile de recréditer le pool toutes les 10s — on attend 5 min avant de retenter.
      if (result.status === "ip_pool_blocked") {
        const backoffMs = 5 * 60_000;
        log("WARN", `[SPAIN-WATCHER] 🚫 IP pool épuisé (Bookitit block) — backoff ${backoffMs / 60_000} min avant retry`);
        await reportSpainWatcherScan({
          status: "error",
          errorMessage: result.errorMessage,
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }

      // ─── DIAGNOSTIC: quand found, toujours extraire et logger les services ──
      // Permet de vérifier si c'est un vrai créneau (services rendus) ou un faux positif
      let detectedServicesJson: string | undefined;
      let detectedSlotsJson: string | undefined;
      // Promise de l'exploration lancée en arrière-plan quand un créneau est trouvé.
      // Initialisée à null ; attendue après le booking pour le reporting Convex.
      // Cela évite que 5–15s d'exploration bloquent le booking pendant la pointe.
      let explorationPromise: Promise<SlotExplorationResult | null> = Promise.resolve(null);
      if (
        (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) &&
        result.status === "found" &&
        (result as any)._mainHtml
      ) {
        const mainHtml = (result as any)._mainHtml as string;

        // ─── Sources de services : HTML rendu OU getservices/ JSONP ───────────
        // Le portail Bookitit rend la liste des services côté client (SPA) :
        // /main/ ne contient AUCUN lien #selectservice. Le scanner a déjà
        // récupéré les services via getservices/ et les expose dans `_services` ;
        // les ignorer produisait un faux « FAUX POSITIF » + le skip de tous les
        // dossiers (« aucun service ne matche … parmi:  » avec liste vide).
        const htmlServices = extractServicesFromHtml(mainHtml);
        const probeServices = ((result as any)._services ?? []) as ExtractedSlotInfo[];
        const byId = new Map<string, ExtractedSlotInfo>();
        for (const svc of [...htmlServices, ...probeServices]) {
          if (svc?.serviceId && !byId.has(svc.serviceId)) byId.set(svc.serviceId, svc);
        }
        const diagServices = [...byId.values()];
        if (htmlServices.length === 0 && probeServices.length > 0) {
          log("INFO", `[SPAIN-WATCHER] ℹ️ 0 lien #selectservice dans le HTML (rendu SPA) → services repris de getservices/ : ${probeServices.map((s) => `"${s.serviceName}" (${s.serviceId})`).join(", ")}`);
        }
        if (diagServices.length > 0) {
          detectedServicesJson = JSON.stringify(diagServices.map(s => ({ serviceId: s.serviceId, serviceName: s.serviceName })));
          const targetService = diagServices.find((svc) => /tramita|visados|visa/i.test(svc.serviceName || "")) ?? null;
          log("INFO", `[SPAIN-WATCHER] ✅ CRÉNEAU CONFIRMÉ — ${diagServices.length} service(s) connu(s) :`);
          for (const svc of diagServices) {
            log("INFO", `[SPAIN-WATCHER]    🎯 "${svc.serviceName}" → serviceId: ${svc.serviceId}`);
          }
          if (targetService) {
            log("INFO", `[SPAIN-WATCHER] 🎯 SERVICE CIBLE (visa) détecté : "${targetService.serviceName}" → serviceId: ${targetService.serviceId}`);
          }

          // ─── EXPLORATION: lancée en arrière-plan — ne bloque plus le booking ──
          // Pendant la pointe les créneaux durent <30s ; l'exploration (5–15s sur
          // serveur chargé) bloquait le booking. On lance la promise ici, on l'await
          // après le booking uniquement pour le reporting Convex.
          const cfSessionExplore = getActiveSession();
          explorationPromise = cfSessionExplore
            ? exploreAvailableSlots(cfSessionExplore, portalUrl, diagServices).catch((exploreErr: unknown) => {
                log("WARN", `[SPAIN-WATCHER] ⚠️ Exploration slots échouée (non-fatal): ${exploreErr}`);
                return null;
              })
            : Promise.resolve(null);
        } else {
          log("WARN", `[SPAIN-WATCHER] ⚠️ Créneau confirmé par datetime/ MAIS aucun service connu (ni HTML ni getservices/) — booking impossible`);
          // Log un extrait du HTML pour diagnostic
          const renderedHtml = mainHtml.replace(/<script\s+type=['"]text\/template['"][^>]*>[\s\S]*?<\/script>/gi, "");
          const containerMatch = renderedHtml.match(/idDivBktServicesContainer[^>]*>([\s\S]{0,500})/i);
          if (containerMatch) {
            log("INFO", `[SPAIN-WATCHER]    Container preview: ${containerMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`);
          }
        }

        const cfSession = getActiveSession();

        if (!cfSession) {
          log("WARN", "[SPAIN-WATCHER] ❌ Auto-booking impossible — pas de session CF active");
        } else {
          // 1. Récupérer les dossiers Espagne actifs depuis Convex
            const dossiers = activeDossiers;

          if (dossiers.length === 0) {
            log("INFO", "[SPAIN-WATCHER] ⚠️ Créneau trouvé mais aucun dossier Espagne actif dans Convex — alerte email seule");
          } else {
            log("INFO", `[SPAIN-WATCHER] 🚀 AUTO-BOOKING DÉCLENCHÉ — ${dossiers.length} dossier(s) actif(s) à traiter`);

            // 2. Services disponibles (HTML rendu + getservices/ JSONP)
            const services = diagServices;
            log("INFO", `[SPAIN-WATCHER]    Services Bookitit disponibles: ${services.map((s) => `"${s.serviceName}" (${s.serviceId})`).join(", ") || "aucun"}`);

            // 3. Les dossiers bookent SÉQUENTIELLEMENT (voir bloc « Booking séquentiel »
            //    plus bas). createIsolatedBookingSession() n'isole réellement le
            //    PHPSESSID qu'en mode HTTP/impit pur ; en mode capsolver — celui utilisé
            //    en production — le PHPSESSID est lié au solve CF et donc partagé entre
            //    tous les dossiers, ce qui interdit le parallélisme.
            //    Ce coût séquentiel est assumé : l'objectif n'est pas de booker tous les
            //    dossiers sur un même cycle, mais d'en sécuriser un proprement — les
            //    autres repasseront au cycle suivant.
            // Date réellement confirmée par datetime/ (undefined si non extractible).
            // Ne jamais retomber sur "aujourd'hui" pour targetDate : cela ferait
            // booker une date inexistante. Le fallback ne sert qu'aux logs Convex.
            const confirmedSlotDate = (result as any).slot?.date || result.slotInfo?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || undefined;
            const confirmedSlotTime = (result as any).slot?.time || undefined;
            const slotDateForLog = confirmedSlotDate ?? new Date().toISOString().slice(0, 10);

            // ─── Assignation round-robin des créneaux ────────────────────────────
            // Distribue équitablement les créneaux disponibles entre les dossiers :
            // dossierA → slot[0], dossierB → slot[1], dossierC → slot[2]…
            // Evite que tous les dossiers tentent le même premier créneau (race condition).
            const scanAllSlots = (result as any)._allSlots as
              | Array<{ date: string; time: string; agendaId?: string; freeslots: number }>
              | undefined;

            const slotAssignments = scanAllSlots && scanAllSlots.length > 0
              ? assignSlotsRoundRobin(dossiers, scanAllSlots)
              : new Map<string, { date: string; time: string; agendaId?: string }>();

            if (scanAllSlots && scanAllSlots.length > 0) {
              log("INFO", `[SPAIN-WATCHER] 📊 Round-robin: ${scanAllSlots.length} créneau(x) disponible(s) pour ${dossiers.length} dossier(s)`);
              for (const dossier of dossiers) {
                const a = slotAssignments.get(dossier.id);
                log("INFO", `[SPAIN-WATCHER]    ${dossier.applicantName} → ${a ? `${a.date} ${a.time}` : "repli datetime/"}`);
              }
            }

            // ─── Booking séquentiel ───────────────────────────────────────────────
            // En mode capsolver, tous les dossiers partagent le même PHPSESSID (lié
            // au solve CF). getsigninfields/ est stateful par PHPSESSID côté serveur :
            // appels simultanés → N-1 dossiers reçoivent 0B. Testé et confirmé.
            //
            // Choix assumé : le surcoût (~3,5-4,5 s par dossier) est négligeable face au
            // risque. Réserver un créneau proprement pour un dossier vaut mieux que de
            // brûler N sessions en parallèle ; les dossiers non servis sont repris au
            // cycle suivant, le round-robin ci-dessus évitant qu'ils visent tous le même
            // créneau.
            // ─────────────────────────────────────────────────────────────────────

            // Capacité restante par créneau (clé = "date_time").
            // freeslots=-1 → capacité inconnue → on tente quand même.
            const slotFreeslots = new Map<string, number>(
              (scanAllSlots ?? []).map((s) => [`${s.date}_${s.time}`, s.freeslots]),
            );
            const bookedCountBySlot = new Map<string, number>();

            const bookDossier = async (dossier: SpainDossier) => {
              const matched = matchServiceForVisa(services, dossier.visaType);

              if (!matched) {
                log("WARN", `[SPAIN-WATCHER] ⚠️ ${dossier.applicantName}: aucun service ne matche "${dossier.visaType}" — skip`);
                await sendHeartbeat({
                  applicationId: dossier.applicationId,
                  result: "not_found",
                  errorMessage: `Créneau détecté mais aucun service Bookitit ne correspond au visa "${dossier.visaType}"`,
                }).catch(() => {});
                return;
              }

              // Récupérer le créneau assigné par le round-robin (peut être absent
              // si _allSlots était vide ou aucun slot éligible pour ce dossier).
              const assignedSlot = slotAssignments.get(dossier.id);

              log("INFO", `[SPAIN-WATCHER] 📋 ${dossier.applicantName}: booking "${matched.serviceName}" (${matched.serviceId}) pour "${dossier.visaType}"${assignedSlot ? ` → créneau pré-assigné ${assignedSlot.date} ${assignedSlot.time}` : " → re-scan datetime/"}`);

              // ── Skip si toutes les places du créneau sont déjà prises ce cycle ──
              if (assignedSlot) {
                const slotKey = `${assignedSlot.date}_${assignedSlot.time}`;
                const freeslots = slotFreeslots.get(slotKey) ?? -1;
                const alreadyBooked = bookedCountBySlot.get(slotKey) ?? 0;
                if (freeslots !== -1 && alreadyBooked >= freeslots) {
                  log("INFO", `[SPAIN-WATCHER] ⏭ ${dossier.applicantName}: créneau ${assignedSlot.date} ${assignedSlot.time} complet (${alreadyBooked}/${freeslots} places prises) — skip`);
                  await sendHeartbeat({
                    applicationId: dossier.applicationId,
                    result: "not_found",
                    errorMessage: `Créneau ${assignedSlot.date} ${assignedSlot.time} complet (${freeslots} place(s), déjà prise(s) ce cycle)`,
                  }).catch(() => {});
                  return;
                }
              }

              const bookingConfig: SpainBookingConfig = {
                login: dossier.login,
                password: dossier.password,
                applicationId: dossier.applicationId,
                otpChannel: dossier.otpChannel,
                applicantName: dossier.applicantName,
                targetServiceId: matched.serviceId,
                visaType: dossier.visaType,
                groupSize: dossier.groupSize,
                // Le scanner a déjà validé services + date via getservices//datetime/.
                // Les transmettre évite de refaire ces appels pendant le booking :
                // au pic, un créneau vit quelques secondes, chaque aller-retour compte.
                availableServices: services,
                targetDate: assignedSlot?.date ?? confirmedSlotDate,
                targetTime: assignedSlot?.time ?? confirmedSlotTime,
              };

              try {
                const bookingResult = await executeHttpBooking(
                  cfSession,
                  portalUrl,
                  mainHtml,
                  bookingConfig,
                );

                log(
                  "INFO",
                  `[SPAIN-WATCHER] 📋 ${dossier.applicantName}: ${bookingResult.status}${bookingResult.locator ? ` — locator: ${bookingResult.locator}` : ""}${bookingResult.errorMessage ? ` (${bookingResult.errorMessage})` : ""} (${bookingResult.durationMs}ms)`,
                );

                if (bookingResult.status === "booked") {
                  // ── Décrémenter la capacité locale du créneau ──
                  if (assignedSlot) {
                    const slotKey = `${assignedSlot.date}_${assignedSlot.time}`;
                    bookedCountBySlot.set(slotKey, (bookedCountBySlot.get(slotKey) ?? 0) + 1);
                  }

                  // ── 0. Report slot discovery outcome: BOOKED ──
                  reportSlotDiscoveryBatch([{
                    applicationId: dossier.applicationId,
                    destination: "spain",
                    office: matched.serviceName,
                    // Date réellement réservée en priorité (cohérence avec le calendrier admin).
                    dateFound: bookingResult.bookedDate ?? assignedSlot?.date ?? slotDateForLog,
                    timeFound: bookingResult.bookedTime ?? assignedSlot?.time ?? undefined,
                    outcome: "captured",
                    context: { locator: bookingResult.locator, serviceId: matched.serviceId },
                    mode: "schedule",
                  }]);

                  // ── 1. Upload + attach PDF de confirmation ──
                  if (bookingResult.confirmationPdf) {
                    try {
                      const b64 = bookingResult.confirmationPdf.toString("base64");
                      const pdfStorageId = (await uploadFile(b64, "application/pdf")) ?? undefined;
                      if (pdfStorageId) {
                        await attachConfirmationDoc({
                          applicationId: dossier.applicationId,
                          storageId: pdfStorageId,
                          docKey: "booking_confirmation_pdf",
                          label: "Confirmation de rendez-vous Espagne (PDF)",
                        });
                        log("INFO", `[SPAIN-WATCHER] 📄 ${dossier.applicantName}: PDF confirmation uploadé et attaché au dossier`);
                      }
                    } catch (pdfErr) {
                      log("WARN", `[SPAIN-WATCHER] ⚠️ ${dossier.applicantName}: PDF upload/attach échoué (non-fatal): ${pdfErr}`);
                    }
                  }

                  // ── 2. Report slot found to Convex (marque le dossier comme "slot_found") ──
                  // IMPORTANT (calendrier admin) : `appointmentDetails.date` alimente
                  // directement getCalendarData. Envoyer `result.slotInfo` (phrase de log)
                  // rendait la date inexploitable dans le calendrier. On utilise donc la
                  // date/heure réellement soumises au portail, avec repli sur le créneau
                  // assigné par le round-robin puis sur celui confirmé par le scan.
                  const appointmentDate =
                    bookingResult.bookedDate ?? assignedSlot?.date ?? confirmedSlotDate;
                  const appointmentTime =
                    bookingResult.bookedTime ?? assignedSlot?.time ?? confirmedSlotTime ?? "";

                  if (!appointmentDate) {
                    log("WARN", `[SPAIN-WATCHER] ⚠️ ${dossier.applicantName}: booking confirmé mais date introuvable — calendrier non alimenté`);
                  }

                  await reportSlotFound({
                    applicationId: dossier.applicationId,
                    date: appointmentDate ?? "unknown",
                    time: appointmentTime,
                    location: bookingResult.bookedServiceName
                      ? `Ambassade d'Espagne Kinshasa — ${bookingResult.bookedServiceName}`
                      : "Ambassade d'Espagne Kinshasa",
                    confirmationCode: bookingResult.locator,
                    screenshotStorageId: undefined,
                  }).catch((e) => log("WARN", `[SPAIN-WATCHER] reportSlotFound error: ${e}`));

                  log("INFO", `[SPAIN-WATCHER] 📆 ${dossier.applicantName}: rendez-vous enregistré ${appointmentDate ?? "?"} ${appointmentTime} (calendrier admin)`);

                  // Préfixer slotInfo avec la confirmation (écriture synchrone — pas de race en JS)
                  result.slotInfo = `✅ BOOKING CONFIRMÉ pour ${dossier.applicantName} ! Locator: ${bookingResult.locator ?? "N/A"} | ${result.slotInfo}`;
                } else {
                  // ── Report slot discovery outcome: FAILED ──
                  reportSlotDiscoveryBatch([{
                    applicationId: dossier.applicationId,
                    destination: "spain",
                    office: matched.serviceName,
                    dateFound: slotDateForLog,
                    outcome: "ignored",
                    reason: `booking_failed_${bookingResult.status}`,
                    context: { errorMessage: bookingResult.errorMessage, serviceId: matched.serviceId },
                    mode: "schedule",
                  }]);

                  await sendHeartbeat({
                    applicationId: dossier.applicationId,
                    result: "error",
                    errorMessage: `Booking échoué: ${bookingResult.status} — ${bookingResult.errorMessage ?? ""}`,
                  }).catch(() => {});
                }
              } catch (bookErr) {
                log("WARN", `[SPAIN-WATCHER] ❌ ${dossier.applicantName}: booking erreur: ${bookErr}`);
                await sendHeartbeat({
                  applicationId: dossier.applicationId,
                  result: "error",
                  errorMessage: `Exception booking: ${bookErr}`,
                }).catch(() => {});
              }
            };

            for (const dossier of dossiers) await bookDossier(dossier);
          }
        }
      }

      // ─── Tableau des créneaux pour l'alerte admin (coût zéro) ────────────────
      // `_allSlots` est déjà en mémoire (produit par le scan datetime/) : le
      // sérialiser ne coûte aucun appel réseau et garantit que l'email admin
      // contient le tableau date/heure/places même si l'exploration échoue ou
      // n'a pas été lancée. L'exploration, plus détaillée, écrase cette valeur
      // si elle aboutit.
      const probeAllSlots = (result as any)._allSlots as
        | Array<{ date: string; time: string; agendaId?: string; freeslots: number }>
        | undefined;
      if (probeAllSlots && probeAllSlots.length > 0) {
        const serviceLabel = detectedServicesJson
          ? (JSON.parse(detectedServicesJson) as Array<{ serviceId: string; serviceName: string }>)[0]
          : undefined;
        detectedSlotsJson = JSON.stringify([{
          id: serviceLabel?.serviceId ?? "",
          name: serviceLabel?.serviceName ?? "Créneaux détectés",
          slots: [...probeAllSlots]
            .sort((a, b) => (a.date.localeCompare(b.date) || a.time.localeCompare(b.time)))
            .slice(0, 40)
            .map((s) => ({ d: s.date, t: s.time, n: s.freeslots })),
        }]);

        // ─── Enregistrement des dates découvertes (interface admin) ───────────
        // Source = créneaux déjà en mémoire → aucun appel réseau ajouté au
        // chemin critique ; l'envoi lui-même est fire-and-forget.
        const scanDiscoveryEvents = buildDiscoveryEventsFromScanSlots(
          probeAllSlots,
          activeDossiers,
          serviceLabel,
        );
        if (scanDiscoveryEvents.length > 0) {
          reportSlotDiscoveryBatch(scanDiscoveryEvents);
          log(
            "INFO",
            `[SPAIN-WATCHER] 🗂️ ${scanDiscoveryEvents.length} date(s) découverte(s) enregistrée(s) depuis le scan (${scanDiscoveryEvents.filter((e) => e.outcome === "captured").length} captured, ${scanDiscoveryEvents.filter((e) => e.outcome === "ignored").length} ignored)`,
          );
        }
      }

      // ─── Résultats exploration (attendus après le booking) ───────────────────
      // explorationPromise = Promise.resolve(null) si pas de créneau (not_found/error).
      const exploration = await explorationPromise;
      if (exploration) {
        // Ne pas écraser le tableau issu du scan si l'exploration n'a rien trouvé.
        if (exploration.totalSlots > 0 || !detectedSlotsJson) {
          detectedSlotsJson = serializeExplorationForConvex(exploration);
        }
        const logLines = formatExplorationForLogs(exploration);
        for (const line of logLines) {
          log("INFO", line);
        }
        if (exploration.totalSlots > 0) {
          const discoveryEvents = buildDiscoveryEventsFromExploration(exploration, activeDossiers);
          if (discoveryEvents.length > 0) {
            reportSlotDiscoveryBatch(discoveryEvents);
            log("INFO", `[SPAIN-WATCHER] 📊 ${discoveryEvents.length} slot discovery event(s) reporté(s) (${discoveryEvents.filter(e => e.outcome === "captured").length} captured, ${discoveryEvents.filter(e => e.outcome === "ignored").length} ignored)`);
          }
        }
      }

      // ─── Report scan result to Convex ──────────────────────────────────
      let screenshotStorageId: string | undefined;
      if ((result.status === "found" || result.status === "not_found") && result.screenshotBase64) {
        screenshotStorageId = await uploadFile(result.screenshotBase64, "image/png") ?? undefined;
      }

      await reportSpainWatcherScan({
        status: result.status,
        slotInfo: result.slotInfo,
        screenshotStorageId,
        errorMessage: result.errorMessage,
        detectedServices: detectedServicesJson,
        detectedSlots: detectedSlotsJson,
      });

      // L'intervalle désigne le temps entre deux débuts de probe, pas le délai
      // ajouté après la fin du probe. Sinon un probe de 35s produisait un cycle
      // réel de 95s malgré le log "intervalle: 60s".
      const nextWaitMs = Math.max(0, intervalMs - (Date.now() - cycleStartedAt));
      log("INFO", `[SPAIN-WATCHER] Prochain probe dans ${Math.ceil(nextWaitMs / 1000)}s (cadence départ-à-départ)`);
      await new Promise((r) => setTimeout(r, nextWaitMs));
    } catch (err) {
      // Libérer le verrou en cas d'exception imprévue
      await releaseSpainScannerLock();
      log("WARN", `[SPAIN-WATCHER] Erreur boucle: ${err} — retry dans ${SPAIN_HTTP_MODE ? "1" : "5"} min`);
      await new Promise((r) => setTimeout(r, SPAIN_HTTP_MODE ? 60_000 : 5 * 60_000));
    }
  }
}
