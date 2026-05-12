/**
 * analyze-spain-capture.ts — Analyse les captures réseau España
 * 
 * Usage:
 *   npx tsx scripts/analyze-spain-capture.ts [fichier-capture.json]
 * 
 * Exemples:
 *   npx tsx scripts/analyze-spain-capture.ts captured/spain/capture-1234567890.json
 *   npx tsx scripts/analyze-spain-capture.ts (analyse le dernier fichier)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface ApiCall {
  url: string;
  method: string;
  status: number;
  timestamp: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  bodyPreview: string;
}

interface CaptureData {
  startedAt: string;
  endedAt: string;
  targetUrl: string;
  apiCalls: ApiCall[];
  requests: Array<{ url: string; method: string }>;
  responses: Array<{ url: string; status: number }>;
}

function extractEndpoint(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathParts = urlObj.pathname.split('/');
    return pathParts[pathParts.length - 1] || pathParts[pathParts.length - 2] || 'unknown';
  } catch {
    return 'invalid-url';
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

function isBookititApi(url: string): boolean {
  return url.includes('api.bookitit.com') || url.includes('bookitit.com/api');
}

function isCloudflare(url: string): boolean {
  return url.includes('cloudflare.com') || url.includes('challenges.cloudflare.com');
}

function analyzeCapture(filePath: string) {
  console.log('🔍 Analyse de la capture:', filePath);
  
  const rawData = fs.readFileSync(filePath, 'utf-8');
  const capture: CaptureData = JSON.parse(rawData);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 RAPPORT D\'ANALYSE - API ESPAÑA');
  console.log('═══════════════════════════════════════════════════════════════');
  
  console.log(`\n📅 Capture du: ${new Date(capture.startedAt).toLocaleString()}`);
  console.log(`🎯 URL cible: ${capture.targetUrl}`);
  console.log(`⏱️  Durée: ${new Date(capture.endedAt).getTime() - new Date(capture.startedAt).getTime()}ms`);
  
  console.log(`\n📈 STATISTIQUES GÉNÉRALES:`);
  console.log(`   - Requêtes totales: ${capture.requests.length}`);
  console.log(`   - Réponses totales: ${capture.responses.length}`);
  console.log(`   - Appels API Bookitit: ${capture.apiCalls.length}`);
  
  // Analyser les appels API Bookitit
  const bookititCalls = capture.apiCalls.filter(call => isBookititApi(call.url));
  const cloudflareCalls = capture.apiCalls.filter(call => isCloudflare(call.url));
  
  console.log(`\n🔍 APPELS API BOOKITIT (${bookititCalls.length}):`);
  
  if (bookititCalls.length === 0) {
    console.log('   ❌ Aucun appel API Bookitit détecté!');
    console.log('   💡 Vérifiez que vous avez bien navigué jusqu\'au message "No hay horas disponibles"');
  } else {
    // Grouper par endpoint
    const endpoints = new Map<string, ApiCall[]>();
    
    bookititCalls.forEach(call => {
      const endpoint = extractEndpoint(call.url);
      if (!endpoints.has(endpoint)) {
        endpoints.set(endpoint, []);
      }
      endpoints.get(endpoint)!.push(call);
    });
    
    console.log(`\n   📋 Endpoints découverts:`);
    endpoints.forEach((calls, endpoint) => {
      console.log(`      - ${endpoint}: ${calls.length} appel(s)`);
      
      // Afficher un exemple pour chaque endpoint
      if (calls.length > 0) {
        const example = calls[0];
        console.log(`        Exemple: ${example.method} ${example.url}`);
        console.log(`        Status: ${example.status}`);
        
        if (example.bodyPreview && example.bodyPreview.length > 0) {
          console.log(`        Preview: ${example.bodyPreview.substring(0, 100)}...`);
        }
        console.log('');
      }
    });
    
    // Analyser les patterns d'URL
    console.log(`\n   🌐 Patterns d'URL:`);
    const uniqueUrls = new Set(bookititCalls.map(call => call.url));
    uniqueUrls.forEach(url => {
      console.log(`      - ${url}`);
    });
    
    // Analyser les headers communs
    console.log(`\n   📨 Headers communs:`);
    if (bookititCalls.length > 0) {
      const sampleHeaders = bookititCalls[0].requestHeaders;
      Object.entries(sampleHeaders).forEach(([key, value]) => {
        if (key.toLowerCase().includes('auth') || key.toLowerCase().includes('token') || 
            key.toLowerCase().includes('cookie') || key.toLowerCase().includes('referer')) {
          console.log(`      - ${key}: ${value.substring(0, 50)}${value.length > 50 ? '...' : ''}`);
        }
      });
    }
  }
  
  console.log(`\n🛡️  APPELS CLOUDFLARE (${cloudflareCalls.length}):`);
  if (cloudflareCalls.length > 0) {
    const cfEndpoints = new Map<string, number>();
    cloudflareCalls.forEach(call => {
      const endpoint = extractEndpoint(call.url);
      cfEndpoints.set(endpoint, (cfEndpoints.get(endpoint) || 0) + 1);
    });
    
    cfEndpoints.forEach((count, endpoint) => {
      console.log(`   - ${endpoint}: ${count} appel(s)`);
    });
  }
  
  // Chercher des tokens intéressants
  console.log(`\n🔑 TOKENS ET IDENTIFIANTS:`);
  
  const allText = JSON.stringify(capture).toLowerCase();
  const tokens = [
    { name: 'bktToken', pattern: /bkt[_-]?token["']?\s*:\s*["']([^"']+)/i },
    { name: 'publickey', pattern: /publickey["']?\s*:\s*["']([^"']+)/i },
    { name: 'widget_id', pattern: /widget[_-]?id["']?\s*:\s*["']([^"']+)/i },
    { name: 'cf_clearance', pattern: /cf[_-]?clearance["']?\s*:\s*["']([^"']+)/i },
    { name: 'session', pattern: /session["']?\s*:\s*["']([^"']+)/i },
  ];
  
  tokens.forEach(token => {
    const match = allText.match(token.pattern);
    if (match) {
      console.log(`   - ${token.name}: ${match[1].substring(0, 30)}...`);
    }
  });
  
  // Recommandations
  console.log(`\n💡 RECOMMANDATIONS:`);
  
  if (bookititCalls.length === 0) {
    console.log(`   1. ❌ Relancer la capture en suivant scrupuleusement le guide`);
    console.log(`   2. Vérifier que vous passez bien le challenge Cloudflare`);
    console.log(`   3. Attendre la redirection #services`);
  } else {
    console.log(`   1. ✅ Capture réussie! ${bookititCalls.length} appels API détectés`);
    console.log(`   2. Analyser les endpoints pour comprendre le flux`);
    console.log(`   3. Extraire les tokens d'authentification`);
    console.log(`   4. Tester les appels API directement`);
  }
  
  console.log(`\n📁 Fichiers de sortie:`);
  console.log(`   - ${filePath} (données complètes)`);
  
  const summaryFile = filePath.replace(/capture-/, 'api-summary-');
  if (fs.existsSync(summaryFile)) {
    console.log(`   - ${summaryFile} (résumé API)`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

function findLatestCapture() {
  const captureDir = path.join(__dirname, '..', 'captured', 'spain');
  
  if (!fs.existsSync(captureDir)) {
    console.error('❌ Dossier de capture introuvable:', captureDir);
    console.log('💡 Exécutez d\'abord: pnpm run spain:capture');
    process.exit(1);
  }
  
  const files = fs.readdirSync(captureDir)
    .filter(file => file.startsWith('capture-') && file.endsWith('.json'))
    .map(file => ({
      name: file,
      path: path.join(captureDir, file),
      time: fs.statSync(path.join(captureDir, file)).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time);
  
  if (files.length === 0) {
    console.error('❌ Aucun fichier de capture trouvé');
    console.log('💡 Exécutez d\'abord: pnpm run spain:capture');
    process.exit(1);
  }
  
  return files[0].path;
}

async function main() {
  const args = process.argv.slice(2);
  let captureFile: string;
  
  if (args.length > 0) {
    captureFile = args[0];
    if (!fs.existsSync(captureFile)) {
      console.error(`❌ Fichier non trouvé: ${captureFile}`);
      process.exit(1);
    }
  } else {
    console.log('🔍 Recherche de la dernière capture...');
    captureFile = findLatestCapture();
    console.log(`📁 Utilisation du fichier: ${captureFile}`);
  }
  
  try {
    analyzeCapture(captureFile);
  } catch (error) {
    console.error('❌ Erreur lors de l\'analyse:', error);
    process.exit(1);
  }
}

main().catch(console.error);