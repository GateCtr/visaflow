import type { CaptchaProvider, SolveRequest, ProviderSolveResult } from '../types.js';

const API_BASE = 'https://api.2captcha.com';
const POLL_INTERVAL = 5_000;
const MAX_POLLS = 36;

export class TwoCaptchaProvider implements CaptchaProvider {
  readonly name = '2captcha' as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  async getBalance(): Promise<number | null> {
    try {
      const res = await fetch(`${API_BASE}/getBalance`, {
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
    const taskId = await this.createTask(req);
    if (!taskId) return null;
    const token = await this.pollResult(taskId);
    if (!token) return null;
    return { token, taskId };
  }

  private async createTask(req: SolveRequest): Promise<string | null> {
    const task = this.buildTask(req);
    if (!task) return null;

    try {
      const res = await fetch(`${API_BASE}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, task }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json() as { errorId: number; taskId?: number; errorCode?: string };
      if (data.errorId !== 0 || !data.taskId) {
        console.error(`[2captcha] createTask failed: ${data.errorCode ?? data.errorId}`);
        return null;
      }
      return String(data.taskId);
    } catch (err) {
      console.error(`[2captcha] createTask error: ${err}`);
      return null;
    }
  }

  private buildTask(req: SolveRequest): Record<string, unknown> | null {
    const base = { websiteURL: req.pageUrl, websiteKey: req.sitekey };
    switch (req.type) {
      case 'recaptcha_v2':
        return { type: 'RecaptchaV2TaskProxyless', ...base };
      case 'recaptcha_v3':
        return { type: 'RecaptchaV3TaskProxyless', ...base, pageAction: req.pageAction ?? 'verify', minScore: 0.7 };
      case 'hcaptcha':
        return { type: 'HCaptchaTaskProxyless', ...base };
      case 'turnstile':
        return { type: 'TurnstileTaskProxyless', ...base };
      default:
        console.error(`[2captcha] unsupported type: ${req.type as string}`);
        return null;
    }
  }

  private async pollResult(taskId: string): Promise<string | null> {
    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      try {
        const res = await fetch(`${API_BASE}/getTaskResult`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: this.apiKey, taskId: Number(taskId) }),
          signal: AbortSignal.timeout(10_000),
        });
        const data = await res.json() as {
          errorId: number;
          status: string;
          solution?: { gRecaptchaResponse?: string; token?: string };
          errorCode?: string;
        };
        if (data.errorId !== 0) {
          console.error(`[2captcha] poll error: ${data.errorCode ?? data.errorId}`);
          return null;
        }
        if (data.status === 'ready') {
          const token = data.solution?.gRecaptchaResponse ?? data.solution?.token ?? null;
          if (token) console.log(`[2captcha] solved (attempt ${i + 1}, len=${token.length})`);
          return token ?? null;
        }
        console.log(`[2captcha] poll #${i + 1} — processing`);
      } catch (err) {
        console.warn(`[2captcha] poll #${i + 1} network error: ${err}`);
      }
    }
    console.error('[2captcha] timeout');
    return null;
  }
}

export function makeTwoCaptcha(): TwoCaptchaProvider | null {
  const key = process.env.TWOCAPTCHA_API_KEY ?? '';
  if (!key) return null;
  return new TwoCaptchaProvider(key);
}
