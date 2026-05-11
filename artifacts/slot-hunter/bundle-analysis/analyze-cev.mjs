import { readFileSync } from 'fs';
const b = readFileSync('bundle-analysis/cev-bundle.js', 'utf8');

// Extract all URL-like paths
const paths = new Set();
const re = /["'](\/[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*[^"']*?)["']/g;
let m;
while ((m = re.exec(b)) !== null) {
  if (!m[1].includes('//') && !m[1].includes('.js') && !m[1].includes('.css')) {
    paths.add(m[1]);
  }
}
console.log("=== ENDPOINTS/PATHS ===");
[...paths].sort().forEach(x => console.log("  " + x));

// Extract all named functions
console.log("\n=== FONCTIONS NOMMÉES ===");
const fns = b.match(/function\s+([a-zA-Z_]\w+)\s*\(/g) || [];
[...new Set(fns)].sort().forEach(x => console.log("  " + x));

// Search for booking/confirm/submit related code
console.log("\n=== CONTEXTE BOOKING ===");
const bookingTerms = ['book', 'confirm', 'submit', 'reserve', 'appointment', 'slot'];
for (const term of bookingTerms) {
  const idx = b.toLowerCase().indexOf(term);
  if (idx !== -1) {
    const ctx = b.slice(Math.max(0, idx - 50), idx + 200);
    console.log(`\n--- "${term}" (pos ${idx}) ---`);
    console.log(ctx.replace(/\n/g, ' ').slice(0, 300));
  }
}
