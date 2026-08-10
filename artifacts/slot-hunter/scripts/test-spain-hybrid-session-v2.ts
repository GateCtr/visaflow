/**
 * test-spain-hybrid-session-v2.ts — Test e2e SpainHybridSession
 * 
 * Valide l'architecture hybride complète :
 *   Phase 1 : CF solve + Continuar (Puppeteer natif)
 *   Phase 2 : page.evaluate(fetch) pour tous les appels Bookitit
 * 
 * Usage : npx tsx scripts/test-spain-hybrid-session-v2.ts
 */

import { SpainHybridSession, resolveSpainProxy } from "../src/spain/spain-hybrid-session.js";

const KINSHASA_PORTAL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const KINSHASA_KEY    = "2d01502f12dc08400e22aea87fb00ae34";

async function main() {
  const proxy = resolveSpainProxy();
  console.log("\n" + "═".repeat(70));
  console.log("  TEST SpainHybridSession v2 — page.evaluate(fetch)");
  console.log("═".repeat(70));
  console.log(`  Portail : Kinshasa (RDC)`);
  console.log(`  Proxy   : ${proxy.replace(/:([^:@]+)@/, ":***@").replace(/\/\/[^:]+:/, "//***:")}`);
  console.log("═".repeat(70) + "\n");

  const t0 = Date.now();
  let session: SpainHybridSession | null = null;

  try {
    // ── Phase 1 : Bootstrap ────────────────────────────────────────────────────
    console.log("▶ Phase 1 — CF solve + Continuar…");
    session = await SpainHybridSession.create({
      portalUrl:  KINSHASA_PORTAL,
      widgetKey:  KINSHASA_KEY,
      headless:   true,
    });

    const phase1Ms = Date.now() - t0;
    console.log(`✅ Session créée en ${Math.round(phase1Ms / 1000)}s`);
    console.log(`   /main/ prefetch: ${session.prefetchedMainHtml.length}B`);

    // ── Phase 2 : page.evaluate(fetch) ────────────────────────────────────────
    console.log("\n▶ Phase 2 — Appels Bookitit via page.evaluate(fetch)…");

    // Test 1 : /main/ scan
    console.log("\n  [1/4] /main/ scan…");
    const t1 = Date.now();
    const scanResult = await session.scanMain();
    console.log(`        → ${scanResult.status} | ${scanResult.bodyLength}B | ${scanResult.durationMs}ms`);
    if (scanResult.bodyLength > 100) {
      console.log(`        → hasSlots: ${scanResult.hasSlots}`);
      console.log(`        → preview: ${scanResult.body.slice(0, 120)}`);
      console.log("        ✅ /main/ OK");
    } else {
      console.log("        ❌ /main/ vide !");
    }

    // Test 2 : getwidgetconfigurations/
    console.log("\n  [2/4] getwidgetconfigurations/…");
    const t2 = Date.now();
    const widgetCfg = await session.getWidgetConfig();
    const ms2 = Date.now() - t2;
    if (widgetCfg) {
      console.log(`        → ${ms2}ms | captcha: ${widgetCfg.captcha} | template: ${widgetCfg.template}`);
      console.log("        ✅ getwidgetconfigurations/ OK");
    } else {
      console.log(`        ❌ getwidgetconfigurations/ vide ! (${ms2}ms)`);
    }

    // Test 3 : getservices/
    console.log("\n  [3/4] getservices/…");
    const t3 = Date.now();
    const services = await session.getServices();
    const ms3 = Date.now() - t3;
    if (services.length > 0) {
      console.log(`        → ${ms3}ms | ${services.length} service(s)`);
      for (const s of services) console.log(`           • ${s.id} : "${s.name}"`);
      console.log("        ✅ getservices/ OK");
    } else {
      console.log(`        ❌ getservices/ vide ! (${ms3}ms)`);
    }

    // Test 4 : getagendas/ (si service trouvé)
    if (services.length > 0) {
      console.log(`\n  [4/4] getagendas/ (service ${services[0].id})…`);
      const t4 = Date.now();
      const agendas = await session.getAgendas(services[0].id);
      const ms4 = Date.now() - t4;
      if (agendas.length > 0) {
        console.log(`        → ${ms4}ms | ${agendas.length} agenda(s)`);
        for (const a of agendas.slice(0, 3)) console.log(`           • ${a.id} : "${a.name}"`);
        console.log("        ✅ getagendas/ OK");
      } else {
        console.log(`        ⚠️  getagendas/ vide (0 agendas) — ${ms4}ms`);
      }
    } else {
      console.log("\n  [4/4] getagendas/ — skipped (pas de service)");
    }

    // ── Test de scan continu (3 itérations) ───────────────────────────────────
    console.log("\n▶ Test scan continu (3 itérations, intervalle 3s)…");
    for (let i = 1; i <= 3; i++) {
      await new Promise(r => setTimeout(r, 3_000));
      const res = await session.scanMain();
      const mark = res.bodyLength > 100 ? "✅" : "❌";
      console.log(`  Scan #${i} → ${mark} ${res.bodyLength}B | ${res.durationMs}ms | slots: ${res.hasSlots}`);
    }

    // ── Résumé ────────────────────────────────────────────────────────────────
    const totalMs = Date.now() - t0;
    console.log("\n" + "═".repeat(70));
    console.log("  RÉSUMÉ");
    console.log("═".repeat(70));
    console.log(`  Durée totale     : ${Math.round(totalMs / 1000)}s`);
    console.log(`  /main/ scan      : ${scanResult.bodyLength > 100 ? "✅ OK" : "❌ FAIL"}`);
    console.log(`  getwidget/       : ${widgetCfg ? "✅ OK" : "❌ FAIL"}`);
    console.log(`  getservices/     : ${services.length > 0 ? "✅ OK" : "❌ FAIL"}`);
    console.log(`  Session valide   : ~${Math.round(session.aliveMs / 1000)}s / 6900s`);
    console.log("═".repeat(70) + "\n");

  } catch (e: any) {
    console.error("\n❌ Erreur fatale:", e.message);
    console.error(e.stack?.split("\n").slice(0, 8).join("\n"));
  } finally {
    if (session) {
      console.log("🔒 Fermeture browser…");
      await session.close();
    }
  }
}

main();
