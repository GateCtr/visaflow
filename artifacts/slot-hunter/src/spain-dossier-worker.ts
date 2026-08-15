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
  spainCfFetch,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import {
  callBookititEndpoint,
  executeHttpBooking,
  type SpainBookingConfig,
  type SpainBookingResult,
} from "./spain-http-booking.js";
import { extractServiceDetails } from "./spain-http-scanner.js";
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
} from "./spain-decodo-pool.js";
import {
  reportSlotFound,
  sendHeartbeat,
  reportSlotDiscoveryBatch,
  attachConfirmationDoc,
  uploadFile,
  type SlotDiscoveryEvent,
} from "./convexClient.js";
import { log } from "./scheduler-utils.js";

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
  status: "found" | "not_found" | "error";
  slots?: WorkerSlot[];
  mainHtml?: string;
  serviceId?: string;
  serviceName?: string;
  agendaId?: string;
  errorMessage?: string;
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

  // ── 2. Créer impit dédié + probe portail CF ───────────────────────────────────
  // CRITIQUE : l'impit est créé ICI, avant le solve CF.
  // Il servira pour (a) capturer le HTML du challenge CF, et (b) toutes les requêtes
  // suivantes (session._ownImpit). Cela garantit une empreinte TLS cohérente :
  // CapSolver reçoit le challenge issu de CET impit → le cf_clearance est lié à sa TLS.
  const probeImpit = createImpitWithProxy(proxyUrl ?? "");

  log(
    "INFO",
    `${tag} 🔎 Probe portail CF → ${proxyUrl ? maskProxy(proxyUrl) : "direct"} …`,
  );
  const { challengeHtml, ua: probeUA, proxyError: probeProxyError } = await captureChallengePage(
    probeImpit,
    config.portalUrl,
    tag,
  );

  // Probe a détecté que le proxy est injoignable → blacklist immédiate avant solve
  if (probeProxyError && proxyUrl) {
    log("WARN", `${tag} 🚫 Probe proxy injoignable — blacklist ${maskProxy(proxyUrl)}`);
    flagDecodoIp(proxyUrl, "probe-connect-error");
    workerResult = {
      dossierId: config.id,
      status: "error",
      errorMessage: `Proxy injoignable au probe CF: ${maskProxy(proxyUrl)}`,
    };
    return workerResult;
  }

  // ── 3. Solve CF en passant le HTML capturé ───────────────────────────────────
  // Sans HTML : cf_clearance lié au Chrome CapSolver → impit reçoit 403/0B (TLS différent)
  // Avec HTML  : cf_clearance lié à la TLS impit → impit reçoit 200 (cohérence TLS)
  log(
    "INFO",
    `${tag} 🔐 Solve CF (html: ${challengeHtml ? `${challengeHtml.length}B` : "absent"}) …`,
  );
  const solveResult = await solveSpainCloudflare(
    config.portalUrl,
    capsolverKey,
    proxyUrl ?? "",
    challengeHtml || undefined,
    challengeHtml ? probeUA : undefined,
  );

  if (!solveResult.success || !solveResult.session) {
    // Si l'échec est dû au proxy injoignable → blacklist immédiate
    if (proxyUrl && isProxyConnectError(solveResult.error)) {
      log("WARN", `${tag} 🚫 Solve CF proxy injoignable — blacklist ${maskProxy(proxyUrl)}`);
      flagDecodoIp(proxyUrl, `solve-proxy-error: ${solveResult.error?.slice(0, 60)}`);
    }
    workerResult = {
      dossierId: config.id,
      status: "error",
      errorMessage: `CF solve échoué: ${solveResult.error}`,
    };
    return workerResult;
  }

  // ── 4. Session complète : MÊME impit que le probe ───────────────────────────
  // probeImpit = instance ayant fait le probe et dont la TLS est liée au cf_clearance
  // Ne pas créer un nouvel impit ici — cela casserait la cohérence TLS.
  const session: SpainCfSession = {
    ...solveResult.session,
    source: "capsolver",
    _ownImpit: probeImpit,
  };

  // Pré-remplir bookititState minimal pour que callBookititEndpoint et
  // makeBookititUrl fonctionnent sans aller chercher le portail à nouveau.
  const publickey = extractPublickey(config.portalUrl);
  if (publickey && !session.bookititState) {
    session.bookititState = {
      jqCallback: buildJQueryCallback(),
      reqCounter: 0,
      srvsrc: "https://www.citaconsular.es",
      version: "4",
      widgetUrl: ensureTrailingSlash(config.portalUrl),
      publickey,
      bookititBase: "https://www.citaconsular.es/onlinebookings/",
    };
  }

  log("INFO", `${tag} ✅ CF résolu (${solveResult.durationMs}ms) — init portail…`);

  // ── 5. Initialiser PHPSESSID via la séquence portail ─────────────────────────
  const phpOk = await initPortalSession(session, config.portalUrl, tag);
  if (!phpOk) {
    log(
      "WARN",
      `${tag} ⚠️ Portail init incomplet — le PHPSESSID est absent ou invalide ; le scan peut échouer`,
    );
  }

  // ── 6. Boucle de scan ────────────────────────────────────────────────────────
  const windowEnd = Date.now() + WORKER_WINDOW_MS;
  let cycleCount = 0;

  while (Date.now() < windowEnd) {
    cycleCount++;
    const cycleStart = Date.now();

    try {
      const scan = await workerScanCycle(session, config, tag);

      // ── Reporting découverte (fire-and-forget) ──────────────────────────
      if (scan.slots && scan.slots.length > 0) {
        emitDiscoveryEvents(scan.slots, scan.serviceId, scan.serviceName, config);
      }

      if (scan.status === "found" && scan.slots && scan.slots.length > 0) {
        const groupSize = config.groupSize && config.groupSize > 1 ? config.groupSize : 1;

        // Filtrer par fenêtre de dates
        const eligible = scan.slots.filter((s) => isSlotInDateWindow(s.date, config, tag));

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

            const bookResult = await executeHttpBooking(
              session,
              config.portalUrl,
              scan.mainHtml ?? "",
              buildBookingConfig(config, scan, slot),
            );

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
            // Atomic Lua : retire seulement la réservation de config.id (pas les autres dossiers)
            releaseSlotClaim(slot.date, slot.time, slot.agendaId ?? "", config.id).catch(() => {});

            // Heartbeat d'erreur
            sendHeartbeat({
              applicationId: config.applicationId,
              result: "error",
              errorMessage: `Booking ${bookResult.status}: ${bookResult.errorMessage}`,
            }).catch(() => {});
          }
        }
      } else if (scan.status === "error") {
        log("WARN", `${tag} Cycle ${cycleCount}: ${scan.errorMessage}`);

        // 0B = IP bloquée par Bookitit → rotation IP (comme l'ancien système).
        // On ne sort pas du worker : on change d'IP et on continue le scan.
        if (
          scan.errorMessage?.includes("0B") &&
          Date.now() + 3 * 60_000 < windowEnd  // au moins 3 min restantes pour valoir la peine
        ) {
          const newProxy = await rotateWorkerIp(session, proxyUrl, config, capsolverKey, tag);
          if (newProxy === null) {
            // Pool épuisé ou solve échoué — plus d'IP disponible, on sort
            workerResult = { dossierId: config.id, status: "error", errorMessage: "Pool Decodo épuisé après rotation" };
            proxyUrl = ""; // éviter double-release dans finally (déjà libérée dans rotateWorkerIp)
            return workerResult;
          }
          proxyUrl = newProxy; // finally libérera la nouvelle IP
          cycleCount = 0;     // reset compteur pour repartir proprement
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
): Promise<{ challengeHtml: string; ua: string; proxyError: boolean }> {
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

    log(
      "INFO",
      `${tag} Probe portail: HTTP ${res.status}, ${html.length}B ` +
      (isCfChallenge ? "✅ CF challenge détecté" : "(pas de challenge — session directe)"),
    );

    return { challengeHtml: html, ua: IMPIT_CHROME_UA, proxyError: false };
  } catch (e) {
    const errMsg = String(e);
    const proxyError = isProxyConnectError(errMsg);
    log(
      proxyError ? "WARN" : "WARN",
      `${tag} Probe portail error${proxyError ? " (proxy injoignable)" : ""}: ${e} — solve CF sans HTML (risque 403)`,
    );
    return { challengeHtml: "", ua: IMPIT_CHROME_UA, proxyError };
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
  log("WARN", `${tag} 🔄 Rotation IP (0B détecté) — libération ${maskProxy(currentProxyUrl)} …`);

  // 1. Libérer l'IP courante
  if (currentProxyUrl) {
    await releaseWorkerIp(currentProxyUrl, config.id).catch(() => {});
  }

  // 2. Sélectionner la prochaine IP disponible
  const newProxy = await pickDedicatedProxy(config.id, tag);
  if (newProxy === null) {
    log("WARN", `${tag} ❌ Rotation impossible — pool Decodo épuisé`);
    return null;
  }

  log("INFO", `${tag} 🔄 Nouvelle IP : ${maskProxy(newProxy)} — probe CF …`);

  // 3 + 4. Nouvel impit + probe portail
  const newImpit = createImpitWithProxy(newProxy ?? "");
  const { challengeHtml, ua, proxyError: probeProxyError } = await captureChallengePage(newImpit, config.portalUrl, tag);

  // Probe a détecté que la nouvelle IP est injoignable → blacklist immédiate
  if (probeProxyError && newProxy) {
    log("WARN", `${tag} 🚫 Rotation probe proxy injoignable — blacklist ${maskProxy(newProxy)}`);
    flagDecodoIp(newProxy, "rotation-probe-connect-error");
    await releaseWorkerIp(newProxy, config.id).catch(() => {});
    return null;
  }

  // 5. Solve CF avec le HTML du nouvel impit
  const solveResult = await solveSpainCloudflare(
    config.portalUrl,
    capsolverKey,
    newProxy ?? "",
    challengeHtml || undefined,
    challengeHtml ? ua : undefined,
  );

  if (!solveResult.success || !solveResult.session) {
    // Si l'échec est dû au proxy injoignable → blacklist immédiate
    if (newProxy && isProxyConnectError(solveResult.error)) {
      log("WARN", `${tag} 🚫 Rotation solve CF proxy injoignable — blacklist ${maskProxy(newProxy)}`);
      flagDecodoIp(newProxy, `rotation-solve-proxy-error: ${solveResult.error?.slice(0, 60)}`);
    }
    log("WARN", `${tag} ❌ Rotation CF solve échoué: ${solveResult.error} — libération ${maskProxy(newProxy)}`);
    if (newProxy) await releaseWorkerIp(newProxy, config.id).catch(() => {});
    return null;
  }

  // 6. Mise à jour session EN PLACE — préserve les états internes (bookititState, etc.)
  const newSession = solveResult.session;
  session.cfClearance   = newSession.cfClearance;
  session.soaxProxyUrl  = newProxy ?? "";
  session._ownImpit     = newImpit; // même impit que le probe → TLS cohérent
  // Fusionner les cookies CF dans la session courante
  for (const c of newSession.allCookies) {
    const idx = session.allCookies.findIndex((x) => x.name === c.name);
    if (idx >= 0) session.allCookies[idx] = c;
    else session.allCookies.push(c);
  }

  log("INFO", `${tag} ✅ Rotation CF réussie (${solveResult.durationMs}ms) — ré-init PHPSESSID …`);

  // 7. Ré-initialiser le PHPSESSID avec le nouvel impit (session PHP liée à l'IP)
  const phpOk = await initPortalSession(session, config.portalUrl, tag);
  if (!phpOk) {
    log("WARN", `${tag} ⚠️ PHPSESSID absent après rotation — scan peut échouer`);
  }

  return newProxy;
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
 * Effectue la séquence d'initialisation du portail Bookitit :
 *   GET portalUrl → extraire token + PHPSESSID depuis Set-Cookie
 *   POST token → confirmer PHPSESSID
 *
 * Met à jour `session.allCookies` en place.
 * Retourne true si PHPSESSID obtenu.
 */
async function initPortalSession(
  session: SpainCfSession,
  portalUrl: string,
  tag: string,
): Promise<boolean> {
  const referer = ensureTrailingSlash(portalUrl);

  // ── GET portail ─────────────────────────────────────────────────────────────
  let getRes: Response | null = null;
  try {
    getRes = await spainCfFetch(portalUrl, session, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
      },
    });
  } catch (e) {
    log("WARN", `${tag} initPortalSession GET error: ${e}`);
    return false;
  }

  if (!getRes?.ok) {
    log("WARN", `${tag} initPortalSession GET → ${getRes?.status ?? "null"}`);
    return false;
  }

  const html = await getRes.text();
  mergeCookiesFromResponse(getRes, session);

  // Extraire le token caché dans le formulaire HTML
  const token =
    html.match(/name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1] ??
    html.match(/value=["']([^"']{20,})["'][^>]+name=["']token["']/i)?.[1];

  if (!token) {
    const php = session.allCookies.find((c) => c.name === "PHPSESSID");
    log(
      "INFO",
      `${tag} initPortalSession: pas de token (${html.length}B) — PHPSESSID=${php ? "✅" : "⚠️ absent"}`,
    );
    return !!php;
  }

  // ── POST token ───────────────────────────────────────────────────────────────
  let postRes: Response | null = null;
  try {
    postRes = await spainCfFetch(referer, session, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Origin: "https://www.citaconsular.es",
        Referer: portalUrl,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
      },
      body: `token=${encodeURIComponent(token)}`,
    });
  } catch (e) {
    log("WARN", `${tag} initPortalSession POST error: ${e}`);
  }

  if (postRes) {
    mergeCookiesFromResponse(postRes, session);
  }

  const php = session.allCookies.find((c) => c.name === "PHPSESSID");
  log(
    "INFO",
    `${tag} initPortalSession: PHPSESSID=${php ? `✅ ${php.value.slice(0, 14)}…` : "⚠️ absent"}`,
  );
  return !!php;
}

// ─── Cycle de scan ────────────────────────────────────────────────────────────

/**
 * Un cycle de scan complet :
 *   /main/ → getservices/ → getagendas/ → datetime/ (DATETIME_MONTHS_AHEAD mois)
 *
 * Utilise la session dédiée du worker (session._ownImpit) pour toutes les requêtes.
 * Ne touche pas à la session globale.
 */
async function workerScanCycle(
  session: SpainCfSession,
  config: SpainDossierConfig,
  tag: string,
): Promise<WorkerScanResult> {
  const publickey = extractPublickey(config.portalUrl);
  const portalRef = ensureTrailingSlash(config.portalUrl);

  // ── /main/ ──────────────────────────────────────────────────────────────────
  const mainResult = await callMain(session, publickey, portalRef, config.portalUrl, tag);
  if (!mainResult.ok) {
    return { status: "error", errorMessage: mainResult.error };
  }
  const { mainHtml } = mainResult;

  const baseParams: Record<string, string> = {
    type: "default",
    publickey,
    lang: "es",
    version: "4",
    src: portalRef,
    srvsrc: "https://www.citaconsular.es",
  };

  // ── getservices/ ─────────────────────────────────────────────────────────────
  let serviceId = "";
  let serviceName = "";
  try {
    const svcPayload = await callBookititEndpoint(
      session,
      "getservices/",
      baseParams,
      config.portalUrl,
    );
    const rawServices = svcPayload ? extractServiceDetails(svcPayload) : [];
    // Tous les portails citaconsular.es sont mono-service — on prend toujours services[0].
    // matchServiceForVisa n'est pas nécessaire ici (aucun portail multi-service en prod).
    if (rawServices.length > 0) {
      serviceId   = rawServices[0].id;
      serviceName = rawServices[0].name;
    }
  } catch (e) {
    log("WARN", `${tag} getservices/ error: ${e}`);
  }

  if (!serviceId) {
    // Parfois /main/ renvoie des données embed — tenter sans service fixe
    return { status: "not_found", mainHtml };
  }

  // ── getagendas/ ──────────────────────────────────────────────────────────────
  let agendaId = "";
  try {
    const agPayload = await callBookititEndpoint(
      session,
      "getagendas/",
      { ...baseParams, "services[]": serviceId },
      config.portalUrl,
    );
    agendaId = agPayload ? extractFirstAgendaId(agPayload) : "";
  } catch (e) {
    log("WARN", `${tag} getagendas/ error: ${e}`);
  }

  // ── datetime/ — N mois ────────────────────────────────────────────────────────
  const groupSize = config.groupSize && config.groupSize > 1 ? config.groupSize : 1;
  const now = new Date();

  for (let offset = 0; offset < DATETIME_MONTHS_AHEAD; offset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const start = formatDate(d);
    const end = formatDate(new Date(d.getFullYear(), d.getMonth() + 1, 0));

    const dtParams: Record<string, string | string[]> = {
      ...baseParams,
      "services[]": serviceId,
      ...(agendaId ? { "agendas[]": agendaId } : {}),
      start,
      end,
      // Toujours "1" : les captures Burp montrent que le portail envoie toujours selectedPeople=1
      // quel que soit le nombre de personnes. La disponibilité par groupe est lue dans freeslots,
      // pas filtrée côté serveur via selectedPeople. groupSize est une abstraction interne.
      selectedPeople: "1",
    };

    let dtPayload: unknown = null;
    try {
      dtPayload = await callBookititEndpoint(
        session,
        "datetime/",
        dtParams,
        config.portalUrl,
      );
    } catch (e) {
      log("WARN", `${tag} datetime/ month+${offset} error: ${e}`);
      continue;
    }

    if (!dtPayload) continue;

    const slots = extractAllSlotsFromPayload(dtPayload, agendaId, groupSize);
    if (slots.length > 0) {
      // Trier par date ASC puis heure ASC
      slots.sort(
        (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
      );
      return { status: "found", slots, mainHtml, serviceId, serviceName, agendaId };
    }
  }

  return { status: "not_found", mainHtml, serviceId, serviceName, agendaId };
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

function buildBookingConfig(
  config: SpainDossierConfig,
  scan: WorkerScanResult,
  slot: WorkerSlot,
): SpainBookingConfig {
  return {
    login: config.login,
    password: config.password,
    applicationId: config.applicationId,
    otpChannel: config.otpChannel,
    applicantName: config.applicantName,
    visaType: config.visaType,
    targetServiceId: scan.serviceId,
    targetDate: slot.date,
    targetTime: slot.time,
    agendaId: slot.agendaId,
    groupSize: config.groupSize,
  };
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
