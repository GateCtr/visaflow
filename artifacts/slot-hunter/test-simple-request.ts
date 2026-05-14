/**
 * Test simple d'une requête avec proxy iProyal
 */

import "dotenv/config";
import { setUsaSessionProxy, usaFetch, authHeaders } from "./src/usaPortal/usa-http.js";
import { makeIproyalStickyUrl } from "./src/usaPortal/usa-http.js";

async function testSimpleRequest() {
  console.log("Test simple avec proxy iProyal");
  
  // 1. Créer URL proxy sticky
  const stickyProxyUrl = makeIproyalStickyUrl(process.env.IPROYAL_PROXY_URL!, 30);
  console.log(`Proxy: ${stickyProxyUrl.replace(/:([^:@]+)@/, ":***@")}`);
  
  // 2. Configurer le proxy
  setUsaSessionProxy(stickyProxyUrl);
  
  // 3. Tester une requête simple (sans auth)
  const testUrl = "https://ipv4.icanhazip.com";
  console.log(`\nTest 1: Requête simple vers ${testUrl}`);
  
  try {
    const res = await fetch(testUrl);
    const ip = await res.text();
    console.log(`✅ Succès! IP: ${ip.trim()}`);
  } catch (error: any) {
    console.log(`❌ Erreur fetch natif: ${error.message}`);
  }
  
  // 4. Tester avec usaFetch (sans proxy)
  setUsaSessionProxy(undefined);
  console.log(`\nTest 2: usaFetch sans proxy`);
  
  try {
    const res = await usaFetch(testUrl);
    const ip = await res.text();
    console.log(`✅ usaFetch sans proxy: IP ${ip.trim()}`);
  } catch (error: any) {
    console.log(`❌ usaFetch sans proxy: ${error.message}`);
  }
  
  // 5. Tester avec usaFetch avec proxy
  setUsaSessionProxy(stickyProxyUrl);
  console.log(`\nTest 3: usaFetch avec proxy`);
  
  try {
    const res = await usaFetch(testUrl);
    const ip = await res.text();
    console.log(`✅ usaFetch avec proxy: IP ${ip.trim()}`);
  } catch (error: any) {
    console.log(`❌ usaFetch avec proxy: ${error.message}`);
  }
  
  // 6. Tester avec headers (simuler une requête auth)
  console.log(`\nTest 4: usaFetch avec headers (simulation auth)`);
  
  try {
    const fakeToken = "fake.token.here";
    const headers = authHeaders(fakeToken, "https://www.usvisaappt.com/visaapplicantui/login", false);
    
    // Enlever le token pour éviter les problèmes
    delete headers.Authorization;
    
    const res = await usaFetch(testUrl, { headers });
    const ip = await res.text();
    console.log(`✅ usaFetch avec headers: IP ${ip.trim()}, status: ${res.status}`);
  } catch (error: any) {
    console.log(`❌ usaFetch avec headers: ${error.message}`);
  }
  
  setUsaSessionProxy(undefined);
}

testSimpleRequest().catch(console.error);