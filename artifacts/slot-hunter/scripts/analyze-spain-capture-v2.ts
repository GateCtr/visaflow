/**
 * analyze-spain-capture-v2.ts — Analyse améliorée des captures réseau España
 * 
 * Détecte les APIs Bookitit sur citaconsular.es/onlinebookings/
 * 
 * Usage:
 *   npx tsx scripts/analyze-spain-capture-v2.ts [fichier-capture.json]
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
  requests: Array<{ 
    id: number;
    timestamp: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    postData: string | null;
  }>;
  responses: Array<{
    id: number;
    timestamp: string;
    requestId: number;
    url: string;
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string | null;
    bodyTruncated: boolean;
  }>;
}

function isBookititApi(url: string): boolean {
  const apiPatterns = [
    'onlinebookings/',
    'getservices',
    'getagendas', 
    'datetime',
    'signin',
    'signup',
    'summary',
    'confirmclient'
  ];
  
  return apiPatterns.some(pattern => url.includes(pattern));
}

function extractApiInfo(url: string): {
  endpoint: string;
  params: Record<string, string>;
  isJsonp: boolean;
} {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const endpoint = pathname.split('/').pop() || 'unknown';
    
    // Extraire les paramètres
    const params: Record<string, string> = {};
    urlObj.searchParams.forEach((value, key) => {
      params[key] = value;
    });
    
    // Détecter JSONP
    const isJsonp = url.includes('callback=') || url.includes('jQuery');
    
    return { endpoint, params, isJsonp };
  } catch {
    return { endpoint: 'invalid-url', params: {}, isJsonp: false };
  }
}

function analyzeCapture(filePath: string) {
  console.log('🔍 Analyse de la capture:', filePath);
  
  const rawData = fs.readFileSync(filePath, 'utf-8');
  const capture: CaptureData = JSON.parse(rawData);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 RAPPORT D\'ANALYSE - API ESPAÑA (V2)');
  console.log('═══════════════════════════════════════════════════════════════');
  
  console.log(`\n📅 Capture du: ${new Date(capture.startedAt).toLocaleString()}`);
  console.log(`🎯 URL cible: ${capture.targetUrl}`);
  console.log(`⏱️  Durée: ${new Date(capture.endedAt).getTime() - new Date(capture.startedAt).getTime()}ms`);
  
  // Trouver toutes les requêtes API Bookitit
  const apiRequests = capture.requests.filter(req => isBookititApi(req.url));
  const apiResponses = capture.responses.filter(res => isBookititApi(res.url));
  
  console.log(`\n📈 STATISTIQUES GÉNÉRALES:`);
  console.log(`   - Requêtes totales: ${capture.requests.length}`);
  console.log(`   - Réponses totales: ${capture.responses.length}`);
  console.log(`   - Requêtes API Bookitit: ${apiRequests.length}`);
  console.log(`   - Réponses API Bookitit: ${apiResponses.length}`);
  
  if (apiRequests.length === 0) {
    console.log(`\n❌ Aucune requête API Bookitit détectée!`);
    console.log(`💡 Les APIs sont probablement sur: citaconsular.es/onlinebookings/`);
    
    // Chercher manuellement dans les URLs
    console.log(`\n🔍 Recherche manuelle dans les URLs:`);
    const allUrls = capture.requests.map(req => req.url);
    const potentialApis = allUrls.filter(url => 
      url.includes('citaconsular.es') && 
      (url.includes('get') || url.includes('api') || url.includes('booking'))
    );
    
    potentialApis.slice(0, 10).forEach(url => {
      console.log(`   - ${url.substring(0, 120)}...`);
    });
    
    if (potentialApis.length > 10) {
      console.log(`   ... et ${potentialApis.length - 10} autres`);
    }
  } else {
    console.log(`\n✅ ${apiRequests.length} REQUÊTES API BOOKITIT DÉTECTÉES!`);
    
    // Grouper par endpoint
    const endpoints = new Map<string, Array<{
      request: typeof apiRequests[0];
      response?: typeof apiResponses[0];
    }>>();
    
    apiRequests.forEach(req => {
      const { endpoint } = extractApiInfo(req.url);
      if (!endpoints.has(endpoint)) {
        endpoints.set(endpoint, []);
      }
      
      const response = apiResponses.find(res => 
        res.url === req.url || res.requestId === req.id
      );
      
      endpoints.get(endpoint)!.push({ request: req, response });
    });
    
    console.log(`\n📋 ENDPOINTS DÉCOUVERTS:`);
    endpoints.forEach((calls, endpoint) => {
      console.log(`\n   🎯 ${endpoint.toUpperCase()} (${calls.length} appel(s)):`);
      
      calls.forEach((call, index) => {
        const { params, isJsonp } = extractApiInfo(call.request.url);
        
        console.log(`\n      Appel ${index + 1}:`);
        console.log(`        URL: ${call.request.url.substring(0, 100)}...`);
        console.log(`        Méthode: ${call.request.method}`);
        console.log(`        Timestamp: ${call.request.timestamp}`);
        console.log(`        Format: ${isJsonp ? 'JSONP' : 'JSON'}`);
        
        if (call.response) {
          console.log(`        Status: ${call.response.status} ${call.response.statusText}`);
          
          if (call.response.body && call.response.body.length > 0) {
            // Essayer d'extraire le JSON du JSONP
            let bodyPreview = call.response.body;
            if (isJsonp && bodyPreview.includes('(') && bodyPreview.includes(')')) {
              const jsonStart = bodyPreview.indexOf('(') + 1;
              const jsonEnd = bodyPreview.lastIndexOf(')');
              bodyPreview = bodyPreview.substring(jsonStart, jsonEnd);
            }
            
            console.log(`        Body preview: ${bodyPreview.substring(0, 150)}...`);
          }
        }
        
        // Afficher les paramètres importants
        const importantParams = Object.entries(params)
          .filter(([key]) => 
            key.includes('key') || 
            key.includes('id') || 
            key.includes('lang') || 
            key.includes('type') ||
            key === 'publickey' ||
            key === 'widget_id'
          );
        
        if (importantParams.length > 0) {
          console.log(`        Paramètres clés:`);
          importantParams.forEach(([key, value]) => {
            console.log(`          - ${key}: ${value.substring(0, 30)}${value.length > 30 ? '...' : ''}`);
          });
        }
      });
    });
    
    // Extraire les tokens et identifiants
    console.log(`\n🔑 IDENTIFIANTS ET TOKENS:`);
    
    const allText = JSON.stringify(capture);
    const tokenPatterns = [
      { name: 'publickey', regex: /["']?publickey["']?\s*[:=]\s*["']([^"']+)/gi },
      { name: 'widget_id', regex: /["']?widget[_-]?id["']?\s*[:=]\s*["']([^"']+)/gi },
      { name: 'bktToken', regex: /["']?bkt[_-]?token["']?\s*[:=]\s*["']([^"']+)/gi },
      { name: 'callback', regex: /callback=([^&]+)/gi },
    ];
    
    const foundTokens = new Set<string>();
    
    tokenPatterns.forEach(pattern => {
      const matches = [...allText.matchAll(pattern.regex)];
      matches.forEach(match => {
        if (match[1] && match[1].length > 5) {
          const token = `${pattern.name}: ${match[1].substring(0, 30)}${match[1].length > 30 ? '...' : ''}`;
          if (!foundTokens.has(token)) {
            foundTokens.add(token);
            console.log(`   - ${token}`);
          }
        }
      });
    });
    
    // Analyser les patterns d'URL
    console.log(`\n🌐 PATTERNS D'URL API:`);
    const uniqueApiUrls = new Set(apiRequests.map(req => {
      const url = new URL(req.url);
      return `${url.origin}${url.pathname}`;
    }));
    
    uniqueApiUrls.forEach(baseUrl => {
      console.log(`   - ${baseUrl}`);
      
      // Compter les appels par base URL
      const callCount = apiRequests.filter(req => 
        req.url.startsWith(baseUrl)
      ).length;
      
      console.log(`     (${callCount} appel(s))`);
    });
  }
  
  // Recommandations
  console.log(`\n💡 RECOMMANDATIONS:`);
  
  if (apiRequests.length > 0) {
    console.log(`   1. ✅ Capture réussie! ${apiRequests.length} appels API détectés`);
    console.log(`   2. Analyser les endpoints pour comprendre le flux`);
    console.log(`   3. Tester les appels API directement avec les paramètres capturés`);
    console.log(`   4. Vérifier si l'API nécessite des cookies Cloudflare`);
  } else {
    console.log(`   1. ❌ Relancer la capture en suivant scrupuleusement le guide`);
    console.log(`   2. S'assurer de cliquer sur "continuer" et d'attendre #services`);
    console.log(`   3. Vérifier que le challenge Cloudflare est passé`);
    console.log(`   4. L'API est probablement sur: citaconsular.es/onlinebookings/`);
  }
  
  console.log(`\n📁 Fichier analysé: ${filePath}`);
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