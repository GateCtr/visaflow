/**
 * test-f5-bypass.ts — Test de bypass F5 BIG-IP sans Playwright
 * 
 * Utilise les EXACTS mêmes headers et cookies que le navigateur
 * pour tester si le cookie TS0110ceb4 est réellement requis.
 */

import { Impit } from 'impit';
import * as fs from 'fs';
import * as path from 'path';

const VOWINT_BASE = 'https://visaonweb.diplomatie.be';
const CEV_BASE = 'https://appointment.cloud.diplomatie.be';

// Cookies extraits du fichier de capture
const CAPTURED_COOKIES = {
  TS0110ceb4: '01f258f401f6f06076705f5f14e78e1623589bdaff6b4eceecdb130825e9e62a6a2dfa2be02a5a80daa26d3cbb74c1003055f66040',
  __RequestVerificationToken: 'Ey1i29nI7xwC5IigjVzJF-nMcFltK8bx5sU2R4oINUaALxjiA5HtvahHKVqdnLrqUaUqvbNn-HBPp7yAKcaVsJxrnuV0OKrJ6hHpHyjTLuw1',
  ServerId: 'eb66856f90f0d6ab',
  OSOnline: 'j5bG4qbTPNtc8qxCc_vBYVhXvv_H8U-XQAb2Q_q1SHRLbdxosKczoE26DJeE_oZcKqD9PpqXKywOYiWNIOd0aU6FMPv3_cejxIdo9giZNzPAVR9KpZ8EyGupU_lWQ3ToBvs3eZYyqZwYvhe8jNlmQrkhIL-_3muo9SLF7-O1CNxpcPyDXSlJC3wduMS1bYyTNngLHo9EgNIII6etbZNYSZrvZprm1-NZ2ZAljz2zHwZvpN75Z7ntmgqhjFQqQ4ZceyEzT6OU_gLkLYk2LFppz_stVaSDgcKWaKz0a7c5_Op58bu8fkEVZfxtU3QihoWRUU5PrScNiU2w_-iJh4FbJPKJtEJsBGWYrtCfNvskM4GKmRCQ6I2hjxrLpgwm4NBlrT37MpYziiZR1ZkL2T6gWrC68frZAcNCK7iCrONbAzP2tOORxdGEWtH68qdfkKoRG7pN8Iqhr4srne3yJBU-G4C2CvbMJEZf9MpFEFnJUazDLKfWKDv8gNMVEKhaE3HnHYDfgXQSwnUi2EE4b_uqY1j3xeDwh3mp3fCZeiGDk7FIu164sk4EPneUyv9bkDV3Sz2N-Mskpn2UfxHbORd6m0WjWbOpED0BJfXCx_onp6rDJIVQVFYbC6MXxBAoCmGLXzcW-I4JOI07E7CMCM_VKeuvZG4lXi9yVBV9oXYnuokhXxq4BqVOTWthW6C2UDtLiXk9ND_ecaruRU0OqMybBflhL9xloJcebigqnw5NN14q79s7Sm-3_WLN5W4sN127pftoNULHSh5zw_zsiVxs9G6qQ2w9efm7O7_Kkswplv4',
  _culture: 'en-US',
  ASPNET_SessionId: 'vxjk0oupsqtgrygku0yv1xdl',
  PreferredCulture: 'en-US'
};

// Headers exacts du navigateur (extraits de la capture)
const BROWSER_HEADERS = {
  'sec-ch-ua-platform': '"Windows"',
  'referer': '',
  'accept-language': 'fr-BE',
  'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'x-requested-with': 'XMLHttpRequest',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'accept': '*/*',
  'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
};

async function testWithExactBrowserHeaders() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Test F5 Bypass - Headers exacts navigateur');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const impit = new Impit({ 
    browser: 'chrome',
    ignoreTlsErrors: true,
    http2: true,
  } as any);
  
  // Test 1: Sans cookie TS0110ceb4 (comme le bot actuel)
  console.log('\n🧪 TEST 1: Sans cookie TS0110ceb4');
  try {
    const cookiesWithoutTS = `ASP.NET_SessionId=${CAPTURED_COOKIES.ASPNET_SessionId}; PreferredCulture=${CAPTURED_COOKIES.PreferredCulture}`;
    
    const response1 = await impit.fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': cookiesWithoutTS,
        'Referer': `${CEV_BASE}/Captcha`,
        'Origin': CEV_BASE,
      },
      body: new URLSearchParams({
        captcha: 'TEST_TOKEN_INVALID' // Token invalide pour tester
      }).toString(),
    } as any) as unknown as Response;
    
    console.log(`  Status: ${response1.status}`);
    console.log(`  Headers: ${JSON.stringify(Object.fromEntries(response1.headers.entries()), null, 2)}`);
    
    const text1 = await response1.text();
    console.log(`  Body (preview): ${text1.slice(0, 200)}...`);
    
  } catch (error) {
    console.log(`  ❌ Erreur: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Test 2: Avec cookie TS0110ceb4
  console.log('\n🧪 TEST 2: Avec cookie TS0110ceb4');
  try {
    const cookiesWithTS = `TS0110ceb4=${CAPTURED_COOKIES.TS0110ceb4}; ASP.NET_SessionId=${CAPTURED_COOKIES.ASPNET_SessionId}; PreferredCulture=${CAPTURED_COOKIES.PreferredCulture}`;
    
    const response2 = await impit.fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': cookiesWithTS,
        'Referer': `${CEV_BASE}/Captcha`,
        'Origin': CEV_BASE,
      },
      body: new URLSearchParams({
        captcha: 'TEST_TOKEN_INVALID'
      }).toString(),
    } as any) as unknown as Response;
    
    console.log(`  Status: ${response2.status}`);
    console.log(`  Headers: ${JSON.stringify(Object.fromEntries(response2.headers.entries()), null, 2)}`);
    
    const text2 = await response2.text();
    console.log(`  Body (preview): ${text2.slice(0, 200)}...`);
    
    // Analyser la réponse
    try {
      const data = JSON.parse(text2);
      console.log(`  JSON Response:`, data);
      if (data.validUntil) {
        console.log(`  ✅ validUntil présent: ${data.validUntil}`);
      }
      if (data.redirectUrl) {
        console.log(`  ✅ redirectUrl présent: ${data.redirectUrl}`);
      }
    } catch {
      console.log(`  ❌ Réponse non-JSON`);
    }
    
  } catch (error) {
    console.log(`  ❌ Erreur: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  // Test 3: Avec TOUS les cookies du navigateur
  console.log('\n🧪 TEST 3: Avec tous les cookies navigateur');
  try {
    const allCookies = [
      `TS0110ceb4=${CAPTURED_COOKIES.TS0110ceb4}`,
      `__RequestVerificationToken=${CAPTURED_COOKIES.__RequestVerificationToken}`,
      `ServerId=${CAPTURED_COOKIES.ServerId}`,
      `OSOnline=${CAPTURED_COOKIES.OSOnline}`,
      `_culture=${CAPTURED_COOKIES._culture}`,
      `ASP.NET_SessionId=${CAPTURED_COOKIES.ASPNET_SessionId}`,
      `PreferredCulture=${CAPTURED_COOKIES.PreferredCulture}`
    ].join('; ');
    
    const response3 = await impit.fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Cookie': allCookies,
        'Referer': `${CEV_BASE}/Captcha`,
        'Origin': CEV_BASE,
      },
      body: new URLSearchParams({
        captcha: 'TEST_TOKEN_INVALID'
      }).toString(),
    } as any) as unknown as Response;
    
    console.log(`  Status: ${response3.status}`);
    const text3 = await response3.text();
    console.log(`  Body (preview): ${text3.slice(0, 200)}...`);
    
  } catch (error) {
    console.log(`  ❌ Erreur: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Analyse :');
  console.log('');
  console.log('  Si Test 2 réussit mieux que Test 1 → cookie TS0110ceb4 requis');
  console.log('  Si même statut → problème ailleurs (TLS, headers, timing)');
  console.log('═══════════════════════════════════════════════════════════════');
}

async function testTlsFingerprintVariants() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Test Fingerprint TLS variants');
  console.log('═══════════════════════════════════════════════════════════════');
  
  const fingerprints = [
    'chrome_120',
    'chrome_110', 
    'firefox_120',
    'safari_17',
    'edge_120'
  ];
  
  for (const fingerprint of fingerprints) {
    console.log(`\n🧪 Fingerprint: ${fingerprint}`);
    try {
      const impit = new Impit({ 
        browser: 'chrome',
        ignoreTlsErrors: true,
        http2: true,
        tlsFingerprint: fingerprint,
      } as any);
      
      const cookies = `ASP.NET_SessionId=${CAPTURED_COOKIES.ASPNET_SessionId}; PreferredCulture=${CAPTURED_COOKIES.PreferredCulture}`;
      
      const response = await impit.fetch(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
        method: 'POST',
        headers: {
          ...BROWSER_HEADERS,
          'Cookie': cookies,
          'Referer': `${CEV_BASE}/Captcha`,
          'Origin': CEV_BASE,
        },
        body: new URLSearchParams({
          captcha: 'TEST_TOKEN_INVALID'
        }).toString(),
      } as any) as unknown as Response;
      
      console.log(`  Status: ${response.status}`);
      
    } catch (error) {
      console.log(`  ❌ Erreur: ${error instanceof Error ? error.message.slice(0, 100) : String(error)}`);
    }
  }
}

async function main() {
  console.log('Démarrage des tests F5 bypass...\n');
  
  await testWithExactBrowserHeaders();
  await testTlsFingerprintVariants();
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Recommandations :');
  console.log('');
  console.log('  1. Si cookie TS0110ceb4 requis :');
  console.log('     - Extraire via script Playwright une fois');
  console.log('     - L\'injecter dans cevHttpSetup.ts');
  console.log('     - Régénérer toutes les 30-60 min');
  console.log('');
  console.log('  2. Si problème TLS :');
  console.log('     - Améliorer fingerprint TLS dans impit');
  console.log('     - Forcer HTTP/2');
  console.log('     - Réutiliser sessions TLS');
  console.log('');
  console.log('  3. Si problème headers :');
  console.log('     - Copier EXACTEMENT les headers navigateur');
  console.log('     - Inclure tous les headers Sec-*');
  console.log('     - Même ordre des headers');
  console.log('');
  console.log('  4. Alternative : Mode hybride');
  console.log('     - Playwright pour login + génération cookie');
  console.log('     - HTTP pur pour polling (avec cookie volé)');
  console.log('═══════════════════════════════════════════════════════════════');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Erreur fatale:', error);
    process.exit(1);
  });
}