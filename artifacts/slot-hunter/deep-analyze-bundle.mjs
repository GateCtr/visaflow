import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bundlePath = path.join(__dirname, 'bundle-analysis', 'bundle.js');
const bundle = fs.readFileSync(bundlePath, 'utf8');

// Fonction pour extraire le contexte autour d'un pattern
function extractContext(text, pattern, contextSize = 200) {
  const index = text.toLowerCase().indexOf(pattern.toLowerCase());
  if (index === -1) return null;
  
  const start = Math.max(0, index - contextSize);
  const end = Math.min(text.length, index + contextSize);
  return text.substring(start, end);
}

// Chercher des patterns spécifiques
const patterns = [
  'temporarily',
  'restricted',
  'access denied',
  'account locked',
  'too many',
  'rate limit',
  'suspended',
  'blocked',
  'try again',
  'please wait',
  'unauthorized',
  'forbidden'
];

console.log('Analyse approfondie du bundle USA:');
console.log('='.repeat(70));

for (const pattern of patterns) {
  const regex = new RegExp(pattern, 'gi');
  const matches = bundle.match(regex);
  
  if (matches) {
    console.log(`\nPattern: "${pattern}" - ${matches.length} occurrence(s)`);
    
    // Extraire quelques exemples
    const contexts = [];
    let lastIndex = 0;
    for (let i = 0; i < Math.min(3, matches.length); i++) {
      const index = bundle.toLowerCase().indexOf(pattern.toLowerCase(), lastIndex);
      if (index === -1) break;
      
      const context = extractContext(bundle, pattern, 100);
      if (context) {
        contexts.push(context);
        lastIndex = index + 1;
      }
    }
    
    // Afficher les contextes uniques
    const uniqueContexts = [...new Set(contexts)];
    uniqueContexts.forEach((ctx, idx) => {
      console.log(`  Exemple ${idx + 1}: ...${ctx.replace(/\n/g, ' ').substring(0, 120)}...`);
    });
  }
}

// Chercher des structures de réponse d'erreur
console.log('\n\nRecherche de structures de réponse d\'erreur:');
console.log('='.repeat(70));

// Patterns pour les réponses JSON d'erreur
const errorResponsePatterns = [
  /\{[^{}]*"error"[^{}]*\}/g,
  /\{[^{}]*"msg"[^{}]*\}/g,
  /\{[^{}]*"message"[^{}]*\}/g
];

let foundErrorResponses = [];

for (const pattern of errorResponsePatterns) {
  const matches = bundle.match(pattern);
  if (matches) {
    foundErrorResponses.push(...matches.slice(0, 10)); // Limiter à 10 par pattern
  }
}

// Filtrer et afficher les réponses intéressantes
const interestingResponses = foundErrorResponses.filter(resp => {
  const lower = resp.toLowerCase();
  return lower.includes('temporarily') || 
         lower.includes('restricted') ||
         lower.includes('access') ||
         lower.includes('account') ||
         lower.includes('limit') ||
         lower.includes('suspended') ||
         lower.includes('blocked') ||
         lower.includes('denied');
});

console.log(`Réponses d'erreur intéressantes trouvées: ${interestingResponses.length}`);

// Afficher les réponses uniques
const uniqueResponses = [...new Set(interestingResponses)];
uniqueResponses.slice(0, 5).forEach((resp, i) => {
  console.log(`\nRéponse ${i + 1}:`);
  console.log(resp.substring(0, 200) + (resp.length > 200 ? '...' : ''));
});

// Analyser les sections de gestion d'erreur
console.log('\n\nAnalyse des sections de gestion d\'erreur:');
console.log('='.repeat(70));

// Chercher des fonctions de gestion d'erreur
const errorHandlingPatterns = [
  /catch\s*\([^)]*\)\s*\{[^}]*\}/g,
  /\.catch\s*\([^)]*\)/g,
  /error\s*=>\s*\{[^}]*\}/g
];

let errorHandlingSections = [];
for (const pattern of errorHandlingPatterns) {
  const matches = bundle.match(pattern);
  if (matches) {
    errorHandlingSections.push(...matches.slice(0, 5));
  }
}

// Filtrer les sections intéressantes
const interestingErrorHandling = errorHandlingSections.filter(section => {
  const lower = section.toLowerCase();
  return lower.includes('401') || 
         lower.includes('403') ||
         lower.includes('429') ||
         lower.includes('status') ||
         lower.includes('response');
});

console.log(`Sections de gestion d'erreur intéressantes: ${interestingErrorHandling.length}`);
interestingErrorHandling.slice(0, 3).forEach((section, i) => {
  console.log(`\nSection ${i + 1}:`);
  console.log(section.substring(0, 150) + (section.length > 150 ? '...' : ''));
});

console.log('\n' + '='.repeat(70));
console.log('Analyse terminée.');