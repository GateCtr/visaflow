const REFRESH_MS        = 25 * 60_000;
const WHITELIST_RETRY_MS = 30 * 60_000;
const POOL_SIZE          = 50;
const IP_LIFETIME_MS     = 30 * 60_000;

export interface PoolState {
  size: number;
  lastRefreshAt: string | null;
  serverIp: string | null;
  whitelistError: boolean;
  whitelistErrorAt: string | null;
  mode: '2captcha' | 'unconfigured';
}

export class ProxyPool {
  private pool: string[] = [];
  private lastRefresh  = 0;
  private serverIp: string | null = null;
  private whitelistError = false;
  private whitelistErrorAt: number | null = null;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get isConfigured(): boolean {
    return this.apiKey.length > 0 && this.serverIp !== null;
  }

  /** Called at startup after public IP detection */
  setServerIp(ip: string): void {
    this.serverIp = ip;
    console.log(`[ProxyPool] Server IP set: ${ip}`);
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

    const expiresAt = new Date(this.lastRefresh + IP_LIFETIME_MS).toISOString();
    return { proxy: `http://${proxy}`, expiresAt };
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
    const url =
      `https://api.2captcha.com/proxy/generate_white_list_connections` +
      `?key=${key}&protocol=http&connection_count=${POOL_SIZE}&ip=${encodeURIComponent(ip)}`;

    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const json = await res.json() as {
        status: string;
        request?: string;
        data?: string[];
      };

      if (json.status === 'OK' && Array.isArray(json.data) && json.data.length > 0) {
        this.pool = [...json.data].sort(() => Math.random() - 0.5);
        this.lastRefresh = Date.now();
        this.whitelistError = false;
        console.log(`[ProxyPool] ✅ ${this.pool.length} residential IPs loaded from 2captcha`);
      } else if (
        json.request?.includes('IP_NOT_WHITELISTED') ||
        json.request?.includes('NOT_WHITELISTED')
      ) {
        this.whitelistError = true;
        this.whitelistErrorAt = Date.now();
        console.error(`[ProxyPool] ❌ IP ${ip} not whitelisted in 2captcha`);
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
