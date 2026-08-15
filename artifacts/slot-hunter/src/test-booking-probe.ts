/**
 * test-booking-probe.ts — Diagnostic rapide : impit vs browser pour les endpoints booking
 *
 * Teste directement si impit peut appeler getagendas/ + signin/ avec le cookie CF actif.
 * Compare la réponse impit vs callBookititEndpointViaBrowser pour le même endpoint.
 */
process.env.CHROMIUM_EXECUTABLE_PATH =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { ensureSpainCfSession, spainCfFetch } from "./spain-soax-solver.js";
import { callBookititEndpointViaBrowser } from "./_legacy_spain-persistent-browser.js";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BASE_JSONP = "https://www.citaconsular.es/onlinebookings/";
const PUBLICKEY = "2d01502f12dc08400e22aea87fb00ae34";
const SERVICE_ID = "bkt853215";

function sep(label: string) {
  console.log("\n" + "═".repeat(60));
  console.log(`  ${label}`);
  console.log("═".repeat(60));
}

async function main() {
  sep("PROBE — impit vs browser pour booking endpoints");

  // 1. Obtenir la session CF (réutilise celle en mémoire si disponible)
  const session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) {
    console.error("❌ Session CF non disponible — relancer après un scan.");
    process.exit(1);
  }
  console.log(`✅ Session CF — soaxProxyUrl: ${session.soaxProxyUrl?.replace(/:([^:@]+)@/, ":***@")}`);
  console.log(`   PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 12) ?? "ABSENT"}…`);
  console.log(`   cf_clearance: ${session.cfClearance?.slice(0, 20)}…`);
  console.log(`   source: ${session.source}`);

  const referer = PORTAL_URL.replace(/\/?$/, "/");
  const jsonpHeaders = {
    Referer: referer,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };

  // ── Test 1 : getagendas/ via impit ────────────────────────────────────────
  sep("TEST 1 — getagendas/ via impit");
  const agQ = new URLSearchParams({
    callback: `cbAg${Date.now()}`,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    selectedPeople: "1",
    _: String(Date.now()),
  });
  const agUrl = `${BASE_JSONP}getagendas/?${agQ}`;
  console.log(`  URL: ${agUrl.slice(0, 120)}`);
  const agRes = await spainCfFetch(agUrl, session, { headers: jsonpHeaders });
  if (!agRes) {
    console.log("  ❌ spainCfFetch returned null (exception or throw)");
  } else {
    const body = await agRes.text();
    console.log(`  HTTP: ${agRes.status} | body: ${body.length}B`);
    console.log(`  Body (300c): ${body.slice(0, 300)}`);
  }

  // ── Test 2 : getagendas/ via browser ─────────────────────────────────────
  sep("TEST 2 — getagendas/ via callBookititEndpointViaBrowser");
  const agQ2 = new URLSearchParams({
    callback: `cbAg2${Date.now()}`,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    selectedPeople: "1",
    _: String(Date.now()),
  });
  const agUrl2 = `${BASE_JSONP}getagendas/?${agQ2}`;
  console.log(`  URL: ${agUrl2.slice(0, 120)}`);
  try {
    const browserBody = await callBookititEndpointViaBrowser(agUrl2);
    console.log(`  body: ${browserBody.length}B`);
    console.log(`  Body (300c): ${browserBody.slice(0, 300)}`);
  } catch (err) {
    console.log(`  ❌ Exception: ${err}`);
  }

  // ── Test 3 : signin/ via impit (faux identifiants) ────────────────────────
  sep("TEST 3 — signin/ via impit (faux credentials — attendre reject ou 0B)");
  const now = new Date();
  const sigQ = new URLSearchParams({
    callback: `cbSig${Date.now()}`,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    selectedPeople: "1",
    date: "2026-09-01",
    time: "09:00",
    comments: "",
    logintype: "document",
    login: "AB123456",
    password: "FakePassword2026",
    _: String(Date.now()),
  });
  const sigUrl = `${BASE_JSONP}signin/?${sigQ}`;
  console.log(`  URL (100c): ${sigUrl.slice(0, 100)}`);
  const sigRes = await spainCfFetch(sigUrl, session, { headers: jsonpHeaders });
  if (!sigRes) {
    console.log("  ❌ spainCfFetch returned null");
  } else {
    const body = await sigRes.text();
    console.log(`  HTTP: ${sigRes.status} | body: ${body.length}B`);
    console.log(`  Body (300c): ${body.slice(0, 300)}`);
  }

  // ── Test 4 : signin/ via browser ─────────────────────────────────────────
  sep("TEST 4 — signin/ via callBookititEndpointViaBrowser (faux creds)");
  const sigQ2 = new URLSearchParams({
    callback: `cbSig2${Date.now()}`,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: referer,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    selectedPeople: "1",
    date: "2026-09-01",
    time: "09:00",
    comments: "",
    logintype: "document",
    login: "AB123456",
    password: "FakePassword2026",
    _: String(Date.now()),
  });
  const sigUrl2 = `${BASE_JSONP}signin/?${sigQ2}`;
  console.log(`  URL (100c): ${sigUrl2.slice(0, 100)}`);
  try {
    const browserBody = await callBookititEndpointViaBrowser(sigUrl2);
    console.log(`  body: ${browserBody.length}B`);
    console.log(`  Body (300c): ${browserBody.slice(0, 300)}`);
  } catch (err) {
    console.log(`  ❌ Exception: ${err}`);
  }

  sep("CONCLUSION");
  console.log("  Si tests 1+3 → 0B et tests 2+4 → >0B :");
  console.log("  → impit utilise une IP différente du browser pour les JSONP");
  console.log("  → Fix: routing booking JSONP via callBookititEndpointViaBrowser");
  console.log("  Si tests 1+3 → >0B :");
  console.log("  → problème de PHPSESSID isolé (dossier session)");
}

main().catch((err) => {
  console.error("\n💥 Erreur:", err);
  process.exit(1);
});
