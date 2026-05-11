
export interface WebUnlockerResponse {
  success: boolean;
  html?: string;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }>;
  headers?: Record<string, string>;
  error?: string;
}

export async function fetchWithWebUnlocker(
  url: string,
  zone: string = "web_unlocker1"
): Promise<WebUnlockerResponse> {
  const API_KEY = process.env.BRIGHTDATA_WEB_UNLOCKER_KEY || "04390ede-cb89-4a42-a4d0-d9a9c7bf8769";
  
  try {
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        zone,
        url,
        format: "raw",
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        unlocker: {
          mode: "auto",
          response_format: "html",
          wait_for: 10000, // 10 secondes pour le déblocage
          retries: 2,
        }
      }),
    });
    
    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    
    const html = await response.text();
    
    // Extraire les cookies
    const cookies: Array<any> = [];
    const setCookieHeader = response.headers.get('set-cookie');
    
    if (setCookieHeader) {
      const cookieStrings = setCookieHeader.split(',').map(c => c.trim());
      
      cookieStrings.forEach(cookieStr => {
        const nameMatch = cookieStr.match(/^([^=]+)=/);
        if (nameMatch) {
          const name = nameMatch[1];
          const valueMatch = cookieStr.match(/=([^;]+)/);
          const value = valueMatch ? valueMatch[1] : '';
          
          cookies.push({
            name,
            value,
            domain: new URL(url).hostname,
            path: "/",
            expires: Math.floor(Date.now() / 1000) + 7200,
            httpOnly: name.includes('cf_') || name.includes('session'),
            secure: true,
            sameSite: "None",
          });
        }
      });
    }
    
    // Extraire les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    
    return {
      success: true,
      html,
      cookies,
      headers,
    };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
