/**
 * Module pour gérer les proxies Bright Data avec IP fixe/session
 * 
 * Pour CapSolver AntiCloudflareTask, nous avons besoin d'une IP fixe.
 * Bright Data offre plusieurs options:
 * 
 * 1. Sessions collantes (-session-<id>) - garde même IP pendant session
 * 2. ISP proxy dédié - plus stable que residential
 * 3. Datacenter proxy dédié - IP vraiment fixe
 * 
 * Format proxy Bright Data:
 * http://brd-customer-<account_id>-zone-<proxy_type>-session-<session_id>:<password>@brd.superproxy.io:33335
 */

export interface BrightDataProxyConfig {
  /** ID client Bright Data (ex: hl_f0e9b823) */
  accountId: string;
  /** Type de proxy: residential_proxy1, isp_proxy1, datacenter_proxy1 */
  proxyType: string;
  /** Mot de passe du proxy */
  password: string;
  /** ID de session pour IP collante (optionnel) */
  sessionId?: string;
  /** Pays (optionnel, ex: country-cd) */
  country?: string;
  /** Ville (optionnel, ex: city-kinshasa) */
  city?: string;
}

/**
 * Construit une URL proxy Bright Data
 */
export function buildBrightDataUrl(config: BrightDataProxyConfig): string {
  // Construction du username
  let username = `brd-customer-${config.accountId}-zone-${config.proxyType}`;
  
  // Ajouter pays/ville si spécifiés
  if (config.country) {
    username += `-${config.country}`;
  }
  if (config.city) {
    username += `-${config.city}`;
  }
  
  // Ajouter session ID si spécifié
  if (config.sessionId) {
    username += `-session-${config.sessionId}`;
  }
  
  // URL complète
  return `http://${username}:${config.password}@brd.superproxy.io:33335`;
}

/**
 * Parse une URL Bright Data existante
 */
export function parseBrightDataUrl(proxyUrl: string): BrightDataProxyConfig | null {
  try {
    const url = new URL(proxyUrl);
    const username = decodeURIComponent(url.username);
    
    // Pattern: brd-customer-{accountId}-zone-{proxyType}[-country-{country}][-city-{city}][-session-{sessionId}]
    const pattern = /^brd-customer-(?<accountId>[^-]+)-zone-(?<proxyType>[^-]+)(?:-(?<extra>.*))?$/;
    const match = username.match(pattern);
    
    if (!match || !match.groups) {
      return null;
    }
    
    const config: BrightDataProxyConfig = {
      accountId: match.groups.accountId,
      proxyType: match.groups.proxyType,
      password: decodeURIComponent(url.password),
    };
    
    // Analyser les parties supplémentaires
    if (match.groups.extra) {
      const parts = match.groups.extra.split('-');
      
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === 'country' && i + 1 < parts.length) {
          config.country = parts[i + 1];
          i++;
        } else if (parts[i] === 'city' && i + 1 < parts.length) {
          config.city = parts[i + 1];
          i++;
        } else if (parts[i] === 'session' && i + 1 < parts.length) {
          config.sessionId = parts[i + 1];
          i++;
        }
      }
    }
    
    return config;
  } catch (error) {
    console.error("Erreur parsing URL Bright Data:", error);
    return null;
  }
}

/**
 * Convertit une URL Bright Data au format CapSolver
 * Format CapSolver: host:port:user:pass
 */
export function brightDataToCapSolverFormat(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    const host = url.hostname; // brd.superproxy.io
    const port = url.port || "33335";
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    
    return `${host}:${port}:${username}:${password}`;
  } catch (error) {
    console.error("Erreur conversion format CapSolver:", error);
    return proxyUrl;
  }
}

/**
 * Génère un ID de session unique basé sur le timestamp
 * Format: session_YYYYMMDD_HHMMSS
 */
export function generateSessionId(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  return `session_${year}${month}${day}_${hours}${minutes}${seconds}`;
}

/**
 * Vérifie si un proxy Bright Data a une session fixe
 */
export function hasFixedSession(proxyUrl: string): boolean {
  const config = parseBrightDataUrl(proxyUrl);
  return config !== null && config.sessionId !== undefined;
}

/**
 * Ajoute/remplace une session à une URL Bright Data
 */
export function withSession(proxyUrl: string, sessionId?: string): string {
  const config = parseBrightDataUrl(proxyUrl);
  
  if (!config) {
    return proxyUrl;
  }
  
  config.sessionId = sessionId || generateSessionId();
  return buildBrightDataUrl(config);
}

/**
 * Teste la connectivité d'un proxy Bright Data
 */
export async function testBrightDataProxy(proxyUrl: string): Promise<{
  success: boolean;
  ip?: string;
  country?: string;
  city?: string;
  product?: string;
  error?: string;
}> {
  const testUrl = "https://geo.brdtest.com/welcome.txt?product=isp&method=native";
  
  try {
    // Convertir l'URL pour fetch
    const url = new URL(proxyUrl);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const host = url.hostname;
    const port = url.port || "33335";
    
    const proxy = `http://${host}:${port}`;
    const auth = `${username}:${password}`;
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Proxy-Authorization': `Basic ${Buffer.from(auth).toString('base64')}`,
      },
      // Note: Node.js fetch ne supporte pas directement les proxies
      // Nous utilisons une approche différente
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`
      };
    }
    
    const text = await response.text();
    
    // Extraire les informations de la réponse
    const ipMatch = text.match(/IP:\s*([\d\.]+)/);
    const countryMatch = text.match(/Country:\s*([^,\n]+)/);
    const cityMatch = text.match(/City:\s*([^,\n]+)/);
    const productMatch = text.match(/Product:\s*([^,\n]+)/);
    
    return {
      success: true,
      ip: ipMatch ? ipMatch[1] : undefined,
      country: countryMatch ? countryMatch[1] : undefined,
      city: cityMatch ? cityMatch[1] : undefined,
      product: productMatch ? productMatch[1] : undefined,
    };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Recommande le meilleur type de proxy pour CapSolver
 */
export function recommendProxyType(): {
  type: string;
  description: string;
  stability: 'high' | 'medium' | 'low';
  cost: 'high' | 'medium' | 'low';
} {
  // Basé sur la documentation Bright Data
  return {
    type: 'isp_proxy1',
    description: 'ISP proxy dédié - plus stable que residential, bon pour Cloudflare',
    stability: 'high',
    cost: 'medium'
  };
}

/**
 * Configuration optimale pour CapSolver AntiCloudflareTask
 */
export function getOptimalCapSolverConfig(): {
  proxyType: string;
  useSession: boolean;
  sessionDuration: string;
  keepAlive: boolean;
} {
  return {
    proxyType: 'isp_proxy1', // ISP proxy plus stable
    useSession: true, // Utiliser session pour IP collante
    sessionDuration: '10-30 minutes', // Durée typique d'une session
    keepAlive: true, // Envoyer des requêtes keep-alive
  };
}