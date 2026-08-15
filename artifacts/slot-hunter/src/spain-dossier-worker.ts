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
  type DynamicSession,
} from "./spain-bookitit-direct.js";
import {
  callBookititEndpoint,
  refreshPhpsessidForCapsolver,
  type SpainBookingResult,
} from "./spain-http-booking.js";
import { confirmSlotsViaDatetime } from "./spain-http-scanner.js";
import {
  tryClaimSlot,
  releaseSlotClaim,
  reserveWorkerIp,
  isIpReservedByOther,
  releaseWorkerIp,
} from "./spain-slot-coordinator.js";
import {
  getDecodoProxyForIndex,
  getDecodoPoolSize,
  flagDecodoIp,
  isDecodoIpBlacklisted,
} from "./spain-decodo-pool.js";
import {
  reportSlotFound,
  sendHeartbeat,
  reportSlotDiscoveryBatch,
  reportSpainWatcherScan,
  attachConfirmationDoc,
  uploadFile,
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
}

export interface WorkerResult {
  dossierId: string;
  status: "booked" | "exited" | "error";
  errorMessage?: string;
}

// ─── Constantes ───────────────────────────────────────────────────────────────

/** Fenêtre de surveillance par dossier (25 min) — alignée TTL cf_clearance */
const WORKER_WINDOW_MS = ((): number => {
  const v = Number(process.env.SPAIN_WORKER_WINDOW_MIN ?? "25");
  return (Number.isFinite(v) ? v : 25) * 60_000;
})();

/** Intervalle de scan start-to-start (secondes → ms) */
const SCAN_INTERVAL_MS = ((): number => {
  const s = Number(process.env.SPAIN_HTTP_SCAN_INTERVAL_SEC ?? "10");
  return Math.max(5, Number.isFinite(s) ? s : 10) * 1_000;
})();

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
  status: "found" | "not_found" | "error" | "ajax_unavailable";
  slots?: WorkerSlot[];
  mainHtml?: string;
  serviceId?: string;
  serviceName?: string;
  agendaId?: string;
  errorMessage?: string;
}


// ─── PHP State (init one-shot, partagé entre tous les cycles) ─────────────────

interface WorkerPhpState {
  services: Array<{ serviceId: string; serviceName: string }>;
  agendaId: string;
  bestServiceId: string;
  bestServiceName: string;
  /** DynamicSession partagé — même impit + reqCounter pour tous les appels impit directs */
  ds: DynamicSession;
}

/**
 * Initialise l'état PHP Bookitit une seule fois par session.
 * Reproduit exactement la section 3 de test-bookitit-dynamic.ts :
 *   getwidgetconfigurations/ → getservices/ → getagendas/
 *
 * RÈGLE §9 : getagendas/ ne peut être appelé qu'UNE FOIS par PHPSESSID.
 * Ensuite, les cycles de scan n'appellent QUE datetime/ — pas de réinit.
 */
async function initPhpState(
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
  await callDirect(ds, "getwidgetconfigurations/");

  // 2. getservices/ — une seule réponse par PHPSESSID (règle identique à getagendas/)
  const svcPayload = await callDirect(ds, "getservices/") as any;
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
  }) as any;

  const rawAgendas: Array<{ id: string }> =
    agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = rawAgendas.find((a) => a?.id)?.id ?? "";

  log("INFO", `${tag} ✅ PHP init OK — agenda=${agendaId || "(vide)"} | cycles suivants: datetime/ direct`);

  return { services, agendaId, bestServiceId: bestSvc.serviceId, bestServiceName: bestSvc.serviceName, ds };
}

/**
 * Un cycle de scan direct — appelle UNIQUEMENT datetime/ avec le phpState déjà initialisé.
 * Reproduit la section 4 de test-bookitit-dynamic.ts (boucle mois par mois).
 *
 * @returns WorkerScanResult   — slots trouvés ou not_found
 * @returns "session_dead"     — datetime/ retourne null (0B) → session PHP morte
 */
async function scanDatetimeDirect(
  phpState: WorkerPhpState,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerScanResult> {
  const ds = phpState.ds;

  const now = new Date();
  const allSlots: WorkerSlot[] = [];
  let globalMaxDays: Date | null = null;
  let consecutiveEmpty = 0;
  const MAX_MONTHS = Math.max(DATETIME_MONTHS_AHEAD + 2, 12); // ≥ 12 comme le test dynamic

  let monthOffset = 0;
  while (monthOffset < MAX_MONTHS) {
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const startStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const endStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

    const extra: Record<string, string> = {
      "services[]": phpState.bestServiceId,
      start: startStr,
      end: endStr,
      selectedPeople: String(config.groupSize && config.groupSize > 1 ? config.groupSize : 1),
    };
    if (phpState.agendaId) extra["agendas[]"] = phpState.agendaId;

    const payload = await callDirect(ds, "datetime/", extra);

    // EXACTEMENT comme le test dynamic l.242-305 : si payload null (0B) →
    // dtData = null → maxDaysRaw = "" → Slots = [] → 0 créneaux ce mois.
    // On NE retourne PAS "session_dead" — c'est normal quand pas d'agenda.
    const dtData = payload as any;
    const maxDaysRaw: string = dtData?.maxDays ?? "";
    if (maxDaysRaw?.match(/^\d{4}-\d{2}-\d{2}$/)) {
      const parsed = new Date(maxDaysRaw + "T23:59:59");
      if (!globalMaxDays || parsed > globalMaxDays) globalMaxDays = parsed;
    }

    const slots = extractAllSlotsFromPayload(payload, phpState.agendaId, config.groupSize ?? 1);
    log(
      "INFO",
      `${tag}   ${monthLabel}: ${slots.length > 0 ? slots.length + " créneau(x)" : payload === null ? "0 (0B)" : "0 (vide)"}  | maxDays=${maxDaysRaw || "(absent)"}`,
    );

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

  if (allSlots.length === 0) {
    return { status: "not_found", serviceId: phpState.bestServiceId, serviceName: phpState.bestServiceName };
  }

  allSlots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  return {
    status: "found",
    slots: allSlots,
    serviceId: phpState.bestServiceId,
    serviceName: phpState.bestServiceName,
    agendaId: phpState.agendaId,
  };
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

  for (let attempt = 0; attempt < MAX_SESSION_RETRIES; attempt++) {
    if (!proxyUrl) break; // mode direct sans proxy

    // Sticky session : même exit IP pour impit ET CapSolver
    const stickyId = Math.random().toString(36).slice(2, 10);
    const stickyProxy = addStickySession(proxyUrl, stickyId);
    log("INFO", `${tag} 🔐 Session init (tentative ${attempt + 1}/${MAX_SESSION_RETRIES}) — ${maskProxy(stickyProxy)} sid=${stickyId}`);

    const result = await initWorkerSession(stickyProxy, portalUrlNoFrag, capsolverKey);

    if (result) {
      session = result.session;
      // proxyUrl = stickyProxy pour que le finally libère la bonne URL
      proxyUrl = stickyProxy;
      log("INFO", `${tag} ✅ Session établie — PHPSESSID ✅ | /main/ ${session.prefetchedMainHtml?.length ?? 0}B`);
      break;
    }

    // Échec → flag + libérer + prendre le suivant
    log("WARN", `${tag} ❌ initWorkerSession échoué — flag + rotation (tentative ${attempt + 1})`);
    flagDecodoIp(proxyUrl, "init-session-failed");
    await releaseWorkerIp(proxyUrl, config.id).catch(() => {});

    const nextProxy = await pickDedicatedProxy(config.id, tag);
    if (!nextProxy) { log("WARN", `${tag} Pool Decodo épuisé`); proxyUrl = ""; break; }
    proxyUrl = nextProxy;
  }

  if (!session) {
    workerResult = { dossierId: config.id, status: "error", errorMessage: "Impossible d'établir session après retries" };
    return workerResult;
  }

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

  // ── 7. Boucle de scan — uniquement datetime/ (pas de réinit PHP) ───────────
  // Identique à la section 4 de test-bookitit-dynamic.ts — boucle mois par mois.
  // Si datetime/ → 0B (session morte) : rotation IP + réinit PHP, continue.
  const windowEnd = Date.now() + WORKER_WINDOW_MS;
  let cycleCount = 0;

  while (Date.now() < windowEnd) {
    cycleCount++;
    const cycleStart = Date.now();

    try {
      // phpState est toujours non-null ici : le seul chemin qui le ré-assigne
      // (rotation IP) renvoie/break immédiatement si l'init échoue.
      if (!phpState) break;
      const scan = await scanDatetimeDirect(phpState, config, tag);

      // ── Reporting scan Convex (par dossier) ─────────────────────────────────
      void reportSpainWatcherScan({
        status: scan.status === "found" ? "found" : "not_found",
        applicationId: config.applicationId,
        dossierName: config.applicantName,
        detectedSlots: scan.status === "found" && scan.slots
          ? JSON.stringify(scan.slots.slice(0, 20).map((s) => ({ d: s.date, t: s.time, n: s.freeslots })))
          : undefined,
      }).catch(() => {});

      // ── Reporting découverte (fire-and-forget) ──────────────────────────
      if (scan.slots && scan.slots.length > 0) {
        emitDiscoveryEvents(scan.slots, scan.serviceId, scan.serviceName, config);
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

        if (eligible.length === 0) {
          log(
            "INFO",
            `${tag} Cycle ${cycleCount}: ${scan.slots.length} créneau(x) hors fenêtre — next`,
          );
        } else {
          const slot = eligible[0]; // Meilleur créneau (trié par date ASC dans le scan)

          // Claim atomique Redis (Lua)
          const claimed = await tryClaimSlot(
            slot.date,
            slot.time,
            slot.agendaId ?? "",
            config.id,
            groupSize,
            slot.freeslots,
          );

          if (!claimed) {
            log(
              "INFO",
              `${tag} Cycle ${cycleCount}: créneau ${slot.date} ${slot.time} déjà pris → next`,
            );
          } else {
            log(
              "INFO",
              `${tag} Cycle ${cycleCount}: ✅ Créneau ${slot.date} ${slot.time} (freeSlots=${slot.freeslots}) — booking en cours…`,
            );

            // ── Booking inline — même session, même PHPSESSID que le scan ────────────
            // Source de vérité : test-bookitit-dynamic.ts section 5.
            // getsigninfields/ amorce le nonce PHP → signin/ le consomme → summary/ confirme.
            // PAS de nouvelle session isolée : le nonce est lié au PHPSESSID du scan.
            const bookT0 = Date.now();
            const widgetUrl = session.bookititState!.widgetUrl;
            const baseBookParams: Record<string, string | string[]> = {
              type:    "default",
              publickey: session.bookititState!.publickey,
              lang:    "es",
              version: session.bookititState!.version,
              src:     widgetUrl,
              srvsrc:  session.bookititState!.srvsrc,
              "services[]": scan.serviceId!,
              ...(slot.agendaId ? { "agendas[]": slot.agendaId } : {}),
              date:    slot.date,
              time:    slot.time,
              selectedPeople: String(config.groupSize && config.groupSize > 1 ? config.groupSize : 1),
            };

            // ── Refresh PHPSESSID + réinitialisation état PHP avant getsigninfields/ ──
            // Après N cycles de scan sur le même PHPSESSID, la session PHP est épuisée
            // → getsigninfields/ → 0B. Fix : reproduire EXACTEMENT la séquence du
            // test-bookitit-dynamic.ts sur un PHPSESSID vierge :
            //   1. GET widget → POST token → /main/  (refreshPhpsessidForCapsolver)
            //   2. getwidgetconfigurations/           (initialise l'état PHP widget)
            //   3. getservices/                       (contextualise le service PHP)
            //   4. getagendas/                        (contextualise l'agenda PHP)
            //   5. datetime/ pour LE mois du créneau  (active le nonce date/heure)
            //   6. getsigninfields/                   (consomme le nonce → formulaire)
            // "Rien entre datetime et getsigninfields/" = vrai dans le dynamic, car les
            // 4 appels de setup sont AVANT le dernier datetime/, pas entre lui et sign.
            log("INFO", `${tag} 🔄 Refresh PHPSESSID (GET widget → POST token → /main/)…`);
            await refreshPhpsessidForCapsolver(session, config.portalUrl);

            // 2. getwidgetconfigurations/ — initialise le widget côté PHP
            log("INFO", `${tag} 🔧 Init PHP: getwidgetconfigurations/…`);
            await callBookititEndpoint(session, "getwidgetconfigurations/", {}, widgetUrl);

            // 3. getservices/ — contextualise le service dans la session PHP
            log("INFO", `${tag} 🔧 Init PHP: getservices/…`);
            await callBookititEndpoint(session, "getservices/", {}, widgetUrl);

            // 4. getagendas/ — contextualise l'agenda dans la session PHP
            log("INFO", `${tag} 🔧 Init PHP: getagendas/…`);
            await callBookititEndpoint(session, "getagendas/", {
              "services[]": scan.serviceId!,
            }, widgetUrl);

            // 5. datetime/ pour le mois du créneau — active le nonce date/heure PHP
            {
              const slotMonth = slot.date.slice(0, 7); // "YYYY-MM"
              const lastDay = new Date(
                Number(slotMonth.slice(0, 4)),
                Number(slotMonth.slice(5, 7)),
                0,
              ).getDate();
              log("INFO", `${tag} 🔧 Init PHP: datetime/ ${slotMonth}…`);
              await callBookititEndpoint(session, "datetime/", {
                "services[]": scan.serviceId!,
                ...(slot.agendaId ? { "agendas[]": slot.agendaId } : {}),
                start: `${slotMonth}-01`,
                end:   `${slotMonth}-${String(lastDay).padStart(2, "0")}`,
                selectedPeople: String(config.groupSize && config.groupSize > 1 ? config.groupSize : 1),
              }, widgetUrl);
            }

            // 6. getsigninfields/ — amorce le nonce PHP (sans ça, signin/ → 0B, confirmé 2026-08-12)
            log("INFO", `${tag} 🔑 getsigninfields/…`);
            const gsfPayload = await callBookititEndpoint(session, "getsigninfields/", baseBookParams, widgetUrl);
            if (!gsfPayload) log("WARN", `${tag} getsigninfields/ → 0B (signin/ risque 0B)`);

            // signin/ — logintype=document confirmé par capture 2026-07-28
            log("INFO", `${tag} 🔑 signin/…`);
            const signinPayload = await callBookititEndpoint(session, "signin/", {
              ...baseBookParams,
              logintype: "document",
              login:     config.login,
              password:  config.password,
              comments:  "",
            }, widgetUrl) as Record<string, unknown> | null;

            const signinInner = (signinPayload as any)?.Client ?? signinPayload;
            const bktToken    = String(signinInner?.bktToken ?? (signinPayload as any)?.bktToken ?? "");
            const signinErrors: Array<{ message?: string }> = Array.isArray(signinInner?.errors) ? signinInner.errors : [];

            let bookResult: SpainBookingResult;

            if (!bktToken) {
              const errMsg = signinErrors.length
                ? signinErrors.map((e) => e.message).join(", ")
                : (signinPayload ? "signin/ sans bktToken" : "signin/ → 0B");
              log("WARN", `${tag} ❌ signin/ échoué: ${errMsg}`);
              bookResult = { status: "signin_failed", errorMessage: errMsg, durationMs: Date.now() - bookT0 };
            } else {
              // summary/ — confirmation finale
              log("INFO", `${tag} 📝 summary/ (bktToken: ${bktToken.slice(0, 15)}…)…`);
              const summaryPayload = await callBookititEndpoint(session, "summary/", {
                ...baseBookParams,
                bktToken,
                login:     config.login,
                logintype: "document",
              }, widgetUrl) as any;

              // Extraire locator — même logique que executeHttpBooking ligne 1607-1617
              const s0 = Array.isArray(summaryPayload) ? summaryPayload[0] : summaryPayload;
              const locator: string =
                s0?.Event?.locator ?? s0?.Appointment?.locator ??
                summaryPayload?.Event?.locator ?? summaryPayload?.Appointment?.locator ?? "";

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
                const summaryErr = JSON.stringify(summaryPayload?.Exception?.errors ?? summaryPayload?.errors ?? summaryPayload).slice(0, 200);
                bookResult = { status: "booking_failed", errorMessage: `summary/ sans locator: ${summaryErr}`, durationMs: Date.now() - bookT0 };
              }
            }

            log(
              "INFO",
              `${tag} Booking: ${bookResult.status}` +
              (bookResult.locator ? ` | locator: ${bookResult.locator}` : "") +
              (bookResult.errorMessage ? ` | ${bookResult.errorMessage}` : ""),
            );

            if (bookResult.status === "booked") {
              await reportBookingSuccess(config, bookResult, slot, scan, tag);
              workerResult = { dossierId: config.id, status: "booked" };
              return workerResult;
            }

            // Booking échoué → libérer le claim de créneau de CE dossier immédiatement.
            releaseSlotClaim(slot.date, slot.time, slot.agendaId ?? "", config.id).catch(() => {});

            sendHeartbeat({
              applicationId: config.applicationId,
              result: "error",
              errorMessage: `Booking ${bookResult.status}: ${bookResult.errorMessage}`,
            }).catch(() => {});
          }
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

    // Attendre jusqu'au prochain cycle (start-to-start)
    const elapsed = Date.now() - cycleStart;
    const wait = Math.max(0, SCAN_INTERVAL_MS - elapsed);
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
    // Libération garantie de l'IP, quelle que soit la sortie (return, throw, exception).
    // Owner-check Lua : seul ce dossier peut supprimer sa réservation.
    // proxyUrl = "" → mode direct, pas de réservation Redis à libérer.
    if (proxyUrl) {
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
): Promise<string | null> {
  log("WARN", `${tag} 🔄 Rotation IP (/main/ 0B) — libération ${maskProxy(currentProxyUrl)} …`);

  // 1. Libérer l'IP courante et la blacklister
  if (currentProxyUrl) {
    flagDecodoIp(currentProxyUrl, "main-0b-rotation");
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

  // Essayer chaque index du pool dans l'ordre
  for (let i = 0; i < poolSize; i++) {
    const url = getDecodoProxyForIndex(i) ?? "";
    if (!url) continue;

    // Skip les IPs blacklistées (portal-html-403, probe-error, etc.)
    if (isDecodoIpBlacklisted(url)) continue;

    const reserved = await isIpReservedByOther(url, dossierId);
    if (reserved) continue;

    // Tenter de réserver
    const ok = await reserveWorkerIp(url, dossierId);
    if (ok) {
      log("INFO", `${tag} IP Decodo réservée : ${maskProxy(url)} (index ${i})`);
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
  const jm = body.match(/^[^\(]+\("(.*)"\);?\s*$/s);
  if (jm?.[1]) {
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

  const minFree = groupSize > 1 ? groupSize : 1;
  const result: WorkerSlot[] = [];

  for (const day of obj.Slots) {
    if (!day || typeof day !== "object") continue;
    const d = day as Record<string, unknown>;
    const date = typeof d.date === "string" ? d.date : "";
    if (!date) continue;

    const slotAgendaId =
      d.agenda != null ? String(d.agenda)
      : d.agenda_id != null ? String(d.agenda_id)
      : agendaId;

    const stateNum =
      typeof d.state === "number" ? d.state
      : typeof d.state === "string" ? parseInt(d.state, 10) : -1;

    const times = d.times;

    // Saopola : times=[] + state=1 → jour disponible sans heure
    if (Array.isArray(times) && times.length === 0 && stateNum === 1) {
      result.push({ date, time: "09:00", agendaId: slotAgendaId, freeslots: 1 });
      continue;
    }

    if (!times || typeof times !== "object" || Array.isArray(times)) continue;
    const timesObj = times as Record<string, unknown>;

    const entries = Object.entries(timesObj).sort(([a], [b]) =>
      a.localeCompare(b),
    );

    for (const [timeKey, v] of entries) {
      if (!v || typeof v !== "object") continue;
      const t = v as Record<string, unknown>;
      const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
      const free =
        typeof freeRaw === "number" ? freeRaw
        : typeof freeRaw === "string" ? parseInt(freeRaw, 10) : -1;

      const hasAvailability = free > 0 || free === -1;
      if (!hasAvailability) continue;
      // Vérification capacité groupSize
      if (free !== -1 && free < minFree) continue;

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
