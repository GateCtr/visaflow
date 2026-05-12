// Test de la fonction isRestrictedBody
function isRestrictedBody(body) {
  const lower = body.toLowerCase();
  return lower.includes("temporarily") || lower.includes("restricted") ||
    lower.includes("access denied") || lower.includes("account locked") ||
    lower.includes("too many") || lower.includes("rate limit");
}

// Scénarios de test
const testCases = [
  {
    name: "Message de suspension temporaire typique",
    body: '{"error": "Your account has been temporarily restricted. Please try again later."}',
    expected: true
  },
  {
    name: "Access denied",
    body: 'Access denied: Too many login attempts',
    expected: true
  },
  {
    name: "Account locked",
    body: 'Your account is locked due to suspicious activity',
    expected: true
  },
  {
    name: "Rate limit",
    body: 'Rate limit exceeded. Please wait before trying again',
    expected: true
  },
  {
    name: "Too many requests",
    body: 'Too many requests from this IP',
    expected: true
  },
  {
    name: "Token expiré (ne devrait pas être détecté comme restriction)",
    body: '{"error": "Token expired"}',
    expected: false
  },
  {
    name: "Invalid credentials",
    body: 'Invalid username or password',
    expected: false
  },
  {
    name: "Maintenance message",
    body: 'This application is currently undergoing updates and is temporarily unavailable. Please check back later',
    expected: true // "temporarily" devrait déclencher
  },
  {
    name: "Message mixte",
    body: 'Your access has been temporarily restricted due to too many failed attempts',
    expected: true
  }
];

console.log('Test de la fonction isRestrictedBody:');
console.log('='.repeat(60));

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = isRestrictedBody(testCase.body);
  const status = result === testCase.expected ? '✓' : '✗';
  
  if (result === testCase.expected) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${status} ${testCase.name}`);
  console.log(`  Body: ${testCase.body.substring(0, 80)}...`);
  console.log(`  Expected: ${testCase.expected}, Got: ${result}`);
  console.log('');
}

console.log('='.repeat(60));
console.log(`Résumé: ${passed} passés, ${failed} échoués`);

// Analyser le bundle pour trouver des messages d'erreur réels
console.log('\n\nAnalyse des messages d\'erreur potentiels dans le bundle:');
console.log('='.repeat(60));

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

try {
  const bundlePath = path.join(__dirname, 'bundle-analysis', 'bundle.js');
  const bundle = fs.readFileSync(bundlePath, 'utf8');
  
  // Chercher des messages d'erreur dans des structures JSON
  const errorRegex = /"error"\s*:\s*"([^"]+)"/gi;
  const msgRegex = /"msg"\s*:\s*"([^"]+)"/gi;
  const messageRegex = /"message"\s*:\s*"([^"]+)"/gi;
  
  const allMatches = [];
  let match;
  
  while ((match = errorRegex.exec(bundle)) !== null) {
    allMatches.push({ type: 'error', value: match[1] });
  }
  
  while ((match = msgRegex.exec(bundle)) !== null) {
    allMatches.push({ type: 'msg', value: match[1] });
  }
  
  while ((match = messageRegex.exec(bundle)) !== null) {
    allMatches.push({ type: 'message', value: match[1] });
  }
  
  // Filtrer les messages intéressants
  const interestingMessages = allMatches.filter(m => 
    isRestrictedBody(m.value) ||
    m.value.toLowerCase().includes('account') ||
    m.value.toLowerCase().includes('access') ||
    m.value.toLowerCase().includes('limit') ||
    m.value.toLowerCase().includes('try again') ||
    m.value.toLowerCase().includes('suspended') ||
    m.value.toLowerCase().includes('blocked')
  );
  
  console.log(`Messages d'erreur intéressants trouvés: ${interestingMessages.length}`);
  
  // Afficher les messages uniques
  const uniqueMessages = [...new Set(interestingMessages.map(m => m.value))];
  uniqueMessages.slice(0, 20).forEach((msg, i) => {
    console.log(`${i + 1}. "${msg}"`);
    console.log(`   Détecté comme restriction: ${isRestrictedBody(msg)}`);
  });
  
} catch (error) {
  console.log('Erreur lors de la lecture du bundle:', error.message);
}