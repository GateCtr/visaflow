/**
 * Test script: Reproduces the exact Spain watcher flow to diagnose the CF session error.
 * Run with: npx tsx test-spain-probe.ts
 */
import "dotenv/config";
import { ensureSpainCfSession, getSpainImpit, spainCfFetch, type SpainCfSession } from "./src/spain-soax-solver.js";

const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5";

async function testProbe() {
  console.log("=== TEST: Spain CF Session + Probe ===\n");

  // Step 1: Get CF session — solve on the ACTUAL portal URL (not the default target)
  console.log("[1] Solving CF session on PORTAL URL...");
  const session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) {
    console.error("FAILED: Could not get CF session");
    process.exit(1);
  }
  console.log(`[1] ✅ Session obtained. Expires: ${new Date(session.expiresAt).toISOString()}`);
  console.log(`    UA: ${session.userAgent}`);
  console.log(`    cf_clearance: ${session.cfClearance.slice(0, 50)}...`);
  console.log(`    Proxy: ${session.soaxProxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70)}`);
  console.log(`    Extra headers: ${JSON.stringify(session.extraHeaders)}`);
  console.log();

  // Step 2: Test GET portal page with full headers (like the fixed scanViaMainEndpoint)
  console.log("[2] GET entry page with FULL Chrome headers...");
  const impit = getSpainImpit(session);
  const cookieParts = [`cf_clearance=${session.cfClearance}`];
  for (const c of session.allCookies) {
    if (c.name !== "cf_clearance") cookieParts.push(`${c.name}=${c.value}`);
  }

  const entryRes = await impit.fetch(PORTAL_URL, {
    headers: {
      "User-Agent": session.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cookie": cookieParts.join("; "),
      "Sec-CH-UA": '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      ...session.extraHeaders,
    },
  } as any) as any;

  console.log(`[2] Status: ${entryRes?.status}`);
  if (!entryRes || entryRes.status === 403) {
    console.error("FAILED: 403 on entry page — CF session rejected with full headers!");
    console.error("    NOTE: Check UA consistency. CapSolver returned UA with Chrome version:");
    const uaVersion = session.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "unknown";
    console.error(`    → Chrome/${uaVersion} in UA, but Sec-CH-UA says Chrome/136`);
    console.error(`    → This mismatch may be the cause!`);
    // Try to read the body for clues
    if (entryRes) {
      const body = await entryRes.text();
      console.error(`    Body (first 500): ${body.slice(0, 500)}`);
    }

    // Retry with dynamically computed Sec-CH-UA based on actual UA version
    console.log("\n[2b] RETRY with UA-derived Sec-CH-UA headers...");
    const chromeVer = session.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "136";
    const dynamicSecChUa = `"Chromium";v="${chromeVer}", "Not.A/Brand";v="99", "Google Chrome";v="${chromeVer}"`;
    console.log(`    Using Sec-CH-UA: ${dynamicSecChUa}`);

    const retryRes = await impit.fetch(PORTAL_URL, {
      headers: {
        "User-Agent": session.userAgent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Cookie": cookieParts.join("; "),
        "Sec-CH-UA": dynamicSecChUa,
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"Windows"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
        ...session.extraHeaders,
      },
    } as any) as any;
    console.log(`[2b] Status: ${retryRes?.status}`);
    if (retryRes && retryRes.status === 200) {
      console.log("    ✅ SUCCESS with dynamic Sec-CH-UA! The mismatch was the cause.");
      const retryHtml = await retryRes.text();
      console.log(`    HTML length: ${retryHtml.length}`);
      const retryToken = retryHtml.match(/name="token"\s+value="([^"]+)"/);
      console.log(`    Token: ${retryToken ? "found" : "NOT found"}`);
    } else if (retryRes) {
      const retryBody = await retryRes.text();
      console.error(`    Still failing. Body: ${retryBody.slice(0, 300)}`);
    }
    process.exit(1);
  }

  // Capture set-cookie
  const setCookies = entryRes.headers?.getSetCookie?.() ?? [];
  console.log(`    Set-Cookie count: ${setCookies.length}`);
  for (const sc of setCookies) {
    const nv = sc.split(";")[0];
    if (nv) cookieParts.push(nv);
    console.log(`    → ${nv}`);
  }

  const entryHtml = await entryRes.text();
  console.log(`    HTML length: ${entryHtml.length}`);

  // Check for CF challenge
  const isCfChallenge = /un instant|just a moment|verifying/i.test(entryHtml.slice(0, 2000));
  console.log(`    CF challenge detected: ${isCfChallenge}`);
  if (isCfChallenge) {
    console.error("FAILED: CF challenge page returned despite valid session!");
    console.error(`    Preview: ${entryHtml.slice(0, 300)}`);
    process.exit(1);
  }

  // Check for token
  const tokenMatch = entryHtml.match(/name="token"\s+value="([^"]+)"/)
    ?? entryHtml.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i);
  console.log(`    Token found: ${!!tokenMatch} ${tokenMatch ? `(${tokenMatch[1].slice(0, 20)}...)` : ""}`);
  if (!tokenMatch) {
    console.error("FAILED: No token found in entry page!");
    const title = entryHtml.match(/<title>([^<]*)<\/title>/i)?.[1];
    console.error(`    Title: ${title}`);
    console.error(`    Preview: ${entryHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)}`);
    process.exit(1);
  }
  console.log();

  // Step 3: POST Continue
  console.log("[3] POST Continue with token...");
  const postUrl = PORTAL_URL.replace(/\/?$/, "/");
  const postRes = await impit.fetch(postUrl, {
    method: "POST",
    headers: {
      "User-Agent": session.userAgent,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieParts.join("; "),
      "Origin": "https://www.citaconsular.es",
      "Referer": PORTAL_URL,
      "Sec-CH-UA": '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
      ...session.extraHeaders,
    },
    body: `token=${encodeURIComponent(tokenMatch[1])}`,
  } as any) as any;

  console.log(`[3] Status: ${postRes?.status}`);
  if (postRes) {
    const postSetCookies = postRes.headers?.getSetCookie?.() ?? [];
    for (const sc of postSetCookies) {
      const nv = sc.split(";")[0];
      if (nv) cookieParts.push(nv);
    }
  }
  console.log();

  // Step 4: GET /onlinebookings/main/
  console.log("[4] GET /onlinebookings/main/ ...");
  const cbName = `jQuery21104${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const params = new URLSearchParams({
    type: "default",
    publickey: "25028fcd7126544630b8da0c6e60722b5",
    lang: "es",
    version: "4",
    src: postUrl,
    callback: cbName,
    _: String(Date.now()),
  });

  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${params}`;
  const mainRes = await impit.fetch(mainUrl, {
    headers: {
      "User-Agent": session.userAgent,
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Cookie": cookieParts.join("; "),
      "Referer": postUrl,
      "X-Requested-With": "XMLHttpRequest",
      "Sec-CH-UA": '"Chromium";v="136", "Not.A/Brand";v="99", "Google Chrome";v="136"',
      "Sec-CH-UA-Mobile": "?0",
      "Sec-CH-UA-Platform": '"Windows"',
      "Sec-Fetch-Dest": "script",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Site": "same-origin",
      ...session.extraHeaders,
    },
  } as any) as any;

  console.log(`[4] Status: ${mainRes?.status}`);
  if (!mainRes || mainRes.status !== 200) {
    console.error(`FAILED: /onlinebookings/main/ returned ${mainRes?.status}`);
    if (mainRes) {
      const body = await mainRes.text();
      console.error(`    Body (first 500): ${body.slice(0, 500)}`);
    }
    process.exit(1);
  }

  const mainBody = await mainRes.text();
  console.log(`    Body length: ${mainBody.length}`);

  // Parse JSONP
  const jsonpMatch = mainBody.match(/^[^(]+\("(.*)"\);?$/s);
  let html: string;
  if (jsonpMatch) {
    try { html = JSON.parse(`"${jsonpMatch[1]}"`); } catch { html = mainBody; }
  } else {
    html = mainBody;
  }
  console.log(`    Parsed HTML length: ${html.length}`);

  // Check for availability signal
  const VISIBLE_NO_SLOTS = /<div\s+style='text-align:\s*center;[^']*'[^>]*>\s*No hay horas disponibles/i;
  const HIDDEN_NO_SLOTS = /<div\s+style='display:\s*none;[^']*'[^>]*>\s*No hay horas disponibles/i;
  const hasVisible = VISIBLE_NO_SLOTS.test(html);
  const hasHidden = HIDDEN_NO_SLOTS.test(html);

  console.log(`    "No hay horas" VISIBLE: ${hasVisible}`);
  console.log(`    "No hay horas" HIDDEN: ${hasHidden}`);

  if (hasVisible) {
    console.log("\n✅ RESULT: not_found (No hay horas disponibles visible → pas de créneau)");
  } else if (hasHidden && !hasVisible) {
    console.log("\n🎉 RESULT: found! (No hay horas hidden → créneaux potentiels!)");
  } else {
    console.log("\n⚠️ RESULT: unknown signal — checking secondary indicators...");
    const hasWidgetBody = /idBktWidgetDefaultBodyContainer|idDivBktServicesContainer/i.test(html);
    console.log(`    Has widget body: ${hasWidgetBody}`);
    if (!hasWidgetBody) {
      console.log(`    HTML preview: ${html.slice(0, 500)}`);
    }
  }

  console.log("\n=== TEST COMPLETE ===");
}

testProbe().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
