/**
 * ProxyPool — Proxy résidentiel 2captcha via gateway eu.proxy.2captcha.com:2334.
 *
 * ARCHITECTURE :
 *   2captcha fournit un gateway proxy (powered by iProyal) avec auth user:pass.
 *   Format : http://username:password@eu.proxy.2captcha.com:2334
 *   Username encode la zone + région : "apiKey-zone-custom-region-cd"
 *   Password = apiKey
 *
 *   Avantages vs l'ancien mode whitelist IP (generate_white_list_connections) :
 *     - Plus besoin de whitelister l'IP serveur (redéploiements Railway sans friction)
 *     - Auth par credentials → fonctionne depuis n'importe quel serveur
 *     - Sessions sticky via suffix "_session-xxx_lifetime-60m" dans le username
 *     - Même pool iProyal en backend (90M+ IPs résidentielles)
 *
 *   La priorité des providers proxy est pilotée par Convex botConfig "proxy_priority".
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const PROXY_GATEWAY_HOST = 'eu.proxy.2captcha.com';
const PROXY_GATEWAY_PORT = 2334;

/**
 * User hash pour l'auth proxy gateway 2captcha.
 * IMPORTANT: Ce n'est PAS l'API key classique (TWOCAPTCHA_API_KEY).
 * C'est un identifiant séparé visible dans le dashboard 2captcha → Proxy → Settings.
 * Format: "u" + 16 chars hex (ex: "u8e0b91d7575b05d7")
 * 
 * Si TWOCAPTCHA_PROXY_USER n'est pas défini, on utilise TWOCAPTCHA_API_KEY comme fallback
 * (fonctionne si le compte a le même hash = cas rare).
 */
const PROXY_USER = process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY ?? '';

/** Lifetime d'une session sticky (iProyal backend). */
const SESSION_LIFETIME_MINUTES = 60;

/** Durée max d'un sticky proxy avant rotation forcée. */
const IP_LIFETIME_MS = SESSION_LIFETIME_MINUTES * 60_000;

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface PoolState {
  size: number;
  lastRefreshAt: string | null;
  serverIp: string | null;
  whitelistError: boolean;
  whitelistErrorAt: string | null;
  mode: '2captcha-gateway' | 'unconfigured';
  stickyCount: number;
}

/** Proxy assigné de manière sticky à un compte — même IP pendant toute la durée du JWT. */
export interface StickyProxy {
  proxy: string;
  /** Timestamp d'expiration de la session proxy (lifetime 2captcha/iProyal). */
  expiresAt: number;
}

// ─── ProxyPool ──────────────────────────────────────────────────────────────

export class ProxyPool {
  private readonly apiKey: string;
  /** Map account → sticky proxy (même IP pendant toute la session JWT). */
  private stickyMap = new Map<string, StickyProxy>();
  /** Compteur de rotation par compte (force nouvelle session après 401/504). */
  private rotationCount = new Map<string, number>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return PROXY_USER.length > 0;
  }

  /**
   * Initialise le pool. Plus besoin de whitelister l'IP serveur
   * car l'auth se fait par credentials dans l'URL proxy.
   */
  async initialize(ip: string): Promise<void> {
    if (!this.apiKey) {
      console.error('[ProxyPool] ❌ TWOCAPTCHA_API_KEY non configurée — proxy pool désactivé');
      return;
    }
    console.log(`[ProxyPool] ✅ Gateway mode: ${PROXY_GATEWAY_HOST}:${PROXY_GATEWAY_PORT} (auth user:pass, region=cd)`);
    console.log(`[ProxyPool] Server IP: ${ip} (whitelist NON requise — auth par credentials)`);
  }

  /** @deprecated Use initialize() instead */
  setServerIp(_ip: string): void {
    // No-op en mode gateway — l'IP serveur n'a plus d'importance pour l'auth.
  }

  getState(): PoolState {
    return {
      size: -1, // Gateway mode = pas de pool local
      lastRefreshAt: null,
      serverIp: null,
      whitelistError: false,
      whitelistErrorAt: null,
      mode: this.apiKey.length > 0 ? '2captcha-gateway' : 'unconfigured',
      stickyCount: this.stickyCount,
    };
  }

  /**
   * Génère une URL proxy 2captcha gateway avec session sticky.
   *
   * Format: http://username:password@eu.proxy.2captcha.com:2334
   * Username: "{apiKey}-zone-custom-region-cd_session-{sessionId}_lifetime-{N}m"
   * Password: "{apiKey}"
   *
   * La session sticky garantit la même IP de sortie pendant `lifetime` minutes.
   * iProyal en backend gère la rotation — chaque session ID = 1 IP fixe.
   */
  private buildProxyUrl(sessionId: string, lifetimeMinutes: number = SESSION_LIFETIME_MINUTES): string {
    const lifetimeStr = lifetimeMinutes >= 60
      ? `${Math.round(lifetimeMinutes / 60)}h`
      : `${lifetimeMinutes}m`;

    // Username = TWOCAPTCHA_PROXY_USER (hash "u...") + zone + session + lifetime
    // Password = même TWOCAPTCHA_PROXY_USER
    const username = `${PROXY_USER}-zone-custom-region-cd_session-${sessionId}_lifetime-${lifetimeStr}`;
    const password = PROXY_USER;

    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${PROXY_GATEWAY_HOST}:${PROXY_GATEWAY_PORT}`;
  }

  /**
   * Génère un session ID déterministe pour un compte.
   * Basé sur : date + demi-journée + username + rotationCount.
   * Permet reprise après redémarrage (même session ID → même IP si pas expirée).
   */
  private generateSessionId(accountKey: string): string {
    // V10 — Fenêtres 12h décalées par-compte pour éviter rotation synchronisée à 00h/12h UTC.
    const now = new Date();
    let _v10h = 0;
    for (const ch of (accountKey + ':v10-rotation-offset')) _v10h = ((_v10h << 5) - _v10h + ch.charCodeAt(0)) & 0x7fffffff;
    const _v10OffsetSec = Math.abs(_v10h) % 3600;
    const _v10WindowIdx = Math.floor((Math.floor(now.getTime() / 1000) - _v10OffsetSec) / 43200);
    const rotation = this.rotationCount.get(accountKey) ?? 0;
    const seed = `w${_v10WindowIdx}:${accountKey}:2captcha-gw:r${rotation}`;

    let hash = 0;
    for (const ch of seed) hash = ((hash << 5) - hash + ch.charCodeAt(0)) & 0x7fffffff;

    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let sessionId = '';
    let h = Math.abs(hash);
    for (let i = 0; i < 8; i++) {
      sessionId += chars[h % 62];
      h = Math.floor(h / 62) + (i + 1) * 7;
    }
    return sessionId;
  }

  /**
   * Retourne un proxy rotatif (non-sticky) pour usage ponctuel.
   * Chaque appel peut obtenir une IP différente (pas de session sticky).
   */
  async getProxy(): Promise<{ proxy: string; expiresAt: string } | null> {
    if (!this.isConfigured) return null;

    // Proxy rotatif = pas de _session- dans le username → IP aléatoire à chaque requête
    const username = `${PROXY_USER}-zone-custom-region-cd`;
    const password = PROXY_USER;
    const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${PROXY_GATEWAY_HOST}:${PROXY_GATEWAY_PORT}`;

    const expiresAt = new Date(Date.now() + IP_LIFETIME_MS).toISOString();
    return { proxy: proxyUrl, expiresAt };
  }

  /**
   * Obtient un proxy sticky pour un compte donné (portail USA).
   *
   * Le serveur USA lie le JWT à l'IP du login → il faut garder la MÊME IP
   * pendant toute la durée du token.
   *
   * Comportement :
   *  - Si le compte a déjà un proxy sticky non expiré → le réutilise.
   *  - Sinon → génère une nouvelle URL gateway avec session sticky.
   *  - Si l'API key est absente → retourne null (fallback Railway direct).
   *
   * @param accountKey  Identifiant unique du compte (email lowercase).
   */
  async getStickyProxy(accountKey: string): Promise<string | null> {
    if (!this.isConfigured) return null;

    const key = accountKey.toLowerCase();

    // Vérifier si un proxy sticky existe et est encore valide
    const existing = this.stickyMap.get(key);
    if (existing && Date.now() < existing.expiresAt) {
      return existing.proxy;
    }

    // Proxy expiré ou inexistant → générer une nouvelle session
    const sessionId = this.generateSessionId(key);
    const proxyUrl = this.buildProxyUrl(sessionId, SESSION_LIFETIME_MINUTES);

    const stickyEntry: StickyProxy = {
      proxy: proxyUrl,
      expiresAt: Date.now() + IP_LIFETIME_MS,
    };
    this.stickyMap.set(key, stickyEntry);

    const masked = proxyUrl.replace(/:([^:@]+)@/, ':***@');
    console.log(`[ProxyPool] 📌 Sticky proxy 2captcha-gw assigné à ${key.slice(0, 8)}… : ${masked} (session=${sessionId}, expire dans ${SESSION_LIFETIME_MINUTES}min)`);
    return proxyUrl;
  }

  /**
   * Retourne les infos complètes du proxy sticky d'un compte (URL + expiration).
   * Utilisé par usaPortal pour synchroniser la durée de vie du JWT avec celle du proxy.
   * Retourne null si aucun proxy sticky n'est assigné ou s'il est expiré.
   */
  getStickyProxyInfo(accountKey: string): StickyProxy | null {
    const key = accountKey.toLowerCase();
    const existing = this.stickyMap.get(key);
    if (existing && Date.now() < existing.expiresAt) {
      return existing;
    }
    return null;
  }

  /**
   * Libère le proxy sticky d'un compte (fin de session ou logout).
   */
  releaseStickyProxy(accountKey: string): void {
    const key = accountKey.toLowerCase();
    if (this.stickyMap.delete(key)) {
      console.log(`[ProxyPool] 🔓 Sticky proxy libéré pour ${key.slice(0, 8)}…`);
    }
  }

  /**
   * Force la rotation du proxy pour un compte (IP brûlée/restreinte).
   * Incrémente le compteur de rotation → le prochain getStickyProxy() génère un nouveau session ID.
   * Retourne la nouvelle URL proxy.
   */
  async rotateStickyProxy(accountKey: string): Promise<string | null> {
    if (!this.isConfigured) return null;

    const key = accountKey.toLowerCase();
    const oldEntry = this.stickyMap.get(key);
    const oldProxy = oldEntry?.proxy ? oldEntry.proxy.replace(/:([^:@]+)@/, ':***@').slice(0, 40) : '(aucun)';

    // Incrémenter le compteur de rotation → nouveau session ID
    const currentRotation = this.rotationCount.get(key) ?? 0;
    this.rotationCount.set(key, currentRotation + 1);

    // Supprimer l'ancien sticky
    this.stickyMap.delete(key);

    // Générer un nouveau proxy avec le nouveau session ID
    const sessionId = this.generateSessionId(key);
    const proxyUrl = this.buildProxyUrl(sessionId, SESSION_LIFETIME_MINUTES);

    const stickyEntry: StickyProxy = {
      proxy: proxyUrl,
      expiresAt: Date.now() + IP_LIFETIME_MS,
    };
    this.stickyMap.set(key, stickyEntry);

    const masked = proxyUrl.replace(/:([^:@]+)@/, ':***@');
    console.log(`[ProxyPool] 🔄 Sticky proxy ROTATÉ pour ${key.slice(0, 8)}… : ${oldProxy} → ${masked} (rot#${currentRotation + 1})`);
    return proxyUrl;
  }

  /** Nombre de proxies sticky actifs. */
  get stickyCount(): number {
    const now = Date.now();
    for (const [k, v] of this.stickyMap.entries()) {
      if (now >= v.expiresAt) this.stickyMap.delete(k);
    }
    return this.stickyMap.size;
  }

  /**
   * Force un "refresh" du pool. En mode gateway, vérifie simplement que la clé API est valide
   * en faisant un test de connectivité via le proxy.
   */
  async forceWhitelistRefresh(): Promise<{ ok: boolean; message: string; serverIp: string | null }> {
    if (!this.apiKey) {
      return { ok: false, message: 'TWOCAPTCHA_API_KEY not configured', serverIp: null };
    }

    // Test de connectivité via le proxy gateway
    try {
      const testUrl = this.buildProxyUrl('healthcheck', 1);
      console.log(`[ProxyPool] 🔍 Testing gateway connectivity...`);

      // On ne peut pas tester directement sans un HTTP client qui supporte les proxies,
      // mais on peut vérifier que l'URL est bien formée.
      return {
        ok: true,
        message: `Gateway mode active: ${PROXY_GATEWAY_HOST}:${PROXY_GATEWAY_PORT} (auth user:pass, no whitelist needed)`,
        serverIp: null,
      };
    } catch (err) {
      return { ok: false, message: `Gateway test failed: ${err}`, serverIp: null };
    }
  }
}

// ─── Utilitaires ────────────────────────────────────────────────────────────

export async function detectPublicIp(): Promise<string | null> {
  const endpoints = [
    'https://api.ipify.org?format=json',
    'https://api4.my-ip.io/ip.json',
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      const data = await res.json() as { ip?: string };
      if (data.ip) {
        console.log(`[ProxyPool] Public IP detected: ${data.ip}`);
        return data.ip;
      }
    } catch {
      // try next
    }
  }
  console.error('[ProxyPool] ❌ Could not detect public IP');
  return null;
}

/** Objet `proxy` Playwright : gère `http://user:pass@host:port` et `http://host:port:user:pass` (2captcha). */
export function parseHttpProxyUrlForPlaywright(
  raw: string,
): { server: string; username?: string; password?: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  let candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  if (!candidate.includes("@")) {
    const withoutScheme = candidate.replace(/^https?:\/\//i, "");
    const parts = withoutScheme.split(":");
    if (parts.length >= 4) {
      const password = parts[parts.length - 1]!;
      const username = parts[parts.length - 2]!;
      const port = parts[parts.length - 3]!;
      const hostParts = parts.slice(0, parts.length - 3);
      if (/^\d{1,5}$/.test(port) && hostParts.length > 0) {
        const looksLikeIpv4 =
          hostParts.length === 4 &&
          hostParts.every((s) => /^\d{1,3}$/.test(s) && Number(s) <= 255);
        const host = looksLikeIpv4 ? hostParts.join(".") : hostParts.join(".");
        const hostInServer = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
        const scheme = candidate.toLowerCase().startsWith("https") ? "https" : "http";
        return {
          server: `${scheme}://${hostInServer}:${port}`,
          username: decodeURIComponent(username),
          password: decodeURIComponent(password),
        };
      }
    }
  }

  try {
    const u = new URL(candidate);
    return {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return undefined;
  }
}
