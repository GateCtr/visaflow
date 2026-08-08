/**
 * cf-challenge-solver.ts — Résolution robuste de TOUS les challenges Cloudflare 2026
 *
 * TYPES DE CHALLENGES CF GÉRÉS :
 *   1. JS Detection (JSD) — script CF exécuté automatiquement dans le navigateur
 *      → Proof-of-Work + fingerprint télémétriques → cf_clearance émis passivement
 *   2. Managed Challenge — CF décide dynamiquement (JSD auto ou Turnstile interactif)
 *      → Détection automatique du mode + résolution adaptée
 *   3. Turnstile Interactif — checkbox visible "Verify you are human"
 *      → Clic CDP précis dans l'iframe cross-origin CF (shadow DOM traversal)
 *   4. Turnstile Invisible — widget invisible avec PoW silencieux
 *      → Attente passive du callback de résolution
 *   5. Under Attack Mode (IUAM) — page "Checking your browser" 5s delay
 *      → Attente du countdown CF + JSD natif
 *
 * ARCHITECTURE :
 *   Ce module est un solver NATIF — il ne dépend d'AUCUN service externe (CapSolver, 2Captcha, etc.).
 *   Il utilise le vrai Chromium (Puppeteer) avec des techniques CDP avancées :
 *   - CDP Input.dispatchMouseEvent pour les clics précis dans les iframes cross-origin
 *   - CDP Runtime.evaluate dans le contexte isolé de l'iframe CF
 *   - Détection automatique du type de challenge via signaux DOM + titres de page
 *   - Retry intelligent avec backoff exponentiel et rotation de stratégie
 *   - Rotation d'IP proxy entre les tentatives (Decodo pool round-robin)
 *   - Stealth enrichi : WebGL, plugins, Client Hints CDP, webdriver patch
 *   - Purge des données CF stales (localStorage, IndexedDB, ServiceWorkers)
 *   - Cache-bust CDN pour forcer des nonces JSD fraîches
 *   - Fallback CapSolver uniquement en dernier recours (si CAPSOLVER_API_KEY est défini)
 *
 * UTILISATION :
 *   import { solveCfChallenge, detectChallengeType } from "./cf-challenge-solver.js";
 *
 *   // Résolution simple (page Puppeteer déjà sur un challenge CF) :
 *   const result = await solveCfChallenge(page, { timeout: 90_000 });
 *   if (result.success) {
 *     console.log(`cf_clearance: ${result.cfClearance}`);
 *   }
 *
 *   // Résolution robuste avec retry + rotation IP (recommandé) :
 *   const result = await solveCfChallengeWithRetry(page, browser, {
 *     targetUrl: "https://www.citaconsular.es/...",
 *     maxRetries: 5,
 *     proxyUrl: "http://user:pass@isp.decodo.com:10010",
 *   });
 */

import type { Page, Browser, CDPSession, ElementHandle, Dialog } from "puppeteer";
import { getCurrentDecodoUrl, rotateDecodoUrl, isDecodoMultiPool } from "./spain-decodo-pool.js";
import { TURNSTILE_INTERCEPT_SCRIPT } from "./capsolver-turnstile.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CfChallengeType =
  | "jsd"              // JS Detection — résolution passive (PoW + fingerprint)
  | "managed"          // Managed Challenge — CF décide JSD ou Turnstile
  | "turnstile"        // Turnstile interactif (checkbox visible)
  | "turnstile_invis"  // Turnstile invisible (PoW silencieux)
  | "iuam"             // Under Attack Mode ("Checking your browser...")
  | "blocked"          // IP bloquée / Access Denied (pas de challenge possible)
  | "none"             // Pas de challenge — page déjà accessible
  | "unknown";         // Type indéterminé

export interface CfSolveResult {
  success: boolean;
  challengeType: CfChallengeType;
  cfClearance?: string;
  /** Durée totale du solve en ms */
  durationMs: number;
  /** Stratégie qui a résolu le challenge */
  solvedBy?: "jsd_passive" | "turnstile_click" | "turnstile_cdp" | "capsolver_fallback" | "already_cleared" | "iuam_wait";
  /** Message d'erreur si échec */
  error?: string;
  /** Tous les cookies post-solve */
  allCookies?: Array<{ name: string; value: string }>;
}

export interface CfSolveOptions {
  /** Timeout global en ms (défaut: 90_000) */
  timeout?: number;
  /** URL cible (pour les logs) */
  targetUrl?: string;
  /** Nombre max de tentatives de clic Turnstile (défaut: 5) */
  maxTurnstileClicks?: number;
  /** Délai entre les tentatives de clic (ms, défaut: 2_000) */
  clickRetryDelay?: number;
  /** Activer le fallback CapSolver si disponible (défaut: true) */
  enableCapsolverFallback?: boolean;
  /** Clé API CapSolver (si non fournie, lue depuis CAPSOLVER_API_KEY) */
  capsolverApiKey?: string;
  /** Timezone géographique alignée avec le proxy (ex: "Europe/Madrid") — v2 */
  geoTimezone?: string;
}

export interface CfSolveWithRetryOptions extends CfSolveOptions {
  /** Nombre max de tentatives avec rotation IP (défaut: 5) */
  maxRetries?: number;
  /** URL du proxy courant (si fourni, rotation sessionid entre tentatives) */
  proxyUrl?: string;
  /** Activer la purge des données CF stales avant chaque tentative (défaut: true) */
  purgeStaleData?: boolean;
  /** Activer le cache-bust CDN pour les nonces JSD (défaut: true) */
  cacheBustCdn?: boolean;
  /** Domaine CF cible (détecté automatiquement depuis targetUrl si absent) */
  cfDomain?: string;
}

// ── Nouvelles interfaces v2 ──────────────────────────────────────────────────

/** Session CF clearance mise en cache par domaine. */
export interface CfSession {
  cfClearance: string;
  cookies: Array<{ name: string; value: string }>;
  /** Date.now() au moment de l'obtention */
  obtainedAt: number;
  /** Date.now() + TTL (lu depuis le cookie CF, ~2h) */
  expiresAt: number;
}

/** Retourné par `getCachedSession()`. */
export interface CachedSessionResult {
  session: CfSession;
  /** true si Date.now() < expiresAt */
  isValid: boolean;
  /** true si TTL restant < 5 min */
  nearExpiry: boolean;
  /** expiresAt - Date.now() */
  ttlRemainingMs: number;
}

/** Métriques du SessionCache, retournées par `getCacheMetrics()`. */
export interface CacheMetrics {
  totalSolves: number;
  cacheHits: number;
  cacheMisses: number;
  averageSolveDurationMs: number;
}

// ── Interface interne pour le retour de page.evaluate() ─────────────────────

/** Signaux DOM collectés en une seule traversée dans `detectChallengeType`. */
interface CfPageSignals {
  title: string;
  url: string;
  isMoment: boolean;
  isChecking: boolean;
  isBlocked: boolean;
  isAttack: boolean;
  hasChallengeRunning: boolean;
  hasTurnstileIframe: boolean;
  hasChallengeForm: boolean;
  hasPleaseWait: boolean;
  hasCfOpt: boolean;
  cfChlType: string;
  hasTurnstileWidget: boolean;
  hasContent: boolean;
  bodyLength: number;
  /** true si le cookie cf_clearance est présent dans document.cookie */
  hasClearance: boolean;
}

// ─── Constantes ─────────────────────────────────────────────────────────────

const LOG_PREFIX = "[cf-solver]";
const CF_IFRAME_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  'iframe[src*="turnstile"]',
  'iframe[id*="cf-"]',
  'iframe[title*="Cloudflare"]',
  'iframe[title*="Turnstile"]',
  'iframe[title*="Widget"]',
];
const CF_CHALLENGE_SELECTORS = [
  ".cf-challenge-running",
  ".cf-im-under-attack",
  "#cf-please-wait",
  "#challenge-running",
  "#challenge-stage",
  "#challenge-form",
  ".challenge-platform",
];

// ─── SessionCache singleton ──────────────────────────────────────────────────

// ── État singleton module-level ──────────────────────────────────────────────

const _sessionCache = new Map<string, CfSession>();
const NEAR_EXPIRY_THRESHOLD_MS = 5 * 60 * 1_000; // 5 minutes

// ── Persistence disque optionnelle ───────────────────────────────────────────

/**
 * Persiste le cache sur disque si CF_SESSION_CACHE_FILE est défini.
 * Erreurs I/O → console.warn uniquement (dégradation gracieuse).
 */
function _persistCacheToDisk(): void {
  const filePath = process.env.CF_SESSION_CACHE_FILE;
  if (!filePath) return;

  try {
    const { writeFileSync } = require("fs") as typeof import("fs");
    const entries = [..._sessionCache.entries()];
    writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf8");
  } catch (err) {
    console.warn(`${LOG_PREFIX} ⚠️ Persistence cache disque échouée: ${err}`);
  }
}

/**
 * Retourne la session en cache pour un domaine, ou null si absente/expirée.
 * Lazy eviction : purge l'entrée expirée à la lecture.
 */
export function getCachedSession(domain: string): CachedSessionResult | null {
  const session = _sessionCache.get(domain);
  if (!session) return null;

  const now = Date.now();
  if (now >= session.expiresAt) {
    _sessionCache.delete(domain); // lazy eviction
    return null;
  }

  const ttlRemainingMs = session.expiresAt - now;
  return {
    session,
    isValid: true,
    nearExpiry: ttlRemainingMs < NEAR_EXPIRY_THRESHOLD_MS,
    ttlRemainingMs,
  };
}

/**
 * Stocke ou met à jour une session CF pour un domaine.
 * Persiste sur disque si CF_SESSION_CACHE_FILE est défini.
 */
export function setCachedSession(domain: string, session: CfSession): void {
  _sessionCache.set(domain, session);
  _persistCacheToDisk();
}

/**
 * Supprime immédiatement la session en cache pour un domaine.
 */
export function invalidateSession(domain: string): void {
  _sessionCache.delete(domain);
}

// ── Métriques ────────────────────────────────────────────────────────────────

let _metrics: CacheMetrics = {
  totalSolves: 0,
  cacheHits: 0,
  cacheMisses: 0,
  averageSolveDurationMs: 0,
};
let _totalSolveDurationMs = 0; // accumulateur pour le calcul de moyenne

/**
 * Retourne une copie défensive des métriques du cache.
 */
export function getCacheMetrics(): CacheMetrics {
  return { ..._metrics };
}

function _recordSolve(durationMs: number): void {
  _metrics.totalSolves++;
  _totalSolveDurationMs += durationMs;
  _metrics.averageSolveDurationMs = _totalSolveDurationMs / _metrics.totalSolves;
}

function _recordCacheHit(): void {
  _metrics.cacheHits++;
}

function _recordCacheMiss(): void {
  _metrics.cacheMisses++;
}

// ── Test helpers (exported with underscore prefix for test access) ─────────

/** @internal Exposed for unit testing only. */
export function _recordSolveForTesting(durationMs: number): void {
  _recordSolve(durationMs);
}

/** @internal Exposed for unit testing only. */
export function _recordCacheHitForTesting(): void {
  _recordCacheHit();
}

/** @internal Exposed for unit testing only. */
export function _recordCacheMissForTesting(): void {
  _recordCacheMiss();
}

/**
 * @internal Resets the metrics and session cache to a clean state.
 * Used in tests to ensure isolation between test cases.
 */
export function _resetMetricsForTesting(): void {
  _metrics = {
    totalSolves: 0,
    cacheHits: 0,
    cacheMisses: 0,
    averageSolveDurationMs: 0,
  };
  _totalSolveDurationMs = 0;
  _sessionCache.clear();
}

/**
 * Charge le cache depuis disque au démarrage du process.
 * Filtre les entrées expirées. Appelé une seule fois (top-level).
 */
function _loadCacheFromDisk(): void {
  const filePath = process.env.CF_SESSION_CACHE_FILE;
  if (!filePath) return;

  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs");
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf8");
    const entries = JSON.parse(raw) as Array<[string, CfSession]>;
    const now = Date.now();
    let loaded = 0;

    for (const [domain, session] of entries) {
      if (now < session.expiresAt) {
        _sessionCache.set(domain, session);
        loaded++;
      }
    }

    if (loaded > 0) {
      console.log(`${LOG_PREFIX} 💾 Cache disque chargé: ${loaded} session(s) valide(s)`);
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} ⚠️ Chargement cache disque échoué (non-fatal): ${err}`);
  }
}

// Chargement du cache disque au démarrage du module
_loadCacheFromDisk();

// ─── Détection du type de challenge ─────────────────────────────────────────

/**
 * Type guard pour valider le retour `unknown` de `page.evaluate()`.
 */
function isCfPageSignals(v: unknown): v is CfPageSignals {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.title === "string" &&
    typeof o.url === "string" &&
    typeof o.isMoment === "boolean" &&
    typeof o.isChecking === "boolean" &&
    typeof o.isBlocked === "boolean" &&
    typeof o.isAttack === "boolean" &&
    typeof o.hasChallengeRunning === "boolean" &&
    typeof o.hasTurnstileIframe === "boolean" &&
    typeof o.hasChallengeForm === "boolean" &&
    typeof o.hasPleaseWait === "boolean" &&
    typeof o.hasCfOpt === "boolean" &&
    typeof o.cfChlType === "string" &&
    typeof o.hasTurnstileWidget === "boolean" &&
    typeof o.hasContent === "boolean" &&
    typeof o.bodyLength === "number" &&
    typeof o.hasClearance === "boolean"
  );
}

/**
 * Détecte le type de challenge Cloudflare présent sur la page.
 *
 * ORDRE DE PRIORITÉ STRICT :
 *   blocked → none → iuam → turnstile → managed → jsd → unknown
 *
 * Un seul `page.evaluate()` collecte tous les signaux DOM en une traversée,
 * évitant les round-trips multiples vers le renderer. Le résultat est validé
 * via un type guard avant d'être interprété en TypeScript.
 */
export async function detectChallengeType(page: Page): Promise<CfChallengeType> {
  try {
    const raw: unknown = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const url = window.location.href;

      // ── Signaux de titre ──────────────────────────────────────────────────
      const isMoment =
        title.includes("just a moment") ||
        title.includes("un instant") ||
        title.includes("einen moment");
      const isChecking =
        title.includes("checking") ||
        title.includes("vérification");
      // Priorité absolue : accès refusé (même si _cf_chl_opt présent)
      const isBlocked =
        title.includes("access denied") ||
        title.includes("error 1015") ||
        title.includes("error 1020");
      const isAttack =
        title.includes("under attack") ||
        title.includes("ddos");

      // ── Signaux DOM ───────────────────────────────────────────────────────
      const hasChallengeRunning = !!(
        document.querySelector(".cf-challenge-running") ||
        document.querySelector("#challenge-running") ||
        document.querySelector("#challenge-stage")
      );
      const hasTurnstileIframe = !!(
        document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
        document.querySelector('iframe[src*="turnstile"]')
      );
      const hasChallengeForm = !!(
        document.querySelector("#challenge-form") ||
        document.querySelector(".challenge-platform")
      );
      const hasPleaseWait = !!(
        document.querySelector("#cf-please-wait") ||
        document.querySelector(".cf-im-under-attack")
      );

      // ── Variable CF côté client ───────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfOpt = (window as any)._cf_chl_opt;
      const hasCfOpt = !!cfOpt;
      const cfChlType: string =
        (typeof cfOpt?.cType === "string" ? cfOpt.cType : null) ??
        (typeof cfOpt?.chlType === "string" ? cfOpt.chlType : "") ??
        "";

      // ── Widget Turnstile visible ──────────────────────────────────────────
      const hasTurnstileWidget = !!(
        document.querySelector(".cf-turnstile") ||
        document.querySelector("[data-sitekey]")
      );

      // ── Contenu de page ───────────────────────────────────────────────────
      const bodyText = document.body?.textContent?.trim() ?? "";
      const hasContent = bodyText.length > 200;

      // ── Présence du cookie cf_clearance (lecture document.cookie) ─────────
      const hasClearance = document.cookie
        .split(";")
        .some((c) => c.trim().startsWith("cf_clearance=") && c.trim().length > "cf_clearance=".length + 10);

      return {
        title,
        url,
        isMoment,
        isChecking,
        isBlocked,
        isAttack,
        hasChallengeRunning,
        hasTurnstileIframe,
        hasChallengeForm,
        hasPleaseWait,
        hasCfOpt,
        cfChlType,
        hasTurnstileWidget,
        hasContent,
        bodyLength: bodyText.length,
        hasClearance,
      };
    }).catch(() => null);

    if (!isCfPageSignals(raw)) return "unknown";

    const s = raw;

    // ── Priorité 1 : Accès refusé — pas de challenge possible ────────────────
    if (s.isBlocked) return "blocked";

    // ── Priorité 2 : Aucun signal CF actif + contenu substantiel → none ──────
    const hasAnyCfSignal =
      s.isMoment ||
      s.isChecking ||
      s.isAttack ||
      s.hasChallengeRunning ||
      s.hasChallengeForm ||
      s.hasPleaseWait ||
      s.hasCfOpt ||
      s.hasTurnstileIframe ||
      s.hasTurnstileWidget;

    if (!hasAnyCfSignal && s.hasContent) return "none";

    // cf_clearance présent sans aucun signal CF actif (page déjà clearée, peu de contenu)
    if (!hasAnyCfSignal && s.hasClearance) return "none";

    // ── Priorité 3 : Under Attack Mode ────────────────────────────────────────
    // #cf-please-wait OU titre "Under Attack"/"ddos", sans iframe Turnstile,
    // et sans _cf_chl_opt.cType === "managed" (ce serait un Managed Challenge)
    if (
      (s.isAttack || s.hasPleaseWait) &&
      !s.hasTurnstileIframe &&
      s.cfChlType !== "managed"
    ) {
      return "iuam";
    }

    // ── Priorité 4 : Turnstile interactif ─────────────────────────────────────
    // iframe CF présente OU cType explicitement "interactive"
    if (s.hasTurnstileIframe || s.cfChlType === "interactive") {
      return "turnstile";
    }

    // ── Priorité 5 : Managed Challenge ────────────────────────────────────────
    if (s.cfChlType === "managed") {
      return "managed";
    }

    // ── Priorité 6 : JS Detection ─────────────────────────────────────────────
    if (
      s.cfChlType === "non-interactive" ||
      s.cfChlType === "jsd" ||
      s.isMoment ||
      s.isChecking ||
      s.hasChallengeRunning ||
      s.hasChallengeForm
    ) {
      return "jsd";
    }

    // ── Priorité 7 : Type indéterminé (signal CF présent mais non classifiable) ─
    return "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Attente passive cf_clearance (JSD / IUAM) ─────────────────────────────

/**
 * Attend que le cookie cf_clearance apparaisse dans le navigateur.
 * Utilisé pour les challenges passifs (JSD, IUAM) où le navigateur résout seul.
 */
async function waitForClearance(
  page: Page,
  timeoutMs: number,
  domain?: string,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  const cookieUrl = domain ? `https://${domain}` : undefined;
  let lastLogAt = 0;

  while (Date.now() < deadline) {
    try {
      const cookies = cookieUrl
        ? await page.cookies(cookieUrl)
        : await page.cookies();
      const cf = cookies.find((c) => c.name === "cf_clearance" && c.value.length > 10);
      if (cf) return cf.value;
    } catch { /* non-fatal */ }

    // Log intermédiaire toutes les 10s
    const now = Date.now();
    if (now - lastLogAt > 10_000) {
      lastLogAt = now;
      const elapsed = Math.round((now - (deadline - timeoutMs)) / 1000);
      const title = await page.title().catch(() => "?");
      console.log(`${LOG_PREFIX} ⏳ Attente cf_clearance ${elapsed}s — titre: "${title}"`);
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  return null;
}

// ─── Résolution Turnstile par clic CDP ──────────────────────────────────────
// ─── Résolution Turnstile par clic CDP ──────────────────────────────────────

/**
 * Coordonnees du widget Turnstile CF 2026.
 *
 * CF 2026 ne met PAS d'<iframe> dans le DOM HTML. Le widget est rendu par le moteur
 * Chromium comme une browser-level frame superposee sur un div conteneur.
 *
 * Strategie : trouver input[id*="cf-chl-widget"] → remonter au parent avec taille.
 */
async function findTurnstileWidgetCoords(
  page: Page,
): Promise<{ x: number; y: number; w: number; h: number; widgetId: string } | null> {
  try {
    const coords: { x: number; y: number; w: number; h: number; widgetId: string } | null = await page.evaluate(() => {
      const input = document.querySelector('input[id*="cf-chl-widget"][id$="_response"]') as HTMLInputElement | null;
      if (!input) return null;
      const widgetId = input.id.replace('cf-chl-widget-', '').replace('_response', '');
      let el: HTMLElement | null = input.parentElement;
      while (el) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 100 && rect.height >= 20 && rect.x >= 0 && rect.y > 0) {
          return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), widgetId };
        }
        el = el.parentElement;
      }
      return null;
    });
    if (coords) {
      console.log(`${LOG_PREFIX} 🎯 Widget CF: id=${coords.widgetId} rect=[${coords.x},${coords.y} ${coords.w}x${coords.h}]`);
      return coords;
    }
  } catch { /* non-fatal */ }
  return null;
}

function computeCfWidgetClickCoords(
  container: { x: number; y: number; w: number; h: number },
): { x: number; y: number } {
  return {
    x: container.x + 33 + (Math.random() - 0.5) * 10,
    y: container.y + container.h / 2 + (Math.random() - 0.5) * 8,
  };
}

/** Legacy — CF 2026 n'utilise plus d'iframe DOM */
async function findTurnstileIframe(page: Page): Promise<ElementHandle | null> {
  for (const selector of CF_IFRAME_SELECTORS) {
    try {
      const iframe = await page.$(selector);
      if (iframe) {
        const src = await iframe.evaluate((el: Element) => (el as HTMLIFrameElement).src).catch(() => "");
        if (src.includes("challenges.cloudflare.com") || src.includes("turnstile")) return iframe;
      }
    } catch { /* non-fatal */ }
  }
  return null;
}

async function computeTurnstileClickCoords(iframe: ElementHandle): Promise<{ x: number; y: number } | null> {
  try {
    const box = await iframe.boundingBox();
    if (!box || box.width < 10 || box.height < 10) return null;
    return { x: box.x + 33 + (Math.random() - 0.5) * 10, y: box.y + box.height / 2 + (Math.random() - 0.5) * 8 };
  } catch { return null; }
}
/**
 * Calcule un point sur une courbe de Bézier cubique.
 * B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 */
export function cubicBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/**
 * Génère une trajectoire de souris Bézier cubique vers la cible.
 *
 * Points de contrôle :
 *   P0 : (400 ± 200, 300 ± 200)     — départ aléatoire
 *   P1 : P0 + (±300, ±200)          — direction initiale
 *   P2 : target + (±100, ±100)      — point de contrôle d'arrivée
 *   P3 : target                      — destination exacte
 *
 * N points : floor(20 + random() * 20) (entre 20 et 40)
 * Délai par point : 2 + (1 - sin(t * π)) * 16 ms
 */
export async function generateBezierTrajectory(
  targetX: number,
  targetY: number,
): Promise<Array<{ x: number; y: number; delayMs: number }>> {
  const p0 = {
    x: 400 + (Math.random() - 0.5) * 400,
    y: 300 + (Math.random() - 0.5) * 400,
  };
  const p1 = {
    x: p0.x + (Math.random() - 0.5) * 600,
    y: p0.y + (Math.random() - 0.5) * 400,
  };
  const p2 = {
    x: targetX + (Math.random() - 0.5) * 200,
    y: targetY + (Math.random() - 0.5) * 200,
  };
  const p3 = { x: targetX, y: targetY };
  const N = Math.floor(20 + Math.random() * 20);

  return Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N;
    const speedFactor = Math.sin(t * Math.PI);
    const delayMs = 2 + (1 - speedFactor) * 16;
    return { ...cubicBezier(p0, p1, p2, p3, t), delayMs };
  });
}

/**
 * Effectue un clic CDP réaliste sur les coordonnées données via trajectoire Bézier.
 *
 * SIMULATION COMPORTEMENT HUMAIN :
 *   1. Trajectoire Bézier cubique vers la cible (20–40 points, vitesse non-uniforme)
 *   2. Micro-pause aléatoire avant le clic (80–250 ms)
 *   3. mousePressed + mouseReleased avec timing naturel (40–150 ms)
 *   4. Jitter de position au release ±3px (tremblement micro)
 */
async function humanLikeCdpClick(
  page: Page,
  targetX: number,
  targetY: number,
): Promise<void> {
  let cdp: CDPSession | null = null;
  try {
    cdp = await page.createCDPSession();

    // Phase 1 : Trajectoire Bézier cubique vers la cible
    const trajectory = await generateBezierTrajectory(targetX, targetY);

    for (const point of trajectory) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      });
      await new Promise((r) => setTimeout(r, point.delayMs));
    }

    // Phase 2 : Micro-pause pré-clic (80–250 ms, réflexion humaine)
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 170));

    // Phase 3 : mousePressed
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: targetX,
      y: targetY,
      button: "left",
      clickCount: 1,
    });

    // Phase 4 : Délai clic maintenu (40–150 ms)
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 110));

    // Phase 5 : mouseReleased avec jitter ±3px
    const releaseJitterX = (Math.random() - 0.5) * 6;
    const releaseJitterY = (Math.random() - 0.5) * 6;
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: targetX + releaseJitterX,
      y: targetY + releaseJitterY,
      button: "left",
      clickCount: 1,
    });

    console.log(`${LOG_PREFIX} 🖱️ Clic CDP Bézier exécuté [${Math.round(targetX)}, ${Math.round(targetY)}] (${trajectory.length} points)`);
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
}

/**
 * Vérifie si le Turnstile a été résolu avec succès après un clic.
 *
 * SIGNAUX DE SUCCÈS :
 *   1. cf_clearance cookie apparu
 *   2. L'iframe Turnstile affiche un checkmark (✓)
 *   3. Le titre de la page n'est plus "Just a moment"
 *   4. Le challenge-form a disparu
 */
async function isTurnstileResolved(page: Page, domain?: string): Promise<boolean> {
  try {
    const cookies = domain
      ? await page.cookies(`https://${domain}`)
      : await page.cookies();
    const hasClearance = cookies.some((c) => c.name === "cf_clearance" && c.value.length > 10);
    if (hasClearance) return true;

    // Vérifier si le challenge a disparu du DOM
    const challengeGone = await page.evaluate(() => {
      const title = document.title.toLowerCase();
      const noChallenge = !title.includes("just a moment") && !title.includes("un instant") &&
                          !title.includes("checking") && !title.includes("einen moment");
      const noCfElements = !document.querySelector(
        ".cf-challenge-running, #challenge-running, #challenge-stage, #cf-please-wait",
      );
      return noChallenge && noCfElements;
    }).catch(() => false);

    return challengeGone;
  } catch {
    return false;
  }
}

/**
 * Tente de résoudre le Turnstile interactif via clic CDP.
 *
 * STRATÉGIE MULTI-TENTATIVES :
 *   1. Trouver l'iframe Turnstile dans le DOM
 *   2. Attendre que l'iframe soit prête (loaded + visible)
 *   3. Calculer les coordonnées de la checkbox
 *   4. Effectuer un clic CDP humanisé
 *   5. Attendre la résolution (cf_clearance ou disparition du challenge)
 *   6. Si échec → retry avec nouvelles coordonnées (CF peut déplacer la checkbox)
 */
async function solveTurnstileByClick(
  page: Page,
  options: CfSolveOptions,
): Promise<CfSolveResult> {
  const t0 = Date.now();
  const maxClicks = options.maxTurnstileClicks ?? 5;
  const clickDelay = options.clickRetryDelay ?? 2_000;
  const timeout = options.timeout ?? 90_000;
  const domain = options.targetUrl ? new URL(options.targetUrl).hostname : undefined;

  console.log(`${LOG_PREFIX} 🔘 Résolution Turnstile par clic CDP (max ${maxClicks} tentatives)…`);

  // Délai post-navigation variable (1.5–3.5 s) — CF peut charger l'iframe en lazy
  const postNavDelay = 1500 + Math.random() * 2000;
  console.log(`${LOG_PREFIX} ⏳ Délai post-navigation: ${Math.round(postNavDelay)}ms…`);
  await new Promise((r) => setTimeout(r, postNavDelay));

  for (let attempt = 1; attempt <= maxClicks; attempt++) {
    if (Date.now() - t0 > timeout) {
      return {
        success: false,
        challengeType: "turnstile",
        durationMs: Date.now() - t0,
        error: `Timeout ${timeout}ms atteint après ${attempt - 1} tentatives`,
      };
    }

    console.log(`${LOG_PREFIX} 🔄 Tentative clic ${attempt}/${maxClicks}…`);
    console.log(`${LOG_PREFIX} 🔄 Tentative clic ${attempt}/${maxClicks}…`);

    // CF 2026 : le widget n'est PAS une <iframe> dans le DOM — chercher via input[id*="cf-chl-widget"]
    const widgetCoords = await findTurnstileWidgetCoords(page);

    if (!widgetCoords) {
      if (attempt < maxClicks) {
        console.log(`${LOG_PREFIX} ⏳ Widget CF absent — attente ${clickDelay}ms…`);
        await new Promise((r) => setTimeout(r, clickDelay));
        if (await isTurnstileResolved(page, domain)) {
          const clearance = await getClearanceValue(page, domain);
          return { success: true, challengeType: "managed", cfClearance: clearance ?? undefined, durationMs: Date.now() - t0, solvedBy: "jsd_passive" };
        }
        continue;
      }
      return { success: false, challengeType: "turnstile", durationMs: Date.now() - t0, error: "Widget CF Turnstile introuvable apres toutes les tentatives" };
    }

    // Coordonnees de clic (checkbox a ~33px du bord gauche, centree verticalement)
    const coords = computeCfWidgetClickCoords(widgetCoords);
    console.log(`${LOG_PREFIX} 🖱️ Clic CF widget [${Math.round(coords.x)}, ${Math.round(coords.y)}] (conteneur: ${widgetCoords.w}x${widgetCoords.h})`);


    // Clic CDP humanisé
    await humanLikeCdpClick(page, coords.x, coords.y);

    // Attendre la résolution (max clickDelay * 3 ou 8s)
    const postClickWait = Math.max(clickDelay * 3, 8_000);
    console.log(`${LOG_PREFIX} ⏳ Attente résolution post-clic (max ${Math.round(postClickWait / 1000)}s)…`);

    const checkDeadline = Date.now() + postClickWait;
    while (Date.now() < checkDeadline) {
      if (await isTurnstileResolved(page, domain)) {
        const clearance = await getClearanceValue(page, domain);
        console.log(
          `${LOG_PREFIX} ✅ Turnstile résolu par clic CDP (tentative ${attempt})` +
          ` — cf_clearance: ${clearance?.slice(0, 30) ?? "absent (challenge disparu)"}…`,
        );
        return {
          success: true,
          challengeType: "turnstile",
          cfClearance: clearance ?? undefined,
          durationMs: Date.now() - t0,
          solvedBy: "turnstile_cdp",
        };
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    // Vérifier si l'iframe a changé d'état (spinning, checkmark, erreur)
    try {
      const iframeState = await page.evaluate(() => {
        const cfIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]') as HTMLIFrameElement;
        if (!cfIframe) return "absent";
        const box = cfIframe.getBoundingClientRect();
        if (box.width < 10 || box.height < 10) return "hidden";
        // Check aria-label for state info
        const label = cfIframe.getAttribute("aria-label") ?? cfIframe.title ?? "";
        if (label.toLowerCase().includes("success") || label.toLowerCase().includes("verified")) return "success";
        if (label.toLowerCase().includes("error") || label.toLowerCase().includes("fail")) return "error";
        return "visible";
      }).catch(() => "unknown");

      console.log(`${LOG_PREFIX} 🔍 État iframe post-clic: ${iframeState}`);

      if (iframeState === "success") {
        // Attendre un peu plus pour que cf_clearance apparaisse
        await new Promise((r) => setTimeout(r, 3_000));
        const clearance = await getClearanceValue(page, domain);
        if (clearance) {
          return {
            success: true,
            challengeType: "turnstile",
            cfClearance: clearance,
            durationMs: Date.now() - t0,
            solvedBy: "turnstile_cdp",
          };
        }
      }
    } catch { /* non-fatal */ }

    // Délai aléatoire entre tentatives (comportement humain + anti-rate-limit)
    if (attempt < maxClicks) {
      const jitteredDelay = clickDelay + Math.random() * 1_000;
      console.log(`${LOG_PREFIX} ⏳ Délai inter-tentative: ${Math.round(jitteredDelay)}ms`);
      await new Promise((r) => setTimeout(r, jitteredDelay));
    }
  }

  return {
    success: false,
    challengeType: "turnstile",
    durationMs: Date.now() - t0,
    error: `Turnstile non résolu après ${maxClicks} tentatives de clic CDP`,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getClearanceValue(page: Page, domain?: string): Promise<string | null> {
  try {
    const cookies = domain
      ? await page.cookies(`https://${domain}`)
      : await page.cookies();
    return cookies.find((c) => c.name === "cf_clearance" && c.value.length > 10)?.value ?? null;
  } catch {
    return null;
  }
}

async function getAllCookies(page: Page, domain?: string): Promise<Array<{ name: string; value: string }>> {
  try {
    const cookies = domain
      ? await page.cookies(`https://${domain}`)
      : await page.cookies();
    return cookies.map((c) => ({ name: c.name, value: c.value }));
  } catch {
    return [];
  }
}

// ─── Solver principal ───────────────────────────────────────────────────────

/**
 * Résout n'importe quel challenge Cloudflare présent sur la page.
 *
 * FLUX DE RÉSOLUTION :
 *   1. Détecter le type de challenge
 *   2. Appliquer la stratégie appropriée :
 *      - JSD/IUAM → attente passive (le navigateur résout seul)
 *      - Managed → attente JSD d'abord, puis Turnstile click si nécessaire
 *      - Turnstile → clic CDP humanisé dans l'iframe cross-origin
 *      - Blocked → échec immédiat (pas de challenge possible)
 *      - None → succès immédiat (déjà résolu)
 *   3. Si toutes les stratégies natives échouent → fallback CapSolver (si configuré)
 *   4. Extraire et retourner cf_clearance + cookies
 *
 * @param page - Page Puppeteer avec le challenge CF chargé
 * @param options - Options de résolution
 * @returns Résultat du solve avec cf_clearance si succès
 */
export async function solveCfChallenge(
  page: Page,
  options: CfSolveOptions = {},
): Promise<CfSolveResult> {
  const t0 = Date.now();
  const timeout = options.timeout ?? 90_000;
  // Domain extracted from targetUrl, falling back to cfDomain from options cast as CfSolveWithRetryOptions
  const retryOpts = options as CfSolveWithRetryOptions;
  const domain =
    options.targetUrl
      ? new URL(options.targetUrl).hostname
      : retryOpts.cfDomain ?? undefined;

  console.log(`${LOG_PREFIX} 🚀 Début résolution challenge CF — timeout: ${timeout / 1000}s`);

  // ── Task 7.1 : Vérification du cache avant toute navigation ──────────────
  if (domain) {
    const cached = getCachedSession(domain);
    if (cached) {
      const ttlS = Math.round(cached.ttlRemainingMs / 1000);
      console.log(`${LOG_PREFIX} 💾 Cache hit — domaine: ${domain} — TTL restant: ${ttlS}s`);
      _recordCacheHit();
      const result: CfSolveResult = {
        success: true,
        challengeType: "none",
        cfClearance: cached.session.cfClearance,
        durationMs: Date.now() - t0,
        solvedBy: "already_cleared",
        allCookies: cached.session.cookies,
      };
      _recordSolve(result.durationMs);
      return result;
    }
    _recordCacheMiss();
  }

  // ── Simuler un onglet au premier plan (Req 2.9) ───────────────────────────
  await page.bringToFront().catch(() => {});

  // ── Étape 1 : Détecter le type de challenge ──────────────────────────────
  let challengeType = await detectChallengeType(page);
  console.log(`${LOG_PREFIX} 🔍 Type de challenge détecté: ${challengeType}`);

  // Helper local : retourner succès + mettre en cache + enregistrer métriques
  const returnSuccess = async (
    type: CfChallengeType,
    solvedBy: NonNullable<CfSolveResult["solvedBy"]>,
    cfClearance?: string,
  ): Promise<CfSolveResult> => {
    const durationMs = Date.now() - t0;
    const allCookies = await getAllCookies(page, domain);

    // Mettre en cache la session si on a un domaine et un cf_clearance
    if (domain && cfClearance) {
      // Lire l'expiration du cookie cf_clearance (en secondes, epoch Unix)
      let expiresAt: number;
      try {
        const cookieUrl = domain ? `https://${domain}` : undefined;
        const cookies = cookieUrl ? await page.cookies(cookieUrl) : await page.cookies();
        const cfCookie = cookies.find((c) => c.name === "cf_clearance");
        expiresAt =
          cfCookie && cfCookie.expires > 0
            ? cfCookie.expires * 1000
            : Date.now() + 2 * 60 * 60 * 1000; // 2 h par défaut
      } catch {
        expiresAt = Date.now() + 2 * 60 * 60 * 1000;
      }

      const session: CfSession = {
        cfClearance,
        cookies: allCookies,
        obtainedAt: Date.now(),
        expiresAt,
      };
      setCachedSession(domain, session);
      console.log(`${LOG_PREFIX} 💾 Session mise en cache — domaine: ${domain} — expiresAt: ${new Date(expiresAt).toISOString()}`);
    }

    _recordSolve(durationMs);
    return {
      success: true,
      challengeType: type,
      cfClearance,
      durationMs,
      solvedBy,
      allCookies,
    };
  };

  // Helper local : retourner échec + enregistrer métriques
  const returnFailure = (
    type: CfChallengeType,
    error: string,
  ): CfSolveResult => {
    const durationMs = Date.now() - t0;
    _recordSolve(durationMs);
    return {
      success: false,
      challengeType: type,
      durationMs,
      error,
    };
  };

  // ── Task 7.2 : Cas trivial — pas de challenge ─────────────────────────────
  if (challengeType === "none") {
    const clearance = await getClearanceValue(page, domain);
    return returnSuccess("none", "already_cleared", clearance ?? undefined);
  }

  // ── Task 7.2 : Cas bloqué — IP refusée ───────────────────────────────────
  if (challengeType === "blocked") {
    return returnFailure(
      "blocked",
      "IP bloquée par Cloudflare (Access Denied) — rotation proxy nécessaire",
    );
  }

  // ── Étape 2 : Résolution selon le type ────────────────────────────────────

  // STRATÉGIE 1 : Attente passive JSD (pour jsd, managed, iuam, unknown)
  // CF JSD s'exécute automatiquement dans le navigateur si le fingerprint est valide.
  // C'est la méthode la plus fiable et la moins détectable.
  if (["jsd", "managed", "iuam", "unknown"].includes(challengeType)) {
    // Task 7.2 : Timeouts JSD passifs selon le type détecté
    //   jsd=65s, iuam=45s, managed=30s, unknown=65s
    const passiveTimeout =
      challengeType === "iuam"    ? 45_000 :
      challengeType === "managed" ? 30_000 : 65_000;

    console.log(
      `${LOG_PREFIX} ⏳ Attente JSD passive (${challengeType}) — max ${passiveTimeout / 1000}s…`,
    );

    const clearance = await waitForClearance(page, passiveTimeout, domain);
    if (clearance) {
      const solveMs = Date.now() - t0;
      const solvedBy: NonNullable<CfSolveResult["solvedBy"]> =
        challengeType === "iuam" ? "iuam_wait" : "jsd_passive";
      console.log(
        `${LOG_PREFIX} ✅ Challenge résolu passivement (${solvedBy}) en ${Math.round(solveMs / 1000)}s` +
        (solveMs < 3_000 ? " ⚡ IP de confiance CF (fast-track)" : ""),
      );
      return returnSuccess(challengeType, solvedBy, clearance);
    }

    // Task 7.2 : JSD passif n'a pas fonctionné — re-détecter
    challengeType = await detectChallengeType(page);
    console.log(`${LOG_PREFIX} 🔍 Re-détection après JSD passif: ${challengeType}`);

    // Task 7.2 : Si résolu entre-temps → none
    if (challengeType === "none") {
      const clearanceValue = await getClearanceValue(page, domain);
      return returnSuccess("none", "jsd_passive", clearanceValue ?? undefined);
    }

    // Task 7.2 : Si toujours jsd/unknown → forcer clic Turnstile
    // CF peut afficher un Turnstile invisible ou un managed challenge dégradé
    if (challengeType === "jsd" || challengeType === "unknown") {
      console.log(`${LOG_PREFIX} 🔄 JSD bloqué → forçage fallback clic Turnstile`);
      challengeType = "turnstile";
    }
  }

  // STRATÉGIE 2 : Clic Turnstile CDP (pour turnstile, managed post-JSD)
  // Task 7.2 : turnstile → directement sans attente JSD
  if (["turnstile", "managed", "turnstile_invis", "unknown"].includes(challengeType)) {
    const remainingTimeout = Math.max(10_000, timeout - (Date.now() - t0));
    const clickResult = await solveTurnstileByClick(page, {
      ...options,
      timeout: remainingTimeout,
    });

    if (clickResult.success) {
      const clearance = clickResult.cfClearance ?? await getClearanceValue(page, domain);
      return returnSuccess(clickResult.challengeType, "turnstile_cdp", clearance ?? undefined);
    }

    console.warn(`${LOG_PREFIX} ⚠️ Clic Turnstile CDP échoué: ${clickResult.error}`);
  }

  // STRATÉGIE 3 : Fallback CapSolver (dernier recours)
  // Task 7.2 : conditionnel à CAPSOLVER_API_KEY défini
  const capsolverKey = options.capsolverApiKey ?? process.env.CAPSOLVER_API_KEY;
  const enableFallback = options.enableCapsolverFallback !== false;

  if (enableFallback && capsolverKey) {
    console.log(`${LOG_PREFIX} 🔁 Fallback CapSolver activé (dernier recours)…`);
    try {
      const { solveTurnstileInPage } = await import("./capsolver-turnstile.js");
      const targetUrl = options.targetUrl ?? page.url();
      const solved = await solveTurnstileInPage(page, targetUrl, capsolverKey);

      if (solved) {
        const clearance = await getClearanceValue(page, domain);
        console.log(`${LOG_PREFIX} ✅ Challenge résolu via CapSolver fallback`);
        return returnSuccess(challengeType, "capsolver_fallback", clearance ?? undefined);
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} ⚠️ CapSolver fallback échoué: ${err}`);
    }
  }

  // ── Échec total ──────────────────────────────────────────────────────────
  const finalTitle = await page.title().catch(() => "?");
  const finalUrl = page.url();
  console.error(
    `${LOG_PREFIX} ❌ Échec résolution challenge CF` +
    ` | type: ${challengeType}` +
    ` | titre: "${finalTitle}"` +
    ` | url: ${finalUrl.slice(0, 60)}` +
    ` | durée: ${Math.round((Date.now() - t0) / 1000)}s`,
  );

  return returnFailure(
    challengeType,
    `Toutes les stratégies ont échoué (JSD passif + Turnstile clic CDP${enableFallback && capsolverKey ? " + CapSolver" : ""})`,
  );
}

// ─── Stealth enrichment (WebGL, plugins, Client Hints, webdriver) ───────────

/**
 * Prépare une page Puppeteer avec le stealth enrichi inspiré de spain-persistent-browser.
 *
 * SIGNAUX BOT CRITIQUES patchés :
 *   • navigator.webdriver = true → undefined
 *   • navigator.plugins = [] → PDF Viewer (comme Chrome réel)
 *   • navigator.mimeTypes = [] → application/pdf + text/pdf
 *   • WebGL UNMASKED_RENDERER = "SwiftShader" → Intel UHD Graphics 620
 *   • Permissions "notifications" → "prompt" (headless retourne "denied")
 *   • window.chrome enrichi (app, csi, loadTimes, runtime)
 *   • window.alert/confirm/prompt supprimés (citaconsular.es les utilise)
 *   • Turnstile sitekey intercepté via evaluateOnNewDocument
 *   • Client Hints CDP alignés avec l'UA
 */
export async function preparePageStealth(
  page: Page,
  ua?: string,
  geoTimezone?: string,
): Promise<void> {
  const userAgent = ua ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const navPlatform = /Macintosh/i.test(userAgent) ? "MacIntel" : /Windows NT/i.test(userAgent) ? "Win32" : "Linux x86_64";
  const navLanguages = ["fr-FR", "fr", "en-US", "en"];

  // UA + viewport
  await page.setUserAgent(userAgent);
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  // Client Hints CDP — aligner sec-ch-ua avec l'UA
  try {
    const cdpUA = await page.createCDPSession();
    const chromeVer = userAgent.match(/Chrome\/([\d]+)/)?.[1] ?? "136";
    const cdpPlatform = navPlatform === "MacIntel" ? "macOS" : navPlatform === "Win32" ? "Windows" : "Linux";
    const cdpPlatformVer = navPlatform === "MacIntel" ? "10_15_7" : navPlatform === "Win32" ? "10.0.0" : "5.15.0";
    const cdpArch = navPlatform === "Linux x86_64" ? "x86_64" : "x86";
    await cdpUA.send("Network.setUserAgentOverride", {
      userAgent,
      acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      userAgentMetadata: {
        brands: [
          { brand: "Not A;Brand", version: "99" },
          { brand: "Chromium", version: chromeVer },
          { brand: "Google Chrome", version: chromeVer },
        ],
        fullVersion: `${chromeVer}.0.0.0`,
        platform: cdpPlatform,
        platformVersion: cdpPlatformVer,
        architecture: cdpArch,
        model: "",
        mobile: false,
      },
    });
    await cdpUA.detach().catch(() => {});
    console.log(`${LOG_PREFIX} 🪪 Client Hints CDP alignés — Chrome/${chromeVer} ${cdpPlatform}`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} ⚠️ CDP setUserAgentOverride (non-fatal): ${err}`);
  }

  // Intercepter le sitekey Turnstile dynamique (CF render=explicit)
  await (page as any).evaluateOnNewDocument(TURNSTILE_INTERCEPT_SCRIPT);

  // Dismiss window.alert/confirm/prompt — citaconsular.es les utilise
  await (page as any).evaluateOnNewDocument(() => {
    (window as any).alert = () => {};
    (window as any).confirm = () => true;
    (window as any).prompt = () => "";
  });
  page.on("dialog", async (dialog: Dialog) => {
    console.log(`${LOG_PREFIX} ⚠️ Dialog natif (${dialog.type()}): "${dialog.message().slice(0, 80)}" → accept`);
    await dialog.accept().catch(() => undefined);
  });

  // Script de stealth enrichi (webdriver, platform, languages, plugins, WebGL, chrome)
  await (page as any).evaluateOnNewDocument(
    (langs: string[], platform: string) => {
      // webdriver
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      // platform + languages
      Object.defineProperty(navigator, "platform", { get: () => platform });
      Object.defineProperty(navigator, "languages", { get: () => langs });

      // navigator.plugins + mimeTypes (PDF plugin simulé — Chrome réel a toujours ça)
      const makeMime = (type: string, desc: string, suffixes: string) => {
        const m = { type, description: desc, suffixes, enabledPlugin: null as any };
        return m;
      };
      const pdfMime1 = makeMime("application/pdf", "Portable Document Format", "pdf");
      const pdfMime2 = makeMime("text/pdf", "Portable Document Format", "pdf");
      const pdfPlugin = {
        name: "PDF Viewer",
        description: "Portable Document Format",
        filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
        length: 2,
        0: pdfMime1,
        1: pdfMime2,
        item: (i: number) => [pdfMime1, pdfMime2][i] ?? null,
        namedItem: (n: string) => ({ "application/pdf": pdfMime1, "text/pdf": pdfMime2 }[n] ?? null),
      };
      const pluginArr = [pdfPlugin];
      Object.defineProperty(pluginArr, "item", { value: (i: number) => pluginArr[i] ?? null });
      Object.defineProperty(pluginArr, "namedItem", { value: (n: string) => pluginArr.find((p) => p.name === n) ?? null });
      Object.defineProperty(pluginArr, "refresh", { value: () => {} });
      Object.defineProperty(navigator, "plugins", { get: () => pluginArr, configurable: true });
      const mimeArr = [pdfMime1, pdfMime2];
      Object.defineProperty(mimeArr, "item", { value: (i: number) => mimeArr[i] ?? null });
      Object.defineProperty(mimeArr, "namedItem", {
        value: (n: string) => mimeArr.find((m) => m.type === n) ?? null,
      });
      Object.defineProperty(navigator, "mimeTypes", { get: () => mimeArr, configurable: true });

      // Permissions API → "notifications" retourne "prompt"
      const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
      if (origQuery) {
        (navigator.permissions as any).query = (params: any) => {
          if (params?.name === "notifications") {
            return Promise.resolve({ state: "prompt", onchange: null });
          }
          return origQuery(params);
        };
      }

      // WebGL renderer/vendor — cacher SwiftShader (signature headless VM)
      const UNMASKED_VENDOR = 0x9245;
      const UNMASKED_RENDERER = 0x9246;
      const fakeVendor = "Intel Inc.";
      const fakeRenderer = platform === "MacIntel"
        ? "Intel Iris OpenGL Engine"
        : "Intel(R) UHD Graphics 620";
      const patchWebGL = (Ctx: any) => {
        if (!Ctx) return;
        const orig = Ctx.prototype.getParameter;
        Ctx.prototype.getParameter = function (param: number) {
          if (param === UNMASKED_VENDOR) return fakeVendor;
          if (param === UNMASKED_RENDERER) return fakeRenderer;
          return orig.call(this, param);
        };
      };
      patchWebGL((window as any).WebGLRenderingContext);
      patchWebGL((window as any).WebGL2RenderingContext);

      // window.chrome enrichi
      const noop = () => undefined;
      (window as any).chrome = {
        app: {
          isInstalled: false,
          InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
          RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
          getDetails: noop, getIsInstalled: noop, runningState: noop,
        },
        csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 200, tran: 15 }),
        loadTimes: () => ({
          requestTime: Date.now() / 1000 - 0.4,
          startLoadTime: Date.now() / 1000 - 0.35,
          commitLoadTime: Date.now() / 1000 - 0.3,
          finishDocumentLoadTime: Date.now() / 1000 - 0.2,
          finishLoadTime: Date.now() / 1000 - 0.1,
          firstPaintTime: 0, firstPaintAfterLoadTime: 0,
          navigationType: "Other",
          wasFetchedViaSpdy: true, wasNpnNegotiated: true,
          npnNegotiatedProtocol: "h2",
          wasAlternateProtocolAvailable: false, connectionInfo: "h2",
        }),
        runtime: {
          PlatformOs: { MAC: "mac", WIN: "win", ANDROID: "android", CROS: "cros", LINUX: "linux", OPENBSD: "openbsd" },
          PlatformArch: { ARM: "arm", ARM64: "arm64", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
          PlatformNaclArch: { ARM: "arm", X86_32: "x86-32", X86_64: "x86-64", MIPS: "mips", MIPS64: "mips64" },
          RequestUpdateCheckStatus: { THROTTLED: "throttled", NO_UPDATE: "no_update", UPDATE_AVAILABLE: "update_available" },
          OnInstalledReason: { INSTALL: "install", UPDATE: "update", CHROME_UPDATE: "chrome_update", SHARED_MODULE_UPDATE: "shared_module_update" },
          OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
          connect: noop, sendMessage: noop, id: undefined,
        },
      };
    },
    navLanguages,
    navPlatform,
  );

  // Nouveaux patches v2 : AudioContext noise, Canvas noise, Battery API, connection, webdriver Proxy
  await (page as any).evaluateOnNewDocument(() => {
    const sessionSalt = Math.floor(Math.random() * 1000);

    // navigator.webdriver — Proxy-trap pattern (plus fort que simple defineProperty)
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: new Proxy(() => undefined, {
          apply: () => undefined,
        }),
        configurable: true,
      });
    } catch { /* déjà défini par le patch v1, non-fatal */ }

    // AudioContext noise déterministe par session
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (channel: number) {
      const data = origGetChannelData.call(this, channel);
      // Appliquer un bruit déterministe (1 sur 100 samples) basé sur sessionSalt
      for (let i = 0; i < data.length; i += 100) {
        data[i] = data[i] + (sessionSalt * 0.0001 * (i % 13 === 0 ? 1 : -1)) * 0.0001;
      }
      return data;
    };

    try {
      const origGetFloatFrequencyData = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function (array: Float32Array<ArrayBuffer>) {
        origGetFloatFrequencyData.call(this, array as Float32Array<ArrayBuffer>);
        for (let i = 0; i < array.length; i += 50) {
          array[i] = array[i] + (sessionSalt % 10) * 0.001;
        }
      };
    } catch { /* AnalyserNode peut ne pas être accessible */ }

    // Canvas noise déterministe par session
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args: unknown[]) {
      const ctx = this.getContext("2d");
      if (ctx && this.width > 0 && this.height > 0) {
        // Modifier 1 pixel dans un coin non visible
        const x = sessionSalt % Math.max(1, this.width);
        const y = Math.floor(sessionSalt / 1000) % Math.max(1, this.height);
        const imageData = ctx.getImageData(x, y, 1, 1);
        imageData.data[0] = (imageData.data[0] + sessionSalt) % 256;
        ctx.putImageData(imageData, x, y);
      }
      return (origToDataURL as (...a: unknown[]) => string).apply(this, args);
    };

    // Battery API (headless Chrome n'expose pas getBattery)
    (navigator as any).getBattery = () =>
      Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1.0,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      });

    // navigator.connection
    Object.defineProperty(navigator, "connection", {
      get: () => ({
        effectiveType: "4g",
        downlink: 10,
        rtt: 50,
        saveData: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      configurable: true,
    });
  });

  // Patch timezone si geoTimezone fourni
  if (geoTimezone) {
    const tz = geoTimezone;
    await (page as any).evaluateOnNewDocument((timezone: string) => {
      // Patch Intl.DateTimeFormat pour utiliser la timezone du proxy
      const OrigDateTimeFormat = Intl.DateTimeFormat;
      (Intl as any).DateTimeFormat = function (
        locales?: string | string[],
        options?: Intl.DateTimeFormatOptions,
      ) {
        if (!options?.timeZone) {
          options = { ...options, timeZone: timezone };
        }
        return new OrigDateTimeFormat(locales, options);
      };
      Object.assign(Intl.DateTimeFormat, OrigDateTimeFormat);
      Object.defineProperty(Intl.DateTimeFormat, "prototype", {
        value: OrigDateTimeFormat.prototype,
        writable: false,
        configurable: false,
      });

      // Patch Date.prototype.getTimezoneOffset pour retourner l'offset correct
      const getOffset = () => {
        try {
          const now = new Date();
          const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
          const tzStr = now.toLocaleString("en-US", { timeZone: timezone });
          const utcDate = new Date(utcStr);
          const tzDate = new Date(tzStr);
          return (utcDate.getTime() - tzDate.getTime()) / 60000;
        } catch {
          return 0;
        }
      };
      Date.prototype.getTimezoneOffset = function () {
        return getOffset();
      };
    }, tz);
  }

  console.log(`${LOG_PREFIX} 🛡️ Stealth enrichi appliqué (webdriver, plugins, WebGL, Client Hints, chrome, dialog handler)`);
}

// ─── Purge des données CF stales ────────────────────────────────────────────

/**
 * Purge les données CF accumulées dans le profil du navigateur.
 *
 * PROBLÈME : Le profil accumule des données CF stales (tokens JSD expirés dans
 * localStorage/IndexedDB, service workers qui servent du JS CF mis en cache).
 * CF reçoit un JSD oneshot avec timestamp périmé → rejette → /main/ = 0B.
 *
 * FIX : Storage.clearDataForOrigin + Network.deleteCookies cf_clearance/PHPSESSID
 *       + Network.clearBrowserCache + page.setCacheEnabled(false)
 */
export async function purgeCfStaleData(
  page: Page,
  domain: string = "citaconsular.es",
): Promise<void> {
  try {
    const cdpStorage = await page.createCDPSession();
    // Supprimer cf_clearance + PHPSESSID pour forcer un fresh challenge
    await cdpStorage.send("Network.deleteCookies", {
      name: "cf_clearance",
      domain: `.${domain}`,
    });
    await cdpStorage.send("Network.deleteCookies", {
      name: "PHPSESSID",
      domain: `.${domain}`,
    });
    await cdpStorage.send("Network.deleteCookies", {
      name: "PHPSESSID",
      domain: `www.${domain}`,
    });
    // Purger storage CF (localStorage, IndexedDB, ServiceWorkers, CacheStorage)
    await cdpStorage.send("Storage.clearDataForOrigin", {
      origin: `https://www.${domain}`,
      storageTypes: "local_storage,session_storage,indexeddb,service_workers,cache_storage",
    });
    await cdpStorage.detach().catch(() => {});
    console.log(`${LOG_PREFIX} 🗑️ Données CF purgées (cf_clearance + PHPSESSID + localStorage/SW/IndexedDB)`);
  } catch (err) {
    console.warn(`${LOG_PREFIX} ⚠️ Purge storage CF (non-fatal): ${err}`);
  }

  // Désactiver le cache HTTP pour la page
  try {
    await (page as any).setCacheEnabled(false);
    const cdpCache = await page.createCDPSession();
    await cdpCache.send("Network.enable");
    await cdpCache.send("Network.clearBrowserCache");
    await cdpCache.detach().catch(() => {});
    console.log(`${LOG_PREFIX} 🗑️ Cache HTTP désactivé — nonce frais garanti`);
  } catch { /* non-fatal */ }
}

// ─── Rotation de proxy ──────────────────────────────────────────────────────

/**
 * Construit une URL de proxy avec rotation (sessionid ou pool round-robin).
 *
 * Mode A — Pool multi-URLs (IPs dédiées à ports fixes) :
 *   Avance l'index du pool → port 10001 → 10002 → … → 10001.
 *
 * Mode B — Proxy résidentiel/rotatif (URL unique) :
 *   Ajoute "-sessionid-XXXX" au username → le provider attribue une IP sticky
 *   différente pour chaque valeur de session.
 */
function buildRotatedProxyUrl(baseUrl?: string): string | undefined {
  // Mode A : pool multi-URLs
  if (isDecodoMultiPool()) {
    return rotateDecodoUrl();
  }

  // Mode B : URL unique → rotation via sessionid
  if (!baseUrl) return getCurrentDecodoUrl();

  try {
    const u = new URL(baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`);
    const decodedUser = decodeURIComponent(u.username);
    const sessionId = Math.random().toString(36).slice(2, 10);
    const baseUser = decodedUser.replace(/-sessionid-[a-z0-9]+$/i, "");
    const rotatedUser = `${baseUser}-sessionid-${sessionId}`;
    u.username = encodeURIComponent(rotatedUser);
    const rotated = u.toString();
    const masked = rotated.replace(/:([^:@]+)@/, ":***@");
    console.log(`${LOG_PREFIX} 🔄 Rotation IP proxy — session: ${sessionId} (${masked.slice(0, 70)})`);
    return rotated;
  } catch {
    console.warn(`${LOG_PREFIX} ⚠️ Rotation proxy échouée — utilisation URL originale`);
    return baseUrl;
  }
}

/**
 * Configure l'authentification proxy via CDP Fetch.enable (handleAuthRequests).
 * Nécessaire car Chrome ne supporte pas les credentials dans --proxy-server.
 */
async function setupProxyAuth(
  page: Page,
  proxyUrl: string,
): Promise<CDPSession | null> {
  try {
    const u = new URL(proxyUrl);
    if (!u.username) return null;

    const username = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);

    const client = await page.createCDPSession();
    await client.send("Fetch.enable", { handleAuthRequests: true });

    client.on("Fetch.authRequired", async (event: any) => {
      const { requestId, authChallenge } = event;
      if (authChallenge?.source === "Proxy") {
        await client.send("Fetch.continueWithAuth", {
          requestId,
          authChallengeResponse: {
            response: "ProvideCredentials",
            username,
            password,
          },
        }).catch(() => {});
      } else {
        await client.send("Fetch.continueWithAuth", {
          requestId,
          authChallengeResponse: { response: "Default" },
        }).catch(() => {});
      }
    });

    client.on("Fetch.requestPaused", async (event: any) => {
      await client.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {});
    });

    console.log(`${LOG_PREFIX} 🔧 Proxy auth CDP configuré (${username.slice(0, 8)}…@${u.hostname}:${u.port})`);
    return client;
  } catch (err) {
    console.warn(`${LOG_PREFIX} ⚠️ Setup proxy auth échoué: ${err}`);
    return null;
  }
}

// ─── Navigation avec cache-bust CDN ────────────────────────────────────────

/**
 * Navigue vers la cible avec cache-bust CDN activé.
 *
 * PROBLÈME : CF CDN (SJC PoP) cache la page portail PHP avec le nonce JSD baked-in.
 * Tous les IPs du pool reçoivent la MÊME nonce stale → JSD oneshot rejeté.
 *
 * FIX : Cache-Control: no-cache + _cb=timestamp dans l'URL → cache-miss absolu.
 * Les headers no-cache sont retirés IMMÉDIATEMENT après le goto pour ne pas
 * polluer les XHR widget (comportement naturel d'un vrai navigateur).
 */
async function navigateWithCacheBust(
  page: Page,
  targetUrl: string,
  enableCacheBust: boolean = true,
): Promise<void> {
  if (enableCacheBust) {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
    }).catch(() => {});
  }

  const bustUrl = enableCacheBust
    ? `${targetUrl}${targetUrl.includes("?") ? "&" : "?"}_cb=${Date.now()}`
    : targetUrl;

  console.log(`${LOG_PREFIX} 🌐 Navigation → ${targetUrl.slice(0, 60)}…${enableCacheBust ? " (cache-bust CDN)" : ""}`);
  try {
    await page.goto(bustUrl, { waitUntil: "load", timeout: 70_000 });
  } catch (navErr: unknown) {
    // CF challenge pages souvent timeout car elles ne finissent jamais de charger
    const navErrMsg = navErr instanceof Error ? navErr.message : String(navErr);
    console.warn(`${LOG_PREFIX} ⚠️ Navigation (non-fatal, JSD peut encore s'exécuter): ${navErrMsg.slice(0, 80)}`);
  }

  // Retirer les headers no-cache — les XHR du widget ne doivent pas les porter
  if (enableCacheBust) {
    await page.setExtraHTTPHeaders({
      "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    }).catch(() => {});
  }

  // Vérifier si page d'erreur Chrome (proxy inaccessible)
  const navUrl = page.url();
  if (navUrl.startsWith("chrome-error://") || navUrl.startsWith("about:")) {
    throw new Error(`Navigation échouée — page d'erreur Chrome: ${navUrl} (proxy inaccessible?)`);
  }
}

// ─── Solver robuste avec retry + rotation IP ────────────────────────────────

/**
 * Résout un challenge Cloudflare avec retry, rotation d'IP, et stealth enrichi.
 *
 * C'est la fonction RECOMMANDÉE pour les cas difficiles (citaconsular.es).
 * Elle combine TOUTES les techniques éprouvées du spain-persistent-browser :
 *
 *   1. Stealth enrichi (WebGL, plugins, Client Hints, webdriver patch)
 *   2. Purge des données CF stales (localStorage, IndexedDB, SW, cookies)
 *   3. Cache-bust CDN pour des nonces JSD fraîches à chaque tentative
 *   4. Attente JSD passive (65s) — le vrai Chromium résout le PoW nativement
 *   5. Clic Turnstile CDP humanisé (si checkbox visible)
 *   6. Fallback CapSolver (si configuré)
 *   7. Rotation d'IP entre les tentatives (Decodo pool ou sessionid)
 *
 * FLUX DE RETRY :
 *   Tentative 1 → JSD passif + Turnstile clic + CapSolver → échec
 *   → Rotation IP proxy (nouveau sessionid ou prochain port Decodo)
 *   → Re-navigation avec cache-bust → nonce fraîche
 *   Tentative 2 → même séquence avec IP différente
 *   → …jusqu'à maxRetries tentatives
 *
 * @param page - Page Puppeteer (stealth sera appliqué automatiquement)
 * @param browser - Instance Browser pour rafraîchir la page si nécessaire
 * @param options - Options étendues avec retry et proxy
 * @returns Résultat du solve avec cf_clearance si succès
 */
export async function solveCfChallengeWithRetry(
  page: Page,
  browser: Browser,
  options: CfSolveWithRetryOptions = {},
): Promise<CfSolveResult> {
  const t0 = Date.now();
  const maxRetries = options.maxRetries ?? 5;
  const targetUrl = options.targetUrl ?? page.url();
  const purge = options.purgeStaleData !== false;
  const cacheBust = options.cacheBustCdn !== false;
  const domain = options.cfDomain ?? (targetUrl ? new URL(targetUrl).hostname.replace(/^www\./, "") : "citaconsular.es");
  let proxyUrl = options.proxyUrl ?? getCurrentDecodoUrl();

  console.log(
    `${LOG_PREFIX} 🚀 Résolution CF robuste — max ${maxRetries} tentatives` +
    ` | cible: ${targetUrl.slice(0, 50)}…` +
    ` | proxy: ${proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 50) : "aucun"}`,
  );

  // ── Appliquer stealth enrichi (une seule fois — evaluateOnNewDocument persiste) ──
  await preparePageStealth(page);

  let lastError = "";
  let lastChallengeType: CfChallengeType = "unknown";

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const attemptT0 = Date.now();

    // ── Log standardisé de tentative (Req 6.5) ──
    const maskedProxy = proxyUrl
      ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70)
      : "aucun";
    console.log(`${LOG_PREFIX} 🔄 Tentative ${attempt}/${maxRetries} — proxy: ${maskedProxy}`);

    // ── Purge des données CF stales (Req 6.6) ──
    if (purge) {
      await purgeCfStaleData(page, domain);
    }

    // ── Configuration proxy auth (si proxy fourni) ──
    let proxyClient: CDPSession | null = null;
    if (proxyUrl) {
      proxyClient = await setupProxyAuth(page, proxyUrl);
    }

    // ── Navigation avec cache-bust CDN (Req 6.7) ──
    try {
      await navigateWithCacheBust(page, targetUrl, cacheBust);
    } catch (navErr: unknown) {
      lastError = navErr instanceof Error ? navErr.message : String(navErr);
      console.error(`${LOG_PREFIX} ❌ Navigation échouée: ${lastError}`);
      if (proxyClient) await proxyClient.detach().catch(() => {});
      // Rotation IP + backoff exponentiel pour la prochaine tentative
      if (attempt < maxRetries) {
        proxyUrl = buildRotatedProxyUrl(proxyUrl) ?? proxyUrl;
        const backoffMs = Math.min(Math.pow(2, attempt - 1) * 2_000, 20_000);
        console.log(`${LOG_PREFIX} ⏳ Backoff ${Math.round(backoffMs / 1000)}s avant prochaine tentative…`);
        await new Promise((r) => setTimeout(r, backoffMs));
      }
      continue;
    }

    // ── Rafraîchir la référence page (CF peut redirect → nouvelle Frame) ──
    try {
      const freshPages = await browser.pages();
      if (freshPages.length > 0 && freshPages[0] !== page) {
        page = freshPages[0];
        console.log(`${LOG_PREFIX} 🔄 Référence page rafraîchie (CF redirect détecté)`);
      }
    } catch { /* non-fatal */ }

    // ── Résolution du challenge CF (JSD passif → Turnstile clic → CapSolver) ──
    const solveResult = await solveCfChallenge(page, {
      ...options,
      timeout: Math.min(options.timeout ?? 90_000, 90_000),
      targetUrl,
    });

    if (solveResult.success) {
      solveResult.durationMs = Date.now() - t0;
      console.log(
        `${LOG_PREFIX} 🎉 Challenge CF résolu à la tentative ${attempt}/${maxRetries}` +
        ` en ${Math.round(solveResult.durationMs / 1000)}s` +
        ` via ${solveResult.solvedBy}` +
        ` — cf_clearance: ${solveResult.cfClearance?.slice(0, 30) ?? "absent"}…`,
      );
      if (proxyClient) await proxyClient.detach().catch(() => {});
      return solveResult;
    }

    // ── Échec de cette tentative ──
    lastError = solveResult.error ?? "unknown";
    lastChallengeType = solveResult.challengeType;
    const attemptMs = Date.now() - attemptT0;
    console.warn(
      `${LOG_PREFIX} ⚠️ Tentative ${attempt}/${maxRetries} échouée (${Math.round(attemptMs / 1000)}s)` +
      ` | type: ${lastChallengeType}` +
      ` | erreur: ${lastError}`,
    );

    if (proxyClient) await proxyClient.detach().catch(() => {});

    // ── Rotation IP + backoff exponentiel pour la prochaine tentative (Req 6.2, 6.3, 6.4) ──
    if (attempt < maxRetries) {
      // Rotation d'IP : rotateDecodoUrl() si multi-pool, sinon nouveau sessionid (Req 6.3, 6.4)
      proxyUrl = buildRotatedProxyUrl(proxyUrl) ?? proxyUrl;
      // Backoff exponentiel : 2^(attempt-1) * 2000 ms, plafonné à 20 000 ms (Req 6.2)
      const backoffMs = Math.min(Math.pow(2, attempt - 1) * 2_000, 20_000);
      console.log(`${LOG_PREFIX} ⏳ Backoff ${Math.round(backoffMs / 1000)}s avant prochaine tentative…`);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  // ── Échec total ──
  const totalMs = Date.now() - t0;
  console.error(
    `${LOG_PREFIX} ❌ ÉCHEC TOTAL — ${maxRetries} tentatives épuisées en ${Math.round(totalMs / 1000)}s` +
    ` | dernier type: ${lastChallengeType}` +
    ` | dernière erreur: ${lastError}`,
  );

  return {
    success: false,
    challengeType: lastChallengeType,
    durationMs: totalMs,
    error: `Échec après ${maxRetries} tentatives avec rotation IP: ${lastError}`,
  };
}

// ─── Utilitaire : monitoring continu des challenges ─────────────────────────

/**
 * Surveille une page pour détecter l'apparition d'un challenge CF et le résoudre
 * automatiquement. Utile pour les sessions longues (persistent-browser).
 *
 * @param page - Page Puppeteer à surveiller
 * @param options - Options de résolution
 * @param onSolved - Callback appelé quand un challenge est résolu
 * @returns Fonction d'arrêt du monitoring
 */
export function monitorAndSolveChallenges(
  page: Page,
  options: CfSolveOptions = {},
  onSolved?: (result: CfSolveResult) => void,
): () => void {
  let running = true;
  let solving = false;

  const checkInterval = setInterval(async () => {
    if (!running || solving) return;

    try {
      const challengeType = await detectChallengeType(page);
      if (challengeType !== "none" && challengeType !== "blocked") {
        solving = true;
        console.log(`${LOG_PREFIX} 🔔 Challenge CF détecté en monitoring: ${challengeType}`);

        const result = await solveCfChallenge(page, options);
        if (onSolved) onSolved(result);

        solving = false;
      }
    } catch {
      solving = false;
    }
  }, 5_000); // Check toutes les 5s

  return () => {
    running = false;
    clearInterval(checkInterval);
  };
}

// ─── Export des utilitaires internes (pour tests et diagnostic) ──────────────

export {
  findTurnstileIframe,
  computeTurnstileClickCoords,
  humanLikeCdpClick,
  waitForClearance,
  isTurnstileResolved,
  getClearanceValue,
  getAllCookies,
  buildRotatedProxyUrl,
};
