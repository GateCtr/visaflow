/**
 * jsd-solver.ts — Cloudflare JavaScript Detection (JSD) solver
 * 
 * JSD (JavaScript Detection) is Cloudflare's invisible challenge that works by:
 * 1. Extracting __CF$cv$params (r, t, m, s parameters) from HTML
 * 2. Fetching /cdn-cgi/challenge-platform/scripts/jsd/main.js to get nonce
 * 3. Generating browser fingerprint (WebGL, Canvas, Screen, Timezone, etc.)
 * 4. Compressing fingerprint using LZ-string algorithm
 * 5. Submitting POST oneshot request with compressed payload
 * 6. Receiving cf_clearance cookie in response
 * 
 * This solver supports both:
 * - Direct mode (no proxy, for IPs CF already trusts)
 * - Proxy mode (uses configured proxy for sticky sessions)
 */

// ─── Dependencies ─────────────────────────────────────────────────────────────

import * as lzstring from "lz-string";
import { ProxyAgent } from "undici";

// ─── Types & Interfaces ───────────────────────────────────────────────────────

interface JSDChallengeParams {
  /** Ray ID (r parameter) */
  ray: string;
  /** Timestamp (t parameter, base64 encoded) */
  timestamp: string;
  /** Encoded data (m parameter) */
  m: string;
  /** Seed values (s parameter) */
  s: string;
}

interface JSDOneshotResponse {
  /** cf_clearance cookie value */
  cfClearance: string;
  /** All cookies returned by Cloudflare */
  cookies: Array<{ name: string; value: string }>;
  /** User-Agent used for the request */
  userAgent: string;
  /** Timestamp when cf_clearance was obtained */
  obtainedAt: number;
  /** Expiration time (cf_clearance typically valid ~2 hours) */
  expiresAt: number;
}

interface JSDSolveResult {
  success: boolean;
  /** Solution if successful */
  session?: JSDOneshotResponse;
  /** Error message if failed */
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CF_JSD_SCRIPT_PATH = "/cdn-cgi/challenge-platform/scripts/jsd/main.js";
const CF_ONESHOT_PATH_PATTERN = "/cdn-cgi/challenge-platform/h/[bg]/jsd/oneshot";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CF_CLEARANCE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours (CF default)
const RETRY_BACKOFF_MS = 2000;
const MAX_RETRIES = 3;

// ─── JSD Solver Class ─────────────────────────────────────────────────────────

export class JSDSolver {
  private userAgent: string;
  private proxyUrl?: string;
  private proxyAgent?: ProxyAgent;
  private oneshotPath?: string;
  private nonce?: string;
  private siteKey?: string;

  /**
   * Create a new JSD Solver instance
   * 
   * @param userAgent - Browser User-Agent string (defaults to Chrome 136)
   * @param proxyUrl - Optional proxy URL for sticky sessions
   */
  constructor(userAgent: string = DEFAULT_USER_AGENT, proxyUrl?: string) {
    this.userAgent = userAgent;
    this.proxyUrl = proxyUrl;
    
    if (proxyUrl) {
      this.proxyAgent = new ProxyAgent(proxyUrl);
    }
  }

  /**
   * Main entry point: Solve a Cloudflare JSD challenge
   * 
   * @param portalUrl - URL of the portal protected by Cloudflare JSD
   * @param timeoutMs - Request timeout in milliseconds
   * @returns Promise<JSDSolveResult> with cf_clearance and cookies
   */
  public async solve(
    portalUrl: string,
    timeoutMs: number = 30000,
  ): Promise<JSDSolveResult> {
    console.log(`[jsd-solver] 🚀 Début résolution JSD pour: ${portalUrl}`);
    
    const startTime = Date.now();
    
    try {
      // Step 1: Fetch portal HTML and extract challenge parameters
      const challengeParams = await this.fetchChallengeParams(portalUrl, timeoutMs);
      if (!challengeParams) {
        throw new Error("Impossible d'extraire les paramètres du challenge JSD");
      }
      console.log(`[jsd-solver] ✅ Paramètres extraits: r=${challengeParams.ray.slice(0, 8)}...`);

      // Step 2: Fetch JSD main script and extract oneshot path
      const oneshotPath = await this.fetchJSDScript(challengeParams, timeoutMs);
      if (!oneshotPath) {
        throw new Error("Impossible d'extraire le chemin oneshot depuis main.js");
      }
      this.oneshotPath = oneshotPath;
      console.log(`[jsd-solver] ✅ Oneshot path: ${oneshotPath.slice(0, 60)}...`);

      // Step 3: Generate browser fingerprint
      const fingerprint = this.generateBrowserFingerprint();
      console.log(`[jsd-solver] ✅ Fingerprint généré (${JSON.stringify(fingerprint).length} bytes)`);

      // Step 4: Compress fingerprint
      const compressedPayload = this.compressFingerprint(fingerprint);
      console.log(`[jsd-solver] ✅ Payload compressé (${compressedPayload.length} chars)`);

      // Step 5: Submit oneshot request
      const solution = await this.submitOneshot(compressedPayload, challengeParams, timeoutMs);
      const duration = Date.now() - startTime;
      
      console.log(`[jsd-solver] 🎉 Résolution JSD terminée en ${duration}ms`);
      console.log(`[jsd-solver]    cf_clearance: ${solution.cfClearance.slice(0, 20)}...`);
      console.log(`[jsd-solver]    Cookies: ${solution.cookies.length} retournés`);
      
      return {
        success: true,
        session: solution,
      };
      
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`[jsd-solver] ❌ Échec JSD en ${duration}ms:`, error);
      
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Step 1: Fetch portal HTML and extract __CF$cv$params
   */
  private async fetchChallengeParams(
    portalUrl: string,
    timeoutMs: number,
  ): Promise<JSDChallengeParams | null> {
    try {
      const res = await this.fetchWithRetry(portalUrl, {
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Upgrade-Insecure-Requests": "1",
        },
        timeout: timeoutMs,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching portal`);
      }

      const html = await res.text();
      
      // Extract __CF$cv$params using regex
      const paramsMatch = html.match(/window\.__CF\$cv\$params\s*=\s*(\{[^}]+\})/);
      if (!paramsMatch) {
        console.warn("[jsd-solver] ⚠️ window.__CF$cv$params non trouvé dans le HTML");
        return null;
      }

      const paramsStr = paramsMatch[1];
      
      // Parse the parameters object
      const params: JSDChallengeParams = {
        ray: paramsMatch[1].match(/\br:\s*['"]([^'"]+)['"]/)?.[1] || "",
        timestamp: paramsMatch[1].match(/\bt:\s*['"]([^'"]+)['"]/)?.[1] || "",
        m: paramsMatch[1].match(/\bm:\s*['"]([^'"]+)['"]/)?.[1] || "",
        s: paramsMatch[1].match(/\bs:\s*['"]([^'"]+)['"]/)?.[1] || "",
      };

      return params;
      
    } catch (error) {
      console.error("[jsd-solver] Erreur fetchChallengeParams:", error);
      return null;
    }
  }

  /**
   * Step 2: Fetch JSD main.js and extract oneshot path
   */
  private async fetchJSDScript(
    params: JSDChallengeParams,
    timeoutMs: number,
  ): Promise<string | null> {
    if (!params.ray) {
      throw new Error("Ray ID required for JSD script fetch");
    }

    try {
      // Build JSD script URL
      const url = this.buildJSDScriptUrl(params.ray);
      
      const res = await this.fetchWithRetry(url, {
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Referer": this.getBaseURL(params.ray),
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-origin",
        },
        timeout: timeoutMs,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching JSD script`);
      }

      const script = await res.text();
      
      // Extract oneshot path from script
      // Pattern: /jsd/oneshot/<siteKey>/<nonce>/
      const oneshotMatch = script.match(/\/jsd\/oneshot\/([a-f0-9]{10,14})\/([\w.:\-_~]+)\//);
      
      if (!oneshotMatch) {
        console.warn("[jsd-solver] ⚠️ Oneshot path non trouvé dans main.js");
        return null;
      }

      this.siteKey = oneshotMatch[1];
      this.nonce = oneshotMatch[2];
      
      const oneshotPath = `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/${this.siteKey}/${this.nonce}/${params.ray}`;
      
      return oneshotPath;
      
    } catch (error) {
      console.error("[jsd-solver] Erreur fetchJSDScript:", error);
      return null;
    }
  }

  /**
   * Step 3: Generate browser fingerprint
   */
  private generateBrowserFingerprint(): Record<string, unknown> {
    // Screen properties available in Node.js JSDOM-like environment
    const availableScreen = {
      width: 1920,
      height: 1080,
      colorDepth: 24,
      pixelRatio: 1,
      availableWidth: 1920,
      availableHeight: 1040,
    };
    
    // Navigator properties available in Node.js environment
    const availableNavigator = {
      platform: "Win32",
      languages: ["fr-FR", "fr", "en-US", "en"],
      hardwareConcurrency: 8,
      maxTouchPoints: 0,
    };
    
    return {
      // Screen information
      screen: availableScreen,
      // Navigator information
      navigator: availableNavigator,
      // Timezone
      timezone: {
        offset: new Date().getTimezoneOffset(),
        name: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris",
      },
      // WebGL
      webgl: {
        vendor: "Google Inc. (NVIDIA)",
        renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 3GB Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      // Canvas hash (simplified - real implementation would render and hash)
      canvas: "canvas_hash_placeholder",
      // Timestamp
      timestamp: Date.now(),
      // User-Agent
      userAgent: this.userAgent,
    };
  }

  /**
   * Step 4: Compress fingerprint using LZ-string
   */
  private compressFingerprint(fingerprint: Record<string, unknown>): string {
    // Convert to JSON
    const jsonString = JSON.stringify(fingerprint);
    
    // Compress using LZ-string
    const compressed = lzstring.compressToEncodedURIComponent(jsonString);
    
    // Format: v_<ray>=<compressed_payload>
    const payload = `v_${this.oneshotPath?.split("/").pop() ?? "unknown"}=${compressed}`;
    
    return payload;
  }

  /**
   * Step 5: Submit oneshot request and extract cf_clearance
   */
  private async submitOneshot(
    compressedPayload: string,
    params: JSDChallengeParams,
    timeoutMs: number,
  ): Promise<JSDOneshotResponse> {
    if (!this.oneshotPath) {
      throw new Error("Oneshot path not set");
    }

    const oneshotUrl = `${this.getBaseURL(params.ray)}${this.oneshotPath}`;
    
    // Build request body with token and timestamp
    const body = this.buildOneshotBody(compressedPayload, params);
    
    const res = await this.fetchWithRetry(oneshotUrl, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "*/*",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": this.getBaseURL(params.ray),
        "Referer": this.getBaseURL(params.ray),
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body,
      timeout: timeoutMs,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} submitting oneshot`);
    }

    // Extract cf_clearance from Set-Cookie header
    const setCookie = res.headers.get("set-cookie") || "";
    const cfClearanceMatch = setCookie.match(/cf_clearance=([^;]+)/);
    
    if (!cfClearanceMatch) {
      throw new Error("cf_clearance cookie not found in response");
    }

    const cfClearance = cfClearanceMatch[1];
    
    // Parse all cookies
    const cookies = this.parseSetCookie(setCookie);
    
    return {
      cfClearance,
      cookies,
      userAgent: this.userAgent,
      obtainedAt: Date.now(),
      expiresAt: Date.now() + CF_CLEARANCE_TTL_MS,
    };
  }

  // ─── Helper Methods ─────────────────────────────────────────────────────────

  /**
   * Build JSD script URL with cache-bust
   */
  private buildJSDScriptUrl(rayId: string): string {
    // JSD script URL typically includes the ray ID
    const baseUrl = this.getBaseURL(rayId);
    return `${baseUrl}${CF_JSD_SCRIPT_PATH}?t=${Date.now()}`;
  }

  /**
   * Extract base URL from ray ID
   */
  private getBaseURL(rayId: string): string {
    // For citaconsular.es: https://www.citaconsular.es
    // This would need to be configurable per portal
    if (rayId.includes("citaconsular")) {
      return "https://www.citaconsular.es";
    }
    
    // Generic fallback - extract from portal URL
    return "https://example.com"; // Placeholder
  }

  /**
   * Build oneshot request body
   */
  private buildOneshotBody(compressedPayload: string, params: JSDChallengeParams): string {
    // Format: v_<ray>=<compressed>&t=<timestamp>
    const bodyParts = [compressedPayload];
    
    if (params.timestamp) {
      bodyParts.push(`t=${encodeURIComponent(params.timestamp)}`);
    }
    
    // For citaconsular.es, we may also need token from widget
    // This would be extracted from the portal HTML form
    
    return bodyParts.join("&");
  }

  /**
   * Parse Set-Cookie header into array
   */
  private parseSetCookie(setCookie: string): Array<{ name: string; value: string }> {
    const cookies: Array<{ name: string; value: string }> = [];
    
    const cookieParts = setCookie.split(",");
    for (const part of cookieParts) {
      const cookieStr = part.trim();
      const eqIndex = cookieStr.indexOf("=");
      if (eqIndex > 0) {
        const name = cookieStr.slice(0, eqIndex).trim();
        const value = cookieStr.slice(eqIndex + 1).split(";")[0].trim();
        if (name && value) {
          cookies.push({ name, value });
        }
      }
    }
    
    return cookies;
  }

  /**
   * Fetch with retry and backoff
   */
  private async fetchWithRetry(
    url: string,
    options: RequestInit & { timeout?: number } = {},
  ): Promise<Response> {
    const timeoutMs = options.timeout || 30000;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        
        // Build options with dispatcher if using proxy
        const fetchOptions = { ...options };
        if (this.proxyAgent) {
          // @ts-ignore - dispatcher is undici-specific
          fetchOptions.dispatcher = this.proxyAgent;
        }
        
        const res = await fetch(url, {
          ...fetchOptions,
          signal: controller.signal,
        });
        
        clearTimeout(timeout);
        return res;
        
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        if (attempt < MAX_RETRIES - 1) {
          const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`[jsd-solver] ⏳ Retry in ${backoff}ms (${attempt + 1}/${MAX_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }
    
    throw lastError || new Error(`Fetch failed after ${MAX_RETRIES} attempts`);
  }

  /**
   * Validate that the session is still valid
   */
  public isSessionValid(session: JSDOneshotResponse): boolean {
    return Date.now() < session.expiresAt;
  }

  /**
   * Get remaining time for a session
   */
  public getSessionRemainingMs(session: JSDOneshotResponse): number {
    return Math.max(0, session.expiresAt - Date.now());
  }

  /**
   * Get session cookies as header string
   */
  public getCookieHeader(session: JSDOneshotResponse): string {
    return session.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  }
}

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Convenience function to solve JSD challenge
 */
export async function solveJSDChallenge(
  portalUrl: string,
  options?: {
    userAgent?: string;
    proxyUrl?: string;
    timeoutMs?: number;
  },
): Promise<JSDSolveResult> {
  const solver = new JSDSolver(
    options?.userAgent,
    options?.proxyUrl,
  );
  return await solver.solve(portalUrl, options?.timeoutMs);
}