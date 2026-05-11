/**
 * capture-selectslot-direct.ts — Capture directe du contenu SelectSlot sans redirection
 * 
 * Utilise fetch avec redirect: 'manual' pour capturer le contenu de SelectSlot
 * avant que le navigateur ne suive la redirection vers NoAvailability.
 * 
 * Usage :
 *   npx tsx scripts/capture-selectslot-direct.ts
 * 
 * Prérequis :
 *   - Avoir une session CEV valide (cookie ASP.NET_SessionId)
 *   - Avoir l'URL d'intégration CEV
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface CaptureResult {
  timestamp: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string | null;
  redirectLocation: string | null;
  error?: string;
}

const OUTPUT_FILE = path.join(__dirname, '..', 'selectslot-capture.json');

async function captureSelectSlot(
  integrationUrl: string,
  sessionCookie: string
): Promise<CaptureResult> {
  const result: CaptureResult = {
    timestamp: new Date().toISOString(),
    url: integrationUrl,
    status: 0,
    statusText: '',
    headers: {},
    body: null,
    redirectLocation: null,
  };

  try {
    console.log(`🔍 Capture de: ${integrationUrl}`);
    
    // Utiliser fetch avec redirect: 'manual' pour empêcher le suivi automatique
    const response = await fetch(integrationUrl, {
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
      redirect: 'manual', // IMPORTANT: empêche le suivi automatique
    });

    result.status = response.status;
    result.statusText = response.statusText;
    
    // Capturer tous les headers
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    result.headers = headers;
    
    // Capturer la location header si c'est une redirection
    if (response.status >= 300 && response.status < 400) {
      result.redirectLocation = response.headers.get('location');
      console.log(`🔄 Redirection ${response.status} détectée vers: ${result.redirectLocation}`);
    }
    
    // Essayer de capturer le body même pour les 302
    try {
      const body = await response.text();
      result.body = body;
      console.log(`📄 Body capturé (${body.length} caractères)`);
      
      if (body.length > 0) {
        // Analyser le body pour des indices
        const lowerBody = body.toLowerCase();
        if (lowerBody.includes('selectslot')) {
          console.log('✅ Le body contient "SelectSlot"');
        }
        if (lowerBody.includes('noavailability')) {
          console.log('⚠️  Le body contient "NoAvailability" (redirection déjà dans le body?)');
        }
        if (lowerBody.includes('hcaptcha')) {
          console.log('🔒 Le body contient "hCaptcha"');
        }
        
        // Chercher des marqueurs CEV
        const markers = [
          'getavailabletimeslotsforpublic',
          'home/availabletimeslots',
          'data-slot-time',
          'integration/vow/',
          'bootstrap-datetimepicker',
          'sharedscripts'
        ];
        
        markers.forEach(marker => {
          if (lowerBody.includes(marker)) {
            console.log(`📌 Marqueur trouvé: ${marker}`);
          }
        });
      }
    } catch (bodyError) {
      console.log(`❌ Impossible de lire le body: ${bodyError}`);
    }
    
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    console.error(`❌ Erreur lors de la capture: ${result.error}`);
  }
  
  return result;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Capture directe SelectSlot sans redirection');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  
  // Demander les informations nécessaires
  console.log('📝 Entrez les informations suivantes :');
  
  // Lire depuis .env ou demander à l'utilisateur
  const envPath = path.join(__dirname, '..', '.env');
  let integrationUrl = '';
  let sessionCookie = '';
  
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const lines = envContent.split('\n');
    
    // Chercher l'URL d'intégration dans les logs précédents
    const capturePath = path.join(__dirname, '..', 'capture.json');
    if (fs.existsSync(capturePath)) {
      try {
        const captureData = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
        // Chercher une URL d'intégration dans les requêtes
        const integrationRequests = captureData.requests?.filter((req: any) => 
          req.url.includes('/Integration/VOW/')
        );
        if (integrationRequests && integrationRequests.length > 0) {
          integrationUrl = integrationRequests[0].url;
          console.log(`🔗 URL d'intégration trouvée dans capture.json: ${integrationUrl}`);
        }
      } catch (e) {
        console.log('⚠️  Impossible de lire capture.json');
      }
    }
  }
  
  // Si pas trouvé, demander
  if (!integrationUrl) {
    console.log('🔗 Entrez l\'URL d\'intégration CEV (ex: https://appointment.cloud.diplomatie.be/Integration/VOW/...) :');
    // Note: Dans un vrai script, on utiliserait readline ou prompt
    // Pour l'exemple, on utilise une valeur par défaut
    integrationUrl = 'https://appointment.cloud.diplomatie.be/Integration/VOW/...';
  }
  
  console.log('🍪 Entrez la valeur du cookie ASP.NET_SessionId (sans "ASP.NET_SessionId=") :');
  // Note: Dans un vrai script, on demanderait à l'utilisateur
  sessionCookie = 'votre_cookie_ici';
  
  console.log('');
  console.log('⏳ Capture en cours...');
  
  const result = await captureSelectSlot(integrationUrl, sessionCookie);
  
  // Sauvegarder le résultat
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result, null, 2), 'utf-8');
  
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Capture terminée !`);
  console.log(`  📁 Fichier : ${OUTPUT_FILE}`);
  console.log('');
  console.log('📊 Résumé :');
  console.log(`  URL: ${result.url}`);
  console.log(`  Status: ${result.status} ${result.statusText}`);
  console.log(`  Redirection: ${result.redirectLocation || 'Aucune'}`);
  console.log(`  Body: ${result.body ? `${result.body.length} caractères` : 'Non capturé'}`);
  if (result.error) {
    console.log(`  Erreur: ${result.error}`);
  }
  console.log('═══════════════════════════════════════════════════════════════');
  
  // Afficher un extrait du body si disponible
  if (result.body && result.body.length > 0) {
    console.log('');
    console.log('📄 Extrait du body (premiers 1000 caractères) :');
    console.log('─'.repeat(80));
    console.log(result.body.slice(0, 1000));
    if (result.body.length > 1000) {
      console.log('... [tronqué]');
    }
    console.log('─'.repeat(80));
  }
}

// Version adaptée pour être utilisée avec les données de la capture existante
async function captureFromExistingData() {
  console.log('🔄 Analyse de la capture existante...');
  
  const capturePath = path.join(__dirname, '..', 'capture.json');
  if (!fs.existsSync(capturePath)) {
    console.log('❌ Fichier capture.json non trouvé');
    return;
  }
  
  try {
    const captureData = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    
    // Trouver la requête SelectSlot
    const selectSlotRequest = captureData.requests?.find((req: any) => 
      req.url.includes('/Integration/VOW/SelectSlot')
    );
    
    if (!selectSlotRequest) {
      console.log('❌ Aucune requête SelectSlot trouvée dans capture.json');
      return;
    }
    
    console.log(`🔗 Requête SelectSlot trouvée: ${selectSlotRequest.url}`);
    console.log(`📅 Timestamp: ${selectSlotRequest.timestamp}`);
    
    // Trouver la réponse correspondante
    const selectSlotResponse = captureData.responses?.find((resp: any) => 
      resp.url.includes('/Integration/VOW/SelectSlot')
    );
    
    if (selectSlotResponse) {
      console.log(`📤 Réponse SelectSlot: ${selectSlotResponse.status} ${selectSlotResponse.statusText}`);
      
      if (selectSlotResponse.status === 302) {
        console.log(`🔄 C\'est une redirection 302 vers: ${selectSlotResponse.headers?.location || 'inconnu'}`);
      }
      
      // Extraire le cookie de la session
      const cookieSnapshots = captureData.cookieSnapshots || [];
      let sessionCookie = '';
      
      for (const snapshot of cookieSnapshots) {
        const cevCookie = snapshot.cookies?.find((c: any) => 
          c.name === 'ASP.NET_SessionId' && c.domain.includes('appointment.cloud')
        );
        if (cevCookie) {
          sessionCookie = cevCookie.value;
          console.log(`🍪 Cookie trouvé: ${sessionCookie.substring(0, 20)}...`);
          break;
        }
      }
      
      if (sessionCookie) {
        console.log('');
        console.log('🔄 Tentative de recapture avec fetch(redirect: "manual")...');
        
        // Recapturer avec fetch
        const result = await captureSelectSlot(selectSlotRequest.url, sessionCookie);
        
        // Sauvegarder
        const recaptureFile = path.join(__dirname, '..', 'selectslot-recapture.json');
        fs.writeFileSync(recaptureFile, JSON.stringify(result, null, 2), 'utf-8');
        console.log(`✅ Recapture sauvegardée dans: ${recaptureFile}`);
      } else {
        console.log('❌ Cookie ASP.NET_SessionId non trouvé dans les snapshots');
      }
    } else {
      console.log('❌ Réponse SelectSlot non trouvée');
    }
    
  } catch (error) {
    console.error(`❌ Erreur lors de l'analyse: ${error}`);
  }
}

// Exécuter
if (process.argv.includes('--from-capture')) {
  captureFromExistingData().catch(console.error);
} else {
  main().catch(console.error);
}