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
      console.error(`[capsolver] Erreur balance: ${data.errorCode || data.errorId}`);
      return null;
    }
  } catch (error) {
    console.error("[capsolver] Erreur vérification balance:", error);
    return null;
  }
}

/**
 * Résout un Cloudflare Challenge avec CapSolver
 * Utilise AntiCloudflareTask qui supporte Cloudflare Managed Challenge
 */
export async function solveCloudflareChallenge(
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
  console.log("[capsolver] Début résolution Cloudflare Challenge...");
  
  const url = websiteURL || page.url();
  
  // Vérifier le solde
  const balance = await checkCapSolverBalance(capsolverApiKey);
  if (balance === null || balance <= 0) {
    return { 
      success: false, 
      error: `Solde insuffisant ou erreur API: ${balance === null ? 'API error' : balance}` 
    };
  }
  
  console.log(`[capsolver] Solde: ${balance}, URL: ${url}`);
  
  try {
    // 1. Créer la tâche AntiCloudflareTask
    console.log(`[capsolver] Création tâche AntiCloudflareTask avec proxy...`);
    
    const createRes = await fetch(`${CAPSOLVER_BASE}/createTask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: capsolverApiKey,
        task: {
          type: "AntiCloudflareTask",
          websiteURL: url,
          proxy: proxyUrl,
          // Paramètres optionnels pour améliorer la réussite
          metadata: {
            action: "managed", // Pour Managed Challenge
            captchaType: "cloudflareManagedChallenge",
          }
        },
      }),
      signal: AbortSignal.timeout(30000),
    });
    
    const createData = await createRes.json() as CapSolverCreateResponse;
    
    if (createData.errorId !== 0 || !createData.taskId) {
      const errorMsg = createData.errorDescription || createData.errorCode || `Error ${createData.errorId}`;
      console.error(`[capsolver] Erreur création tâche: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
    
    const taskId = createData.taskId;
    console.log(`[capsolver] Tâche créée: ${taskId}`);
    
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
          console.error(`[capsolver] Erreur poll: ${resultData.errorCode || resultData.errorId}`);
          continue;
        }
        
        if (resultData.status === "ready") {
          const solution = resultData.solution;
          if (!solution || !solution.token) {
            console.error("[capsolver] Solution ready mais token absent");
            return { success: false, error: "Token absent dans la solution" };
          }
          
          console.log(`[capsolver] Challenge résolu! Token: ${solution.token.slice(0, 20)}...`);
          console.log(`[capsolver] User-Agent: ${solution.userAgent?.slice(0, 50)}...`);
          console.log(`[capsolver] Cookies: ${solution.cookies?.length || 0}`);
          console.log(`[capsolver] Headers: ${Object.keys(solution.headers || {}).length}`);
          
          return {
            success: true,
            token: solution.token,
            userAgent: solution.userAgent,
            cookies: solution.cookies,
            headers: solution.headers,
            proxy: solution.proxy,
          };
        }
        
        console.log(`[capsolver] Poll #${i + 1} — ${resultData.status}`);
        
      } catch (error) {
        console.warn(`[capsolver] Erreur réseau poll #${i + 1}:`, error instanceof Error ? error.message : error);
      }
    }
    
    console.error("[capsolver] Timeout après", CAPSOLVER_MAX_POLLS, "polls");
    return { success: false, error: "Timeout" };
    
  } catch (error) {
    console.error("[capsolver] Erreur résolution:", error instanceof Error ? error.message : error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Applique la solution CapSolver à la page
 * Configure les cookies, headers, user-agent selon les recommandations
 */
export async function applyCapSolverSolution(
  page: Page,
  solution: {
    token: string;
    userAgent?: string;
    cookies?: Array<{ name: string; value: string }>;
    headers?: Record<string, string>;
    proxy?: string;
  }
): Promise<boolean> {
  console.log("[capsolver] Application de la solution...");
  
  try {
    const context = page.context();
    
    // 1. Configurer le user-agent si fourni
    if (solution.userAgent) {
      console.log(`[capsolver] Configuration User-Agent: ${solution.userAgent.slice(0, 50)}...`);
      await page.setExtraHTTPHeaders({
        'User-Agent': solution.userAgent,
      });
    }
    
    // 2. Ajouter les cookies
    if (solution.cookies && solution.cookies.length > 0) {
      console.log(`[capsolver] Ajout de ${solution.cookies.length} cookies...`);
      
      // D'abord nettoyer les cookies existants
      const existingCookies = await context.cookies();
      await context.clearCookies();
      
      // Ajouter les nouveaux cookies
      const cookiesToAdd = solution.cookies.map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: new URL(page.url()).hostname,
        path: "/",
        // Valeurs par défaut
        expires: Math.floor(Date.now() / 1000) + 3600, // 1 heure
        httpOnly: cookie.name === 'cf_clearance',
        secure: true,
        sameSite: 'None' as const,
      }));
      
      await context.addCookies(cookiesToAdd);
      
      // Vérifier le cookie cf_clearance
      const cfClearanceCookie = solution.cookies.find(c => c.name === 'cf_clearance');
      if (cfClearanceCookie) {
        console.log(`[capsolver] Cookie cf_clearance ajouté: ${cfClearanceCookie.value.slice(0, 20)}...`);
      }
    }
    
    // 3. Ajouter le token comme cookie cf_clearance (recommandation CapSolver)
    console.log(`[capsolver] Ajout token comme cf_clearance: ${solution.token.slice(0, 20)}...`);
    
    await context.addCookies([{
      name: 'cf_clearance',
      value: solution.token,
      domain: new URL(page.url()).hostname,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 7200, // 2 heures
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    }]);
    
    // 4. Ajouter les headers supplémentaires
    if (solution.headers) {
      console.log(`[capsolver] Ajout de ${Object.keys(solution.headers).length} headers...`);
      
      const currentHeaders = await page.evaluate(() => {
        // Récupérer les headers actuels n'est pas direct, on les combine
        return {};
      });
      
      const allHeaders = { ...currentHeaders, ...solution.headers };
      await page.setExtraHTTPHeaders(allHeaders);
    }
    
    console.log("[capsolver] Solution appliquée avec succès");
    return true;
    
  } catch (error) {
    console.error("[capsolver] Erreur application solution:", error);
    return false;
  }
}

/**
 * Méthode complète pour résoudre et appliquer Cloudflare Challenge
 */
export async function solveAndApplyCloudflareChallenge(
  page: Page,
  capsolverApiKey: string,
  proxyUrl: string
): Promise<boolean> {
  console.log("[capsolver] Résolution complète Cloudflare Challenge...");
  
  // 1. Résoudre le challenge
  const solution = await solveCloudflareChallenge(page, capsolverApiKey, proxyUrl);
  
  if (!solution.success || !solution.token) {
    console.error("[capsolver] Échec résolution challenge");
    return false;
  }
  
  // 2. Appliquer la solution
  const applied = await applyCapSolverSolution(page, solution);
  
  if (!applied) {
    console.error("[capsolver] Échec application solution");
    return false;
  }
  
  // 3. Recharger la page avec la nouvelle configuration
  console.log("[capsolver] Rechargement de la page avec la nouvelle configuration...");
  
  try {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 });
    
    // Vérifier si Cloudflare est toujours présent
    const title = await page.title();
    const isCloudflare = /un instant|just a moment|verifying/i.test(title);
    
    if (isCloudflare) {
      console.error("[capsolver] Cloudflare toujours présent après application");
      
      // Vérifier les cookies
      const cookies = await page.context().cookies();
      const cfClearance = cookies.find(c => c.name === 'cf_clearance');
      console.log(`[capsolver] Cookie cf_clearance présent: ${cfClearance ? "OUI" : "NON"}`);
      
      if (cfClearance) {
        console.log(`[capsolver] Valeur: ${cfClearance.value.slice(0, 20)}...`);
      }
      
      return false;
    }
    
    console.log("[capsolver] ✅ Cloudflare résolu avec succès!");
    return true;
    
  } catch (error) {
    console.error("[capsolver] Erreur rechargement:", error);
    return false;
  }
}