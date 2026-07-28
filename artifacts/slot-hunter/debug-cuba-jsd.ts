/**
 * debug-cuba-jsd.ts — Analyse jsd/main.js pour extraire l'URL oneshot
 *
 * Objectif : comprendre comment CF génère l'URL jsd/oneshot à partir de
 * window.__CF$cv$params={r:'...', t:'...'} et construire l'appel correct.
 */

import fs from "fs";
import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
} from "./src/spain-soax-solver.js";

const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const PORTAL_URL = `https://www.citaconsular.es/es/hosteds/widgetdefault/${PUBLICKEY}/`;
const OUT = "/tmp/cuba-jsd/";
fs.mkdirSync(OUT, { recursive: true });

// ─── CF session ───────────────────────────────────────────────────────────────
invalidateSpainCfSession();
console.log("─── 0. CF session ───");
const session = await ensureSpainCfSession(PORTAL_URL);
if (!session) { console.error("❌ CF session failed"); process.exit(1); }
console.log(`✅ cf_clearance: ${session.cfClearance.slice(0, 40)}…`);

const cookies: Record<string, string> = {};
for (const c of session.allCookies ?? []) cookies[c.name] = c.value;

function mergeCookies(raw: string | null) {
  if (!raw) return;
  for (const part of raw.split(",")) {
    const eq = part.trim().split(";")[0];
    const idx = eq.indexOf("=");
    if (idx < 0) continue;
    cookies[eq.slice(0, idx).trim()] = eq.slice(idx + 1).trim();
  }
}
function ck() {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

const htmlHdrs = {
  Cookie: ck(),
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
  "Priority": "u=0, i",
};

// ─── 1. GET portal ────────────────────────────────────────────────────────────
console.log("\n─── 1. GET portal ───");
const r1 = await spainCfFetch(PORTAL_URL, session, { headers: htmlHdrs });
const h1 = await r1.text();
mergeCookies(r1.headers.get("set-cookie"));
console.log(`   HTTP ${r1.status} | bytes: ${h1.length}`);

const token = h1.match(/name="token"\s+value="([^"]+)"/)?.[1]
  ?? h1.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i)?.[1]
  ?? "";
console.log(`   token: ${token.slice(0, 30)} (len=${token.length})`);

// ─── 2. POST Continue ─────────────────────────────────────────────────────────
console.log("\n─── 2. POST Continue ───");
const r2 = await spainCfFetch(PORTAL_URL, session, {
  method: "POST",
  headers: {
    ...htmlHdrs,
    Cookie: ck(),
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://www.citaconsular.es",
    Referer: PORTAL_URL,
    "Sec-Fetch-User": "?1",
  },
  body: `token=${encodeURIComponent(token)}`,
});
const h2 = await r2.text();
mergeCookies(r2.headers.get("set-cookie"));
console.log(`   HTTP ${r2.status} | bytes: ${h2.length}`);
fs.writeFileSync(`${OUT}widget-post.html`, h2);

// Extract CF params from jsd iframe
const cfParams = h2.match(/window\.__CF\$cv\$params\s*=\s*\{r:'([^']+)',t:'([^']+)'\}/);
const cfR = cfParams?.[1] ?? "";
const cfT = cfParams?.[2] ?? "";
console.log(`   CF params: r='${cfR}' t='${cfT}'`);

const beaconToken = h2.match(/data-cf-beacon='[^']*"token":"([^"]+)"[^']*'/)?.[1] ?? "";
console.log(`   Beacon token: ${beaconToken}`);

// Check for pre-embedded oneshot URL  
const oneshotDirect = h2.match(/\/cdn-cgi\/challenge-platform\/h\/b\/jsd\/oneshot\/[a-f0-9]{10,14}\/[^'"<\s]{10,}\/[a-f0-9]{14,18}/);
console.log(`   Direct oneshot URL: ${oneshotDirect?.[0] ?? "NONE"}`);

// ─── 3. Fetch jsd/main.js ─────────────────────────────────────────────────────
console.log("\n─── 3. GET /cdn-cgi/challenge-platform/scripts/jsd/main.js ───");
const jsdUrl = `https://www.citaconsular.es/cdn-cgi/challenge-platform/scripts/jsd/main.js`;
const r3 = await spainCfFetch(jsdUrl, session, {
  headers: {
    Cookie: ck(),
    Accept: "*/*",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: PORTAL_URL,
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  },
});
const jsdJs = await r3.text();
console.log(`   HTTP ${r3.status} | bytes: ${jsdJs.length}`);
fs.writeFileSync(`${OUT}jsd-main.js`, jsdJs);

// Look for oneshot URL patterns in the script
const oneshotInJs = [...jsdJs.matchAll(/['"](\/cdn-cgi\/[^'"]+oneshot[^'"]+)['"]/g)];
console.log(`   Oneshot URLs in script: ${oneshotInJs.length}`);
for (const m of oneshotInJs.slice(0, 5)) console.log(`     ${m[1]}`);

// Look for siteKey (hex string 10-14 chars)
const siteKeys = [...jsdJs.matchAll(/['"\/]([a-f0-9]{10,14})['"\/]/g)].map(m => m[1]);
const uniqSiteKeys = [...new Set(siteKeys)];
console.log(`   Possible siteKeys (10-14 hex): ${uniqSiteKeys.slice(0, 10).join(", ")}`);

// Look for the b/ path segment
const bPaths = [...jsdJs.matchAll(/['"](\/cdn-cgi\/challenge-platform\/h\/b\/[^'"]{5,})['"]/g)];
console.log(`   h/b/ paths: ${bPaths.length}`);
for (const m of bPaths.slice(0, 5)) console.log(`     ${m[1]}`);

// Generic URL patterns
const urlPatterns = [...jsdJs.matchAll(/['"](\/cdn-cgi\/[^'"]{20,})['"]/g)];
console.log(`   All /cdn-cgi/ URLs: ${urlPatterns.length}`);
for (const m of urlPatterns.slice(0, 10)) console.log(`     ${m[1]}`);

// ─── 4. Try to construct oneshot URL from known parts ─────────────────────────
// Pattern: /cdn-cgi/challenge-platform/h/b/jsd/oneshot/<siteKey>/<nonce>/<rayId>
// rayId = r param = cfR
console.log("\n─── 4. Attempt oneshot construction ───");
console.log(`   cfR (rayId): ${cfR}`);
console.log(`   cfT (token): ${cfT} → decoded: ${Buffer.from(cfT, "base64").toString()}`);
console.log(`   beaconToken: ${beaconToken}`);

// The siteKey is typically the first segment in the oneshot URL (10-14 hex chars)
// Try with the beacon token prefix (first 12 chars)
const beaconPrefix = beaconToken.slice(0, 12);
console.log(`   Beacon prefix 12: ${beaconPrefix}`);

// ─── 5. Fire RUM beacon (critical, t+3ms after main/) ────────────────────────
// This is separate from JSD — test to see if it affects session validity
console.log("\n─── 5. Fire CF RUM beacon ───");
const rumUrl = `https://www.citaconsular.es/cdn-cgi/rum?`;
const rumBody = JSON.stringify({
  resources: [{
    type: "navigation",
    name: PORTAL_URL,
    startTime: 0,
    duration: 1500 + Math.floor(Math.random() * 500),
    transferSize: h2.length,
    responseStart: 200,
    domContentLoadedEventEnd: 800,
    loadEventEnd: 1200,
  }],
  version: "2024.11.0",
  token: beaconToken,
});
const rumRes = await spainCfFetch(rumUrl, session, {
  method: "POST",
  headers: {
    Cookie: ck(),
    "Content-Type": "application/json",
    Accept: "*/*",
    Referer: PORTAL_URL,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  },
  body: rumBody,
}).catch(() => null);
console.log(`   RUM HTTP ${rumRes?.status ?? "failed"}`);

// ─── 6. GET /main/ direct (avec headers corrects) ─────────────────────────────
console.log("\n─── 6. GET /main/ (headers corrects JSONP) ───");
const tNow = Date.now();
const cbName = `jQuery${tNow}`;
const mainQ = new URLSearchParams({
  callback: cbName, type: "default", publickey: PUBLICKEY,
  lang: "es", version: "4", src: PORTAL_URL, _: String(tNow),
});
const mainRes = await spainCfFetch(
  `https://www.citaconsular.es/onlinebookings/main/?${mainQ}`,
  session,
  {
    headers: {
      Cookie: ck(),
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Referer: PORTAL_URL,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Priority: "u=1, i",
    },
  },
);
const mainBody = await mainRes.text();
mergeCookies(mainRes.headers.get("set-cookie"));
console.log(`   HTTP ${mainRes.status} | bytes: ${mainBody.length}`);
if (mainBody.length > 0) {
  console.log(`   snippet: ${mainBody.slice(0, 200)}`);
  fs.writeFileSync(`${OUT}main.jsonp`, mainBody);
} else {
  console.log(`   ❌ empty body — JSD non résolu`);
}

console.log(`\n══ Files: ${OUT} ══`);
