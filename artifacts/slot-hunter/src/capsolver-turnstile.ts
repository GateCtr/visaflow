/**
 * capsolver-turnstile.ts — Résolution Cloudflare Turnstile via CapSolver (injection browser)
 *
 * ARCHITECTURE (différente de AntiCloudflareTask) :
 *   1. Notre Chromium navigue vers l'URL cible → CF challenge Turnstile apparaît
 *   2. On extrait le sitekey depuis le DOM de la page
 *   3. CapSolver résout UNIQUEMENT le token Turnstile (AntiTurnstileTaskProxyLess)
 *   4. On injecte le token dans notre page Chromium via JS
 *   5. CF valide le token depuis notre contexte browser → émet cf_clearance lié à NOTRE TLS
 *
 * POURQUOI ça marche là où AntiCloudflareTask échoue :
 *   - AntiCloudflareTask : CapSolver fait TOUT sur leur infra → cf_clearance lié à LEUR TLS
 *     → notre Chromium envoie un TLS différent → CF bloque /main/ (0B)
 *   - Turnstile injection : CapSolver résout seulement le CAPTCHA math/IA,
 *     notre Chromium reste l'acteur de la validation finale → cf_clearance pour NOTRE TLS
 */

import type { Page } from "puppeteer";

const CAPSOLVER_BASE = "https://api.capsolver.com";
const CAPSOLVER_POLL_MS = 3_000;
const CAPSOLVER_MAX_POLLS = 60; // 3min max

// ─── Types CapSolver ─────────────────────────────────────────────────────────

interface CapSolverCreateResp {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
}

interface CapSolverResultResp {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status: "processing" | "ready" | "failed";
  solution?: {
    token: string;
    type?: string;
    userAgent?: string;
  };
}

// ─── Token Turnstile ─────────────────────────────────────────────────────────

/**
 * Résout un token Cloudflare Turnstile via CapSolver (proxyless).
 * Retourne le token à injecter dans le browser, ou null si échec.
 */
export async function solveTurnstileToken(
  websiteURL: string,
  websiteKey: string,
  apiKey: string,
  metadata?: { action?: string; cdata?: string },
): Promise<{ token: string; userAgent?: string } | null> {
  const key = apiKey.trim();
  console.log(
    `[capsolver-ts] 🎯 Résolution Turnstile — sitekey: ${websiteKey.slice(0, 30)}…` +
    ` URL: ${websiteURL.slice(0, 60)}`,
  );

  // Vérifier la balance CapSolver
  try {
    const balRes = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key }),
      signal: AbortSignal.timeout(10_000),
    });
    const balData = (await balRes.json()) as { errorId: number; balance?: number; errorCode?: string; errorDescription?: string };
    if (balData.errorId !== 0) {
      console.error(`[capsolver-ts] ❌ Balance erreur: ${balData.errorCode ?? balData.errorId} — ${balData.errorDescription ?? ""}`);
      return null;
    }
    if ((balData.balance ?? 0) <= 0) {
      console.error(`[capsolver-ts] ❌ Balance insuffisante: $${balData.balance}`);
      return null;
    }
    console.log(`[capsolver-ts] 💰 Balance: $${balData.balance?.toFixed(3)}`);
  } catch (err) {
    console.error(`[capsolver-ts] ❌ Balance check failed: ${err}`);
    return null;
  }

  // Créer la tâche AntiTurnstileTaskProxyLess
  let taskId: string;
  try {
    const taskBody: Record<string, unknown> = {
      type: "AntiTurnstileTaskProxyLess",
      websiteURL,
      websiteKey,
    };
    if (metadata) taskBody.metadata = metadata;

    console.log(`[capsolver-ts] 📤 createTask AntiTurnstileTaskProxyLess…`);
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: key, task: taskBody }),
      signal: AbortSignal.timeout(30_000),
    });
    const createData = (await createRes.json()) as CapSolverCreateResp;

    if (createData.errorId !== 0 || !createData.taskId) {
      const err = createData.errorDescription || createData.errorCode || `errorId=${createData.errorId}`;
      console.error(`[capsolver-ts] ❌ createTask failed: ${err}`);
      return null;
    }
    taskId = createData.taskId;
    console.log(`[capsolver-ts] ✅ Task créée: ${taskId}`);
  } catch (err) {
    console.error(`[capsolver-ts] ❌ createTask erreur réseau: ${err}`);
    return null;
  }

  // Poller le résultat
  for (let i = 0; i < CAPSOLVER_MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, CAPSOLVER_POLL_MS));

    try {
      const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: key, taskId }),
        signal: AbortSignal.timeout(15_000),
      });
      const resultData = (await resultRes.json()) as CapSolverResultResp;

      if (resultData.errorId !== 0) {
        const errCode = resultData.errorCode || `errorId=${resultData.errorId}`;
        if (
          errCode.includes("ERROR_INVALID_TASK_DATA") ||
          errCode.includes("ERROR_CAPTCHA_UNSOLVABLE") ||
          errCode.includes("ERROR_PROXY")
        ) {
          console.error(`[capsolver-ts] ❌ Erreur fatale: ${errCode} — ${resultData.errorDescription ?? ""}`);
          return null;
        }
        console.warn(`[capsolver-ts] ⚠️ Poll #${i + 1}: ${errCode} — on continue`);
        continue;
      }

      if (resultData.status === "ready" && resultData.solution?.token) {
        const tok = resultData.solution.token;
        console.log(
          `[capsolver-ts] ✅ Token Turnstile résolu (poll #${i + 1}): ${tok.slice(0, 50)}…`,
        );
        return { token: tok, userAgent: resultData.solution.userAgent };
      }

      if (i % 5 === 4) {
        console.log(`[capsolver-ts] ⏳ Poll #${i + 1} — status: ${resultData.status}`);
      }
    } catch (err) {
      console.warn(`[capsolver-ts] ⚠️ Poll #${i + 1} erreur: ${err}`);
    }
  }

  console.error(`[capsolver-ts] ❌ Timeout: ${CAPSOLVER_MAX_POLLS * CAPSOLVER_POLL_MS / 1000}s sans résultat`);
  return null;
}

// ─── Extraction sitekey ──────────────────────────────────────────────────────

/**
 * Extrait le sitekey Turnstile depuis une page Puppeteer.
 *
 * CF Managed Challenge avec render=explicit NE met pas data-sitekey dans le DOM.
 * Il passe le sitekey à window.turnstile.render() dynamiquement.
 *
 * Stratégies d'extraction (par ordre de priorité) :
 *   1. window.__cf_intercepted_sitekey  (injecté par evaluateOnNewDocument, voir ci-dessous)
 *   2. data-sitekey dans le DOM         (widgets Turnstile tiers)
 *   3. URL du script Turnstile          (turnstile/v0/g/<SITEKEY>/api.js)
 *   4. Scripts inline                   (sitekey: "xxx")
 *
 * NOTE : pour que la stratégie 1 fonctionne, appeler `injectTurnstileInterceptScript(page)`
 * via evaluateOnNewDocument AVANT la navigation.
 */
export async function waitForTurnstileSitekey(
  page: Page,
  timeoutMs = 30_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const sitekey: string | null = await page.evaluate(() => {
      // ── Stratégie 1 : intercepté via window.turnstile.render hook ────────────
      const intercepted = (window as any).__cf_intercepted_sitekey as string | undefined;
      if (intercepted && intercepted.length > 5) return intercepted;

      // ── Stratégie 2 : data-sitekey DOM (widgets tiers) ───────────────────────
      const selectors = [
        '[data-sitekey]',
        '.cf-turnstile[data-sitekey]',
        '#challenge-form [data-sitekey]',
        'div[data-sitekey]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const key = el.getAttribute('data-sitekey');
          if (key && key.length > 5) return key;
        }
      }

      // ── Stratégie 3 : URL du script Turnstile CF ─────────────────────────────
      // Format CF Managed Challenge : turnstile/v0/g/<SITEKEY>/api.js
      // Ex: https://challenges.cloudflare.com/turnstile/v0/g/b0da9f4911ba/api.js
      for (const s of Array.from(document.querySelectorAll('script[src]'))) {
        const src = (s as HTMLScriptElement).src;
        if (src.includes('challenges.cloudflare.com/turnstile')) {
          const m = src.match(/\/turnstile\/v[\d]+\/[a-z]\/([a-f0-9]{8,32})\/api\.js/);
          if (m) return m[1];
          // Format alternatif : /turnstile/v0/api.js?sitekey=xxx (iframes)
          const url = new URL(src);
          const sk = url.searchParams.get('sitekey');
          if (sk && sk.length > 5) return sk;
        }
      }

      // ── Stratégie 4 : scripts inline ─────────────────────────────────────────
      for (const s of Array.from(document.querySelectorAll('script'))) {
        const m = s.textContent?.match(/["']sitekey["']\s*:\s*["']([^"']{6,})["']/);
        if (m) return m[1];
        const m2 = s.textContent?.match(/data-sitekey=["']([^"']{6,})["']/);
        if (m2) return m2[1];
      }

      return null;
    }).catch(() => null);

    if (sitekey) return sitekey;

    // Vérifier si on est encore sur un challenge CF
    const isChallenge: boolean = await page.evaluate(() => {
      const t = document.title.toLowerCase();
      return t.includes('just a moment') || t.includes('un instant') || t.includes('checking') ||
             !!document.querySelector('.cf-challenge-running, .cf-im-under-attack, #cf-please-wait') ||
             !!(window as any)._cf_chl_opt;
    }).catch(() => false);

    if (!isChallenge) {
      // Plus de challenge — page réelle chargée, pas besoin du sitekey
      console.log('[capsolver-ts] ℹ️ Challenge CF disparu avant extraction sitekey (challenge auto-résolu ?)');
      return null;
    }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  console.error(`[capsolver-ts] ❌ Sitekey Turnstile introuvable après ${timeoutMs / 1000}s`);
  return null;
}

/**
 * Script à injecter via `page.evaluateOnNewDocument()` AVANT navigation.
 * Il intercepte window.turnstile.render() pour capturer le sitekey dynamique.
 *
 * CF Managed Challenge avec render=explicit appelle :
 *   window.turnstile.render(element, { sitekey: 'xxx', callback: fn })
 * Sans cet hook, le sitekey n'est jamais dans le DOM.
 */
export const TURNSTILE_INTERCEPT_SCRIPT = `
(function() {
  // Intercepter window.turnstile dès qu'il est défini (peut arriver après DOMContentLoaded)
  let _turnstile_storage = undefined;
  function patchTurnstile(t) {
    if (!t || typeof t.render !== 'function') return t;
    const origRender = t.render.bind(t);
    t.render = function(el, options) {
      if (options && options.sitekey) {
        window.__cf_intercepted_sitekey = options.sitekey;
      }
      return origRender(el, options);
    };
    return t;
  }

  // Définir un getter/setter sur window.turnstile pour intercepter l'assignation
  Object.defineProperty(window, 'turnstile', {
    get() { return _turnstile_storage; },
    set(v) {
      _turnstile_storage = patchTurnstile(v);
    },
    configurable: true,
    enumerable: true,
  });
})();
`;

// ─── Injection token ─────────────────────────────────────────────────────────

/**
 * Injecte un token Turnstile résolu dans une page Puppeteer.
 * Tente plusieurs méthodes pour s'adapter aux différentes implémentations CF.
 */
export async function injectTurnstileToken(page: Page, token: string): Promise<boolean> {
  return page.evaluate((t: string): boolean => {
    let success = false;

    // Méthode 1 : input hidden cf-turnstile-response + dispatch events
    const inputs = document.querySelectorAll<HTMLInputElement>(
      '[name="cf-turnstile-response"], input[id="cf-turnstile-response"]',
    );
    inputs.forEach((inp) => {
      inp.value = t;
      inp.dispatchEvent(new Event('input',  { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      success = true;
    });

    // Méthode 2 : callback défini sur le widget (data-callback="myFn")
    document.querySelectorAll('[data-callback]').forEach((widget) => {
      const cbName = widget.getAttribute('data-callback');
      if (cbName && typeof (window as any)[cbName] === 'function') {
        try {
          (window as any)[cbName](t);
          success = true;
        } catch { /* callback peut lever */ }
      }
    });

    // Méthode 3 : API globale window.turnstile (CF Turnstile SDK)
    if ((window as any).turnstile?.render) {
      // Si le widget est déjà rendu, appeler le callback directement
      const containers = document.querySelectorAll('.cf-turnstile, [data-sitekey]');
      containers.forEach((c) => {
        const cbName = c.getAttribute('data-callback');
        if (cbName && typeof (window as any)[cbName] === 'function') {
          try { (window as any)[cbName](t); success = true; } catch { /* non-fatal */ }
        }
      });
    }

    // Méthode 4 : formulaire CF challenge standard (#challenge-form)
    const form = document.getElementById('challenge-form') as HTMLFormElement | null;
    if (form) {
      const hiddenInput = form.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]');
      if (hiddenInput) {
        hiddenInput.value = t;
        hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      try {
        form.submit();
        success = true;
      } catch { /* non-fatal */ }
    }

    return success;
  }, token);
}

// ─── Attente cf_clearance ────────────────────────────────────────────────────

/**
 * Attend l'apparition du cookie cf_clearance dans la page Puppeteer.
 * CF l'émet après avoir validé le token Turnstile injecté.
 */
export async function waitForCfClearanceCookie(
  page: Page,
  timeoutMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const cookies = await page.cookies("https://www.citaconsular.es");
      const cf = cookies.find((c) => c.name === "cf_clearance");
      if (cf?.value) return true;
    } catch { /* non-fatal */ }

    await new Promise((r) => setTimeout(r, 1_000));
  }

  return false;
}

// ─── Solve complet in-page ───────────────────────────────────────────────────

/**
 * Résout le challenge Turnstile CF directement dans une page Puppeteer ouverte.
 *
 * Flow :
 *   1. Attendre que le widget Turnstile soit présent (sitekey)
 *   2. Appeler CapSolver AntiTurnstileTaskProxyLess → token
 *   3. Injecter le token dans la page
 *   4. Attendre cf_clearance dans les cookies
 *
 * Retourne true si cf_clearance apparu, false sinon.
 */
export async function solveTurnstileInPage(
  page: Page,
  targetUrl: string,
  apiKey: string,
): Promise<boolean> {
  // 1. Extraire le sitekey depuis la page ouverte
  const sitekey = await waitForTurnstileSitekey(page, 30_000);

  if (!sitekey) {
    // Pas de sitekey → vérifier si cf_clearance déjà présent (auto-résolu)
    const cfAlready = await waitForCfClearanceCookie(page, 3_000);
    if (cfAlready) {
      console.log('[capsolver-ts] ✅ cf_clearance déjà présent (challenge auto-résolu)');
      return true;
    }
    console.error('[capsolver-ts] ❌ Sitekey introuvable et pas de cf_clearance — impossible de résoudre');
    return false;
  }

  console.log(`[capsolver-ts] 🔑 Sitekey extrait: ${sitekey.slice(0, 40)}…`);

  // 2. Résoudre le token via CapSolver
  // CF Managed Challenge interactive → metadata action:"managed" + type:"turnstile"
  const result = await solveTurnstileToken(targetUrl, sitekey, apiKey, {
    action: "managed",
  });
  if (!result) {
    console.error('[capsolver-ts] ❌ Token Turnstile non obtenu');
    return false;
  }

  // 3. Injecter le token dans la page
  console.log('[capsolver-ts] 💉 Injection token Turnstile dans la page…');
  const injected = await injectTurnstileToken(page, result.token);
  console.log(`[capsolver-ts] 💉 Injection: ${injected ? "✅ callbacks appelés" : "⚠️ aucun callback trouvé (token dans DOM)"}`);

  // 4. Attendre cf_clearance
  console.log('[capsolver-ts] ⏳ Attente cf_clearance post-injection (max 45s)…');
  const cleared = await waitForCfClearanceCookie(page, 45_000);

  if (cleared) {
    console.log('[capsolver-ts] ✅ cf_clearance apparu — CF validé dans notre Chromium');
  } else {
    console.error('[capsolver-ts] ❌ cf_clearance absent après 45s');
  }

  return cleared;
}
