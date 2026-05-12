// Script Playwright pour capturer les requêtes réseau du widget Bookitit España
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Configuration
const OUTPUT_DIR = './captured/spain';
const TARGET_URL = 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5';

// Créer le dossier de sortie
if (!existsSync(OUTPUT_DIR)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Données capturées
const capturedData = {
  startTime: new Date().toISOString(),
  targetUrl: TARGET_URL,
  requests: [],
  responses: [],
  consoleLogs: [],
  errors: [],
  pageContent: null,
  networkData: {
    apiCalls: [],
    jsFiles: [],
    cssFiles: [],
    images: [],
    other: []
  }
};

// Fonction pour classifier les requêtes
function classifyRequest(request) {
  const url = request.url();
  
  if (url.includes('api.bookitit.com') || url.includes('/api/')) {
    return 'api';
  } else if (url.endsWith('.js') || url.includes('.js?')) {
    return 'js';
  } else if (url.endsWith('.css') || url.includes('.css?')) {
    return 'css';
  } else if (url.match(/\.(png|jpg|jpeg|gif|svg|ico)$/i)) {
    return 'image';
  } else {
    return 'other';
  }
}

// Fonction pour extraire les informations pertinentes d'une requête
function extractRequestInfo(request) {
  return {
    url: request.url(),
    method: request.method(),
    headers: request.headers(),
    postData: request.postData(),
    resourceType: request.resourceType(),
    frame: request.frame()?.url(),
    timestamp: new Date().toISOString()
  };
}

// Fonction pour extraire les informations d'une réponse
function extractResponseInfo(response) {
  return {
    url: response.url(),
    status: response.status(),
    statusText: response.statusText(),
    headers: response.headers(),
    fromCache: response.fromCache(),
    fromServiceWorker: response.fromServiceWorker(),
    request: extractRequestInfo(response.request()),
    timestamp: new Date().toISOString()
  };
}

async function runCapture() {
  console.log('🚀 Lancement du navigateur pour capture réseau...');
  console.log(`📝 URL cible: ${TARGET_URL}`);
  console.log('📁 Données sauvegardées dans:', OUTPUT_DIR);
  console.log('\n=== INSTRUCTIONS ===');
  console.log('1. Le navigateur va s\'ouvrir');
  console.log('2. Naviguez MANUELLEMENT comme d\'habitude');
  console.log('3. Toutes les requêtes réseau seront capturées');
  console.log('4. Quand vous avez terminé, fermez le navigateur');
  console.log('5. Les données seront sauvegardées automatiquement');
  console.log('===================\n');

  const browser = await chromium.launch({ 
    headless: false,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: null, // Utiliser la taille maximale
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  // Capturer les logs de la console
  page.on('console', msg => {
    const logEntry = {
      type: msg.type(),
      text: msg.text(),
      args: msg.args().map(arg => arg.toString()),
      location: msg.location(),
      timestamp: new Date().toISOString()
    };
    capturedData.consoleLogs.push(logEntry);
    console.log(`[CONSOLE ${msg.type()}] ${msg.text()}`);
  });

  // Capturer les erreurs de page
  page.on('pageerror', error => {
    const errorEntry = {
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    };
    capturedData.errors.push(errorEntry);
    console.error(`[PAGE ERROR] ${error.message}`);
  });

  // Capturer toutes les requêtes
  page.on('request', request => {
    const requestInfo = extractRequestInfo(request);
    capturedData.requests.push(requestInfo);
    
    // Classifier et stocker
    const type = classifyRequest(request);
    capturedData.networkData[`${type}Files`].push(requestInfo);
    
    console.log(`[REQUEST ${request.method()}] ${request.url()}`);
  });

  // Capturer toutes les réponses
  page.on('response', async response => {
    const responseInfo = extractResponseInfo(response);
    capturedData.responses.push(responseInfo);
    
    // Essayer de capturer le corps pour les APIs
    if (response.url().includes('api.bookitit.com') || response.url().includes('/api/')) {
      try {
        const body = await response.text();
        responseInfo.body = body.substring(0, 5000); // Limiter la taille
        
        // Extraire les endpoints API
        const apiCall = {
          url: response.url(),
          method: response.request().method(),
          status: response.status(),
          bodyPreview: body.substring(0, 200),
          timestamp: new Date().toISOString(),
          requestHeaders: response.request().headers(),
          responseHeaders: response.headers()
        };
        capturedData.networkData.apiCalls.push(apiCall);
        
        console.log(`[API ${response.status()}] ${response.url()} - ${body.substring(0, 100)}...`);
      } catch (err) {
        console.log(`[API ${response.status()}] ${response.url()} - Failed to read body`);
      }
    }
    
    console.log(`[RESPONSE ${response.status()}] ${response.url()}`);
  });

  // Naviguer vers l'URL cible
  console.log(`🌐 Navigation vers ${TARGET_URL}...`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle' });

  // Capturer le contenu initial de la page
  capturedData.pageContent = await page.content();

  console.log('\n✅ Navigateur prêt !');
  console.log('👉 Commencez votre navigation manuelle maintenant...');
  console.log('👉 Toutes les interactions réseau sont capturées en temps réel');
  console.log('👉 Fermez le navigateur quand vous avez terminé\n');

  // Attendre que l'utilisateur ferme le navigateur
  await new Promise((resolve) => {
    page.on('close', resolve);
    browser.on('disconnected', resolve);
  });

  // Sauvegarder les données capturées
  console.log('\n💾 Sauvegarde des données capturées...');
  
  // Sauvegarder les données complètes
  writeFileSync(
    `${OUTPUT_DIR}/capture-${Date.now()}.json`,
    JSON.stringify(capturedData, null, 2),
    'utf8'
  );

  // Sauvegarder un résumé des APIs
  const apiSummary = {
    totalRequests: capturedData.requests.length,
    totalResponses: capturedData.responses.length,
    totalApiCalls: capturedData.networkData.apiCalls.length,
    apis: capturedData.networkData.apiCalls.map(api => ({
      url: api.url,
      method: api.method,
      status: api.status,
      endpoint: api.url.split('?')[0].split('/').pop(),
      domain: new URL(api.url).hostname
    })),
    uniqueEndpoints: [...new Set(capturedData.networkData.apiCalls.map(api => 
      api.url.split('?')[0].split('/').pop()
    ))],
    jsBundles: capturedData.networkData.jsFiles.map(js => ({
      url: js.url,
      size: 'unknown'
    })),
    captureTime: capturedData.startTime,
    endTime: new Date().toISOString()
  };

  writeFileSync(
    `${OUTPUT_DIR}/api-summary-${Date.now()}.json`,
    JSON.stringify(apiSummary, null, 2),
    'utf8'
  );

  // Sauvegarder les logs
  writeFileSync(
    `${OUTPUT_DIR}/console-logs-${Date.now()}.json`,
    JSON.stringify(capturedData.consoleLogs, null, 2),
    'utf8'
  );

  console.log(`✅ Capture terminée !`);
  console.log(`📊 Statistiques:`);
  console.log(`   - Requêtes: ${capturedData.requests.length}`);
  console.log(`   - Réponses: ${capturedData.responses.length}`);
  console.log(`   - Appels API: ${capturedData.networkData.apiCalls.length}`);
  console.log(`   - Fichiers JS: ${capturedData.networkData.jsFiles.length}`);
  console.log(`   - Logs console: ${capturedData.consoleLogs.length}`);
  console.log(`\n📁 Données sauvegardées dans: ${OUTPUT_DIR}`);

  await browser.close();
}

// Gestion des erreurs
process.on('SIGINT', async () => {
  console.log('\n\n⚠️  Capture interrompue par l\'utilisateur');
  console.log('💾 Sauvegarde des données partielles...');
  // Ici on pourrait sauvegarder les données même en cas d'interruption
  process.exit(0);
});

// Lancer la capture
runCapture().catch(err => {
  console.error('❌ Erreur lors de la capture:', err);
  process.exit(1);
});