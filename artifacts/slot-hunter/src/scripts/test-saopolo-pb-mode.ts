/**
 * test-saopolo-pb-mode.ts — Teste le mode persistent-browser (vrai Chromium) sur Sao Paulo.
 *
 * Contrairement à AntiCloudflareTask (CapSolver résout → clearance lié à SON TLS → 403),
 * ici un VRAI Chromium Puppeteer résout le challenge CF nativement ET fait les requêtes :
 * TLS + IP + exécution JS cohérents → cf_clearance accepté → PHPSESSID + /main/.
 *
 * On force SPAIN_SESSION_MODE=persistent-browser et un proxy du pool (DECODO_PROXY_URL).
 *
 * USAGE :
 *   CHROMIUM_EXECUTABLE_PATH=/opt/playwright/chromium-1232/chrome-linux64/chrome \
 *   DECODO_PROXY_URL="http://...@host:port" \
 *   npx tsx src/scripts/test-saopolo-pb-mode.ts
 */

import "dotenv/config";

process.env.SPAIN_SESSION_MODE = "persistent-browser";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

function log(msg: string): void {
  console.log(`[test-saopolo-pb] ${msg}`);
}

async function main(): Promise<void> {
  const { ensureSpainPersistentBrowserSession } =
    await import("../_legacy_spain-persistent-browser.js");

  log(`Portal   : Sao Paulo`);
  log(`Mode     : persistent-browser (vrai Chromium)`);
  log(`Chromium : ${process.env.CHROMIUM_EXECUTABLE_PATH ?? "(cache puppeteer par défaut)"}`);
  log(`Proxy    : ${process.env.DECODO_PROXY_URL ? process.env.DECODO_PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) + "…" : "⚠️ aucun (IP locale)"}`);
  log(`CapSolver: ${process.env.CAPSOLVER_API_KEY ? "✅ (dispo pour Turnstile en page)" : "❌"}`);

  const t0 = Date.now();
  log(`\n═══ ensureSpainPersistentBrowserSession ═══`);
  const session = await ensureSpainPersistentBrowserSession(SAOPOLO_URL.split("#")[0]);
  const dt = Math.round((Date.now() - t0) / 1000);

  if (!session) {
    console.error(`\n❌ Session persistent-browser échouée (${dt}s)`);
    process.exit(1);
  }

  const php = session.allCookies?.find((c) => c.name === "PHPSESSID");
  const mainLen = session.prefetchedMainHtml?.length ?? 0;
  log(`\n═══ RÉSULTAT (${dt}s) ═══`);
  log(`cf_clearance : ${session.cfClearance ? session.cfClearance.length + "B ✅" : "∅ ❌"}`);
  log(`PHPSESSID    : ${php ? "✅ " + php.value.slice(0, 12) + "…" : "❌ absent"}`);
  log(`/main/       : ${mainLen > 1000 ? mainLen + "B ✅" : mainLen + "B " + (mainLen === 0 ? "(non capturé)" : "⚠️ court")}`);
  log(`source       : ${(session as any).source ?? "?"}`);

  if (session.cfClearance && php) {
    log(`\n🎉 Le mode persistent-browser FRANCHIT le challenge CF sur ce portail.`);
  } else {
    log(`\n⚠️ Session partielle — clearance ou PHPSESSID manquant.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
