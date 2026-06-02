#!/usr/bin/env tsx

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const envPath = path.join(rootDir, ".env.local");
console.log("[TEST] Loading env from:", envPath);
dotenv.config({ path: envPath });

import { makeCevProxyStickyUrl } from "./src/cev-shared-impit.js";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const CEV_URL = "https://appointment.cloud.diplomatie.be/Captcha";
const VOWINT_URL = "https://visaonweb.diplomatie.be";
let PROXY_URL = process.env.SOAX_PROXY_URL
  ? makeCevProxyStickyUrl("soax", undefined, "test-local")
  : process.env.IPROYAL_PROXY_URL
  ? process.env.IPROYAL_PROXY_URL
  : process.env.PROXY_URL ?? "";

console.log("[TEST] Proxy URL:", PROXY_URL.replace(/:([^:@]+)@/, ":***@"));

async function main() {
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
      console.log("[TEST] Proxy configured:", parsed.hostname, parsed.port);
    } catch {
      console.log("[TEST] Invalid proxy URL — direct connection");
    }
  }

  const browser = await puppeteer.launch({
    headless: false, // Let's show the browser for debugging!
    args: launchArgs,
  });

  const page = await browser.newPage();

  if (PROXY_URL) {
    try {
      const parsed = new URL(PROXY_URL.startsWith("http") ? PROXY_URL : `http://${PROXY_URL}`);
      if (parsed.username) {
        console.log("[TEST] Setting proxy auth");
        await page.authenticate({
          username: decodeURIComponent(parsed.username),
          password: decodeURIComponent(parsed.password),
        });
      }
    } catch {}
  }

  const userAgent = await browser.userAgent();
  console.log("[TEST] User-Agent:", userAgent);

  console.log("[TEST] Navigating to VOWINT:", VOWINT_URL);
  await page.goto(VOWINT_URL, { waitUntil: "networkidle2", timeout: 60000 });
  
  const waitVowintSec = 15 + Math.random() * 5;
  console.log("[TEST] Waiting", waitVowintSec.toFixed(1), "seconds on VOWINT for F5 cookie...");
  await new Promise((r) => setTimeout(r, waitVowintSec * 1000));

  console.log("[TEST] Now navigating to CEV Captcha:", CEV_URL);
  await page.goto(CEV_URL, { waitUntil: "networkidle2", timeout: 60000 });

  const waitSec = 10 + Math.random() * 5;
  console.log("[TEST] Waiting", waitSec.toFixed(1), "seconds on CEV...");
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  const cookies = await page.cookies();
  console.log(`\n[TEST] ${cookies.length} cookie(s) captured!`);

  console.log("\n[TEST] All cookies:");
  cookies.forEach((c) => {
    console.log(`  - ${c.name}=${c.value}`);
  });

  const f5Cookie = cookies.find((c) => c.name.startsWith("TS"));
  const aspNetCookie = cookies.find((c) => c.name === "ASP.NET_SessionId");

  console.log("\n[TEST] F5 cookie found:", !!f5Cookie);
  console.log("[TEST] ASP.NET_SessionId found:", !!aspNetCookie);

  if (f5Cookie) {
    console.log(`[TEST] F5 cookie: ${f5Cookie.name}=${f5Cookie.value.slice(0, 30)}...`);
  }

  console.log("\n[TEST] Press Enter to close browser...");
  await new Promise((r) => process.stdin.once("data", r));

  await browser.close();
}

main().catch((err) => {
  console.error("[TEST] Error:", err);
  process.exit(1);
});
