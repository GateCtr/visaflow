/**
 * BrightData Residential Proxy — sticky session management avec keep-alive.
 *
 * Format URL BrightData:
 *   http://{username}-session-{sessionId}-country-{cc}:{password}@brd.superproxy.io:33335
 *
 * Différences avec iProyal:
 *   - iProyal: session ID dans le PASSWORD (_session-XXX_lifetime-60m)
 *   - BrightData: session ID dans le USERNAME (-session-XXX)
 *   - BrightData n'a PAS de lifetime explicite — la session reste active tant qu'il y a du trafic
 *   - Idle timeout BrightData: ~5-7 min sans requête → l'IP est relâchée
 *   - Solution: keep-alive automatique toutes les 2-3 min
 *
 * Variables d'environnement:
 *   BRIGHTDATA_PROXY_URL — URL complète du proxy résidentiel (avec credentials)
 *     Format attendu: http://brd-customer-XXX-zone-YYY:PASSWORD@brd.superproxy.io:33335
 *     Ou format simplifié pour les tests: http://user:pass@host:port
 */

import { tokenCache, isCachedTokenValid } from "./usa-http.js";

// ─── Compteur de rotation par compte (force nouvelle IP après erreur) ────────
const _brightdataRotationCount = new Map<string, number>();

// ─── Keep-alive state ─────────────────────────────────────────────────────────
interface BrightDataSession {
  sessionId: string;
  proxyUrl: string;
  createdAt: number;
  lastKeepAliveAt: number;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  username: string; // compte USA associé
}

const _activeSessions = new Map<string, BrightDataSession>(); // key = username.toLowerCase()

// Keep-alive interval: 2-3 min (bien en dessous du idle timeout de 5-7 min)
const KEEP_ALIVE_INTERVAL_MS = 150_000; // 2.5 min
const KEEP_ALIVE_JITTER_MS = 30_000; // ±30s de jitter

/**
 * Génère une URL proxy BrightData sticky pour un compte donné.
 *
 * Le session ID est déterministe par demi-journée + compte (même logique qu'iProyal)
 * pour garantir que le même compte garde la même IP pendant toute la session.
 *
 * @param baseUrl - URL du proxy BrightData (BRIGHTDATA_PROXY_URL)
 * @param username - Compte USA (pour la seed du session ID)
 * @param country - Code pays cible (défaut: "cd" pour Congo/RDC)
 * @returns URL proxy avec session sticky intégrée
 */
export function makeBrightDataStickyUrl(
  baseUrl: string,
  username?: string,
  country: string = "cd",
): string {
  try {
    const parsed = new URL(baseUrl);
    let proxyUsername = decodeURIComponent(parsed.username);

    // Nettoyer les anciens paramètres de session si présents
    proxyUsername = proxyUsername
      .replace(/-session-[a-zA-Z0-9]+/g, "")
      .replace(/-country-[a-z]{2}/g, "");

    // Générer session ID déterministe (stable par période + compteur de rotation)
    // NOTE: Ceci ne garantit PAS la même IP pendant 12h. La session iProyal expire
    // après 60 min (lifetime). Le halfDay sert uniquement à la reprise déterministe.
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _brightdataRotationCount.get((username ?? "default").toLowerCase()) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${(username ?? "default").toLowerCase()}:brightdata:r${rotationCount}`;

    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;

    // Session ID: 8 caractères alphanumériques
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let sessionId = "";
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 36];
      h = Math.floor(h / 36) + (i + 1) * 7;
    }

    // Construire le username avec session et country
    proxyUsername += `-session-${sessionId}-country-${country}`;
    parsed.username = encodeURIComponent(proxyUsername);

    const finalUrl = parsed.toString();
    const masked = finalUrl.replace(/:([^:@]+)@/, ":***@");
    console.log(`[brightdata] 🔒 Sticky session=${sessionId} country=${country} rot#${rotationCount}`);

    return finalUrl;
  } catch (err) {
    console.warn(`[brightdata] ⚠️ Impossible de parser l'URL proxy — fallback sur URL brute`);
    return baseUrl;
  }
}

/**
 * Force la rotation du proxy BrightData pour un compte donné.
 * Appelé après un échec réseau / 401 pour obtenir une nouvelle IP au prochain login.
 */
export function rotateBrightDataSession(username: string): void {
  const key = username.toLowerCase();
  const current = _brightdataRotationCount.get(key) ?? 0;
  _brightdataRotationCount.set(key, current + 1);

  // Arrêter le keep-alive de l'ancienne session
  stopBrightDataKeepAlive(key);

  console.log(`[brightdata] 🔄 Rotation demandée pour ${key.slice(0, 12)}… (rot#${current + 1})`);
}

/**
 * Démarre le keep-alive automatique pour une session BrightData.
 *
 * Envoie une requête légère (geo check) toutes les 2-3 min via le proxy
 * pour empêcher le idle timeout de BrightData (5-7 min).
 *
 * IMPORTANT: Le keep-alive est séparé du keep-alive du portail USA.
 * - Ce keep-alive maintient la SESSION PROXY (même IP de sortie)
 * - Le keep-alive portail maintient le JWT (sendKeepAliveIfNeeded)
 */
export function startBrightDataKeepAlive(proxyUrl: string, username: string): void {
  const key = username.toLowerCase();

  // Arrêter un éventuel ancien keep-alive
  stopBrightDataKeepAlive(key);

  // Extraire le session ID de l'URL pour le log
  const sessionMatch = proxyUrl.match(/-session-([a-z0-9]+)/);
  const sessionId = sessionMatch?.[1] ?? "unknown";

  const session: BrightDataSession = {
    sessionId,
    proxyUrl,
    createdAt: Date.now(),
    lastKeepAliveAt: Date.now(),
    keepAliveTimer: null,
    username: key,
  };

  // Timer avec jitter pour éviter que tous les comptes ping au même moment
  const interval = KEEP_ALIVE_INTERVAL_MS + (Math.random() * 2 - 1) * KEEP_ALIVE_JITTER_MS;

  session.keepAliveTimer = setInterval(async () => {
    try {
      // FIX 13E: Vérifier que le token du compte est encore valide avant de ping.
      // Si le token a expiré et le compte est en cooldown, inutile de maintenir
      // la session proxy — elle sera recréée au prochain login avec une nouvelle IP.
      const cachedToken = tokenCache.get(session.username);
      if (!cachedToken || !isCachedTokenValid(cachedToken)) {
        console.log(`[brightdata] 🛑 Token expiré/invalide pour ${session.username.slice(0, 12)}… — arrêt keep-alive proxy`);
        if (session.keepAliveTimer) {
          clearInterval(session.keepAliveTimer);
          session.keepAliveTimer = null;
        }
        _activeSessions.delete(session.username);
        return;
      }

      const elapsed = Date.now() - session.lastKeepAliveAt;
      const elapsedSec = Math.round(elapsed / 1000);

      // IMPORTANT: On doit passer la requête VIA le proxy BrightData pour maintenir la session.
      // Utilise Impit (comme le reste du code) pour gérer le SSL des proxies nativement.
      const { Impit } = await import("impit");
      const impit = new Impit({ browser: "chrome", proxyUrl: session.proxyUrl, ignoreTlsErrors: true } as any);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await impit.fetch("https://geo.brdtest.com/mygeo.json", {
        signal: controller.signal,
      }) as unknown as Response;

      clearTimeout(timeout);

      if (res.ok) {
        session.lastKeepAliveAt = Date.now();
        const geo = await res.json().catch(() => null) as { country?: string; asn?: { org_name?: string }; ip?: string } | null;
        const country = geo?.country ?? "?";
        const asn = geo?.asn?.org_name ?? "?";
        const ip = geo?.ip ?? "?";
        console.log(`[brightdata] 🏓 Keep-alive OK (${elapsedSec}s) — session=${sessionId} IP: ${ip} (${country}/${asn})`);
      } else {
        console.warn(`[brightdata] 🏓 Keep-alive HTTP ${res.status} — session=${sessionId} peut être morte`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[brightdata] 🏓 Keep-alive erreur — session=${sessionId}: ${msg.slice(0, 100)}`);
    }
  }, interval);

  // Unref le timer pour ne pas bloquer l'arrêt du process
  if (session.keepAliveTimer && typeof session.keepAliveTimer === "object" && "unref" in session.keepAliveTimer) {
    (session.keepAliveTimer as NodeJS.Timeout).unref();
  }

  _activeSessions.set(key, session);
  console.log(`[brightdata] ✅ Keep-alive démarré: session=${sessionId}, intervalle=${Math.round(interval / 1000)}s`);
}

/**
 * Arrête le keep-alive pour un compte donné.
 * Appelé lors de la fin de session, rotation, ou erreur.
 */
export function stopBrightDataKeepAlive(username: string): void {
  const key = username.toLowerCase();
  const session = _activeSessions.get(key);
  if (session?.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
    session.keepAliveTimer = null;
    const durationMin = Math.round((Date.now() - session.createdAt) / 60000);
    console.log(`[brightdata] 🛑 Keep-alive arrêté: session=${session.sessionId} (durée: ${durationMin}min)`);
  }
  _activeSessions.delete(key);
}

/**
 * Vérifie si une session BrightData est active pour un compte.
 */
export function hasBrightDataSession(username: string): boolean {
  return _activeSessions.has(username.toLowerCase());
}

/**
 * Retourne l'info de la session active (pour diagnostic/logs).
 */
export function getBrightDataSessionInfo(username: string): {
  sessionId: string;
  createdAt: number;
  lastKeepAliveAt: number;
  durationMin: number;
} | null {
  const session = _activeSessions.get(username.toLowerCase());
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    createdAt: session.createdAt,
    lastKeepAliveAt: session.lastKeepAliveAt,
    durationMin: Math.round((Date.now() - session.createdAt) / 60000),
  };
}

/**
 * Arrête tous les keep-alive actifs.
 * Appelé lors de l'arrêt du process (graceful shutdown).
 */
export function stopAllBrightDataKeepAlives(): void {
  for (const [key, session] of _activeSessions.entries()) {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
    }
  }
  const count = _activeSessions.size;
  _activeSessions.clear();
  if (count > 0) {
    console.log(`[brightdata] 🛑 ${count} keep-alive(s) arrêté(s) (shutdown)`);
  }
}
