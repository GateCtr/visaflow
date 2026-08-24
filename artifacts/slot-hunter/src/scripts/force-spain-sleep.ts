/**
 * force-spain-sleep.ts — Pose manuellement le flag Redis spain:slots_found_today
 * avec un TTL qui expire à 22:05 UTC.
 *
 * Usage : npx tsx src/scripts/force-spain-sleep.ts
 *
 * Effet : l'orchestrateur Spain V2 ne lance plus de workers jusqu'à 22:05 UTC.
 * Les workers en cours finissent naturellement.
 */

import { initSpainRedis, setSlotFoundToday, getSecondsUntil2205UTC } from "../spain-redis-persistence.js";

async function main(): Promise<void> {
  const ttl = getSecondsUntil2205UTC();
  if (ttl <= 0) {
    console.log("⚠️  Il est déjà >= 22:05 UTC — le sommeil prolongé ne s'applique pas.");
    console.log("    Le flag sera posé avec un TTL court (5 min) pour le cycle courant.");
  } else {
    const hours = Math.floor(ttl / 3600);
    const mins = Math.round((ttl % 3600) / 60);
    console.log(`🌙 Forçage du sommeil Spain — TTL = ${hours}h${mins}min (expire à 22:05 UTC)`);
  }

  const ok = await initSpainRedis();
  if (!ok) {
    console.error("❌ Redis indisponible — impossible de poser le flag");
    process.exit(1);
  }

  await setSlotFoundToday();
  console.log("✅ Flag spain:slots_found_today posé dans Redis");
  console.log("   → L'orchestrateur V2 ne lancera plus de workers Spain jusqu'à expiration");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur:", err);
  process.exit(1);
});
