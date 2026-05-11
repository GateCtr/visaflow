import type { Page } from "playwright";

const CAPSOLVER_BASE = "https://api.capsolver.com";
const CAPSOLVER_POLL_MS = 3_000;
const CAPSOLVER_MAX_POLLS = 40;

interface CapSolverCreateResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
}

interface CapSolverResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status: 'processing' | 'ready';
  solution?: {
    token: string;
    userAgent: string;
    cookies: Array<{ name: string; value: string }>;
    headers: Record<string, string>;
    proxy: string;
  };
}

interface CapSolverBalanceResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  balance: number;
}

/**
 * Vérifie le solde CapSolver
 */
export async function checkCapSolverBalance(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch(`${CAPSOLVER_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: apiKey }),
      signal: AbortSignal.timeout(10000),
    });
    
    const data = await res.json() as CapSolverBalanceResponse;
    
    if (data.errorId === 0) {
      return data.balance;
    } else {
      console.error(`[capsolver-fixed] Erreur balance: ${data.errorCode || data.errorId}`);
      return null;
    }
  } catch (error) {
    console.error("[capsolver-fixed] Erreur vérification balance:", error);
    return null;
  }
}

/**
 * Parse une URL Bright Data pour extraire les composants
 */
export interface BrightDataComponents {
  ip: string;           // IP fixe (212.81.41.27)
  port: string;         // Port (33335)
  username: string;     // Username complet avec zone, country, ip
  password: string;     // Mot de passe
  hostname?: string;    // Hostname original (brd.superproxy.io)
}

/**
 * Parse une URL Bright Data au format correct pour CapSolver
 * Format attendu: http://username:password@hostname:port
 * Avec username contenant: brd-customer-{accountId}-zone-{type}-country-{country}-ip-{ip}
 */
export function parseBrightDataForCapSolver(proxyUrl: string): BrightDataComponents | null {
  try {
    const url = new URL(proxyUrl);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const hostname = url.hostname; // brd.superproxy.io
    const port = url.port || "33335";
    
    // Extraire l'IP du username
    // Format: brd-customer-{accountId}-zone-{type}-country-{country}-ip-{ip}
    const ipMatch = username.match(/-ip-(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    
    if (!ipMatch) {
      console.error("[capsolver-fixed] IP non trouvée dans le username");
      return null;
    }
    
    const ip = ipMatch[1];
    
    return {
      ip,
      port,
      username,
      password,
      hostname,
    };
    
  } catch (error) {
    console.error("[capsolver-fixed] Erreur parsing URL:", error);
    return null;
  }
}

/**
 * Résout un Cloudflare Challenge avec CapSolver - FORMAT CORRECT
 * Utilise le format: proxy=IP:PORT, proxyLogin=username, proxyPassword=password
 */
export async function solveCloudflareChallengeFixed(
  page: Page,
  capsolverApiKey: string,
  proxyUrl: string,
  websiteURL?: string
): Promise<{
  success: boolean;
  token?: string;
  userAgent?: string;
  cookies?: Array<{ name: string; value: string }>;
  headers?: Record<string, string>; 
  proxy?: string;
  error?: string;
}> {
  console.log("[capsolver-fixed] Début résolution Cloudflare Challenge (format corrigé)...");
  
  const url = websiteURL || page.url();
  
  // Vérifier le solde
  const balance = await checkCapSolverBalance(capsolverApiKey);
  if (balance === null || balance <= 0) {
    return { 
      success: false, 
      error: `Solde insuffisant ou erreur API: ${balance === null ? 'API error' : balance}` 
    };
  }
  
  console.log(`[capsolver-fixed] Solde: ${balance}, URL: ${url}`);
  
  // Parser l'URL Bright Data
  const components = parseBrightDataForCapSolver(proxyUrl);
  
  if (!components) {
    return {
      success: false,
      error: "Format proxy invalide. Attendu: http://username:password@hostname:port avec -ip-{ip} dans username"
    };
  }
  
  console.log(`[capsolver-fixed] IP fixe détectée: ${components.ip}`);
  console.log(`[capsolver-fixed] Port: ${components.port}`);
  console.log(`[capsolver-fixed] Username: ${components.username.slice(0, 30)}...`);
  
  try {
    // 1. Créer la tâche AntiCloudflareTask avec FORMAT CORRECT
    console.log(`[capsolver-fixed] Création tâche AntiCloudflareTask (format corrigé)...`);
    
    const taskPayload = {
      clientKey: capsolverApiKey,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: url,
        // FORMAT CORRECT: IP:PORT séparé, credentials séparés
        proxy: `${components.ip}:${components.port}`,
        proxyType: "http",
        proxyLogin: components.username,
        proxyPassword: components.password,
        // Paramètres optionnels
        metadata: {
          action: "managed",
          captchaType: "cloudflareManagedChallenge",
        }
      },
    };
    
    console.log(`[capsolver-fixed] Payload envoyé à CapSolver:`);
    console.log(`  - proxy: ${components.ip}:${components.port} (✅ IP FIXE DIRECTE)`);
    console.log(`  - proxyLogin: ${components.username.slice(0, 30)}...`);
    console.log(`  - proxyPassword: ${components.password.slice(0, 3)}...`);
    
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(taskPayload),
      signal: AbortSignal.timeout(30000),
    });
    
    const createData = await createRes.json() as CapSolverCreateResponse;
    
    if (createData.errorId !== 0 || !createData.taskId) {
      const errorMsg = createData.errorDescription || createData.errorCode || `Error ${createData.errorId}`;
      console.error(`[capsolver-fixed] Erreur création tâche: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
    
    const taskId = createData.taskId;
    console.log(`[capsolver-fixed] Tâche créée: ${taskId}`);
    
    // 2. Poller le résultat
    for (let i = 0; i < CAPSOLVER_MAX_POLLS; i++) {
      await new Promise(r => setTimeout(r, CAPSOLVER_POLL_MS));
      
      try {
        const resultRes = await fetch(`${CAPSOLVER_BASE}/getTaskResult`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: capsolverApiKey, taskId }),
          signal: AbortSignal.timeout(15000),
        });
        
        const resultData = await resultRes.json() as CapSolverResultResponse;
        
        if (resultData.errorId !== 0) {
          console.error(`[capsolver-fixed] Erreur poll: ${resultData.errorCode || resultData.errorId}`);
          continue;
        }
        
        if (resultData.status === "ready") {
          const solution = resultData.solution;
          if (!solution || !solution.token) {
            console.error("[capsolver-fixed] Solution ready mais token absent");
            return { success: false, error: "Token absent dans la solution" };
          }
          
          console.log(`[capsolver-fixed] Challenge résolu! Token: ${solution.token.slice(0, 20)}...`);
          console.log(`[capsolver-fixed] User-Agent: ${solution.userAgent?.slice(0, 50)}...`);
          console.log(`[capsolver-fixed] Cookies: ${solution.cookies?.length || 0}`);
          console.log(`[capsolver-fixed] Headers: ${Object.keys(solution.headers || {}).length}`);
          
          return {
            success: true,
            token: solution.token,
            userAgent: solution.userAgent,
            cookies: solution.cookies,
            headers: solution.headers,
            proxy: solution.proxy,
          };
        }
        
        console.log(`[capsolver-fixed] Poll #${i + 1} — ${resultData.status}`);
        
      } catch (error) {
        console.warn(`[capsolver-fixed] Erreur réseau poll #${i + 1}:`, error instanceof Error ? error.message : error);
      }
    }
    
    console.error("[capsolver-fixed] Timeout après", CAPSOLVER_MAX_POLLS, "polls");
    return { success: false, error: "Timeout" };
    
  } catch (error) {
    console.error("[capsolver-fixed] Erreur résolution:", error instanceof Error ? error.message : error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applique la solution CapSolver à la page
 */
export async function applyCapSolverSolutionFixed(
  page: Page,
  solution: {
    token: string;
    userAgent?: string;
    cookies?: Array<{ name: string; value: string }>;
    headers?: Record<string, string>;
    proxy?: string;
  }
): Promise<boolean> {
  console.log("[capsolver-fixed] Application de la solution...");
  
  try {
    const context = page.context();
    
    // 1. Configurer le user-agent si fourni
    if (solution.userAgent) {
      console.log(`[capsolver-fixed] Configuration User-Agent: ${solution.userAgent.slice(0, 50)}...`);
      await page.setExtraHTTPHeaders({
        'User-Agent': solution.userAgent,
      });
    }
    
    // 2. Ajouter les cookies
    if (solution.cookies && solution.cookies.length > 0) {
      console.log(`[capsolver-fixed] Ajout de ${solution.cookies.length} cookies...`);
      
      // D'abord nettoyer les cookies existants
      await context.clearCookies();
      
      // Ajouter les nouveaux cookies
      const cookiesToAdd = solution.cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: new URL(page.url()).hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: cookie.name === 'cf_clearance',
        secure: true,
        sameSite: 'None' as const,
      }));
      
      await context.addCookies(cookiesToAdd);
      
      // Vérifier le cookie cf_clearance
      const cfClearanceCookie = solution.cookies.find(c => c.name === 'cf_clearance');
      if (cfClearanceCookie) {
        console.log(`[capsolver-fixed] Cookie cf_clearance ajouté: ${cfClearanceCookie.value.slice(0, 20)}...`);
      }
    }
    
    // 3. Ajouter le token comme cookie cf_clearance
    console.log(`[capsolver-fixed] Ajout token comme cf_clearance: ${solution.token.slice(0, 20)}...`);
    
    await context.addCookies([{
      name: 'cf_clearance',
      value: solution.token,
      domain: new URL(page.url()).hostname,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 7200,
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    }]);
    
    // 4. Ajouter les headers supplémentaires
    if (solution.headers) {
      console.log(`[capsolver-fixed] Ajout de ${Object.keys(solution.headers).length} headers...`);
      await page.setExtraHTTPHeaders(solution.headers);
    }
    
    console.log("[capsolver-fixed] Solution appliquée avec succès");
    return true;
    
  } catch (error) {
    console.error("[capsolver-fixed] Erreur application solution:", error);
    return false;
  }
}

/**
 * Méthode complète pour résoudre et appliquer Cloudflare Challenge - FORMAT CORRECT
 */
export async function solveAndApplyCloudflareChallengeFixed(
  page: Page,
  capsolverApiKey: string,
  proxyUrl: string
): Promise<boolean> {
  console.log("[capsolver-fixed] Résolution complète Cloudflare Challenge (format corrigé)...");
  
  // 1. Résoudre le challenge avec format corrigé
  const solution = await solveCloudflareChallengeFixed(page, capsolverApiKey, proxyUrl);
  
  if (!solution.success || !solution.token) {
    console.error("[capsolver-fixed] Échec résolution challenge");
    return false;
  }
  
  // 2. Appliquer la solution
  const applied = await applyCapSolverSolutionFixed(page, {
    token: solution.token!,
    userAgent: solution.userAgent,
    cookies: solution.cookies,
    headers: solution.headers,
    proxy: solution.proxy,
  });
  
  if (!applied) {
    console.error("[capsolver-fixed] Échec application solution");
    return false;
  }
  
  // 3. Recharger la page
  console.log("[capsolver-fixed] Rechargement de la page...");
  
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    
    // Vérifier si Cloudflare est toujours présent
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      console.error("[capsolver-fixed] Cloudflare toujours présent après application");
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      console.log(`[capsolver-fixed] Cookie cf_clearance présent: ${cfClearance ? "OUI" : "NON"}`);
      
      if (cfClearance) {
        console.log(`[capsolver-fixed] Valeur: ${cfClearance.value.slice(0, 20)}...`);
      }
      
      return false;
    }
    
    console.log("[capsolver-fixed] ✅ Cloudflare résolu avec succès!");
    return true;
    
  } catch (error) {
    console.error("[capsolver-fixed] Erreur rechargement:", error);
    return false;
  }
}

/**
 * Teste si une URL Bright Data est compatible avec le format corrigé
 */
export function isBrightDataCompatible(proxyUrl: string): boolean {
  const components = parseBrightDataForCapSolver(proxyUrl);
  if (!components) return false;
  
  // Vérifier que l'username contient -ip-
  return components.username.includes('-ip-');
}

/**
 * Génère le format d'affichage pour debugging
 */
export function debugBrightDataFormat(proxyUrl: string): string {
  const components = parseBrightDataForCapSolver(proxyUrl);
  
  if (!components) {
    return "❌ Format invalide";
  }
  
  return `
✅ FORMAT BRIGHT DATA DÉTECTÉ:
  IP fixe: ${components.ip}
  Port: ${components.port}
  Username: ${components.username.slice(0, 40)}...
  Password: ${components.password.slice(0, 3)}...
  Hostname: ${components.hostname}

🎯 FORMAT CAPSOLVER CORRECT:
  proxy: "${components.ip}:${components.port}"
  proxyLogin: "${components.username}"
  proxyPassword: "${components.password}"
  proxyType: "http"

⚠️  IMPORTANT:
  - IP envoyée directement: ${components.ip} (pas ${components.hostname})
  - Credentials séparés dans proxyLogin/proxyPassword
  - Compatible avec AntiCloudflareTask
  `.trim();
}