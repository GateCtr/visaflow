/**
 * test-jsd-then-main.ts — CapSolver CF solve → JSD oneshot → POST token → /main/
 * 
 * Flow complet :
 * 1. CapSolver résout Managed Challenge → cf_clearance
 * 2. GET portail (avec cf_clearance) → page avec JSD + token
 * 3. Extraire et soumettre JSD oneshot
 * 4. POST token (Continuar)  
 * 5. GET /main/ → 128KB
 */
import "dotenv/config";
import { solveSpainCloudflare } from "../spain-soax-solver.js";
import { JSDSolver } from "../jsd-solver.js";

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

async function main(): Promise<void> {
  const proxy = process.env.SPAIN_ISP_PROXY_URL;
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!proxy || !capKey) { console.error("Missing env vars"); process.exit(1); }

  console.log("═".repeat(60));
  console.log("  TEST CapSolver → JSD Oneshot → /main/");
  console.log("═".repeat(60));
  console.log(`Proxy: ${proxy.replace(/:([^@:]+)@/, ":***@").slice(0, 60)}`);

  // 1. CapSolver solve CF Managed Challenge
  console.log("\n[1] CapSolver AntiCloudflareTask...");
  const solve = await solveSpainCloudflare(PORTAL_URL, capKey, proxy);
  if (!solve.success || !solve.session) {
    console.error("CapSolver FAILED:", solve.error);
    process.exit(1);
  }
  const { cfClearance, userAgent } = solve.session;
  console.log(`  CF OK! cf_clearance: ${cfClearance.slice(0, 25)}…`);

  // 2. JSD Solver with pre-existing cf_clearance
  console.log("\n[2] JSD Solver (with cf_clearance from CapSolver)...");
  const jsdSolver = new JSDSolver(PORTAL_URL, userAgent, proxy);
  
  // Fetch portal with cf_clearance to get the JSD challenge page
  const impit = jsdSolver.impit;
  const r1 = await impit.fetch(PORTAL_URL, {
    method: "GET",
    headers: { "User-Agent": userAgent, "Cookie": `cf_clearance=${cfClearance}` },
  } as any) as unknown as Response;
  const html = await r1.text();
  console.log(`  GET portal: ${r1.status} | ${html.length}B`);

  // Check if JSD params are in the page
  const hasJSD = html.includes("__CF$cv$params") || html.includes("jsd/oneshot");
  const hasCfChlOpt = html.includes("_cf_chl_opt");
  console.log(`  __CF$cv$params: ${hasJSD}`);
  console.log(`  _cf_chl_opt: ${hasCfChlOpt}`);

  // Extract PHPSESSID
  const sc = r1.headers.get("set-cookie") ?? "";
  const pm = sc.match(/PHPSESSID=([^;]+)/);
  const phpSessId = pm?.[1] ?? "";
  const cookies = `PHPSESSID=${phpSessId}; cf_clearance=${cfClearance}`;
  console.log(`  PHPSESSID: ${phpSessId.slice(0, 12)}…`);

  // Try solving JSD from the prefetched HTML
  if (hasJSD || hasCfChlOpt) {
    console.log("  → JSD challenge detected, solving...");
    const jsdResult = await jsdSolver.solve(30000, html);
    if (jsdResult.success && jsdResult.session) {
      console.log(`  JSD OK! New cf_clearance: ${jsdResult.session.cfClearance.slice(0, 25)}…`);
      const jsdImpit = jsdResult.session.impit;
      // Use PHPSESSID from step 2 + cf_clearance from CAPSOLVER (not JSD!)
      // The JSD oneshot sets an internal CF state but the real clearance is still the CapSolver one
      const finalCookies = `PHPSESSID=${phpSessId}; cf_clearance=${cfClearance}`;
      console.log(`  Final cookies (CapSolver clearance): PHPSESSID=${phpSessId.slice(0,10)}… + cf_clearance=${cfClearance.slice(0,15)}…`);

      // Use token from step 2 (still valid — same PHPSESSID)
      const tokenMatch = html.match(/name=["']token["']\s+value=["']([^"']+)/i);
      if (!tokenMatch) { console.error("No token from step 2!"); process.exit(1); }
      const token = tokenMatch[1];
      console.log(`  Token (from step 2): ${token.slice(0, 20)}…`);

      // POST token (Continuar)
      console.log("\n[3] POST token (Continuar)...");
      const r2 = await jsdImpit.fetch(PORTAL_URL, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": finalCookies,
          "Origin": "https://www.citaconsular.es",
          "Referer": PORTAL_URL,
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
        },
        body: `token=${encodeURIComponent(token)}`,
      } as any) as unknown as Response;
      const postBody = await r2.text();
      console.log(`  → ${r2.status} | ${postBody.length}B`);
      console.log(`  POST body FULL:\n${postBody}`);
      const hasWidget = postBody.includes("bkt_init_widget") || postBody.includes("loadermaec");
      console.log(`  Widget loaded: ${hasWidget}`);

      // GET /main/
      // First check if POST response has a JSD challenge — solve it before /main/
      if (postBody.includes("__CF$cv$params")) {
        console.log("\n[3b] POST response has JSD #2 — solving...");
        const jsd2 = new JSDSolver(PORTAL_URL, userAgent, proxy);
        const jsd2Result = await jsd2.solve(30000, postBody);
        if (jsd2Result.success && jsd2Result.session) {
          console.log(`  JSD #2 OK! cf_clearance: ${jsd2Result.session.cfClearance.slice(0, 25)}…`);
          // Now use JSD#2's cf_clearance for /main/
          const finalCookies2 = `PHPSESSID=${phpSessId}; cf_clearance=${jsd2Result.session.cfClearance}`;
          
          const ts = Date.now();
          const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQ_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts + 1}`;
          console.log("\n[4] GET /main/ (after JSD #2)...");
          const r3 = await jsd2Result.session.impit.fetch(mainUrl, {
            method: "GET",
            headers: {
              "User-Agent": userAgent,
              "Cookie": finalCookies2,
              "Accept": "text/javascript, application/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
              "Referer": PORTAL_URL,
            },
          } as any) as unknown as Response;
          const mainBody = await r3.text();
          console.log(`  → ${r3.status} | ${mainBody.length}B`);
          if (mainBody.length > 1000) {
            console.log(`\n  🎉🎉🎉 /main/ → ${mainBody.length}B !`);
            console.log(`  Aceptar: ${/aceptar/i.test(mainBody) ? "YES ✅" : "NO"}`);
          } else {
            console.log(`  Body: ${mainBody.slice(0, 200)}`);
          }
        } else {
          console.error("  JSD #2 FAILED:", jsd2Result.error);
        }
      } else {
        // No JSD in POST response — call /main/ directly
        const ts = Date.now();
        const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQ_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts + 1}`;
        console.log("\n[4] GET /main/ (no JSD #2)...");
        const r3 = await jsdImpit.fetch(mainUrl, {
          method: "GET",
          headers: {
            "User-Agent": userAgent,
            "Cookie": finalCookies,
            "Accept": "text/javascript, application/javascript, */*; q=0.01",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": PORTAL_URL,
          },
        } as any) as unknown as Response;
        const mainBody = await r3.text();
        console.log(`  → ${r3.status} | ${mainBody.length}B`);
        if (mainBody.length > 1000) {
          console.log(`\n  🎉🎉🎉 /main/ → ${mainBody.length}B !`);
          console.log(`  Aceptar: ${/aceptar/i.test(mainBody) ? "YES ✅" : "NO"}`);
        } else {
          console.log(`  Body: ${mainBody.slice(0, 200)}`);
        }
      }
    } else {
      console.error("  JSD FAILED:", jsdResult.error);
    }
  } else {
    // No JSD — try directly with POST token then /main/
    console.log("  → No JSD detected, trying direct POST + /main/...");
    const tokenMatch = html.match(/name=["']token["']\s+value=["']([^"']+)/i);
    if (tokenMatch) {
      const token = tokenMatch[1];
      console.log(`  Token: ${token.slice(0, 20)}…`);
      
      // POST token
      console.log("\n[3] POST token...");
      const r2 = await impit.fetch(PORTAL_URL, {
        method: "POST",
        headers: {
          "User-Agent": userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookies,
          "Origin": "https://www.citaconsular.es",
          "Referer": PORTAL_URL,
        },
        body: `token=${encodeURIComponent(token)}`,
      } as any) as unknown as Response;
      console.log(`  → ${r2.status} | ${(await r2.text()).length}B`);
      
      // /main/
      const ts = Date.now();
      const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?callback=jQ_${ts}&type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts + 1}`;
      console.log("\n[4] GET /main/ (no JSD)...");
      const r3 = await impit.fetch(mainUrl, {
        method: "GET",
        headers: { "User-Agent": userAgent, "Cookie": cookies, "X-Requested-With": "XMLHttpRequest", "Referer": PORTAL_URL },
      } as any) as unknown as Response;
      const mb = await r3.text();
      console.log(`  → ${r3.status} | ${mb.length}B`);
      if (mb.length > 1000) console.log(`  🎉 SUCCESS ${mb.length}B!`);
      else console.log(`  Body: ${mb.slice(0, 200)}`);
    }
  }
  
  console.log("\n" + "═".repeat(60));
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
