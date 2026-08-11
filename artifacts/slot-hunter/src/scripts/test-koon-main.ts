/**
 * test-koon-main.ts — Test koon (TLS fingerprint library) for /main/ endpoint
 * Uses Chrome profile matching CapSolver's output to align JA3/JA4 fingerprints.
 *
 * USAGE: npx tsx src/scripts/test-koon-main.ts
 */
import "dotenv/config";
import koonjs from "koonjs";
const { Koon } = koonjs as any;
import { solveSpainCloudflare } from "../spain-soax-solver.js";

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

async function main(): Promise<void> {
  const proxy = process.env.SPAIN_ISP_PROXY_URL ?? process.env.DECODO_PROXY_URL;
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!proxy || !capKey) { console.error("Missing SPAIN_ISP_PROXY_URL or CAPSOLVER_API_KEY"); process.exit(1); }

  console.log("═".repeat(60));
  console.log("  TEST KOON + CapSolver → /main/");
  console.log("═".repeat(60));
  console.log(`Proxy: ${proxy.replace(/:([^@:]+)@/, ":***@").slice(0, 60)}`);

  // 1. Solve CF
  console.log("\n[1] Solving CF via CapSolver...");
  const solve = await solveSpainCloudflare(PORTAL_URL, capKey, proxy);
  if (!solve.success || !solve.session) { console.error("CF solve failed:", solve.error); process.exit(1); }
  const { cfClearance, userAgent } = solve.session;
  const chromeVer = userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "135";
  console.log(`    CF OK! Chrome/${chromeVer}`);
  console.log(`    cf_clearance: ${cfClearance.slice(0, 30)}…`);

  // 2. Create koon client with matching Chrome profile
  const profile = `chrome${chromeVer}-windows`;
  console.log(`\n[2] Koon client — profile: ${profile}`);
  const client = new Koon({ browser: profile, proxy });

  // 3. GET portal
  console.log("\n[3] GET portal...");
  const r1 = await client.get(PORTAL_URL, {
    headers: { "Cookie": `cf_clearance=${cfClearance}`, "User-Agent": userAgent },
  });
  const html = r1.text();
  console.log(`    → ${r1.status} | ${html.length}B`);

  if (html.includes("Just a moment") || r1.status === 403) {
    console.error("    CF still blocking!");
    process.exit(1);
  }

  // Extract token + PHPSESSID
  const tokenMatch = html.match(/name=["']token["']\s+value=["']([^"']+)/i);
  if (!tokenMatch) { console.error("    No token found!"); process.exit(1); }
  const token = tokenMatch[1];
  console.log(`    Token: ${token.slice(0, 20)}…`);

  const setCookie = r1.header("set-cookie") ?? "";
  const phpMatch = setCookie.match(/PHPSESSID=([^;]+)/);
  const phpSessId = phpMatch?.[1] ?? "";
  const cookies = `PHPSESSID=${phpSessId}; cf_clearance=${cfClearance}`;
  console.log(`    PHPSESSID: ${phpSessId.slice(0, 12)}…`);

  // 4. POST token (Continuar)
  console.log("\n[4] POST token (Continuar)...");
  const r2 = await client.post(PORTAL_URL, `token=${encodeURIComponent(token)}`, {
    headers: {
      "Cookie": cookies,
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": "https://www.citaconsular.es",
      "Referer": PORTAL_URL,
      "Cache-Control": "max-age=0",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      "User-Agent": userAgent,
    },
  });
  const postBody = r2.text();
  console.log(`    → ${r2.status} | ${postBody.length}B`);

  // 5. GET /main/ JSONP
  const ts = Date.now();
  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQuery21104230673043030936_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts + 1}`;

  console.log("\n[5] GET /main/ JSONP...");
  const r3 = await client.get(mainUrl, {
    headers: {
      "Cookie": cookies,
      "User-Agent": userAgent,
      "Accept": "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": PORTAL_URL,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });
  const mainBody = r3.text();
  console.log(`    → ${r3.status} | ${mainBody.length}B`);

  if (mainBody.length > 1000) {
    console.log(`\n    🎉🎉🎉 SUCCESS! /main/ returned ${mainBody.length} bytes with KOON!`);
    console.log(`    Aceptar: ${/aceptar/i.test(mainBody) ? "YES ✅" : "NO"}`);
  } else if (mainBody.length === 0) {
    console.log("    ❌ 0B — same issue as Impit");
  } else {
    console.log(`    Body: ${mainBody.slice(0, 200)}`);
  }

  console.log("\n" + "═".repeat(60));
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
