import type { CaptchaProvider, CaptchaType, ProviderName, SolveRequest, SolveResult } from './types.js';

type RoutingTable = Record<CaptchaType, ProviderName[]>;

const DEFAULT_ROUTING: RoutingTable = {
  hcaptcha:     ['anticaptcha', 'capsolver', '2captcha'],
  recaptcha_v2: ['2captcha', 'anticaptcha', 'capsolver'],
  recaptcha_v3: ['2captcha', 'anticaptcha'],
  turnstile:    ['2captcha', 'anticaptcha'],
};

const PROVIDER_TIMEOUT_MS = 180_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export class CaptchaResolver {
  private providers: Map<ProviderName, CaptchaProvider>;

  constructor(providers: CaptchaProvider[]) {
    this.providers = new Map(providers.map(p => [p.name, p]));
  }

  getConfiguredProviders(): ProviderName[] {
    return [...this.providers.values()]
      .filter(p => p.isConfigured())
      .map(p => p.name);
  }

  async solve(req: SolveRequest): Promise<SolveResult> {
    const order = this.buildOrder(req);

    if (order.length === 0) {
      throw new Error('No captcha provider configured. Set TWOCAPTCHA_API_KEY, ANTICAPTCHA_API_KEY, or CAPSOLVER_API_KEY.');
    }

    const errors: string[] = [];

    for (const providerName of order) {
      const provider = this.providers.get(providerName);
      if (!provider?.isConfigured()) {
        console.log(`[resolver] ${providerName} not configured — skipping`);
        continue;
      }

      console.log(`[resolver] trying ${providerName} for ${req.type} (timeout ${PROVIDER_TIMEOUT_MS}ms)`);
      const start = Date.now();

      try {
        const result = await withTimeout(
          provider.solve(req),
          PROVIDER_TIMEOUT_MS,
          `${providerName}/${req.type}`,
        );
        if (result) {
          return {
            token: result.token,
            taskId: result.taskId,
            provider: providerName,
            durationMs: Date.now() - start,
          };
        }
        const msg = `${providerName} returned null`;
        errors.push(msg);
        console.warn(`[resolver] ${msg} — trying next provider`);
      } catch (err) {
        const msg = `${providerName} threw: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        console.error(`[resolver] ${msg} — trying next provider`);
      }
    }

    throw new Error(`All providers failed for ${req.type}: ${errors.join(' | ')}`);
  }

  private buildOrder(req: SolveRequest): ProviderName[] {
    if (req.provider) {
      const provider = this.providers.get(req.provider);
      if (!provider?.isConfigured()) {
        throw new Error(`Requested provider "${req.provider}" is not configured`);
      }
      return [req.provider];
    }
    return DEFAULT_ROUTING[req.type] ?? [];
  }
}
