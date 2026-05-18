/**
 * UsaFetcher — Instance de fetch contextualisée par session/compte.
 *
 * MOTIVATION :
 *   L'ancien `usaFetch` singleton utilisait un proxy global (_usaProxyUrl) partagé
 *   par toutes les sessions. Impossible de paralléliser : chaque appel à
 *   `setUsaSessionProxy()` écrasait le proxy du dossier précédent.
 *
 *   UsaFetcher encapsule : impit instance + proxyUrl + jitter + proxy guard + activity tracking.
 *   Chaque session/dossier crée son propre fetcher → parallélisation safe.
 *
 * COMPATIBILITÉ :
 *   L'ancien `usaFetch` global est conservé (backward-compatible) et utilise
 *   un fetcher legacy interne. Le nouveau code utilise `createSessionFetcher()`.
 *
 * USAGE :
 *   const fetcher = createSessionFetcher({ proxyUrl, username });
 *   const res = await fetcher.fetch(url, options);
 *   // ... plus tard
 *   fetcher.dispose(); // libère l'instance impit
 */

import { Impit } from "impit";
import { tokenCache } from "./usa-http.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UsaFetcherConfig {
  /** URL du proxy résidentiel (http://user:pass@host:port). undefined = connexion directe. */
  proxyUrl?: string;
  /** Username du compte (pour activity tracking et proxy guard). */
  username: string;
  /** Désactiver le jitter réseau (utile pour les health checks). */
  disableJitter?: boolean;
  /** Label pour les logs (ex: "watcher", "booking-race"). */
  label?: string;
}

export interface UsaFetcher {
  /** Exécute une requête HTTP avec fingerprint TLS Chrome via impit. */
  fetch(url: string, options?: RequestInit): Promise<Response>;
  /** URL du proxy utilisé par ce fetcher. */
  readonly proxyUrl: string | undefined;
  /** Username associé à ce fetcher. */
  readonly username: string;
  /** Libère les ressources (instance impit). Appeler en fin de session. */
  dispose(): void;
  /** Vérifie si le fetcher est actif (non disposé). */
  readonly isActive: boolean;
}

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Crée un fetcher contextualisé pour une session USA.
 *
 * Chaque fetcher possède sa propre instance impit avec son propre proxy,
 * permettant à plusieurs sessions de fonctionner en parallèle sans conflit.
 *
 * @param config - Configuration du fetcher (proxy, username, options)
 * @returns Un objet UsaFetcher avec méthode fetch() et dispose()
 */
export function createSessionFetcher(config: UsaFetcherConfig): UsaFetcher {
  const { proxyUrl, username, disableJitter = false, label } = config;
  const logPrefix = label ? `[usa:${label}]` : `[usa:${username.slice(0, 8)}]`;

  // Créer une instance impit dédiée à cette session
  const impitOptions: Record<string, unknown> = { browser: "chrome", ignoreTlsErrors: true };
  if (proxyUrl) {
    impitOptions.proxyUrl = proxyUrl;
  }

  let impitInstance: InstanceType<typeof Impit> | null = new Impit(impitOptions as any);
  let disposed = false;

  const masked = proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@") : "direct";
  console.log(`${logPrefix} ✅ Fetcher créé (proxy: ${masked})`);

  // ── Activity tracking helper ──────────────────────────────────────────────
  function touchCachedTokenActivity(headers: HeadersInit | undefined, res: Response): void {
    if (!res.ok) return;
    const bearer = extractBearerFromHeaders(headers);
    if (!bearer) return;
    const cached = tokenCache.get(username.toLowerCase());
    if (cached && cached.accessToken === bearer) {
      cached.lastActivityAt = Date.now();
    }
  }

  const fetcher: UsaFetcher = {
    get proxyUrl() { return proxyUrl; },
    get username() { return username; },
    get isActive() { return !disposed; },

    async fetch(url: string, options: RequestInit = {}): Promise<Response> {
      if (disposed || !impitInstance) {
        throw new Error(`${logPrefix} Fetcher disposed — cannot make requests`);
      }

      // ── Mid-session proxy guard ──────────────────────────────────────────
      if (proxyUrl) {
        const { checkProxyLiveness, isSessionFrozen } = await import("./proxy-session-guard.js");
        const proxyAlive = await checkProxyLiveness();
        if (!proxyAlive || isSessionFrozen(username)) {
          console.error(`${logPrefix} 🛑 REQUÊTE BLOQUÉE — proxy mort mid-session`);
          console.error(`${logPrefix}    URL: ${url.slice(0, 80)}…`);
          return new Response(
            JSON.stringify({ error: "PROXY_DEAD_MID_SESSION", message: "Session frozen — proxy died mid-session" }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      // ── Jitter réseau réaliste (30-200ms) ────────────────────────────────
      if (!disableJitter) {
        const jitterMs = 30 + Math.random() * 170;
        await new Promise(r => setTimeout(r, jitterMs));
      }

      // ── Requête via impit (fingerprint TLS Chrome) ───────────────────────
      const res = await impitInstance.fetch(url, options as Parameters<typeof impitInstance.fetch>[1]) as unknown as Response;

      // ── Activity tracking ────────────────────────────────────────────────
      touchCachedTokenActivity(options.headers, res);

      return res;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      impitInstance = null;
      console.log(`${logPrefix} 🗑️ Fetcher disposé`);
    },
  };

  return fetcher;
}

// ─── Helper interne ─────────────────────────────────────────────────────────

/** Extrait le JWT Bearer des en-têtes de requête. */
function extractBearerFromHeaders(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) {
    const v = headers.get("Authorization") ?? headers.get("authorization");
    return v?.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
  }
  if (Array.isArray(headers)) {
    const row = headers.find(([k]) => k.toLowerCase() === "authorization");
    const v = row?.[1];
    return v?.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
  }
  const o = headers as Record<string, string>;
  const v = o.Authorization ?? o.authorization;
  return typeof v === "string" && v.startsWith("Bearer ") ? v.slice(7).trim() : undefined;
}
