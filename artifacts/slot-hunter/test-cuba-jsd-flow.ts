/**
 * test-cuba-jsd-flow.ts — Test du flow complet JSD main.js pour Cuba
 * Variante : log complet POST widget #2 + test /main/ sans step 2c
 */
import fs from "fs";
import {
  ensureSpainCfSession,
  spainCfFetch,
  invalidateSpainCfSession,
} from "./src/spain-soax-solver.js";

const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const PORTAL_URL = `https://www.citaconsular.es/es/hosteds/widgetdefault/${PUBLICKEY}/`;
const BASE = "https://www.citaconsular.es/onlinebookings/";
const OUT = "/tmp/cuba-jsd2/";
fs.mkdirSync(OUT, { recursive: true });

invalidateSpainCfSession();
const session = await ensureSpainCfSession(PORTAL_URL);
if (!session) { console.error("❌ CF session"); process.exit(1); }

const cookies: Record<string, string> = {};
for (const c of session.allCookies ?? []) cookies[c.name] = c.value;
let activeCfClearance = session.cfClearance;

function mergeCookies(res: Response | null, label: string) {
  for (const raw of res?.headers?.getSetCookie?.() ?? []) {
    const part = raw.split(";")[0] ?? "";
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name === "cf_clearance") {
      activeCfClearance = val;
      console.log(`  🔑 cf_clearance updated from ${label}`);
    } else if (name === "PHPSESSID") {
      cookies["PHPSESSID"] = val;
      console.log(`  🍪 PHPSESSID updated from ${label}: ${val.slice(0, 12)}…`);
    } else if (name && val) {
      cookies[name] = val;
    }
  }
}
function ck() {
  const parts: string[] = [];
  for (const n of ["_ga", "_ga_F3TYSDL945", "PHPSESSID"]) {
    if (cookies[n]) parts.push(`${n}=${cookies[n]}`);
  }
  for (const [k, v] of Object.entries(cookies)) {
    if (!["_ga", "_ga_F3TYSDL945", "PHPSESSID", "cf_clearance"].includes(k)) parts.push(`${k}=${v}`);
  }
  parts.push(`cf_clearance=${activeCfClearance}`);
  return parts.join("; ");
}

const htmlHdrs = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "same-origin",
  "Upgrade-Insecure-Requests": "1",
  "Priority": "u=0, i",
};

async function callMain(label: string) {
  const tNow = Date.now();
  const cbName = `jQuery${tNow}`;
  const q = new URLSearchParams({ callback: cbName, type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: PORTAL_URL, _: String(tNow) });
  const r = await spainCfFetch(`${BASE}main/?${q}`, session, {
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
  });
  const body = await r.text();
  console.log(`  /main/ [${label}] → HTTP ${r.status} | bytes: ${body.length}`);
  if (body.length > 0) fs.writeFileSync(`${OUT}main-${label}.jsonp`, body);
  return body;
}

// ─── 1. GET portal ────────────────────────────────────────────────────────────
console.log("\n─── 1. GET portal ───");
const r1 = await spainCfFetch(PORTAL_URL, session, { headers: { Cookie: ck(), ...htmlHdrs, "Sec-Fetch-Site": "none" } });
const h1 = await r1.text();
mergeCookies(r1, "GET portal");
const token = h1.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
console.log(`   HTTP ${r1.status} | bytes: ${h1.length} | token: ${token.slice(0, 20)}… (${token.length})`);

// ─── 2. POST Continue ─────────────────────────────────────────────────────────
console.log("\n─── 2. POST Continue ───");
const r2 = await spainCfFetch(PORTAL_URL, session, {
  method: "POST",
  headers: { Cookie: ck(), ...htmlHdrs, "Content-Type": "application/x-www-form-urlencoded", Origin: "https://www.citaconsular.es", Referer: PORTAL_URL, "Sec-Fetch-User": "?1" },
  body: `token=${encodeURIComponent(token)}`,
});
const h2 = await r2.text();
mergeCookies(r2, "POST widget #1");
fs.writeFileSync(`${OUT}widget1.html`, h2);
console.log(`   HTTP ${r2.status} | bytes: ${h2.length} | bkt: ${/bkt_init_widget/.test(h2)}`);

const cfR = h2.match(/window\.__CF\$cv\$params\s*=\s*\{r:'([^']+)',/)?.[1] ?? "";
console.log(`   CF r param: ${cfR}`);

// ─── Test A: /main/ BEFORE JSD ───────────────────────────────────────────────
console.log("\n─── Test A: /main/ BEFORE JSD ───");
await callMain("before-jsd");

// ─── 3. Fetch jsd/main.js ─────────────────────────────────────────────────────
console.log("\n─── 3. Fetch jsd/main.js ───");
const r3 = await spainCfFetch("https://www.citaconsular.es/cdn-cgi/challenge-platform/scripts/jsd/main.js", session, {
  headers: { Cookie: ck(), Accept: "*/*", Referer: PORTAL_URL, "Sec-Fetch-Dest": "script", "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Site": "same-origin" },
});
const jsdJs = await r3.text();
console.log(`   HTTP ${r3.status} | bytes: ${jsdJs.length}`);

const oneshotM = jsdJs.match(/\/jsd\/oneshot\/([a-f0-9]{10,14})\/([\w.:\-_~]+)\//);
const siteKey = oneshotM?.[1] ?? "";
const nonce = oneshotM?.[2] ?? "";
const oneshotPath = `/cdn-cgi/challenge-platform/h/b/jsd/oneshot/${siteKey}/${nonce}/${cfR}`;
console.log(`   Oneshot: ${oneshotPath}`);

// ─── 4. Fire JSD oneshot ──────────────────────────────────────────────────────
console.log("\n─── 4. JSD Oneshot POST ───");
await new Promise<void>(r => setTimeout(r, 4500 + Math.floor(Math.random() * 500)));
const r4 = await spainCfFetch(`https://www.citaconsular.es${oneshotPath}`, session, {
  method: "POST",
  headers: {
    Cookie: ck(), "Content-Type": "application/x-www-form-urlencoded", "Content-Length": "0",
    Origin: "https://www.citaconsular.es", Referer: PORTAL_URL,
    Accept: "*/*", "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "gzip, deflate, br",
    "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Priority: "u=1, i",
  },
  body: "",
});
const h4 = await r4.text();
mergeCookies(r4, "JSD oneshot");
console.log(`   HTTP ${r4.status} | bytes: ${h4.length} | cf_clearance: ${activeCfClearance.slice(0, 40)}…`);

// ─── Test B: /main/ AFTER JSD, BEFORE POST #2 ────────────────────────────────
console.log("\n─── Test B: /main/ AFTER JSD (no POST #2) ───");
await callMain("after-jsd-no-post2");

// ─── 5. POST widget #2 ───────────────────────────────────────────────────────
console.log("\n─── 5. POST widget #2 ───");
const r5 = await spainCfFetch(PORTAL_URL, session, {
  method: "POST",
  headers: {
    Cookie: ck(), ...htmlHdrs, "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://www.citaconsular.es", Referer: PORTAL_URL, "Sec-Fetch-User": "?1",
  },
  body: `token=${encodeURIComponent(token)}`,
});
const h5 = await r5.text();
mergeCookies(r5, "POST widget #2");
fs.writeFileSync(`${OUT}widget2.html`, h5);
console.log(`   HTTP ${r5.status} | bytes: ${h5.length}`);
console.log(`   bkt_init_widget: ${/bkt_init_widget/.test(h5)}`);
console.log(`   snippet: ${h5.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300)}`);

// ─── Test C: /main/ AFTER POST #2 ────────────────────────────────────────────
console.log("\n─── Test C: /main/ AFTER POST #2 ───");
await callMain("after-post2");

console.log(`\n══ Files: ${OUT} ══`);
