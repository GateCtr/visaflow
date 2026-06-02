#!/usr/bin/env tsx

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { makeCevProxyStickyUrl } from "./src/cev-shared-impit.js";
import * as fs from "fs";

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..", "..");
const envPath = path.join(rootDir, ".env.local");
console.log("[TEST] Loading env from:", envPath);
dotenv.config({ path: envPath });

const OUTPUT_DIR = path.join(__dirname, "captured", "session-worker");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const timestamp = Date.now();
const cookiesOutputPath = path.join(OUTPUT_DIR, `cookies-${timestamp}.json`);
const logOutputPath = path.join(OUTPUT_DIR, `log-${timestamp}.txt`);

const VOWINT_URL = "https://visaonweb.diplomatie.be";

let PROXY_URL = process.env.SOAX_PROXY_URL
  ? makeCevProxyStickyUrl("soax", undefined, "test-local")
  : process.env.IPROYAL_PROXY_URL
  ? process.env.IPROYAL_PROXY_URL
  : process.env.PROXY_URL ?? "";

const logLines: string[] = [];

function log(message: string) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${message}`;
  console.log(line);
  logLines.push(line);
}

function saveLog() {
  fs.writeFileSync(logOutputPath, logLines.join("\n"), "utf-8");
  console.log(`\n💾 Log saved to: ${logOutputPath}`);
}

async function saveCookies(page: any) {
  const cookies = await page.cookies();
  fs.writeFileSync(cookiesOutputPath, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(`💾 Cookies saved to: ${cookiesOutputPath}`);
}

async function main() {
  log("═══════════════════════════════════════════════════════════════");
  log("  INTERACTIVE F5 COOKIE MONITOR");
  log("═══════════════════════════════════════════════════════════════");
  log("\nInstructions:");
  log("1. Navigate manually in the opened browser");
  log("2. Login to VOWINT if needed");
  log("3. Click 'Prendre rendez-vous' / 'Obtenir un rendez-vous'");
  log("4. Watch the console for cookie changes (especially TS01...)");
  log("5. Press Ctrl+C in the terminal when you're done\n");

  const launchArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
  ];

  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      launchArgs.push(`--proxy-server=${parsed.hostname}:${parsed.port}`);
      log(`Proxy configured: ${parsed.hostname}:${parsed.port}`);
    } catch {
      log(`Invalid proxy URL — direct connection`);
    }
  }

  const browser = await puppeteer.launch({
    headless: false, // Visible browser for manual navigation
    args: launchArgs,
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();

  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      if (parsed.username) {
        log(`Setting proxy auth`);
        await page.authenticate({
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        });
      }
    } catch {}
  }

  let lastCookieNames = new Set<string>();

  // Function to log cookie changes
  async function logCookieChanges(trigger: string) {
    const cookies = await page.cookies();
    const currentCookieNames = new Set(cookies.map(c => c.name));
    
    // Find new cookies
    const newCookies = cookies.filter(c => !lastCookieNames.has(c.name));
    if (newCookies.length > 0) {
      log(`\n🍪 NEW COOKIES (trigger: ${trigger}):`);
      newCookies.forEach(c => {
        const preview = c.value.length > 60 ? c.value.slice(0, 60) + "…" : c.value;
        log(`   • [${c.domain}] ${c.name} = ${preview}`);
        if (c.name.startsWith("TS")) {
          log(`   ⚠️  TS COOKIE DETECTED!`);
        }
      });
    }

    // Find removed cookies
    const removedCookies = [...lastCookieNames].filter(n => !currentCookieNames.has(n));
    if (removedCookies.length > 0) {
      log(`\n❌ REMOVED COOKIES (trigger: ${trigger}):`);
      removedCookies.forEach(n => log(`   • ${n}`));
    }

    lastCookieNames = currentCookieNames;
  }

  // Monitor navigation
  page.on("framenavigated", async (frame) => {
    if (frame === page.mainFrame()) {
      log(`\n🌐 NAVIGATED TO: ${frame.url()}`);
      await logCookieChanges("navigation");
      await saveCookies(page);
      saveLog();
    }
  });

  // Monitor responses (for Set-Cookie headers)
  page.on("response", async (response) => {
    const url = response.url();
    const setCookieHeaders = response.headers()["set-cookie"];
    if (setCookieHeaders) {
      log(`\n📩 RESPONSE with Set-Cookie: ${url.slice(0, 80)}…`);
      log("   Set-Cookie headers:");
      (Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders]).forEach(h => {
        log(`      ${h.slice(0, 100)}…`);
      });
      await logCookieChanges("Set-Cookie header");
      await saveCookies(page);
      saveLog();
    }
  });

  // Log cookies every 5 seconds
  setInterval(async () => {
    await logCookieChanges("5-second check");
    await saveCookies(page);
    saveLog();
  }, 5000);

  // Start on VOWINT
  log(`\nOpening VOWINT: ${VOWINT_URL}`);
  await page.goto(VOWINT_URL, { waitUntil: "networkidle2" });
  await logCookieChanges("initial page load");
  await saveCookies(page);
  saveLog();

  // Keep browser open until user closes it manually or Ctrl+C
  await new Promise<void>((resolve) => {
    browser.on("disconnected", async () => {
      log("\nBrowser closed!");
      await saveCookies(page);
      saveLog();
      resolve();
    });
    process.on("SIGINT", async () => {
      log("\nCtrl+C received — closing browser...");
      
      // Log final cookies
      const finalCookies = await page.cookies();
      log("\n═══════════════════════════════════════════════════════════════");
      log("  FINAL COOKIES CAPTURED");
      log("═══════════════════════════════════════════════════════════════");
      finalCookies.forEach(c => {
        const preview = c.value.length > 80 ? c.value.slice(0, 80) + "…" : c.value;
        log(`  • [${c.domain}] ${c.name} = ${preview}`);
      });
      
      await saveCookies(page);
      saveLog();
      await browser.close();
      resolve();
    });
  });

  log("\nDone!");
}

main().catch(err => {
  console.error("\n❌ Fatal error:", err);
  process.exit(1);
});
