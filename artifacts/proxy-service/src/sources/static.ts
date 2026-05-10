export interface StaticProxySource {
  isConfigured: boolean;
  proxyUrl: string | null;
}

export function getStaticProxy(): StaticProxySource {
  const url = process.env.PROXY_URL ?? '';
  if (!url) {
    return { isConfigured: false, proxyUrl: null };
  }
  return { isConfigured: true, proxyUrl: url };
}
