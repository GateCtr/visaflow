import type { Page } from "playwright";

const ANTICAPTCHA_BASE = "https://api.anti-captcha.com";
const ANTICAPTCHA_POLL_MS = 5_000;
const ANTICAPTCHA_MAX_POLLS = 36;

interface AntiCaptchaCreateResponse {
  errorId: number;
  taskId?: number;
  errorCode?: string;
}

interface AntiCaptchaResultResponse {
  errorId: number;
  status: 'processing' | 'ready';
  solution?: { gRecaptchaResponse?: string; token?: string };
  errorCode?: string;
}

/**
 * Analyse des scripts Cloudflare capturés pour comprendre le Managed Challenge:
 * 
 * 1. Le portail Espagne utilise Cloudflare Managed Challenge (Turnstile)
 * 2. Le sitekey est: 0x4AAAAAAAAjq6WYeRDKmebM
 * 3. Le script principal Cloudflare est: https://www.citaconsular.es/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1/ray_9f9b6e65ae61e.js
 * 4. L'API Turnstile est chargée via: https://challenges.cloudflare.com/turnstile/v0/g/fe6331af5207/api.js?onload=kwkA1&render=explicit
 * 5. Les scripts Bookitit récupèrent le token via: document.querySelector('#idDivBktSignUpContainer input[name="cf-turnstile-response"]')?.value
 * 
 * Stratégie d'adaptation:
 * 1. Capturer le bundle Cloudflare pour analyser la configuration exacte
 * 2. Intercepter l'initialisation de Turnstile dans le contexte du Managed Challenge
 * 3. Adapter la méthode de proxy injection pour ce type spécifique
 */

/**
 * Capture et analyse le bundle Cloudflare pour comprendre la configuration Turnstile
 */
export async function captureAndAnalyzeCloudflareBundle(page: Page): Promise<{
  sitekey: string | null;
  turnstileConfig: any | null;
  scripts: Array<{ url: string; content: string }>;
}> {
  console.log("[cf-managed] Capture du bundle Cloudflare...");
  
  const scripts: Array<{ url: string; content: string }> = [];
  
  // Capturer tous les scripts chargés
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('.js') && (url.includes('cloudflare') || url.includes('challenge') || url.includes('turnstile'))) {
      try {
        const text = await response.text();
        scripts.push({ url, content: text.slice(0, 5000) }); // Limiter la taille pour l'analyse
      } catch (error) {
        // Ignorer les erreurs de lecture
      }
    }
  });
  
  // Attendre un peu pour capturer les scripts
  await new Promise(r => setTimeout(r, 5000));
  
  // Analyser les scripts pour trouver le sitekey et la configuration
  let sitekey: string | null = null;
  let turnstileConfig: any | null = null;
  
  // Méthode 1: Chercher dans les scripts
  for (const script of scripts) {
    // Chercher le sitekey
    const sitekeyMatch = script.content.match(/0x4[A-Za-z0-9_-]{10,}/);
    if (sitekeyMatch && !sitekey) {
      sitekey = sitekeyMatch[0];
    }
    
    // Chercher la configuration Turnstile
    if (script.content.includes('turnstile') && script.content.includes('render')) {
      // Essayer d'extraire la configuration
      const configMatch = script.content.match(/(?:sitekey|websiteKey)\s*[:=]\s*["']([^"']+)["']/);
      if (configMatch && !turnstileConfig) {
        turnstileConfig = { sitekey: configMatch[1] };
      }
    }
  }
  
  // Méthode 2: Si sitekey non trouvé, chercher dans les frames
  if (!sitekey) {
    try {
      const frames = page.frames();
      for (const frame of frames) {
        try {
          const frameUrl = frame.url();
          if (frameUrl.includes('cloudflare') || frameUrl.includes('challenge') || frameUrl.includes('turnstile')) {
            // Extraire le sitekey de l'URL du frame
            const match = frameUrl.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
            if (match && !sitekey) {
              sitekey = match[1];
              console.log(`[cf-managed] Sitekey trouvé dans l'URL du frame: ${sitekey}`);
            }
          }
        } catch (error) {
          // Ignorer les erreurs d'accès aux frames
        }
      }
    } catch (error) {
      console.warn("[cf-managed] Erreur analyse frames:", error);
    }
  }
  
  // Méthode 3: Si toujours pas trouvé, évaluer dans la page
  if (!sitekey) {
    try {
      const evalResult = await page.evaluate(() => {
        // Chercher dans window
        const w = window as any;
        if (w._cf_chl_opt && w._cf_chl_opt.sitekey) {
          return w._cf_chl_opt.sitekey;
        }
        
        // Chercher dans les iframes
        const iframes = Array.from(document.querySelectorAll('iframe'));
        for (const iframe of iframes) {
          const src = iframe.src;
          const match = src.match(/\/(0x4[A-Za-z0-9_-]{10,})\//);
          if (match) {
            return match[1];
          }
        }
        
        return null;
      });
      
      if (evalResult) {
        sitekey = evalResult;
        console.log(`[cf-managed] Sitekey trouvé via évaluation: ${sitekey}`);
      }
    } catch (error) {
      console.warn("[cf-managed] Erreur évaluation page:", error);
    }
  }
  
  return { sitekey, turnstileConfig, scripts };
}

/**
 * Méthode adaptée pour le Managed Challenge:
 * 1. Intercepte l'initialisation de Turnstile dans le contexte Cloudflare
 * 2. Capture les paramètres exacts du Managed Challenge
 * 3. Utilise Anti-Captcha avec les paramètres corrects
 */
export async function solveManagedChallengeWithAdaptedInjection(
  page: Page,
  anticaptchaApiKey: string,
): Promise<'solved' | 'failed' | 'no_key'> {
  console.log("[cf-managed] Résolution du Managed Challenge avec méthode adaptée...");
  
  // 1. Capturer et analyser le bundle Cloudflare
  const analysis = await captureAndAnalyzeCloudflareBundle(page);
  
  // Sitekey connu pour le portail Espagne
  const knownSitekey = "0x4AAAAAAAAjq6WYeRDKmebM";
  
  const sitekey = analysis.sitekey || knownSitekey;
  
  if (!sitekey) {
    console.error("[cf-managed] Sitekey non trouvé");
    return "failed";
  }
  
  console.log(`[cf-managed] Sitekey utilisé: ${sitekey} ${analysis.sitekey ? '(détecté)' : '(connu)'}`);
  
  // 2. Injecter un proxy adapté pour le Managed Challenge
  // Le Managed Challenge utilise un flux différent de Turnstile standard
  // On doit intercepter l'initialisation dans le contexte Cloudflare
  
  const injected = await page.evaluate((sitekey: string) => {
    const w = window as any;
    
    // Stratégie 1: Intercepter l'API Turnstile si elle est chargée
    if (w.turnstile) {
      console.log("[cf-managed] Turnstile API détectée, injection du proxy...");
      
      w._originalTurnstile = { ...w.turnstile };
      w._capturedParams = null;
      w._capturedCallback = null;
      
      w.turnstile = new Proxy(w.turnstile, {
        get(target, prop) {
          if (prop === "render") {
            return function (container: any, options: any) {
              console.log("[cf-managed] Turnstile.render appelé avec options:", options);
              
              const params = {
                websiteURL: window.location.href,
                websiteKey: options.sitekey || sitekey,
                action: options.action,
                cData: options.cData,
                chlPageData: options.chlPageData,
                userAgent: navigator.userAgent,
                mode: options.mode || "managed",
              };
              
              w._capturedParams = params;
              w._capturedCallback = options.callback;
              
              // Appeler l'original
              return target.render.call(target, container, options);
            };
          }
          return (target as any)[prop];
        },
      });
      
      return { method: "turnstile_proxy", success: true };
    }
    
    // Stratégie 2: Intercepter les scripts Cloudflare
    // Le Managed Challenge peut initialiser Turnstile différemment
    const scripts = Array.from(document.scripts);
    const cloudflareScripts = scripts.filter(s => 
      s.src.includes('cloudflare') || s.src.includes('challenge') || s.src.includes('turnstile')
    );
    
    if (cloudflareScripts.length > 0) {
      console.log(`[cf-managed] ${cloudflareScripts.length} scripts Cloudflare détectés`);
      
      // Surveiller les appels à l'API Turnstile
      const originalFetch = window.fetch;
      window.fetch = new Proxy(originalFetch, {
        apply(target, thisArg, args) {
          const [url, options] = args;
          if (typeof url === 'string' && url.includes('turnstile') && url.includes('execute')) {
            console.log("[cf-managed] Appel API Turnstile détecté:", url);
            
            // Intercepter la requête pour analyser les paramètres
            if (options && options.body) {
              try {
                const body = JSON.parse(options.body);
                w._capturedParams = {
                  websiteURL: window.location.href,
                  websiteKey: sitekey,
                  ...body,
                  userAgent: navigator.userAgent,
                };
                console.log("[cf-managed] Paramètres API capturés:", w._capturedParams);
              } catch (e) {
                console.error("[cf-managed] Erreur parsing body:", e);
              }
            }
          }
          return target.apply(thisArg, args);
        },
      });
      
      return { method: "fetch_intercept", success: true };
    }
    
    // Stratégie 3: Surveiller les éléments DOM Turnstile
    const turnstileElements = document.querySelectorAll('.cf-turnstile, [data-cf-turnstile], iframe[src*="turnstile"]');
    if (turnstileElements.length > 0) {
      console.log(`[cf-managed] ${turnstileElements.length} éléments Turnstile détectés`);
      
      // Observer les mutations pour capturer l'initialisation
      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          if (mutation.type === 'attributes' && mutation.attributeName === 'data-sitekey') {
            const element = mutation.target as HTMLElement;
            const detectedSitekey = element.getAttribute('data-sitekey');
            if (detectedSitekey) {
              console.log("[cf-managed] Sitekey détecté via mutation:", detectedSitekey);
              w._capturedSitekey = detectedSitekey;
            }
          }
        });
      });
      
      turnstileElements.forEach(el => {
        observer.observe(el, { attributes: true, attributeFilter: ['data-sitekey', 'data-callback'] });
      });
      
      w._mutationObserver = observer;
      return { method: "mutation_observer", success: true };
    }
    
    return { method: "none", success: false };
  }, sitekey);
  
  if (!injected.success) {
    console.error("[cf-managed] Échec de l'injection du proxy");
    return "failed";
  }
  
  console.log(`[cf-managed] Proxy injecté avec méthode: ${injected.method}`);
  
  // 3. Attendre que les paramètres soient capturés
  let capturedParams: any = null;
  let attempts = 0;
  const maxAttempts = 10;
  
  while (!capturedParams && attempts < maxAttempts) {
    attempts++;
    console.log(`[cf-managed] Attente des paramètres... tentative ${attempts}/${maxAttempts}`);
    
    capturedParams = await page.evaluate(() => {
      const w = window as any;
      return w._capturedParams || null;
    });
    
    if (!capturedParams) {
      await new Promise(r => setTimeout(r, 3000));
      
      // Essayer de déclencher l'initialisation si elle n'a pas encore eu lieu
      if (attempts === 3) {
        console.log("[cf-managed] Tentative de déclenchement de l'initialisation...");
        await page.evaluate(() => {
          // Essayer de trouver et cliquer sur le bouton de vérification
          const verifyButton = document.querySelector('button[type="submit"], input[type="submit"], .cf-turnstile') as HTMLElement;
          if (verifyButton) {
            verifyButton.click();
            console.log("[cf-managed] Bouton de vérification cliqué");
          }
        });
      }
    }
  }
  
  if (!capturedParams) {
    console.error("[cf-managed] Aucun paramètre capturé après", maxAttempts, "tentatives");
    
    // Fallback: utiliser le sitekey détecté avec des paramètres par défaut
    capturedParams = {
      websiteURL: page.url(),
      websiteKey: sitekey,
      userAgent: await page.evaluate(() => navigator.userAgent),
      action: 'managed-challenge',
      mode: 'managed',
    };
    console.log("[cf-managed] Utilisation des paramètres par défaut:", capturedParams);
  } else {
    console.log("[cf-managed] Paramètres capturés:", {
      websiteKey: capturedParams.websiteKey?.slice(0, 14) + '...',
      action: capturedParams.action,
      mode: capturedParams.mode,
    });
  }
  
  // 4. Résoudre avec Anti-Captcha
  try {
    // Créer la tâche Anti-Captcha
    const createRes = await fetch(`${ANTICAPTCHA_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: anticaptchaApiKey,
        task: {
          type: "TurnstileTaskProxyless",
          websiteURL: capturedParams.websiteURL,
          websiteKey: capturedParams.websiteKey || sitekey,
          action: capturedParams.action,
          data: capturedParams.cData,
          pageData: capturedParams.chlPageData,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
    
    const createData = await createRes.json() as AntiCaptchaCreateResponse;
    
    if (createData.errorId !== 0 || !createData.taskId) {
      console.error(`[cf-managed] Anti-Captcha createTask erreur: ${createData.errorCode ?? createData.errorId}`);
      return "failed";
    }
    
    const taskId = createData.taskId;
    console.log(`[cf-managed] Tâche Anti-Captcha créée: ${taskId}`);
    
    // Poller le résultat
    for (let i = 0; i < ANTICAPTCHA_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, ANTICAPTCHA_POLL_MS));
      
      try {
        const resultRes = await fetch(`${ANTICAPTCHA_BASE}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: anticaptchaApiKey, taskId }),
          signal: AbortSignal.timeout(10000),
        });
        
        const resultData = await resultRes.json() as AntiCaptchaResultResponse;
        
        if (resultData.errorId !== 0) {
          console.error(`[cf-managed] Anti-Captcha poll erreur: ${resultData.errorId}`);
          return "failed";
        }
        
        if (resultData.status === "ready") {
          const token = resultData.solution?.token;
          if (!token) {
            console.error("[cf-managed] Anti-Captcha: status ready mais token absent");
            return "failed";
          }
          
          console.log(`[cf-managed] Token reçu (longueur: ${token.length})`);
          
          // 5. Injecter le token
          const injectionResult = await injectManagedChallengeToken(page, token, capturedParams);
          
          if (injectionResult === "solved") {
            // Vérifier le cookie cf_clearance
            const cookies = await page.context().cookies();
            const cfClearance = cookies.find(c => c.name === "cf_clearance");
            
            if (cfClearance) {
              console.log(`[cf-managed] Cookie cf_clearance obtenu: ${cfClearance.value.slice(0, 20)}...`);
              return "solved";
            } else {
              console.warn("[cf-managed] Aucun cookie cf_clearance trouvé, mais token injecté");
              // Attendre un peu pour voir si la page se débloque
              await new Promise(r => setTimeout(r, 5000));
              return "solved";
            }
          }
          
          return injectionResult;
        }
        
        console.log(`[cf-managed] Anti-Captcha poll #${i + 1} — processing`);
      } catch (error) {
        console.warn(`[cf-managed] Erreur réseau poll #${i + 1}:`, error instanceof Error ? error.message : error);
      }
    }
    
    console.error("[cf-managed] Timeout Anti-Captcha");
    return "failed";
    
  } catch (error) {
    console.error("[cf-managed] Erreur résolution:", error instanceof Error ? error.message : error);
    return "failed";
  }
}

/**
 * Injecte le token dans le Managed Challenge
 */
async function injectManagedChallengeToken(
  page: Page,
  token: string,
  params: any
): Promise<'solved' | 'failed'> {
  console.log("[cf-managed] Injection du token...");
  
  try {
    // Essayer plusieurs méthodes d'injection
    const result = await page.evaluate(({ token, params }) => {
      const w = window as any;
      
      // Méthode 1: Appeler le callback capturé
      if (w._capturedCallback && typeof w._capturedCallback === "function") {
        console.log("[cf-managed] Appel du callback capturé");
        try {
          w._capturedCallback(token);
          return { method: "callback", success: true };
        } catch (error) {
          console.error("[cf-managed] Erreur callback:", error);
        }
      }
      
      // Méthode 2: Injecter dans l'input caché
      const hiddenInputs = document.querySelectorAll<HTMLInputElement>(
        'input[name="cf-turnstile-response"], input[name="cf_challenge_response"], [name="cf-turnstile-response"]'
      );
      
      for (const input of hiddenInputs) {
        input.value = token;
        console.log("[cf-managed] Token injecté dans input:", input.name);
        
        // Déclencher les événements de changement
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      
      if (hiddenInputs.length > 0) {
        return { method: "hidden_input", success: true };
      }
      
      // Méthode 3: Soumettre le formulaire challenge
      const challengeForm = document.querySelector<HTMLFormElement>('#challenge-form, form[action*="cdn-cgi"]');
      if (challengeForm) {
        console.log("[cf-managed] Formulaire challenge trouvé");
        
        // Créer un champ caché pour le token
        const tokenInput = document.createElement('input');
        tokenInput.type = 'hidden';
        tokenInput.name = 'cf-turnstile-response';
        tokenInput.value = token;
        challengeForm.appendChild(tokenInput);
        
        // Soumettre le formulaire
        challengeForm.submit();
        return { method: "form_submit", success: true };
      }
      
      // Méthode 4: Utiliser l'API Turnstile si disponible
      if (w.turnstile && w.turnstile.execute) {
        console.log("[cf-managed] Utilisation de turnstile.execute");
        try {
          // Trouver le widget
          const widgets = document.querySelectorAll('.cf-turnstile, [data-cf-turnstile]');
          for (const widget of widgets) {
            const widgetId = widget.id;
            if (widgetId) {
              w.turnstile.execute(widgetId, { response: token });
              return { method: "turnstile_execute", success: true };
            }
          }
        } catch (error) {
          console.error("[cf-managed] Erreur turnstile.execute:", error);
        }
      }
      
      // Méthode 5: Injection directe dans le DOM
      console.log("[cf-managed] Injection directe dans le DOM");
      
      // Créer un événement personnalisé
      const event = new CustomEvent('cf-turnstile-response', {
        detail: { token },
        bubbles: true,
      });
      document.dispatchEvent(event);
      
      // Déclencher un événement global
      w._cfToken = token;
      w.dispatchEvent(new Event('cf-token-received'));
      
      return { method: "dom_injection", success: true };
      
    }, { token, params });
    
    if (result.success) {
      console.log(`[cf-managed] Token injecté avec méthode: ${result.method}`);
      
      // Attendre la navigation/redirection
      try {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {
          console.log("[cf-managed] Pas de navigation détectée, continuation...");
        });
      } catch (error) {
        console.warn("[cf-managed] Erreur attente navigation:", error);
      }
      
      return "solved";
    } else {
      console.error("[cf-managed] Échec de l'injection du token");
      return "failed";
    }
    
  } catch (error) {
    console.error("[cf-managed] Erreur lors de l'injection:", error instanceof Error ? error.message : error);
    return "failed";
  }
}

/**
 * Méthode principale pour résoudre le Managed Challenge
 * Combine l'analyse du bundle et l'injection adaptée
 */
export async function solveCloudflareManagedChallenge(
  page: Page,
  anticaptchaApiKey?: string,
  capsolverApiKey?: string,
  twoCaptchaApiKey?: string,
): Promise<'solved' | 'failed' | 'no_key'> {
  console.log("[cf-managed] Début résolution Managed Challenge...");
  
  if (!anticaptchaApiKey && !capsolverApiKey && !twoCaptchaApiKey) {
    console.error("[cf-managed] Aucune clé captcha disponible");
    return "no_key";
  }
  
  // Priorité: Anti-Captcha avec méthode adaptée
  if (anticaptchaApiKey) {
    console.log("[cf-managed] Utilisation d'Anti-Captcha avec méthode adaptée");
    return await solveManagedChallengeWithAdaptedInjection(page, anticaptchaApiKey);
  }
  
  // Fallback: autres providers (à implémenter si nécessaire)
  console.error("[cf-managed] Seul Anti-Captcha est supporté pour la méthode adaptée");
  return "no_key";
}