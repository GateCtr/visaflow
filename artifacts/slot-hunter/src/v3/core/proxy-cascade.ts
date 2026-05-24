/**
 * Proxy Cascade V3 — 4-way failover + budget protection.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Résoudre un proxy fonctionnel en testant chaque provider dans l'ordre configuré.
 *   Si TOUS les proxies sont down → retourner null (l'appelant ne login PAS).
 *
 * PROTECTION BUDGET :
 *   Proxy mort ≠ login gaspillé. Le session-pool ne consomme un login QUE si
 *   resolveProxy() retourne une URL valide. Si null → pas de login → budget intact.
 *
 * ORDRE PAR DÉFAUT :
 *   1. iProyal (sticky résidentiel, 12h)
 *   2. SOAX (sticky résidentiel, 10h, ciblage ville)
 *   3. BrightData (sticky résidentiel, keep-alive)
 *   4. 2captcha gateway (eu.proxy.2captcha.com, sticky 1h)
 *
 * ADMIN-PILOTABLE :
 *   bot-config Convex clé "proxy_priority" → ex: "soax,iproyal,brightdata,2captcha"
 *   hunterConfig.preferredProxy → override par dossier
 *
 * USAGE :
 *   const proxy = await resolveProxy(config);
 *   if (!proxy) { recordProxyDeath(username); return null; } // PAS de login
 *   setUsaSessionProxy(proxy.url);
 */

import { recordProxyDeath } from "./session-pool.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Résultat d'une résolution proxy. */
export interface ProxyResolution {
  /** URL du proxy fonctionnel (prête pour setUsaSessionProxy). */
  url: string;
  /** Provider qui a répondu. */
  provider: "iproyal" | "brightdata" | "2captcha" | "soax";
  /** Latence du pre-flight check (ms). */
  latencyMs: number;
  /** IP de sortie détectée. */
  exitIp?: string;
}

/** Configuration pour la résolution proxy. */
export interface ProxyCascadeConfig {
  /** Username du compte (pour les logs + sticky session). */
  username: string;
  /** Job ID (pour les logs). */
  jobId: string;
  /** Ordre de priorité (si absent → défaut iproyal → soax → brightdata → 2captcha). */
  priority?: string[]; // ["iproyal", "soax", "brightdata", "2captcha"]
  /** Pre-flight URL pour tester le proxy (défaut: api.ipify.org). */
  preFlightUrl?: string;
  /** Timeout pre-flight (ms). Défaut: 10s. */
  preFlightTimeoutMs?: number;
}

/** Provider abstrait (chaque implémentation sait construire son URL). */
export interface ProxyProvider {
  name: "iproyal" | "brightdata" | "2captcha" | "soax";
  /** Le provider est-il configuré (env vars présentes) ? */
  isConfigured(): boolean;
  /** Construit l'URL sticky pour ce compte. */
  buildStickyUrl(username: string): string | null;
}

// ─── Providers ──────────────────────────────────────────────────────────────

const iproyalProvider: ProxyProvider = {
  name: "iproyal",
  isConfigured: () => !!process.env.IPROYAL_PROXY_URL,
  buildStickyUrl: (username: string) => {
    const base = process.env.IPROYAL_PROXY_URL;
    if (!base) return null;
    // Sticky session via session ID dans le password
    // Format iProyal: _session-{hash}_lifetime-12h
    const hash = simpleHash(`${username}:${new Date().toISOString().slice(0, 10)}`);
    try {
      const parsed = new URL(base);
      let password = decodeURIComponent(parsed.password);
      // Supprimer l'ancienne session si présente
      password = password.replace(/_session-[^_]+_lifetime-\d+[hm]/, "");
      password += `_session-${hash}_lifetime-12h`;
      parsed.password = encodeURIComponent(password);
      return parsed.toString();
    } catch {
      return null;
    }
  },
};

const brightdataProvider: ProxyProvider = {
  name: "brightdata",
  isConfigured: () => !!process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL,
  buildStickyUrl: (username: string) => {
    const base = process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL;
    if (!base) return null;
    const hash = simpleHash(`${username}:${Date.now().toString(36)}`);
    try {
      const parsed = new URL(base);
      parsed.username += `-country-cd-session-${hash}`;
      return parsed.toString();
    } catch {
      return null;
    }
  },
};

const twocaptchaProvider: ProxyProvider = {
  name: "2captcha",
  isConfigured: () => !!(process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY),
  buildStickyUrl: (username: string) => {
    const user = process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY ?? "";
    if (!user) return null;
    const hash = simpleHash(`${username}:${Date.now().toString(36)}`);
    const login = `${user}-zone-custom-region-cd_session-${hash}_lifetime-1h`;
    return `http://${encodeURIComponent(login)}:${encodeURIComponent(user)}@eu.proxy.2captcha.com:2334`;
  },
};

const soaxProvider: ProxyProvider = {
  name: "soax",
  isConfigured: () => !!process.env.SOAX_PROXY_URL,
  buildStickyUrl: (username: string) => {
    const base = process.env.SOAX_PROXY_URL;
    if (!base) return null;
    const hash = simpleHash(`${username}:${new Date().toISOString().slice(0, 10)}`);
    const country = process.env.SOAX_COUNTRY ?? "cd";
    const city = process.env.SOAX_CITY ?? "kinshasa";
    const sesstime = process.env.SOAX_SESSION_TIME ?? "600";
    try {
      const parsed = new URL(base.startsWith("http") ? base : `http://${base}`);
      let proxyUser = decodeURIComponent(parsed.username);
      // Nettoyer les anciens paramètres SOAX du username si présents
      proxyUser = proxyUser
        .replace(/-country-[^-]*/g, "")
        .replace(/-city-[^-]*/g, "")
        .replace(/-sessionid-[^-]*/g, "")
        .replace(/-sessionlength-[^-]*/g, "")
        .replace(/-+$/, "");
      // Ajouter les paramètres sticky dans le USERNAME (format SOAX Dashboard v2)
      // Format: {package}-sessionid-{id}-sessionlength-{sec}-country-{cc}-city-{city}
      proxyUser += `-sessionid-${hash}`;
      proxyUser += `-sessionlength-${parseInt(sesstime) * 60}`; // SOAX attend des secondes
      proxyUser += `-country-${country}`;
      if (city) proxyUser += `-city-${city}`;
      parsed.username = encodeURIComponent(proxyUser);
      return parsed.toString();
    } catch {
      return null;
    }
  },
};

const ALL_PROVIDERS: ProxyProvider[] = [iproyalProvider, soaxProvider, brightdataProvider, twocaptchaProvider];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Hash simple déterministe (8 chars base62). */
function simpleHash(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  let h = Math.abs(hash);
  for (let i = 0; i < 8; i++) {
    result += chars[h % 62];
    h = Math.floor(h / 62) + (i + 1) * 7;
  }
  return result;
}

/** Pre-flight : vérifie que le proxy répond (via fetch ipify). */
async function preFlightCheck(proxyUrl: string, timeoutMs: number): Promise<{ ok: boolean; latencyMs: number; ip?: string; error?: string }> {
  const start = Date.now();
  try {
    // Import dynamique pour éviter la dépendance circulaire
    const { Impit } = await import("impit");
    const impit = new Impit({ browser: "chrome", proxyUrl, ignoreTlsErrors: true } as any);
    const res = await impit.fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(timeoutMs),
    }) as unknown as Response;
    const latencyMs = Date.now() - start;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    const j = await res.json() as { ip?: string };
    return { ok: true, latencyMs, ip: j.ip };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message?.slice(0, 100) };
  }
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Résout un proxy fonctionnel en testant chaque provider dans l'ordre.
 * Retourne null si TOUS sont down (l'appelant ne doit PAS login).
 */
export async function resolveProxy(config: ProxyCascadeConfig): Promise<ProxyResolution | null> {
  const timeoutMs = config.preFlightTimeoutMs ?? 10_000;

  // Déterminer l'ordre des providers
  const order = config.priority ?? ["iproyal", "soax", "brightdata", "2captcha"];
  const providers = order
    .map(name => ALL_PROVIDERS.find(p => p.name === name))
    .filter((p): p is ProxyProvider => p !== undefined && p.isConfigured());

  if (providers.length === 0) {
    console.warn(`[proxy-cascade] ⚠️ Aucun proxy configuré pour ${config.username.slice(0, 12)}…`);
    return null;
  }

  // Tester chaque provider dans l'ordre
  for (const provider of providers) {
    const url = provider.buildStickyUrl(config.username);
    if (!url) continue;

    const masked = url.replace(/:([^:@]+)@/, ":***@");
    console.log(`[proxy-cascade] 🔄 Test ${provider.name} pour ${config.username.slice(0, 12)}…`);

    const result = await preFlightCheck(url, timeoutMs);

    if (result.ok) {
      console.log(`[proxy-cascade] ✅ ${provider.name} OK (${result.latencyMs}ms, IP: ${result.ip})`);
      return {
        url,
        provider: provider.name,
        latencyMs: result.latencyMs,
        exitIp: result.ip,
      };
    }

    console.warn(`[proxy-cascade] ❌ ${provider.name} FAILED: ${result.error} (${result.latencyMs}ms)`);
  }

  // Tous les providers sont down
  console.error(`[proxy-cascade] 🚨 TOUS LES PROXIES DOWN pour ${config.username.slice(0, 12)}… — login INTERDIT`);
  recordProxyDeath(config.username);
  return null;
}

/**
 * Parse l'ordre de priorité proxy depuis une string bot-config Convex.
 * Format: "soax,iproyal,brightdata,2captcha" ou "soax" ou "brightdata,2captcha"
 * Retourne null si invalide (l'appelant utilise l'ordre par défaut).
 */
export function parseProxyPriority(value: string | null): string[] | null {
  if (!value || !value.trim()) return null;
  const order = value.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const valid = ["iproyal", "brightdata", "2captcha", "soax"];
  const filtered = order.filter(o => valid.includes(o));
  return filtered.length > 0 ? filtered : null;
}
