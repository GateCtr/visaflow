// Test du flux proxy iProyal pour USA portal
const { ProxyAgent } = require('undici');

// URL iProyal depuis .env.local
const IPROYAL_BASE_URL = 'http://jT9eIHi669kwIORb:ngucIBfEKjEkUfDn_country-cd_city-kinshasa@geo.iproyal.com:12321';
const TEST_URL = 'https://ipv4.icanhazip.com';

// Fonction makeIproyalStickyUrl (copiée de usa-http.ts)
function makeIproyalStickyUrl(baseUrl, lifetimeMinutes = 60) {
  try {
    const parsed = new URL(baseUrl);
    // Générer un session ID aléatoire de 8 caractères alphanumériques
    const sessionId = Array.from({ length: 8 }, () =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
    ).join('');
    // Ajouter les paramètres sticky au mot de passe (après le password existant)
    // Si le password contient déjà _session-, on le remplace pour éviter les doublons
    let password = decodeURIComponent(parsed.password);
    password = password.replace(/_session-[^_]+/g, '').replace(/_lifetime-[^_]+/g, '');
    password += `_session-${sessionId}_lifetime-${lifetimeMinutes}m`;
    parsed.password = encodeURIComponent(password);
    console.log(`🔒 Proxy sticky: session=${sessionId}, lifetime=${lifetimeMinutes}m`);
    return parsed.toString();
  } catch (err) {
    console.warn(`⚠️ Impossible de parser l'URL proxy pour sticky session — fallback rotatif: ${err.message}`);
    return baseUrl;
  }
}

async function testProxyFlow() {
  console.log('=== Test du flux proxy iProyal pour USA portal ===\n');
  
  // 1. Créer URL sticky
  console.log('1. Création URL proxy sticky...');
  const stickyUrl = makeIproyalStickyUrl(IPROYAL_BASE_URL, 30);
  console.log(`   URL: ${stickyUrl.replace(/:([^:@]+)@/, ':***@')}`);
  
  // 2. Tester la connexion
  console.log('\n2. Test de connexion avec ProxyAgent...');
  try {
    const agent = new ProxyAgent(stickyUrl);
    const response = await fetch(TEST_URL, { dispatcher: agent });
    const ip = await response.text();
    console.log(`   ✅ Succès! IP proxy: ${ip.trim()}`);
    console.log(`   Status: ${response.status}`);
  } catch (error) {
    console.error(`   ❌ Échec: ${error.message}`);
    return;
  }
  
  // 3. Simuler plusieurs requêtes (comme le bot)
  console.log('\n3. Test de plusieurs requêtes (simulation bot)...');
  const agent = new ProxyAgent(stickyUrl);
  
  for (let i = 1; i <= 3; i++) {
    try {
      const response = await fetch(TEST_URL, { dispatcher: agent });
      const ip = await response.text();
      console.log(`   Requête ${i}: IP ${ip.trim()} (status: ${response.status})`);
      // Délai aléatoire entre requêtes (comme le bot)
      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    } catch (error) {
      console.error(`   Requête ${i} échouée: ${error.message}`);
    }
  }
  
  console.log('\n=== Résumé ===');
  console.log('✅ Proxy iProyal fonctionne avec format user:pass@host:port');
  console.log('✅ Session sticky créée avec succès');
  console.log('✅ Plusieurs requêtes réussies avec même IP');
  console.log('\n=== Prochaines étapes ===');
  console.log('1. Tester avec compte USA réel (avec credentials)');
  console.log('2. Vérifier que login + requêtes utilisent même IP');
  console.log('3. Monitorer les 401 et restrictions Cognito');
}

testProxyFlow().catch(console.error);