import * as dotenv from "dotenv";
dotenv.config();

import { solveCloudflareFree, cleanupCloudflareFree } from "./src/free-cloudflare-solver.js";

const SPAIN_PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

async function captureCookieManual() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  CAPTURE DE COOKIE CLOUDFLARE - MODE SEMI-AUTOMATIQUE         ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  console.log("Ce script va:");
  console.log("1. Ouvrir un navigateur avec techniques stealth");
  console.log("2. Naviguer vers le portail Espagne");
  console.log("3. Attendre que vous résolviez le captcha manuellement");
  console.log("4. Capturer automatiquement les cookies après résolution");
  console.log("5. Sauvegarder les cookies pour réutilisation future\n");

  console.log("⚠️  IMPORTANT: Vous devrez cocher la case 'I'm human' manuellement\n");

  const startTime = Date.now();

  try {
    const result = await solveCloudflareFree({
      portalUrl: SPAIN_PORTAL_URL,
      domain: 'citaconsular.es',
      useStealth: true,
      useCookies: true,
      headless: false,
      waitForManualCaptcha: true,
      manualCaptchaTimeout: 180000, // 3 minutes
    });

    if (result.success && result.page && result.context && result.browser) {
      const timeMs = Date.now() - startTime;
      console.log(`\n✅ SUCCÈS en ${(timeMs / 1000).toFixed(1)}s`);
      console.log("Cookie capturé et sauvegardé!\n");
      console.log("Le cookie peut maintenant être utilisé automatiquement par:");
      console.log("- npm run cloudflare:free-solver");
      console.log("- Le slot-hunter Espagne\n");

      // Attendre un peu pour visualiser
      console.log("Appuyez sur Entrée pour fermer le navigateur...");
      await new Promise(resolve => {
        process.stdin.once('data', resolve);
      });

      // Nettoyer
      await cleanupCloudflareFree(result.browser, result.context, result.page);
      
      console.log("✅ Capture terminée avec succès");
      process.exit(0);
    } else {
      const timeMs = Date.now() - startTime;
      console.log(`\n❌ ÉCHEC après ${(timeMs / 1000).toFixed(1)}s`);
      console.log(`Erreur: ${result.error}\n`);
      console.log("Conseils:");
      console.log("- Assurez-vous d'avoir coché la case 'I'm human'");
      console.log("- Vérifiez que vous avez une connexion internet stable");
      console.log("- Réessayez si nécessaire\n");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ ERREUR:", error);
    process.exit(1);
  }
}

captureCookieManual();
