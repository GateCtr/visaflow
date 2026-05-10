import { ProxyAgent } from 'undici';

const VERIFY_URL = 'https://ipv4.icanhazip.com';
const VERIFY_TIMEOUT_MS = 12_000;

export interface BrightDataSource {
  isConfigured: boolean;
  proxyUrl: string | null;
}

export function getBrightDataProxy(): BrightDataSource {
  const url = process.env.BRIGHTDATA_PROXY_URL ?? '';
  if (!url) {
    return { isConfigured: false, proxyUrl: null };
  }
  return { isConfigured: true, proxyUrl: url };
}

export async function verifyBrightDataProxy(): Promise<{
  ok: boolean;
  ip: string | null;
  proxyUrl: string | null;
  error?: string;
}> {
  const src = getBrightDataProxy();
  if (!src.isConfigured || !src.proxyUrl) {
    return { ok: false, ip: null, proxyUrl: null, error: 'BRIGHTDATA_PROXY_URL not configured' };
  }

  const client = new ProxyAgent(src.proxyUrl);
  try {
    const res = await fetch(VERIFY_URL, {
      dispatcher: client,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    } as RequestInit & { dispatcher: ProxyAgent });

    if (!res.ok) {
      return { ok: false, ip: null, proxyUrl: src.proxyUrl, error: `HTTP ${res.status}` };
    }

    const ip = (await res.text()).trim();
    console.log(`[BrightData] ✅ Proxy verified — exit IP: ${ip}`);
    return { ok: true, ip, proxyUrl: src.proxyUrl };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BrightData] ❌ Verify failed: ${msg}`);
    return { ok: false, ip: null, proxyUrl: src.proxyUrl, error: msg };
  } finally {
    await client.close();
  }
}
