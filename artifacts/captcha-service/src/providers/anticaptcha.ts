import type { CaptchaProvider, SolveRequest, ProviderSolveResult } from '../types.js';

const BASE = 'https://api.anti-captcha.com';
const POLL_INTERVAL = 5_000;
const MAX_POLLS = 36;

export class AntiCaptchaProvider implements CaptchaProvider {
  readonly name = 'anticaptcha' as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async getBalance(): Promise<number | null> {
    try {
      const res = await fetch(`${BASE}/getBalance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json() as { errorId: number; balance?: number };
      if (data.errorId !== 0 || data.balance === undefined) return null;
      return data.balance;
    } catch {
      return null;
    }
  }

  async solve(req: SolveRequest): Promise<ProviderSolveResult | null> {
    const task = this.buildTask(req);
    if (!task) return null;

    let taskId: number;
    try {
      const res = await fetch(`${BASE}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, task }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json() as { errorId: number; taskId?: number; errorCode?: string };
      if (data.errorId !== 0 || !data.taskId) {
        console.error(`[anticaptcha] createTask failed: ${data.errorCode ?? data.errorId}`);
        return null;
      }
      taskId = data.taskId;
      console.log(`[anticaptcha] task created: ${taskId}`);
    } catch (err) {
      console.error(`[anticaptcha] createTask error: ${err}`);
      return null;
    }

    const token = await this.pollResult(taskId);
    if (!token) return null;
    return { token, taskId: String(taskId) };
  }

  private buildTask(req: SolveRequest): Record<string, unknown> | null {
    const base = { websiteURL: req.pageUrl, websiteKey: req.sitekey };
    switch (req.type) {
      case 'recaptcha_v2':
        return { type: 'RecaptchaV2TaskProxyless', ...base };
      case 'recaptcha_v3':
        return { type: 'RecaptchaV3TaskProxyless', ...base, minScore: 0.7, pageAction: req.pageAction ?? 'verify' };
      case 'hcaptcha':
        return { type: 'HCaptchaTaskProxyless', ...base };
      case 'turnstile':
        return { type: 'TurnstileProxyless', ...base };
      default:
        console.error(`[anticaptcha] unsupported type: ${req.type as string}`);
        return null;
    }
  }

  private async pollResult(taskId: number): Promise<string | null> {
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const res = await fetch(`${BASE}/getTaskResult`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, taskId }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as {
          errorId: number;
          status: 'processing' | 'ready';
          solution?: { gRecaptchaResponse?: string; token?: string };
          errorCode?: string;
        };
        if (data.errorId !== 0) {
          console.error(`[anticaptcha] poll error: ${data.errorCode ?? data.errorId}`);
          return null;
        }
        if (data.status === 'ready') {
          const token = data.solution?.gRecaptchaResponse ?? data.solution?.token ?? null;
          if (token) console.log(`[anticaptcha] solved (attempt ${i + 1}, len=${token.length})`);
          return token ?? null;
        }
        console.log(`[anticaptcha] poll #${i + 1} — processing`);
      } catch (err) {
        console.warn(`[anticaptcha] poll #${i + 1} network error: ${err}`);
      }
    }
    console.error('[anticaptcha] timeout');
    return null;
  }
}

export function makeAntiCaptcha(): AntiCaptchaProvider | null {
  const key = process.env.ANTICAPTCHA_API_KEY ?? '';
  if (!key) return null;
  return new AntiCaptchaProvider(key);
}
