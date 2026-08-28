/**
 * spain-dossier-worker.ts — Agent autonome par dossier (Task #52)
 *
 * Chaque worker est une instance isolée pour un seul dossier :
 *   1. Réserve une IP Decodo dédiée (Redis NX, TTL 30 min)
 *   2. PROBE portail via impit dédié (même proxy) → capture HTML challenge CF
 *   3. Solve CF via CapSolver EN PASSANT le HTML capturé → cf_clearance lié à l'empreinte TLS impit
 *   4. Utilise le MÊME impit (session._ownImpit) pour toutes les requêtes suivantes
 *   5. Initialise PHPSESSID via GET + POST token
 *   6. Boucle de scan toutes les ~10 s pendant WORKER_WINDOW_MS (25 min) :
 *        /main/ → getservices/ → getagendas/ → datetime/ mois courant+suivants
 *        → créneau éligible ? → Lua Redis atomic claim → executeHttpBooking
 *   7. Sort après booking réussi ou fin de fenêtre.
 *
 * ISOLATION GARANTIES :
 *   - IP dédiée : chaque worker réserve son index Decodo avec Redis NX
 *   - Impit dédié : même instance pour le probe CF + toutes les requêtes suivantes
 *     (TLS fingerprint cohérent → le cf_clearance CapSolver est valide avec impit)
 *   - PHPSESSID dédié : initPortalSession() crée une session PHP propre par worker
 *   - Slot atomique : tryClaimSlot() = Lua SETNX avec capacité groupSize
 */

import {
  solveSpainCloudflare,
  createImpitWithProxy,
  initWorkerSession,
  spainCfFetch,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import {
  buildDynamicSession,
  callDirect,
  makeDirectUrl,
  makeDirectHeaders,
  CALL_DIRECT_NETWORK_ERROR,
  type DynamicSession,
} from "./spain-bookitit-direct.js";
import {
  type SpainBookingResult,
} from "./spain-http-booking.js";
import { confirmSlotsViaDatetime } from "./spain-http-scanner.js";
import {
  tryClaimSlot,
  releaseSlotClaim,
  reserveWorkerIp,
  isIpReservedByOther,
  releaseWorkerIp,
  publishSlotSnapshot,
} from "./spain-slot-coordinator.js";
import { buildSlotAssignment } from "./spain-slot-assignment.js";
import {
  getDecodoProxyForIndex,
  getDecodoPoolSize,
  getDecodoCurrentIndex,
  flagDecodoIp,
  isDecodoIpBlacklisted,
  rotateDecodoUrl,
  initDecodoPool,
} from "./spain-decodo-pool.js";
import {
  saveLastProxyForDossier,
  getLastProxyForDossier,
  saveLastStickyForDossier,
  getLastStickyForDossier,
  deleteLastStickyForDossier,
  tryAcquireBookingSlot,
  releaseBookingSlot,
  MAX_CONCURRENT_BOOKERS,
} from "./spain-redis-persistence.js";
import {
  reportSlotFound,
  sendHeartbeat,
  reportSlotDiscoveryBatch,
  reportSpainWatcherScan,
  attachConfirmationDoc,
  uploadFile,
  reportBookingLog,
  type SlotDiscoveryEvent,
} from "./convexClient.js";
import { log } from "./scheduler-utils.js";

// ─── Sticky session helper ────────────────────────────────────────────────────

/**
 * Injecte un identifiant de session sticky Decodo dans l'URL proxy.
 * Format Decodo résidentiel : user-{id}-session-{sid}-sessionduration-60
 *
 * CRITIQUE : sans session sticky, impit et CapSolver ouvrent deux connexions TCP
 * différentes → deux exit IP différentes → le cf_clearance de CapSolver est lié
 * à l'exit IP CapSolver, pas à celle d'impit → GET impit avec ce cf_clearance
 * reçoit HTTP 403. Source de vérité : ensureSpainImpitSession l.908-910.
 */
function addStickySession(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch { return url; }
}

/**
 * Supprime le sticky session ID du username Decodo pour obtenir la BASE URL.
 * Ex: http://user-sp4e4cx19x-session-abc123-sessionduration-60:pass@es.decodo.com:10005
 *   → http://user-sp4e4cx19x-sessionduration-60:pass@es.decodo.com:10005
 *
 * Utilisé avant saveLastProxyForDossier pour persister la BASE URL, pas la sticky URL.
 * Sans ça, deux windows peuvent générer des clés Redis différentes pour le même port
 * (base URL vs sticky URL) → double réservation → IP partagée entre dossiers.
 */
function stripStickySession(url: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    if (!user.includes("-session-")) return url; // déjà base URL
    const baseUser = user.replace(/-session-[^-]+-/, "-"); // retire -session-{id}-
    u.username = encodeURIComponent(baseUser);
    // URL.toString() ajoute un "/" final sur les URLs sans path — le retirer pour
    // que la base URL sauvegardée corresponde au format des URLs CSV (sans slash).
    const result = u.toString();
    return (u.pathname === "/" && !url.endsWith("/")) ? result.replace(/\/$/, "") : result;
  } catch { return url; }
}

// ─── Types publics ────────────────────────────────────────────────────────────

export interface SpainDossierConfig {
  id: string;
  applicantName: string;
  visaType: string;
  login: string;
  password: string;
  applicationId: string;
  otpChannel: "email" | "sms" | "manual";
  portalUrl: string;
  slotDateFrom?: string;
  slotDateDeadline?: string;
  groupSize?: number;
  /** Priorité manuelle pour la distribution P4 (0 = premier choix) */
  spainPriorityIndex?: number;
  /** Nombre total de dossiers actifs sur ce portail (pour la distribution P4) */
  activeDossierCount?: number;
  /** Index de ce dossier dans la liste triée (0-based, déterministe) */
  dossierIndex?: number;
}

export interface WorkerResult {
  dossierId: string;
  status: "booked" | "exited" | "error";
  errorMessage?: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Fenêtre de surveillance par dossier (25 min) — alignée TTL cf_clearance */
const WORKER_WINDOW_MS = ((): number => {
  const v = Number(process.env.SPAIN_WORKER_WINDOW_MIN ?? "20");
  return (Number.isFinite(v) ? v : 20) * 60_000;
})();

/**
 * Minute absolue de fin de fenêtre dans l'heure courante (défaut: 25 → HH:25:00).
 * La boucle de scan s'arrête à cette borne quel que soit le moment du démarrage du worker.
 * Ainsi un restart à HH:28 n'étend pas la fenêtre : le worker sort immédiatement.
 * Override : SPAIN_WINDOW_END_MIN
 */
const WINDOW_END_MIN = ((): number => {
  const v = Number(process.env.SPAIN_WINDOW_END_MIN ?? "20");
  return Math.max(1, Math.min(59, Number.isFinite(v) ? Math.round(v) : 20));
})();

/** Intervalle de scan start-to-start (secondes → ms) */
const SCAN_INTERVAL_MS = ((): number => {
  const s = Number(process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "10");
  return Math.max(5, Number.isFinite(s) ? s : 10) * 1_000;
})();

// ─── V2 Adaptive Scan Intervals ──────────────────────────────────────────────

/** Intervalle warm-up : HH:05 → HH:10 (60s entre cycles) */
const SCAN_WARMUP_INTERVAL_MS = 60_000;

/** Intervalle normal : HH:10 → détection (10s, identique à l'actuel) */
const SCAN_NORMAL_INTERVAL_MS = SCAN_INTERVAL_MS;

/** Intervalle rapide : après détection, workers en attente de place sémaphore (2-3s) */
const SCAN_FAST_INTERVAL_MS = 2_500;

/** Intervalle hyper-rapide : à partir de HH:12 (pic de publication) → 1s entre cycles */
const SCAN_HYPERFAST_INTERVAL_MS = 1_000;

/** Minute (UTC) à partir de laquelle on passe en scan hyper-rapide (1s) */
const HYPERFAST_START_MINUTE = 12;

/**
 * Détermine l'intervalle de scan adaptatif selon la phase du cycle.
 *
 * Phases :
 *   - Warm-up   (HH:05 → HH:10) : 60s — init PHP, CF cache chaud
 *   - Normal    (HH:10 → HH:12) : 10s — scan actif, en attente de publication
 *   - Hyperfast (HH:12+)        : 1s  — pic de publication, on scanne au max
 *   - Fast      (après détection, sémaphore plein) : 2-3s — cycle complet rapide
 *
 * @param slotsDetectedThisWindow  true si des slots ont été vus dans cette fenêtre horaire
 * @param holdingBookingSlot       true si ce worker est armé (a acquis le sémaphore)
 */
function getAdaptiveScanInterval(slotsDetectedThisWindow: boolean, holdingBookingSlot: boolean): number {
  if (holdingBookingSlot) {
    // Worker armé = en cours de booking, pas de scan interval (il ne scanne plus)
    return SCAN_NORMAL_INTERVAL_MS;
  }
  if (slotsDetectedThisWindow) {
    // Slots détectés mais ce worker attend sa place au sémaphore → scan rapide
    return SCAN_FAST_INTERVAL_MS;
  }
  // Pas encore de détection — adapter selon la minute dans l'heure (UTC)
  const minInHour = new Date().getUTCMinutes();
  if (minInHour < 10) {
    return SCAN_WARMUP_INTERVAL_MS; // HH:05 → HH:10 = warm-up 60s
  }
  if (minInHour >= HYPERFAST_START_MINUTE) {
    return SCAN_HYPERFAST_INTERVAL_MS; // HH:12+ = pic de publication, scan 1s
  }
  return SCAN_NORMAL_INTERVAL_MS; // HH:10 → HH:12 = scan normal 10s
}

/** Tolérance slotDateFrom (jours) — identique au watcher legacy */
const SLOT_FROM_TOLERANCE_DAYS = ((): number => {
  const raw = Number(process.env.SPAIN_SLOT_FROM_TOLERANCE_DAYS ?? "45");
  return Number.isFinite(raw) ? Math.round(raw) : 45;
})();

/** Nombre de mois à scanner via datetime/ (mois courant + N suivants) */
const DATETIME_MONTHS_AHEAD = ((): number => {
  const v = Number(process.env.SPAIN_DATETIME_MONTHS_AHEAD ?? "4");
  return Math.max(1, Number.isFinite(v) ? v : 4);
})();

const MAX_DISCOVERY_EVENTS_PER_CYCLE = 60;

/**
 * Mode Race : quand le nombre total de créneaux distincts détectés dans un cycle
 * est ≤ ce seuil, on SKIP le lock Redis et tous les workers foncent en parallèle.
 * Le serveur Bookitit est l'arbitre final (premier summary/ qui passe gagne).
 * Les perdants recevront "seleccionada por otra persona" → fallback au prochain candidat.
 *
 * Quand > seuil : mode normal (Redis claim atomique empêche la collision inter-dossiers).
 */
const RACE_MODE_SLOT_THRESHOLD = 5;

/**
 * Seuil "assez de places" pour BYPASSER le sémaphore de booking.
 *
 * Le sémaphore (MAX_CONCURRENT_BOOKERS) sert à éviter les réponses 0B du serveur
 * Bookitit quand trop de signin/ frappent LA MÊME place simultanément (collision).
 *
 * Mais quand il y a AUTANT de places libres que de bookers potentiels, il n'y a
 * pas de collision : chaque worker (via distribution P4) vise une place différente.
 * Dans ce cas, brider à 5 bookers fait perdre un temps énorme — tous les workers qui
 * ont une place attribuée doivent pouvoir booker immédiatement.
 *
 * NB : on compte les PLACES réelles (somme des freeslots), pas les créneaux.
 * Un créneau peut offrir plusieurs places : 14 créneaux × 2 places = 28 places.
 *
 * Règle : si totalFreeCapacity >= ce seuil → skip sémaphore, tous foncent en parallèle.
 * Configurable via SPAIN_SEMAPHORE_BYPASS_SLOTS (défaut : MAX_CONCURRENT_BOOKERS = 5).
 */
const SEMAPHORE_BYPASS_SLOT_THRESHOLD = ((): number => {
  const v = Number(process.env.SPAIN_SEMAPHORE_BYPASS_SLOTS ?? String(MAX_CONCURRENT_BOOKERS));
  return Math.max(1, Number.isFinite(v) ? Math.round(v) : MAX_CONCURRENT_BOOKERS);
})();

/**
 * Pre-publication proxy refresh : à la minute PREPUB_REFRESH_MINUTE de chaque heure,
 * chaque worker force une rotation de proxy frais + re-solve CF.
 * Objectif : arriver à la fenêtre de publication (min 13-14) avec un proxy tout neuf.
 * Valeur 11 → refresh à XX:11, prêt pour XX:13.
 */
const PREPUB_REFRESH_MINUTE = 11;

// ─── Détection erreur proxy ────────────────────────────────────────────────────

/**
 * Détecte si une chaîne d'erreur correspond à un proxy injoignable (connexion refusée,
 * timeout, erreur proxy CapSolver). Utilisée pour blacklister l'IP Decodo dès le
 * solve CF initial (pas seulement lors d'un scan 0B).
 *
 * Cas connus :
 *  - impit : "ECONNREFUSED", "ECONNRESET", "proxy", "connect"
 *  - CapSolver : "ERROR_PROXY_*", "custom proxy connect", "proxy connect", "proxy refused"
 */
function isProxyConnectError(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return (
    m.includes("error_proxy") ||
    m.includes("proxy connect") ||
    m.includes("proxy refused") ||
    m.includes("custom proxy") ||
    m.includes("econnrefused") ||
    m.includes("econnreset") ||
    m.includes("epipe") ||
    m.includes("proxy timeout") ||
    m.includes("connect timeout")
  );
}

// ─── Types internes ───────────────────────────────────────────────────────────

interface WorkerSlot {
  date: string;
  time: string;
  agendaId?: string;
  freeslots: number;
}

interface WorkerScanResult {
  status: "found" | "not_found" | "error" | "ajax_unavailable" | "proxy_error" | "session_dead" | "cf_expired";
  slots?: WorkerSlot[];
  mainHtml?: string;
  serviceId?: string;
  serviceName?: string;
  agendaId?: string;
  errorMessage?: string;
  /** DynamicSession du cycle courant — à utiliser pour getsigninfields/ et signin/
   *  car son jar contient le PHPSESSID frais créé par refreshSessionAndScan. */
  ds?: import("./spain-bookitit-direct.js").DynamicSession;
  /** Trace par mois — bytes/slots/ok pour chaque appel datetime/ */
  monthTraces?: Array<{ month: string; bytes: number; slots: number; ok: boolean }>;
}

/**
 * Trace complète d'un cycle de scan — sérialisée en JSON dans spainWatcherScans.scanTrace.
 * Doit rester compatible avec SpainScanTraceData dans BotLogs.tsx (mêmes champs).
 */
interface WorkerSpainTrace {
  /** Solve CF : nouveau ou réutilisé depuis cache Redis */
  solver?: { reused: boolean; ms: number };
  /** IP Decodo utilisée */
  ip?: { index: number; total: number; proxy: string };
  main?: {
    bytes: number; ok: boolean;
    serviceContainer: boolean; dialogConfirm: boolean;
    isSpa?: boolean; idSvcText?: boolean; fromCache?: boolean;
  };
  initConfig?: { bytes: number; ok: boolean };
  service?: {
    bytes: number; ok: boolean; count: number; names?: string;
    allowAppointment?: boolean; serviceContainer?: boolean; dialogConfirm?: boolean;
  };
  agendas: Array<{ serviceId: string; serviceName: string; bytes: number; ok: boolean; agendaId?: string }>;
  datetimes: Array<{ serviceId: string; serviceName: string; month: string; bytes: number; slots: number; ok: boolean }>;
  bookings: Array<{ applicant: string; status: string; detail?: string; ms?: number; gsfBytes?: number; signinBytes?: number; bktToken?: string; locator?: string }>;
  ipRotations: number;
  /** Durée réelle du cycle de scan (ms) — datetime/ uniquement */
  scanMs?: number;
}

/** Extrait les signaux SPA Bookitit du HTML /main/ */
function parseMainSignals(html: string) {
  const h = html ?? "";
  return {
    serviceContainer: h.includes("idBktDefaultServicesTextBeforeServicesList") || h.includes("bktDefaultServicesContainer"),
    dialogConfirm: h.includes("dialog-confirm") || h.includes("dialogConfirm") || h.includes("bktDialogConfirm"),
    isSpa: h.includes("bookitit") || h.includes("bktDefault"),
    idSvcText: h.includes("idBktDefaultServicesTextBeforeServicesList"),
  };
}

// ─── PHP State (init one-shot, partagé entre tous les cycles) ─────────────────

export interface WorkerPhpState {
  services: Array<{ serviceId: string; serviceName: string }>;
  agendaId: string;
  bestServiceId: string;
  bestServiceName: string;
  /** Valeur réelle du champ AllowAppointment retourné par getservices/ (null = absent du payload) */
  allowAppointment: boolean | null;
  /** DynamicSession partagé — même impit + reqCounter pour tous les appels impit directs */
  ds: DynamicSession;
  /** Trace des appels d'init — transmise dans scanTrace de chaque cycle */
  _trace?: {
    cfgBytes: number;
    svcBytes: number;
    svcStr: string;
    agBytes: number;
  };
}

/**
 * Initialise l'état PHP Bookitit une seule fois par session.
 * Reproduit exactement la section 3 de test-bookitit-dynamic.ts :
 *   getwidgetconfigurations/ → getservices/ → getagendas/
 *
 * RÈGLE §9 : getagendas/ ne peut être appelé qu'UNE FOIS par PHPSESSID.
 * Ensuite, les cycles de scan n'appellent QUE datetime/ — pas de réinit.
 */
export async function initPhpState(
  session: SpainCfSession,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerPhpState | null> {
  // Construit la DynamicSession — même impit + jar + jqCallback que initWorkerSession.
  // Tous les appels Bookitit passent par callDirect() pour éviter les différences de
  // headers de callBookititEndpoint/spainCfFetch qui causent 0B sur getservices/.
  const ds = buildDynamicSession(session);
  if (!ds) {
    log("WARN", `${tag} initPhpState: bookititState ou _ownImpit absent`);
    return null;
  }

  // 1. getwidgetconfigurations/ — initialise le widget PHP côté serveur
  const cfgPayload = await callDirect(ds, "getwidgetconfigurations/", undefined, tag);
  const cfgBytes = JSON.stringify(cfgPayload ?? "").length;

  // 2. getservices/ — une seule réponse par PHPSESSID (règle identique à getagendas/)
  const svcPayload = await callDirect(ds, "getservices/", undefined, tag) as any;
  const svcBytes = JSON.stringify(svcPayload ?? "").length;
  const svcStr = JSON.stringify(svcPayload ?? "");

  // Lire AllowAppointment depuis le payload top-level (même logique que spain-http-scanner.ts)
  const rawAllow = svcPayload?.AllowAppointment ?? svcPayload?.allowAppointment;
  const allowAppointment: boolean | null = rawAllow !== undefined
    ? (rawAllow === true || rawAllow === "true" || rawAllow === 1 || rawAllow === "1")
    : null;
  if (allowAppointment === false) {
    log("WARN", `${tag} initPhpState: getservices/ → AllowAppointment=false (portail fermé aux RDV?)`);
  } else {
    log("INFO", `${tag} initPhpState: AllowAppointment=${allowAppointment === null ? "absent" : allowAppointment}`);
  }

  const rawServices: Array<{ id: string; name: string }> =
    svcPayload?.Services ?? svcPayload?.services ?? [];

  const services = rawServices
    .filter((s) => s?.id)
    .map((s) => ({
      serviceId: String(s.id),
      serviceName: (s.name ?? "").replace(/<[^>]*>/g, "").trim(),
    }));

  if (services.length === 0) {
    log("WARN", `${tag} initPhpState: getservices/ → 0 services`);
    return null;
  }

  // Prioriser un service avec nom non-vide (comme test-bookitit-dynamic.ts l.195)
  const bestSvc = services.find((s) => s.serviceName.length > 0) ?? services[0];
  log("INFO", `${tag} 🎯 PHP init: ${services.length} service(s) → cible "${bestSvc.serviceName}" (${bestSvc.serviceId})`);

  // 3. getagendas/ — une seule réponse par PHPSESSID (Règle §9)
  const agPayload = await callDirect(ds, "getagendas/", {
    "services[]": bestSvc.serviceId,
    selectedPeople: "1",
  }, tag) as any;

  const rawAgendas: Array<{ id: string }> =
    agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = rawAgendas.find((a) => a?.id)?.id ?? "";
  const agBytes = JSON.stringify(agPayload ?? "").length;

  log("INFO", `${tag} ✅ PHP init OK — agenda=${agendaId || "(vide)"} | cycles suivants: datetime/ direct`);

  return {
    services, agendaId, bestServiceId: bestSvc.serviceId, bestServiceName: bestSvc.serviceName,
    allowAppointment, ds,
    _trace: { cfgBytes, svcBytes, svcStr, agBytes },
  };
}

/**
 * Un cycle de scan direct — appelle UNIQUEMENT datetime/ avec le phpState déjà initialisé.
 * Reproduit la section 4 de test-bookitit-dynamic.ts (boucle mois par mois).
 *
 * @returns WorkerScanResult   — slots trouvés, not_found, ou proxy_error
 * @returns proxy_error        — toutes les requêtes datetime/ ont échoué en réseau (proxy CONNECT cassé)
 */
export async function scanDatetimeDirect(
  phpState: WorkerPhpState,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerScanResult> {
  const ds = phpState.ds;

  const now = new Date();
  const allSlots: WorkerSlot[] = [];
  const monthTraces: Array<{ month: string; bytes: number; slots: number; ok: boolean }> = [];
  let globalMaxDays: Date | null = null;
  let consecutiveEmpty = 0;
  const MAX_MONTHS = Math.max(DATETIME_MONTHS_AHEAD + 2, 12); // ≥ 12 comme le test dynamic

  let monthOffset = 0;
  let networkErrorCount = 0; // Compteur d'erreurs réseau (ProxyTunnelError, Timeout, etc.)
  let httpNullCount = 0;     // Compteur de réponses HTTP 0B légitimes (payload null, pas sentinel)
  let monthsChecked = 0;

  while (monthOffset < MAX_MONTHS) {
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    // Premier mois : start = date du jour pour ne pas rater les créneaux en milieu de mois.
    // Mois suivants : start = 1er du mois (scan complet).
    const startDay = monthOffset === 0 ? String(now.getDate()).padStart(2, "0") : "01";
    const startStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${startDay}`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const endStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const extra: Record<string, string> = {
      "services[]": phpState.bestServiceId,
      start: startStr,
      end: endStr,
      // selectedPeople toujours "1" dans le scan — on veut TOUS les créneaux visibles.
      // Le filtrage par groupSize se fait côté notre code (extractAllSlotsFromPayload + Redis).
      selectedPeople: "1",
    };
    if (phpState.agendaId) extra["agendas[]"] = phpState.agendaId;

    const raw = await callDirect(ds, "datetime/", extra, tag);
    monthsChecked++;

    // Distinguer erreur réseau (sentinel) d'une réponse HTTP vide légitime (null).
    // ProxyTunnelError/Timeout → CALL_DIRECT_NETWORK_ERROR.
    // Réponse 0B serveur (pas de créneau, agenda absent) → null.
    const isNetworkError = raw === CALL_DIRECT_NETWORK_ERROR;
    if (isNetworkError) {
      networkErrorCount++;
    } else if (raw === null) {
      httpNullCount++;
    }

    const payload = isNetworkError ? null : raw;
    const rawBytes = JSON.stringify(payload ?? "").length;

    const dtData = payload as any;
    const maxDaysRaw: string = dtData?.maxDays ?? "";
    if (maxDaysRaw?.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const parsed = new Date(maxDaysRaw + "T23:59:59");
      if (!globalMaxDays || parsed > globalMaxDays) globalMaxDays = parsed;
    }

    const slots = extractAllSlotsFromPayload(payload, phpState.agendaId, config.groupSize ?? 1);
    log(
      "INFO",
      `${tag}   ${monthLabel}: ${slots.length > 0 ? slots.length + " créneau(x)" : isNetworkError ? "0 (err réseau)" : payload === null ? "0 (0B)" : "0 (vide)"}  | maxDays=${maxDaysRaw || "(absent)"}`,
    );

    // Trace par mois — 0B = null payload (normal quand aucun créneau), ok si non-null
    monthTraces.push({ month: monthLabel, bytes: rawBytes, slots: slots.length, ok: !isNetworkError && payload !== null });

    if (slots.length > 0) {
      allSlots.push(...slots);
      consecutiveEmpty = 0;
    } else {
      consecutiveEmpty++;
    }

    monthOffset++;

    // Stop condition identique au test dynamic (section 4 l.288-304)
    if (monthOffset >= 2 && globalMaxDays) {
      const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
      if (firstOfNextMonth > globalMaxDays) {
        log("INFO", `${tag}   ⏹ fin : ${firstOfNextMonth.toISOString().slice(0, 10)} > maxDays ${globalMaxDays.toISOString().slice(0, 10)}`);
        break;
      }
    }
    if (!globalMaxDays && consecutiveEmpty >= 3) {
      log("WARN", `${tag}   ⏹ 3 mois vides sans maxDays — arrêt`);
      break;
    }
  }

  // Cas 1 — Proxy CONNECT cassé : toutes les requêtes ont levé une exception réseau.
  // UNIQUEMENT sur le sentinel, jamais sur réponses HTTP vides légitimes.
  if (monthsChecked >= 2 && networkErrorCount === monthsChecked) {
    log("WARN", `${tag}   ⚠️ Proxy CONNECT cassé — ${networkErrorCount}/${monthsChecked} mois en erreur réseau → rotation IP`);
    return {
      status: "proxy_error",
      serviceId: phpState.bestServiceId,
      serviceName: phpState.bestServiceName,
      monthTraces,
    };
  }

  // Cas 2 — Session PHP morte : agenda présent mais datetime/ retourne 0B HTTP sur tous les mois.
  // Si agendaId est absent le serveur retourne 0B normalement → pas de faux positif.
  // Si agendaId est présent le serveur DOIT retourner du JSONP valide → 0B = session expirée.
  if (monthsChecked >= 2 && phpState.agendaId && httpNullCount === monthsChecked) {
    log("WARN", `${tag}   ⚠️ Session PHP morte — agendaId présent mais ${httpNullCount}/${monthsChecked} mois → 0B HTTP → réinit PHPSESSID`);
    return {
      status: "session_dead",
      serviceId: phpState.bestServiceId,
      serviceName: phpState.bestServiceName,
      monthTraces,
    };
  }

  if (allSlots.length === 0) {
    return {
      status: "not_found",
      serviceId: phpState.bestServiceId,
      serviceName: phpState.bestServiceName,
      monthTraces,
    };
  }

  allSlots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  return {
    status: "found",
    slots: allSlots,
    serviceId: phpState.bestServiceId,
    serviceName: phpState.bestServiceName,
    agendaId: phpState.agendaId,
    ds: phpState.ds,   // ← propagé pour que le booking utilise le bon PHPSESSID
    monthTraces,
  };
}

// ─── Cycle complet par itération (GET token → POST → main → cfg → svc → ag → dt) ──

/**
 * Effectue un cycle de scan complet en obtenant un NOUVEAU PHPSESSID à chaque appel.
 *
 * Réutilise le même impit + cf_clearance (pas de re-solve CF).
 * Si GET widget retourne 403 (CF challenge) → status "cf_expired".
 * Si getagendas/ retourne vide → "not_found" (pas de créneau actuellement).
 * Si datetime/ trouve des slots → "found".
 *
 * FLOW :
 *   1. GET widget → token CSRF (utilise cf_clearance existant)
 *   2. POST token → nouveau PHPSESSID + srvsrc
 *   3. GET /main/ (JSONP)
 *   4. getwidgetconfigurations/
 *   5. getservices/ → trouver le service avec nom non-vide
 *   6. getagendas/ → si vide = not_found
 *   7. datetime/ (multi-mois) → found ou not_found
 */
export async function refreshSessionAndScan(
  session: SpainCfSession,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerScanResult> {
  const impit = session._ownImpit;
  if (!impit) {
    return { status: "error", errorMessage: "refreshSessionAndScan: _ownImpit absent", monthTraces: [] };
  }

  const targetUrl = config.portalUrl.split("#")[0];
  const UA = session.userAgent;
  const cfClearance = session.cfClearance;

  // Helpers
  const extractCookies = (headers: { get: (k: string) => string | null }): Record<string, string> => {
    const result: Record<string, string> = {};
    const raw = headers.get("set-cookie") ?? "";
    for (const part of raw.split(/,(?=[^ ])/)) {
      const m = part.trim().match(/^([^=]+)=([^;]*)/);
      if (m) result[m[1].trim()] = m[2];
    }
    return result;
  };
  const buildCookieStr = (jar: Record<string, string>): string =>
    Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");

  // Cookie jar : cf_clearance + cookies existants (sauf PHPSESSID qu'on veut frais)
  const jar: Record<string, string> = {};
  for (const c of session.allCookies) {
    if (c.name !== "PHPSESSID") jar[c.name] = c.value;
  }
  if (cfClearance) jar.cf_clearance = cfClearance;

  // ── 1. GET widget → token ───────────────────────────────────────────────────
  let token = "";
  try {
    const r = await (impit.fetch(targetUrl, {
      headers: { "User-Agent": UA, "Cookie": buildCookieStr(jar) },
    } as any) as unknown as Promise<Response>);
    const body = await r.text();
    Object.assign(jar, extractCookies(r.headers as any));
    const isCf = r.status === 403 || /just a moment|_cf_chl_opt/i.test(body.slice(0, 3000));
    if (isCf) {
      log("WARN", `${tag} ① GET widget → CF challenge (HTTP ${r.status}, ${body.length}B) → cf_expired`);
      return { status: "cf_expired", errorMessage: "CF challenge sur GET widget", monthTraces: [] };
    }
    token = body.match(/name="token"\s+value="([^"]+)"/i)?.[1] ?? "";
    if (!token) {
      log("WARN", `${tag} ① GET widget → token absent (HTTP ${r.status}, ${body.length}B)`);
      return { status: "error", errorMessage: `Token absent (HTTP ${r.status}, ${body.length}B)`, monthTraces: [] };
    }
    log("INFO", `${tag} ① token ✅`);
  } catch (e) {
    log("WARN", `${tag} ① GET widget → erreur réseau: ${e}`);
    return { status: "proxy_error", errorMessage: `GET widget: ${e}`, monthTraces: [] };
  }

  // ── 2. POST token → PHPSESSID + srvsrc ──────────────────────────────────────
  const baseHost = new URL(targetUrl).origin;
  let srvsrc = baseHost;
  let version = "4";
  try {
    const r = await (impit.fetch(targetUrl, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": buildCookieStr(jar),
        "Referer": targetUrl,
        "Origin": baseHost,
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Promise<Response>);
    const body = await r.text();
    Object.assign(jar, extractCookies(r.headers as any));
    srvsrc = body.match(/srvsrc:\s*'([^']+)'/)?.[1] ?? baseHost;
    version = body.match(/loadermaec\.js\?v=(\d+)/)?.[1] ?? "4";
    if (!jar.PHPSESSID) {
      log("WARN", `${tag} ② POST → PHPSESSID absent`);
      return { status: "error", errorMessage: "PHPSESSID absent après POST", monthTraces: [] };
    }
    log("INFO", `${tag} ② PHPSESSID=${jar.PHPSESSID.slice(0, 8)}…`);
  } catch (e) {
    log("WARN", `${tag} ② POST → erreur: ${e}`);
    return { status: "proxy_error", errorMessage: `POST token: ${e}`, monthTraces: [] };
  }

  // ── 3-7. Construire DynamicSession et faire cfg → svc → ag → dt ─────────────
  const publickey = targetUrl.match(/widgetdefault\/([^/?#]+)/)?.[1] ?? "";
  const bookititBase = `${baseHost}/onlinebookings`;
  const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let reqCounter = Date.now();

  // Mettre à jour session.allCookies avec le nouveau PHPSESSID pour buildDynamicSession
  session.allCookies = Object.entries(jar).filter(([, v]) => v).map(([name, value]) => ({ name, value }));
  session.bookititState = {
    jqCallback,
    reqCounter,
    srvsrc,
    version,
    widgetUrl: targetUrl.endsWith("/") ? targetUrl : targetUrl + "/",
    publickey,
    bookititBase,
  };

  // GET /main/ via DynamicSession
  const ds = buildDynamicSession(session);
  if (!ds) {
    return { status: "error", errorMessage: "buildDynamicSession échoué", monthTraces: [] };
  }

  // 3. GET /main/
  const mainUrl = makeDirectUrl(ds, "main/");
  const mainHeaders = makeDirectHeaders(ds);
  try {
    const r = await (ds.impit.fetch(mainUrl, { headers: mainHeaders } as any) as unknown as Promise<Response>);
    const body = await r.text();
    // Merge Set-Cookie (PHPSESSID peut être renouvelé)
    const newCookies = extractCookies(r.headers as any);
    Object.assign(ds.jar, newCookies);
    if (newCookies.PHPSESSID) jar.PHPSESSID = newCookies.PHPSESSID;
    if (body.length < 1000) {
      log("WARN", `${tag} ③ /main/ → ${body.length}B (trop court) → proxy_error`);
      return { status: "proxy_error", errorMessage: `/main/ ${body.length}B`, monthTraces: [] };
    }
    log("INFO", `${tag} ③ /main/ → ${Math.round(body.length / 1024)}kB ✅`);
  } catch (e) {
    log("WARN", `${tag} ③ /main/ → erreur: ${e}`);
    return { status: "proxy_error", errorMessage: `/main/: ${e}`, monthTraces: [] };
  }

  // 4. getwidgetconfigurations/
  await callDirect(ds, "getwidgetconfigurations/", undefined, tag);

  // 5. getservices/
  const svcPayload = await callDirect(ds, "getservices/", undefined, tag) as any;
  if (svcPayload === CALL_DIRECT_NETWORK_ERROR) {
    log("WARN", `${tag} ⑤ getservices/ → erreur réseau`);
    return { status: "proxy_error", errorMessage: "getservices/ network error", monthTraces: [] };
  }
  const rawServices: Array<{ id: string; name: string }> =
    svcPayload?.Services ?? svcPayload?.services ?? [];
  const services = rawServices.filter((s) => s?.id).map((s) => ({
    serviceId: String(s.id),
    serviceName: (s.name ?? "").replace(/<[^>]*>/g, "").trim(),
  }));
  if (services.length === 0) {
    log("WARN", `${tag} ⑤ getservices/ → 0 services (${JSON.stringify(svcPayload ?? "").length}B)`);
    return { status: "error", errorMessage: "getservices/ 0 services", monthTraces: [] };
  }
  const bestSvc = services.find((s) => s.serviceName.length > 0) ?? services[0];
  log("INFO", `${tag} ⑤ svc=${services.length} → "${bestSvc.serviceName.slice(0, 25)}" (${bestSvc.serviceId})`);

  // 6. getagendas/
  const agPayload = await callDirect(ds, "getagendas/", {
    "services[]": bestSvc.serviceId,
    selectedPeople: "1",
  }, tag) as any;
  if (agPayload === CALL_DIRECT_NETWORK_ERROR) {
    log("WARN", `${tag} ⑥ getagendas/ → erreur réseau`);
    return { status: "proxy_error", errorMessage: "getagendas/ network error", monthTraces: [] };
  }
  const rawAgendas: Array<{ id: string }> = agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = rawAgendas.find((a) => a?.id)?.id ?? "";

  if (!agendaId) {
    // Pas de créneau — comportement attendu quand le portail est fermé
    log("INFO", `${tag} ⑥ agenda=(vide) — pas de créneau`);
    return {
      status: "not_found",
      serviceId: bestSvc.serviceId,
      serviceName: bestSvc.serviceName,
      monthTraces: [{ month: "ag", bytes: JSON.stringify(agPayload ?? "").length, slots: 0, ok: true }],
    };
  }

  log("INFO", `${tag} ⑥ agenda=${agendaId} ✅ → datetime/`);

  // 7. datetime/ (multi-mois) — réutilise scanDatetimeDirect avec le phpState frais
  const phpState: WorkerPhpState = {
    services,
    agendaId,
    bestServiceId: bestSvc.serviceId,
    bestServiceName: bestSvc.serviceName,
    allowAppointment: null,
    ds,
  };
  return scanDatetimeDirect(phpState, config, tag);
}

// ─── Entrée publique ──────────────────────────────────────────────────────────

/**
 * Lance le worker autonome pour un dossier.
 * Résout en WorkerResult quand le worker sort (booking, fin fenêtre, ou erreur).
 */
export async function runDossierWorker(
  config: SpainDossierConfig,
): Promise<WorkerResult> {
  const tag = `[WORKER:${config.applicantName.slice(0, 18)}]`;
  log("INFO", `${tag} ▶ Démarrage worker autonome — portalUrl: ${config.portalUrl.slice(-40)}`);

  // ── 0. Init pool Decodo (index aléatoire si Redis absent) ────────────────────
  await initDecodoPool();

  // ── 0b. Calcul anticipé de windowEnd — AVANT toute init ─────────────────────
  // Doit être fait ici, pas après l'init session, sinon si l'init dure trop longtemps
  // et qu'il reste < 60s avant HH:WINDOW_END_MIN, le fallback WORKER_WINDOW_MS prolonge
  // la fenêtre de 20 min supplémentaires (bug "dépasse HH:25").
  //
  // SPAIN_BYPASS_WINDOW=1 : mode test — fenêtre relative à now (pas HH:25).
  const bypassWindow = process.env.SPAIN_BYPASS_WINDOW === "1";
  const windowEndEarly = (() => {
    if (bypassWindow) {
      return Date.now() + WORKER_WINDOW_MS;
    }
    const now = new Date();
    return new Date(
      now.getFullYear(), now.getMonth(), now.getDate(),
      now.getHours(), WINDOW_END_MIN, 0, 0,
    ).getTime();
  })();
  if (!bypassWindow && windowEndEarly <= Date.now()) {
    log("WARN", `${tag} ⏰ Fenêtre HH:${String(WINDOW_END_MIN).padStart(2, "0")} déjà expirée au démarrage — exit immédiat`);
    return { dossierId: config.id, status: "exited" };
  }
  // Si moins de 3 min avant la fin de fenêtre → pas la peine d'init
  if (!bypassWindow && windowEndEarly - Date.now() < 3 * 60_000) {
    log("WARN", `${tag} ⏰ Moins de 3 min avant HH:${String(WINDOW_END_MIN).padStart(2, "0")} — skip init`);
    return { dossierId: config.id, status: "exited" };
  }
  if (bypassWindow) {
    log("INFO", `${tag} 🧪 SPAIN_BYPASS_WINDOW=1 — fenêtre test ${WORKER_WINDOW_MS / 60_000} min depuis maintenant`);
  }

  // ── 1. Réserver une IP Decodo dédiée ────────────────────────────────────────
  let proxyUrl = await pickDedicatedProxy(config.id, tag);
  if (proxyUrl === null) {
    const msg = "Aucune IP Decodo disponible — toutes réservées";
    log("WARN", `${tag} ❌ ${msg}`);
    return { dossierId: config.id, status: "error", errorMessage: msg };
  }

  // ── try/finally : garantit la libération de l'IP même si une exception surgit ──
  // Toute sortie de la fonction (return, throw, exception async) passe par le finally.
  // proxyUrl = "" → mode direct sans proxy → pas de réservation à libérer.
  let workerResult: WorkerResult = { dossierId: config.id, status: "error", errorMessage: "init" };
  // V2 : déclaré ici (pas dans le try) pour être accessible dans le finally
  let holdingBookingSlot = false;
  // true seulement si le sémaphore Redis a réellement été acquis (INCR). Reste false
  // quand le sémaphore est bypassé (assez de créneaux) → on ne fait PAS de releaseBookingSlot
  // pour ne pas décrémenter un compteur jamais incrémenté.
  let usedSemaphore = false;
  try {

  const capsolverKey =
    process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
  if (!capsolverKey) {
    workerResult = {
      dossierId: config.id,
      status: "error",
      errorMessage: "CAPSOLVER_API_KEY manquante",
    };
    return workerResult;
  }

  // ── 2-5. Session complète via initWorkerSession ──────────────────────────────
  // Reproduit exactement le bloc capsolver-residential de ensureSpainImpitSession :
  // sticky session → probe (UA+Accept) → CapSolver (html+proxy+UA) → GET portail
  // (token+PHPSESSID) → POST token (srvsrc+version) → GET /main/ (validation).
  // Même impit pour toutes les étapes = cohérence TLS = cf_clearance valide.
  //
  // Rotation : si initWorkerSession échoue (proxy bloqué ou /main/ 0B), on flag
  // le port, on libère, on prend le suivant — max MAX_SESSION_RETRIES tentatives.
  const portalUrlNoFrag = config.portalUrl.split("#")[0];
  const MAX_SESSION_RETRIES = 3;

  let session: SpainCfSession | null = null;
  let cfFromCache = false;
  let solveT0 = Date.now();

  // Première tentative : récupérer le stickyId de la session précédente pour réutiliser
  // la même exit IP Decodo → cf_clearance Redis encore valide → CapSolver évité.
  // CRITIQUE : le cf_clearance CapSolver est lié à l'exit IP RÉELLE (pas au host:port).
  // Même port Decodo + nouveau stickyId = nouvelle exit IP = clearance invalide → re-solve.
  const lastStickyId = await getLastStickyForDossier(config.id).catch(() => null);
  if (lastStickyId) {
    log("INFO", `${tag} ♻️ StickyId précédent récupéré (${lastStickyId}) — même exit IP attendue → CF cache potentiel`);
  }

  for (let attempt = 0; attempt < MAX_SESSION_RETRIES; attempt++) {
    if (!proxyUrl) break; // mode direct sans proxy

    // Sticky session : même exit IP pour impit ET CapSolver.
    // Sur la 1ère tentative, réutiliser l'ancien stickyId pour préserver l'exit IP
    // et donc la validité du cf_clearance en cache Redis (TTL 2h).
    // Sur les tentatives suivantes (échec), générer un nouveau stickyId aléatoire.
    const stickyId = (attempt === 0 && lastStickyId) ? lastStickyId : Math.random().toString(36).slice(2, 10);
    const stickyProxy = addStickySession(proxyUrl, stickyId);
    const cacheHint = (attempt === 0 && lastStickyId) ? " [CF cache possible]" : " [nouveau sticky]";
    log("INFO", `${tag} 🔐 Session init (tentative ${attempt + 1}/${MAX_SESSION_RETRIES})${cacheHint} — ${maskProxy(stickyProxy)} sid=${stickyId}`);
    solveT0 = Date.now(); // reset per attempt

    const result = await initWorkerSession(stickyProxy, portalUrlNoFrag, capsolverKey);

    if (result) {
      session = result.session;
      cfFromCache = result.cfFromCache;
      // proxyUrl = stickyProxy pour que le finally libère la bonne URL
      proxyUrl = stickyProxy;
      // Mémoriser le stickyId réussi → réutilisable à la prochaine fenêtre (TTL 2h)
      await saveLastStickyForDossier(config.id, stickyId).catch(() => {});
      log("INFO", `${tag} ✅ Session établie — PHPSESSID ✅ | /main/ ${session.prefetchedMainHtml?.length ?? 0}B | cfFromCache=${cfFromCache}`);
      break;
    }

    // Échec → flag + libérer + prendre le suivant
    log("WARN", `${tag} ❌ initWorkerSession échoué — flag + rotation (tentative ${attempt + 1})`);
    flagDecodoIp(proxyUrl, "init-session-failed");
    await releaseWorkerIp(proxyUrl, config.id).catch(() => {});

    // Si c'était la tentative avec l'ancien stickyId (attempt 0 + lastStickyId),
    // l'invalider immédiatement : le port vient d'être blacklisté et les fenêtres
    // suivantes ne doivent pas réinjecter ce stickyId sur un autre port (exit IP
    // différente → CF clearance invalide → re-solve inutile).
    if (attempt === 0 && lastStickyId) {
      await deleteLastStickyForDossier(config.id).catch(() => {});
      log("INFO", `${tag} 🗑️ StickyId invalidé (port blacklisté) — prochain solve sera frais`);
    }

    const nextProxy = await pickDedicatedProxy(config.id, tag);
    if (!nextProxy) { log("WARN", `${tag} Pool Decodo épuisé`); proxyUrl = ""; break; }
    proxyUrl = nextProxy;
  }

  if (!session) {
    workerResult = { dossierId: config.id, status: "error", errorMessage: "Impossible d'établir session après retries" };
    return workerResult;
  }

  // ── Trace de session : solver (timing → cache ou nouveau solve) + main/ signals ──
  const solveMs = Date.now() - solveT0;
  const mainHtml = session.prefetchedMainHtml ?? "";
  const mainSigs = parseMainSignals(mainHtml);
  const workerTrace: WorkerSpainTrace = {
    solver: {
      reused: cfFromCache,
      ms: solveMs,
    },
    ip: { index: 0, total: 6000, proxy: maskProxy(proxyUrl) },
    main: {
      bytes: mainHtml.length,
      ok: mainHtml.length > 1000,
      serviceContainer: mainSigs.serviceContainer,
      dialogConfirm: mainSigs.dialogConfirm,
      isSpa: mainSigs.isSpa,
      idSvcText: mainSigs.idSvcText,
    },
    agendas: [],
    datetimes: [],
    bookings: [],
    ipRotations: 0,
  };

  // ── 6. PHP init one-shot ────────────────────────────────────────────────────
  // Reproduit la section 3 de test-bookitit-dynamic.ts : getwidget/ + getservices/ + getagendas/.
  // UNE SEULE FOIS par session PHP (règle §9 Bookitit).
  // Les cycles suivants n'appellent QUE datetime/ — même comportement que le test dynamique A-à-Z.
  log("INFO", `${tag} 🔧 PHP init one-shot (getwidgetconfigurations/ + getservices/ + getagendas/)…`);
  let phpState = await initPhpState(session, config, tag);
  if (!phpState) {
    workerResult = { dossierId: config.id, status: "error", errorMessage: "initPhpState: aucun service découvert (getservices/ 0B?)" };
    return workerResult;
  }

  // Peupler la trace avec les données d'init PHP
  if (phpState._trace) {
    workerTrace.initConfig = { bytes: phpState._trace.cfgBytes, ok: phpState._trace.cfgBytes > 0 };
    workerTrace.service = {
      bytes: phpState._trace.svcBytes,
      ok: phpState.services.length > 0,
      count: phpState.services.length,
      names: phpState.services.map((s) => s.serviceName).filter(Boolean).join(", "),
      allowAppointment: phpState.allowAppointment ?? undefined,
    };
    workerTrace.agendas = [{
      serviceId: phpState.bestServiceId,
      serviceName: phpState.bestServiceName,
      bytes: phpState._trace.agBytes,
      ok: phpState.agendaId !== "" || phpState._trace.agBytes > 10,
      agendaId: phpState.agendaId || undefined,
    }];
  }

  // ── Helper : met à jour workerTrace avec les données d'init PHP courantes ──
  // Appelé après chaque initPhpState() réussi (init + proxy_error + session_dead + pre-pub refresh)
  function updatePhpTrace(): void {
    if (!phpState?._trace) return;
    workerTrace.initConfig = { bytes: phpState._trace.cfgBytes, ok: phpState._trace.cfgBytes > 0 };
    workerTrace.service = {
      bytes: phpState._trace.svcBytes,
      ok: phpState.services.length > 0,
      count: phpState.services.length,
      names: phpState.services.map((s) => s.serviceName).filter(Boolean).join(", "),
      allowAppointment: phpState.allowAppointment ?? undefined,
    };
    workerTrace.agendas = [{
      serviceId: phpState.bestServiceId,
      serviceName: phpState.bestServiceName,
      bytes: phpState._trace.agBytes,
      ok: phpState.agendaId !== "" || phpState._trace.agBytes > 10,
      agendaId: phpState.agendaId || undefined,
    }];
  }

  // ── 7. Boucle de scan — uniquement datetime/ (pas de réinit PHP) ───────────
  // windowEnd calculé au tout début de runDossierWorker (avant init) pour éviter
  // le bug du fallback WORKER_WINDOW_MS quand l'init dépasse HH:WINDOW_END_MIN.
  const windowEnd = windowEndEarly;
  let cycleCount = 0;

  // ── V2 : état adaptatif du scan ─────────────────────────────────────────────
  /** true si des slots ont été détectés dans cette fenêtre horaire */
  let slotsDetectedThisWindow = false;

  if (windowEnd <= Date.now()) {
    log("WARN", `${tag} ⏰ Fenêtre HH:${String(WINDOW_END_MIN).padStart(2, "0")} expirée après init — exit`);
    workerResult = { dossierId: config.id, status: "exited" };
    return workerResult;
  }

  // ── Tracking pre-publication proxy refresh (1x par heure) ─────────────────
  let lastPrepubRefreshHour = -1;

  while (Date.now() < windowEnd) {
    cycleCount++;
    const cycleStart = Date.now();

    // ── Per-cycle solver trace : par défaut = réutilisation du CF existant (pas de re-solve) ──
    // Sera mis à jour si cf_expired déclenche un re-solve dans ce cycle.
    workerTrace.solver = { reused: true, ms: 0 };
    // Mettre à jour l'IP courante (peut avoir changé via rotation)
    workerTrace.ip = { index: 0, total: 6000, proxy: maskProxy(proxyUrl) };

    // V2 : si un autre worker a posé le flag sommeil → (DÉSACTIVÉ — les annulations arrivent à tout moment)
    // if (cycleCount > 1 && await shouldSleepAfterSlots()) { ... }

    try {
      // ── Pre-publication proxy refresh ─────────────────────────────────────────
      // À la minute PREPUB_REFRESH_MINUTE, forcer une rotation de proxy frais pour
      // arriver à la publication (min 13-14) avec une IP neuve et CF résolu.
      const nowDate = new Date();
      const currentMinute = nowDate.getUTCMinutes();
      const currentHour = nowDate.getUTCHours();
      if (
        currentMinute >= PREPUB_REFRESH_MINUTE &&
        currentMinute < PREPUB_REFRESH_MINUTE + 1 &&
        currentHour !== lastPrepubRefreshHour
      ) {
        lastPrepubRefreshHour = currentHour;
        log("INFO", `${tag} 🔄 Pre-pub refresh (min ${currentMinute}) — rotation proxy frais avant publication`);
        const newProxy = await rotateWorkerIp(session, proxyUrl, config, capsolverKey, tag, "main-0b-rotation");
        if (newProxy) {
          proxyUrl = newProxy;
          phpState = await initPhpState(session, config, tag);
          if (phpState) {
            updatePhpTrace();
            log("INFO", `${tag} ✅ Pre-pub refresh OK — proxy frais prêt`);
          } else {
            log("WARN", `${tag} ⚠️ Pre-pub refresh: PHP reinit échouée, proxy OK quand même`);
          }
        } else {
          log("WARN", `${tag} ⚠️ Pre-pub refresh: rotation impossible — proxy actuel conservé`);
        }
      }

      // ── Header de cycle — visible pour chaque dossier en cours de scan ─────────
      const winRemain = Math.round((windowEnd - Date.now()) / 60_000);
      log(
        "INFO",
        `${tag} 🔍 Cycle ${cycleCount} | fenêtre -${winRemain}min | proxy: ${maskProxy(proxyUrl)}`,
      );

      const scan = await refreshSessionAndScan(session, config, tag);
      log("INFO", `${tag} 📊 Cycle ${cycleCount} scan=${scan.status} | cfClearance=${session.cfClearance?.slice(0, 15) ?? "ABSENT"}… | cookies=${session.allCookies.map(c => c.name).join(",")}`);

      // ── Reporting découverte (fire-and-forget, indépendant de l'éligibilité) ──
      if (scan.slots && scan.slots.length > 0) {
        emitDiscoveryEvents(scan.slots, scan.serviceId, scan.serviceName, config);
      }

      if (scan.status === "proxy_error") {
        // Proxy CONNECT cassé — toutes les requêtes datetime/ ont échoué en réseau.
        // Déclencher une rotation IP et réinitialiser la session PHP.
        log("WARN", `${tag} 🔄 proxy_error — rotation IP + réinit session`);
        const newProxy = await rotateWorkerIp(session, proxyUrl, config, capsolverKey, tag, "proxy_error");
        if (!newProxy) {
          log("WARN", `${tag} ❌ Rotation impossible — pool épuisé, exit worker`);
          workerResult = { dossierId: config.id, status: "error", errorMessage: "proxy_error: pool Decodo épuisé" };
          return workerResult;
        }
        proxyUrl = newProxy;
        // Réinitialiser la session PHP avec le nouveau proxy (impit + PHPSESSID).
        phpState = await initPhpState(session, config, tag);
        if (!phpState) {
          log("WARN", `${tag} ❌ Réinit PHP échouée après rotation — exit worker`);
          workerResult = { dossierId: config.id, status: "error", errorMessage: "proxy_error: réinit PHP impossible" };
          return workerResult;
        }
        updatePhpTrace();
        continue; // Repartir immédiatement sur le nouveau proxy
      }

      if (scan.status === "cf_expired") {
        // CF clearance expiré — le GET widget a retourné un challenge 403.
        // Re-solve via CapSolver avec le même proxy (exit IP inchangée).
        log("WARN", `${tag} 🔄 cf_expired — re-solve CF (proxy conservé) | cycle=${cycleCount} | clearance=${session.cfClearance?.slice(0, 15) ?? "ABSENT"}`);
        const reSolveT0 = Date.now();
        const freshResult = await initWorkerSession(proxyUrl, portalUrlNoFrag, capsolverKey);
        if (!freshResult) {
          log("WARN", `${tag} ❌ Re-solve CF échoué — exit worker`);
          workerResult = { dossierId: config.id, status: "error", errorMessage: "cf_expired: re-solve échoué" };
          return workerResult;
        }
        // Remplacer la session (nouveau cf_clearance + impit)
        session = freshResult.session;
        // Mettre à jour la trace solver pour ce cycle (vrai re-solve, pas du cache)
        workerTrace.solver = { reused: false, ms: Date.now() - reSolveT0 };
        log("INFO", `${tag} ✅ CF re-résolu (${workerTrace.solver.ms}ms) — reprise du scan`);
        continue;
      }

      if (scan.status === "session_dead") {
        // Session PHP morte (agendaId présent mais datetime/ retourne 0B sur tous les mois).
        // Le proxy est sain — pas de rotation IP. Réinit PHPSESSID uniquement.
        log("WARN", `${tag} 🔄 session_dead — réinit PHPSESSID (proxy conservé)`);
        phpState = await initPhpState(session, config, tag);
        if (!phpState) {
          log("WARN", `${tag} ❌ Réinit PHP échouée après session_dead — exit worker`);
          workerResult = { dossierId: config.id, status: "error", errorMessage: "session_dead: réinit PHP impossible" };
          return workerResult;
        }
        updatePhpTrace();
        continue; // Repartir avec le même proxy, nouveau PHPSESSID
      }

      if (scan.status === "not_found") {
        log("INFO", `${tag} ⏸ Cycle ${cycleCount}: aucun créneau — next`);

        // V2 (DÉSACTIVÉ) : le sommeil post-détection empêchait de capter les annulations.
        // Les workers continuent de scanner normalement même après avoir vu des slots disparaître.

        // Mettre à jour les datetimes de la trace pour ce cycle
        if (scan.monthTraces) {
          workerTrace.datetimes = scan.monthTraces.map((m) => ({
            serviceId: scan.serviceId ?? "",
            serviceName: scan.serviceName ?? "",
            month: m.month,
            bytes: m.bytes,
            slots: m.slots,
            ok: m.ok,
          }));
        }
        workerTrace.scanMs = Date.now() - cycleStart;
        void reportSpainWatcherScan({
          status: "not_found",
          applicationId: config.applicationId,
          dossierName: config.applicantName,
          scanTrace: JSON.stringify(workerTrace),
        }).catch(() => {});
      }

      if (scan.status === "found" && scan.slots && scan.slots.length > 0) {
        const groupSize = config.groupSize && config.groupSize > 1 ? config.groupSize : 1;

        // Filtrer par fenêtre de dates ET exclure les slots fantômes (freeslots <= 0).
        // freeslots=-1 = state=1 times=[] → heure par défaut non confirmée par le serveur.
        // getsigninfields/ retourne 0B sur un slot fantôme (même comportement que dynamic test
        // qui exclut explicitement free <= 0 dans allFoundSlots). Seuls les slots réels
        // (freeslots >= 1, issus du times{} de la réponse datetime/) sont bookables.
        const eligible = scan.slots.filter(
          (s) => isSlotInDateWindow(s.date, config, tag) && s.freeslots > 0,
        );

        // Publier le snapshot pour les workers parallèles — TOUS les slots (pas seulement éligibles)
        // pour que Redis connaisse la capacité réelle de chaque créneau sur tous les mois.
        publishSlotSnapshot(
          scan.agendaId ?? "",
          scan.serviceId ?? "",
          scan.slots.map((s) => ({ date: s.date, time: s.time, agendaId: s.agendaId ?? "", freeslots: s.freeslots })),
        ).catch(() => {});

        // ── Reporting Convex APRÈS filtre — "found" seulement si créneaux éligibles ──
        // IMPORTANT : ne pas passer "found" si tous les créneaux sont hors-fenêtre,
        // sinon l'email admin "Créneau Espagne Disponible !" est déclenché à tort.
        // Mettre à jour la trace datetimes pour ce cycle
        if (scan.monthTraces) {
          workerTrace.datetimes = scan.monthTraces.map((m) => ({
            serviceId: scan.serviceId ?? "",
            serviceName: scan.serviceName ?? "",
            month: m.month,
            bytes: m.bytes,
            slots: m.slots,
            ok: m.ok,
          }));
        }

        // Grouper les slots éligibles par date avec total de places — comme le tableau du test dynamic
        // Permet au frontend de voir la disponibilité réelle par date (pas seulement les 20 premiers)
        const slotsByDate = new Map<string, { total: number; count: number }>();
        for (const s of eligible) {
          const existing = slotsByDate.get(s.date);
          if (existing) {
            existing.total += s.freeslots;
            existing.count++;
          } else {
            slotsByDate.set(s.date, { total: s.freeslots, count: 1 });
          }
        }
        const detectedSlotsPayload = eligible
          .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time))
          .slice(0, 50) // limiter à 50 slots pour ne pas exploser le payload
          .map((s) => ({ d: s.date, t: s.time, n: s.freeslots }));

        workerTrace.scanMs = Date.now() - cycleStart;
        void reportSpainWatcherScan({
          status: eligible.length > 0 ? "found" : "not_found",
          slotInfo: eligible.length > 0
            ? buildSlotInfoSummary(eligible)
            : undefined,
          applicationId: config.applicationId,
          dossierName: config.applicantName,
          detectedServices: scan.serviceId
            ? JSON.stringify([{ serviceId: scan.serviceId, serviceName: scan.serviceName ?? scan.serviceId }])
            : undefined,
          detectedSlots: JSON.stringify(detectedSlotsPayload),
          scanTrace: JSON.stringify(workerTrace),
        }).catch(() => {});

        if (eligible.length === 0) {
          log(
            "INFO",
            `${tag} Cycle ${cycleCount}: ${scan.slots.length} créneau(x) hors fenêtre — next`,
          );
        } else {
          // V2 : marquer la détection SEULEMENT quand il y a des slots éligibles (dans la fenêtre de dates)
          slotsDetectedThisWindow = true;

          // P4 — Distribution déterministe des créneaux.
          // Chaque dossier a un index fixe (0-based) → premier choix garanti différent.
          const totalDossiers = config.activeDossierCount || 10;
          const sortedEligible = buildSlotAssignment(
            config.id,
            eligible.map((s) => ({ date: s.date, time: s.time, agendaId: s.agendaId ?? "", freeslots: s.freeslots })),
            groupSize,
            totalDossiers,
            config.dossierIndex,
          ).map((assigned) => {
            // Retrouver le WorkerSlot original correspondant
            return eligible.find(
              (e) => e.date === assigned.date && e.time === assigned.time && (e.agendaId ?? "") === assigned.agendaId,
            )!;
          }).filter(Boolean);

          // ── P1+P2+P5 : Boucle de booking avec cascade fallback ───────────────
          // Le worker itère tous les candidats éligibles. Si un créneau est pris par
          // un humain ("seleccionada") ou que summary/ échoue après retries, on libère
          // le claim Redis et on passe au candidat suivant — pas de sortie du cycle.
          //
          // MODE RACE (≤ RACE_MODE_SLOT_THRESHOLD créneaux) :
          //   Pas de lock Redis — tous les workers foncent en parallèle sur le même
          //   créneau. Le serveur Bookitit décide du gagnant. Les perdants reçoivent
          //   "seleccionada" et passent au prochain candidat.
          //   En race, chaque worker a accès à TOUS les créneaux (pas seulement son
          //   sous-ensemble P4) pour maximiser les chances de fallback.
          let bookingSucceeded = false;
          const raceMode = eligible.length <= RACE_MODE_SLOT_THRESHOLD;
          if (raceMode) {
            log("INFO", `${tag} 🏁 MODE RACE activé (${eligible.length} créneau(x) ≤ ${RACE_MODE_SLOT_THRESHOLD}) — pas de lock Redis, tous les workers foncent`);
          }

          // En mode race : premier choix = P4 (distribution déterministe), mais les
          // créneaux restants sont ajoutés en fallback. Chaque worker commence par son
          // slot assigné, et s'il échoue (seleccionada) il tente les autres.
          // En mode normal : distribution P4 stricte (pas de fallback cross-slot).
          const bookingCandidates = raceMode
            ? (() => {
                // Start with P4 assignment, then append remaining eligible slots as fallbacks
                const p4Set = new Set(sortedEligible.map(s => `${s.date}|${s.time}`));
                const fallbacks = eligible
                  .filter(s => !p4Set.has(`${s.date}|${s.time}`))
                  .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
                return [...sortedEligible, ...fallbacks];
              })()
            : sortedEligible;

          // ── V2 : Sémaphore de booking — limiter à MAX_CONCURRENT_BOOKERS signin/ simultanés ──
          // Si le sémaphore est plein, ce worker reste en scan rapide (2-3s) sans tenter le booking.
          // Il reviendra au prochain cycle et re-checkera armed_count.
          //
          // BYPASS : quand il y a AUTANT de PLACES RÉELLES que le seuil de bypass
          // (≥ SEMAPHORE_BYPASS_SLOT_THRESHOLD), chaque worker vise une place différente
          // (distribution P4) → aucune collision signin/ → aucun risque de 0B.
          // On skip donc le sémaphore : tous les workers avec un créneau attribué bookent
          // immédiatement en parallèle. Gain de temps massif quand beaucoup de places
          // s'ouvrent (ex. 25 places → 25 dossiers bookent en même temps, pas 5 par 5).
          //
          // IMPORTANT : on compte les PLACES (somme des freeslots), pas les créneaux.
          // Un créneau peut offrir plusieurs places (ex. 14 créneaux × 2 places = 28 places).
          // La capacité réelle bookable est la somme des freeslots de tous les créneaux éligibles.
          const totalFreeCapacity = eligible.reduce((sum, s) => sum + Math.max(0, s.freeslots), 0);
          const enoughSlotsForAll = totalFreeCapacity >= SEMAPHORE_BYPASS_SLOT_THRESHOLD;
          if (enoughSlotsForAll) {
            if (!holdingBookingSlot) {
              log(
                "INFO",
                `${tag} 🚀 Sémaphore bypassé — ${totalFreeCapacity} places (${eligible.length} créneaux) ≥ ${SEMAPHORE_BYPASS_SLOT_THRESHOLD} (assez pour tous, pas de collision) → booking immédiat`,
              );
            }
            holdingBookingSlot = true; // marque le worker comme armé sans consommer le sémaphore
          } else if (!holdingBookingSlot) {
            const acquired = await tryAcquireBookingSlot(config.id);
            if (!acquired) {
              log("INFO", `${tag} ⏳ Sémaphore plein — scan rapide (pas de booking ce cycle)`);
              // Ne pas entrer dans la boucle de booking — scan rapide au prochain cycle
              // Le reporting "found" est déjà fait ci-dessus, pas besoin de le refaire
            } else {
              holdingBookingSlot = true;
              usedSemaphore = true; // slot Redis réellement consommé → à libérer
            }
          }

          if (holdingBookingSlot) {
          for (const candidate of bookingCandidates) {
            // ── Redis atomic claim (désactivé en mode race) ──────────────────────
            if (!raceMode) {
              const ok = await tryClaimSlot(
                candidate.date,
                candidate.time,
                candidate.agendaId ?? "",
                config.id,
                groupSize,
                candidate.freeslots,
              );
              if (!ok) {
                log("INFO", `${tag} ${candidate.date} ${candidate.time} → déjà pris (Redis), prochain créneau…`);
                continue;
              }
            }

            const slot = candidate;
            log(
              "INFO",
              `${tag} Cycle ${cycleCount}: ✅ Créneau ${slot.date} ${slot.time} (freeSlots=${slot.freeslots}) — booking en cours…`,
            );

            // ── Booking inline — même session, même PHPSESSID que le scan ────────
            const bookT0 = Date.now();
            const ds = scan.ds ?? phpState!.ds;
            const bookExtra: Record<string, string> = {
              "services[]": scan.serviceId!,
              date:          slot.date,
              time:          slot.time,
              selectedPeople: "1",
            };
            if (slot.agendaId) bookExtra["agendas[]"] = slot.agendaId;

            // Email admin : tentative de booking (fire-and-forget)
            reportBookingLog({
              applicationId: config.applicationId,
              dossierId: config.id,
              applicantName: config.applicantName,
              date: slot.date,
              time: slot.time,
              status: "attempted",
              serviceName: scan.serviceName,
            }).catch(() => {});

            // ── P5 : getsigninfields/ — skip immédiat si 0B (pas de retry en booking) ──
            const gsfPhpsessid = Object.entries(ds.jar).find(([k]) => k === "PHPSESSID")?.[1]?.slice(0, 8) ?? "?";
            log("INFO", `${tag} 🔑 getsigninfields/ — ds.PHPSESSID=${gsfPhpsessid}… src=${ds.widgetUrl.slice(-40)}`);
            const gsfPayload = await callDirect(ds, "getsigninfields/", {
              "services[]": bookExtra["services[]"],
              "agendas[]":  bookExtra["agendas[]"] ?? "",
              date:         bookExtra.date,
              time:         bookExtra.time,
              selectedPeople: bookExtra.selectedPeople,
            }, tag) as any;
            const gsfBytes = gsfPayload ? JSON.stringify(gsfPayload).length : 0;
            log("INFO", `${tag} 🔑 getsigninfields/ → ${gsfBytes}B${gsfPayload ? " ✅" : " ❌ 0B — skip slot"}`);
            if (gsfPayload === null) {
              // Serveur surchargé — passer au créneau suivant immédiatement
              await sleep(200);
              continue;
            }
            const logintype = "document";

            // ── signin/ — appel unique, skip immédiat si 0B ─────────────────────
            log("INFO", `${tag} 🔑 signin/…`);
            const signinRaw = await callDirect(ds, "signin/", {
              ...bookExtra,
              logintype,
              login:     config.login,
              password:  config.password,
              comments:  "",
            });
            const signinPayload: Record<string, unknown> | null =
              (signinRaw === null || signinRaw === CALL_DIRECT_NETWORK_ERROR)
                ? null
                : signinRaw as Record<string, unknown>;

            const signinInner = (signinPayload as any)?.Client ?? signinPayload;
            const bktToken = String(
              (signinPayload as any)?.Access?.bktToken ??
              signinInner?.bktToken ??
              (signinPayload as any)?.bktToken ??
              ""
            );
            const signinErrors: Array<{ message?: string }> = Array.isArray(signinInner?.errors) ? signinInner.errors : [];

            let bookResult: SpainBookingResult;

            if (!bktToken) {
              const errMsg = signinErrors.length
                ? signinErrors.map((e) => e.message).join(", ")
                : (signinPayload ? "signin/ sans bktToken" : "signin/ → 0B");
              log("WARN", `${tag} ❌ signin/ échoué: ${errMsg}`);
              bookResult = { status: "signin_failed", errorMessage: errMsg, durationMs: Date.now() - bookT0 };
            } else {
              // ── P2 : summary/ avec retry 2× sur 504/null ───────────────────────
              log("INFO", `${tag} 📝 summary/ (bktToken: ${bktToken.slice(0, 15)}…)…`);
              const summaryExtra: Record<string, string> = {
                "services[]": scan.serviceId!,
                date:          slot.date,
                time:          slot.time,
              };
              if (slot.agendaId) summaryExtra["agendas[]"] = slot.agendaId;
              const summaryParams = {
                ...summaryExtra,
                bktToken,
                login:          config.login,
                password:       config.password,
                logintype:      "document",
                comments:       "",
                client_signin:  "true",
                event_created:  "true",
              };

              let summaryPayload: any = null;
              const SUMMARY_MAX_RETRIES = 2;
              for (let summaryAttempt = 0; summaryAttempt <= SUMMARY_MAX_RETRIES; summaryAttempt++) {
                if (summaryAttempt > 0) {
                  const backoff = 3_000 * summaryAttempt; // 3s, 6s
                  log("INFO", `${tag} 📝 summary/ retry ${summaryAttempt}/${SUMMARY_MAX_RETRIES} (${backoff}ms)…`);
                  await sleep(backoff);
                }
                const raw = await callDirect(ds, "summary/", summaryParams);
                if (raw === CALL_DIRECT_NETWORK_ERROR) {
                  // Proxy cassé — pas la peine de retry summary/
                  break;
                }
                if (raw !== null) {
                  summaryPayload = raw;
                  break;
                }
                // raw === null (HTTP 504/0B) → retry si tentatives restantes
              }

              if (summaryPayload === null) {
                bookResult = { status: "booking_failed", errorMessage: "summary/ → null après retries", durationMs: Date.now() - bookT0 };
              } else {
                // Extraire locator depuis la réponse summary/
                const eventList: any[] = Array.isArray(summaryPayload?.Event) ? summaryPayload.Event
                  : Array.isArray(summaryPayload) ? summaryPayload
                  : summaryPayload?.Event ? [summaryPayload.Event]
                  : [];
                const firstEvent = eventList[0];
                const locator: string =
                  firstEvent?.Event?.locator ??
                  firstEvent?.locator ??
                  firstEvent?.Appointment?.locator ??
                  summaryPayload?.Event?.locator ??
                  summaryPayload?.locator ?? "";

                if (locator) {
                  bookResult = {
                    status:           "booked",
                    locator,
                    bookedDate:       slot.date,
                    bookedTime:       slot.time,
                    bookedServiceName: scan.serviceName,
                    durationMs:       Date.now() - bookT0,
                  };
                } else {
                  // Kinshasa : state=1 + date = confirmation sans locator
                  const eventState = firstEvent?.Event?.state ?? firstEvent?.state ?? "";
                  const eventDate  = firstEvent?.Event?.date  ?? firstEvent?.date  ?? "";
                  if (String(eventState) === "1" && eventDate) {
                    log("INFO", `${tag} ✅ Booking confirmé (state=1, date=${eventDate}) — locator absent (comportement Kinshasa)`);
                    bookResult = {
                      status:           "booked",
                      locator:          `state1-${eventDate}`,
                      bookedDate:       eventDate,
                      bookedTime:       firstEvent?.Event?.time ?? firstEvent?.time ?? slot.time,
                      bookedServiceName: scan.serviceName,
                      durationMs:       Date.now() - bookT0,
                    };
                  } else {
                    const summaryErr = JSON.stringify(summaryPayload?.Exception?.errors ?? summaryPayload?.errors ?? summaryPayload).slice(0, 200);
                    bookResult = { status: "booking_failed", errorMessage: `summary/ sans locator: ${summaryErr}`, durationMs: Date.now() - bookT0 };
                  }
                }
              }
            }

            log(
              "INFO",
              `${tag} Booking: ${bookResult.status}` +
              (bookResult.locator ? ` | locator: ${bookResult.locator}` : "") +
              (bookResult.errorMessage ? ` | ${bookResult.errorMessage}` : ""),
            );

            // Enregistrer le résultat du booking dans la trace
            workerTrace.bookings.push({
              applicant: config.applicantName,
              status: bookResult.status,
              detail: (bookResult.locator ?? bookResult.errorMessage ?? "").slice(0, 80) || undefined,
              ms: bookResult.durationMs,
              gsfBytes: gsfBytes,
              signinBytes: signinPayload ? JSON.stringify(signinPayload).length : 0,
              bktToken: bktToken ? bktToken.slice(0, 12) + "…" : undefined,
              locator: bookResult.locator || undefined,
            });

            if (bookResult.status === "booked") {
              await reportBookingSuccess(config, bookResult, slot, scan, tag);
              // V2 : libérer le sémaphore de booking (seulement si réellement acquis)
              if (holdingBookingSlot) {
                if (usedSemaphore) { await releaseBookingSlot(config.id); usedSemaphore = false; }
                holdingBookingSlot = false;
              }
              workerResult = { dossierId: config.id, status: "booked" };
              return workerResult;
            }

            // Booking échoué → libérer le claim Redis de CE dossier immédiatement.
            if (!raceMode) {
              releaseSlotClaim(slot.date, slot.time, slot.agendaId ?? "", config.id).catch(() => {});
            }

            // ── Erreur credentials permanente → sortie immédiate ──────────────────
            const isCredentialError = bookResult.status === "signin_failed"
              && (bookResult.errorMessage ?? "").toLowerCase().includes("incorrect");
            if (isCredentialError) {
              log("WARN", `${tag} 🚫 Erreur credentials permanente — arrêt du worker`);
              reportBookingLog({
                applicationId: config.applicationId,
                dossierId: config.id,
                applicantName: config.applicantName,
                date: slot.date,
                time: slot.time,
                status: "failed",
                reason: bookResult.errorMessage ?? "Credentials incorrects",
                serviceName: scan.serviceName,
              }).catch(() => {});
              // V2 : libérer le sémaphore (seulement si réellement acquis)
              if (holdingBookingSlot) {
                if (usedSemaphore) { await releaseBookingSlot(config.id); usedSemaphore = false; }
                holdingBookingSlot = false;
              }
              workerResult = { dossierId: config.id, status: "error", errorMessage: `signin_failed: ${bookResult.errorMessage}` };
              return workerResult;
            }

            // ── P1 : "seleccionada por otra persona" → continuer au créneau suivant ──
            // Le serveur dit que ce créneau est pris par un humain/autre agent.
            // En mode race, c'est probablement un de NOS workers qui a gagné — pas grave.
            // On ne quitte pas le cycle : on tente immédiatement le prochain candidat.
            const errLower = (bookResult.errorMessage ?? "").toLowerCase();
            const isSlotTakenByOther = errLower.includes("seleccionada por otra persona")
              || errLower.includes("elegida")
              || errLower.includes("ya no está disponible")
              || errLower.includes("no disponible");
            if (isSlotTakenByOther) {
              if (raceMode) {
                log("INFO", `${tag} 🏁 Race perdue: ${slot.date} ${slot.time} pris (un de nos workers ou humain) — fallback`);
              } else {
                log("INFO", `${tag} ⏭️ P1: Créneau ${slot.date} ${slot.time} pris par un humain — fallback au prochain candidat`);
              }
              await sleep(300); // micro-délai pour ne pas spammer
              continue; // → prochain candidat dans sortedEligible
            }

            // ── signin/ → 0B → slot déjà pris (ou serveur surchargé) → skip immédiat ──
            // Quand getsigninfields/ a réussi (nonce PHP activé) mais que signin/ retourne
            // 0B juste après, le serveur signale le plus souvent que le créneau n'existe
            // plus : un concurrent l'a capturé entre le scan et le booking (fréquent en
            // mode RACE sur un slot freeSlots=1). Le 0B peut aussi venir d'une surcharge
            // serveur, mais dans les deux cas il n'y a plus rien à faire sur ce créneau →
            // on passe immédiatement au suivant.
            const isSlotGoneOrOverload = bookResult.status === "signin_failed"
              && (bookResult.errorMessage ?? "").includes("0B");
            if (isSlotGoneOrOverload) {
              log("INFO", `${tag} ⏭️ signin/ 0B (slot déjà pris ou surcharge) — skip au prochain slot`);
              await sleep(200);
              continue;
            }

            // Booking échoué (autre raison) → reporter puis passer au créneau suivant
            reportBookingLog({
              applicationId: config.applicationId,
              dossierId: config.id,
              applicantName: config.applicantName,
              date: slot.date,
              time: slot.time,
              status: "failed",
              reason: bookResult.errorMessage ?? "Raison inconnue",
              serviceName: scan.serviceName,
            }).catch(() => {});

            sendHeartbeat({
              applicationId: config.applicationId,
              result: "error",
              errorMessage: `Booking ${bookResult.status}: ${bookResult.errorMessage}`,
            }).catch(() => {});

            // Délai 800ms post-booking pour stabiliser impit
            await sleep(800);
          } // fin boucle for (const candidate of sortedEligible)

          if (!bookingSucceeded) {
            log(
              "INFO",
              `${tag} Cycle ${cycleCount}: tous les créneaux éligibles (${sortedEligible.length}) épuisés — next cycle`,
            );
            // V2 : libérer le sémaphore — ce worker n'a pas réussi à booker
            if (holdingBookingSlot) {
              if (usedSemaphore) { await releaseBookingSlot(config.id); usedSemaphore = false; }
              holdingBookingSlot = false;
            }
          }
          } // end if (holdingBookingSlot)
        }
      }

      // Heartbeat de scan OK / not_found
      sendHeartbeat({
        applicationId: config.applicationId,
        result: "not_found",
      }).catch(() => {});
    } catch (err) {
      log("WARN", `${tag} Cycle ${cycleCount} exception: ${err}`);
    }

    // Attendre jusqu'au prochain cycle (start-to-start) — V2 adaptatif
    const adaptiveInterval = getAdaptiveScanInterval(slotsDetectedThisWindow, holdingBookingSlot);
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, adaptiveInterval - elapsed);
    if (Date.now() + wait < windowEnd) {
      await sleep(wait);
    }
  }

  log(
    "INFO",
    `${tag} Fenêtre ${WORKER_WINDOW_MS / 60_000}min expirée après ${cycleCount} cycle(s) — exit`,
  );
  workerResult = { dossierId: config.id, status: "exited" };
  return workerResult;

  } finally {
    // V2 : libérer le sémaphore de booking si encore détenu (crash, exception…)
    // Seulement si le slot Redis a réellement été acquis (pas en cas de bypass).
    if (holdingBookingSlot) {
      if (usedSemaphore) { await releaseBookingSlot(config.id).catch(() => {}); usedSemaphore = false; }
      holdingBookingSlot = false;
    }
    // Libération garantie de l'IP, quelle que soit la sortie (return, throw, exception).
    // Owner-check Lua : seul ce dossier peut supprimer sa réservation.
    // proxyUrl = "" → mode direct, pas de réservation Redis à libérer.
    if (proxyUrl) {
      // Mémoriser ce port pour la prochaine fenêtre → même port → CF cache hit.
      // IMPORTANT : sauvegarder la BASE URL (sans sticky session) pour que le path
      // lastProxy de pickDedicatedProxy génère la même clé Redis que le round-robin.
      // Sauvegarder la sticky URL provoquait une double réservation (clés différentes)
      // → deux dossiers sur le même port physique → CF clearances écrasées mutuellement.
      // await obligatoire : process.exit() (test) tuerait une Promise fire-and-forget.
      await saveLastProxyForDossier(config.id, stripStickySession(proxyUrl)).catch(() => {});
      releaseWorkerIp(proxyUrl, config.id).catch(() => {});
    }
  }
}

// ─── Probe CF challenge ───────────────────────────────────────────────────────

/**
 * User-Agent Chrome utilisé par impit (browser: "chrome").
 * Doit correspondre à la version impit installée pour la cohérence TLS.
 * Passé à CapSolver quand html est fourni (obligatoire, sinon ERROR_INVALID_TASK_DATA).
 */
const IMPIT_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

/**
 * Utilise l'impit dédié du worker pour GET le portail et capturer le HTML du challenge CF.
 *
 * RÔLE CRITIQUE : le cf_clearance retourné par CapSolver est lié à l'empreinte TLS
 * du navigateur qui a fait le probe. En passant ce HTML à solveSpainCloudflare, on
 * garantit que le cf_clearance est compatible avec l'impit (même empreinte TLS Chrome),
 * et non avec le Chrome interne de CapSolver (qui donnerait 403 à l'impit).
 *
 * @returns challengeHtml - HTML brut du portail (peut être une page CF challenge ou non)
 *          ua            - User-Agent à passer à CapSolver avec le HTML
 */
async function captureChallengePage(
  impit: any,
  portalUrl: string,
  tag: string,
): Promise<{ challengeHtml: string; ua: string; proxyError: boolean; probeCookies: Array<{name: string; value: string}> }> {
  try {
    const res = await impit.fetch(portalUrl, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
    });

    const html = await res.text();
    const isCfChallenge =
      html.includes("cf_chl_opt") ||
      html.includes("challenges.cloudflare.com") ||
      html.includes("__cf_chl") ||
      html.includes("cf-mitigated");

    // ── Capturer les Set-Cookie du probe (même pour 403) ─────────────────────
    // Le test dynamique (test-bookitit-dynamic.ts l.71) fait Object.assign(jar, extractSetCookies)
    // après le probe 403 — les cookies CF (__cf_bm, _cfuvid, etc.) sont ainsi inclus dans le
    // Cookie header du GET portail post-solve. Sans eux, CF rejette la requête HTML (403).
    const probeCookies: Array<{name: string; value: string}> = [];
    try {
      const rawSC = (res.headers as any).get?.("set-cookie") ?? "";
      // Certains runtimes retournent plusieurs Set-Cookie séparés par \n
      const parts = rawSC.split(/,(?=[^ ])/);
      for (const part of parts) {
        const m = part.trim().match(/^([^=;]+)=([^;]*)/);
        if (m && m[1] && m[2]) probeCookies.push({ name: m[1].trim(), value: m[2].trim() });
      }
    } catch { /* non-fatal */ }

    log(
      "INFO",
      `${tag} Probe portail: HTTP ${res.status}, ${html.length}B ` +
      (isCfChallenge ? "✅ CF challenge détecté" : "(pas de challenge — session directe)") +
      (probeCookies.length ? ` | probe cookies: [${probeCookies.map(c => c.name).join(", ")}]` : ""),
    );

    return { challengeHtml: html, ua: IMPIT_CHROME_UA, proxyError: false, probeCookies };
  } catch (e) {
    const errMsg = String(e);
    const proxyError = isProxyConnectError(errMsg);
    log(
      proxyError ? "WARN" : "WARN",
      `${tag} Probe portail error${proxyError ? " (proxy injoignable)" : ""}: ${e} — solve CF sans HTML (risque 403)`,
    );
    return { challengeHtml: "", ua: IMPIT_CHROME_UA, proxyError, probeCookies: [] };
  }
}

// ─── Rotation IP mid-session ──────────────────────────────────────────────────

/**
 * Rotation IP quand /main/ retourne 0B (IP bloquée par Bookitit).
 *
 * IDENTIQUE à l'ancien système (spain-watcher-loop.ts + rotateSpainCfIpAfterMainFailure),
 * mais encapsulé dans le worker dossier plutôt que dans l'état global :
 *   1. Libère l'IP courante (owner-checked Redis)
 *   2. Sélectionne la prochaine IP disponible
 *   3. Crée un nouvel impit avec cette IP
 *   4. Probe portail → capture HTML challenge CF (lie cf_clearance à la TLS du nouvel impit)
 *   5. Solve CF (CapSolver) avec le HTML → nouveau cf_clearance
 *   6. Met à jour session en place (ne crée pas de nouveau SpainCfSession)
 *   7. Ré-initialise le PHPSESSID avec le nouvel impit
 *
 * @returns nouvelle proxyUrl (string) si succès, null si plus d'IP disponible ou solve échoué
 */
async function rotateWorkerIp(
  session: SpainCfSession,
  currentProxyUrl: string,
  config: SpainDossierConfig,
  capsolverKey: string,
  tag: string,
  reason: "main-0b-rotation" | "proxy_error" = "main-0b-rotation",
): Promise<string | null> {
  const reasonLabel = reason === "proxy_error" ? "proxy_error (CONNECT cassé)" : "/main/ 0B";
  log("WARN", `${tag} 🔄 Rotation IP (${reasonLabel}) — libération ${maskProxy(currentProxyUrl)} …`);

  // 1. Libérer l'IP courante et la blacklister
  if (currentProxyUrl) {
    flagDecodoIp(currentProxyUrl, reason);
    await releaseWorkerIp(currentProxyUrl, config.id).catch(() => {});
  }

  // 2. Nouvelle IP + initWorkerSession complète (même séquence que l'init initiale)
  const portalUrl = config.portalUrl.split("#")[0];

  const newProxy = await pickDedicatedProxy(config.id, tag);
  if (!newProxy) {
    log("WARN", `${tag} ❌ Rotation impossible — pool Decodo épuisé`);
    return null;
  }

  const stickyId = Math.random().toString(36).slice(2, 10);
  const stickyNewProxy = addStickySession(newProxy, stickyId);
  log("INFO", `${tag} 🔄 Nouvelle IP : ${maskProxy(stickyNewProxy)} (sid=${stickyId})`);

  const result = await initWorkerSession(stickyNewProxy, portalUrl, capsolverKey);
  if (!result) {
    log("WARN", `${tag} ❌ initWorkerSession échoué sur nouvelle IP — libération`);
    flagDecodoIp(newProxy, "rotation-init-session-failed");
    await releaseWorkerIp(newProxy, config.id).catch(() => {});
    return null;
  }

  // 3. Mettre à jour la session EN PLACE (préserve les refs extérieures)
  const newSess = result.session;
  session.cfClearance        = newSess.cfClearance;
  session.soaxProxyUrl       = stickyNewProxy;
  session.userAgent          = newSess.userAgent;
  session.allCookies         = newSess.allCookies;
  session._ownImpit          = newSess._ownImpit;
  session.bookititState      = newSess.bookititState;
  session.prefetchedMainHtml = newSess.prefetchedMainHtml;
  session.phpSessionCreatedAt = newSess.phpSessionCreatedAt;

  // Persister le nouveau stickyId → la prochaine fenêtre réutilisera la même exit IP
  // et bénéficiera du cache CF Redis (évite un re-solve CapSolver inutile).
  await saveLastStickyForDossier(config.id, stickyId).catch(() => {});

  log("INFO", `${tag} ✅ Rotation réussie — PHPSESSID ✅ | /main/ ${newSess.prefetchedMainHtml?.length ?? 0}B`);
  return stickyNewProxy;
}

// ─── IP Decodo dédiée ─────────────────────────────────────────────────────────

/**
 * Sélectionne un proxy Decodo non réservé par un autre worker.
 * Retourne l'URL du proxy, "" si aucun proxy configuré (mode sans proxy),
 * ou null si tous les proxies sont déjà réservés.
 */
async function pickDedicatedProxy(
  dossierId: string,
  tag: string,
): Promise<string | null> {
  const poolSize = getDecodoPoolSize();

  // Aucun proxy configuré → mode direct (pas de réservation IP)
  if (poolSize === 0) {
    log("WARN", `${tag} Pool Decodo vide — scan en mode direct (sans proxy)`);
    return "";
  }

  // ── Priorité : réutiliser le dernier port de ce dossier ──────────────────────
  // Si le même port est réutilisé, la clé Redis du CF clearance (host:port) est
  // identique → cache hit → CapSolver évité (~20s + balance économisés).
  const lastProxy = await getLastProxyForDossier(dossierId);
  if (lastProxy && !isDecodoIpBlacklisted(lastProxy)) {
    const reservedByOther = await isIpReservedByOther(lastProxy, dossierId);
    if (!reservedByOther) {
      const ok = await reserveWorkerIp(lastProxy, dossierId);
      if (ok) {
        log("INFO", `${tag} IP Decodo réutilisée (CF cache préservé) : ${maskProxy(lastProxy)}`);
        return lastProxy;
      }
    }
  }

  // ── Fallback : round-robin depuis l'index courant ────────────────────────────
  // IMPORTANT : avancer l'index de départ pour que chaque appel à pickDedicatedProxy
  // explore une zone différente du pool. Sans ça, tous les dossiers partent du même
  // startIndex → tombent sur les mêmes 20-30 premiers proxies → on n'utilise jamais
  // les 100K IPs disponibles.
  const startIndex = getDecodoCurrentIndex();

  for (let i = 0; i < poolSize; i++) {
    const idx = (startIndex + i) % poolSize;
    const url = getDecodoProxyForIndex(idx) ?? "";
    if (!url) continue;

    // Skip les IPs blacklistées (portal-html-403, probe-error, etc.)
    if (isDecodoIpBlacklisted(url)) continue;

    const reserved = await isIpReservedByOther(url, dossierId);
    if (reserved) continue;

    // Tenter de réserver
    const ok = await reserveWorkerIp(url, dossierId);
    if (ok) {
      // Avancer l'index global APRÈS ce proxy pour que le prochain appel
      // (même dossier ou autre) commence après celui-ci dans le pool.
      rotateDecodoUrl();
      log("INFO", `${tag} IP Decodo réservée : ${maskProxy(url)} (index ${idx}/${poolSize})`);
      return url;
    }
  }

  return null; // tous réservés
}

// ─── Init portail (GET + POST token → PHPSESSID) ──────────────────────────────

/**
 * Effectue l'initialisation du portail Bookitit pour obtenir un PHPSESSID.
 *
 * STRATÉGIE identique à solveViaImpit (spain-soax-solver.ts l.1542-1560) :
 *   - Appel DIRECT via session._ownImpit (PAS spainCfFetch) avec headers
 *     navigation Chrome minimaux + Cookie: cf_clearance=... uniquement.
 *   - spainCfFetch ajoute un Referer "citaconsular.es/es/" qui déclenche 403
 *     CF sur une navigation directe (le serveur attend Referer absent ou même domaine).
 *   - PHPSESSID extrait depuis Set-Cookie de la réponse GET.
 *
 * Si GET → 403 (CF encore actif) : try POST widget direct (token de la page).
 * Si GET → 200 sans PHPSESSID dans Set-Cookie : extraire token + POST widget.
 *
 * Retourne true si PHPSESSID obtenu dans session.allCookies.
 */
async function initPortalSession(
  session: SpainCfSession,
  portalUrl: string,
  tag: string,
): Promise<boolean> {
  const impit = session._ownImpit;
  if (!impit) {
    log("WARN", `${tag} initPortalSession: _ownImpit absent`);
    return false;
  }

  // Cookie jar complet (cf_clearance + tout ce que le probe 403 a retourné)
  const cookieStr = session.allCookies
    .filter(c => c.name !== "PHPSESSID")
    .map(c => `${c.name}=${c.value}`)
    .join("; ");

  // ── GET portail — IDENTIQUE à ensureSpainImpitSession l.975-976 ─────────────
  // Seuls UA + Cookie sont fournis explicitement. Impit gère le reste (Sec-Ch-Ua,
  // Sec-Fetch-*, fingerprint TLS) en interne — surcharger ces headers casse CF.
  let html = "";
  try {
    const getRes = await (impit.fetch(portalUrl, {
      headers: { "User-Agent": session.userAgent, "Cookie": cookieStr },
    } as any) as unknown as Response);
    const status = (getRes as any).status as number;
    const body   = await (getRes as any).text() as string;
    const setCookie = (getRes as any).headers?.get?.("set-cookie") ?? "";
    const phpFromGet = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
    log("INFO", `${tag} initPortalSession GET → HTTP ${status} | ${body.length}B | PHPSESSID=${phpFromGet ? "✅" : "absent"}`);

    if (phpFromGet) { upsertCookie(session, "PHPSESSID", phpFromGet); return true; }
    if (status === 403) {
      log("WARN", `${tag} initPortalSession GET 403 — proxy bloqué pour HTML (rotation nécessaire)`);
      return false;
    }
    html = body;
  } catch (e) {
    log("WARN", `${tag} initPortalSession GET error: ${e}`);
    return false;
  }

  // ── Extraire token CSRF + POST — IDENTIQUE à ensureSpainImpitSession l.1007-1031 ──
  const token =
    html.match(/name="token"\s+value="([^"]+)"/i)?.[1] ??
    html.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1];

  if (!token) {
    const existingPhp = session.allCookies.find(c => c.name === "PHPSESSID");
    log("INFO", `${tag} initPortalSession: pas de token — PHPSESSID=${existingPhp ? "✅" : "absent"}`);
    return !!existingPhp;
  }

  const baseHost = "https://www.citaconsular.es";
  const targetUrl = ensureTrailingSlash(portalUrl);
  try {
    const rPost = await (impit.fetch(targetUrl, {
      method: "POST",
      headers: {
        "User-Agent":   session.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie":       cookieStr,
        "Referer":      portalUrl,
        "Origin":       baseHost,
      },
      body: `token=${encodeURIComponent(token)}`,
    } as any) as unknown as Response);
    const bodyPost   = await (rPost as any).text() as string;
    const setCookie  = (rPost as any).headers?.get?.("set-cookie") ?? "";
    const phpFromPost = setCookie.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";

    // Extraire srvsrc + version depuis le POST (identique au test dynamique l.158-161)
    const srvsrc  = bodyPost.match(/srvsrc:\s*'([^']+)'/)?.[1];
    const version = bodyPost.match(/loadermaec\.js\?v=(\d+)/)?.[1];
    if (srvsrc  && session.bookititState) session.bookititState.srvsrc  = srvsrc;
    if (version && session.bookititState) session.bookititState.version = version;

    if (phpFromPost) {
      upsertCookie(session, "PHPSESSID", phpFromPost);
      log("INFO", `${tag} initPortalSession POST → PHPSESSID ✅ | srvsrc=${srvsrc ?? "?"} | v=${version ?? "?"}`);
      return true;
    }
    log("WARN", `${tag} initPortalSession POST → HTTP ${(rPost as any).status} — PHPSESSID absent`);
  } catch (e) {
    log("WARN", `${tag} initPortalSession POST error: ${e}`);
  }

  return false;
}

/** Insère ou met à jour un cookie dans session.allCookies. */
function upsertCookie(session: SpainCfSession, name: string, value: string): void {
  const idx = session.allCookies.findIndex((c) => c.name === name);
  if (idx >= 0) session.allCookies[idx] = { name, value };
  else session.allCookies.push({ name, value });
}

// ─── Cycle de scan ────────────────────────────────────────────────────────────

/**
 * Un cycle de scan complet — appelle directement confirmSlotsViaDatetime,
 * le MÊME flux que l'ancien watcher. Ne reproduit rien : réutilise tel quel.
 *
 * confirmSlotsViaDatetime gère intégralement :
 *   getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/ (multi-mois)
 *
 * Règle §9 Bookitit : getagendas/ ne peut être appelé qu'une seule fois par PHPSESSID.
 * → Chaque cycle doit avoir sa propre session (rotation dans runDossierWorker).
 */
async function workerScanCycle(
  session: SpainCfSession,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerScanResult> {
  const bookititState = session.bookititState;
  if (!bookititState) return { status: "error", errorMessage: "workerScanCycle: bookititState absent" };

  const publickey = bookititState.publickey;
  const referer   = bookititState.widgetUrl;

  // cookieStr — fidèle à buildCookieStr() de scanViaMainEndpoint :
  // GA cookies synthétiques (si source != playwright) + PHPSESSID + cf_clearance.
  const browserCookies = session.allCookies.filter((c) => c.name !== "cf_clearance");
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga")) {
    const seed = session.createdAt;
    browserCookies.push({
      name: "_ga",
      value: `GA1.1.${100_000_000 + (seed % 900_000_000)}.${Math.floor(seed / 1000) - 15 * 24 * 3600}`,
    });
  }
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga_F3TYSDL945")) {
    const ts = String(Math.floor(session.createdAt / 1000));
    browserCookies.push({ name: "_ga_F3TYSDL945", value: `GS2.1.s${ts}$o1$g0$t${ts}$j60$l0$h0` });
  }
  const cookieStr = [
    ...browserCookies.map((c) => `${c.name}=${c.value}`),
    ...(session.cfClearance ? [`cf_clearance=${session.cfClearance}`] : []),
  ].join("; ");

  // mainHtml — prefetchedMainHtml si disponible (confirmSlotsViaDatetimeOnce l'utilise
  // pour extraire les liens #selectservice ; "" → fallback getservices/ automatique).
  const mainHtml = session.prefetchedMainHtml ?? "";
  session.prefetchedMainHtml = undefined;

  log("INFO", `${tag} 🔍 scan via confirmSlotsViaDatetime — publickey=${publickey}`);

  const result = await confirmSlotsViaDatetime(session, mainHtml, publickey, cookieStr, referer);

  if (!result) return { status: "not_found", mainHtml };
  if (result === "ajax_unavailable") return { status: "ajax_unavailable", mainHtml };

  const allSlots = (result.allSlots ?? []).map((s) => ({
    date:      s.date,
    time:      s.time,
    agendaId:  s.agendaId ?? "",
    freeslots: s.freeslots,
  }));

  if (allSlots.length === 0) {
    return { status: "not_found", mainHtml, serviceId: result.serviceId, serviceName: result.serviceName };
  }

  return {
    status:      "found",
    slots:       allSlots,
    mainHtml,
    serviceId:   result.serviceId,
    serviceName: result.serviceName,
    agendaId:    allSlots[0]?.agendaId ?? "",
  };
}

// ─── Appel /main/ ─────────────────────────────────────────────────────────────

async function callMain(
  session: SpainCfSession,
  publickey: string,
  portalRef: string,
  portalUrl: string,
  tag: string,
): Promise<{ ok: true; mainHtml: string } | { ok: false; error: string }> {
  // Réutiliser le jqCallback de la session si disponible (cohérence Bookitit)
  const jqCb =
    session.bookititState?.jqCallback ?? buildJQueryCallback();

  const qs = new URLSearchParams({
    callback: jqCb,
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: portalRef,
    srvsrc: "https://www.citaconsular.es",
    _: String(Date.now()),
  });

  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${qs}`;

  let res: Response | null = null;
  try {
    res = await spainCfFetch(mainUrl, session, {
      headers: {
        Accept:
          "text/javascript, application/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: portalRef,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
    });
  } catch (e) {
    return { ok: false, error: `main/ fetch error: ${e}` };
  }

  if (!res?.ok) {
    return { ok: false, error: `main/ HTTP ${res?.status ?? "null"}` };
  }

  // Mettre à jour les cookies depuis Set-Cookie
  mergeCookiesFromResponse(res, session);

  const body = await res.text();
  if (body.length < 200) {
    return {
      ok: false,
      error: `main/ 0B (${body.length} chars) — IP bloquée ou PHPSESSID expiré`,
    };
  }

  // Désencapsuler le JSONP → HTML
  let mainHtml = body;
  const jm = body.match(/^[^\(]+\("(.*)"\);?\s*$/);
  if (!jm) {
    // Retry with manual newline matching (equivalent to /s flag)
    const singleLine = body.replace(/\n/g, " ");
    const jm2 = singleLine.match(/^[^\(]+\("(.*)"\);?\s*$/);
    if (jm2?.[1]) {
      try { mainHtml = JSON.parse(`"${jm2[1]}"`); } catch {}
    }
  } else if (jm[1]) {
    try { mainHtml = JSON.parse(`"${jm[1]}"`); } catch {}
  }

  return { ok: true, mainHtml };
}

// ─── Extraction créneaux ──────────────────────────────────────────────────────

/**
 * Extrait tous les créneaux disponibles depuis le payload datetime/.
 * Supporte les formats Bookitit :
 *   { Slots: [ { date, times: { "HH:MM": { freeSlots, totalSlots } } } ] }
 *   { Slots: [ { date, state: 1, times: [] } ] }  (Saopola)
 */
function extractAllSlotsFromPayload(
  payload: unknown,
  agendaId: string,
  groupSize: number,
): WorkerSlot[] {
  if (!payload || typeof payload !== "object") return [];
  const obj = payload as Record<string, unknown>;
  if (!Array.isArray(obj.Slots)) return [];

  // Tout créneau avec au moins 1 place libre est bookable.
  // groupSize est géré par Redis (coordination multi-dossier sur créneaux adjacents),
  // pas par le filtrage des slots. Chaque dossier booke selectedPeople=1.
  const minFree = 1;

  const result: WorkerSlot[] = [];

  for (const day of (obj.Slots as unknown[])) {
    if (!day || typeof day !== "object") continue;
    const d = day as Record<string, unknown>;
    const date = typeof d.date === "string" ? d.date : "";
    if (!date) continue;

    const stateNum =
      typeof d.state === "number" ? d.state
      : typeof d.state === "string" ? parseInt(d.state, 10) : -1;
    if (stateNum !== 1) continue;

    const slotAgendaId =
      d.agenda != null ? String(d.agenda)
      : d.agenda_id != null ? String(d.agenda_id)
      : agendaId;

    const times = d.times;
    if (!times || typeof times !== "object" || Array.isArray(times)) continue;
    const timesObj = times as Record<string, unknown>;

    const entries = Object.entries(timesObj).sort(([a], [b]) => a.localeCompare(b));

    for (const [timeKey, v] of entries) {
      if (!v || typeof v !== "object") continue;
      const t = v as Record<string, unknown>;
      const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
      const free =
        typeof freeRaw === "number" ? freeRaw
        : typeof freeRaw === "string" ? parseInt(freeRaw, 10) : -1;

      if (free < minFree) continue;

      const time = /^\d{1,2}:\d{2}$/.test(timeKey)
        ? timeKey
        : typeof t.time === "string"
          ? t.time
          : "09:00";

      result.push({ date, time, agendaId: slotAgendaId, freeslots: free });
    }
  }

  return result;
}

function extractFirstAgendaId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const walk = (node: unknown): string => {
    if (Array.isArray(node)) {
      for (const item of node) { const r = walk(item); if (r) return r; }
      return "";
    }
    if (!node || typeof node !== "object") return "";
    const obj = node as Record<string, unknown>;
    for (const key of ["id", "Id", "agendaId", "agenda_id", "agendaid"]) {
      const v = obj[key];
      if ((typeof v === "string" || typeof v === "number") && String(v).trim()) {
        return String(v).trim();
      }
    }
    for (const v of Object.values(obj)) {
      const r = walk(v); if (r) return r;
    }
    return "";
  };
  return walk(payload);
}

// ─── P6 : SlotInfo enrichi pour l'email admin ──────────────────────────────────

/**
 * Construit un résumé complet des créneaux éligibles pour l'email admin.
 * Format : "23 sept (08:30-12:30, 9 crén., 12 places), 24 sept (6 crén., 9 places)"
 * Montre TOUTES les dates avec plage horaire + nombre de créneaux + total places.
 */
function buildSlotInfoSummary(eligible: WorkerSlot[]): string {
  if (eligible.length === 0) return "";

  // Grouper par date
  const byDate = new Map<string, { times: string[]; totalFree: number }>();
  for (const s of eligible) {
    const entry = byDate.get(s.date);
    if (entry) {
      if (s.time && !entry.times.includes(s.time)) entry.times.push(s.time);
      entry.totalFree += s.freeslots;
    } else {
      byDate.set(s.date, { times: s.time ? [s.time] : [], totalFree: s.freeslots });
    }
  }

  // Formater chaque date
  const parts: string[] = [];
  const sortedDates = Array.from(byDate.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [dateStr, { times, totalFree }] of sortedDates) {
    // Formater la date en "23 sept" ou "3 oct"
    const d = new Date(dateStr);
    const months = ["janv", "fév", "mars", "avr", "mai", "juin", "juil", "août", "sept", "oct", "nov", "déc"];
    const dateFmt = !isNaN(d.getTime())
      ? `${d.getDate()} ${months[d.getMonth()]}`
      : dateStr;

    times.sort();
    const timeRange = times.length > 1
      ? `${times[0]}-${times[times.length - 1]}`
      : times.length === 1 ? times[0] : "";

    const countStr = `${times.length} crén.`;
    const freeStr = `${totalFree} place${totalFree > 1 ? "s" : ""}`;
    const detail = [timeRange, countStr, freeStr].filter(Boolean).join(", ");
    parts.push(`${dateFmt} (${detail})`);
  }

  // Si trop de dates, tronquer avec "…"
  if (parts.length > 5) {
    const totalSlots = eligible.length;
    const totalFree = eligible.reduce((sum, s) => sum + s.freeslots, 0);
    return `${parts.slice(0, 4).join(", ")}… +${parts.length - 4} dates (${totalSlots} crén., ${totalFree} places total)`;
  }
  return parts.join(", ");
}

// ─── Fenêtre de dates ─────────────────────────────────────────────────────────

function isSlotInDateWindow(
  slotDate: string,
  config: SpainDossierConfig,
  tag: string,
): boolean {
  if (!slotDate) return true;
  const slot = new Date(slotDate);
  if (isNaN(slot.getTime())) return true;

  // Passé → toujours non
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  if (slot < todayMidnight) {
    log("INFO", `${tag} ⏭️ créneau ${slotDate} passé`);
    return false;
  }

  if (config.slotDateFrom && SLOT_FROM_TOLERANCE_DAYS >= 0) {
    const from = new Date(config.slotDateFrom);
    if (!isNaN(from.getTime())) {
      const fromWithTolerance = new Date(
        from.getTime() - SLOT_FROM_TOLERANCE_DAYS * 86_400_000,
      );
      if (slot < fromWithTolerance) {
        log(
          "INFO",
          `${tag} ⏭️ créneau ${slotDate} trop avant slotDateFrom ${config.slotDateFrom} (tol. ${SLOT_FROM_TOLERANCE_DAYS}j)`,
        );
        return false;
      }
    }
  }

  if (config.slotDateDeadline) {
    const deadline = new Date(config.slotDateDeadline);
    if (!isNaN(deadline.getTime()) && slot > deadline) {
      log(
        "INFO",
        `${tag} ⏭️ créneau ${slotDate} après deadline ${config.slotDateDeadline}`,
      );
      return false;
    }
  }

  return true;
}

// ─── Reporting Convex ─────────────────────────────────────────────────────────

function emitDiscoveryEvents(
  slots: WorkerSlot[],
  serviceId: string | undefined,
  serviceName: string | undefined,
  config: SpainDossierConfig,
): void {
  const office = serviceName || "TRAMITACIÓN DE VISADOS";
  const events: SlotDiscoveryEvent[] = [];

  const sorted = [...slots].sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );

  for (const slot of sorted) {
    if (!slot.date) continue;
    if (events.length >= MAX_DISCOVERY_EVENTS_PER_CYCLE) break;
    events.push({
      applicationId: config.applicationId,
      destination: "spain",
      office,
      dateFound: slot.date,
      timeFound: slot.time || undefined,
      outcome: "captured",
      context: {
        serviceId,
        freeSlots: slot.freeslots,
        agendaId: slot.agendaId,
        applicant: config.applicantName,
        source: "worker_scan_datetime",
      },
      mode: "schedule",
    });
  }

  if (events.length > 0) {
    reportSlotDiscoveryBatch(events);
  }
}

async function reportBookingSuccess(
  config: SpainDossierConfig,
  result: SpainBookingResult,
  slot: WorkerSlot,
  scan: WorkerScanResult,
  tag: string,
): Promise<void> {
  const bookedDate = result.bookedDate ?? slot.date;
  const bookedTime = result.bookedTime ?? slot.time;

  // Email admin : booking réussi avec date + heure + locator (fire-and-forget)
  reportBookingLog({
    applicationId: config.applicationId,
    dossierId: config.id,
    applicantName: config.applicantName,
    date: bookedDate,
    time: bookedTime,
    status: "booked",
    locator: result.locator,
    serviceName: scan.serviceName,
  }).catch(() => {});

  try {
    await reportSlotFound({
      applicationId: config.applicationId,
      date: bookedDate,
      time: bookedTime,
      location: scan.serviceName ?? "TRAMITACIÓN DE VISADOS",
      confirmationCode: result.locator,
    });
    log(
      "INFO",
      `${tag} ✅ Booking reporté Convex (date: ${bookedDate} ${bookedTime})`,
    );
  } catch (e) {
    log("WARN", `${tag} reportSlotFound Convex error: ${e}`);
  }

  // Upload PDF de confirmation si présent
  if (result.confirmationPdf) {
    try {
      const base64 = result.confirmationPdf.toString("base64");
      const storageId = await uploadFile(base64, "application/pdf");
      if (storageId) {
        const docKey = `confirmation_${bookedDate}_${config.applicantName.replace(/\s+/g, "_")}`;
        await attachConfirmationDoc({
          applicationId: config.applicationId,
          storageId,
          docKey,
          label: `Confirmation ${bookedDate}`,
        });
      }
    } catch (e) {
      log("WARN", `${tag} PDF upload error: ${e}`);
    }
  }
}


// ─── Utilitaires ─────────────────────────────────────────────────────────────

function buildJQueryCallback(): string {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 1_000_000_000);
  return `jQuery21109${ts}_${rnd}`;
}

function extractPublickey(portalUrl: string): string {
  return (
    portalUrl.match(/\/([a-f0-9]{20,})\/?(?:[?#].*)?$/i)?.[1] ?? ""
  );
}

function ensureTrailingSlash(url: string): string {
  const stripped = url.split("?")[0].split("#")[0];
  return stripped.endsWith("/") ? stripped : `${stripped}/`;
}

function maskProxy(url: string): string {
  try {
    const parsed = new URL(url.startsWith("http") ? url : `http://${url}`);
    return `${parsed.hostname}:${parsed.port}`;
  } catch {
    return url.slice(0, 30);
  }
}

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Merge les cookies Set-Cookie d'une Response dans session.allCookies.
 * Met à jour en place les cookies existants, ajoute les nouveaux.
 */
function mergeCookiesFromResponse(res: Response, session: SpainCfSession): void {
  // getSetCookie() est disponible dans Node 18+ et impit Response
  const setCookieHeader =
    typeof (res.headers as any).getSetCookie === "function"
      ? (res.headers as any).getSetCookie() as string[]
      : [];

  for (const sc of setCookieHeader) {
    const [nameVal = ""] = sc.split(";", 1);
    const sep = nameVal.indexOf("=");
    if (sep <= 0) continue;
    const name = nameVal.slice(0, sep).trim();
    const value = nameVal.slice(sep + 1).trim();
    if (!name || !value) continue;
    const idx = session.allCookies.findIndex((c) => c.name === name);
    if (idx >= 0) {
      session.allCookies[idx] = { name, value };
    } else {
      session.allCookies.push({ name, value });
    }
  }
}
