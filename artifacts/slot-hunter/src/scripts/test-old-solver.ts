/**
 * Test du solver capsolver-residential (ancien système) sur Saopolo.
 * Lance ensureSpainCfSession avec SPAIN_SESSION_MODE=capsolver-residential
 * et vérifie si la session contient un PHPSESSID.
 */
import "dotenv/config";
import { initDecodoPool } from "../spain-decodo-pool.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { ensureSpainCfSession } from "../spain-soax-solver.js";

process.env.SPAIN_SESSION_MODE = "capsolver-residential";
const SAOPOLO = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
process.env.SPAIN_WIDGET_URL = SAOPOLO;

async function main() {
  console.log("=== TEST SOLVER ANCIEN SYSTÈME (capsolver-residential) ===");
  console.log(`Portal : ${SAOPOLO}`);
  console.log(`Mode   : ${process.env.SPAIN_SESSION_MODE}`);

  await initSpainRedis();
  await initDecodoPool();

  console.log("\n→ Appel ensureSpainCfSession...");
  const t0 = Date.now();
  const session = await ensureSpainCfSession(SAOPOLO);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  if (!session) {
    console.error(`\n❌ Session nulle après ${elapsed}s — le solver ancien échoue aussi`);
    process.exit(1);
  }

  const php = session.allCookies.find(c => c.name === "PHPSESSID");
  const cf  = session.allCookies.find(c => c.name === "cf_clearance");
  console.log(`\n=== RÉSULTAT (${elapsed}s) ===`);
  console.log(`cf_clearance : ${cf  ? cf.value.slice(0, 40)  + "…" : "❌ absent"}`);
  console.log(`PHPSESSID    : ${php ? php.value.slice(0, 25) + "…" : "❌ absent"}`);
  console.log(`soaxProxyUrl : ${session.soaxProxyUrl?.replace(/:([^@:]+)@/, ":***@") ?? "(direct)"}`);
  console.log(`userAgent    : ${session.userAgent?.slice(0, 60)}`);
  console.log(`bookititState: ${session.bookititState ? JSON.stringify({
    srvsrc: session.bookititState.srvsrc,
    version: session.bookititState.version,
    publickey: session.bookititState.publickey?.slice(0, 12) + "…",
  }) : "❌ absent"}`);
  console.log(`prefetchedMainHtml: ${session.prefetchedMainHtml ? session.prefetchedMainHtml.length + "B" : "absent"}`);

  if (php) {
    console.log("\n🎉 PHPSESSID présent → solver opérationnel avec le pool CSV Decodo");
  } else {
    console.log("\n⚠️  PHPSESSID absent → le solver ancien NE passe pas non plus le CF HTML via Decodo CSV");
  }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
