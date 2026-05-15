/**
 * captcha-gate.ts — Détection et résolution automatique du CAPTCHA au login USA.
 *
 * Le portail USA peut activer dynamiquement un reCAPTCHA v2 sur la page de login
 * via l'endpoint GET /globalconfiguration/getby/Captcha.
 * Quand `globalValue === "true"`, le login Angular exige un token reCAPTCHA valide.
 *
 * Ce module :
 *  1. Vérifie la configuration CAPTCHA du portail (warm-up GET déjà fait)
 *  2. Si activé, résout le reCAPTCHA v2 via 2captcha (clé API dans TWOCAPTCHA_API_KEY)
 *  3. Retourne le token à injecter dans le login, ou null si pas requis
 *
 * Le portail n'envoie PAS le token reCAPTCHA dans le body du POST /login
 * (contrairement à ce qu'on pourrait penser). D'après le bundle Angular,
 * le reCAPTCHA est validé côté client AVANT d'autoriser le submit du formulaire.
 * Le serveur valide le token reCAPTCHA via l'API Google séparément (server-side verification).
 *
 * Si le serveur exige le token dans le body, il faudra l'ajouter au payload login.
 * Pour l'instant, on suit le pattern du bundle : le CAPTCHA bloque le submit côté client,
 * donc pour notre bot headless, on résout le CAPTCHA et on l'envoie dans un champ dédié.
 */

import { usaFetch, getBrowserHeaders } from "./usa-http.js";
import { USA_BASE, REFERER_LOGIN } from "./config.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const TWOCAPTCHA_API_KEY = process.env.TWOCAPTCHA_API_KEY ?? "";
const CAPTCHA_CONFIG_URL = `${USA_BASE}/visaadministrationapi/v1/globalconfiguration/getby/Captcha`;
const LOGIN_PAGE_URL = `${USA_BASE}/visaapplicantui/login`;

// Fallback siteKey extraite du bundle Angular (peut changer côté serveur)
const FALLBACK_SITE_KEY = "6LcpAXklAAAAAFUYDDE8NlsuSb69b5GbXg3sEmaZ";

// 2captcha polling
const TWOCAPTCHA_BASE = "https://api.2captcha.com";
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 36; // 3 min max

// ─── Interfaces ─────────────────────────────────────────────────────────────

interface CaptchaConfig {
  /** true si le portail exige un CAPTCHA au login */
  required: boolean;
  /** siteKey reCAPTCHA du portail */
  siteKey: string;
}

interface CreateTaskResponse {
  errorId: number;
  taskId?: number;
  errorCode?: string;
  errorDescription?: string;
}

interface GetResultResponse {
  errorId: number;
  status: "processing" | "ready";
  solution?: { gRecaptchaResponse?: string; token?: string };
  errorCode?: string;
}

// ─── Détection ──────────────────────────────────────────────────────────────

/**
 * Vérifie si le portail a activé le CAPTCHA au login.
 *
 * Appelle GET /globalconfiguration/getby/Captcha (même endpoint que le warm-up)
 * et parse la réponse pour déterminer si le CAPTCHA est requis.
 *
 * Réponse attendue du portail (d'après le bundle) :
 *   [{ globalValue: "true"|"false", recaptchaSiteKey: "6Lc..." }]
 */
export async function checkCaptchaConfig(): Promise<CaptchaConfig> {
  try {
    const headers = {
      ...getBrowserHeaders(),
      "Referer": REFERER_LOGIN,
    };
    // GET sans Content-Type (comme un navigateur)
    delete (headers as Record<string, string | undefined>)["Content-Type"];

    const res = await usaFetch(CAPTCHA_CONFIG_URL, {
      method: "GET",
      headers,
    });

    if (!res.ok) {
      console.log(`[captcha-gate] GET Captcha config HTTP ${res.status} — assume pas requis`);
      return { required: false, siteKey: "" };
    }

    const body = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      console.warn(`[captcha-gate] Réponse non-JSON: ${body.slice(0, 100)}`);
      return { required: false, siteKey: "" };
    }

    // Le portail retourne un tableau : [{ globalValue: "true", recaptchaSiteKey: "..." }]
    const arr = Array.isArray(data) ? data : [data];
    const config = arr[0] as Record<string, unknown> | undefined;

    if (!config) {
      return { required: false, siteKey: "" };
    }

    const globalValue = String(config.globalValue ?? "false").toLowerCase();
    const siteKey = String(config.recaptchaSiteKey ?? config.siteKey ?? FALLBACK_SITE_KEY);

    const required = globalValue === "true";

    if (required) {
      console.log(`[captcha-gate] ⚠️ CAPTCHA ACTIVÉ par le portail — siteKey: ${siteKey.slice(0, 12)}...`);
    } else {
      console.log(`[captcha-gate] ✅ CAPTCHA désactivé (globalValue=${globalValue})`);
    }

    return { required, siteKey };
  } catch (err) {
    // Erreur réseau : on assume pas de CAPTCHA (le login échouera de toute façon si requis)
    console.warn(`[captcha-gate] Erreur vérification CAPTCHA config: ${err instanceof Error ? err.message : err}`);
    return { required: false, siteKey: "" };
  }
}

// ─── Résolution ─────────────────────────────────────────────────────────────

/**
 * Résout le reCAPTCHA v2 du portail USA via 2captcha.
 *
 * Utilise l'API createTask (format moderne, compatible avec le captcha-service).
 * Le token obtenu est valide ~2 minutes — il faut l'utiliser immédiatement après.
 *
 * @returns Token reCAPTCHA, ou null si la résolution échoue
 */
export async function solveLoginCaptcha(siteKey: string): Promise<string | null> {
  if (!TWOCAPTCHA_API_KEY) {
    console.error("[captcha-gate] ❌ TWOCAPTCHA_API_KEY non configurée — impossible de résoudre le CAPTCHA");
    console.error("[captcha-gate] Ajoutez TWOCAPTCHA_API_KEY dans les variables d'environnement");
    return null;
  }

  console.log(`[captcha-gate] 🔐 Résolution reCAPTCHA v2 via 2captcha...`);
  console.log(`[captcha-gate]    siteKey: ${siteKey.slice(0, 12)}...`);
  console.log(`[captcha-gate]    pageUrl: ${LOGIN_PAGE_URL}`);

  // 1. Créer la tâche
  const taskId = await createRecaptchaTask(siteKey);
  if (!taskId) return null;

  // 2. Poller le résultat
  const token = await pollTaskResult(taskId);

  if (token) {
    console.log(`[captcha-gate] ✅ reCAPTCHA résolu (token: ${token.length} chars)`);
  } else {
    console.error(`[captcha-gate] ❌ Résolution échouée après ${MAX_POLL_ATTEMPTS} tentatives`);
  }

  return token;
}

async function createRecaptchaTask(siteKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${TWOCAPTCHA_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: TWOCAPTCHA_API_KEY,
        task: {
          type: "RecaptchaV2TaskProxyless",
          websiteURL: LOGIN_PAGE_URL,
          websiteKey: siteKey,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json()) as CreateTaskResponse;

    if (data.errorId !== 0 || !data.taskId) {
      console.error(`[captcha-gate] createTask erreur: ${data.errorCode ?? data.errorId} — ${data.errorDescription ?? ""}`);
      return null;
    }

    console.log(`[captcha-gate] Tâche créée: ${data.taskId}`);
    return String(data.taskId);
  } catch (err) {
    console.error(`[captcha-gate] createTask réseau: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

async function pollTaskResult(taskId: string): Promise<string | null> {
  for (let i = 1; i <= MAX_POLL_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const res = await fetch(`${TWOCAPTCHA_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientKey: TWOCAPTCHA_API_KEY,
          taskId: Number(taskId),
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const data = (await res.json()) as GetResultResponse;

      if (data.errorId !== 0) {
        console.error(`[captcha-gate] poll erreur: ${data.errorCode ?? data.errorId}`);
        return null;
      }

      if (data.status === "ready") {
        return data.solution?.gRecaptchaResponse ?? data.solution?.token ?? null;
      }

      // Log toutes les 3 tentatives pour ne pas spammer
      if (i % 3 === 0) {
        console.log(`[captcha-gate] ⏳ En attente... (${i}/${MAX_POLL_ATTEMPTS})`);
      }
    } catch (err) {
      console.warn(`[captcha-gate] poll #${i} erreur réseau: ${err instanceof Error ? err.message : err}`);
    }
  }

  return null;
}

// ─── Orchestrateur ──────────────────────────────────────────────────────────

/**
 * Vérifie si le CAPTCHA est actif et le résout si nécessaire.
 *
 * À appeler AVANT le POST /login. Retourne :
 * - null si pas de CAPTCHA requis (cas normal)
 * - le token reCAPTCHA si résolu avec succès
 * - throws Error si le CAPTCHA est requis mais ne peut pas être résolu
 *
 * Usage dans usa-auth.ts :
 *   const captchaToken = await resolveLoginCaptchaIfNeeded();
 *   // Ajouter captchaToken au body login si non-null
 */
export async function resolveLoginCaptchaIfNeeded(): Promise<string | null> {
  const config = await checkCaptchaConfig();

  if (!config.required) {
    return null; // Pas de CAPTCHA — proceed normalement
  }

  // CAPTCHA activé — résoudre
  const token = await solveLoginCaptcha(config.siteKey);

  if (!token) {
    throw new Error(
      "CAPTCHA requis par le portail mais résolution échouée. " +
      "Vérifiez TWOCAPTCHA_API_KEY et le solde du compte 2captcha."
    );
  }

  return token;
}
