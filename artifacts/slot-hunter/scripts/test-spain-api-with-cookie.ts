/**
 * test-spain-api-with-cookie.ts — Tester l'API Bookitit España avec le cookie cf_clearance capturé
 * 
 * Utilise le cookie Cloudflare de la capture pour accéder à l'API
 * 
 * Usage:
 *   npx tsx scripts/test-spain-api-with-cookie.ts
 */

import * as https from 'https';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

// Cookie cf_clearance extrait de la capture
const CF_CLEARANCE = 'gYEZ5xvvDIvzOhjATLh27Df_bX2ML_COKfuIjHTiUtE-1778517847-1.2.1.1-Ns484nN_guIur8BCq3ALLyeme52zKaKeYlJopMmE.vjffpcfPFHRNnu_SNmjQWsqcg2jo6FrVP2x3nc4tMSnWOPlwsq4XdxJ4fVqBqy5KZ5xsfzE.wbk_jIpgnV4vmeMmfWjCcCotX9988TgnuZBWAZ1Zvob510EIIWGLhWrIuyhAXJM7_W2uiKot6Vv8Jb1rwrj8OqiiFF9O28yTIifvStGf3Af5uatj_gYyKuG8F.aL9PYXQICYz1W..fJ0hYs5sA3ucHBVQSSrZapHU0LbXZvHpcb2c_nt8GjX6iZhhus76.LqOHIp3ZCRT9pL7WOaqRMPu8pjs0O2s8FrEAPQA';

// Configuration basée sur la capture
const CONFIG = {
  baseUrl: 'https://www.citaconsular.es/onlinebookings',
  publickey: '25028fcd7126544630b8da0c6e60722b5',
  widgetId: '25028fcd7126544630b8da0c6e60722b5',
  lang: 'es',
  type: 'default',
  version: '4',
  cookie: `cf_clearance=${CF_CLEARANCE}`
};

interface ApiTest {
  name: string;
  endpoint: string;
  method: 'GET' | 'POST';
  params: Record<string, string>;
  description: string;
  requiresAuth?: boolean;
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
  },
  // Endpoints potentiels à tester (basés sur l'analyse)
  {
    name: 'getagendas',
    endpoint: 'getagendas',
    method: 'GET',
    params: {
      type: CONFIG.type,
      publickey: CONFIG.publickey,
      lang: CONFIG.lang,
      version: CONFIG.version
    },
    description: 'Liste des agendas (consulats) - À confirmer'
  },
  {
    name: 'datetime',
    endpoint: 'datetime',
    method: 'GET',
    params: {
      type: CONFIG.type,
      publickey: CONFIG.publickey,
      lang: CONFIG.lang,
      version: CONFIG.version,
      date: '2025-01-15' // Date d'exemple
    },
    description: 'Créneaux disponibles - À confirmer'
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
      // Si ce n'est pas du JSON valide, ça pourrait être du HTML ou autre
      return { raw: body.substring(0, 500), isJsonp: true, jsonParseError: err.message };
    }
  }
  
  // Essayer de parser comme JSON normal
  try {
    return JSON.parse(body);
  } catch (err) {
    return { raw: body.substring(0, 500), isJson: false, parseError: err.message };
  }
}

function getHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cookie': CONFIG.cookie,
    'Referer': `https://www.citaconsular.es/es/hosteds/widgetdefault/${CONFIG.widgetId}/`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  };
}

async function testApi(test: ApiTest): Promise<{
  success: boolean;
  status?: number;
  data?: any;
  error?: string;
  url: string;
  responseTime?: number;
}> {
  return new Promise((resolve) => {
    const url = buildUrl(test.endpoint, test.params);
    const startTime = Date.now();
    
    console.log(`\n🔍 Test: ${test.name}`);
    console.log(`   📝 ${test.description}`);
    console.log(`   🌐 URL: ${url.substring(0, 100)}...`);
    
    const options = {
      headers: getHeaders(),
      timeout: 15000
    };
    
    const req = https.get(url, options, (res) => {
      let body = '';
      
      res.on('data', (chunk) => {
        body += chunk;
      });
      
      res.on('end', () => {
        const responseTime = Date.now() - startTime;
        
        console.log(`   ⏱️  Temps: ${responseTime}ms`);
        console.log(`   📊 Status: ${res.statusCode} ${res.statusMessage}`);
        console.log(`   📦 Content-Type: ${res.headers['content-type']}`);
        console.log(`   📏 Taille: ${body.length} bytes`);
        
        if (res.statusCode === 200) {
          console.log(`   ✅ Succès!`);
          
          const parsed = parseJsonpResponse(body);
          
          // Afficher un aperçu intelligent selon le type de réponse
          if (parsed.Services) {
            console.log(`   📋 Services trouvés: ${Array.isArray(parsed.Services) ? parsed.Services.length : 'N/A'}`);
            if (Array.isArray(parsed.Services) && parsed.Services.length > 0) {
              const service = parsed.Services[0];
              console.log(`      Premier service:`);
              console.log(`        ID: ${service.id}`);
              console.log(`        Nom: ${service.name}`);
              console.log(`        Prix: ${service.price}`);
              console.log(`        Prépay: ${service.prepay}`);
            }
          } else if (parsed.WidgetConfiguration) {
            console.log(`   ⚙️  Configuration du widget:`);
            Object.entries(parsed.WidgetConfiguration).forEach(([key, value]) => {
              if (typeof value === 'string' && value.length < 50) {
                console.log(`      ${key}: ${value}`);
              }
            });
          } else if (parsed.Agendas) {
            console.log(`   🏛️  Agendas trouvés: ${Array.isArray(parsed.Agendas) ? parsed.Agendas.length : 'N/A'}`);
          } else if (parsed.Slots) {
            console.log(`   🕒 Créneaux trouvés: ${Array.isArray(parsed.Slots) ? parsed.Slots.length : 'N/A'}`);
          } else if (parsed.raw) {
            console.log(`   📄 Aperçu: ${parsed.raw.substring(0, 150)}...`);
          } else {
            console.log(`   📊 Structure:`, Object.keys(parsed));
          }
          
          resolve({
            success: true,
            status: res.statusCode,
            data: parsed,
            url,
            responseTime
          });
        } else if (res.statusCode === 403) {
          console.log(`   ❌ Accès refusé (403)`);
          console.log(`   💡 Le cookie cf_clearance a probablement expiré`);
          console.log(`   💡 Réponse: ${body.substring(0, 200)}...`);
          
          resolve({
            success: false,
            status: res.statusCode,
            error: 'Cloudflare blocked - Cookie may be expired',
            url,
            responseTime
          });
        } else {
          console.log(`   ⚠️  Status inattendu: ${res.statusCode}`);
          console.log(`   📄 Réponse: ${body.substring(0, 200)}...`);
          
          resolve({
            success: false,
            status: res.statusCode,
            error: `HTTP ${res.statusCode}`,
            url,
            responseTime
          });
        }
      });
    });
    
    req.on('error', (err) => {
      const responseTime = Date.now() - startTime;
      console.log(`   ❌ Erreur réseau: ${err.message}`);
      resolve({
        success: false,
        error: err.message,
        url,
        responseTime
      });
    });
    
    req.setTimeout(15000, () => {
      console.log(`   ⏱️  Timeout après 15s`);
      req.destroy();
      resolve({
        success: false,
        error: 'Timeout',
        url,
        responseTime: Date.now() - startTime
      });
    });
  });
}

async function testWithDifferentLanguages() {
  console.log('\n🔤 TEST AVEC DIFFÉRENTES LANGUES:');
  const languages = [
    { code: 'es', name: 'Espagnol' },
    { code: 'fr', name: 'Français' },
    { code: 'en', name: 'Anglais' },
    { code: 'pt', name: 'Portugais' }
  ];
  
  for (const lang of languages) {
    const test = {
      ...API_TESTS[0], // getservices
      params: {
        ...API_TESTS[0].params,
        lang: lang.code
      }
    };
    
    console.log(`\n   🌍 ${lang.name} (${lang.code})...`);
    const result = await testApi(test);
    
    if (result.success && result.data && result.data.Services) {
      const services = result.data.Services;
      console.log(`   ✅ ${Array.isArray(services) ? services.length : 'N/A'} services`);
      
      if (Array.isArray(services) && services.length > 0) {
        // Afficher les noms des services (en évitant le HTML caché)
        services.slice(0, 3).forEach((service: any, index: number) => {
          let name = service.name || 'Sans nom';
          // Nettoyer le HTML caché
          name = name.replace(/<[^>]*>/g, '').trim();
          if (name && name.length > 0) {
            console.log(`      ${index + 1}. ${name.substring(0, 50)}...`);
          }
        });
      }
    } else {
      console.log(`   ❌ Échec: ${result.error || 'Unknown error'}`);
    }
    
    // Pause entre les requêtes
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function exploreOtherEndpoints() {
  console.log('\n🔍 EXPLORATION D\'AUTRES ENDPOINTS POTENTIELS:');
  
  // Endpoints basés sur l'analyse du bundle
  const potentialEndpoints = [
    'getagendas',
    'datetime', 
    'signin',
    'signup',
    'summary',
    'confirmclient',
    'signupfirstappointment',
    'signupsecondappointment',
    'recoverpassword',
    'changepassword',
    'geteventhistory',
    'deleteeventhistory',
    'waitinglist',
    'creditcardcapture',
    'paypalcreatepayment',
    'paypalexecutepayment',
    'niubizcreatepayment',
    'niubizexecutedpayment',
    'freetempevent'
  ];
  
  // Tester quelques endpoints prometteurs
  const endpointsToTest = ['getagendas', 'datetime', 'signin', 'summary'];
  
  for (const endpoint of endpointsToTest) {
    const test = {
      name: endpoint,
      endpoint,
      method: 'GET' as const,
      params: {
        type: CONFIG.type,
        publickey: CONFIG.publickey,
        lang: CONFIG.lang,
        version: CONFIG.version
      },
      description: `Endpoint ${endpoint} - Test d'exploration`
    };
    
    console.log(`\n   🧪 Test: ${endpoint}...`);
    const result = await testApi(test);
    
    if (result.success) {
      console.log(`   ✅ Endpoint accessible!`);
      if (result.data && typeof result.data === 'object') {
        console.log(`   📊 Clés: ${Object.keys(result.data).join(', ')}`);
      }
    } else {
      console.log(`   ❌ Non accessible: ${result.error || 'Unknown'}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 800));
  }
}

async function runAllTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🍪 TEST API BOOKITIT ESPAÑA AVEC COOKIE CLOUDFLARE');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`Base URL: ${CONFIG.baseUrl}`);
  console.log(`Public Key: ${CONFIG.publickey}`);
  console.log(`Cookie cf_clearance: ${CF_CLEARANCE.substring(0, 30)}...`);
  console.log(`Longueur cookie: ${CF_CLEARANCE.length} caractères`);
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const results = [];
  
  // Tester les endpoints principaux
  for (const test of API_TESTS.slice(0, 3)) { // Juste les 3 premiers (confirmés)
    const result = await testApi(test);
    results.push(result);
    
    // Pause entre les tests
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  
  // Résumé
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('📊 RÉSUMÉ DES TESTS PRINCIPAUX');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  
  console.log(`✅ Succès: ${successful}/${results.length}`);
  console.log(`❌ Échecs: ${failed}/${results.length}`);
  
  if (successful > 0) {
    console.log('\n🎯 API ACCESSIBLE AVEC LE COOKIE!');
    console.log('   Le cookie cf_clearance fonctionne (pour le moment)');
    
    // Tester avec différentes langues
    await testWithDifferentLanguages();
    
    // Explorer d'autres endpoints
    await exploreOtherEndpoints();
    
    console.log('\n💡 PROCHAINES ÉTAPES:');
    console.log('   1. Le cookie a une durée de vie limitée (probablement 1-2 heures)');
    console.log('   2. Pour un bot, il faudra:');
    console.log('      - Soit régénérer le cookie via un service (Capsolver, etc.)');
    console.log('      - Soit maintenir une session active');
    console.log('   3. Tester l\'authentification complète (signin -> datetime -> summary)');
    console.log('   4. Implémenter le polling des créneaux');
    
  } else {
    console.log('\n⚠️  API INACCESSIBLE AVEC CE COOKIE');
    console.log('   Causes possibles:');
    console.log('   1. Le cookie cf_clearance a expiré');
    console.log('   2. Cloudflare a détecté une anomalie');
    console.log('   3. Le cookie nécessite d\'autres paramètres de session');
    console.log('   4. L\'IP a changé');
    
    console.log('\n💡 SOLUTIONS:');
    console.log('   1. Relancer une capture pour obtenir un nouveau cookie');
    console.log('   2. Utiliser un service de résolution Cloudflare');
    console.log('   3. Implémenter une automatisation complète du navigateur');
  }
  
  // Vérifier la validité du cookie
  console.log('\n🔐 VALIDITÉ DU COOKIE:');
  const cookieParts = CF_CLEARANCE.split('-');
  if (cookieParts.length >= 3) {
    const timestamp = parseInt(cookieParts[1]);
    if (!isNaN(timestamp)) {
      const cookieDate = new Date(timestamp * 1000);
      const now = new Date();
      const ageHours = (now.getTime() - cookieDate.getTime()) / (1000 * 60 * 60);
      
      console.log(`   Timestamp cookie: ${timestamp}`);
      console.log(`   Date cookie: ${cookieDate.toLocaleString()}`);
      console.log(`   Âge: ${ageHours.toFixed(2)} heures`);
      
      if (ageHours > 2) {
        console.log(`   ⚠️  Cookie probablement expiré (> 2 heures)`);
      } else {
        console.log(`   ✅ Cookie relativement récent`);
      }
    }
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