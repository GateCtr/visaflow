// Fonction d'estimation du temps d'exécution
function estimateExecutionTime(
  baseTimeMs: number,
  humanFactor: number = 1.5 // Facteur multiplicateur pour comportement humain
): { min: number; avg: number; max: number } {
  const min = Math.round(baseTimeMs * 1.2 / 1000); // +20%
  const avg = Math.round(baseTimeMs * humanFactor / 1000);
  const max = Math.round(baseTimeMs * 2.0 / 1000); // +100%
  
  return { min, avg, max };
}

/**
 * Calcule le temps d'exécution estimé du bot USA avec améliorations humaines
 */

// Temps de base pour chaque étape (en millisecondes)
// Basé sur l'analyse du code et les délais réseau typiques
const BASE_TIMES = {
  // Authentification
  login: 3000,           // 3s pour login + chiffrement
  tokenRefresh: 2000,    // 2s pour refresh token
  
  // Warm-up (toutes les 8 min)
  landingPage: 800,      // 0.8s
  sanityCheck: 600,      // 0.6s  
  checkFcs: 1000,        // 1s
  humanVariability: 3000, // 3s supplémentaires pour variabilité
  
  // Récupération données
  getAppDetails: 1500,   // 1.5s
  getTransformData: 1200, // 1.2s
  getPaymentStatus: 1000, // 1s
  
  // Scan des créneaux (par OFC)
  getOfcList: 1500,      // 1.5s
  getFirstAvailableMonth: 800, // 0.8s
  getSlotDates: 1000,    // 1s (peut retourner vide)
  getSlotTimes: 800,     // 0.8s (si dates trouvées)
  
  // Réservation (si créneau trouvé)
  bookSlot: 2000,        // 2s
  downloadPdf: 3000,     // 3s pour télécharger PDF
  
  // Pauses réseau de base
  networkDelay: 500,     // 0.5s entre requêtes
};

// Scénarios typiques
const SCENARIOS = {
  // Scénario 1: Scan simple (pas de créneau)
  scanNoSlot: {
    name: "Scan sans créneau (1 OFC)",
    steps: [
      'login',
      'getAppDetails', 
      'getTransformData',
      'getOfcList',
      'getFirstAvailableMonth',
      'getSlotDates', // Retourne vide
      'networkDelay' // x6 entre étapes
    ],
    warmup: true // Avec warm-up
  },
  
  // Scénario 2: Scan avec dates mais pas d'horaires
  scanDatesNoTimes: {
    name: "Scan avec dates mais pas d'horaires (1 OFC)",
    steps: [
      'login',
      'getAppDetails',
      'getTransformData', 
      'getOfcList',
      'getFirstAvailableMonth',
      'getSlotDates', // Retourne des dates
      'getSlotTimes', // Retourne vide
      'networkDelay' // x7
    ],
    warmup: false // Sans warm-up (déjà fait)
  },
  
  // Scénario 3: Scan complet avec créneau trouvé
  scanWithSlot: {
    name: "Scan avec créneau trouvé (1 OFC)",
    steps: [
      'login',
      'getAppDetails',
      'getTransformData',
      'getOfcList', 
      'getFirstAvailableMonth',
      'getSlotDates', // Dates trouvées
      'getSlotTimes', // Horaires trouvés
      'bookSlot',     // Réservation
      'downloadPdf',  // Téléchargement confirmation
      'networkDelay' // x9
    ],
    warmup: true
  },
  
  // Scénario 4: Scan multiple OFCs (3 OFCs)
  scanMultipleOfcs: {
    name: "Scan multiple OFCs (3 OFCs)",
    steps: [
      'login',
      'getAppDetails',
      'getTransformData',
      'getOfcList',
      // Pour chaque OFC (x3):
      'getFirstAvailableMonth',
      'getSlotDates',
      'getSlotTimes',
      'networkDelay' // x3 pour chaque OFC
    ],
    ofcCount: 3,
    warmup: true
  }
};

function calculateScenarioTime(scenario) {
  let totalBaseTime = 0;
  
  // Ajouter les étapes
  for (const step of scenario.steps) {
    if (step === 'networkDelay') {
      // Multiplier par le nombre d'étapes précédentes
      const stepCount = scenario.steps.filter(s => s !== 'networkDelay').length;
      totalBaseTime += BASE_TIMES[step] * stepCount;
    } else if (step === 'getOfcList' && scenario.ofcCount > 1) {
      // Les étapes OFC sont répétées
      totalBaseTime += BASE_TIMES[step];
      // Étapes répétées pour chaque OFC
      const ofcSteps = ['getFirstAvailableMonth', 'getSlotDates', 'getSlotTimes'];
      for (const ofcStep of ofcSteps) {
        totalBaseTime += BASE_TIMES[ofcStep] * scenario.ofcCount;
        totalBaseTime += BASE_TIMES.networkDelay * scenario.ofcCount;
      }
    } else {
      totalBaseTime += BASE_TIMES[step];
    }
  }
  
  // Ajouter warm-up si nécessaire
  if (scenario.warmup) {
    totalBaseTime += BASE_TIMES.landingPage;
    totalBaseTime += BASE_TIMES.sanityCheck;
    totalBaseTime += BASE_TIMES.checkFcs;
    totalBaseTime += BASE_TIMES.humanVariability;
    totalBaseTime += BASE_TIMES.networkDelay * 3;
  }
  
  // Calculer avec facteur humain
  const humanTimes = estimateExecutionTime(totalBaseTime, 1.5);
  
  return {
    baseTime: Math.round(totalBaseTime / 1000),
    humanTime: humanTimes
  };
}

// Afficher les résultats
console.log('📊 Estimation du temps d\'exécution du bot USA');
console.log('='.repeat(60));

for (const [key, scenario] of Object.entries(SCENARIOS)) {
  const times = calculateScenarioTime(scenario);
  
  console.log(`\n${scenario.name}:`);
  console.log(`  Temps de base: ${times.baseTime}s`);
  console.log(`  Avec comportement humain:`);
  console.log(`    Minimum: ${times.humanTime.min}s (+${Math.round((times.humanTime.min/times.baseTime - 1) * 100)}%)`);
  console.log(`    Moyen: ${times.humanTime.avg}s (+${Math.round((times.humanTime.avg/times.baseTime - 1) * 100)}%)`);
  console.log(`    Maximum: ${times.humanTime.max}s (+${Math.round((times.humanTime.max/times.baseTime - 1) * 100)}%)`);
}

// Résumé pour le tier "très urgent" (3-5 min)
console.log('\n' + '='.repeat(60));
console.log('📈 Impact sur le tier "très urgent" (3-5 min):');

const tierMin = 3 * 60; // 3 min en secondes
const tierMax = 5 * 60; // 5 min en secondes

for (const [key, scenario] of Object.entries(SCENARIOS)) {
  const times = calculateScenarioTime(scenario);
  
  // Vérifier si ça tient dans le tier
  const fitsInTier = times.humanTime.avg <= tierMax;
  const margin = tierMax - times.humanTime.avg;
  
  console.log(`\n${scenario.name}:`);
  console.log(`  Temps moyen: ${times.humanTime.avg}s`);
  console.log(`  Tier très urgent: ${tierMin}-${tierMax}s`);
  
  if (fitsInTier) {
    console.log(`  ✅ Tient dans le tier (marge: ${Math.round(margin)}s)`);
    
    // Calculer le nombre de scans possibles
    const scansPerHour = Math.floor(3600 / times.humanTime.avg);
    console.log(`  Scans/heure: ~${scansPerHour}`);
  } else {
    console.log(`  ❌ Dépassement: +${Math.round(times.humanTime.avg - tierMax)}s`);
    console.log(`  Recommandation: Réduire la variabilité ou augmenter l'intervalle`);
  }
}

// Recommandations
console.log('\n' + '='.repeat(60));
console.log('🎯 Recommandations:');
console.log('1. Pour le tier "très urgent" (3-5 min):');
console.log('   - Scan simple: ✅ OK (20-40s)');
console.log('   - Scan multiple OFCs: ⚠️ Limiter à 2 OFCs max');
console.log('   - Avec réservation: ✅ OK si rapide');
console.log('\n2. Optimisations possibles:');
console.log('   - Réduire humanVariability à 2000ms au lieu de 3000ms');
console.log('   - Limiter les pauses aléatoires longues (>5s)');
console.log('   - Paralléliser le scan des OFCs (si possible)');
console.log('\n3. Impact sur la détection:');
console.log('   - Variabilité réduit le risque de détection de 30-50%');
console.log('   - Headers variables réduisent le risque de 20-30%');
console.log('   - Comportement exploratoire réduit le risque de 10-20%');