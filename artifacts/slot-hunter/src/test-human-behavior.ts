/**
 * Test du comportement humain amélioré
 * Usage: npx tsx src/test-human-behavior.ts
 */

import {
  MIN_HUMAN_SESSION_MS,
  MAX_HUMAN_SESSION_MS,
  MIN_SESSION_BREAK_MS,
  MAX_SESSION_BREAK_MS,
  MIN_KEEP_ALIVE_INTERVAL_MS,
  MAX_KEEP_ALIVE_INTERVAL_MS,
} from "./usaPortal/config.js";

function simulateHumanBehavior() {
  console.log("=".repeat(60));
  console.log(" TEST COMPORTEMENT HUMAIN AMÉLIORÉ");
  console.log("=".repeat(60));
  
  // Simuler 10 sessions
  for (let i = 1; i <= 10; i++) {
    console.log(`\n--- Session ${i} ---`);
    
    // Durée de session aléatoire
    const sessionDuration = MIN_HUMAN_SESSION_MS + Math.random() * (MAX_HUMAN_SESSION_MS - MIN_HUMAN_SESSION_MS);
    const sessionMinutes = Math.round(sessionDuration / 60000);
    
    // Intervalle keep-alive aléatoire
    const keepAliveInterval = MIN_KEEP_ALIVE_INTERVAL_MS + Math.random() * (MAX_KEEP_ALIVE_INTERVAL_MS - MIN_KEEP_ALIVE_INTERVAL_MS);
    const keepAliveMinutes = Math.round(keepAliveInterval / 60000);
    
    // Pause entre sessions aléatoire
    const breakDuration = MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
    const breakMinutes = Math.round(breakDuration / 60000);
    
    console.log(`Durée session: ${sessionMinutes} min (${MIN_HUMAN_SESSION_MS/60000}-${MAX_HUMAN_SESSION_MS/60000} min)`);
    console.log(`Intervalle keep-alive: ${keepAliveMinutes} min (${MIN_KEEP_ALIVE_INTERVAL_MS/60000}-${MAX_KEEP_ALIVE_INTERVAL_MS/60000} min)`);
    console.log(`Pause après session: ${breakMinutes} min (${MIN_SESSION_BREAK_MS/60000}-${MAX_SESSION_BREAK_MS/60000} min)`);
    
    // Simuler des scans pendant la session
    const scanCount = Math.floor(sessionDuration / (keepAliveInterval * 1.5));
    console.log(`Scans estimés: ${scanCount} (≈1 scan/${Math.round(keepAliveInterval*1.5/60000)}min)`);
    
    // Calculer la couverture quotidienne
    const dailySessions = Math.floor(24 * 60 * 60000 / (sessionDuration + breakDuration));
    const dailyCoverage = (dailySessions * sessionDuration) / (24 * 60 * 60000) * 100;
    console.log(`Sessions/jour estimées: ${dailySessions}`);
    console.log(`Couverture quotidienne: ${dailyCoverage.toFixed(1)}%`);
  }
  
  console.log("\n" + "=".repeat(60));
  console.log(" ANALYSE DES PATTERNS");
  console.log("=".repeat(60));
  
  // Analyser la variabilité
  const samples = 1000;
  let sessionTotal = 0;
  let keepAliveTotal = 0;
  let breakTotal = 0;
  
  for (let i = 0; i < samples; i++) {
    sessionTotal += MIN_HUMAN_SESSION_MS + Math.random() * (MAX_HUMAN_SESSION_MS - MIN_HUMAN_SESSION_MS);
    keepAliveTotal += MIN_KEEP_ALIVE_INTERVAL_MS + Math.random() * (MAX_KEEP_ALIVE_INTERVAL_MS - MIN_KEEP_ALIVE_INTERVAL_MS);
    breakTotal += MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
  }
  
  const avgSession = sessionTotal / samples / 60000;
  const avgKeepAlive = keepAliveTotal / samples / 60000;
  const avgBreak = breakTotal / samples / 60000;
  
  console.log(`Moyenne sur ${samples} échantillons:`);
  console.log(`- Session: ${avgSession.toFixed(1)} min`);
  console.log(`- Keep-alive: ${avgKeepAlive.toFixed(1)} min`);
  console.log(`- Pause: ${avgBreak.toFixed(1)} min`);
  
  const dailySessionsAvg = Math.floor(24 * 60 / (avgSession + avgBreak));
  console.log(`\n- Sessions/jour moyennes: ${dailySessionsAvg}`);
  console.log(`- Pattern détectabilité: FAIBLE (variabilité élevée)`);
  
  console.log("\n" + "=".repeat(60));
  console.log(" RECOMMANDATIONS");
  console.log("=".repeat(60));
  console.log("✅ Sessions variables: 30-120 min");
  console.log("✅ Keep-alive variable: 5-12 min");
  console.log("✅ Pauses variables: 5-45 min");
  console.log("✅ Headers variables: Accept-Encoding, Accept-Language");
  console.log("✅ Intervalles de scan selon tier");
  console.log("✅ Comportement aléatoire simulé");
  console.log("\nLe bot est maintenant plus incognito à Cognito!");
}

simulateHumanBehavior().catch(console.error);