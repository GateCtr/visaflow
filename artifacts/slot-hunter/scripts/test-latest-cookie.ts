/**
 * Tester le cookie cf_clearance le plus récent avec l'API Bookitit
 */

import * as fs from 'fs';
import * as path from 'path';
import { BookititApiClient } from '../src/spain/bookitit-client.js';

interface CookieInfo {
  file: string;
  cookie: string;
  timestamp: number;
  ageMinutes: number;
  isValid: boolean;
}

function extractLatestCookie(): CookieInfo | null {
  const captureDir = './captured/spain';
  const files = fs.readdirSync(captureDir).filter(f => f.startsWith('capture-'));
  
  let latestCookie: CookieInfo | null = null;
  
  for (const file of files) {
    const filePath = path.join(captureDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Chercher cf_clearance
    const cfMatch = content.match(/"name":\s*"cf_clearance",\s*"value":\s*"([^"]+)"/);
    
    if (cfMatch) {
      const cookie = cfMatch[1];
      
      // Extraire le timestamp du cookie
      const timestampMatch = cookie.match(/-(\d+)-/);
      if (timestampMatch) {
        const cookieTimestamp = parseInt(timestampMatch[1]);
        const nowSeconds = Math.floor(Date.now() / 1000);
        const ageMinutes = Math.round((nowSeconds - cookieTimestamp) / 60);
        const isValid = ageMinutes <= 120; // 2 heures max
        
        const cookieInfo: CookieInfo = {
          file,
          cookie,
          timestamp: cookieTimestamp,
          ageMinutes,
          isValid
        };
        
        // Garder le plus récent
        if (!latestCookie || cookieTimestamp > latestCookie.timestamp) {
          latestCookie = cookieInfo;
        }
      }
    }
  }
  
  return latestCookie;
}

async function testBookititApi(cookie: string): Promise<boolean> {
  console.log('🧪 Test de l\'API Bookitit...');
  
  try {
    const client = new BookititApiClient({
      publickey: '25028fcd7126544630b8da0c6e60722b5',
      widgetId: '25028fcd7126544630b8da0c6e60722b5',
      lang: 'es',
      cfClearance: cookie
    });
    
    console.log('🔍 Récupération des services...');
    const services = await client.getServices();
    
    console.log(`✅ SUCCÈS! ${services.length} service(s) trouvé(s):`);
    
    if (services.length > 0) {
      services.forEach((service, index) => {
        const name = service.name ? service.name.replace(/<[^>]*>/g, '').trim() : 'Hidden service';
        console.log(`   ${index + 1}. ${service.id}: ${name}`);
      });
      
      // Tester la configuration du widget
      console.log('\n🔍 Récupération de la configuration...');
      const config = await client.getWidgetConfiguration();
      
      if (config) {
        console.log(`✅ Configuration chargée:`);
        console.log(`   - Registration type: ${config.registration_type}`);
        console.log(`   - Waiting list: ${config.waiting_list}`);
        console.log(`   - Show comments: ${config.show_comments}`);
      }
      
      // Tester les agendas pour le premier service
      if (services.length > 0) {
        const firstService = services[0];
        console.log(`\n🔍 Récupération des agendas pour ${firstService.id}...`);
        
        try {
          const agendas = await client.getAgendas(firstService.id);
          console.log(`✅ ${agendas.length} agenda(s) trouvé(s)`);
          
          if (agendas.length > 0) {
            // Tester les créneaux pour aujourd'hui
            const today = new Date().toISOString().split('T')[0];
            const firstAgenda = agendas[0];
            console.log(`\n🔍 Vérification des créneaux pour ${firstAgenda.id} (${today})...`);
            
            const slots = await client.getSlots(firstAgenda.id, today);
            const availableSlots = slots.filter(s => s.available);
            
            console.log(`📊 ${slots.length} créneau(x) total, ${availableSlots.length} disponible(s)`);
            
            if (availableSlots.length > 0) {
              console.log('🎉 CRÉNEAUX DISPONIBLES!');
              availableSlots.forEach(slot => {
                const date = new Date(slot.datetime * 1000);
                console.log(`   - ${date.toLocaleString()}: ${slot.slots} place(s)`);
              });
            } else {
              console.log('😔 Aucun créneau disponible aujourd\'hui');
            }
          }
        } catch (agendaError) {
          console.log(`⚠️  Erreur agendas: ${agendaError.message}`);
        }
      }
      
      return true;
    } else {
      console.log('⚠️  Aucun service trouvé (mais API fonctionne)');
      return true;
    }
    
  } catch (error) {
    console.error(`❌ ERREUR API: ${error.message}`);
    
    // Analyse de l'erreur
    if (error.message.includes('JSON') || error.message.includes('DOCTYPE')) {
      console.log('🔧 Le cookie est probablement expiré ou invalide');
      console.log('   Cloudflare renvoie une page HTML au lieu de JSON');
    } else if (error.message.includes('timeout')) {
      console.log('🔧 Timeout - problème de réseau ou serveur lent');
    } else if (error.message.includes('status')) {
      console.log('🔧 Erreur HTTP - vérifiez le cookie et les headers');
    }
    
    return false;
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🧪 TEST DU COOKIE CF_CLEARANCE LE PLUS RÉCENT');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  // Extraire le cookie le plus récent
  const cookieInfo = extractLatestCookie();
  
  if (!cookieInfo) {
    console.log('❌ Aucun cookie cf_clearance trouvé dans les captures');
    console.log('\n🚀 Lancez une nouvelle capture:');
    console.log('   npm run spain:capture:manual');
    return;
  }
  
  console.log('🍪 Cookie le plus récent trouvé:');
  console.log(`   Fichier: ${cookieInfo.file}`);
  console.log(`   Âge: ${cookieInfo.ageMinutes} minutes`);
  console.log(`   Statut: ${cookieInfo.isValid ? '✅ VALIDE' : '❌ EXPIRÉ'}`);
  console.log(`   Cookie: ${cookieInfo.cookie.substring(0, 50)}...\n`);
  
  if (!cookieInfo.isValid) {
    console.log('⚠️  Le cookie est expiré (plus de 2 heures)');
    console.log('   Il ne fonctionnera probablement pas avec l\'API');
    console.log('\n🚀 Lancez une nouvelle capture:');
    console.log('   npm run spain:capture:manual');
    return;
  }
  
  // Tester l'API
  const apiWorks = await testBookititApi(cookieInfo.cookie);
  
  console.log('\n═══════════════════════════════════════════════════════════════');
  
  if (apiWorks) {
    console.log('🎉 SUCCÈS COMPLET!');
    console.log('   ✅ Cookie cf_clearance valide');
    console.log('   ✅ API Bookitit accessible');
    console.log('   ✅ Prêt pour l\'automatisation');
    
    console.log('\n💡 Prochaines étapes:');
    console.log('   1. Implémenter le polling automatique');
    console.log('   2. Ajouter la détection de créneaux disponibles');
    console.log('   3. Configurer les notifications');
    console.log('   4. Automatiser le renouvellement du cookie');
    
  } else {
    console.log('❌ ÉCHEC DU TEST');
    console.log('\n🔧 Problèmes possibles:');
    console.log('   1. Cookie expiré (même si < 2 heures)');
    console.log('   2. Cloudflare a changé sa protection');
    console.log('   3. Problème de réseau/proxy');
    console.log('   4. API Bookitit modifiée');
    
    console.log('\n🔄 Solutions:');
    console.log('   1. Lancer une nouvelle capture manuelle');
    console.log('   2. Vérifier les étapes manuelles complètes');
    console.log('   3. Extraire un cookie frais');
    console.log('   4. Tester à nouveau');
    
    console.log('\n🚀 Commande: npm run spain:capture:manual');
  }
  
  console.log('\n═══════════════════════════════════════════════════════════════\n');
}

// Exécuter
main().catch(console.error);