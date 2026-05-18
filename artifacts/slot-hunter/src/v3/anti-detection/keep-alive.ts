/**
 * Keep-Alive V3 — Ping périodique pour maintenir le token JWT actif.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Appeler un endpoint léger (getLandingPageDeatils) toutes les 8-12 min
 *   pour signaler au serveur que la session est active.
 *   Empêche le serveur de considérer la session comme abandonnée.
 *
 * RÈGLES (doc V3) :
 *   - JAMAIS de POST /refreshToken — tue la session
 *   - Le JWT a une durée de vie de 60 min (Cognito)
 *   - Le keep-alive ne PROLONGE PAS le token — juste montre de l'activité
 *   - Intervalle : 8-12 min (gaussien, pas fixe = anti-détection)
 *   - Si le ping échoue (401) → token expiré, arrêter le keep-alive
 *
 * INTÉGRATION :
 *   Démarré après chaque login réussi.
 *   Arrêté quand le token expire (fin de session naturelle à 60 min).
 *
 * USAGE :
 *   const ka = startKeepAlive(session, jobId);
 *   // ... scan en cours ...
 *   ka.stop(); // Quand la session termine
 */

import { USA_LANDING_PAGE_URL } from "../../usaPortal/config.js";
import { usaFetch, sessionHeaders } from "../../usaPortal/usa-http.js";
import type { UsaSession } from "../../usaPortal/types.js";
import { gaussianInterval } from "../anti-detection/human-timing.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Handle pour contrôler le keep-alive. */
export interface KeepAliveHandle {
  /** Arrête le keep-alive (à appeler en fin de session). */
  stop(): void;
  /** Le keep-alive est-il actif ? */
  readonly isRunning: boolean;
  /** Nombre de pings envoyés. */
  readonly pingCount: number;
  /** Dernier ping réussi (timestamp). */
  readonly lastPingAt: number;
}

/** Configuration du keep-alive. */
export interface KeepAliveConfig {
  /** Intervalle minimum entre pings (ms). Défaut: 8 min. */
  minIntervalMs?: number;
  /** Intervalle maximum entre pings (ms). Défaut: 12 min. */
  maxIntervalMs?: number;
  /** Callback quand le token semble expiré (401 reçu). */
  onTokenExpired?: () => void;
}

// ─── Constantes ─────────────────────────────────────────────────────────────

const DEFAULT_MIN_INTERVAL_MS = 8 * 60_000;  // 8 min
const DEFAULT_MAX_INTERVAL_MS = 12 * 60_000; // 12 min
const REFERER_DASHBOARD = "https://www.usvisaappt.com/visaapplicantui/home/dashboard";

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Démarre le keep-alive pour une session active.
 * Envoie un ping léger (getLandingPageDeatils) à intervalles gaussiens.
 *
 * @param session - Session USA active avec token valide
 * @param jobId - Job ID pour les logs
 * @param config - Configuration optionnelle
 * @returns Handle pour arrêter le keep-alive
 */
export function startKeepAlive(
  session: UsaSession,
  jobId: string,
  config?: KeepAliveConfig,
): KeepAliveHandle {
  const minMs = config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const maxMs = config?.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;

  let running = true;
  let pingCount = 0;
  let lastPingAt = 0;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function ping(): Promise<boolean> {
    if (!running) return false;
    if (!session.applicationId) return false;

    try {
      const headers = {
        ...sessionHeaders(
          session.accessToken,
          session.applicationId,
          session.missionId,
          REFERER_DASHBOARD,
          false,
        ),
        "LanguageId": "1",
      };

      const res = await usaFetch(USA_LANDING_PAGE_URL, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 401) {
        console.log(`[keep-alive] 🔒 Token expiré (401) — arrêt keep-alive`);
        running = false;
        config?.onTokenExpired?.();
        return false;
      }

      pingCount++;
      lastPingAt = Date.now();
      console.log(`[keep-alive] 💓 Ping #${pingCount} OK (HTTP ${res.status})`);
      return true;
    } catch (err) {
      // Erreur réseau — ne pas arrêter, retenter au prochain intervalle
      console.warn(`[keep-alive] ⚠️ Ping échoué: ${err}`);
      return true; // continuer quand même
    }
  }

  function scheduleNext(): void {
    if (!running) return;
    const intervalMs = gaussianInterval(minMs, maxMs);
    timeoutId = setTimeout(async () => {
      const shouldContinue = await ping();
      if (shouldContinue && running) {
        scheduleNext();
      }
    }, intervalMs);
  }

  // Premier ping après le premier intervalle (pas immédiat)
  scheduleNext();
  console.log(`[keep-alive] 🟢 Démarré pour job ${jobId.slice(-5)} (${Math.round(minMs / 60_000)}-${Math.round(maxMs / 60_000)} min)`);

  return {
    stop() {
      running = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      console.log(`[keep-alive] 🔴 Arrêté (${pingCount} pings envoyés)`);
    },
    get isRunning() { return running; },
    get pingCount() { return pingCount; },
    get lastPingAt() { return lastPingAt; },
  };
}
