/**
 * cev-hcaptcha.ts — Solver hCaptcha unifié pour CEV
 *
 * Supporte :
 *   - HCaptchaTask (AVEC proxy) — même IP que la session Puppeteer
 *   - HCaptchaTaskProxyless     — mode no-proxy (cev_use_proxy=0)
 *
 * IMPORTANT : CapSolver est blacklisté pour les sitekeys CEV depuis 2026-04.
 * Utiliser UNIQUEMENT Anti-Captcha via ANTICAPTCHA_API_KEY.
 */

import { resolveAnticaptchaKey } from "./cevHttpSetup.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HCaptchaProxyParams {
  type?: "HTTP" | "HTTPS" | "SOCKS4" | "SOCKS5";
  address: string;
  port: number;
  login?: string;
  password?: string;
}

export interface SolveHcaptchaParams {
  sitekey: string;
  siteUrl: string;
  /** Proxy à utiliser (même IP que la session Puppeteer pour éviter IP jump) */
  proxy?: HCaptchaProxyParams;
  /** Timeout total en ms (défaut: 120s) */
  timeoutMs?: number;
  /** Prefix pour les logs */
  logPrefix?: string;
}

// ─── Anti-Captcha API types ───────────────────────────────────────────────────

interface AcCreateResponse {
  errorId: number;
  errorCode?: string;
  taskId?: number;
}

interface AcResultResponse {
  errorId: number;
  errorCode?: string;
  status: "processing" | "ready";
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
}

// ─── Solver principal ─────────────────────────────────────────────────────────

/**
 * Résout un hCaptcha via Anti-Captcha.
 * Utilise HCaptchaTask (avec proxy) ou HCaptchaTaskProxyless selon la config.
 */
export async function solveHcaptchaWithProxy(
  params: SolveHcaptchaParams,
): Promise<string> {
  const {
    sitekey,
    siteUrl,
    proxy,
    timeoutMs = 120_000,
    logPrefix = "[CEV-HCAPTCHA]",
  } = params;

  const apiKey = await resolveAnticaptchaKey();
  if (!apiKey) {
    throw new Error(
      "Anti-Captcha API key non configurée (ANTICAPTCHA_API_KEY manquant)",
    );
  }

  // Choisir le type de tâche selon la présence d'un proxy
  const taskBody: Record<string, unknown> = proxy
    ? {
        type: "HCaptchaTask",
        websiteURL: siteUrl,
        websiteKey: sitekey,
        proxyType: proxy.type ?? "HTTP",
        proxyAddress: proxy.address,
        proxyPort: proxy.port,
        ...(proxy.login ? { proxyLogin: proxy.login } : {}),
        ...(proxy.password ? { proxyPassword: proxy.password } : {}),
      }
    : {
        type: "HCaptchaTaskProxyless",
        websiteURL: siteUrl,
        websiteKey: sitekey,
      };

  const taskTypeName = proxy ? "HCaptchaTask" : "HCaptchaTaskProxyless";
  console.log(
    `${logPrefix} 🔒 Création tâche ${taskTypeName} | sitekey=${sitekey.slice(0, 8)}… | url=${siteUrl.slice(0, 50)}`,
  );

  // ── Créer la tâche ──────────────────────────────────────────────────────────
  let createData: AcCreateResponse;
  try {
    const createResp = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey, task: taskBody }),
      signal: AbortSignal.timeout(30_000),
    });
    createData = (await createResp.json()) as AcCreateResponse;
  } catch (err) {
    throw new Error(
      `Anti-Captcha createTask réseau échoué: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (createData.errorId !== 0) {
    throw new Error(
      `Anti-Captcha createTask failed: ${createData.errorCode ?? "UNKNOWN_ERROR"} (errorId=${createData.errorId})`,
    );
  }

  const taskId = createData.taskId!;
  console.log(`${logPrefix} 📋 Tâche créée: taskId=${taskId}`);

  // ── Polling résultat ────────────────────────────────────────────────────────
  const deadline = Date.now() + timeoutMs;
  let pollCount = 0;

  while (Date.now() < deadline) {
    // Délai entre polls : 5s (Anti-Captcha recommande de ne pas poller avant 5s)
    const waitMs = pollCount === 0 ? 8_000 : 5_000;
    await new Promise((r) => setTimeout(r, waitMs));
    pollCount++;

    let result: AcResultResponse;
    try {
      const resultResp = await fetch(
        "https://api.anti-captcha.com/getTaskResult",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: apiKey, taskId }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      result = (await resultResp.json()) as AcResultResponse;
    } catch (err) {
      console.warn(
        `${logPrefix} ⚠️ Poll réseau échoué (tentative ${pollCount}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (result.errorId !== 0) {
      throw new Error(
        `Anti-Captcha task error: ${result.errorCode ?? "UNKNOWN"} (errorId=${result.errorId})`,
      );
    }

    if (result.status === "ready") {
      const token =
        result.solution?.gRecaptchaResponse ?? result.solution?.token;
      if (!token) {
        throw new Error(
          "Anti-Captcha retourné status=ready mais token vide (solution manquante)",
        );
      }
      const remainingSec = Math.round((deadline - Date.now()) / 1000);
      console.log(
        `${logPrefix} ✅ hCaptcha résolu en ${Math.round((timeoutMs - remainingSec * 1000) / 1000)}s | token: ${token.slice(0, 20)}…`,
      );
      return token;
    }

    // Status "processing" — continuer à attendre
    const remainingSec = Math.round((deadline - Date.now()) / 1000);
    if (pollCount % 4 === 0) {
      console.log(
        `${logPrefix} ⏳ En cours… (${remainingSec}s restantes, poll #${pollCount})`,
      );
    }
  }

  throw new Error(
    `Anti-Captcha timeout après ${timeoutMs}ms (taskId=${taskId})`,
  );
}

/**
 * Parse une URL proxy (http://user:pass@host:port) vers les params Anti-Captcha.
 */
export function parseProxyForAnticaptcha(
  proxyUrl: string,
): HCaptchaProxyParams | null {
  try {
    const parsed = new URL(
      proxyUrl.startsWith("http") ? proxyUrl : `http://${proxyUrl}`,
    );
    return {
      type: "HTTP",
      address: parsed.hostname,
      port: parseInt(parsed.port || "3128", 10),
      login: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password
        ? decodeURIComponent(parsed.password)
        : undefined,
    };
  } catch {
    console.warn(`[CEV-HCAPTCHA] ⚠️ Impossible de parser URL proxy: ${proxyUrl.slice(0, 40)}…`);
    return null;
  }
}
