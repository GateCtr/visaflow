/**
 * fresh-capture-selectslot.ts — Setup frais + capture SelectSlot
 * 
 * 1. Crée une nouvelle session CEV fraîche
 * 2. Capture immédiatement SelectSlot avec redirect: 'manual'
 * 3. Analyse le contenu avant redirection
 * 
 * Usage :
 *   npx tsx scripts/fresh-capture-selectslot.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Importer le setup CEV (version simplifiée)
async function setupFreshCevSession(): Promise<{
  success: boolean;
  sessionCookie?: string;
  integrationUrl?: string;
  error?: string;
}> {
  console.log('🔄 Setup d\'une nouvelle session CEV...');
  
  // Note: Dans une vraie implémentation, on importerait setupCevSessionHttp
  // Pour l'exemple, on utilise les données de capture.json
  
  const capturePath = path.join(__dirname, '..', 'capture.json');
  if (!fs.existsSync(capturePath)) {
    return { success: false, error: 'capture.json non trouvé' };
  }
  
  try {
    const captureData = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    
    // Trouver une URL d'intégration
    const integrationRequest = captureData.requests?.find((req: any) => 
      req.url.includes('/Integration/VOW/') && !req.url.includes('SelectSlot') && !req.url.includes('Error')
    );
    
    if (!integrationRequest) {
      return { success: false, error: 'URL d\'intégration non trouvée' };
    }
    
    // Trouver un cookie frais (le dernier)
    let sessionCookie = '';
    const cookieSnapshots = captureData.cookieSnapshots || [];
    
    // Prendre le dernier snapshot avec un cookie CEV
    for (let i = cookieSnapshots.length - 1; i >= 0; i--) {
      const snapshot = cookieSnapshots[i];
      const cevCookie = snapshot.cookies?.find((c: any) => 
        c.name === 'ASP.NET_SessionId' && c.domain.includes('appointment.cloud')
      );
      if (cevCookie) {
        sessionCookie = cevCookie.value;
        console.log(`🍪 Cookie frais trouvé (timestamp: ${snapshot.timestamp})`);
        break;
      }
    }
    
    if (!sessionCookie) {
      return { success: false, error: 'Cookie ASP.NET_SessionId non trouvé' };
    }
    
    return {
      success: true,
      sessionCookie,
      integrationUrl: integrationRequest.url,
    };
    
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function captureSelectSlotWithManualRedirect(
  url: string,
  sessionCookie: string
): Promise<{
  success: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  redirectLocation: string | null;
  isSelectSlotPage: boolean;
  markersFound: string[];
  error?: string;
}> {
  try {
    console.log(`🔍 Capture de SelectSlot: ${url}`);
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Cookie': `ASP.NET_SessionId=${sessionCookie}; PreferredCulture=en-US`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'manual',
    });

    // Capturer les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const redirectLocation = response.headers.get('location');
    
    // Capturer le body
    let body: string | null = null;
    try {
      body = await response.text();
    } catch {
      // Ignorer les erreurs de lecture de body
    }
    
    // Analyser le body pour des marqueurs
    const markersFound: string[] = [];
    let isSelectSlotPage = false;
    
    if (body) {
      const lowerBody = body.toLowerCase();
      const markers = [
        'getavailabletimeslotsforpublic',
        'home/availabletimeslots',
        'availabletimeslots',
        'data-slot-time',
        'bootstrap-datetimepicker',
        'sharedscripts',
        'selectslot',
        'integration/vow/',
        'calendar',
        'time slot',
        'appointment',
      ];
      
      markers.forEach(marker => {
        if (lowerBody.includes(marker)) {
          markersFound.push(marker);
        }
      });
      
      // Déterminer si c'est la page SelectSlot
      isSelectSlotPage = markersFound.some(m => 
        ['getavailabletimeslotsforpublic', 'home/availabletimeslots', 'data-slot-time'].includes(m)
      );
    }
    
    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      redirectLocation,
      isSelectSlotPage,
      markersFound,
    };

  } catch (error) {
    return {
      success: false,
      status: 0,
      statusText: 'ERROR',
      headers: {},
      body: null,
      redirectLocation: null,
      isSelectSlotPage: false,
      markersFound: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Capture SelectSlot avec session fraîche');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Étape 1: Setup d'une session fraîche
  const setupResult = await setupFreshCevSession();
  
  if (!setupResult.success) {
    console.log(`❌ Échec du setup: ${setupResult.error}`);
    console.log(`\n💡 Solution alternative:`);
    console.log(`   1. Lance le script cev-manual-capture.ts`);
    console.log(`   2. Connecte-toi manuellement sur VOWINT`);
    console.log(`   3. Clique sur "Prendre rendez-vous"`);
    console.log(`   4. IMMÉDIATEMENT après, lance ce script dans un autre terminal`);
    console.log(`   5. Utilise le cookie frais généré`);
    return;
  }
  
  console.log(`✅ Session fraîche obtenue`);
  console.log(`   Cookie: ${setupResult.sessionCookie?.substring(0, 30)}...`);
  console.log(`   URL: ${setupResult.integrationUrl}`);
  
  // Étape 2: Construire l'URL SelectSlot
  if (!setupResult.integrationUrl) {
    console.log('❌ URL d\'intégration manquante');
    return;
  }
  
  // Convertir l'URL d'intégration en URL SelectSlot
  // Format: /Integration/VOW/{guid1}/{guid2} → /Integration/VOW/SelectSlot
  let selectSlotUrl = setupResult.integrationUrl;
  if (selectSlotUrl.includes('/Integration/VOW/')) {
    // Garder seulement la base jusqu'à /Integration/VOW/
    const baseMatch = selectSlotUrl.match(/^(https:\/\/appointment\.cloud\.diplomatie\.be\/Integration\/VOW\/)[^\/]+\/[^\/]+/);
    if (baseMatch) {
      selectSlotUrl = baseMatch[1] + 'SelectSlot';
      console.log(`🔗 URL SelectSlot construite: ${selectSlotUrl}`);
    }
  }
  
  // Étape 3: Capturer avec redirect: 'manual'
  console.log('\n⏳ Capture en cours...');
  const captureResult = await captureSelectSlotWithManualRedirect(
    selectSlotUrl,
    setupResult.sessionCookie!
  );
  
  // Étape 4: Afficher les résultats
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RÉSULTATS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  if (!captureResult.success) {
    console.log(`❌ Échec de la capture: ${captureResult.error}`);
    return;
  }
  
  console.log(`📊 Status: ${captureResult.status} ${captureResult.statusText}`);
  
  if (captureResult.status === 302) {
    console.log(`🔄 Redirection vers: ${captureResult.redirectLocation}`);
    
    if (captureResult.redirectLocation?.includes('NoAvailability')) {
      console.log(`   ❌ Pas de créneaux disponibles`);
    } else if (captureResult.redirectLocation?.includes('SessionExpired')) {
      console.log(`   ⚠️  Session expirée (trop lente?)`);
    }
  } else if (captureResult.status === 200) {
    console.log(`✅ Status 200 - Page accessible !`);
  }
  
  console.log(`\n🔍 Analyse du body:`);
  console.log(`   Taille: ${captureResult.body?.length || 0} caractères`);
  console.log(`   Page SelectSlot: ${captureResult.isSelectSlotPage ? '✅ OUI' : '❌ NON'}`);
  
  if (captureResult.markersFound.length > 0) {
    console.log(`   Marqueurs trouvés: ${captureResult.markersFound.join(', ')}`);
  }
  
  // Afficher le body si présent
  if (captureResult.body) {
    console.log(`\n📋 Extrait du body (500 premiers caractères):`);
    console.log('─'.repeat(80));
    console.log(captureResult.body.slice(0, 500));
    if (captureResult.body.length > 500) {
      console.log(`... [${captureResult.body.length - 500} caractères supplémentaires]`);
    }
    console.log('─'.repeat(80));
    
    // Sauvegarder
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bodyFile = path.join(__dirname, '..', `selectslot-body-${timestamp}.html`);
    fs.writeFileSync(bodyFile, captureResult.body);
    console.log(`\n💾 Body sauvegardé dans: ${bodyFile}`);
  }
  
  // Étape 5: Recommandations
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RECOMMANDATIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  if (captureResult.status === 302 && captureResult.redirectLocation?.includes('NoAvailability')) {
    console.log(`💡 La session est valide mais il n'y a pas de créneaux.`);
    console.log(`   Le serveur redirige directement vers NoAvailability.`);
    console.log(`\n   Pour capturer SelectSlot, il faut:`);
    console.log(`   1. Attendre qu'un créneau soit disponible`);
    console.log(`   2. Capturer IMMÉDIATEMENT avec redirect: 'manual'`);
  } else if (captureResult.status === 302 && captureResult.redirectLocation?.includes('SessionExpired')) {
    console.log(`💡 La session a expiré trop vite.`);
    console.log(`\n   Solutions:`);
    console.log(`   1. Accélérer le processus (setup → capture en < 5 secondes)`);
    console.log(`   2. Vérifier que le captcha est bien résolu`);
    console.log(`   3. Tester avec une session manuelle (cev-manual-capture.ts)`);
  } else if (captureResult.status === 200 && captureResult.isSelectSlotPage) {
    console.log(`🎉 SUCCÈS ! La page SelectSlot a été capturée.`);
    console.log(`\n   Prochaines étapes:`);
    console.log(`   1. Analyser le HTML pour les sélecteurs de date/heure`);
    console.log(`   2. Tester l'API /Home/AvailableTimeSlots`);
    console.log(`   3. Implémenter la sélection automatique`);
  } else if (captureResult.status === 200) {
    console.log(`⚠️  Status 200 mais pas la page SelectSlot.`);
    console.log(`   Analyser le body pour comprendre quelle page c'est.`);
  }
  
  // Sauvegarder les résultats complets
  const resultFile = path.join(__dirname, '..', `selectslot-result-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const fullResult = {
    timestamp: new Date().toISOString(),
    setup: setupResult,
    capture: captureResult,
  };
  fs.writeFileSync(resultFile, JSON.stringify(fullResult, null, 2));
  console.log(`\n💾 Résultats complets sauvegardés dans: ${resultFile}`);
}

main().catch(console.error);