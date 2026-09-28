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
 *   - tournent sur des proxies Decodo INDÉPENDANTS (redondance : si un proxy meurt, les
 *     autres maintiennent la fraîcheur → pas de trou pendant un re-solve CF de ~30 s).
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
  scanViaWidgetDatetime,
  publishSlotSnapshotWithRetry,
  type SpainDossierConfig,
} from "./spain-dossier-worker.js";
import {
  publishBurstSignal,
  deleteWorkerCfClearance,
} from "./spain-redis-persistence.js";
import {
  getDecodoProxyForIndex,
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

/** Tick de scan LENT hors fenêtre (ms) — garde le cf_clearance chaud sans marteler. Défaut 45000. */
const SCOUT_IDLE_TICK_MS = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_IDLE_TICK_MS ?? "45000");
  return Math.max(5000, Number.isFinite(v) ? Math.round(v) : 45000);
})();

/** Minute-dans-l'heure de début de la fenêtre rapide (Europe/Madrid). Défaut 3. */
const SCOUT_FAST_START_MIN = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_FAST_START_MIN ?? "3");
  return Math.max(0, Math.min(59, Number.isFinite(v) ? Math.round(v) : 3));
})();

/** Minute-dans-l'heure de fin de la fenêtre rapide (Europe/Madrid). Défaut 26 (pic HH:13-14). */
const SCOUT_FAST_END_MIN = ((): number => {
  const v = Number(process.env.SPAIN_SCOUT_FAST_END_MIN ?? "26");
  return Math.max(1, Math.min(60, Number.isFinite(v) ? Math.round(v) : 26));
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

/** Résout la clé CapSolver depuis l'environnement (jamais journalisée). */
function resolveCapsolverKey(): string {
  return process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
}

// ─── Un éclaireur ──────────────────────────────────────────────────────────────

/**
 * Boucle d'un éclaireur dédié. Ne booke jamais : scanne datetime/ et publie le snapshot.
 * Chaque scout possède un proxy Decodo distinct (index staggeré) + son propre cf_clearance.
 */
async function runScout(
  scoutIndex: number,
  capsolverKey: string,
  isStopped: () => boolean,
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

  // Proxy dédié : index de départ distinct par scout ; saute de SCOUT_COUNT en cas de mort
  // pour ne jamais retomber sur l'IP d'un autre scout.
  let proxyIndex = scoutIndex;
  let stickyId = `sc${scoutIndex}-${Math.random().toString(36).slice(2, 8)}`;
  let session: SpainCfSession | null = null;

  const poolSize = getDecodoPoolSize();
  if (poolSize === 0) {
    console.warn(`${tag} ⚠️ pool Decodo vide — scout désactivé`);
    return;
  }

  /** (Re)crée la session CF si absente ou proche de l'expiration. */
  const ensureSession = async (): Promise<boolean> => {
    if (session && session.expiresAt - Date.now() > SESSION_MIN_FRESH_MS) return true;
    const base = getDecodoProxyForIndex(proxyIndex);
    if (!base) {
      console.warn(`${tag} ⚠️ aucun proxy à l'index ${proxyIndex}`);
      return false;
    }
    const stickyProxy = addStickySession(base, stickyId);
    console.log(`${tag} 🔐 init session — ${maskProxy(stickyProxy)} (UA=${WORKER_UA.slice(0, 20)}…)`);
    // Init RÉDUIT (skipTokenAndMain=true) : solve CF + GET widget seul suffit pour datetime/.
    // initWorkerSession gère le cache cf_clearance Redis (par host:port) en interne.
    const res = await initWorkerSession(
      stickyProxy,
      SCOUT_PORTAL_URL,
      capsolverKey,
      undefined,
      undefined,
      true,
    );
    if (!res) {
      console.warn(`${tag} ❌ init session échouée — blacklist + rotation proxy`);
      flagDecodoIp(base, "scout-init-failed");
      deleteWorkerCfClearance(stickyProxy);
      proxyIndex += SCOUT_COUNT;
      stickyId = `sc${scoutIndex}-${Math.random().toString(36).slice(2, 8)}`;
      session = null;
      return false;
    }
    session = res.session;
    console.log(`${tag} ✅ session prête (cfFromCache=${res.cfFromCache})`);
    return true;
  };

  /** Bascule sur un autre proxy après une mort CF. */
  const rotateProxy = (reason: string): void => {
    const base = getDecodoProxyForIndex(proxyIndex);
    if (base) {
      flagDecodoIp(base, reason);
      deleteWorkerCfClearance(addStickySession(base, stickyId));
    }
    proxyIndex += SCOUT_COUNT;
    stickyId = `sc${scoutIndex}-${Math.random().toString(36).slice(2, 8)}`;
    session = null;
  };

  // Décalage initial : les scouts s'entrelacent (refresh global ~SCOUT_FAST_TICK_MS/COUNT).
  await sleep((scoutIndex * SCOUT_FAST_TICK_MS) / SCOUT_COUNT);
  console.log(`${tag} 🚀 démarré — portail ${SCOUT_PORTAL_URL} (agenda=${known.agendaId}, service=${known.serviceId})`);

  while (!isStopped()) {
    let tickMs = isFastWindow(Date.now()) ? SCOUT_FAST_TICK_MS : SCOUT_IDLE_TICK_MS;
    try {
      const ok = await ensureSession();
      if (!ok || !session) {
        await sleep(SESSION_RETRY_BACKOFF_MS);
        continue;
      }

      const scan = await scanViaWidgetDatetime(session, scoutConfig, tag);

      if (scan === null) {
        // Chemin court non applicable (ne devrait pas arriver pour Kinshasa) → réinit.
        session = null;
      } else if (scan.status === "cf_expired") {
        console.warn(`${tag} 🔄 cf_expired — rotation proxy + re-solve`);
        rotateProxy("scout-cf-expired");
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
        // Proxy mort au scan → rotation (comme cf_expired mais sans re-solve immédiat).
        console.warn(`${tag} 🔄 proxy_error au scan — rotation proxy`);
        rotateProxy("scout-proxy-error");
        tickMs = SESSION_RETRY_BACKOFF_MS;
      }
      // not_found / error / server_overload → ne PAS publier (laisse l'âge grimper côté meute).
    } catch (error) {
      console.warn(
        `${tag} ⚠️ cycle en erreur : ${error instanceof Error ? error.message : String(error)}`,
      );
      tickMs = SESSION_RETRY_BACKOFF_MS;
    }

    // Jitter ±15 % pour désynchroniser (indétectabilité + éviter les fronts identiques).
    const jitter = tickMs * (Math.random() * 0.3 - 0.15);
    await sleep(tickMs + jitter);
  }

  console.log(`${tag} 🛑 arrêté`);
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
      `portail ${SCOUT_PORTAL_URL} (fast ${SCOUT_FAST_TICK_MS}ms / idle ${SCOUT_IDLE_TICK_MS}ms)`,
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
