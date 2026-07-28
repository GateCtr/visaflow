/**
 * test-cuba-full-flow.ts — Capture complète du flow Cuba bout-en-bout
 *
 * Usage:
 *   tsx test-cuba-full-flow.ts
 *
 * Ce script:
 *   1. Solve CF via Chromium persistant
 *   2. Lance scanSpainHttp() sur le portail Cuba
 *   3. Si des services sont rendus → appelle getagendas/ + datetime/ explicitement
 *      et loggue les vraies réponses JSON pour valider confirmSlotsViaDatetime
 *   4. Affiche le résumé complet (status, slotInfo, services trouvés, dates)
 */

import * as dotenv from "dotenv";
dotenv.config();

import {
  ensureSpainPersistentBrowserSession,
  spainPersistentBrowser,
} from "./src/spain-persistent-browser.js";
import { runSpainHttpProbe } from "./src/spain-http-scanner.js";
import { spainCfFetch } from "./src/spain-soax-solver.js";

const CUBA_URL = process.env.SPAIN_PORTAL_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PUBLICKEY = CUBA_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1]
  ?? "28330379fc95acafd31ee9e8938c278ff";
const BASE = "https://www.citaconsular.es/onlinebookings/";
const SRVSRC = "https://www.citaconsular.es";

console.log(`\n${"═".repeat(66)}`);
console.log("  Test flow complet — Portail Cuba (créneaux disponibles)");
console.log(`${"═".repeat(66)}\n`);
console.log(`[cuba] PORTAL_URL : ${CUBA_URL}`);
console.log(`[cuba] PUBLICKEY  : ${PUBLICKEY}`);

// ─── Helper JSONP parser ──────────────────────────────────────────────────────
function parseJsonp(raw: string): any {
  const m = raw.match(/^[^(]+\(([\s\S]*)\);?\s*$/);
  if (!m) { try { return JSON.parse(raw); } catch { return null; } }
  try { return JSON.parse(m[1]); } catch { return null; }
}

async function run() {
  const t0 = Date.now();

  // ─── 1. CF solve ─────────────────────────────────────────────────────────
  console.log("\n─── Étape 1 : CF solve via Chromium persistant ───");
  const session = await ensureSpainPersistentBrowserSession(CUBA_URL);
  if (!session) {
    console.error("❌ CF solve échoué"); process.exit(1);
  }
  console.log(`✅ cf_clearance obtenu (${Math.round((Date.now()-t0)/1000)}s)`);
  console.log(`   cookies: ${session.allCookies.map(c=>c.name).join(", ")}`);

  // ─── 2. runSpainHttpProbe ─────────────────────────────────────────────────
  console.log("\n─── Étape 2 : runSpainHttpProbe() ───");
  const t2 = Date.now();
  const probe = await runSpainHttpProbe(CUBA_URL);
  console.log(`   status      : ${probe.status} (${Math.round((Date.now()-t2)/1000)}s)`);
  console.log(`   slotInfo    : ${probe.slotInfo ?? "(aucun)"}`);
  console.log(`   errorMessage: ${probe.errorMessage ?? "(aucun)"}`);

  if (probe.status === "found") {
    console.log("   🎯 CRÉNEAUX DÉTECTÉS VIA PROBE !");
  }

  // ─── 3. Appels directs getagendas/ + datetime/ pour Cuba ─────────────────
  // On refait manuellement pour capturer les vraies réponses JSON/JSONP
  console.log("\n─── Étape 3 : getagendas/ + datetime/ explicites (diagnostic) ───");

  // On a besoin d'un cookieStr à jour — session est mise à jour par le probe
  const cookieParts: string[] = [];
  const preferred = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  for (const n of preferred) {
    const c = session.allCookies.find(c => c.name === n);
    if (c) cookieParts.push(`${c.name}=${c.value}`);
  }
  for (const c of session.allCookies) {
    if (!preferred.includes(c.name) && c.name !== "cf_clearance") cookieParts.push(`${c.name}=${c.value}`);
  }
  cookieParts.push(`cf_clearance=${session.cfClearance}`);
  const cookieStr = cookieParts.join("; ");

  const referer = CUBA_URL.replace(/\/?$/, "/");
  const headers = {
    Cookie: cookieStr,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Referer: referer,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };

  // 3a. /main/ direct pour récupérer les services
  const cb = `jQCuba${Date.now()}`;
  const mainQ = new URLSearchParams({
    callback: cb, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: referer, _: String(Date.now()),
  });
  const mainRes = await spainCfFetch(`${BASE}main/?${mainQ}`, session, { headers });
  const mainRaw = mainRes ? await mainRes.text() : "";
  console.log(`   /main/ status: ${mainRes?.status ?? "null"} | bytes: ${mainRaw.length}`);

  // Extraire les services depuis le HTML de /main/
  const mainParsed = parseJsonp(mainRaw);
  const mainHtml: string = (typeof mainParsed === "string")
    ? mainParsed
    : (mainRaw.includes("<") ? mainRaw : "");

  const svcMatches = [...mainHtml.matchAll(/<a[^>]+href=['"]#selectservice\/([\w]+)['"][^>]*>([\s\S]*?)<\/a>/gi)];
  console.log(`   Services trouvés dans /main/ : ${svcMatches.length}`);

  if (svcMatches.length === 0) {
    console.log(`   Aperçu /main/ body: ${mainRaw.slice(0, 400).replace(/\s+/g, " ")}`);
  }

  for (const m of svcMatches.slice(0, 5)) {
    const svcId = m[1];
    const inner = m[2];
    const nameM = inner.match(/clsBktServiceDataName[^>]*>([^<]+)/i) ?? inner.match(/>([^<]{5,})</);
    const svcName = nameM?.[1]?.trim() ?? "Service";
    console.log(`\n   🔧 Service: "${svcName}" (ID: ${svcId})`);

    // 3b. getagendas/
    const cbAg = `cbAg${Date.now()}`;
    const agQ = new URLSearchParams();
    agQ.append("callback", cbAg); agQ.append("type", "default");
    agQ.append("publickey", PUBLICKEY); agQ.append("lang", "es");
    agQ.append("version", "4"); agQ.append("src", referer);
    agQ.append("srvsrc", SRVSRC); agQ.append("services[]", svcId);
    agQ.append("selectedPeople", "1"); agQ.append("_", String(Date.now()));
    const agRes = await spainCfFetch(`${BASE}getagendas/?${agQ}`, session, { headers });
    const agRaw = agRes ? await agRes.text() : "";
    const agData = parseJsonp(agRaw);
    console.log(`   getagendas/ status: ${agRes?.status ?? "null"}`);
    console.log(`   getagendas/ body (300): ${agRaw.slice(0,300).replace(/\s+/g," ")}`);

    // Extraire agendaId
    let agendaId = "";
    const agIds = JSON.stringify(agData ?? "").match(/"id"\s*:\s*"([^"]+)"/g);
    if (agIds?.[0]) agendaId = agIds[0].replace(/.*"id"\s*:\s*"([^"]+)".*/, "$1");
    if (agendaId) console.log(`   agendaId: ${agendaId}`);

    // 3c. datetime/ sur juillet et août 2026
    const now = new Date();
    for (let mo = 0; mo < 2; mo++) {
      const tgt   = new Date(now.getFullYear(), now.getMonth() + mo, 1);
      const start = tgt.toISOString().slice(0, 10);
      const end   = new Date(tgt.getFullYear(), tgt.getMonth()+1, 0).toISOString().slice(0, 10);
      const cbDt  = `cbDt${mo}${Date.now()}`;
      const dtQ = new URLSearchParams();
      dtQ.append("callback", cbDt); dtQ.append("type", "default");
      dtQ.append("publickey", PUBLICKEY); dtQ.append("lang", "es");
      dtQ.append("version", "4"); dtQ.append("src", referer);
      dtQ.append("srvsrc", SRVSRC); dtQ.append("services[]", svcId);
      if (agendaId) dtQ.append("agendas[]", agendaId);
      dtQ.append("selectedPeople", "1");
      dtQ.append("start", start); dtQ.append("end", end);
      dtQ.append("_", String(Date.now()));
      const dtRes = await spainCfFetch(`${BASE}datetime/?${dtQ}`, session, { headers });
      const dtRaw = dtRes ? await dtRes.text() : "";
      const dtData = parseJsonp(dtRaw);
      console.log(`   datetime/ [${start}→${end}] status: ${dtRes?.status ?? "null"} | bytes: ${dtRaw.length}`);
      console.log(`   datetime/ body (400): ${dtRaw.slice(0,400).replace(/\s+/g," ")}`);
      if (dtData) console.log(`   datetime/ parsed: ${JSON.stringify(dtData).slice(0,300)}`);
    }
  }

  // ─── Résumé ───────────────────────────────────────────────────────────────
  const total = Math.round((Date.now()-t0)/1000);
  console.log(`\n${"═".repeat(66)}`);
  console.log(`  CF solve         : ✅`);
  console.log(`  probe status     : ${probe.status}`);
  console.log(`  slotInfo         : ${probe.slotInfo ?? "(aucun)"}`);
  console.log(`  Services /main/  : ${svcMatches.length}`);
  console.log(`  Durée totale     : ${total}s`);
  console.log(`${"═".repeat(66)}\n`);

  await spainPersistentBrowser.close();
  process.exit(0);
}

run().catch(err => { console.error("❌ Exception:", err); process.exit(1); });
