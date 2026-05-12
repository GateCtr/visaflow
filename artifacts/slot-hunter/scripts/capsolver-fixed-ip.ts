/**
 * Test Capsolver avec IP fixe directe
 */

import * as dotenv from "dotenv";
dotenv.config();

async function testCapsolverWithFixedIp() {
  console.log('🔍 Test Capsolver avec IP fixe directe\n');
  
  const capsolverKey = process.env.CAPSOLVER_API_KEY;
  const brightdataUrl = process.env.BRIGHTDATA_PROXY_URL;
  
  if (!capsolverKey || !brightdataUrl) {
    console.error('❌ Configuration manquante');
    return;
  }
  
  // Analyser l'URL BrightData
  // Format: http://brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6@brd.superproxy.io:33335
  const match = brightdataUrl.match(/@([^:]+):(\d+)/);
  
  if (!match) {
    console.error('❌ Format URL BrightData invalide');
    return;
  }
  
  const [, host, port] = match;
  console.log(`🌐 Proxy BrightData:`);
  console.log(`   Host: ${host}`);
  console.log(`   Port: ${port}`);
  console.log(`   URL complète: ${brightdataUrl.split('@')[0]}...@...`);
  
  // Extraire l'IP de l'URL (si présente)
  const ipMatch = brightdataUrl.match(/ip-(\d+\.\d+\.\d+\.\d+)/);
  const ip = ipMatch ? ipMatch[1] : null;
  
  console.log(`\n🔍 IP dans l'URL: ${ip || 'Non trouvée'}`);
  
  // Formats Capsolver à tester
  const formats = [
    // Format original (avec hostname)
    `${host}:${port}:brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6`,
    
    // Avec IP directe (si disponible)
    ip ? `${ip}:${port}:brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6` : null,
    
    // Format simplifié
    `${host}:${port}:brd-customer-hl_f0e9b823:85jymkmfp0e6`,
  ].filter(Boolean);
  
  console.log('\n🧪 Formats Capsolver à tester:');
  formats.forEach((format, i) => {
    console.log(`   ${i + 1}. ${format?.substring(0, 60)}...`);
  });
  
  // Tester la résolution DNS
  console.log('\n🔍 Résolution DNS:');
  try {
    const dns = await import('dns');
    const dnsPromises = dns.promises;
    
    const addresses = await dnsPromises.resolve4(host);
    console.log(`   ${host} résout vers: ${addresses.join(', ')}`);
    
    if (ip && addresses.includes(ip)) {
      console.log(`   ✅ L'IP ${ip} est dans les résultats DNS`);
    } else if (ip) {
      console.log(`   ⚠️  L'IP ${ip} n'est pas dans les résultats DNS`);
      console.log(`   Cela peut expliquer l'erreur Capsolver`);
    }
  } catch (dnsError) {
    console.log(`   ❌ Erreur DNS: ${dnsError.message}`);
  }
  
  // Tester la connectivité du proxy
  console.log('\n🔌 Test de connectivité proxy:');
  try {
    const https = await import('https');
    
    const proxyTest = new Promise((resolve, reject) => {
      const req = https.get('https://api.ipify.org?format=json', {
        timeout: 10000,
        agent: new https.Agent({
          proxy: brightdataUrl
        })
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
      });
      
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
    
    const result = await proxyTest;
    console.log(`   ✅ Proxy fonctionnel: ${JSON.stringify(result)}`);
  } catch (proxyError) {
    console.log(`   ❌ Proxy non fonctionnel: ${proxyError.message}`);
  }
  
  console.log('\n💡 Recommandations:');
  console.log('   1. Capsolver rejette les DNS dynamiques');
  console.log('   2. Essayez d\'utiliser directement l\'IP dans le format');
  console.log('   3. Contactez BrightData pour un hostname statique');
  console.log('   4. Essayez un autre fournisseur de proxy avec IP fixe');
  
  // Si nous avons une IP, créer le format corrigé
  if (ip) {
    console.log(`\n🎯 Format Capsolver corrigé (avec IP):`);
    const correctedFormat = `${ip}:${port}:brd-customer-hl_f0e9b823-zone-datacenter_proxy1-country-fr-ip-212.81.41.27:85jymkmfp0e6`;
    console.log(`   ${correctedFormat}`);
    
    // Sauvegarder dans .env temporairement
    console.log('\n💾 Pour tester, ajoutez à .env:');
    console.log(`   CAPSOLVER_FIXED_IP_FORMAT="${correctedFormat}"`);
  }
}

// Exécuter
testCapsolverWithFixedIp().catch(console.error);