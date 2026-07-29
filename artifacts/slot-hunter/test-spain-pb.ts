/**
 * Test rapide de ensureSpainPersistentBrowserSession()
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-pb.ts
 *
 * Watchdog 90s : si la fonction ne répond pas, on tue le process pour ne pas
 * gaspiller les tokens proxy/CapSolver sur une attente infinie.
 */
import "dotenv/config";
import { ensureSpainPersistentBrowserSession, spainPersistentBrowser } from "./src/spain-persistent-browser.js";

const TARGET_URL =
  process.env.TEST_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

// ── Watchdog : tue le process après 90s quoi qu'il arrive ─────────────────────
const WATCHDOG_MS = 150_000;
const watchdog = setTimeout(() => {
  console.error(`\n⏱️ WATCHDOG ${WATCHDOG_MS / 1000}s dépassé — arrêt forcé (tokens proxy préservés)`);
  process.exit(4);
}, WATCHDOG_MS);
watchdog.unref(); // ne bloque pas la sortie normale

console.log("=".repeat(60));
console.log("TEST ensureSpainPersistentBrowserSession");
console.log(`  CAPSOLVER_API_KEY : ${process.env.CAPSOLVER_API_KEY ? "✅" : "❌ manquant"}`);
console.log(`  DECODO_PROXY_URL  : ${process.env.DECODO_PROXY_URL ? "✅" : "❌ manquant"}`);
console.log(`  CHROMIUM_PATH     : ${process.env.CHROMIUM_EXECUTABLE_PATH ?? "(auto Puppeteer)"}`);
console.log(`  Target URL        : ${TARGET_URL}`);
console.log(`  Watchdog          : ${WATCHDOG_MS / 1000}s`);
console.log("=".repeat(60));

const t0 = Date.now();
try {
  const session = await ensureSpainPersistentBrowserSession(TARGET_URL);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  // Fermer le browser dès qu'on a le résultat (libère les ressources + tokens proxy)
  try {
    await (spainPersistentBrowser as any)._browser?.close();
  } catch { /* non-fatal */ }
  clearTimeout(watchdog);

  if (!session) {
    console.error(`\n❌ ÉCHEC — ensureSession() a retourné null (${elapsed}s)`);
    process.exit(1);
  }

  const prefetch: string = (session as any).prefetchedMainHtml ?? "";
  const ok = prefetch.length > 100;

  console.log("\n" + "=".repeat(60));
  console.log(ok ? `✅ SESSION OK (${elapsed}s)` : `⚠️  SESSION PARTIELLE — /main/ vide (${elapsed}s)`);
  console.log(`   cf_clearance   : ${session.cfClearance.slice(0, 50)}…`);
  console.log(`   UA             : ${session.userAgent.slice(0, 80)}`);
  console.log(`   cookies        : ${session.allCookies.length} (${session.allCookies.map((c) => c.name).join(", ")})`);
  console.log(`   PHPSESSID      : ${session.allCookies.find((c) => c.name === "PHPSESSID")?.value.slice(0, 16) ?? "❌ absent"}`);
  console.log(`   prefetchedMain : ${ok ? `✅ ${prefetch.length}B` : "❌ vide (0B) — CF soft-block ou boot PHP incomplet"}`);
  if (ok) {
    console.log(`   snippet        : ${prefetch.slice(0, 200).replace(/\n/g, " ")}`);
  }
  console.log(`   expire         : ${new Date(session.expiresAt).toISOString()}`);
  console.log("=".repeat(60));

  process.exit(ok ? 0 : 2);
} catch (err) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  // Fermer le browser même en cas d'exception
  try { await (spainPersistentBrowser as any)._browser?.close(); } catch { /* non-fatal */ }
  clearTimeout(watchdog);
  console.error(`\n❌ EXCEPTION (${elapsed}s):`, err);
  process.exit(1);
}
