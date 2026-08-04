/**
 * jsd-solver.ts — Cloudflare JavaScript Detection (JSD) solver
 *
 * JSD (JavaScript Detection) is Cloudflare's invisible challenge that works by:
 *  1. Extracting __CF$cv$params (r, t, m, s parameters) from HTML
 *  2. Fetching /cdn-cgi/challenge-platform/scripts/jsd/main.js to get nonce
 *  3. Generating browser fingerprint (WebGL, Canvas, Screen, Timezone, etc.)
 *  4. Compressing fingerprint using LZ-string algorithm
 *  5. Submitting POST oneshot request with compressed payload
 *  6. Receiving cf_clearance cookie in response
 *
 * TRANSPORT : toutes les requêtes HTTP passent par une instance Impit (Chrome JA3/JA4).
 * Node.js fetch() natif est volontairement BANNI — il expose un fingerprint TLS détectable
 * par Cloudflare, qui renverrait une erreur silencieuse ou un 403.
 *
 * BUG CORRIGÉ : l'ancienne implémentation dérivait la base URL depuis le `rayId` (une chaîne
 * hex CF sans aucune relation avec un domaine). La base URL est maintenant dérivée du
 * `portalUrl` passé au constructeur.
 */

// ─── Dependencies ─────────────────────────────────────────────────────────────

import * as lzstring from "lz-string";
import { Impit } from "impit";

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

export interface JSDOneshotResponse {
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
  /** The impit instance used (same TLS session — MUST be reused for subsequent calls) */
  impit: InstanceType<typeof Impit>;
}

export interface JSDSolveResult {
  success: boolean;
  /** Solution if successful */
  session?: JSDOneshotResponse;
  /** Error message if failed */
  error?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/** cf_clearance is typically valid for ~2 hours */
const CF_CLEARANCE_TTL_MS = 2 * 60 * 60 * 1000;

const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;

// ─── JSD Solver Class ─────────────────────────────────────────────────────────

export class JSDSolver {
  private portalUrl: string;
  private baseUrl: string;
  private userAgent: string;
  private proxyUrl?: string;
  private _impit: InstanceType<typeof Impit>;
  private oneshotPath?: string;
  private nonce?: string;
  private siteKey?: string;

  /**
   * @param portalUrl      - Full URL of the CF-protected portal (e.g. https://www.citaconsular.es/...)
   * @param userAgent      - Browser UA string (defaults to Chrome 136 Win)
   * @param proxyUrl       - Optional proxy URL for sticky sessions (REQUIRED when cf_clearance is IP-bound)
   * @param existingImpit  - Optional pre-initialised impit instance to reuse (same TLS session as probe)
   */
  constructor(
    portalUrl: string,
    userAgent: string = DEFAULT_USER_AGENT,
    proxyUrl?: string,
    existingImpit?: InstanceType<typeof Impit>,
  ) {
    this.portalUrl = portalUrl;
    this.userAgent = userAgent;
    this.proxyUrl = proxyUrl;

    // Derive base URL from the actual portal URL — NOT from the CF rayId
    const parsed = new URL(portalUrl);
    this.baseUrl = `${parsed.protocol}//${parsed.hostname}`;

    // Single impit instance per solver — all requests share the same TLS session.
    // This is critical: cf_clearance is tied to the (IP, TLS fingerprint) pair.
    // If we switch instances mid-solve, the cookie will be rejected.
    // When the caller (e.g. solveViaImpit) already made a probe request, reuse that
    // impit instance so the TLS session is continuous from probe → challenge → clearance.
    if (existingImpit) {
      this._impit = existingImpit;
      console.log(
        `[jsd-solver] 🔧 Initialisé pour ${this.baseUrl}${proxyUrl ? " (proxy)" : " (direct)"} — impit réutilisé (TLS session continue)`,
      );
    } else {
      this._impit = new Impit({
        browser: "chrome",
        ...(proxyUrl ? { proxyUrl } : {}),
      } as any);
      console.log(
        `[jsd-solver] 🔧 Initialisé pour ${this.baseUrl}${proxyUrl ? " (proxy)" : " (direct)"}`,
      );
    }
  }

  /** The impit instance used — callers MUST reuse it for all subsequent requests. */
  get impit(): InstanceType<typeof Impit> {
    return this._impit;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Solve a Cloudflare JSD challenge and return cf_clearance.
   *
   * The returned `session.impit` MUST be used for all subsequent requests —
   * it is the same impit instance that obtained the cookie (same TLS session).
   *
   * @param timeoutMs      - Max time for the full solve (default 30s)
   * @param prefetchedHtml - Optional HTML already fetched by the caller (avoids a redundant GET)
   */
  public async solve(timeoutMs = 30_000, prefetchedHtml?: string): Promise<JSDSolveResult> {
    console.log(`[jsd-solver] 🚀 Début résolution JSD pour: ${this.portalUrl}`);
    const t0 = Date.now();

    try {
      // Step 1 : Fetch portal HTML and extract CF challenge params
      // If the caller already has the HTML (e.g. from a probe request), skip the GET.
      const challengeParams = await this.fetchChallengeParams(timeoutMs, prefetchedHtml);
      if (!challengeParams) {
        throw new Error("Impossible d'extraire les paramètres du challenge JSD (__CF$cv$params absent)");
      }
      console.log(`[jsd-solver] ✅ Paramètres CF extraits: r=${challengeParams.ray.slice(0, 12)}…`);

      // Step 2 : Fetch JSD main.js and extract oneshot path
      const oneshotPath = await this.fetchJSDScript(challengeParams, timeoutMs);
      if (!oneshotPath) {
        throw new Error("Impossible d'extraire le chemin oneshot depuis main.js");
      }
      this.oneshotPath = oneshotPath;
      console.log(`[jsd-solver] ✅ Oneshot path: ${oneshotPath.slice(0, 70)}…`);

      // Step 3 : Generate browser fingerprint
      const fingerprint = this.generateBrowserFingerprint();

      // Step 4 : Compress fingerprint (LZ-string)
      const compressedPayload = this.compressFingerprint(fingerprint);
      console.log(`[jsd-solver] ✅ Payload compressé (${compressedPayload.length} chars)`);

      // Step 5 : POST oneshot → receive cf_clearance
      const solution = await this.submitOneshot(compressedPayload, challengeParams, timeoutMs);
      const duration = Date.now() - t0;

      console.log(`[jsd-solver] 🎉 JSD résolu en ${duration}ms`);
      console.log(`[jsd-solver]    cf_clearance: ${solution.cfClearance.slice(0, 30)}…`);
      console.log(`[jsd-solver]    Cookies reçus: ${solution.cookies.length}`);

      return { success: true, session: solution };
    } catch (error) {
      const duration = Date.now() - t0;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[jsd-solver] ❌ Échec JSD en ${duration}ms: ${msg}`);
      return { success: false, error: msg };
    }
  }

  // ─── Step 1 : Fetch challenge params ────────────────────────────────────────

  private async fetchChallengeParams(
    timeoutMs: number,
    prefetchedHtml?: string,
  ): Promise<JSDChallengeParams | null> {
    try {
      let html: string;

      if (prefetchedHtml) {
        // Reuse HTML already fetched by the caller — avoids a redundant GET and keeps
        // the TLS session intact (no extra round-trip that could alter CF state).
        html = prefetchedHtml;
        console.log(
          `[jsd-solver] Portal HTML réutilisé depuis probe (${html.length} chars)`,
        );
      } else {
        const res = await this.fetchViaImpit(this.portalUrl, {
          headers: {
            "User-Agent": this.userAgent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
            "Accept-Encoding": "gzip, deflate, br",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Upgrade-Insecure-Requests": "1",
          },
          signal: AbortSignal.timeout(timeoutMs),
        });

        // CF challenge pages return 403 — allow it and parse the HTML body.
        // Any other non-2xx error (500, 429, etc.) is a real failure.
        if (!res.ok && res.status !== 403) {
          throw new Error(`HTTP ${res.status} fetching portal`);
        }

        html = await res.text();
        console.log(
          `[jsd-solver] Portal HTML reçu (${html.length} chars, status=${res.status})`,
        );
      }

      // Extract __CF$cv$params
      const paramsMatch = html.match(/window\.__CF\$cv\$params\s*=\s*(\{[^}]+\})/);
      if (!paramsMatch) {
        // Log a preview to diagnose why params are missing
        const preview = html.slice(0, 600).replace(/\s+/g, " ");
        console.warn(`[jsd-solver] ⚠️ __CF$cv$params absent. Preview: ${preview}`);
        return null;
      }

      const block = paramsMatch[1];
      return {
        ray:       block.match(/\br:\s*['"]([^'"]+)['"]/)?.[1]  ?? "",
        timestamp: block.match(/\bt:\s*['"]([^'"]+)['"]/)?.[1]  ?? "",
        m:         block.match(/\bm:\s*['"]([^'"]+)['"]/)?.[1]  ?? "",
        s:         block.match(/\bs:\s*['"]([^'"]+)['"]/)?.[1]  ?? "",
      };
    } catch (err) {
      console.error("[jsd-solver] Erreur fetchChallengeParams:", err);
      return null;
    }
  }

  // ─── Step 2 : Fetch JSD main.js ─────────────────────────────────────────────

  private async fetchJSDScript(
    params: JSDChallengeParams,
    timeoutMs: number,
  ): Promise<string | null> {
    try {
      const scriptUrl = `${this.baseUrl}/cdn-cgi/challenge-platform/scripts/jsd/main.js?t=${Date.now()}`;

      const res = await this.fetchViaImpit(scriptUrl, {
        headers: {
          "User-Agent": this.userAgent,
          "Accept": "*/*",
          "Accept-Language": "fr-FR,fr;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "Referer": this.portalUrl,
          "Sec-Fetch-Dest": "script",
          "Sec-Fetch-Mode": "no-cors",
          "Sec-Fetch-Site": "same-origin",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} fetching JSD script`);
      }

      const script = await res.text();
      console.log(`[jsd-solver] JSD script reçu (${script.length} chars)`);

      // Extract: /jsd/oneshot/<siteKey>/<nonce>/<ray>
      const oneshotMatch = script.match(
        /\/jsd\/oneshot\/([a-f0-9]{10,14})\/([\w.:\-_~]+)\//,
      );

      if (!oneshotMatch) {
        console.warn("[jsd-solver] ⚠️ Oneshot path absent dans main.js. Script preview:", script.slice(0, 400));
        return null;
      }

      this.siteKey = oneshotMatch[1];
      this.nonce   = oneshotMatch[2];

      return `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/${this.siteKey}/${this.nonce}/${params.ray}`;
    } catch (err) {
      console.error("[jsd-solver] Erreur fetchJSDScript:", err);
      return null;
    }
  }

  // ─── Step 3 : Browser fingerprint (Node.js compatible) ───────────────────────

  private generateBrowserFingerprint(): Record<string, unknown> {
    return {
      screen: {
        width: 1920,
        height: 1080,
        colorDepth: 24,
        pixelRatio: 1,
        availableWidth: 1920,
        availableHeight: 1040,
      },
      navigator: {
        platform: "Win32",
        languages: ["fr-FR", "fr", "en-US", "en"],
        hardwareConcurrency: 8,
        maxTouchPoints: 0,
      },
      timezone: {
        offset: new Date().getTimezoneOffset(),
        name: Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Paris",
      },
      webgl: {
        vendor: "Google Inc. (NVIDIA)",
        renderer:
          "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 3GB Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
      canvas: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0",
      timestamp: Date.now(),
      userAgent: this.userAgent,
    };
  }

  // ─── Step 4 : Compress ───────────────────────────────────────────────────────

  private compressFingerprint(fingerprint: Record<string, unknown>): string {
    const json = JSON.stringify(fingerprint);
    const compressed = lzstring.compressToEncodedURIComponent(json);
    // Format expected by CF: v_<ray>=<compressed>
    const rayId = this.oneshotPath?.split("/").pop() ?? "unknown";
    return `v_${rayId}=${compressed}`;
  }

  // ─── Step 5 : POST oneshot ───────────────────────────────────────────────────

  private async submitOneshot(
    compressedPayload: string,
    params: JSDChallengeParams,
    timeoutMs: number,
  ): Promise<JSDOneshotResponse> {
    if (!this.oneshotPath) throw new Error("oneshotPath non défini");

    const oneshotUrl = `${this.baseUrl}${this.oneshotPath}`;

    const bodyParts = [compressedPayload];
    if (params.timestamp) bodyParts.push(`t=${encodeURIComponent(params.timestamp)}`);
    if (params.m)         bodyParts.push(`m=${encodeURIComponent(params.m)}`);
    const body = bodyParts.join("&");

    const res = await this.fetchViaImpit(oneshotUrl, {
      method: "POST",
      headers: {
        "User-Agent": this.userAgent,
        "Accept": "*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": this.baseUrl,
        "Referer": this.portalUrl,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} au POST oneshot. Body: ${bodyText.slice(0, 200)}`);
    }

    // Extract cf_clearance from Set-Cookie header
    // impit peut retourner les cookies via set-cookie ou getSetCookie()
    const rawSetCookie = res.headers.get("set-cookie") ?? "";
    const cfClearanceMatch = rawSetCookie.match(/cf_clearance=([^;]+)/);

    if (!cfClearanceMatch) {
      const bodyText = await res.text().catch(() => "");
      console.warn(`[jsd-solver] ⚠️ cf_clearance absent dans Set-Cookie.`);
      console.warn(`[jsd-solver]    Set-Cookie: ${rawSetCookie.slice(0, 200)}`);
      console.warn(`[jsd-solver]    Body: ${bodyText.slice(0, 200)}`);
      throw new Error("cf_clearance cookie absent dans la réponse oneshot");
    }

    const cfClearance = cfClearanceMatch[1];
    const cookies = this.parseSetCookieHeader(rawSetCookie);

    return {
      cfClearance,
      cookies,
      userAgent: this.userAgent,
      obtainedAt: Date.now(),
      expiresAt:  Date.now() + CF_CLEARANCE_TTL_MS,
      impit: this._impit,
    };
  }

  // ─── Transport : impit (Chrome TLS) ─────────────────────────────────────────

  /**
   * All HTTP calls go through this method.
   * Uses the class-level impit instance — same TLS session throughout the solve.
   * Node.js fetch() is NEVER called.
   */
  private async fetchViaImpit(
    url: string,
    options: RequestInit & { signal?: AbortSignal } = {},
  ): Promise<Response> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await (
          this._impit.fetch(url, options as any) as unknown as Promise<Response>
        );
        return res;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          const backoff = RETRY_BACKOFF_MS * Math.pow(2, attempt);
          console.log(
            `[jsd-solver] ⏳ Retry ${attempt + 1}/${MAX_RETRIES} dans ${backoff}ms (${lastError.message.slice(0, 80)})`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    throw lastError ?? new Error(`fetch échoué après ${MAX_RETRIES} tentatives`);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /** Parse a Set-Cookie header string into name/value pairs. */
  private parseSetCookieHeader(rawSetCookie: string): Array<{ name: string; value: string }> {
    const result: Array<{ name: string; value: string }> = [];
    // Each cookie directive is separated by ", " but values can contain commas.
    // Split on ", " followed by a token that looks like a cookie name.
    for (const part of rawSetCookie.split(/,\s*(?=[A-Za-z_][^=]*=)/)) {
      const directive = part.trim();
      const eqIdx = directive.indexOf("=");
      if (eqIdx > 0) {
        const name  = directive.slice(0, eqIdx).trim();
        const value = directive.slice(eqIdx + 1).split(";")[0].trim();
        if (name && value) result.push({ name, value });
      }
    }
    return result;
  }

  // ─── Public helpers ──────────────────────────────────────────────────────────

  public isSessionValid(session: JSDOneshotResponse): boolean {
    return Date.now() < session.expiresAt;
  }

  public getSessionRemainingMs(session: JSDOneshotResponse): number {
    return Math.max(0, session.expiresAt - Date.now());
  }

  public getCookieHeader(session: JSDOneshotResponse): string {
    return session.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

// ─── Convenience export ───────────────────────────────────────────────────────

/**
 * Solve a Cloudflare JSD challenge using impit (Chrome TLS fingerprint).
 *
 * @param portalUrl  Full URL protected by CF (e.g. https://www.citaconsular.es/...)
 * @param proxyUrl   Proxy URL (REQUIRED if cf_clearance is IP-bound: Decodo, SOAX, etc.)
 * @param userAgent  Optional UA override (defaults to Chrome 136 Win)
 */
export async function solveJSDChallenge(
  portalUrl: string,
  proxyUrl?: string,
  userAgent?: string,
): Promise<JSDSolveResult> {
  const solver = new JSDSolver(portalUrl, userAgent, proxyUrl);
  return solver.solve();
}
