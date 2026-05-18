/**
 * Pillar 1 — Pre-Flight Proxy Health Check
 *
 * Avant chaque tentative de login, on vérifie que le proxy est réactif
 * en effectuant un GET rapide vers https://api.ipify.org.
 *
 * Seuil : 5000ms. Si le proxy ne répond pas dans ce délai ou échoue,
 * la session du compte est AVORTÉE immédiatement.
 *
 * Objectif : ne JAMAIS tenter un login si le proxy est instable — préserver
 * la réputation du compte auprès de Cognito (les timeouts côté portail sont
 * interprétés comme des tentatives suspectes et comptent vers le lockout).
 */

import { Impit } from "impit";
import { botLog } from "../convexClient.js";

/** Seuil de latence max (ms) au-delà duquel le proxy est considéré instable. */
const PROXY_LATENCY_THRESHOLD_MS = 5000;

/** URL légère pour tester la connectivité proxy (retourne l'IP de sortie en texte brut). */
const HEALTH_CHECK_URL = "https://api.ipify.org?format=text";

export interface ProxyHealthResult {
  /** true si le proxy a répondu dans les temps. */
  healthy: boolean;
  /** Latence mesurée en ms (Infinity si timeout/erreur). */
  latencyMs: number;
  /** IP de sortie du proxy (null si échec). */
  exitIp: string | null;
  /** Message d'erreur si unhealthy. */
  error?: string;
}

/**
 * Effectue un GET rapide vers ipify.org via le proxy donné.
 *
 * Utilise Impit (fingerprint TLS Chrome) pour router via le proxy.
 * Impit gère nativement les certificats SSL des proxies (comme un vrai Chrome)
 * sans avoir besoin de rejectUnauthorized:false — compatible BrightData, iProyal, etc.
 *
 * @param proxyUrl — URL complète du proxy (http://user:pass@host:port)
 * @param jobId   — ID du job Convex pour le logging (optionnel)
 */
export async function preFlightProxyCheck(
  proxyUrl: string | undefined,
  jobId?: string,
): Promise<ProxyHealthResult> {
  // Si pas de proxy configuré (connexion directe Railway), le check passe toujours.
  if (!proxyUrl) {
    return { healthy: true, latencyMs: 0, exitIp: null };
  }

  const t0 = Date.now();

  try {
    const impit = new Impit({ browser: "chrome", proxyUrl, ignoreTlsErrors: true });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_LATENCY_THRESHOLD_MS);

    const res = await impit.fetch(HEALTH_CHECK_URL, {
      signal: controller.signal,
    }) as unknown as Response;

    clearTimeout(timeout);
    const latencyMs = Date.now() - t0;

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const result: ProxyHealthResult = {
        healthy: false,
        latencyMs,
        exitIp: null,
        error: `HTTP ${res.status}${body ? ` — ${body.slice(0, 100)}` : ""}`,
      };
      logHealthCheck(result, proxyUrl, jobId);
      return result;
    }

    const exitIp = (await res.text()).trim();
    const healthy = latencyMs <= PROXY_LATENCY_THRESHOLD_MS;

    const result: ProxyHealthResult = {
      healthy,
      latencyMs,
      exitIp,
      error: healthy ? undefined : `Latency ${latencyMs}ms exceeds ${PROXY_LATENCY_THRESHOLD_MS}ms threshold`,
    };

    logHealthCheck(result, proxyUrl, jobId);
    return result;
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMsg.includes("abort") || errorMsg.includes("timeout");

    const result: ProxyHealthResult = {
      healthy: false,
      latencyMs: isTimeout ? PROXY_LATENCY_THRESHOLD_MS : latencyMs,
      exitIp: null,
      error: isTimeout
        ? `Proxy timeout (>${PROXY_LATENCY_THRESHOLD_MS}ms)`
        : `Proxy error: ${errorMsg.slice(0, 200)}`,
    };

    logHealthCheck(result, proxyUrl, jobId);
    return result;
  }
}

function logHealthCheck(result: ProxyHealthResult, proxyUrl: string, jobId?: string): void {
  const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
  const status = result.healthy ? "✅" : "❌";

  console.log(
    `[proxy-health] ${status} ${result.latencyMs}ms` +
    `${result.exitIp ? ` IP:${result.exitIp}` : ""}` +
    `${result.error ? ` — ${result.error}` : ""}` +
    ` [${masked.slice(0, 40)}…]`
  );

  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "proxy_health_check",
      status: result.healthy ? "ok" : "fail",
      data: {
        latencyMs: result.latencyMs,
        exitIp: result.exitIp,
        healthy: result.healthy,
        error: result.error,
        thresholdMs: PROXY_LATENCY_THRESHOLD_MS,
      },
    });
  }
}
