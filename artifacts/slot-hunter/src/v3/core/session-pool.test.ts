/**
 * Test unitaire — session-pool.ts
 * Vérifie le budget allocator sans réseau (pas de login réel).
 *
 * Usage : npx tsx src/v3/core/session-pool.test.ts
 */

import {
  canLogin,
  recordLogin,
  recordProxyDeath,
  getRemainingLogins,
  getUsedLogins,
  getProxyDeathCount,
  getBudgetSnapshot,
  isRushHour,
  updateConfig,
  _resetForTesting,
} from "./session-pool.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

section("1. Budget initial = 9 logins autorisés");
_resetForTesting();
{
  const d = canLogin("test@example.com");
  assert(d.allowed === true, "Premier login autorisé");
  assert(d.remaining === 8, "Remaining = 8 (avant consommation)");
  assert(getRemainingLogins("test@example.com") === 9, "getRemainingLogins = 9 (pas encore consommé)");
}

section("2. recordLogin incrémente le compteur");
_resetForTesting();
// Désactiver le minInterLogin pour ce test
updateConfig({ minInterLoginMs: 0 });
{
  recordLogin("test@example.com", "standard");
  assert(getUsedLogins("test@example.com") === 1, "1 login utilisé");
  assert(getRemainingLogins("test@example.com") === 8, "8 restants");

  recordLogin("test@example.com", "rush");
  assert(getUsedLogins("test@example.com") === 2, "2 logins utilisés");
  assert(getRemainingLogins("test@example.com") === 7, "7 restants");
}

section("3. Bloque au 10ème login (cap = 9)");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  // Consommer 9 logins
  for (let i = 0; i < 9; i++) {
    const d = canLogin("cap@test.com");
    assert(d.allowed === true, `Login #${i + 1} autorisé`);
    recordLogin("cap@test.com", d.phase);
  }

  // Le 10ème doit être refusé
  const d10 = canLogin("cap@test.com");
  assert(d10.allowed === false, "Login #10 REFUSÉ (cap atteint)");
  assert(d10.reason!.includes("épuisé"), `Raison contient 'épuisé': "${d10.reason}"`);
  assert(d10.waitMs > 0, `waitMs > 0 (${d10.waitMs}ms)`);
}

section("4. Intervalle minimum 10 min entre logins");
_resetForTesting();
// Garder le minInterLoginMs par défaut (10 min)
updateConfig({ minInterLoginMs: 10 * 60_000 });
{
  recordLogin("interval@test.com", "standard");
  
  // Deuxième login immédiat → refusé
  const d = canLogin("interval@test.com");
  assert(d.allowed === false, "Login immédiat refusé (intervalle 10 min)");
  assert(d.reason!.includes("Intervalle"), `Raison: "${d.reason}"`);
  assert(d.waitMs > 0 && d.waitMs <= 10 * 60_000, `waitMs raisonnable (${Math.round(d.waitMs / 1000)}s)`);
}

section("5. Allocation par phase (rush=4, standard=3, emergency=2)");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  // Consommer les 3 logins standard
  for (let i = 0; i < 3; i++) {
    recordLogin("phase@test.com", "standard");
  }
  
  // Le 4ème en standard devrait fallback sur emergency ou rush (emprunt)
  const d = canLogin("phase@test.com");
  assert(d.allowed === true, "4ème login autorisé (emprunt cross-phase)");
  // La phase devrait être "emergency" ou "rush" (emprunt)
  assert(d.phase === "emergency" || d.phase === "rush", `Phase empruntée: ${d.phase}`);
}

section("6. recordProxyDeath ne consomme PAS de login");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  recordProxyDeath("proxy@test.com");
  recordProxyDeath("proxy@test.com");
  recordProxyDeath("proxy@test.com");
  
  assert(getUsedLogins("proxy@test.com") === 0, "0 logins consommés malgré 3 proxy deaths");
  assert(getProxyDeathCount("proxy@test.com") === 3, "3 proxy deaths enregistrés");
  assert(getRemainingLogins("proxy@test.com") === 9, "Budget intact (9 restants)");
}

section("7. Comptes indépendants (pas de partage de budget)");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  for (let i = 0; i < 5; i++) {
    recordLogin("alice@test.com", "standard");
  }
  
  const dAlice = canLogin("alice@test.com");
  const dBob = canLogin("bob@test.com");
  
  assert(getRemainingLogins("alice@test.com") === 4, "Alice: 4 restants");
  assert(getRemainingLogins("bob@test.com") === 9, "Bob: 9 restants (indépendant)");
  assert(dAlice.allowed === true, "Alice peut encore login");
  assert(dBob.allowed === true, "Bob peut login (budget plein)");
}

section("8. getBudgetSnapshot retourne les bonnes valeurs");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  recordLogin("snap@test.com", "rush");
  recordLogin("snap@test.com", "rush");
  recordLogin("snap@test.com", "standard");
  recordProxyDeath("snap@test.com");
  
  const snap = getBudgetSnapshot("snap@test.com");
  assert(snap.totalUsed === 3, `totalUsed = 3 (got ${snap.totalUsed})`);
  assert(snap.remaining === 6, `remaining = 6 (got ${snap.remaining})`);
  assert(snap.usedByPhase.rush === 2, `rush = 2 (got ${snap.usedByPhase.rush})`);
  assert(snap.usedByPhase.standard === 1, `standard = 1 (got ${snap.usedByPhase.standard})`);
  assert(snap.proxyDeaths === 1, `proxyDeaths = 1 (got ${snap.proxyDeaths})`);
  assert(snap.maxPerDay === 9, `maxPerDay = 9 (got ${snap.maxPerDay})`);
}

section("9. Case-insensitive (même budget pour EMAIL et email)");
_resetForTesting();
updateConfig({ minInterLoginMs: 0 });
{
  recordLogin("MixedCase@Test.COM", "standard");
  assert(getUsedLogins("mixedcase@test.com") === 1, "Case-insensitive: 1 login");
  assert(getUsedLogins("MIXEDCASE@TEST.COM") === 1, "Case-insensitive: uppercase aussi");
}

// ─── Résultat final ─────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(` RÉSULTAT: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);

if (failed > 0) {
  process.exit(1);
}
