/**
 * SOAX Residential Proxy — sticky session management avec keep-alive.
 *
 * Format URL SOAX (Dashboard v2 — paramètres dans le USERNAME) :
 *   http://{package}-sessionid-{id}-sessionlength-{seconds}-country-{cc}-city-{city}:{password}@proxy.soax.com:5000
 *
 * Différences avec les autres providers:
 *   - IPRoyal: session ID dans le PASSWORD (_session-XXX_lifetime-60m)
 *   - BrightData: session ID dans le USERNAME (-session-XXX)
 *   - SOAX (v2): paramètres dans le USERNAME, séparés par "-" (tiret)
 *   - SOAX utilise "sessionid" pour le sticky et "sessionlength" en SECONDES
 *   - IMPORTANT: codes pays/ville en MINUSCULE obligatoire (CD → cd, Kinshasa → kinshasa)
 *   - Idle timeout SOAX: variable — session libérée si pas d'activité pendant ~5 min
 *   - Solution: keep-alive automatique toutes les 2-3 min (même pattern que BrightData)
 *
 * Variables d'environnement:
 *   SOAX_PROXY_URL — URL de base du proxy SOAX (credentials sans paramètres de session)
 *     Format attendu: http://package-XXXXX:PASSWORD@proxy.soax.com:5000
 *     Les paramètres (sessionid, sessionlength, country, city) sont ajoutés dynamiquement.
 *   SOAX_COUNTRY — Code pays de sortie en minuscule (défaut: "cd" = Congo/RDC)
 *   SOAX_CITY — Ville cible en minuscule (défaut: "kinshasa")
 *   SOAX_FALLBACK_COUNTRIES — Liste de pays de fallback séparés par virgule
 *     Défaut: "za,ke,ng" — essayés dans l'ordre si le pays principal timeout.
 *   SOAX_SESSION_TIME — Durée de session sticky en minutes (défaut: 600 = 10h)
 *     Converti en secondes pour l'API SOAX (600 min → 36000 sec).
 */

import { tokenCache, isCachedTokenValid } from "./usa-http.js";

// ─── Compteur de rotation par compte (force nouvelle IP après erreur) ────────
const _soaxRotationCount = new Map<string, number>();

// ─── Configuration ───────────────────────────────────────────────────────────

/** Pays principal pour SOAX (env: SOAX_COUNTRY, défaut: "cd") */
const SOAX_PRIMARY_COUNTRY = process.env.SOAX_COUNTRY ?? "cd";

/** Ville cible pour SOAX (env: SOAX_CITY, défaut: "kinshasa") */
const SOAX_CITY = process.env.SOAX_CITY ?? "kinshasa";

/** Durée de session sticky en minutes (env: SOAX_SESSION_TIME, défaut: 5 = 5min = 300s) */
const SOAX_SESSION_TIME_MIN = parseInt(process.env.SOAX_SESSION_TIME ?? "5", 10);

/**
 * Liste de pays de fallback à essayer si le pays principal timeout.
 * "za" (Afrique du Sud) a un pool résidentiel massif et fiable.
 * "ke" (Kenya) et "ng" (Nigeria) sont des alternatives africaines raisonnables.
 */
const SOAX_FALLBACK_COUNTRIES: string[] = (
  process.env.SOAX_FALLBACK_COUNTRIES ?? "za,ke,ng"
).split(",").map(c => c.trim()).filter(Boolean);

// ─── Keep-alive state ─────────────────────────────────────────────────────────
interface SoaxSession {
  sessionId: string;
  proxyUrl: string;
  createdAt: number;
  lastKeepAliveAt: number;
  keepAliveTimer: ReturnType<typeof setInterval> | null;
  username: string; // compte USA associé
}

const _activeSessions = new Map<string, SoaxSession>(); // key = username.toLowerCase()

// Keep-alive interval: 2-3 min (bien en dessous du idle timeout de ~5 min)
const KEEP_ALIVE_INTERVAL_MS = 150_000; // 2.5 min
const KEEP_ALIVE_JITTER_MS = 30_000; // ±30s de jitter

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Hash simple déterministe (8 chars alphanumériques). */
function simpleHash(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  let h = Math.abs(hash);
  for (let i = 0; i < 8; i++) {
    result += chars[h % 36];
    h = Math.floor(h / 36) + (i + 1) * 7;
  }
  return result;
}

/**
 * Nettoie le username SOAX des paramètres de session existants.
 * Retourne le username de base (package-XXXXX) sans les options dynamiques.
 */
function cleanSoaxUsername(username: string): string {
  return username
    .replace(/-sessionid-[^-]*/g, "")
    .replace(/-sessionlength-[^-]*/g, "")
    .replace(/-country-[^-]*/g, "")
    .replace(/-city-[^-]*/g, "")
    .replace(/-bindttl-[^-]*/g, "")
    .replace(/-opt-[^-]*/g, "")
    .replace(/-+$/, ""); // supprimer les "-" trailing
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Génère une URL proxy SOAX sticky pour un compte donné.
 *
 * Le session ID est déterministe par demi-journée + compte (même logique que BrightData/iProyal)
 * pour garantir que le même compte garde la même IP pendant toute la session.
 *
 * @param baseUrl - URL du proxy SOAX (SOAX_PROXY_URL)
 * @param username - Compte USA (pour la seed du session ID)
 * @param country - Code pays cible (défaut: SOAX_COUNTRY env ou "cd")
 * @param city - Ville cible (défaut: SOAX_CITY env ou "kinshasa"). Passer "" pour désactiver.
 * @returns URL proxy avec session sticky intégrée
 */
export function makeSoaxStickyUrl(
  baseUrl: string,
  username?: string,
  country: string = SOAX_PRIMARY_COUNTRY,
  city: string = SOAX_CITY,
): string {
  try {
    const parsed = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);

    // Nettoyer le username existant (enlever anciens paramètres de session)
    let proxyUser = decodeURIComponent(parsed.username);
    
    // Extraire et conserver les paramètres fixes depuis la base URL (bindttl, opt)
    const bindttlMatch = proxyUser.match(/-bindttl-(\d+)/);
    const optMatch = proxyUser.match(/-opt-([^-]+)/);
    const bindttl = bindttlMatch ? bindttlMatch[1] : "3600";
    const opt = optMatch ? optMatch[1] : "wb";
    
    proxyUser = cleanSoaxUsername(proxyUser);

    // Générer session ID déterministe (stable par période + compteur de rotation)
    const now = new Date();
    const halfDay = now.getUTCHours() < 12 ? "AM" : "PM";
    const rotationCount = _soaxRotationCount.get((username ?? "default").toLowerCase()) ?? 0;
    const seed = `${now.toISOString().slice(0, 10)}-${halfDay}:${(username ?? "default").toLowerCase()}:soax:r${rotationCount}`;
    const sessionId = simpleHash(seed);

    // Construire le username avec les paramètres SOAX (format Dashboard v2)
    // Format: {package}-sessionid-{id}-sessionlength-{sec}-country-{cc}-city-{city}-bindttl-{ttl}-opt-{opt}
    const sessionLengthSec = SOAX_SESSION_TIME_MIN * 60; // SOAX attend des secondes
    proxyUser += `-sessionid-${sessionId}`;
    proxyUser += `-sessionlength-${sessionLengthSec}`;
    proxyUser += `-country-${country}`;
    if (city) {
      proxyUser += `-city-${city}`;
    }
    proxyUser += `-bindttl-${bindttl}`;
    proxyUser += `-opt-${opt}`;

    parsed.username = encodeURIComponent(proxyUser);

    const finalUrl = parsed.toString();
    console.log(`[soax] 🔒 Sticky sessionid=${sessionId} country=${country}${city ? ` city=${city}` : ""} sessionlength=${sessionLengthSec}s rot#${rotationCount}`);

    return finalUrl;
  } catch (err) {
    console.warn(`[soax] ⚠️ Impossible de parser l'URL proxy — fallback sur URL brute`);
    return baseUrl;
  }
}

/**
 * Essaie le pays principal puis les pays de fallback pour SOAX.
 *
 * Le pool résidentiel du Congo (country=cd) est petit — les pays de fallback
 * (za, ke, ng) ont des pools beaucoup plus larges et fiables.
 *
 * @param baseUrl - URL du proxy SOAX (SOAX_PROXY_URL)
 * @param username - Compte USA
 * @param preFlightCheck - Fonction de health check (injectée pour éviter import circulaire)
 * @param jobId - ID du job pour logging
 * @returns { url, country } ou null si tous les pays échouent
 */
export async function makeSoaxStickyUrlWithFallback(
  baseUrl: string,
  username: string,
  preFlightCheck: (proxyUrl: string, jobId?: string) => Promise<{ healthy: boolean; latencyMs: number; exitIp: string | null; error?: string }>,
  jobId?: string,
): Promise<{ url: string; country: string; latencyMs: number } | null> {
  // Construire la liste de pays à essayer: primaire + fallbacks
  const countries = [SOAX_PRIMARY_COUNTRY, ...SOAX_FALLBACK_COUNTRIES.filter(c => c !== SOAX_PRIMARY_COUNTRY)];

  for (const country of countries) {
    // Pas de ciblage ville pour les pays de fallback (pool trop petit)
    const city = country === SOAX_PRIMARY_COUNTRY ? SOAX_CITY : "";
    const url = makeSoaxStickyUrl(baseUrl, username, country, city);
    const health = await preFlightCheck(url, jobId);

    if (health.healthy) {
      if (country !== SOAX_PRIMARY_COUNTRY) {
        console.log(`[soax] 🌍 Fallback country=${country} OK (${health.latencyMs}ms) — pays principal "${SOAX_PRIMARY_COUNTRY}" indisponible`);
      }
      return { url, country, latencyMs: health.latencyMs };
    }

    console.warn(`[soax] ⚠️ country=${country} FAILED (${health.error}) — essai suivant...`);
  }

  console.error(`[soax] ❌ TOUS les pays épuisés (${countries.join(", ")}) — SOAX inaccessible`);
  return null;
}

/**
 * Retourne la configuration country actuelle (pour les logs de diagnostic).
 */
export function getSoaxCountryConfig(): { primary: string; city: string; fallbacks: string[] } {
  return { primary: SOAX_PRIMARY_COUNTRY, city: SOAX_CITY, fallbacks: SOAX_FALLBACK_COUNTRIES };
}

/**
 * Force la rotation du proxy SOAX pour un compte donné.
 * Appelé après un échec réseau / 401 pour obtenir une nouvelle IP au prochain login.
 */
export function rotateSoaxSession(username: string): void {
  const key = username.toLowerCase();
  const current = _soaxRotationCount.get(key) ?? 0;
  _soaxRotationCount.set(key, current + 1);

  // Arrêter le keep-alive de l'ancienne session
  stopSoaxKeepAlive(key);

  console.log(`[soax] 🔄 Rotation demandée pour ${key.slice(0, 12)}… (rot#${current + 1})`);
}

/**
 * Démarre le keep-alive automatique pour une session SOAX.
 *
 * Envoie une requête légère (ipify) toutes les 2-3 min via le proxy
 * pour empêcher le idle timeout de SOAX (~5 min).
 *
 * IMPORTANT: Le keep-alive est séparé du keep-alive du portail USA.
 * - Ce keep-alive maintient la SESSION PROXY (même IP de sortie)
 * - Le keep-alive portail maintient le JWT (sendKeepAliveIfNeeded)
 */
export function startSoaxKeepAlive(proxyUrl: string, username: string): void {
  const key = username.toLowerCase();

  // Arrêter un éventuel ancien keep-alive
  stopSoaxKeepAlive(key);

  // Extraire le session ID de l'URL pour le log
  const sessionMatch = decodeURIComponent(proxyUrl).match(/sessionid-([a-z0-9]+)/);
  const sessionId = sessionMatch?.[1] ?? "unknown";

  const session: SoaxSession = {
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
      // Vérifier que le token du compte est encore valide avant de ping.
      const cachedToken = tokenCache.get(session.username);
      if (!cachedToken || !isCachedTokenValid(cachedToken)) {
        console.log(`[soax] 🛑 Token expiré/invalide pour ${session.username.slice(0, 12)}… — arrêt keep-alive proxy`);
        if (session.keepAliveTimer) {
          clearInterval(session.keepAliveTimer);
          session.keepAliveTimer = null;
        }
        _activeSessions.delete(session.username);
        return;
      }

      const elapsed = Date.now() - session.lastKeepAliveAt;
      const elapsedSec = Math.round(elapsed / 1000);

      // Passer la requête VIA le proxy SOAX pour maintenir la session.
      const { Impit } = await import("impit");
      const impit = new Impit({ browser: "chrome", proxyUrl: session.proxyUrl, ignoreTlsErrors: true } as any);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const res = await impit.fetch("https://api.ipify.org?format=json", {
        signal: controller.signal,
      }) as unknown as Response;

      clearTimeout(timeout);

      if (res.ok) {
        session.lastKeepAliveAt = Date.now();
        const data = await res.json().catch(() => null) as { ip?: string } | null;
        const ip = data?.ip ?? "?";
        console.log(`[soax] 🏓 Keep-alive OK (${elapsedSec}s) — session=${sessionId} IP: ${ip}`);
      } else {
        console.warn(`[soax] 🏓 Keep-alive HTTP ${res.status} — session=${sessionId} peut être morte`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[soax] 🏓 Keep-alive erreur — session=${sessionId}: ${msg.slice(0, 100)}`);
    }
  }, interval);

  // Unref le timer pour ne pas bloquer l'arrêt du process
  if (session.keepAliveTimer && typeof session.keepAliveTimer === "object" && "unref" in session.keepAliveTimer) {
    (session.keepAliveTimer as NodeJS.Timeout).unref();
  }

  _activeSessions.set(key, session);
  console.log(`[soax] ✅ Keep-alive démarré: session=${sessionId}, intervalle=${Math.round(interval / 1000)}s`);
}

/**
 * Arrête le keep-alive pour un compte donné.
 */
export function stopSoaxKeepAlive(username: string): void {
  const key = username.toLowerCase();
  const session = _activeSessions.get(key);
  if (session?.keepAliveTimer) {
    clearInterval(session.keepAliveTimer);
    session.keepAliveTimer = null;
    const durationMin = Math.round((Date.now() - session.createdAt) / 60000);
    console.log(`[soax] 🛑 Keep-alive arrêté: session=${session.sessionId} (durée: ${durationMin}min)`);
  }
  _activeSessions.delete(key);
}

/**
 * Vérifie si une session SOAX est active pour un compte.
 */
export function hasSoaxSession(username: string): boolean {
  return _activeSessions.has(username.toLowerCase());
}

/**
 * Retourne l'info de la session active (pour diagnostic/logs).
 */
export function getSoaxSessionInfo(username: string): {
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
 * Arrête tous les keep-alive SOAX actifs.
 * Appelé lors de l'arrêt du process (graceful shutdown).
 */
export function stopAllSoaxKeepAlives(): void {
  for (const [, session] of _activeSessions.entries()) {
    if (session.keepAliveTimer) {
      clearInterval(session.keepAliveTimer);
    }
  }
  const count = _activeSessions.size;
  _activeSessions.clear();
  if (count > 0) {
    console.log(`[soax] 🛑 ${count} keep-alive(s) arrêté(s) (shutdown)`);
  }
}
