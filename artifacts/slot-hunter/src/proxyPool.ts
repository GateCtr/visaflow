const REFRESH_MS        = 15 * 60_000;
const WHITELIST_RETRY_MS = 30 * 60_000;
const POOL_SIZE          = 100;
const IP_LIFETIME_MS     = 30 * 60_000;

export interface PoolState {
  size: number;
  lastRefreshAt: string | null;
  serverIp: string | null;
  whitelistError: boolean;
  whitelistErrorAt: string | null;
  mode: '2captcha' | 'unconfigured';
  stickyCount: number;
}

/** Proxy assigné de manière sticky à un compte — même IP pendant toute la durée du JWT. */
export interface StickyProxy {
  proxy: string;
  /** Timestamp d'expiration de l'IP résidentielle (lifetime 2captcha = 30 min). */
  expiresAt: number;
}

export class ProxyPool {
  private pool: string[] = [];
  private lastRefresh  = 0;
  private serverIp: string | null = null;
  private whitelistError = false;
  private whitelistErrorAt: number | null = null;
  private readonly apiKey: string;
  /** Map account → sticky proxy (même IP pendant toute la session JWT). */
  private stickyMap = new Map<string, StickyProxy>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.serverIp !== null;
  }

  async initialize(ip: string): Promise<void> {
    this.serverIp = ip;
    console.log(`[ProxyPool] Server IP set: ${ip}`);
    await this.refresh();
    this.startAutoRefresh();
  }

  /** @deprecated Use initialize() instead */
  setServerIp(ip: string): void {
    this.serverIp = ip;
  }

  private startAutoRefresh(): void {
    const timer = setInterval(() => {
      console.log('[ProxyPool] ⏱ Auto-refresh triggered (15 min interval)');
      this.refresh().catch(err => {
        console.error('[ProxyPool] Auto-refresh error:', err);
      });
    }, REFRESH_MS);
    timer.unref();
    console.log('[ProxyPool] 🔄 Auto-refresh loop started (every 15 min)');
  }

  getState(): PoolState {
    return {
      size: this.pool.length,
      lastRefreshAt: this.lastRefresh > 0
        ? new Date(this.lastRefresh).toISOString()
        : null,
      serverIp: this.serverIp,
      whitelistError: this.whitelistError,
      whitelistErrorAt: this.whitelistErrorAt !== null
        ? new Date(this.whitelistErrorAt).toISOString()
        : null,
      mode: this.apiKey.length > 0 ? '2captcha' : 'unconfigured',
      stickyCount: this.stickyCount,
    };
  }

  async getProxy(): Promise<{ proxy: string; expiresAt: string } | null> {
    if (!this.isConfigured) return null;

    if (this.whitelistError) {
      if (
        this.whitelistErrorAt !== null &&
        Date.now() - this.whitelistErrorAt > WHITELIST_RETRY_MS
      ) {
        console.log('[ProxyPool] 30 min elapsed since whitelist error — retrying...');
        this.whitelistError = false;
        this.whitelistErrorAt = null;
        this.pool = [];
      } else {
        return null;
      }
    }

    if (this.pool.length < 5 || Date.now() - this.lastRefresh > REFRESH_MS) {
      await this.refresh();
    }

    if (this.pool.length === 0) return null;

    const proxy = this.pool.shift()!;
    this.pool.push(proxy);

    // Vérifier si l'URL contient déjà le protocole
    let proxyUrl = proxy;
    if (!proxyUrl.startsWith('http://') && !proxyUrl.startsWith('https://')) {
      proxyUrl = `http://${proxyUrl}`;
    }

    const expiresAt = new Date(this.lastRefresh + IP_LIFETIME_MS).toISOString();
    return { proxy: proxyUrl, expiresAt };
  }

  /**
   * Obtient un proxy sticky pour un compte donné (portail USA).
   * 
   * Le serveur USA lie le JWT à l'IP du login → il faut garder la MÊME IP
   * pendant toute la durée du token (10 min max dans notre config).
   * 
   * Comportement :
   *  - Si le compte a déjà un proxy sticky non expiré → le réutilise.
   *  - Sinon → en assigne un nouveau depuis le pool (round-robin) et le mémorise.
   *  - Si le pool est vide ou non configuré → retourne null (fallback Railway direct).
   * 
   * @param accountKey  Identifiant unique du compte (email lowercase).
   */
  async getStickyProxy(accountKey: string): Promise<string | null> {
    const key = accountKey.toLowerCase();

    // Vérifier si un proxy sticky existe et est encore valide
    const existing = this.stickyMap.get(key);
    if (existing && Date.now() < existing.expiresAt) {
      return existing.proxy;
    }

    // Proxy expiré ou inexistant → en assigner un nouveau
    const result = await this.getProxy();
    if (!result) return null;

    const stickyEntry: StickyProxy = {
      proxy: result.proxy,
      expiresAt: Date.now() + IP_LIFETIME_MS,
    };
    this.stickyMap.set(key, stickyEntry);
    console.log(`[ProxyPool] 📌 Sticky proxy assigné à ${key.slice(0, 8)}… : ${result.proxy} (expire dans ${IP_LIFETIME_MS / 60_000} min)`);
    return result.proxy;
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
   * L'IP retourne dans la rotation générale au prochain refresh.
   */
  releaseStickyProxy(accountKey: string): void {
    const key = accountKey.toLowerCase();
    if (this.stickyMap.delete(key)) {
      console.log(`[ProxyPool] 🔓 Sticky proxy libéré pour ${key.slice(0, 8)}…`);
    }
  }

  /**
   * Force la rotation du proxy pour un compte (IP brûlée/restreinte).
   * Supprime l'ancien sticky et assigne immédiatement une nouvelle IP depuis le pool.
   * Retourne la nouvelle URL proxy ou null si le pool est vide.
   */
  async rotateStickyProxy(accountKey: string): Promise<string | null> {
    const key = accountKey.toLowerCase();
    const oldEntry = this.stickyMap.get(key);
    const oldProxy = oldEntry?.proxy ?? "(aucun)";
    this.stickyMap.delete(key);
    
    // Assigner un nouveau proxy (différent de l'ancien si possible)
    const result = await this.getProxy();
    if (!result) {
      console.warn(`[ProxyPool] 🔄 Rotation demandée pour ${key.slice(0, 8)}… mais pool vide`);
      return null;
    }

    // Si le pool est petit, on pourrait retomber sur la même IP — on essaie 3 fois
    let newProxy = result.proxy;
    if (newProxy === oldProxy && this.pool.length > 1) {
      for (let i = 0; i < 3; i++) {
        const retry = await this.getProxy();
        if (retry && retry.proxy !== oldProxy) {
          newProxy = retry.proxy;
          break;
        }
      }
    }

    const stickyEntry: StickyProxy = {
      proxy: newProxy,
      expiresAt: Date.now() + IP_LIFETIME_MS,
    };
    this.stickyMap.set(key, stickyEntry);
    console.log(`[ProxyPool] 🔄 Sticky proxy ROTATÉ pour ${key.slice(0, 8)}… : ${oldProxy.slice(0, 20)}… → ${newProxy.slice(0, 20)}…`);
    return newProxy;
  }

  /** Nombre de proxies sticky actifs. */
  get stickyCount(): number {
    // Nettoyer les entrées expirées
    const now = Date.now();
    for (const [k, v] of this.stickyMap.entries()) {
      if (now >= v.expiresAt) this.stickyMap.delete(k);
    }
    return this.stickyMap.size;
  }

  async forceWhitelistRefresh(): Promise<{ ok: boolean; message: string; serverIp: string | null }> {
    if (!this.apiKey) {
      return { ok: false, message: 'TWOCAPTCHA_API_KEY not configured', serverIp: null };
    }
    if (!this.serverIp) {
      return { ok: false, message: 'Server IP not yet detected — wait for startup to complete', serverIp: null };
    }
    this.whitelistError = false;
    this.whitelistErrorAt = null;
    this.pool = [];
    await this.refresh();
    return {
      ok: !this.whitelistError,
      message: this.whitelistError
        ? `IP ${this.serverIp} not whitelisted in 2captcha — add it at 2captcha.com/proxy`
        : `Pool refreshed: ${this.pool.length} IPs loaded`,
      serverIp: this.serverIp,
    };
  }

  private async refresh(): Promise<void> {
    const key = this.apiKey;
    const ip  = this.serverIp!;
    // 2captcha proxy API — utilise le paramètre `ip` pour whitelister l'IP serveur.
    // Certaines versions de l'API attendent aussi `server_ip` — on envoie les deux pour compatibilité.
    // country=cd → IPs résidentielles du Congo (RDC) exclusivement.
    // Les comptes USA visa sont basés à Kinshasa — des connexions depuis un pays africain cohérent
    // sont beaucoup plus crédibles que des IPs aléatoires de pays différents (mode mixte par défaut).
    const url =
      `https://api.2captcha.com/proxy/generate_white_list_connections` +
      `?key=${key}&protocol=http&connection_count=${POOL_SIZE}&country=cd&ip=${encodeURIComponent(ip)}&server_ip=${encodeURIComponent(ip)}`;

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const json = await res.json() as {
        status: string;
        message?: string;
        request?: string;
        data?: string[];
      };

      if (json.status === 'OK' && Array.isArray(json.data) && json.data.length > 0) {
        this.pool = [...json.data].sort(() => Math.random() - 0.5);
        this.lastRefresh = Date.now();
        this.whitelistError = false;
        console.log(`[ProxyPool] ✅ ${this.pool.length} residential IPs loaded from 2captcha (pool target: ${POOL_SIZE})`);
      } else if (
        json.request?.includes('IP_NOT_WHITELISTED') ||
        json.request?.includes('NOT_WHITELISTED') ||
        json.status === 'ERROR_MISSING_IP' ||
        json.status === 'ERROR_IP_NOT_WHITELISTED'
      ) {
        this.whitelistError = true;
        this.whitelistErrorAt = Date.now();
        console.error(`[ProxyPool] ❌ IP ${ip} not whitelisted or missing in 2captcha (status: ${json.status})`);
        console.error(`[ProxyPool] → Go to 2captcha.com/proxy → "IP whitelist" → Add: ${ip}`);
      } else {
        console.error(`[ProxyPool] ❌ Refresh failed: ${JSON.stringify(json)}`);
      }
    } catch (err) {
      console.error(`[ProxyPool] ❌ Network error during refresh: ${err}`);
    }
  }
}

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
  console.error('[ProxyPool] ❌ Could not detect public IP — proxy pool disabled');
  return null;
}
