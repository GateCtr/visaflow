/**
 * test-cuba-main-direct.ts — Isole pourquoi /main/ retourne 0 bytes
 * Teste différentes combinaisons de cookies pour trouver le vrai blocage.
 */
import { ensureSpainCfSession, spainCfFetch } from "./src/spain-soax-solver.js";

const PUBLICKEY = "28330379fc95acafd31ee9e8938c278ff";
const PORTAL_URL = `https://www.citaconsular.es/es/hosteds/widgetdefault/${PUBLICKEY}/`;
const BASE = "https://www.citaconsular.es/onlinebookings/";

// Utiliser la session cachée si dispo
const session = await ensureSpainCfSession(PORTAL_URL);
if (!session) { console.error("❌ CF session"); process.exit(1); }
console.log(`✅ cf_clearance: ${session.cfClearance.slice(0, 30)}… | source: ${session.source}`);
console.log(`   cookies: ${session.allCookies.map(c => c.name).join(", ")}`);

async function callMain(label: string, cookieOverride?: string) {
  const tNow = Date.now();
  const q = new URLSearchParams({
    callback: `jQuery${tNow}`, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: PORTAL_URL, _: String(tNow),
  });
  const headers: Record<string, string> = {
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: PORTAL_URL,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };
  if (cookieOverride !== undefined) headers["Cookie"] = cookieOverride;
  const r = await spainCfFetch(`${BASE}main/?${q}`, session, { headers });
  const body = await r.text();
  const cfRay = r.headers.get("cf-ray") ?? "";
  const setCookie = r.headers.get("set-cookie") ?? "";
  console.log(`  [${label}] HTTP ${r.status} | bytes: ${body.length} | cf-ray: ${cfRay} | set-cookie: ${setCookie.slice(0, 60)}`);
  return body;
}

const capsolver_cf = session.cfClearance;
const capsolver_phpsessid = session.allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";
const ga = session.allCookies.find(c => c.name === "_ga")?.value ?? "";
const ga2 = session.allCookies.find(c => c.name === "_ga_F3TYSDL945")?.value ?? "";

console.log(`\n   CapSolver PHPSESSID: ${capsolver_phpsessid.slice(0, 20) || "(absent)"}`);
console.log(`   CapSolver _ga: ${ga.slice(0, 30) || "(absent)"}`);

console.log("\n─── Test 1: ONLY cf_clearance (no PHPSESSID) ───");
await callMain("cf-only", `cf_clearance=${capsolver_cf}`);

console.log("\n─── Test 2: cf_clearance + CapSolver PHPSESSID ───");
if (capsolver_phpsessid) {
  await callMain("cf+capsolver-phpsessid", `PHPSESSID=${capsolver_phpsessid}; cf_clearance=${capsolver_cf}`);
} else {
  console.log("  (no CapSolver PHPSESSID available)");
}

console.log("\n─── Test 3: cf_clearance + fresh PHPSESSID from portal GET ───");
const htmlHdrs = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};
const p1 = await spainCfFetch(PORTAL_URL, session, { headers: { Cookie: `cf_clearance=${capsolver_cf}`, ...htmlHdrs } });
const h1 = await p1.text();
const portalPhp = p1.headers.getSetCookie().join(";").match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
const token = h1.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
console.log(`  Portal GET: HTTP ${p1.status} | bytes: ${h1.length} | PHPSESSID: ${portalPhp.slice(0, 20)}… | token: ${token.slice(0, 20)}…`);
await callMain("cf+portal-phpsessid", `PHPSESSID=${portalPhp}; cf_clearance=${capsolver_cf}`);

console.log("\n─── Test 4: cf_clearance + PHPSESSID after POST token ───");
if (token) {
  const p2 = await spainCfFetch(PORTAL_URL, session, {
    method: "POST",
    headers: {
      Cookie: `PHPSESSID=${portalPhp}; cf_clearance=${capsolver_cf}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Origin: "https://www.citaconsular.es",
      Referer: PORTAL_URL,
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
    },
    body: `token=${encodeURIComponent(token)}`,
  });
  const h2 = await p2.text();
  const postPhp = p2.headers.getSetCookie().join(";").match(/PHPSESSID=([^;]+)/)?.[1] ?? portalPhp;
  console.log(`  POST widget: HTTP ${p2.status} | bytes: ${h2.length} | PHPSESSID: ${postPhp.slice(0, 20)}…`);
  await callMain("cf+post-phpsessid", `PHPSESSID=${postPhp}; cf_clearance=${capsolver_cf}`);
}

console.log("\n─── Test 5: let spainCfFetch handle cookies via impit (no override) ───");
await callMain("impit-auto-cookies", undefined);

console.log("\n─── Test 6: no cookies at all ───");
await callMain("no-cookies", "");

process.exit(0);
