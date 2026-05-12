import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lire le bundle
const bundlePath = path.join(__dirname, 'bundle-analysis', 'bundle.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');

console.log('Analyse du bundle USA pour les messages d\'erreur d\'authentification');
console.log('='.repeat(60));

// Chercher des messages d'erreur courants
const errorPatterns = [
  'temporarily restricted',
  'account temporarily',
  'access temporarily',
  'too many requests',
  'rate limit exceeded',
  'please try again later',
  'your account has been',
  'account locked',
  'access denied',
  'temporarily unavailable',
  'suspended',
  'blocked',
  'restricted access',
  'too many attempts',
  'try again later'
];

console.log('\n1. Recherche de patterns textuels:');
for (const pattern of errorPatterns) {
  const regex = new RegExp(pattern, 'gi');
  const matches = bundle.match(regex);
  if (matches) {
    console.log(`  ${pattern}: ${matches.length} occurrence(s)`);
    
    // Trouver le contexte autour de la première occurrence
    const index = bundle.toLowerCase().indexOf(pattern.toLowerCase());
    if (index !== -1) {
      const start = Math.max(0, index - 150);
      const end = Math.min(bundle.length, index + 150);
      let context = bundle.substring(start, end);
      
      // Nettoyer le contexte
      context = context.replace(/\n/g, ' ').replace(/\s+/g, ' ');
      console.log(`    Contexte: ...${context}...`);
    }
  }
}

// Chercher des structures JSON avec des messages d'erreur
console.log('\n2. Recherche de structures JSON avec des erreurs:');
const jsonPatterns = [
  /"error"\s*:\s*"([^"]+)"/gi,
  /"msg"\s*:\s*"([^"]+)"/gi,
  /"message"\s*:\s*"([^"]+)"/gi,
  /"errorMessage"\s*:\s*"([^"]+)"/gi,
  /"description"\s*:\s*"([^"]+)"/gi
];

let foundErrors = [];
for (const pattern of jsonPatterns) {
  let match;
  while ((match = pattern.exec(bundle)) !== null) {
    const errorMsg = match[1].toLowerCase();
    // Filtrer les messages d'erreur intéressants
    if (errorMsg.includes('temporarily') || 
        errorMsg.includes('restricted') ||
        errorMsg.includes('access') ||
        errorMsg.includes('account') ||
        errorMsg.includes('too many') ||
        errorMsg.includes('rate limit') ||
        errorMsg.includes('try again') ||
        errorMsg.includes('locked') ||
        errorMsg.includes('denied') ||
        errorMsg.includes('suspended')) {
      foundErrors.push({
        type: match[0].split(':')[0].replace(/"/g, '').trim(),
        message: match[1]
      });
    }
  }
}

// Afficher les erreurs uniques
const uniqueErrors = [...new Set(foundErrors.map(e => e.message))];
console.log(`  ${uniqueErrors.length} message(s) d'erreur unique(s) trouvé(s):`);
uniqueErrors.slice(0, 10).forEach((msg, i) => {
  console.log(`  ${i + 1}. "${msg}"`);
});

// Chercher dans les sections d'erreur HTTP
console.log('\n3. Recherche de codes d\'erreur HTTP:');
const httpErrorPatterns = [
  /401\s*:\s*"([^"]+)"/gi,
  /403\s*:\s*"([^"]+)"/gi,
  /429\s*:\s*"([^"]+)"/gi,
  /"status"\s*:\s*401/gi,
  /"status"\s*:\s*403/gi,
  /"status"\s*:\s*429/gi
];

for (const pattern of httpErrorPatterns) {
  const matches = bundle.match(pattern);
  if (matches) {
    console.log(`  ${pattern.toString().substring(0, 50)}: ${matches.length} occurrence(s)`);
  }
}

// Extraire des sections spécifiques du bundle
console.log('\n4. Extraction de sections pertinentes:');
const sectionsToExtract = [
  { name: 'login error handling', pattern: /login.*error|error.*login/gi },
  { name: 'authentication error', pattern: /auth.*error|error.*auth/gi },
  { name: 'rate limiting', pattern: /rate.*limit|limit.*rate/gi },
  { name: 'temporarily', pattern: /temporarily/gi }
];

for (const section of sectionsToExtract) {
  const matches = bundle.match(section.pattern);
  if (matches) {
    console.log(`  ${section.name}: ${matches.length} occurrence(s)`);
    
    // Extraire un exemple
    const index = bundle.toLowerCase().indexOf(section.pattern.source.replace(/\\/g, '').split('|')[0]);
    if (index !== -1) {
      const start = Math.max(0, index - 200);
      const end = Math.min(bundle.length, index + 300);
      const example = bundle.substring(start, end);
      console.log(`    Exemple: ${example.substring(0, 100)}...`);
    }
  }
}

console.log('\n' + '='.repeat(60));
console.log('Analyse terminée.');