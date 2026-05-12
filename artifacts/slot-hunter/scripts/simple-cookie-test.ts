/**
 * Simple test to check if cf_clearance cookie works
 */

import * as https from 'https';
import * as zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);

async function testCookie() {
  console.log('🔍 Testing cf_clearance cookie...\n');
  
  const freshCookie = 'lbQzY8u381IR9AUQZSORMyJaWR6oJalRztP5qmJ0A4E-1778520388-1.2.1.1-evlOsDvDCSdezjq56ufscaKqX4axDSzqgjkrYCdMy9psMgCetd2b0Oc2ezjFuE7aDH.eaZQg6rMrNFfMqcgx7GdhCc3Gk9aPC.65gkUsqJ9e3Mc83R9T1uCLuJejCdaGarqED8DW9VSN_SMQrZsdzKIDTTYnl7Bjbg.f5FoCQ2E.xahmLEpZo86VZEGyV6IzNWbjDUNwudeM4YZStHcJM2atyQv5S4gabCy7GjW2wNwPNdQrXHTZNxfymtvRoH5tsohdhAIVYQnKjTcMB_vJIHK8oDogfTVA_69Xlzn888uTfHVsaWczoJjLwvPUDyzbFsdwQPbba9D9zHM4KbKHxg';
  
  const url = 'https://www.citaconsular.es/onlinebookings/getservices/?callback=test123&type=default&publickey=25028fcd7126544630b8da0c6e60722b5&lang=es&version=4&src=https%3A%2F%2Fwww.citaconsular.es%2Fes%2Fhosteds%2Fwidgetdefault%2F25028fcd7126544630b8da0c6e60722b5%2F&srvsrc=https%3A%2F%2Fwww.citaconsular.es&_=' + Date.now();
  
  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      'Accept': 'text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01',
      'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/',
      'X-Requested-With': 'XMLHttpRequest',
      'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Cookie': `cf_clearance=${freshCookie}`
    },
    timeout: 10000
  };
  
  return new Promise((resolve, reject) => {
    console.log(`📡 Request URL: ${url.substring(0, 100)}...`);
    console.log(`🍪 Cookie: ${freshCookie.substring(0, 50)}...\n`);
    
    const req = https.get(url, options, async (res) => {
      const chunks: Buffer[] = [];
      
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      
      res.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          
          let responseBody: string;
          if (encoding === 'gzip') {
            const decompressed = await gunzip(buffer);
            responseBody = decompressed.toString('utf-8');
          } else {
            responseBody = buffer.toString('utf-8');
          }
          
          console.log(`📊 Response Status: ${res.statusCode}`);
          console.log(`📦 Content-Type: ${res.headers['content-type']}`);
          console.log(`📏 Content-Length: ${responseBody.length} chars\n`);
          
          if (res.statusCode === 200) {
            // Check if it's JSONP response
            if (responseBody.includes('Services') || responseBody.includes('callback(')) {
              console.log('✅ SUCCESS: Valid API response received');
              console.log(`📄 Response preview: ${responseBody.substring(0, 200)}...`);
              
              // Try to parse JSONP
              const jsonpMatch = responseBody.match(/^[a-zA-Z0-9_]+\((.+)\);?$/);
              if (jsonpMatch && jsonpMatch[1]) {
                try {
                  const json = JSON.parse(jsonpMatch[1]);
                  console.log(`\n🎯 Parsed JSON successfully`);
                  console.log(`   Services count: ${json.Services?.length || 0}`);
                  if (json.Services && json.Services.length > 0) {
                    json.Services.forEach((service: any, index: number) => {
                      const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
                      console.log(`   ${index + 1}. ${service.id}: ${name}`);
                    });
                  }
                } catch (err) {
                  console.log(`⚠️ Could not parse JSON: ${err.message}`);
                }
              }
            } else if (responseBody.includes('<!DOCTYPE') || responseBody.includes('<html')) {
              console.log('❌ FAILURE: Received HTML page (Cloudflare blocking)');
              console.log(`📄 Response preview: ${responseBody.substring(0, 200)}...`);
            } else {
              console.log('⚠️ UNKNOWN: Response format not recognized');
              console.log(`📄 Response preview: ${responseBody.substring(0, 200)}...`);
            }
          } else {
            console.log(`❌ FAILURE: HTTP ${res.statusCode}`);
            console.log(`📄 Response: ${responseBody.substring(0, 200)}...`);
          }
          
          resolve({ statusCode: res.statusCode, body: responseBody });
        } catch (err) {
          console.error('❌ Error processing response:', err.message);
          reject(err);
        }
      });
    });
    
    req.on('error', (err) => {
      console.error('❌ Request error:', err.message);
      reject(err);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      console.error('❌ Request timeout');
      reject(new Error('Request timeout'));
    });
  });
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🍪 SIMPLE COOKIE TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  try {
    await testCookie();
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('🏁 TEST COMPLETED');
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(console.error);