import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { ProxyPool, detectPublicIp } from './pool.js';
import { getStaticProxy } from './sources/static.js';
import { getIProyalProxy, verifyIProyalProxy } from './sources/iproyal.js';
import { getBrightDataProxy, verifyBrightDataProxy } from './sources/brightdata.js';

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

  const brightdata = getBrightDataProxy();
  const iproyal    = getIProyalProxy();
  const staticSrc  = getStaticProxy();

  if (brightdata.isConfigured) {
    console.log(' ✅ BrightData proxy configured (BRIGHTDATA_PROXY_URL) — used for /proxy/get?source=brightdata');
    const check = await verifyBrightDataProxy();
    if (check.ok) {
      console.log(` ✅ BrightData verified — exit IP: ${check.ip}`);
    } else {
      console.warn(` ⚠️  BrightData verify failed at startup: ${check.error}`);
    }
  }

  if (iproyal.isConfigured) {
    console.log(' ✅ iProyal proxy configured (IPROYAL_PROXY_URL) — default residential');
    const check = await verifyIProyalProxy();
    if (check.ok) {
      console.log(` ✅ iProyal verified — exit IP: ${check.ip}`);
    } else {
      console.warn(` ⚠️  iProyal verify failed at startup: ${check.error}`);
    }
  } else if (TWOCAPTCHA_KEY) {
    pool = new ProxyPool(TWOCAPTCHA_KEY);
    const ip = await detectPublicIp();
    if (ip) {
      await pool.initialize(ip);
      console.log(' ✅ Mode: 2captcha residential proxy pool — initial load complete');
    } else {
      console.warn(' ⚠️  Mode: 2captcha key set but IP detection failed — pool disabled until next restart');
    }
  } else if (staticSrc.isConfigured) {
    console.log(' ✅ Mode: static proxy (PROXY_URL configured)');
  }

  if (!brightdata.isConfigured && !iproyal.isConfigured && !pool && !staticSrc.isConfigured) {
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
  const brightdata = getBrightDataProxy();
  const iproyal    = getIProyalProxy();
  const staticSrc  = getStaticProxy();
  res.json({
    status: 'ok',
    brightdata: brightdata.isConfigured,
    iproyal: iproyal.isConfigured,
    pool2captcha: pool?.isConfigured ?? false,
    staticProxy: staticSrc.isConfigured,
    timestamp: new Date().toISOString(),
  });
});

app.get('/proxy/get', authMiddleware, async (req: Request, res: Response) => {
  const type   = req.query['type'];
  const source = req.query['source'] as string | undefined;

  if (type !== undefined && type !== 'residential') {
    res.status(400).json({ error: `Unsupported proxy type: "${type}". Only "residential" is supported.` });
    return;
  }

  // Source explicite demandée : "brightdata" ou "iproyal"
  if (source === 'brightdata') {
    const bd = getBrightDataProxy();
    if (bd.isConfigured && bd.proxyUrl) {
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      res.json({ proxy: bd.proxyUrl, source: 'brightdata', expiresAt });
    } else {
      res.status(503).json({ proxy: null, source: 'brightdata', error: 'BRIGHTDATA_PROXY_URL not configured' });
    }
    return;
  }

  if (source === 'iproyal') {
    const ip = getIProyalProxy();
    if (ip.isConfigured && ip.proxyUrl) {
      const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
      res.json({ proxy: ip.proxyUrl, source: 'iproyal', expiresAt });
    } else {
      res.status(503).json({ proxy: null, source: 'iproyal', error: 'IPROYAL_PROXY_URL not configured' });
    }
    return;
  }

  // Sélection automatique — Priorité : iProyal > 2captcha > static
  const iproyal = getIProyalProxy();
  if (iproyal.isConfigured && iproyal.proxyUrl) {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    res.json({ proxy: iproyal.proxyUrl, source: 'iproyal', expiresAt });
    return;
  }

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
  const brightdata = getBrightDataProxy();
  const iproyal    = getIProyalProxy();
  const staticSrc  = getStaticProxy();
  res.json({
    brightdata: brightdata.isConfigured ? '[configured]' : null,
    iproyal: iproyal.isConfigured ? '[configured]' : null,
    staticProxy: staticSrc.proxyUrl,
    pool2captcha: pool ? pool.getState() : null,
  });
});

// Vérifier iProyal
app.post('/proxy/verify', authMiddleware, async (_req: Request, res: Response) => {
  const result = await verifyIProyalProxy();
  res.status(result.ok ? 200 : 502).json(result);
});

// Vérifier BrightData
app.post('/proxy/verify/brightdata', authMiddleware, async (_req: Request, res: Response) => {
  const result = await verifyBrightDataProxy();
  res.status(result.ok ? 200 : 502).json(result);
});

app.post('/proxy/whitelist', authMiddleware, async (_req: Request, res: Response) => {
  if (!pool) {
    res.status(400).json({ ok: false, error: 'TWOCAPTCHA_API_KEY not configured — pool unavailable' });
    return;
  }
  const freshIp = await detectPublicIp();
  if (freshIp) {
    pool.setServerIp(freshIp);
    console.log(`[whitelist] Re-detected public IP: ${freshIp}`);
  } else {
    console.warn('[whitelist] Could not re-detect public IP — using cached IP');
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
