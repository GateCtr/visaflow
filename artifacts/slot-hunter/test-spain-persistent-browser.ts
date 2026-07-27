/**
 * test-spain-persistent-browser.ts — Test standalone du mode persistent-browser
 *
 * Usage :
 *   DECODO_PROXY_URL=http://user:pass@host:port tsx test-spain-persistent-browser.ts
 *
 * Sans proxy Decodo, le test tourne en accès direct (CF peut bloquer).
 *
 * Étapes testées :
 *   1. ensureSpainPersistentBrowserSession() — solve CF via Chromium persistant
 *   2. getActiveSpainPersistentBrowserSession() — cache mémoire (doit être immédiat)
 *   3. createSpainPersistentBrowserDossierSession() — PHPSESSID isolé via incognito
 *   4. Fermeture propre
 */

import * as dotenv from "dotenv";
dotenv.config();
if (process.env.DECODO_PROXY_URL) {
  console.log("[test] DECODO_PROXY_URL détecté ✅");
} else {
  console.warn("[test] ⚠️  DECODO_PROXY_URL absent — accès direct (CF peut bloquer)");
}

import {
  ensureSpainPersistentBrowserSession,
  isSpainPersistentBrowserSessionExpiringSoon,
  getActiveSpainPersistentBrowserSession,
  createSpainPersistentBrowserDossierSession,
  spainPersistentBrowser,
} from "./src/spain-persistent-browser.js";

const TARGET_URL = "https://www.citaconsular.es/es/hosteds/widgetdef498.html";
// URL portail réel (extraite du watcher Convex — on peut la laisser vide pour tester)
const PORTAL_URL = process.env.SPAIN_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdef498.html";

async function run() {
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  Test spain-persistent-browser");
  console.log("══════════════════════════════════════════════════════\n");

  // ─── Étape 1 : solve CF ────────────────────────────────────────────────────
  console.log("─── Étape 1 : ensureSpainPersistentBrowserSession() ───");
  const t0 = Date.now();
  const session = await ensureSpainPersistentBrowserSession(TARGET_URL);

  if (!session) {
    console.error("❌ ÉCHEC : session null — cf_clearance non obtenu");
    process.exit(1);
  }

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`✅ Session CF obtenue en ${elapsed}s`);
  console.log(`   source        : ${session.source}`);
  console.log(`   userAgent     : ${session.userAgent.slice(0, 80)}`);
  console.log(`   cf_clearance  : ${session.cfClearance.slice(0, 50)}…`);
  console.log(`   cookies total : ${session.allCookies.length}`);
  console.log(`   cookie names  : ${session.allCookies.map(c => c.name).join(", ")}`);
  console.log(`   expire dans   : ~${Math.round((session.expiresAt - Date.now()) / 60_000)}min`);
  console.log(`   proxy URL     : ${session.soaxProxyUrl ? session.soaxProxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "(aucun)"}`);

  // ─── Étape 2 : cache mémoire ───────────────────────────────────────────────
  console.log("\n─── Étape 2 : getActiveSpainPersistentBrowserSession() ───");
  const t1 = Date.now();
  const cached = getActiveSpainPersistentBrowserSession();

  if (!cached) {
    console.error("❌ ÉCHEC : cache vide après solve — bug dans isSessionValid()");
    process.exit(1);
  }
  const cacheMs = Date.now() - t1;
  console.log(`✅ Cache hit en ${cacheMs}ms (attendu < 5ms)`);
  console.log(`   isExpiringSoon : ${isSpainPersistentBrowserSessionExpiringSoon()}`);

  // ─── Étape 2b : réutilisation (doit être < 100ms) ─────────────────────────
  console.log("\n─── Étape 2b : ensureSpainPersistentBrowserSession() (réutilisation) ───");
  const t2 = Date.now();
  const reused = await ensureSpainPersistentBrowserSession(TARGET_URL);
  const reuseMs = Date.now() - t2;

  if (!reused || reused.createdAt !== session.createdAt) {
    console.warn("⚠️  Session réutilisée mais createdAt différent — nouveau solve inattendu");
  } else {
    console.log(`✅ Session réutilisée depuis le cache en ${reuseMs}ms`);
  }

  // ─── Étape 3 : PHPSESSID isolé ────────────────────────────────────────────
  console.log("\n─── Étape 3 : createSpainPersistentBrowserDossierSession() ───");
  const t3 = Date.now();
  const dossierSession = await createSpainPersistentBrowserDossierSession(session, PORTAL_URL);

  if (!dossierSession) {
    console.warn("⚠️  Dossier session null — /main/ n'a pas retourné de PHPSESSID");
    console.warn("    (normal si portalUrl générique ou si CF bloque /onlinebookings/main/)");
  } else {
    const d3 = Math.round((Date.now() - t3) / 1000);
    const phpSessId = dossierSession.allCookies.find(c => c.name === "PHPSESSID");
    console.log(`✅ Session dossier obtenue en ${d3}s`);
    console.log(`   PHPSESSID  : ${phpSessId ? phpSessId.value.slice(0, 20) + "…" : "ABSENT ❌"}`);
    console.log(`   cookies    : ${dossierSession.allCookies.map(c => c.name).join(", ")}`);

    // Vérifier que le PHPSESSID de la session parente n'a pas été modifié
    const parentPhp = session.allCookies.find(c => c.name === "PHPSESSID");
    if (phpSessId && parentPhp && phpSessId.value === parentPhp.value) {
      console.warn("⚠️  PHPSESSID identique à la session parente — isolation non garantie");
    } else if (phpSessId && (!parentPhp || phpSessId.value !== parentPhp.value)) {
      console.log("   isolation  : ✅ PHPSESSID distinct de la session parente");
    }
  }

  // ─── Résumé final ─────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════");
  console.log("  Résultat : ✅ SUCCÈS");
  console.log(`  Durée totale : ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("══════════════════════════════════════════════════════\n");

  await spainPersistentBrowser.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Exception inattendue :", err);
  process.exit(1);
});
