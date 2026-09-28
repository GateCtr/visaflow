/**
 * E2E Saopolo du scout dédié, via la boucle de production runScout().
 * Une seule itération : solve/cache CF → GET widget → datetime/ → publication éventuelle.
 * Le module scout ne contient aucun appel signin/ ou summary/; aucun booking possible.
 *
 * Usage depuis la racine :
 *   pnpm --filter @workspace/slot-hunter exec tsx src/scripts/test-spain-scout-saopolo.ts
 */

import "dotenv/config";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { getDecodoPoolSize, initDecodoPool } from "../spain-decodo-pool.js";
import { SAOPOLO_PORTAL_URL } from "../spain-portals.js";

async function main(): Promise<void> {
  // Forcer Redis local pour isoler le snapshot de test des données de production.
  process.env.REDIS_HOST = "127.0.0.1";
  process.env.REDIS_PORT = process.env.SPAIN_TEST_REDIS_PORT ?? "6379";
  process.env.REDIS_USERNAME = "default";
  delete process.env.REDIS_URL;
  delete process.env.REDIS_PASSWORD;

  // Ces valeurs sont lues au chargement du module scout : les définir avant l'import dynamique.
  process.env.SPAIN_SCOUT_POOL = "1";
  process.env.SPAIN_SCOUT_COUNT = "1";
  process.env.SPAIN_SCOUT_PORTAL_URL = SAOPOLO_PORTAL_URL.split("#")[0];

  console.log(`[scout-test] Portail Saopolo : ${process.env.SPAIN_SCOUT_PORTAL_URL}`);
  console.log("[scout-test] Une seule itération du scout de production; aucun signin/ ni booking.");

  const redisReady = await initSpainRedis();
  if (!redisReady) throw new Error("Redis local indisponible; arrêt avant le test live.");

  await initDecodoPool();
  const poolSize = getDecodoPoolSize();
  if (poolSize === 0) throw new Error("Pool Decodo vide; arrêt avant le test live.");
  console.log(`[scout-test] Redis local prêt; pool proxy initialisé (${poolSize} entrées).`);

  const { runScoutOnceForTest } = await import("../spain-scout.js");
  const startedAt = Date.now();
  await runScoutOnceForTest(0);
  console.log(`[scout-test] Itération scout terminée en ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);
}

function exitAfterFlush(code: number): void {
  // initSpainRedis garde la connexion Redis ouverte; terminer le CLI après vidage des logs.
  process.stdout.write("", () => process.exit(code));
}

main()
  .then(() => exitAfterFlush(0))
  .catch((error) => {
    console.error("[scout-test] ÉCHEC :", error instanceof Error ? error.message : String(error));
    exitAfterFlush(1);
  });