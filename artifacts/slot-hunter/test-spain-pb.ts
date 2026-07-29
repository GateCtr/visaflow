/**
 * Test rapide de ensureSpainPersistentBrowserSession()
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-pb.ts
 */
import "dotenv/config";
import { ensureSpainPersistentBrowserSession } from "./src/spain-persistent-browser.js";

const TARGET_URL =
  process.env.TEST_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

console.log("=".repeat(60));
console.log("TEST ensureSpainPersistentBrowserSession");
console.log(`  CAPSOLVER_API_KEY : ${process.env.CAPSOLVER_API_KEY ? "✅" : "❌ manquant"}`);
console.log(`  DECODO_PROXY_URL  : ${process.env.DECODO_PROXY_URL ? "✅" : "❌ manquant"}`);
console.log(`  CHROMIUM_PATH     : ${process.env.CHROMIUM_EXECUTABLE_PATH ?? "(auto Puppeteer)"}`);
console.log(`  Target URL        : ${TARGET_URL}`);
console.log("=".repeat(60));

const t0 = Date.now();
try {
  const session = await ensureSpainPersistentBrowserSession(TARGET_URL);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!session) {
    console.error(`\n❌ ÉCHEC — ensureSession() a retourné null (${elapsed}s)`);
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`✅ SESSION OK (${elapsed}s)`);
  console.log(`   cf_clearance   : ${session.cfClearance.slice(0, 50)}…`);
  console.log(`   UA             : ${session.userAgent.slice(0, 80)}`);
  console.log(`   cookies        : ${session.allCookies.length} (${session.allCookies.map((c) => c.name).join(", ")})`);
  console.log(`   PHPSESSID      : ${session.allCookies.find((c) => c.name === "PHPSESSID")?.value.slice(0, 16) ?? "❌ absent"}`);
  console.log(`   prefetchedMain : ${(session as any).prefetchedMainHtml ? `✅ ${(session as any).prefetchedMainHtml.length}B` : "❌ vide (0B)"}`);
  if ((session as any).prefetchedMainHtml) {
    const snippet = (session as any).prefetchedMainHtml.slice(0, 200).replace(/\n/g, " ");
    console.log(`   snippet        : ${snippet}`);
  }
  console.log(`   expire         : ${new Date(session.expiresAt).toISOString()}`);
  console.log("=".repeat(60));

  const ok = (session as any).prefetchedMainHtml?.length > 100;
  process.exit(ok ? 0 : 2);
} catch (err) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.error(`\n❌ EXCEPTION (${elapsed}s):`, err);
  process.exit(1);
}
