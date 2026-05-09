export type CaptchaType = 'recaptcha_v2' | 'recaptcha_v3' | 'hcaptcha' | 'turnstile';
export type ProviderName = '2captcha' | 'anticaptcha' | 'capsolver';

export interface SolveRequest {
  type: CaptchaType;
  sitekey: string;
  pageUrl: string;
  provider?: ProviderName;
  pageAction?: string;
}

export interface SolveResult {
  token: string;
  provider: ProviderName;
  durationMs: number;
  taskId: string;
}

export interface BalanceResult {
  provider: ProviderName;
  balance: number | null;
  currency: string;
  error?: string;
}

export interface CaptchaProvider {
  name: ProviderName;
  isConfigured(): boolean;
  solve(req: SolveRequest): Promise<string | null>;
  getBalance(): Promise<number | null>;
}
