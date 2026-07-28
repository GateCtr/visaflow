/**
 * Test du mode persistent-browser : alert dismiss + clic Continuar + #services
 */
import { ensureSpainPersistentBrowserSession } from "./src/spain-persistent-browser.js";

// Pointer Puppeteer vers le Chromium téléchargé par Playwright
process.env.PUPPETEER_EXECUTABLE_PATH =
  "/home/runner/workspace/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

console.log("[test-pb] Lancement ensureSpainPersistentBrowserSession…");
const t0 = Date.now();

const session = await ensureSpainPersistentBrowserSession(PORTAL_URL);

const elapsed = Math.round((Date.now() - t0) / 1000);
if (!session) {
  console.error(`[test-pb] ❌ Session null après ${elapsed}s`);
  process.exit(1);
}

console.log(`[test-pb] ✅ Session obtenue en ${elapsed}s`);
console.log(`[test-pb]    cf_clearance: ${session.cfClearance.slice(0, 50)}…`);
console.log(`[test-pb]    source: ${session.source}`);
console.log(`[test-pb]    cookies (${session.allCookies.length}): ${session.allCookies.map((c: { name: string }) => c.name).join(", ")}`);
console.log(`[test-pb]    PHPSESSID: ${session.allCookies.find((c: { name: string }) => c.name === "PHPSESSID")?.value?.slice(0, 16) ?? "ABSENT"}`);

// Maintenant tester un scan HTTP avec cette session
console.log("\n[test-pb] → Lancement scanSpainHttp avec la session persistent-browser…");
const { scanSpainHttp } = await import("./src/spain-http-scanner.js");
const result = await scanSpainHttp(PORTAL_URL);
const r = result as any;
console.log(`[test-pb] Résultat scan: status=${result.status}`, r.slotInfo ?? r.errorMessage?.slice(0, 200) ?? "");
