import type { CaptchaProvider, SolveRequest, ProviderSolveResult } from '../types.js';

const BASE = 'https://api.capsolver.com';
const POLL_INTERVAL = 5_000;
const MAX_POLLS = 36;

export class CapSolverProvider implements CaptchaProvider {
  readonly name = 'capsolver' as const;
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

    let taskId: string;
    try {
      const res = await fetch(`${BASE}/createTask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: this.apiKey, task }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await res.json() as { errorId: number; taskId?: string; errorCode?: string; errorDescription?: string };
      if (data.errorId !== 0 || !data.taskId) {
        console.error(`[capsolver] createTask failed: ${data.errorCode ?? data.errorId} — ${data.errorDescription ?? ''}`);
        return null;
      }
      taskId = data.taskId;
      console.log(`[capsolver] task created: ${taskId}`);
    } catch (err) {
      console.error(`[capsolver] createTask error: ${err}`);
      return null;
    }

    const token = await this.pollResult(taskId);
    if (!token) return null;
    return { token, taskId };
  }

  private buildTask(req: SolveRequest): Record<string, unknown> | null {
    const base = { websiteURL: req.pageUrl, websiteKey: req.sitekey };
    switch (req.type) {
      case 'recaptcha_v2':
        return { type: 'ReCaptchaV2TaskProxyLess', ...base };
      case 'recaptcha_v3':
        return { type: 'ReCaptchaV3TaskProxyLess', ...base, pageAction: req.pageAction ?? 'verify' };
      case 'hcaptcha':
        return { type: 'HCaptchaTaskProxyLess', ...base, isEnterprise: true };
      case 'turnstile':
        return { type: 'AntiTurnstileTaskProxyLess', ...base };
      default:
        console.error(`[capsolver] unsupported type: ${req.type as string}`);
        return null;
    }
  }

  private async pollResult(taskId: string): Promise<string | null> {
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
          status: string;
          solution?: { gRecaptchaResponse?: string; token?: string };
          errorCode?: string;
        };
        if (data.errorId !== 0) {
          console.error(`[capsolver] poll error: ${data.errorCode ?? data.errorId}`);
          return null;
        }
        if (data.status === 'ready') {
          const token = data.solution?.gRecaptchaResponse ?? data.solution?.token ?? null;
          if (token) console.log(`[capsolver] solved (attempt ${i + 1}, len=${token.length})`);
          return token ?? null;
        }
        console.log(`[capsolver] poll #${i + 1} — processing`);
      } catch (err) {
        console.warn(`[capsolver] poll #${i + 1} network error: ${err}`);
      }
    }
    console.error('[capsolver] timeout');
    return null;
  }
}

export function makeCapSolver(): CapSolverProvider | null {
  const key = process.env.CAPSOLVER_API_KEY ?? '';
  if (!key) return null;
  return new CapSolverProvider(key);
}
