import { ProxyAgent } from 'undici';

const VERIFY_URL = 'https://ipv4.icanhazip.com';
const VERIFY_TIMEOUT_MS = 10_000;

export interface IProyalSource {
  isConfigured: boolean;
  proxyUrl: string | null;
}

export function getIProyalProxy(): IProyalSource {
  const url = process.env.IPROYAL_PROXY_URL ?? '';
  if (!url) {
    return { isConfigured: false, proxyUrl: null };
  }
  return { isConfigured: true, proxyUrl: url };
}

export async function verifyIProyalProxy(): Promise<{
  ok: boolean;
  ip: string | null;
  proxyUrl: string | null;
  error?: string;
}> {
  const src = getIProyalProxy();
  if (!src.isConfigured || !src.proxyUrl) {
    return { ok: false, ip: null, proxyUrl: null, error: 'IPROYAL_PROXY_URL not configured' };
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
    console.log(`[iProyal] ✅ Proxy verified — exit IP: ${ip}`);
    return { ok: true, ip, proxyUrl: src.proxyUrl };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[iProyal] ❌ Verify failed: ${msg}`);
    return { ok: false, ip: null, proxyUrl: src.proxyUrl, error: msg };
  } finally {
    await client.close();
  }
}
