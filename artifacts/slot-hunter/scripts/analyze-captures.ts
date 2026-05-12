/**
 * Analyser les captures pour extraire les cookies cf_clearance
 */

import * as fs from 'fs';
import * as path from 'path';

interface CaptureInfo {
  file: string;
  sizeMB: number;
  timestamp: number;
  cfClearance?: string;
  cookieAgeMinutes: number;
  cookieLength: number;
  isExpired: boolean;
}

function analyzeCaptures(): CaptureInfo[] {
  const captureDir = './captured/spain';
  const files = fs.readdirSync(captureDir).filter(f => f.startsWith('capture-'));
  
  const results: CaptureInfo[] = [];
  
  console.log('🔍 Analyse des captures disponibles:\n');
  
  for (const file of files) {
    const filePath = path.join(captureDir, file);
    const stats = fs.statSync(filePath);
    const sizeMB = stats.size / (1024 * 1024);
    
    // Extraire le timestamp du nom de fichier
    const timestampMatch = file.match(/capture-(\d+)\.json/);
    const fileTimestamp = timestampMatch ? parseInt(timestampMatch[1]) : 0;
    
    const info: CaptureInfo = {
      file,
      sizeMB,
      timestamp: fileTimestamp,
      cookieAgeMinutes: 0,
      cookieLength: 0,
      isExpired: true
    };
    
    try {
      // Lire le fichier (première partie seulement pour la performance)
      const stream = fs.createReadStream(filePath, { encoding: 'utf8', start: 0, end: 200000 });
      let content = '';
      
      stream.on('data', chunk => content += chunk);
      stream.on('end', () => {
        // Chercher cf_clearance
        const cfMatch = content.match(/"name":\s*"cf_clearance",\s*"value":\s*"([^"]+)"/);
        
        if (cfMatch) {
          info.cfClearance = cfMatch[1];
          info.cookieLength = cfMatch[1].length;
          
          // Extraire le timestamp du cookie
          const cookieTimestampMatch = cfMatch[1].match(/-(\d+)-/);
          if (cookieTimestampMatch) {
            const cookieTimestamp = parseInt(cookieTimestampMatch[1]);
            const nowSeconds = Math.floor(Date.now() / 1000);
            info.cookieAgeMinutes = Math.round((nowSeconds - cookieTimestamp) / 60);
            
            // Un cookie cf_clearance expire généralement après 2 heures (120 minutes)
            info.isExpired = info.cookieAgeMinutes > 120;
          }
        }
        
        results.push(info);
        printCaptureInfo(info);
        
        // Si c'est le dernier fichier, faire les recommandations
        if (results.length === files.length) {
          makeRecommendations(results);
        }
      });
      
    } catch (error) {
      console.log(`❌ Erreur lecture ${file}: ${error.message}`);
      results.push(info);
    }
  }
  
  return results;
}

function printCaptureInfo(info: CaptureInfo): void {
  console.log(`📁 ${info.file}`);
  console.log(`   Taille: ${info.sizeMB.toFixed(2)} MB`);
  console.log(`   Timestamp fichier: ${new Date(info.timestamp).toLocaleString()}`);
  
  if (info.cfClearance) {
    console.log(`   🍪 Cookie cf_clearance trouvé`);
    console.log(`      Début: ${info.cfClearance.substring(0, 30)}...`);
    console.log(`      Longueur: ${info.cookieLength} caractères`);
    console.log(`      Âge: ${info.cookieAgeMinutes} minutes`);
    console.log(`      Statut: ${info.isExpired ? '❌ EXPIRÉ' : '✅ VALIDE'}`);
  } else {
    console.log(`   ❌ Aucun cookie trouvé`);
  }
  console.log('');
}

function makeRecommendations(results: CaptureInfo[]): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('💡 RECOMMANDATIONS');
  console.log('═══════════════════════════════════════════════════════════════\n');
  
  const validCookies = results.filter(r => r.cfClearance && !r.isExpired);
  const expiredCookies = results.filter(r => r.cfClearance && r.isExpired);
  
  if (validCookies.length > 0) {
    console.log(`✅ ${validCookies.length} cookie(s) valide(s) trouvé(s):`);
    validCookies.forEach(cookie => {
      console.log(`   - ${cookie.file} (${cookie.cookieAgeMinutes} minutes)`);
    });
    
    console.log('\n🎯 Actions recommandées:');
    console.log('   1. Utiliser le cookie le plus récent pour tester l\'API');
    console.log('   2. Créer un script de test avec ce cookie');
    console.log('   3. Vérifier si l\'API Bookitit fonctionne');
    
    // Afficher le cookie le plus récent
    const mostRecent = validCookies.sort((a, b) => b.timestamp - a.timestamp)[0];
    if (mostRecent && mostRecent.cfClearance) {
      console.log('\n🍪 Cookie le plus récent:');
      console.log(mostRecent.cfClearance);
    }
    
  } else if (expiredCookies.length > 0) {
    console.log(`⚠️  ${expiredCookies.length} cookie(s) expiré(s) trouvé(s)`);
    console.log('   Les cookies cf_clearance expirent après ~2 heures');
    
    console.log('\n🎯 Actions recommandées:');
    console.log('   1. Lancer une nouvelle capture manuelle');
    console.log('   2. Suivre le flow manuel complet');
    console.log('   3. Extraire le nouveau cookie frais');
    console.log('   4. Tester l\'API avec le nouveau cookie');
    
  } else {
    console.log('❌ Aucun cookie cf_clearance trouvé dans les captures');
    console.log('\n🎯 Actions recommandées:');
    console.log('   1. Lancer une capture manuelle complète');
    console.log('   2. Suivre toutes les étapes manuelles');
    console.log('   3. Extraire le cookie de la nouvelle capture');
  }
  
  console.log('\n🚀 Commande pour nouvelle capture:');
  console.log('   npm run spain:capture:manual');
}

// Exécuter l'analyse
analyzeCaptures();