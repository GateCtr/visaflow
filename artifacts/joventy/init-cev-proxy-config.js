/**
 * Script d'initialisation de la clé cev_use_proxy dans botConfig
 * À exécuter manuellement pour initialiser la clé avec la valeur par défaut "0"
 */

// Configuration
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || 'https://funny-pangolin-67.convex.site';
const HUNTER_API_KEY = process.env.HUNTER_API_KEY || '';

if (!HUNTER_API_KEY) {
  console.error('Erreur: HUNTER_API_KEY non configurée');
  console.error('Définissez la variable d\'environnement HUNTER_API_KEY');
  process.exit(1);
}

const BOT_CONFIG_KEY = 'cev_use_proxy';
const DEFAULT_VALUE = '0';

async function checkAndInitConfig() {
  try {
    // 1. Vérifier si la clé existe déjà
    const checkUrl = `${CONVEX_SITE_URL}/hunter/bot-config?key=${encodeURIComponent(BOT_CONFIG_KEY)}`;
    console.log(`[1/3] Vérification clé ${BOT_CONFIG_KEY}...`);
    
    const checkRes = await fetch(checkUrl, {
      method: 'GET',
      headers: {
        'X-Hunter-Key': HUNTER_API_KEY,
      },
    });
    
    if (!checkRes.ok) {
      console.error(`Erreur vérification: ${checkRes.status} ${checkRes.statusText}`);
      return;
    }
    
    const checkData = await checkRes.json();
    
    if (checkData.value !== null) {
      console.log(`✓ Clé ${BOT_CONFIG_KEY} existe déjà avec valeur: ${checkData.value}`);
      console.log('Aucune action nécessaire.');
      return;
    }
    
    console.log(`[2/3] Clé ${BOT_CONFIG_KEY} n\'existe pas, création avec valeur: ${DEFAULT_VALUE}...`);
    
    // 2. Créer la clé avec la valeur par défaut
    const createUrl = `${CONVEX_SITE_URL}/hunter/bot-config`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'X-Hunter-Key': HUNTER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: BOT_CONFIG_KEY,
        value: DEFAULT_VALUE,
      }),
    });
    
    if (!createRes.ok) {
      console.error(`Erreur création: ${createRes.status} ${await createRes.text()}`);
      return;
    }
    
    console.log('[3/3] Vérification de la création...');
    
    // 3. Vérifier que la clé a été créée
    const verifyRes = await fetch(checkUrl, {
      method: 'GET',
      headers: {
        'X-Hunter-Key': HUNTER_API_KEY,
      },
    });
    
    if (!verifyRes.ok) {
      console.error(`Erreur vérification: ${verifyRes.status}`);
      return;
    }
    
    const verifyData = await verifyRes.json();
    
    if (verifyData.value === DEFAULT_VALUE) {
      console.log(`✅ SUCCÈS: Clé ${BOT_CONFIG_KEY} initialisée avec valeur: ${DEFAULT_VALUE}`);
      console.log('\nNote: Le proxy CEV est maintenant désactivé par défaut (cev_use_proxy=0).');
      console.log('Pour activer le proxy, utilisez l\'interface admin: /admin/bot-settings');
    } else {
      console.log(`⚠️ ATTENTION: Valeur inattendue: ${verifyData.value} (attendue: ${DEFAULT_VALUE})`);
    }
    
  } catch (error) {
    console.error('Erreur lors de l\'initialisation:', error);
  }
}

// Exécution
checkAndInitConfig();