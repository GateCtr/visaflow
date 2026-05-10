import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ProxyPool, detectPublicIp } from './pool.js';
import { getStaticProxy } from './sources/static.js';

const PORT             = parseInt(process.env.PORT ?? '3200', 10);
const SERVICE_API_KEY  = process.env.PROXY_SERVICE_API_KEY ?? '';
const TWOCAPTCHA_KEY   = process.env.TWOCAPTCHA_API_KEY ?? '';

let pool: ProxyPool | null = null;

async function init(): Promise<void> {
  console.log('='.repeat(60));
  console.log(' Proxy Service starting');
  console.log('='.repeat(60));

  if (!SERVICE_API_KEY) {
    console.error(' ❌ FATAL: PROXY_SERVICE_API_KEY is not set');
    console.error('    Set PROXY_SERVICE_API_KEY to a secure random string.');
    process.exit(1);
  }
  console.log(' 🔒 Auth enabled (X-Api-Key required)');

  const staticSrc = getStaticProxy();

  if (TWOCAPTCHA_KEY) {
    pool = new ProxyPool(TWOCAPTCHA_KEY);
    const ip = await detectPublicIp();
    if (ip) {
      pool.setServerIp(ip);
      console.log(' ✅ Mode: 2captcha residential proxy pool');
    } else {
      console.warn(' ⚠️  Mode: 2captcha key set but IP detection failed — pool disabled until next restart');
    }
  } else if (staticSrc.isConfigured) {
    console.log(` ✅ Mode: static proxy (${staticSrc.proxyUrl})`);
  } else {
    console.warn(' ⚠️  Mode: no proxy configured — /proxy/get will return source="none"');
  }

  console.log(` Port: ${PORT}`);
  console.log('='.repeat(60));
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (key !== SERVICE_API_KEY) {
    res.status(401).json({ error: 'Unauthorized — invalid or missing X-Api-Key header' });
    return;
  }
  next();
}

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  const staticSrc = getStaticProxy();
  res.json({
    status: 'ok',
    mode: pool?.isConfigured
      ? '2captcha'
      : staticSrc.isConfigured
        ? 'static'
        : 'none',
    timestamp: new Date().toISOString(),
  });
});

app.get('/proxy/get', authMiddleware, async (_req: Request, res: Response) => {
  if (pool?.isConfigured) {
    const result = await pool.getProxy();
    if (result) {
      res.json({ proxy: result.proxy, source: '2captcha', expiresAt: result.expiresAt });
      return;
    }
    console.warn('[proxy/get] 2captcha pool returned null — trying static fallback');
  }

  const staticSrc = getStaticProxy();
  if (staticSrc.isConfigured && staticSrc.proxyUrl) {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    res.json({ proxy: staticSrc.proxyUrl, source: 'static', expiresAt });
    return;
  }

  res.json({ proxy: null, source: 'none', expiresAt: null });
});

app.get('/proxy/pool', authMiddleware, (_req: Request, res: Response) => {
  const staticSrc = getStaticProxy();
  if (!pool) {
    res.json({
      mode: staticSrc.isConfigured ? 'static' : 'none',
      staticProxy: staticSrc.proxyUrl,
      pool: null,
    });
    return;
  }
  res.json({
    mode: pool.isConfigured ? '2captcha' : 'unconfigured',
    staticProxy: staticSrc.proxyUrl,
    pool: pool.getState(),
  });
});

app.post('/proxy/whitelist', authMiddleware, async (_req: Request, res: Response) => {
  if (!pool) {
    res.status(400).json({ ok: false, error: 'TWOCAPTCHA_API_KEY not configured — pool unavailable' });
    return;
  }
  const result = await pool.forceWhitelistRefresh();
  res.status(result.ok ? 200 : 500).json(result);
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

init().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Proxy Service listening on port ${PORT}`);
  });
}).catch(err => {
  console.error('Fatal init error:', err);
  process.exit(1);
});
