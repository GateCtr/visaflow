/**
 * simple-cev-test.ts — Test simple de la théorie de limitation CEV
 * 
 * Ce script teste si on peut faire plus de 5 clics en changeant de session et d'IP.
 * 
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx scripts/simple-cev-test.ts
 */

console.log('═══════════════════════════════════════════════════════════════');
console.log('  TEST SIMPLE THÉORIE LIMITATION CEV');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('Ce script va tester la théorie suivante :');
console.log('  - Limite de 5 clics/heure sur VOWINT');
console.log('  - Basée sur session cookie + adresse IP');
console.log('  - Changement des deux = contournement possible');
console.log('');

// Vérifier les variables d'environnement
const requiredEnvVars = [
  'VOWINT_TEST_PASSWORD',
  'ANTICAPTCHA_API_KEY',
  'IPROYAL_PROXY_URL',
  'BRIGHTDATA_PROXY_URL'
];

console.log('Vérification des variables d\'environnement :');
for (const envVar of requiredEnvVars) {
  if (process.env[envVar]) {
    console.log(`  ✅ ${envVar}: ${process.env[envVar].slice(0, 10)}...`);
  } else {
    console.log(`  ❌ ${envVar}: NON DÉFINIE`);
  }
}
console.log('');

// Demander confirmation avant de continuer
console.log('⚠️  ATTENTION : Ce test va consommer des crédits captcha ($0.003 par clic)');
console.log('   et utiliser vos comptes proxy.');
console.log('');
console.log('Voulez-vous continuer ? (oui/non)');

// Pour un test interactif, on pourrait utiliser readline
// Mais pour simplifier, on va juste exécuter un test limité
console.log('\nPour exécuter le test complet, modifiez le script pour :');
console.log('1. Importer setupCevSessionHttp depuis ../src/cevHttpSetup.js');
console.log('2. Implémenter la logique de rotation session/IP');
console.log('3. Exécuter avec npx tsx scripts/simple-cev-test.ts');
console.log('');
console.log('Exemple de code à ajouter :');
console.log(`
import { setupCevSessionHttp, invalidateVowintCache } from '../src/cevHttpSetup.js';

async function testWithProxy(proxyUrl: string, resetSession: boolean) {
  // Sauvegarder les proxies actuels
  const oldHttpProxy = process.env.HTTP_PROXY;
  const oldHttpsProxy = process.env.HTTPS_PROXY;
  
  // Définir le nouveau proxy
  process.env.HTTP_PROXY = proxyUrl;
  process.env.HTTPS_PROXY = proxyUrl;
  
  try {
    if (resetSession) {
      invalidateVowintCache('screentapinc@gmail.com');
    }
    
    const result = await setupCevSessionHttp(
      'screentapinc@gmail.com',
      process.env.VOWINT_TEST_PASSWORD || '',
      'test-client-id',
      'test-client-id'
    );
    
    return result;
  } finally {
    // Restaurer les proxies
    if (oldHttpProxy) {
      process.env.HTTP_PROXY = oldHttpProxy;
    } else {
      delete process.env.HTTP_PROXY;
    }
    
    if (oldHttpsProxy) {
      process.env.HTTPS_PROXY = oldHttpsProxy;
    } else {
      delete process.env.HTTPS_PROXY;
    }
  }
}
`);

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  STRATÉGIE DE TEST RECOMMANDÉE');
console.log('═══════════════════════════════════════════════════════════════');
console.log('');
console.log('1. Phase 1 (3 clics avec IP iProyal CD) :');
console.log('   - Proxy: iProyal Congo (Kinshasa)');
console.log('   - Même session (pas de reset)');
console.log('   - Attendre 2s entre chaque clic');
console.log('');
console.log('2. Phase 2 (4 clics avec IP BrightData FR) :');
console.log('   - Proxy: BrightData France (IP fixe)');
console.log('   - Nouvelle session (reset)');
console.log('   - Attendre 2s entre chaque clic');
console.log('');
console.log('3. Analyse :');
console.log('   - Si Phase 1 échoue après 3 clics → limite stricte');
console.log('   - Si Phase 2 réussit 4 clics → théorie confirmée');
console.log('   - Si Phase 2 échoue aussi → autre facteur (compte, etc.)');
console.log('');

console.log('📝 Note : Le vrai test nécessite un compte VOWINT actif avec');
console.log('   un dossier en attente de rendez-vous.');
console.log('   Sans dossier actif, GetEAppointmentUrl retournera une erreur.');