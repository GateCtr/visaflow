/**
 * spain-scout.ts — Pool d'éclaireurs DÉDIÉS pour le mode meute Espagne (Bookitit).
 *
 * PROBLÈME RÉSOLU (bug prod 2026-09-28) : en mode meute, le snapshot Redis des créneaux
 * restait figé. L'éclaireur historique était un DOSSIER CLIENT qui, une fois son créneau
 * booké, quittait la fenêtre — plus personne ne rafraîchissait le snapshot avec des données
 * réelles, et la meute (qui republiait à l'identique ce qu'elle lisait) le maintenait
 * artificiellement « frais » avec des créneaux déjà pris → boucle infinie sur un créneau mort.
 *
 * SOLUTION : un petit POOL d'éclaireurs dédiés, indépendants des dossiers Convex, qui :
 *   - ne bookent JAMAIS (aucun signin/, aucun hCaptcha de booking, aucun coût) ;
 *   - scannent datetime/ en continu (chemin court GET widget → datetime/, IDs connus) ;
 *   - publient les créneaux RÉELS dans le snapshot Redis + un signal burst ;
 *   - réservent leurs proxies Decodo avec le même allocateur Redis que les workers, pour
 *     éviter les collisions d'IP tout en gardant plusieurs scouts redondants.
 *
 * Le snapshot reflète alors la réalité : à mesure que des créneaux sont bookés, le prochain
 * datetime/ d'un scout renvoie la liste réduite → le snapshot converge. Combiné à la garde
 * de fraîcheur côté meute (SPAIN_SNAPSHOT_FRESH_MAX_SEC) et au décrément post-booking
 * (decrementSlotSnapshot), la meute ne boucle plus sur des créneaux morts.
 *
 * Feature-flaggé : SPAIN_SCOUT_POOL=1 (OFF par défaut → aucun impact prod).
 *
 * Règles projet : TypeScript strict, aucun `any` non nécessaire, type de retour explicite,
 * secrets jamais journalisés, logs préfixés `[spain-scout]`.
 */

import type { SpainCfSession } from "./spain-soax-solver.js";
import { initWorkerSession, WORKER_UA } from "./spain-soax-solver.js";
import {
  pickDedicatedProxy,
  scanViaWidgetDatetime,
  publishSlotSnapshotWithRetry,
  type SpainDossierConfig,
} from "./spain-dossier-worker.js";
import {
  publishBurstSignal,
  deleteWorkerCfClearance,
  deleteLastStickyForDossier,
  deleteWorkerProxyIdentity,
  getLastStickyForDossier,
  getWorkerProxyIdentity,
  saveLastProxyForDossier,
  saveLastStickyForDossier,
  saveWorkerProxyIdentity,
} from "./spain-redis-persistence.js";
import { releaseWorkerIp, reserveWorkerIp } from "./spain-slot-coordinator.js";
import {
  getDecodoPoolSize,
  flagDecodoIp,
} from "./spain-decodo-pool.js";
import {
  KINSHASA_PORTAL_URL,
  getKnownIdsForPortal,
} from "./spain-portals.js";

// ─── Configuration (env) ───────────────────────────────────────────────────────

/** Active le pool d'éclaireurs dédiés. OFF par défaut → comportement historique intact. */
export const SCOUT_POOL_ENABLED = process.env.SPAIN_SCOUT_POOL === "1";

/** Nombre d'éclaireurs dédiés (redondance anti-SPOF proxy). Défaut 3, borné [1, 10]. */
const SCOUT_COUNT = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_COUNT ?? "3");
  return Math.max(1, Math.min(10, Number.isFinite(v) ? Math.round(v) : 3));
})();

/** Portail cible du pool (Kinshasa uniquement pour l'instant ; structure extensible). */
const SCOUT_PORTAL_URL = (process.env.SPAIN_SCOUT_PORTAL_URL ?? KINSHASA_PORTAL_URL).split("#")[0];

/** Tick de scan RAPIDE en fenêtre de publication (ms). Défaut 2500. Décalé par scout. */
const SCOUT_FAST_TICK_MS = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_FAST_TICK_MS ?? "2500");
  return Math.max(500, Number.isFinite(v) ? Math.round(v) : 2500);
})();

/** Borne max du sommeil hors fenêtre (ms). Le scout n'effectue AUCUN scan hors fenêtre ; cette
 *  valeur ne sert plus qu'à re-vérifier périodiquement l'arrêt du pool pendant l'attente. Défaut 45000. */
const SCOUT_IDLE_TICK_MS = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_IDLE_TICK_MS ?? "45000");
  return Math.max(5000, Number.isFinite(v) ? Math.round(v) : 45000);
})();

/** Minute-dans-l'heure de début de la fenêtre rapide (Europe/Madrid). Aligné sur le démarrage
 *  du worker : lit SPAIN_WINDOW_START_MIN (défaut 3, comme WINDOW_START_MIN de l'orchestrateur)
 *  et n'accepte un override propre au scout (SPAIN_SCOUT_FAST_START_MIN) que s'il est fourni. */
const SCOUT_FAST_START_MIN = ((): number => {
  const raw = process.env.SPAIN_SCOUT_FAST_START_MIN ?? process.env.SPAIN_WINDOW_START_MIN ?? "3";
  const v = Number(raw);
  return Math.max(0, Math.min(59, Number.isFinite(v) ? Math.round(v) : 3));
})();

/** Minute-dans-l'heure de fin (exclue) de la fenêtre rapide (Europe/Madrid). Défaut 15 :
 *  les scouts s'arrêtent TOTALEMENT à HH:15 (le pic de publication HH:13 est passé). Ils ne
 *  scannent donc jamais jusqu'à la fin de fenêtre du worker (HH:18). */
const SCOUT_FAST_END_MIN = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_FAST_END_MIN ?? "15");
  return Math.max(1, Math.min(60, Number.isFinite(v) ? Math.round(v) : 15));
})();

/** Marge de fraîcheur du cf_clearance (ms) sous laquelle on re-initialise la session (5 min). */
const SESSION_MIN_FRESH_MS = 5 * 60_000;

/** TTL de secours si aucune session (ms) avant nouvelle tentative d'init. */
const SESSION_RETRY_BACKOFF_MS = 3_000;

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Injecte un sticky session ID dans l'URL proxy Decodo (même logique que le worker :
 * on ajoute `-session-{sid}` au username pour fixer l'exit IP → cf_clearance stable).
 */
function addStickySession(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    if (user.includes("-session-")) return url; // déjà sticky
    u.username = encodeURIComponent(`${user}-session-${sid}`);
    return u.toString();
  } catch {
    return url;
  }
}

/** Masque les identifiants d'une URL proxy pour les logs. */
function maskProxy(url: string): string {
  return url.replace(/:([^:@/]+)@/, ":***@").slice(0, 60);
}

/** Minute-dans-l'heure (0–59) en fuseau Europe/Madrid (DST géré). Repli UTC sans lancer. */
function minuteOfHourMadrid(nowMs: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Madrid",
      hour12: false,
      minute: "2-digit",
    }).formatToParts(new Date(nowMs));
    const minutePart = parts.find((p) => p.type === "minute");
    if (minutePart !== undefined) {
      const minute = Number(minutePart.value);
      if (Number.isFinite(minute)) return minute;
    }
  } catch {
    /* repli ci-dessous */
  }
  return Math.floor(nowMs / 60_000) % 60;
}

/** true si on est dans la fenêtre de publication (cadence rapide). */
function isFastWindow(nowMs: number): boolean {
  const m = minuteOfHourMadrid(nowMs);
  return m >= SCOUT_FAST_START_MIN && m < SCOUT_FAST_END_MIN;
}

/**
 * Ms jusqu'au prochain début de fenêtre HH:SCOUT_FAST_START_MIN (Europe/Madrid).
 * Utilisé hors fenêtre pour que le scout DORME (arrêt total du scan) au lieu de scanner
 * en cadence lente : une fois HH:15 atteint, plus aucune requête jusqu'au prochain HH:03.
 */
function msUntilNextFastWindow(nowMs: number): number {
  const secondInHour = ((): number => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Madrid",
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
      }).formatToParts(new Date(nowMs));
      const min = Number(parts.find((p) => p.type === "minute")?.value);
      const sec = Number(parts.find((p) => p.type === "second")?.value);
      if (Number.isFinite(min) && Number.isFinite(sec)) return min * 60 + sec;
    } catch {
      /* repli ci-dessous */
    }
    return (Math.floor(nowMs / 1000) % 3600);
  })();
  const startSec = SCOUT_FAST_START_MIN * 60;
  const deltaSec = secondInHour < startSec ? startSec - secondInHour : 3600 - secondInHour + startSec;
  return deltaSec * 1000;
}

/** Résout la clé CapSolver depuis l'environnement (jamais journalisée). */
function resolveCapsolverKey(): string {
  return process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
}

// ─── Un éclaireur ──────────────────────────────────────────────────────────────

/**
 * Boucle d'un éclaireur dédié. Ne booke jamais : scanne datetime/ et publie le snapshot.
 * Chaque scout détient un bail proxy worker-compatible + son propre cf_clearance.
 */
async function runScout(
  scoutIndex: number,
  capsolverKey: string,
  isStopped: () => boolean,
  options: { maxCycles?: number; ignoreFastWindow?: boolean } = {},
): Promise<void> {
  const tag = `[spain-scout#${scoutIndex}]`;
  const known = getKnownIdsForPortal(SCOUT_PORTAL_URL);
  if (!known) {
    console.warn(`${tag} ⚠️ portail sans IDs connus (${SCOUT_PORTAL_URL}) — scout désactivé`);
    return;
  }

  // Config synthétique : le scout n'est PAS un dossier Convex. Les champs de booking
  // (login/password/applicationId) restent vides — le scout ne booke jamais.
  const scoutConfig: SpainDossierConfig = {
    id: `scout-${scoutIndex}`,
    applicantName: `SCOUT#${scoutIndex}`,
    visaType: "",
    login: "",
    password: "",
    applicationId: "",
    otpChannel: "manual",
    portalUrl: SCOUT_PORTAL_URL,
    // Pas de role meute/eclaireur : le scout n'entre pas dans la logique d'orchestration.
  };

  // Le scout utilise le même allocateur et les mêmes réservations Redis que les workers.
  // Son ID synthétique le distingue des dossiers Convex tout en partageant l'exclusion IP.
  const ownerId = scoutConfig.id;
  const MAX_INIT_ATTEMPTS = Math.max(
    1,
    Math.min(10, Number(process.env.SPAIN_ROTATE_MAX_ATTEMPTS ?? "3") || 3),
  );
  let proxyUrl = "";
  let excludedBaseProxy: string | undefined;
  let stickyId = "";
  let session: SpainCfSession | null = null;

  const poolSize = getDecodoPoolSize();
  if (poolSize === 0) {
    console.warn(`${tag} ⚠️ pool Decodo vide — scout désactivé`);
    return;
  }

  const newStickyId = (): string => Math.random().toString(36).slice(2, 10);

  const releaseProxy = async (saveForReuse = true): Promise<void> => {
    if (!proxyUrl) return;
    const current = proxyUrl;
    if (saveForReuse) {
      await saveLastProxyForDossier(ownerId, current).catch(() => {});
    }
    await releaseWorkerIp(current, ownerId).catch(() => {});
    proxyUrl = "";
  };

  const acquireProxy = async (): Promise<boolean> => {
    const picked = await pickDedicatedProxy(ownerId, tag, excludedBaseProxy);
    if (!picked) {
      console.warn(`${tag} ⚠️ aucune IP Decodo non réservée disponible`);
      return false;
    }
    proxyUrl = picked;

    // Même règle que les workers : ne réutiliser le sticky que pour sa base proxy connue.
    const identity = await getWorkerProxyIdentity(ownerId).catch(() => null);
    const legacyStickyId = await getLastStickyForDossier(ownerId).catch(() => null);
    stickyId =
      identity?.baseProxy === proxyUrl
        ? identity.stickyId
        : identity
          ? newStickyId()
          : legacyStickyId ?? newStickyId();
    return true;
  };

  /** (Re)crée la session CF si absente ou proche de l'expiration. */
  const ensureSession = async (): Promise<boolean> => {
    if (proxyUrl && !(await reserveWorkerIp(proxyUrl, ownerId))) {
      console.warn(`${tag} ⚠️ réservation IP perdue — abandon de la session et nouvelle allocation`);
      session = null;
      proxyUrl = "";
      stickyId = "";
    }
    if (session && session.expiresAt - Date.now() > SESSION_MIN_FRESH_MS) return true;

    for (let attempt = 1; attempt <= MAX_INIT_ATTEMPTS; attempt++) {
      if (!proxyUrl && !(await acquireProxy())) return false;

      const base = proxyUrl;
      const stickyProxy = addStickySession(base, stickyId);
      console.log(`${tag} 🔐 init session — ${maskProxy(stickyProxy)} (UA=${WORKER_UA.slice(0, 20)}…)`);
      // Le scout conserve son init courte : pas de POST token, /main/ ni booking.
      const res = await initWorkerSession(
        stickyProxy,
        SCOUT_PORTAL_URL,
        capsolverKey,
        undefined,
        undefined,
        true,
      );
      if (res) {
        session = res.session;
        await saveLastStickyForDossier(ownerId, stickyId).catch(() => {});
        await saveWorkerProxyIdentity(ownerId, proxyUrl, stickyId).catch(() => {});
        console.log(`${tag} ✅ session prête (cfFromCache=${res.cfFromCache})`);
        return true;
      }

      console.warn(`${tag} ❌ init session échouée — blacklist + réservation libérée`);
      flagDecodoIp(base, "scout-init-failed");
      deleteWorkerCfClearance(stickyProxy);
      await deleteWorkerProxyIdentity(ownerId).catch(() => {});
      await deleteLastStickyForDossier(ownerId).catch(() => {});
      await releaseWorkerIp(base, ownerId).catch(() => {});
      excludedBaseProxy = base;
      proxyUrl = "";
      stickyId = "";
      session = null;
    }

    console.warn(`${tag} ❌ init impossible après ${MAX_INIT_ATTEMPTS} IP réservées`);
    return false;
  };

  /** Libère et blackliste comme un worker; le prochain cycle reprend via l'allocateur partagé. */
  const rotateProxy = async (reason: string): Promise<void> => {
    const failedBase = proxyUrl;
    if (failedBase) {
      flagDecodoIp(failedBase, reason);
      deleteWorkerCfClearance(addStickySession(failedBase, stickyId));
      await deleteWorkerProxyIdentity(ownerId).catch(() => {});
      await deleteLastStickyForDossier(ownerId).catch(() => {});
      await releaseWorkerIp(failedBase, ownerId).catch(() => {});
      excludedBaseProxy = failedBase;
    }
    proxyUrl = "";
    stickyId = "";
    session = null;
  };

  // Décalage initial : les scouts s'entrelacent (refresh global ~SCOUT_FAST_TICK_MS/COUNT).
  await sleep((scoutIndex * SCOUT_FAST_TICK_MS) / SCOUT_COUNT);
  console.log(`${tag} 🚀 démarré — portail ${SCOUT_PORTAL_URL} (agenda=${known.agendaId}, service=${known.serviceId})`);

  let cycles = 0;
  try {
    while (!isStopped()) {
      // Hors fenêtre : libérer le bail pour que les workers puissent utiliser l'IP.
      if (!options.ignoreFastWindow && !isFastWindow(Date.now())) {
        session = null;
        await releaseProxy(true);
        const untilNext = msUntilNextFastWindow(Date.now());
        console.log(
          `${tag} 💤 hors fenêtre — réservation libérée, réveil dans ${Math.round(untilNext / 1000)}s ` +
            `(prochain HH:${String(SCOUT_FAST_START_MIN).padStart(2, "0")})`,
        );
        // Sommeil borné par SCOUT_IDLE_TICK_MS pour rester réactif à l'arrêt du pool (isStopped).
        await sleep(Math.min(untilNext, SCOUT_IDLE_TICK_MS));
        continue;
      }

      let tickMs = SCOUT_FAST_TICK_MS;
      try {
        const ok = await ensureSession();
        if (!ok || !session) {
          cycles++;
          if (options.maxCycles !== undefined && cycles >= options.maxCycles) break;
          await sleep(SESSION_RETRY_BACKOFF_MS);
          continue;
        }

        const scan = await scanViaWidgetDatetime(session, scoutConfig, tag);

        if (scan === null) {
          // Chemin court non applicable → refaire l'init sur l'IP réservée.
          session = null;
        } else if (scan.status === "cf_expired") {
          console.warn(`${tag} 🔄 cf_expired — blacklist, libération et allocation worker`);
          await rotateProxy("scout-cf-expired");
          tickMs = SESSION_RETRY_BACKOFF_MS;
        } else if (scan.status === "found" && scan.slots && scan.slots.length > 0) {
          // Publier les créneaux RÉELS + signal burst. Écrivain unique du snapshot.
          await publishSlotSnapshotWithRetry(
            known.agendaId,
            known.serviceId,
            scan.slots.map((s) => ({
              date: s.date,
              time: s.time,
              agendaId: s.agendaId ?? known.agendaId,
              freeslots: s.freeslots,
            })),
            tag,
          );
          void publishBurstSignal(SCOUT_PORTAL_URL, scan.slots.length);
          console.log(`${tag} 📢 snapshot publié : ${scan.slots.length} créneau(x) + burst`);
        } else if (scan.status === "proxy_error") {
          // Proxy mort au scan → utiliser la même blacklist, libération et allocation.
          console.warn(`${tag} 🔄 proxy_error au scan — rotation IP worker`);
          await rotateProxy("scout-proxy-error");
          tickMs = SESSION_RETRY_BACKOFF_MS;
        }
        // not_found / error / server_overload → garder l'IP réservée et la session.
      } catch (error) {
        console.warn(
          `${tag} ⚠️ cycle en erreur : ${error instanceof Error ? error.message : String(error)}`,
        );
        tickMs = SESSION_RETRY_BACKOFF_MS;
      }

      cycles++;
      if (options.maxCycles !== undefined && cycles >= options.maxCycles) break;

      // Jitter ±15 % pour désynchroniser (indétectabilité + éviter les fronts identiques).
      const jitter = tickMs * (Math.random() * 0.3 - 0.15);
      await sleep(tickMs + jitter);
    }
  } finally {
    session = null;
    await releaseProxy(true);
    console.log(`${tag} 🛑 arrêté`);
  }
}

/**
 * Harnais E2E borné : exécute une seule itération de la boucle réelle du scout.
 * Utilisé par test-spain-scout-saopolo.ts ; le scout ne possède aucun chemin de booking.
 */
export async function runScoutOnceForTest(scoutIndex = 0): Promise<void> {
  const key = resolveCapsolverKey();
  if (!key) throw new Error("CAPSOLVER_API_KEY/NONECAP_API_KEY manquante");
  await runScout(scoutIndex, key, () => false, {
    maxCycles: 1,
    ignoreFastWindow: true,
  });
}

// ─── Pool ────────────────────────────────────────────────────────────────────

/**
 * Démarre le pool d'éclaireurs dédiés (fire-and-forget). No-op si SPAIN_SCOUT_POOL != 1.
 *
 * Chaque scout tourne dans sa propre boucle asynchrone (proxy dédié, cf_clearance propre).
 * La redondance (SCOUT_COUNT) garantit qu'un proxy mort n'interrompt pas le rafraîchissement
 * du snapshot : les autres scouts continuent de publier.
 *
 * @param capsolverKey Clé CapSolver (résolue par l'orchestrateur ; jamais journalisée).
 * @returns fonction d'arrêt du pool (stoppe toutes les boucles au prochain cycle).
 */
export function startScoutPool(capsolverKey?: string): () => void {
  if (!SCOUT_POOL_ENABLED) {
    return () => {};
  }
  const key = capsolverKey ?? resolveCapsolverKey();
  if (!key) {
    console.warn("[spain-scout] ⚠️ CapSolver introuvable (CAPSOLVER_API_KEY/NONECAP_API_KEY) — pool non démarré");
    return () => {};
  }
  if (getDecodoPoolSize() === 0) {
    console.warn("[spain-scout] ⚠️ pool Decodo vide — pool d'éclaireurs non démarré");
    return () => {};
  }

  let stopped = false;
  const isStopped = (): boolean => stopped;

  console.log(
    `[spain-scout] 🐺 Démarrage du pool d'éclaireurs dédiés — ${SCOUT_COUNT} scout(s), ` +
      `portail ${SCOUT_PORTAL_URL} (fenêtre HH:${String(SCOUT_FAST_START_MIN).padStart(2, "0")}` +
      `→HH:${String(SCOUT_FAST_END_MIN).padStart(2, "0")}, fast ${SCOUT_FAST_TICK_MS}ms, ` +
      `arrêt total hors fenêtre)`,
  );

  for (let i = 0; i < SCOUT_COUNT; i++) {
    // Fire-and-forget : chaque scout est autonome et ne doit jamais faire échouer les autres.
    void runScout(i, key, isStopped).catch((error) => {
      console.warn(
        `[spain-scout#${i}] ⚠️ boucle terminée sur erreur : ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  return () => {
    stopped = true;
    console.log("[spain-scout] 🛑 Arrêt du pool d'éclaireurs demandé");
  };
}
