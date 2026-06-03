/**
 * Test de la configuration proxy CEV via botConfig
 */

import "dotenv/config";

async function testCevProxyConfig() {
  console.log("=== Test de la configuration proxy CEV ===\n");

  // Simuler la lecture de botConfig
  const mockBotConfigValue = "0"; // ou "1" pour tester
  
  console.log(`Valeur simulée de cev_use_proxy: "${mockBotConfigValue}"`);
  
  if (mockBotConfigValue === "0") {
    console.log("✅ Proxy devrait être DÉSACTIVÉ");
    console.log("  - cevImpitFetch devrait utiliser le mode direct");
    console.log("  - sessionWorker devrait utiliser le mode direct");
  } else if (mockBotConfigValue === "1") {
    console.log("✅ Proxy devrait être ACTIVÉ");
    console.log("  - cevImpitFetch devrait utiliser le proxy si configuré");
    console.log("  - sessionWorker devrait utiliser le proxy si configuré");
  } else {
    console.log("✅ Proxy par défaut (activé)");
    console.log("  - cevImpitFetch devrait utiliser le proxy si configuré");
    console.log("  - sessionWorker devrait utiliser le proxy si configuré");
  }
  
  console.log("\n=== Instructions pour tester ===");
  console.log("1. Ajouter une clé 'cev_use_proxy' dans bot-config Convex");
  console.log("2. Mettre la valeur à '0' pour désactiver le proxy");
  console.log("3. Mettre la valeur à '1' pour activer le proxy");
  console.log("4. Les changements sont effectifs immédiatement (pas besoin de redéploiement)");
  console.log("5. Le cache est rafraîchi toutes les 60 secondes");
  
  console.log("\n=== Impact sur les composants ===");
  console.log("• cevImpitFetch (HTTP setup/polling) → respecte cev_use_proxy");
  console.log("• sessionWorker (capture cookies) → respecte cev_use_proxy");
  console.log("• Toutes les boucles CEV qui utilisent ces composants");
}

testCevProxyConfig().catch(console.error);