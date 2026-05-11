/**
 * capture-selectslot-now.ts — Capture immédiate de SelectSlot
 * 
 * Utilise les données de capture.json pour recapturer SelectSlot
 * avec redirect: 'manual' et analyser le contenu.
 * 
 * Usage :
 *   npx tsx scripts/capture-selectslot-now.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function captureWithManualRedirect(
  url: string,
  sessionCookie: string
): Promise<{
  success: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  redirectLocation: string | null;
  error?: string;
}> {
  try {
    console.log(`🔍 Capture de: ${url}`);
    
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
      redirect: 'manual', // NE PAS suivre automatiquement
    });

    // Capturer les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const redirectLocation = response.headers.get('location');
    
    // Essayer de capturer le body
    let body: string | null = null;
    try {
      body = await response.text();
    } catch (bodyError) {
      console.log(`⚠️  Impossible de lire le body: ${bodyError}`);
    }

    return {
      success: true,
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      redirectLocation,
    };

  } catch (error) {
    return {
      success: false,
      status: 0,
      statusText: 'ERROR',
      headers: {},
      body: null,
      redirectLocation: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Capture immédiate SelectSlot sans redirection');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Lire la capture existante
  const capturePath = path.join(__dirname, '..', 'capture.json');
  if (!fs.existsSync(capturePath)) {
    console.log('❌ capture.json non trouvé');
    return;
  }
  
  try {
    const captureData = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    
    // 1. Trouver l'URL SelectSlot
    const selectSlotRequest = captureData.requests?.find((req: any) => 
      req.url.includes('/Integration/VOW/SelectSlot')
    );
    
    if (!selectSlotRequest) {
      console.log('❌ Requête SelectSlot non trouvée');
      return;
    }
    
    const selectSlotUrl = selectSlotRequest.url;
    console.log(`🔗 URL SelectSlot: ${selectSlotUrl}`);
    
    // 2. Trouver le cookie
    let sessionCookie = '';
    const cookieSnapshots = captureData.cookieSnapshots || [];
    
    for (const snapshot of cookieSnapshots) {
      const cevCookie = snapshot.cookies?.find((c: any) => 
        c.name === 'ASP.NET_SessionId' && c.domain.includes('appointment.cloud')
      );
      if (cevCookie) {
        sessionCookie = cevCookie.value;
        console.log(`🍪 Cookie trouvé: ${sessionCookie.substring(0, 30)}...`);
        break;
      }
    }
    
    if (!sessionCookie) {
      console.log('❌ Cookie ASP.NET_SessionId non trouvé');
      return;
    }
    
    // 3. Capturer avec redirect: 'manual'
    console.log('\n⏳ Capture en cours (redirect: "manual")...');
    const result = await captureWithManualRedirect(selectSlotUrl, sessionCookie);
    
    // 4. Afficher les résultats
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  RÉSULTATS DE LA CAPTURE');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    if (!result.success) {
      console.log(`❌ Échec: ${result.error}`);
      return;
    }
    
    console.log(`📊 Status: ${result.status} ${result.statusText}`);
    console.log(`🔄 Redirection: ${result.redirectLocation || 'Aucune'}`);
    console.log(`📄 Body: ${result.body ? `${result.body.length} caractères` : 'Vide/null'}`);
    
    // Afficher les headers importants
    console.log('\n📋 Headers:');
    const importantHeaders = ['location', 'set-cookie', 'content-type', 'cache-control', 'pragma'];
    Object.entries(result.headers).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (importantHeaders.some(h => lowerKey.includes(h))) {
        console.log(`  ${key}: ${value}`);
      }
    });
    
    // Analyser le body
    if (result.body && result.body.length > 0) {
      console.log('\n🔍 Analyse du body:');
      
      const lowerBody = result.body.toLowerCase();
      const markers = [
        'selectslot',
        'noavailability',
        'sessionexpired',
        'hcaptcha',
        'getavailabletimeslotsforpublic',
        'home/availabletimeslots',
        'availabletimeslots',
        'data-slot-time',
        'bootstrap-datetimepicker',
        'sharedscripts',
        '<html',
        '<body',
        '<div',
        '<script',
        '<form',
      ];
      
      let foundMarkers = 0;
      markers.forEach(marker => {
        if (lowerBody.includes(marker)) {
          console.log(`  ✅ ${marker}`);
          foundMarkers++;
        }
      });
      
      if (foundMarkers === 0) {
        console.log(`  ⚠️  Aucun marqueur trouvé`);
      }
      
      // Afficher un extrait
      console.log('\n📋 Extrait du body (1000 premiers caractères):');
      console.log('─'.repeat(80));
      console.log(result.body.slice(0, 1000));
      if (result.body.length > 1000) {
        console.log(`... [${result.body.length - 1000} caractères supplémentaires]`);
      }
      console.log('─'.repeat(80));
      
      // Sauvegarder le body complet
      const bodyFile = path.join(__dirname, '..', 'selectslot-body.html');
      fs.writeFileSync(bodyFile, result.body);
      console.log(`\n💾 Body complet sauvegardé dans: ${bodyFile}`);
    }
    
    // 5. Interprétation
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('  INTERPRÉTATION');
    console.log('═══════════════════════════════════════════════════════════════\n');
    
    if (result.status === 302) {
      console.log(`🔄 C'est une redirection 302`);
      console.log(`   → Vers: ${result.redirectLocation}`);
      
      if (result.body && result.body.length > 0) {
        console.log(`\n💡 Le serveur a envoyé du contenu avec la redirection 302.`);
        console.log(`   Cela pourrait être:`);
        console.log(`   1. Une page HTML complète (peut-être la page SelectSlot)`);
        console.log(`   2. Un message d'erreur`);
        console.log(`   3. Du JavaScript de redirection`);
        
        if (result.body.includes('NoAvailability') || result.body.includes('noavailability')) {
          console.log(`\n⚠️  Le body contient "NoAvailability"`);
          console.log(`   La redirection est probablement due à l'absence de créneaux.`);
        }
        
        if (result.body.includes('getavailabletimeslotsforpublic')) {
          console.log(`\n✅ Le body contient "getavailabletimeslotsforpublic"`);
          console.log(`   C'est un marqueur de la page calendrier CEV !`);
          console.log(`   Le serveur a peut-être envoyé la page SelectSlot avant de rediriger.`);
        }
      } else {
        console.log(`\n💡 Redirection 302 standard sans body.`);
        console.log(`   Le navigateur suivrait automatiquement vers: ${result.redirectLocation}`);
      }
    } else if (result.status === 200) {
      console.log(`✅ Status 200 - Pas de redirection !`);
      console.log(`   La page SelectSlot est accessible directement.`);
    } else {
      console.log(`⚠️  Status ${result.status} - À analyser`);
    }
    
    // Sauvegarder les résultats complets
    const resultFile = path.join(__dirname, '..', 'selectslot-capture-result.json');
    fs.writeFileSync(resultFile, JSON.stringify(result, null, 2));
    console.log(`\n💾 Résultats complets sauvegardés dans: ${resultFile}`);
    
  } catch (error) {
    console.error(`❌ Erreur: ${error}`);
  }
}

main().catch(console.error);