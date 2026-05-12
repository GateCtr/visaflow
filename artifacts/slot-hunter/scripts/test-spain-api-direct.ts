/**
 * test-spain-api-direct.ts — Tester l'API Bookitit España directement
 * 
 * Utilise les paramètres capturés pour tester les endpoints API
 * 
 * Usage:
 *   npx tsx scripts/test-spain-api-direct.ts
 */

import * as https from 'https';
import * as http from 'http';

// Configuration basée sur la capture
const CONFIG = {
  baseUrl: 'https://www.citaconsular.es/onlinebookings',
  publickey: '25028fcd7126544630b8da0c6e60722b5',
  widgetId: '25028fcd7126544630b8da0c6e60722b5',
  lang: 'es', // ou 'fr'
  type: 'default',
  version: '4'
};

interface ApiTest {
  name: string;
  endpoint: string;
  method: 'GET' | 'POST';
  params: Record<string, string>;
  description: string;
}

const API_TESTS: ApiTest[] = [
  {
    name: 'getservices',
    endpoint: 'getservices',
    method: 'GET',
    params: {
      type: CONFIG.type,
      publickey: CONFIG.publickey,
      lang: CONFIG.lang,
      version: CONFIG.version,
      src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${CONFIG.widgetId}/`,
      srvsrc: 'https://www.citaconsular.es'
    },
    description: 'Liste des services (types de visa)'
  },
  {
    name: 'getwidgetconfigurations',
    endpoint: 'getwidgetconfigurations',
    method: 'GET',
    params: {
      type: CONFIG.type,
      publickey: CONFIG.publickey,
      lang: CONFIG.lang,
      version: CONFIG.version
    },
    description: 'Configuration du widget'
  },
  {
    name: 'main',
    endpoint: 'main',
    method: 'GET',
    params: {
      type: CONFIG.type,
      publickey: CONFIG.publickey,
      lang: CONFIG.lang,
      version: CONFIG.version
    },
    description: 'Template principal HTML'
  }
];

function buildUrl(endpoint: string, params: Record<string, string>): string {
  const url = new URL(`${CONFIG.baseUrl}/${endpoint}`);
  
  // Ajouter les paramètres
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.append(key, value);
  });
  
  // Ajouter un callback JSONP (nécessaire pour certaines APIs)
  if (!url.searchParams.has('callback')) {
    url.searchParams.append('callback', `jsonp_${Date.now()}`);
  }
  
  // Ajouter un timestamp anti-cache
  url.searchParams.append('_', Date.now().toString());
  
  return url.toString();
}

function parseJsonpResponse(body: string): any {
  // Essayer de parser la réponse JSONP
  if (body.includes('(') && body.includes(')')) {
    const jsonStart = body.indexOf('(') + 1;
    const jsonEnd = body.lastIndexOf(')');
    const jsonStr = body.substring(jsonStart, jsonEnd);
    
    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      // Si ce n'est pas du JSON valide, ça pourrait être du HTML
      return { raw: body.substring(0, 200) + '...' };
    }
  }
  
  // Essayer de parser comme JSON normal
  try {
    return JSON.parse(body);
  } catch (err) {
    return { raw: body.substring(0, 200) + '...' };
  }
}

async function testApi(test: ApiTest): Promise<{
  success: boolean;
  status?: number;
  data?: any;
  error?: string;
  url: string;
}> {
  return new Promise((resolve) => {
    const url = buildUrl(test.endpoint, test.params);
    console.log(`\n🔍 Test: ${test.name} (${test.description})`);
    console.log(`   URL: ${url.substring(0, 120)}...`);
    
    const req = https.get(url, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        console.log(`   Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`   Content-Type: ${res.headers['content-type']}`);
        console.log(`   Content-Length: ${body.length} bytes`);
        
        if (res.statusCode === 200) {
          try {
            const parsed = parseJsonpResponse(body);
            
            if (typeof parsed === 'object' && parsed !== null) {
              console.log(`   ✅ Succès! Structure:`, Object.keys(parsed));
              
              // Afficher un aperçu des données
              if (parsed.Services) {
                console.log(`   📊 Services: ${Array.isArray(parsed.Services) ? parsed.Services.length : 'N/A'}`);
                if (Array.isArray(parsed.Services) && parsed.Services.length > 0) {
                  console.log(`      Exemple: ${JSON.stringify(parsed.Services[0], null, 2).substring(0, 100)}...`);
                }
              }
              
              if (parsed.WidgetConfiguration) {
                console.log(`   ⚙️  Configuration:`, Object.keys(parsed.WidgetConfiguration));
              }
            } else {
              console.log(`   📄 Réponse: ${body.substring(0, 150)}...`);
            }
            
            resolve({
              success: true,
              status: res.statusCode,
              data: parsed,
              url
            });
          } catch (err) {
            console.log(`   📄 Réponse (raw): ${body.substring(0, 200)}...`);
            resolve({
              success: true,
              status: res.statusCode,
              data: { raw: body.substring(0, 500) },
              url
            });
          }
        } else {
          console.log(`   ❌ Erreur HTTP: ${res.statusCode}`);
          console.log(`   📄 Réponse: ${body.substring(0, 200)}...`);
          resolve({
            success: false,
            status: res.statusCode,
            error: `HTTP ${res.statusCode}`,
            url
          });
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`   ❌ Erreur réseau: ${err.message}`);
      resolve({
        success: false,
        error: err.message,
        url
      });
    });
    
    req.setTimeout(10000, () => {
      console.log(`   ⏱️  Timeout après 10s`);
      req.destroy();
      resolve({
        success: false,
        error: 'Timeout',
        url
      });
    });
  });
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 TESTS API BOOKITIT ESPAÑA');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Base URL: ${CONFIG.baseUrl}`);
  console.log(`Public Key: ${CONFIG.publickey}`);
  console.log(`Langue: ${CONFIG.lang}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const results = [];
  
  for (const test of API_TESTS) {
    const result = await testApi(test);
    results.push(result);
    
    // Petite pause entre les tests
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  // Résumé
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ DES TESTS');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Succès: ${successful}/${results.length}`);
  console.log(`❌ Échecs: ${failed}/${results.length}`);
  
  if (successful > 0) {
    console.log('\n🎯 API ACCESSIBLE! Prochaines étapes:');
    console.log('   1. Tester avec la langue française (lang=fr)');
    console.log('   2. Chercher les endpoints getagendas/, datetime/, etc.');
    console.log('   3. Tester l\'authentification (signin/, signup/)');
    console.log('   4. Vérifier les créneaux disponibles (datetime/)');
  } else {
    console.log('\n⚠️  API INACCESSIBLE. Causes possibles:');
    console.log('   1. Cloudflare bloque les requêtes directes');
    console.log('   2. Cookies/session requis');
    console.log('   3. URL ou paramètres incorrects');
    console.log('   4. Rate limiting');
  }
  
  // Tester avec différentes langues
  console.log('\n🔤 TEST AVEC DIFFÉRENTES LANGUES:');
  const languages = ['es', 'fr', 'en', 'pt'];
  
  for (const lang of languages) {
    const test = {
      ...API_TESTS[0], // getservices
      params: {
        ...API_TESTS[0].params,
        lang
      }
    };
    
    console.log(`\n   Test getservices avec lang=${lang}...`);
    const result = await testApi(test);
    
    if (result.success && result.data && result.data.Services) {
      console.log(`   ✅ ${lang.toUpperCase()}: ${Array.isArray(result.data.Services) ? result.data.Services.length : 'N/A'} services`);
    } else {
      console.log(`   ❌ ${lang.toUpperCase()}: Échec`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

// Gestion des erreurs
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Tests interrompus par l\'utilisateur');
  process.exit(0);
});

// Lancer les tests
runAllTests().catch(err => {
  console.error('❌ Erreur fatale:', err);
  process.exit(1);
});