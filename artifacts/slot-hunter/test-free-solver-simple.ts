import * as dotenv from "dotenv";
dotenv.config();

import { bypassCloudflareFree, cleanupCloudflareFree } from "./src/free-cloudflare-solver.js";

const SPAIN_PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

async function testFreeSolver() {
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  TEST DU SOLVEUR GRATUIT CLOUDFLARE                           ║");
  console.log("╚════════════════════════════════════════════════════════════════╝\n");

  const startTime = Date.now();

  try {
    console.log("Tentative de bypass Cloudflare avec solution gratuite...");
    const result = await bypassCloudflareFree(SPAIN_PORTAL_URL, 'citaconsular.es');

    if (result.success && result.page && result.context && result.browser) {
      const timeMs = Date.now() - startTime;
      console.log(`\n✅ SUCCÈS en ${(timeMs / 1000).toFixed(1)}s`);
      console.log("Page accessible, Cloudflare contourné!\n");

      // Attendre un peu pour visualiser
      console.log("Appuyez sur Entrée pour fermer le navigateur...");
      await new Promise(resolve => {
        process.stdin.once('data', resolve);
      });

      // Nettoyer
      await cleanupCloudflareFree(result.browser, result.context, result.page);
      
      console.log("✅ Test terminé avec succès");
      process.exit(0);
    } else {
      const timeMs = Date.now() - startTime;
      console.log(`\n❌ ÉCHEC après ${(timeMs / 1000).toFixed(1)}s`);
      console.log("La solution gratuite n'a pas fonctionné.\n");
      process.exit(1);
    }
  } catch (error) {
    console.error("\n❌ ERREUR:", error);
    process.exit(1);
  }
}

testFreeSolver();
