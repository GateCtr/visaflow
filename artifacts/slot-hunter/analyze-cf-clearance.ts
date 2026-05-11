import * as fs from 'fs';
import * as path from 'path';

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
  partitionKey?: string;
  _crHasCrossSiteAncestor?: boolean;
}

function analyzeCfClearance(cookieValue: string) {
  console.log("Analyse du cookie cf_clearance...");
  console.log(`Longueur totale: ${cookieValue.length} caractères`);
  
  // Le cookie cf_clearance a généralement ce format:
  // <token>.<timestamp>-<version>.<signature>.<additional_data>
  
  const parts = cookieValue.split('.');
  console.log(`\nNombre de parties séparées par '.': ${parts.length}`);
  
  for (let i = 0; i < parts.length; i++) {
    console.log(`Part ${i}: ${parts[i].slice(0, 50)}... (${parts[i].length} chars)`);
  }
  
  // Essayer de décoder les parties
  if (parts.length >= 3) {
    console.log("\nAnalyse des parties:");
    
    // Partie 1: Token principal
    const token = parts[0];
    console.log(`1. Token principal: ${token.slice(0, 20)}...`);
    
    // Partie 2: Timestamp et version
    const timestampVersion = parts[1];
    const subParts = timestampVersion.split('-');
    console.log(`2. Timestamp/Version: ${timestampVersion}`);
    
    if (subParts.length >= 2) {
      const timestamp = parseInt(subParts[0]);
      const version = subParts[1];
      const date = new Date(timestamp * 1000);
      console.log(`   - Timestamp: ${timestamp} (${date.toISOString()})`);
      console.log(`   - Version: ${version}`);
    }
    
    // Partie 3: Signature
    const signature = parts[2];
    console.log(`3. Signature: ${signature.slice(0, 20)}... (${signature.length} chars)`);
    
    // Parties supplémentaires
    if (parts.length > 3) {
      console.log(`4. Données supplémentaires: ${parts.slice(3).join('.')}`);
    }
  }
  
  // Chercher des patterns dans le cookie
  console.log("\nRecherche de patterns:");
  
  // Pattern base64
  const base64Pattern = /^[A-Za-z0-9+/=]+$/;
  for (let i = 0; i < Math.min(parts.length, 3); i++) {
    if (base64Pattern.test(parts[i])) {
      console.log(`Part ${i} semble être en base64`);
      try {
        const decoded = Buffer.from(parts[i], 'base64').toString('utf-8');
        console.log(`  Décodé: ${decoded.slice(0, 100)}...`);
      } catch (e) {
        console.log(`  Erreur décodage base64: ${e}`);
      }
    }
  }
  
  // Vérifier si c'est un JWT
  if (parts.length === 3) {
    console.log("\nStructure JWT détectée (3 parties)");
    try {
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf-8'));
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
      console.log("Header:", JSON.stringify(header, null, 2));
      console.log("Payload:", JSON.stringify(payload, null, 2));
    } catch (e) {
      console.log("Pas un JWT standard");
    }
  }
}

async function main() {
  const captureDir = path.join(process.cwd(), 'cloudflare-capture');
  const cookiesPath = path.join(captureDir, 'cookies.json');
  
  if (!fs.existsSync(cookiesPath)) {
    console.error(`Fichier ${cookiesPath} non trouvé`);
    return;
  }
  
  const cookiesData = fs.readFileSync(cookiesPath, 'utf-8');
  const cookies: Cookie[] = JSON.parse(cookiesData);
  
  console.log(`Total cookies: ${cookies.length}`);
  
  const cfClearance = cookies.find(c => c.name === 'cf_clearance');
  
  if (!cfClearance) {
    console.error("Cookie cf_clearance non trouvé");
    return;
  }
  
  console.log(`\nCookie cf_clearance trouvé:`);
  console.log(`- Domain: ${cfClearance.domain}`);
  console.log(`- Path: ${cfClearance.path}`);
  console.log(`- Expires: ${new Date(cfClearance.expires * 1000).toISOString()}`);
  console.log(`- HttpOnly: ${cfClearance.httpOnly}`);
  console.log(`- Secure: ${cfClearance.secure}`);
  console.log(`- SameSite: ${cfClearance.sameSite}`);
  
  analyzeCfClearance(cfClearance.value);
  
  // Analyser aussi les autres cookies Cloudflare
  const cfCookies = cookies.filter(c => c.name.startsWith('cf_'));
  console.log(`\nAutres cookies Cloudflare: ${cfCookies.length}`);
  
  for (const cookie of cfCookies) {
    console.log(`\n${cookie.name}:`);
    console.log(`  Value: ${cookie.value.slice(0, 30)}...`);
    console.log(`  Expires: ${new Date(cookie.expires * 1000).toISOString()}`);
  }
  
  // Analyser le localStorage si disponible
  const localStoragePath = path.join(captureDir, 'localStorage.json');
  if (fs.existsSync(localStoragePath)) {
    console.log("\nAnalyse du localStorage...");
    const localStorageData = fs.readFileSync(localStoragePath, 'utf-8');
    const storage = JSON.parse(localStorageData);
    
    const cfKeys = Object.keys(storage).filter(key => 
      key.includes('cf') || key.includes('cloudflare') || key.includes('turnstile')
    );
    
    console.log(`Clés Cloudflare dans localStorage: ${cfKeys.length}`);
    for (const key of cfKeys.slice(0, 5)) {
      console.log(`  ${key}: ${storage[key]?.slice(0, 50)}...`);
    }
  }
}

main().catch(console.error);