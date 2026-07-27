/**
 * test-spain-persistent-browser.ts — Test standalone du mode persistent-browser
 *
 * Usage :
 *   DECODO_PROXY_URL=http://user:pass@host:port \
 *   SPAIN_PORTAL_URL=https://www.citaconsular.es/es/hosteds/widgetdef498.html \
 *   tsx test-spain-persistent-browser.ts
 *
 * Étapes testées :
 *   1. ensureSpainPersistentBrowserSession()   — solve CF via Chromium persistant
 *   2. cache mémoire + réutilisation           — 0ms, pas de re-solve
 *   3. createSpainPersistentBrowserDossierSession() — PHPSESSID isolé via incognito
 *   4. spainCfFetch → /onlinebookings/main/    — impit avec cf_clearance, pas de challenge
 *   5. runSpainHttpProbe()                     — probe complet end-to-end
 */

import * as dotenv from "dotenv";
dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const PORTAL_URL = process.env.SPAIN_PORTAL_URL
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

const CF_TARGET = process.env.SPAIN_CF_TARGET
  ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

if (process.env.DECODO_PROXY_URL) {
  const masked = process.env.DECODO_PROXY_URL.replace(/:([^:@]+)@/, ":***@");
  console.log(`[test] DECODO_PROXY_URL : ${masked}`);
} else {
  console.warn("[test] ⚠️  DECODO_PROXY_URL absent — accès direct (CF peut bloquer)");
}
console.log(`[test] PORTAL_URL       : ${PORTAL_URL}`);

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  ensureSpainPersistentBrowserSession,
  isSpainPersistentBrowserSessionExpiringSoon,
  getActiveSpainPersistentBrowserSession,
  createSpainPersistentBrowserDossierSession,
  spainPersistentBrowser,
} from "./src/spain-persistent-browser.js";

import { spainCfFetch } from "./src/spain-soax-solver.js";
import { runSpainHttpProbe } from "./src/spain-http-scanner.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isCfChallenge(status: number, body: string): boolean {
  if (status === 403) return true;
  return /just a moment|un instant|verifying you are human|challenge-platform|_cf_chl_opt/i
    .test(body.slice(0, 4000));
}

function bodyPreview(body: string, max = 300): string {
  return body.replace(/\s+/g, " ").trim().slice(0, max);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Test spain-persistent-browser — end-to-end");
  console.log("══════════════════════════════════════════════════════════════\n");

  const t0 = Date.now();

  // ─── Étape 1 : solve CF ───────────────────────────────────────────────────
  console.log("─── Étape 1 : ensureSpainPersistentBrowserSession() ───");
  const session = await ensureSpainPersistentBrowserSession(CF_TARGET);
  if (!session) {
    console.error("❌ ÉCHEC : session null — cf_clearance non obtenu");
    process.exit(1);
  }
  console.log(`✅ Session CF obtenue en ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`   source        : ${session.source}`);
  console.log(`   cf_clearance  : ${session.cfClearance.slice(0, 50)}…`);
  console.log(`   cookies       : ${session.allCookies.map(c => c.name).join(", ")}`);
  console.log(`   expire dans   : ~${Math.round((session.expiresAt - Date.now()) / 60_000)}min`);

  // ─── Étape 2 : cache + réutilisation ──────────────────────────────────────
  console.log("\n─── Étape 2 : cache mémoire ───");
  const cached = getActiveSpainPersistentBrowserSession();
  if (!cached) { console.error("❌ cache vide"); process.exit(1); }
  console.log(`✅ cache hit 0ms — expiringSoon: ${isSpainPersistentBrowserSessionExpiringSoon()}`);

  const t2b = Date.now();
  await ensureSpainPersistentBrowserSession(CF_TARGET);
  console.log(`✅ réutilisation depuis cache en ${Date.now() - t2b}ms`);

  // ─── Étape 3 : PHPSESSID isolé ────────────────────────────────────────────
  console.log("\n─── Étape 3 : createSpainPersistentBrowserDossierSession() ───");
  const t3 = Date.now();
  const dossierSession = await createSpainPersistentBrowserDossierSession(session, PORTAL_URL);
  if (!dossierSession) {
    console.warn("⚠️  Dossier session null — /main/ n'a pas retourné de PHPSESSID");
  } else {
    const phpSessId = dossierSession.allCookies.find(c => c.name === "PHPSESSID");
    const parentPhp = session.allCookies.find(c => c.name === "PHPSESSID");
    const isolated = phpSessId && (!parentPhp || phpSessId.value !== parentPhp.value);
    console.log(`✅ Dossier session en ${Math.round((Date.now() - t3) / 1000)}s`);
    console.log(`   PHPSESSID  : ${phpSessId?.value.slice(0, 20) ?? "ABSENT ❌"}…`);
    console.log(`   isolation  : ${isolated ? "✅ distinct" : "⚠️  identique à la session parente"}`);
  }

  // ─── Étape 4 : spainCfFetch → /onlinebookings/main/ ──────────────────────
  // Test réel : est-ce que impit + cf_clearance passe sans challenge CF ?
  console.log("\n─── Étape 4 : spainCfFetch → /onlinebookings/main/ ───");
  const publickey = PORTAL_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const callback = `jQueryBooking${Date.now()}`;
  const mainQuery = new URLSearchParams({
    callback,
    type: "default",
    ...(publickey ? { publickey } : {}),
    lang: "es",
    version: "4",
    src: PORTAL_URL,
    _: String(Date.now()),
  });
  const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;
  console.log(`   URL: ${mainUrl.slice(0, 100)}…`);

  const t4 = Date.now();
  const mainRes = await spainCfFetch(mainUrl, session, {
    headers: {
      Referer: PORTAL_URL,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, */*; q=0.01",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
    },
  });

  // Hoist so the summary block can read it (a CF JS challenge returns HTTP 200
  // with HTML — checking only the status code misses it entirely).
  let step4Challenge: boolean | null = null;

  if (!mainRes) {
    console.error("❌ spainCfFetch a retourné null (réseau ou proxy)");
  } else {
    const status = (mainRes as any).status ?? "?";
    const body = await (mainRes as any).text() as string;
    const challenge = isCfChallenge(Number(status), body);
    step4Challenge = challenge;               // ← hoisté pour le résumé
    const elapsed = Math.round((Date.now() - t4) / 1000);

    console.log(`   HTTP status : ${status} (${elapsed}s)`);
    console.log(`   CF challenge: ${challenge ? "❌ OUI — session rejetée par CF" : "✅ NON"}`);
    console.log(`   Body (début): ${bodyPreview(body, 400)}`);

    // Diagnostics supplémentaires
    if (challenge) {
      console.error("❌ ÉTAPE 4 ÉCHOUÉE : CF challenge détecté sur /main/");
      console.error("   → cf_clearance non reconnu, ou proxy incohérent avec l'IP qui a résolu CF");
    } else if (status === 200 || status === "200") {
      // Vérifier si la réponse contient du contenu Bookitit ou "No hay horas"
      const hasBookitit = /bkt|bookitit|jquery|callback|PHPSESSID/i.test(body);
      const noHoras = /no hay horas|no appointments/i.test(body);
      const hasServices = /#selectservice/i.test(body);
      console.log(`   Contenu     : ${hasBookitit ? "✅ réponse Bookitit" : "⚠️  pas de marqueurs Bookitit"}`);
      console.log(`   Créneaux    : ${hasServices ? "🎯 CRÉNEAUX DISPONIBLES !" : noHoras ? "🔴 'No hay horas' (normal)" : "⚠️  indéterminé"}`);
    }
  }

  // ─── Étape 5 : runSpainHttpProbe complet ──────────────────────────────────
  console.log("\n─── Étape 5 : runSpainHttpProbe() — probe complet ───");
  const t5 = Date.now();
  const probeResult = await runSpainHttpProbe(PORTAL_URL);
  const elapsed5 = Math.round((Date.now() - t5) / 1000);

  console.log(`   status      : ${probeResult.status} (${elapsed5}s)`);
  console.log(`   slotInfo    : ${probeResult.slotInfo ?? "(aucun)"}`);
  console.log(`   errorMessage: ${probeResult.errorMessage ?? "(aucun)"}`);

  // runSpainHttpProbe collapses cf_blocked/session_expired → "error" internally.
  // Distinguish CF blocks from other errors via errorMessage.
  const cfKeywords = /cf_blocked|cloudflare|challenge|session_expired/i;
  if (probeResult.status === "error") {
    const isCfBlock = cfKeywords.test(probeResult.errorMessage ?? "");
    if (isCfBlock) {
      console.error("❌ ÉTAPE 5 ÉCHOUÉE : CF a bloqué le probe");
      console.error(`   → ${probeResult.errorMessage}`);
    } else {
      console.error(`❌ ÉTAPE 5 ERREUR : ${probeResult.errorMessage}`);
    }
  } else {
    console.log(`✅ Probe HTTP passé sans challenge CF (status: ${probeResult.status})`);
    if (probeResult.status === "found") {
      console.log("   🎯 CRÉNEAUX DÉTECTÉS !");
    }
  }

  // ─── Résumé ───────────────────────────────────────────────────────────────
  const total = Math.round((Date.now() - t0) / 1000);
  // step4Challenge is null only when mainRes was null; false = no challenge (pass).
  const step4ok = mainRes !== null && step4Challenge === false;
  const step5ok = probeResult.status !== "error";

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`  Étape 1 (CF solve)     : ✅`);
  console.log(`  Étape 2 (cache)        : ✅`);
  console.log(`  Étape 3 (PHPSESSID)    : ${dossierSession ? "✅" : "⚠️ "}`);
  console.log(`  Étape 4 (impit /main/) : ${mainRes ? (step4ok ? "✅" : "❌ challenge") : "❌ null"}`);
  console.log(`  Étape 5 (probe complet): ${step5ok ? "✅" : "❌"}`);
  console.log(`  Durée totale           : ${total}s`);
  console.log("══════════════════════════════════════════════════════════════\n");

  await spainPersistentBrowser.close();
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ Exception inattendue :", err);
  process.exit(1);
});
