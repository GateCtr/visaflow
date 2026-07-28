/**
 * debug-cuba-getservices.ts
 * Diagnostic fin pour comprendre pourquoi getservices/ retourne 0B en HTTP-only
 * pour le portail Cuba (28330379fc95acafd31ee9e8938c278ff).
 *
 * Stratégie :
 *   1. Obtenir une session CF + PHPSESSID via le flow normal
 *   2. Fetcher loadermaec.js pour trouver les appels d'init cachés
 *   3. Tester getservices/ avec différents délais, headers, params
 *   4. Tester getagendas/ directement
 */

import fs from "fs";
import path from "path";
import { spainCfFetch, ensureSpainCfSession, invalidateSpainCfSession } from "./src/spain-soax-solver";
import type { SpainCfSession } from "./src/spain-soax-solver";

const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const PORTAL_URL = `https://www.citaconsular.es/es/hosteds/widgetdefault/${PUBLICKEY}/`;
const BASE = "https://www.citaconsular.es/onlinebookings/";
const OUT = "/tmp/cuba-debug/";

fs.mkdirSync(OUT, { recursive: true });

function cb(): string {
  return `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
}
function ts(): string { return String(Date.now()); }

async function cookieStr(session: SpainCfSession, phpsessid: string): Promise<string> {
  const parts: string[] = [];
  if (session.allCookies) {
    for (const c of session.allCookies) {
      if (c.name !== "PHPSESSID") parts.push(`${c.name}=${c.value}`);
    }
  }
  parts.push(`PHPSESSID=${phpsessid}`);
  return parts.join("; ");
}

// ─── Étape 0 : Session CF + PHPSESSID ─────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════════════");
console.log("  debug-cuba-getservices.ts");
console.log("══════════════════════════════════════════════════════════════════\n");

invalidateSpainCfSession();
console.log("─── 0. Obtain CF session ───");
const session = await ensureSpainCfSession(PORTAL_URL);
if (!session) { console.error("❌ CF session failed"); process.exit(1); }
console.log(`   cf_clearance: ${session.cfClearance.slice(0, 40)}…`);

// ─── Étape 1 : Portal GET → PHPSESSID ─────────────────────────────────────────
console.log("\n─── 1. GET portal → PHPSESSID ───");

// impit init
const { initSpainImpit } = await import("./src/spain-shared-impit.js");
const impit = await initSpainImpit(session);
if (!impit) { console.error("❌ impit init failed"); process.exit(1); }

const { ImpitFetchInstance } = await import("./src/spain-shared-impit.js");

// We'll track PHPSESSID via Set-Cookie
let phpsessid = "";
const cookies: Record<string, string> = {};
if (session.allCookies) {
  for (const c of session.allCookies) cookies[c.name] = c.value;
}

function mergeCookies(raw: string | null) {
  if (!raw) return;
  for (const part of raw.split(",")) {
    const eq = part.trim().split(";")[0];
    const idx = eq.indexOf("=");
    if (idx < 0) continue;
    const name = eq.slice(0, idx).trim();
    const value = eq.slice(idx + 1).trim();
    if (name) cookies[name] = value;
  }
  if (cookies["PHPSESSID"]) phpsessid = cookies["PHPSESSID"];
}

function buildCookieHeader(): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

const htmlHeaders = {
  Cookie: buildCookieHeader(),
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Referer": "https://www.citaconsular.es/",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "max-age=0",
};

const portalRes = await spainCfFetch(PORTAL_URL, session, { headers: htmlHeaders });
const portalHtml = await portalRes.text();
mergeCookies(portalRes.headers.get("set-cookie"));
console.log(`   HTTP ${portalRes.status} | bytes: ${portalHtml.length}`);
console.log(`   PHPSESSID: ${phpsessid.slice(0, 20)}…`);

// Extract token
const tokenMatch = portalHtml.match(/name="_token"\s+value="([a-f0-9]{20,})"/);
const token = tokenMatch?.[1] ?? "";
console.log(`   token: ${token.slice(0, 20)}…`);

// ─── Étape 2 : POST Continue ───────────────────────────────────────────────────
console.log("\n─── 2. POST Continue → widget HTML ───");
const body = new URLSearchParams({ _token: token });
const postRes = await spainCfFetch(PORTAL_URL, session, {
  method: "POST",
  headers: {
    ...htmlHeaders,
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: buildCookieHeader(),
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    Origin: "https://www.citaconsular.es",
  },
  body: body.toString(),
});
const widgetHtml = await postRes.text();
mergeCookies(postRes.headers.get("set-cookie"));
console.log(`   HTTP ${postRes.status} | bytes: ${widgetHtml.length}`);
fs.writeFileSync(path.join(OUT, "widget-post.html"), widgetHtml);

// Extract JSD params from iframe variant
const cfParamsMatch = widgetHtml.match(/window\.__CF\$cv\$params\s*=\s*\{r:'([^']+)',t:'([^']+)'\}/);
console.log(`   JSD iframe params: ${cfParamsMatch ? `r=${cfParamsMatch[1]}, t=${cfParamsMatch[2]}` : "none"}`);

// ─── Étape 3 : GET /main/ ──────────────────────────────────────────────────────
console.log("\n─── 3. GET /main/ ───");
const mainCb = cb();
const mainSrc = PORTAL_URL;
const mainQ = new URLSearchParams({
  callback: mainCb,
  type: "default",
  publickey: PUBLICKEY,
  lang: "es",
  version: "4",
  src: mainSrc,
  srvsrc: "https://www.citaconsular.es",
  _: ts(),
});
const mainHeaders = {
  Cookie: buildCookieHeader(),
  "Accept": "*/*",
  "Accept-Encoding": "gzip, deflate, br",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Referer": PORTAL_URL,
  "Sec-Fetch-Dest": "script",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "same-origin",
  "X-Requested-With": "XMLHttpRequest",
};
const mainRes = await spainCfFetch(`${BASE}main/?${mainQ}`, session, { headers: mainHeaders });
const mainBody = await mainRes.text();
mergeCookies(mainRes.headers.get("set-cookie"));
console.log(`   HTTP ${mainRes.status} | bytes: ${mainBody.length}`);
fs.writeFileSync(path.join(OUT, "main-raw.jsonp"), mainBody);

// ─── Étape 4 : Fetch loadermaec.js ────────────────────────────────────────────
console.log("\n─── 4. GET loadermaec.js ───");
const loaderRes = await spainCfFetch("https://www.citaconsular.es/js/widgets/loadermaec.js?v=4", session, {
  headers: {
    Cookie: buildCookieHeader(),
    "Accept": "*/*",
    "Referer": PORTAL_URL,
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  },
});
const loaderJs = await loaderRes.text();
console.log(`   HTTP ${loaderRes.status} | bytes: ${loaderJs.length}`);
fs.writeFileSync(path.join(OUT, "loadermaec.js"), loaderJs);
// Find all AJAX/URL patterns
const urlPatterns = loaderJs.match(/['"`][^'"`]*onlinebookings[^'"`]*['"`]/g) ?? [];
console.log(`   URL patterns found: ${urlPatterns.length}`);
for (const p of urlPatterns.slice(0, 20)) console.log(`     ${p}`);

// ─── Étape 5 : getwidgetconfigurations/ — test avec délais ──────────────────
console.log("\n─── 5. getwidgetconfigurations/ (3 essais avec délais croissants) ───");

async function testGetWidgetConfs(delayMs: number): Promise<string> {
  await new Promise<void>((r) => setTimeout(r, delayMs));
  const cfgCb = cb();
  const cfgQ = new URLSearchParams({
    callback: cfgCb,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: PORTAL_URL,
    srvsrc: "https://www.citaconsular.es",
    selectedPeople: "1",
    _: ts(),
  });
  const jsonpHeaders = {
    Cookie: buildCookieHeader(),
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer": `${BASE}main/?callback=${mainCb}&type=default&publickey=${PUBLICKEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts()}`,
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  };
  const r = await spainCfFetch(`${BASE}getwidgetconfigurations/?${cfgQ}`, session, { headers: jsonpHeaders });
  const body = await r.text();
  return body;
}

for (const delay of [0, 2000, 5000]) {
  const body = await testGetWidgetConfs(delay);
  console.log(`   delay=${delay}ms → HTTP | bytes: ${body.length} | snippet: ${body.slice(0, 100)}`);
}

// ─── Étape 6 : getservices/ — test avec différents params et délais ──────────
console.log("\n─── 6. getservices/ (délais + params variants) ───");

async function testGetServices(delayMs: number, extraParams: Record<string, string> = {}): Promise<string> {
  await new Promise<void>((r) => setTimeout(r, delayMs));
  const svcCb = cb();
  const svcQ = new URLSearchParams({
    callback: svcCb,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: PORTAL_URL,
    srvsrc: "https://www.citaconsular.es",
    selectedPeople: "1",
    _: ts(),
    ...extraParams,
  });
  const jsonpHeaders = {
    Cookie: buildCookieHeader(),
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "es-ES,es;q=0.9",
    "Referer": `${BASE}main/?callback=${mainCb}&type=default&publickey=${PUBLICKEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts()}`,
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  };
  const r = await spainCfFetch(`${BASE}getservices/?${svcQ}`, session, { headers: jsonpHeaders });
  const body = await r.text();
  return body;
}

// Test 1: immédiatement
let body = await testGetServices(0);
console.log(`   delay=0ms → bytes: ${body.length} | snippet: ${body.slice(0, 120)}`);

// Test 2: 2s de délai
body = await testGetServices(2000);
console.log(`   delay=2000ms → bytes: ${body.length} | snippet: ${body.slice(0, 120)}`);

// Test 3: 5s de délai
body = await testGetServices(5000);
console.log(`   delay=5000ms → bytes: ${body.length} | snippet: ${body.slice(0, 120)}`);

// Test 4: sans selectedPeople
body = await testGetServices(0, {});
console.log(`   no-selectedPeople → bytes: ${body.length} | snippet: ${body.slice(0, 120)}`);

// Test 5: getagendas/ sans serviceId (pour voir ce que ça donne)
console.log("\n─── 7. getagendas/ (sans serviceId) ───");
const agCb = cb();
const agQ = new URLSearchParams({
  callback: agCb,
  type: "default",
  publickey: PUBLICKEY,
  lang: "es",
  version: "4",
  src: PORTAL_URL,
  srvsrc: "https://www.citaconsular.es",
  selectedPeople: "1",
  _: ts(),
});
const agRes = await spainCfFetch(`${BASE}getagendas/?${agQ}`, session, {
  headers: {
    Cookie: buildCookieHeader(),
    "Accept": "*/*",
    "Referer": `${BASE}main/?callback=${mainCb}&publickey=${PUBLICKEY}&lang=es&version=4&src=${encodeURIComponent(PORTAL_URL)}&_=${ts()}`,
    "Sec-Fetch-Dest": "script",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "same-origin",
  },
});
const agBody = await agRes.text();
console.log(`   HTTP ${agRes.status} | bytes: ${agBody.length} | snippet: ${agBody.slice(0, 200)}`);
fs.writeFileSync(path.join(OUT, "getagendas.jsonp"), agBody);

// ─── Résumé ───────────────────────────────────────────────────────────────────
console.log("\n══════════════════════════════════════════════════════════════════");
console.log(`  Files saved to ${OUT}`);
console.log("══════════════════════════════════════════════════════════════════");
