/**
 * debug-spain-response.ts — Debugger les réponses de l'API
 */

import * as https from 'https';
import * as zlib from 'zlib';

const CF_CLEARANCE = 'gYEZ5xvvDIvzOhjATLh27Df_bX2ML_COKfuIjHTiUtE-1778517847-1.2.1.1-Ns484nN_guIur8BCq3ALLyeme52zKaKeYlJopMmE.vjffpcfPFHRNnu_SNmjQWsqcg2jo6FrVP2x3nc4tMSnWOPlwsq4XdxJ4fVqBqy5KZ5xsfzE.wbk_jIpgnV4vmeMmfWjCcCotX9988TgnuZBWAZ1Zvob510EIIWGLhWrIuyhAXJM7_W2uiKot6Vv8Jb1rwrj8OqiiFF9O28yTIifvStGf3Af5uatj_gYyKuG8F.aL9PYXQICYz1W..fJ0hYs5sA3ucHBVQSSrZapHU0LbXZvHpcb2c_nt8GjX6iZhhus76.LqOHIp3ZCRT9pL7WOaqRMPu8pjs0O2s8FrEAPQA';

const CONFIG = {
  baseUrl: 'https://www.citaconsular.es/onlinebookings',
  publickey: '25028fcd7126544630b8da0c6e60722b5',
  cookie: `cf_clearance=${CF_CLEARANCE}`
};

function getHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'fr-FR,fr;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cookie': CONFIG.cookie,
    'Referer': 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/',
    'X-Requested-With': 'XMLHttpRequest'
  };
}

async function debugRequest(endpoint: string): Promise<void> {
  return new Promise((resolve) => {
    const url = `${CONFIG.baseUrl}/${endpoint}?type=default&publickey=${CONFIG.publickey}&lang=es&version=4&callback=test&_=${Date.now()}`;
    
    console.log(`\n🔍 ${endpoint}`);
    console.log(`URL: ${url.substring(0, 120)}...`);
    
    const req = https.get(url, { headers: getHeaders() }, (res) => {
      const chunks: Buffer[] = [];
      
      console.log(`Status: ${res.statusCode}`);
      console.log(`Headers:`);
      Object.entries(res.headers).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
      
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        
        console.log(`\nRaw buffer (first 100 bytes):`);
        console.log(buffer.slice(0, 100).toString('hex'));
        console.log(`\nAs text (first 200 chars):`);
        console.log(buffer.slice(0, 200).toString());
        
        // Essayer différentes décompressions
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, result) => {
            if (!err) {
              console.log(`\n✅ Décompressé gzip (first 500 chars):`);
              const text = result.toString();
              console.log(text.substring(0, 500));
              
              // Analyser le format
              console.log(`\n📊 Analyse du format:`);
              if (text.includes('(') && text.includes(')')) {
                const start = text.indexOf('(');
                const end = text.lastIndexOf(')');
                console.log(`JSONP détecté: position (${start}, ${end})`);
                console.log(`Contenu JSONP: ${text.substring(start, end + 1).substring(0, 300)}...`);
                
                // Essayer d'extraire le JSON
                const jsonStr = text.substring(start + 1, end);
                console.log(`\nTentative de parse JSON...`);
                try {
                  const json = JSON.parse(jsonStr);
                  console.log(`✅ JSON valide!`);
                  console.log(`Structure:`, Object.keys(json));
                  
                  if (json.Services) {
                    console.log(`Services: ${Array.isArray(json.Services) ? json.Services.length : 'N/A'}`);
                  }
                  if (json.WidgetConfiguration) {
                    console.log(`WidgetConfiguration keys:`, Object.keys(json.WidgetConfiguration));
                  }
                } catch (jsonErr) {
                  console.log(`❌ Erreur JSON: ${jsonErr.message}`);
                  console.log(`JSON string (first 300 chars): ${jsonStr.substring(0, 300)}`);
                }
              } else {
                console.log(`Format non reconnu`);
              }
            } else {
              console.log(`❌ Erreur gzip: ${err.message}`);
            }
            resolve();
          });
        } else {
          console.log(`No compression or unknown: ${encoding}`);
          resolve();
        }
      });
    });
    
    req.on('error', (err) => {
      console.log(`❌ Error: ${err.message}`);
      resolve();
    });
    
    req.setTimeout(5000, () => {
      console.log(`⏱️ Timeout`);
      req.destroy();
      resolve();
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🐛 DEBUG API RESPONSE FORMAT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  await debugRequest('getservices');
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  await debugRequest('getwidgetconfigurations');
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('💡 OBSERVATIONS:');
  console.log('1. Vérifier si la réponse est vraiment du JSONP');
  console.log('2. Vérifier les caractères spéciaux au début');
  console.log('3. Vérifier l\'encodage');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);