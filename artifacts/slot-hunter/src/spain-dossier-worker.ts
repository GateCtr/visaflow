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
  callBookititEndpoint,
  executeHttpBooking,
  type SpainBookingConfig,
  type SpainBookingResult,
} from "./spain-http-booking.js";
import { extractServiceDetails, extractAllSlotsFromDatetime } from "./spain-http-scanner.js";
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
  status: "found" | "not_found" | "error";
  slots?: WorkerSlot[];
  mainHtml?: string;
  serviceId?: string;
  serviceName?: string;
  agendaId?: string;
  errorMessage?: string;
}

/** Cache service+agenda entre les cycles (règle §9 : 1 seul getagendas/ par PHPSESSID). */
interface ServiceCache {
  initialized: boolean;
  serviceId: string;
  serviceName: string;
  agendaId: string;
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

  // ── 5.5. getwidgetconfigurations/ — UNE SEULE FOIS après session établie ─────
  // CRITIQUE : doit précéder getservices/ pour initialiser la session côté serveur Bookitit.
  // Source de vérité : test-bookitit-dynamic.ts section 3.
  {
    const portalRef = ensureTrailingSlash(config.portalUrl);
    const srvsrc    = session.bookititState?.srvsrc  ?? "https://www.citaconsular.es";
    const version   = session.bookititState?.version ?? "4";
    const pubkey    = extractPublickey(config.portalUrl);
    try {
      await callBookititEndpoint(session, "getwidgetconfigurations/", {
        type: "default", publickey: pubkey, lang: "es", version, src: portalRef, srvsrc,
      }, config.portalUrl);
      await new Promise<void>((r) => setTimeout(r, 220));
      log("INFO", `${tag} ✅ getwidgetconfigurations/ OK`);
    } catch (e) {
      log("WARN", `${tag} getwidgetconfigurations/ erreur (non-fatal): ${e}`);
    }
  }

  // ── 6. Boucle de scan ────────────────────────────────────────────────────────
  const windowEnd = Date.now() + WORKER_WINDOW_MS;
  let cycleCount = 0;
  // Cache service+agenda : getservices/ et getagendas/ appelés UNE SEULE FOIS
  // par PHPSESSID (règle §9 Bookitit : getagendas/ suivants retournent 0B).
  const serviceCache: ServiceCache = { serviceId: "", serviceName: "", agendaId: "", initialized: false };

  while (Date.now() < windowEnd) {
    cycleCount++;
    const cycleStart = Date.now();

    try {
      const scan = await workerScanCycle(session, config, tag, serviceCache);

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
 * Un cycle de scan complet — reproduit fidèlement l'ancien watcher (spain-http-scanner.ts
 * confirmSlotsViaDatetimeOnce) et test-bookitit-dynamic.ts (source de vérité) :
 *
 *   /main/
 *   → [getservices/ + getagendas/]  ← UNE SEULE FOIS par PHPSESSID (cache ServiceCache)
 *   → datetime/ mois par mois       ← start=aujourd'hui pour mo=0, 1er du mois sinon
 *                                      arrêt sur 3 mois vides consécutifs (PAS maxDays)
 *
 * Règle §9 Bookitit : getagendas/ appelé 2× sur le même PHPSESSID → 0B.
 * → serviceCache.initialized = true après le 1er appel ; cycles suivants sautent.
 */
async function workerScanCycle(
  session: SpainCfSession,
  config: SpainDossierConfig,
  tag: string,
  cache: ServiceCache,
): Promise<WorkerScanResult> {
  const publickey = extractPublickey(config.portalUrl);
  const portalRef = ensureTrailingSlash(config.portalUrl);

  // ── /main/ ──────────────────────────────────────────────────────────────────
  const mainResult = await callMain(session, publickey, portalRef, config.portalUrl, tag);
  if (!mainResult.ok) {
    return { status: "error", errorMessage: mainResult.error };
  }
  const { mainHtml } = mainResult;

  // srvsrc et version extraits dynamiquement depuis le POST token (initPortalSession).
  // Fallback sur les valeurs Saopolo si bookititState absent.
  const srvsrc  = session.bookititState?.srvsrc  ?? "https://www.citaconsular.es";
  const version = session.bookititState?.version  ?? "4";

  const baseParams: Record<string, string> = {
    type: "default",
    publickey,
    lang: "es",
    version,
    src: portalRef,
    srvsrc,
  };

  // ── getservices/ + getagendas/ — une seule fois par PHPSESSID ─────────────
  // Règle §9 (confirmée par l'ancien scanner) : getagendas/ appelé 2× sur le
  // même PHPSESSID retourne 0B → on perd l'agendaId pour tous les cycles suivants.
  // Solution : cache ServiceCache initialisé au 1er cycle, réutilisé ensuite.
  if (!cache.initialized) {
    // getservices/
    try {
      const svcPayload = await callBookititEndpoint(
        session,
        "getservices/",
        baseParams,
        config.portalUrl,
      );
      // Filtre identique à l'ancien scanner (spain-http-scanner.ts l.1324-1334) :
      //   - Écarter les services dont le nom est purement HTML invisible (placeholder Bookitit)
      //     ex : bkt853105 dont name = "<span style='display:none;'></span>"
      //   - Prendre le premier service visible ; fallback Services[0]
      const allSvcs: Array<{ id: string; name: string }> =
        (svcPayload as any)?.Services ?? [];
      const visibleSvcs = allSvcs.filter(
        (s) => (s.name ?? "").replace(/<[^>]+>/g, "").trim().length > 0,
      );
      const target = (visibleSvcs.length > 0 ? visibleSvcs : allSvcs)[0];
      if (target) {
        cache.serviceId   = target.id;
        cache.serviceName = (target.name ?? "").replace(/<[^>]+>/g, "").trim() || target.id;
        log("INFO", `${tag} service: "${cache.serviceName}" (${cache.serviceId})`);
      }
    } catch (e) {
      log("WARN", `${tag} getservices/ error: ${e}`);
    }

    if (!cache.serviceId) {
      // Pas de service trouvé — ne pas marquer initialized pour retenter au prochain cycle
      return { status: "not_found", mainHtml };
    }

    // getagendas/ — avec selectedPeople="1" (obligatoire — cf. test-bookitit-dynamic.ts l.198)
    try {
      const agPayload = await callBookititEndpoint(
        session,
        "getagendas/",
        { ...baseParams, "services[]": cache.serviceId, selectedPeople: "1" },
        config.portalUrl,
      );
      cache.agendaId = agPayload ? extractFirstAgendaId(agPayload) : "";
      if (cache.agendaId) log("INFO", `${tag} agenda: ${cache.agendaId}`);
      else log("INFO", `${tag} getagendas/ 0B — datetime/ appelé sans agendas[]`);
    } catch (e) {
      log("WARN", `${tag} getagendas/ error: ${e}`);
    }

    cache.initialized = true;
  }

  const { serviceId, serviceName, agendaId } = cache;

  // ── datetime/ — boucle multi-mois, logique identique à l'ancien scanner ────
  //
  // RÈGLES (copiées de spain-http-scanner.ts confirmSlotsViaDatetimeOnce l.1466-1681) :
  //   1. start mois 0 = aujourd'hui (pas le 1er du mois) — le serveur retourne
  //      maxDays relatif à aujourd'hui, pas au 1er du mois.
  //   2. Arrêt = 3 mois vides CONSÉCUTIFS (slotsThisMonth === 0), PAS maxDays.
  //      → maxDays est la limite de visibilité de l'agenda, pas le stop condition.
  //      → Utiliser maxDays comme stop condition faisait rater des mois entiers
  //        (confirmé : septembre retourne maxDays=2026-09-18 mais les slots vont
  //        jusqu'au 30 septembre).
  //   3. Plafond absolu : 12 mois.
  //   4. extractAllSlotsFromDatetime (pas extractAllSlotsFromPayload) — gère
  //      freeslots=-1 (times=[], state=1) et la résolution jour-détail.
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const MAX_MONTHS = 12;
  let consecutiveEmpty = 0;
  const allSlots: WorkerSlot[] = [];

  for (let mo = 0; mo < MAX_MONTHS; mo++) {
    const tgt   = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    // Mois courant : start=aujourd'hui (aligne sur le vrai navigateur)
    // Mois suivants : start=1er du mois (navigation mensuelle standard)
    const start = mo === 0 ? todayStr : tgt.toISOString().slice(0, 10);
    const end   = new Date(tgt.getFullYear(), tgt.getMonth() + 1, 0).toISOString().slice(0, 10);

    const dtParams: Record<string, string> = {
      ...baseParams,
      "services[]": serviceId,
      ...(agendaId ? { "agendas[]": agendaId } : {}),
      start,
      end,
      selectedPeople: "1",
    };

    let dtPayload: unknown = null;
    try {
      dtPayload = await callBookititEndpoint(session, "datetime/", dtParams, config.portalUrl);
      log("INFO", `${tag} datetime/ ${start}→${end} — payload: ${dtPayload ? "reçu" : "0B/null"}`);
    } catch (e) {
      log("WARN", `${tag} datetime/ mo+${mo} error: ${e}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      continue;
    }

    if (!dtPayload) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
      continue;
    }

    // extractAllSlotsFromDatetime = fonction de l'ancien scanner (spain-http-scanner.ts l.1847)
    // Gère : times={} (heures explicites), times=[] + state=1 (jour ouvert sans heures → 09:00 freeslots=-1)
    const monthSlots = extractAllSlotsFromDatetime(dtPayload);
    const slotsThisMonth = monthSlots.length;

    if (slotsThisMonth > 0) {
      const preview = monthSlots.slice(0, 3).map((s) => `${s.date} ${s.time}`).join(", ");
      log("INFO", `${tag} datetime/ ${start}→${end} — ${slotsThisMonth} créneau(x) : ${preview}${slotsThisMonth > 3 ? ` … +${slotsThisMonth - 3}` : ""}`);
      for (const s of monthSlots) {
        allSlots.push({
          date:      s.date,
          time:      s.time,
          agendaId:  s.agendaId ?? agendaId,
          freeslots: s.freeslots,
        });
      }
      consecutiveEmpty = 0;
    } else {
      log("INFO", `${tag} datetime/ ${start}→${end} — aucun créneau`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) {
        log("INFO", `${tag} datetime/ 3 mois vides consécutifs — arrêt`);
        break;
      }
    }
  }

  if (allSlots.length > 0) {
    allSlots.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
    return { status: "found", slots: allSlots, mainHtml, serviceId, serviceName, agendaId };
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
