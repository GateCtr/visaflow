import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { makeTwoCaptcha } from './providers/twocaptcha.js';
import { makeAntiCaptcha } from './providers/anticaptcha.js';
import { makeCapSolver } from './providers/capsolver.js';
import { CaptchaResolver } from './resolver.js';
import type { CaptchaType, ProviderName, SolveRequest } from './types.js';

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const SERVICE_API_KEY = process.env.CAPTCHA_SERVICE_API_KEY ?? '';

const CAPTCHA_TYPES: CaptchaType[] = ['recaptcha_v2', 'recaptcha_v3', 'hcaptcha', 'turnstile'];
const PROVIDER_NAMES: ProviderName[] = ['2captcha', 'anticaptcha', 'capsolver'];

function buildResolver(): CaptchaResolver {
  const providers = [
    makeTwoCaptcha(),
    makeAntiCaptcha(),
    makeCapSolver(),
  ].filter((p): p is NonNullable<typeof p> => p !== null);

  const resolver = new CaptchaResolver(providers);
  const configured = resolver.getConfiguredProviders();

  console.log('='.repeat(60));
  console.log(' Captcha Service starting');
  console.log('='.repeat(60));

  if (configured.length === 0) {
    console.error(' ❌ FATAL: No captcha providers configured!');
    console.error('    Set at least one of: TWOCAPTCHA_API_KEY, ANTICAPTCHA_API_KEY, CAPSOLVER_API_KEY');
    process.exit(1);
  }
  console.log(` ✅ Providers active: ${configured.join(', ')}`);

  if (!SERVICE_API_KEY) {
    console.error(' ❌ FATAL: CAPTCHA_SERVICE_API_KEY is not set');
    console.error('    All requests to /captcha/* will be rejected until this is configured.');
    console.error('    Set CAPTCHA_SERVICE_API_KEY to a secure random string.');
    process.exit(1);
  }
  console.log(' 🔒 Auth enabled (X-Api-Key required)');
  console.log(` Port: ${PORT}`);
  console.log('='.repeat(60));

  return resolver;
}

const resolver = buildResolver();

const app = express();
app.use(express.json());

function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'];
  if (key !== SERVICE_API_KEY) {
    res.status(401).json({ error: 'Unauthorized — invalid or missing X-Api-Key header' });
    return;
  }
  next();
}

app.get('/health', (_req: Request, res: Response) => {
  const configured = resolver.getConfiguredProviders();
  res.json({
    status: 'ok',
    providers: configured,
    timestamp: new Date().toISOString(),
  });
});

app.post('/captcha/solve', authMiddleware, async (req: Request, res: Response) => {
  const { type, sitekey, pageUrl, provider, pageAction } = req.body as Partial<SolveRequest>;

  if (!type || !sitekey || !pageUrl) {
    res.status(400).json({ error: 'Missing required fields: type, sitekey, pageUrl' });
    return;
  }

  if (!CAPTCHA_TYPES.includes(type)) {
    res.status(400).json({
      error: `Invalid type "${type}". Supported: ${CAPTCHA_TYPES.join(', ')}`,
    });
    return;
  }

  if (provider && !PROVIDER_NAMES.includes(provider)) {
    res.status(400).json({
      error: `Invalid provider "${provider}". Supported: ${PROVIDER_NAMES.join(', ')}`,
    });
    return;
  }

  const solveReq: SolveRequest = { type, sitekey, pageUrl, provider, pageAction };
  const tag = `[${type}] ${sitekey.slice(0, 8)}... @ ${pageUrl.slice(0, 50)}`;
  console.log(`[solve] ${tag}`);

  try {
    const result = await resolver.solve(solveReq);
    console.log(`[solve] ✅ ${tag} → ${result.provider} (${result.taskId}) in ${result.durationMs}ms`);
    res.json({
      token: result.token,
      provider: result.provider,
      durationMs: result.durationMs,
      taskId: result.taskId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[solve] ❌ ${tag} — ${message}`);
    res.status(500).json({ error: message });
  }
});

app.get('/captcha/balance', authMiddleware, async (_req: Request, res: Response) => {
  const providers = [makeTwoCaptcha(), makeAntiCaptcha(), makeCapSolver()]
    .filter((p): p is NonNullable<typeof p> => p !== null && p.isConfigured());

  const results = await Promise.allSettled(
    providers.map(async p => ({
      provider: p.name,
      balance: await p.getBalance(),
      currency: 'USD',
    }))
  );

  const balances = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      provider: providers[i].name,
      balance: null,
      currency: 'USD',
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });

  res.json({ balances });
});

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Captcha Service listening on port ${PORT}`);
});
