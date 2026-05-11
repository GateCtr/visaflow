/**
 * test-selectslot-capture.ts — Tester la capture de SelectSlot sans redirection
 * 
 * Utilise les données de capture.json pour tester la fonction captureSelectSlotWithoutRedirect
 * 
 * Usage :
 *   npx tsx scripts/test-selectslot-capture.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('🔍 Analyse de la capture existante pour SelectSlot...\n');
  
  const capturePath = path.join(__dirname, '..', 'capture.json');
  if (!fs.existsSync(capturePath)) {
    console.log('❌ Fichier capture.json non trouvé');
    return;
  }
  
  try {
    const captureData = JSON.parse(fs.readFileSync(capturePath, 'utf-8'));
    
    // 1. Trouver la requête SelectSlot
    const selectSlotRequests = captureData.requests?.filter((req: any) => 
      req.url.includes('/Integration/VOW/SelectSlot')
    ) || [];
    
    console.log(`📊 ${selectSlotRequests.length} requête(s) SelectSlot trouvée(s)`);
    
    for (const req of selectSlotRequests) {
      console.log(`\n─`.repeat(50));
      console.log(`🔗 URL: ${req.url}`);
      console.log(`📅 Timestamp: ${req.timestamp}`);
      console.log(`📤 Méthode: ${req.method}`);
      
      // Trouver la réponse correspondante
      const response = captureData.responses?.find((resp: any) => 
        resp.url === req.url
      );
      
      if (response) {
        console.log(`📥 Réponse: ${response.status} ${response.statusText}`);
        
        if (response.status === 302) {
          const location = response.headers?.location || response.headers?.Location;
          console.log(`🔄 Redirection 302 vers: ${location}`);
          
          // Vérifier si on a capturé le body de la 302
          if (response.body && response.body.length > 0) {
            console.log(`📄 Body de la 302 capturé: ${response.body.length} caractères`);
            
            // Analyser le body
            const lowerBody = response.body.toLowerCase();
            const markers = [
              'selectslot',
              'noavailability', 
              'sessionexpired',
              'hcaptcha',
              'getavailabletimeslotsforpublic',
              'home/availabletimeslots'
            ];
            
            console.log(`🔍 Analyse du body:`);
            markers.forEach(marker => {
              if (lowerBody.includes(marker)) {
                console.log(`   ✅ Contient: ${marker}`);
              }
            });
            
            // Afficher un extrait
            console.log(`\n📋 Extrait du body (500 premiers caractères):`);
            console.log('─'.repeat(80));
            console.log(response.body.slice(0, 500));
            if (response.body.length > 500) console.log('...');
            console.log('─'.repeat(80));
          } else {
            console.log(`📄 Body: Non capturé ou vide`);
          }
        }
        
        // Afficher les headers importants
        console.log(`\n📋 Headers de la réponse:`);
        const importantHeaders = ['location', 'Location', 'set-cookie', 'Set-Cookie', 'content-type', 'Content-Type'];
        Object.entries(response.headers || {}).forEach(([key, value]) => {
          if (importantHeaders.includes(key.toLowerCase())) {
            console.log(`   ${key}: ${value}`);
          }
        });
      } else {
        console.log(`❌ Réponse non trouvée pour cette requête`);
      }
    }
    
    // 2. Analyser les cookies
    console.log(`\n─`.repeat(50));
    console.log(`🍪 Analyse des cookies:`);
    
    const cookieSnapshots = captureData.cookieSnapshots || [];
    console.log(`📊 ${cookieSnapshots.length} snapshot(s) de cookies`);
    
    let cevSessionCookie = '';
    for (const snapshot of cookieSnapshots) {
      const cevCookie = snapshot.cookies?.find((c: any) => 
        c.name === 'ASP.NET_SessionId' && c.domain.includes('appointment.cloud')
      );
      if (cevCookie) {
        cevSessionCookie = cevCookie.value;
        console.log(`✅ Cookie ASP.NET_SessionId trouvé: ${cevCookie.value.substring(0, 30)}...`);
        console.log(`   Domaine: ${cevCookie.domain}`);
        console.log(`   Timestamp: ${snapshot.timestamp}`);
        console.log(`   Trigger: ${snapshot.trigger}`);
        break;
      }
    }
    
    if (!cevSessionCookie) {
      console.log(`❌ Cookie ASP.NET_SessionId non trouvé`);
    }
    
    // 3. Analyser les redirections
    console.log(`\n─`.repeat(50));
    console.log(`🔄 Analyse des redirections:`);
    
    const redirectResponses = captureData.responses?.filter((resp: any) => 
      resp.status >= 300 && resp.status < 400
    ) || [];
    
    console.log(`📊 ${redirectResponses.length} redirection(s) détectée(s)`);
    
    for (const resp of redirectResponses.slice(0, 5)) { // Limiter aux 5 premières
      const location = resp.headers?.location || resp.headers?.Location;
      console.log(`\n   ${resp.status} ${resp.url}`);
      console.log(`   → ${location || 'Pas de location header'}`);
      console.log(`   Body: ${resp.body ? `${resp.body.length} chars` : 'none'}`);
    }
    
    // 4. Recommandations pour la capture future
    console.log(`\n─`.repeat(50));
    console.log(`💡 RECOMMANDATIONS pour capturer SelectSlot:`);
    console.log(`\n1. Utiliser fetch avec redirect: 'manual'`);
    console.log(`   Exemple:`);
    console.log(`   fetch(url, { redirect: 'manual', ... })`);
    console.log(`\n2. Capturer TOUS les headers de la réponse 302`);
    console.log(`   - location: URL de redirection`);
    console.log(`   - set-cookie: Nouveaux cookies`);
    console.log(`   - content-type: Type de contenu`);
    console.log(`\n3. Essayer de lire le body même pour les 302`);
    console.log(`   Certains serveurs envoient du HTML dans les 302`);
    console.log(`\n4. Analyser le body pour:`);
    console.log(`   - Marqueurs CEV (getavailabletimeslotsforpublic, etc.)`);
    console.log(`   - Messages d'erreur (NoAvailability, SessionExpired)`);
    console.log(`   - Contenu HTML de la page`);
    
    // 5. Générer un exemple de code
    if (selectSlotRequests.length > 0 && cevSessionCookie) {
      const exampleUrl = selectSlotRequests[0].url;
      console.log(`\n─`.repeat(50));
      console.log(`📝 Exemple de code pour recapturer:`);
      console.log(`\`\`\`typescript`);
      console.log(`async function captureSelectSlot() {`);
      console.log(`  const response = await fetch('${exampleUrl}', {`);
      console.log(`    method: 'GET',`);
      console.log(`    headers: {`);
      console.log(`      'Cookie': 'ASP.NET_SessionId=${cevSessionCookie.substring(0, 20)}...; PreferredCulture=en-US',`);
      console.log(`      'User-Agent': 'Mozilla/5.0 ...',`);
      console.log(`    },`);
      console.log(`    redirect: 'manual', // IMPORTANT`);
      console.log(`  });`);
      console.log(`  `);
      console.log(`  console.log('Status:', response.status);`);
      console.log(`  console.log('Location:', response.headers.get('location'));`);
      console.log(`  console.log('Body:', await response.text());`);
      console.log(`}`);
      console.log(`\`\`\``);
    }
    
  } catch (error) {
    console.error(`❌ Erreur lors de l'analyse: ${error}`);
  }
}

main().catch(console.error);