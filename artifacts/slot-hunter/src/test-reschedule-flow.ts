/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CAPTURE RESCHEDULE FLOW — Mode 100% manuel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Ce script ouvre un navigateur VISIBLE et capture TOUT le trafic réseau
 * pendant que TU navigues manuellement :
 *   1. Tu te connectes (email + password + captcha)
 *   2. Tu vas sur le dashboard
 *   3. Tu cliques sur "Mes rendez-vous"
 *   4. Tu cliques sur "Reschedule" sur le RDV voulu
 *   5. Tu confirmes
 *   6. Tu sélectionnes Kinshasa dans le sélecteur
 *   7. Tu changes de mois si besoin
 *
 * Le script capture et décode TOUT en temps réel dans la console.
 * Quand tu as fini, appuie sur ENTRÉE dans le terminal pour générer le rapport.
 *
 * Usage :
 *   npx tsx src/test-reschedule-flow.ts
 */

import { chromium } from "playwright";
import { writeFileSync } from "fs";
import * as dotenv from "dotenv";
dotenv.config();

// ─── Configuration ───────────────────────────────────────────────────────────
const USA_PORTAL = "https://www.usvisaappt.com";
const LOGIN_URL  = `${USA_PORTAL}/visaapplicantui/home/auth/login`;

// ─── Types ───────────────────────────────────────────────────────────────────
interface NetworkCapture {
  timestamp: string;
  method: string;
  url: string;
  status: number | null;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  resHeaders: Record<string, string>;
  resBody: string | null;
}

// ─── Globals ─────────────────────────────────────────────────────────────────
const captures: NetworkCapture[] = [];
let captureCount = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function shortUrl(url: string): string {
  return url.replace(USA_PORTAL, "").replace(/https:\/\/www\.google-analytics\.com.*/, "[GA]");
}

function isApiCall(url: string): boolean {
  if (url.includes("google-analytics.com")) return false;
  if (url.includes("googletagmanager.com")) return false;
  if (url.includes("dap.digitalgov.gov")) return false;
  if (url.includes("fonts.gstatic.com")) return false;
  if (url.includes("fonts.googleapis.com")) return false;
  return url.includes("usvisaappt.com") &&
    !url.match(/\.(js|css|png|jpg|jpeg|ico|woff|woff2|svg|gif|ttf|eot|map)(\?|$)/) &&
    !url.includes("/assets/");
}

function isInterestingCall(url: string): boolean {
  return /visa(userapi|workflowprocessor|appointmentapi|adminapi|administrationapi|integrationapi|paymentapi|notificationapi|applicationapi)|identity\/user|cancel|reschedule|appoint|applicant|schedule|slot|landing|sanity|transform|getpost|getuser|globalconfig/i.test(url);
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log("═".repeat(70));
  console.log("  CAPTURE RESCHEDULE — Mode manuel (tu navigues, je capture)");
  console.log("═".repeat(70));
  console.log("");
  console.log("  Le navigateur va s'ouvrir sur la page de login.");
  console.log("  Fais tout manuellement :");
  console.log("    1. Connecte-toi (email + password + captcha)");
  console.log("    2. Va sur le dashboard");
  console.log("    3. Clique sur 'Mes rendez-vous' / 'Manage Appointment'");
  console.log("    4. Clique sur 'Reschedule' sur le RDV voulu");
  console.log("    5. Confirme le reschedule");
  console.log("    6. Sélectionne Kinshasa dans le sélecteur");
  console.log("    7. Change de mois si besoin");
  console.log("");
  console.log("  Je capture TOUT le trafic réseau en temps réel.");
  console.log("  Quand tu as fini → appuie sur ENTRÉE ici pour le rapport.");
  console.log("");
  console.log("═".repeat(70));

  // Lancer le navigateur en mode VISIBLE, sans stealth (on veut un vrai Chrome)
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1400,900",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    locale: "en-US",
    timezoneId: "Africa/Kinshasa",
  });

  const page = await context.newPage();

  // ── Intercepteur réseau ────────────────────────────────────────────────────
  page.on("request", (req) => {
    const url = req.url();
    if (!isApiCall(url)) return;

    if (isInterestingCall(url)) {
      const method = req.method();
      let body: string | null = null;
      try { body = req.postData() ?? null; } catch { /* */ }

      captureCount++;
      console.log(`\n  ┌─ #${captureCount} REQ [${method}] ${shortUrl(url)}`);

      // Headers importants
      const h = req.headers();
      if (h["authorization"]) console.log(`  │ Auth: ${h["authorization"].slice(0, 70)}...`);
      if (h["x-xsrf-token"]) console.log(`  │ X-XSRF-TOKEN: ${h["x-xsrf-token"]}`);
      if (h["cookiename"]) console.log(`  │ CookieName: ${h["cookiename"]}`);
      if (h["cookie"]) console.log(`  │ Cookie: ${h["cookie"].slice(0, 100)}`);
      if (h["x-correlation-key"]) console.log(`  │ X-Correlation-key: ${h["x-correlation-key"]}`);
      if (h["referer"]) console.log(`  │ Referer: ${shortUrl(h["referer"])}`);
      if (body) {
        console.log(`  │ Body: ${body.slice(0, 500)}`);
      }
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (!isApiCall(url)) return;

    const req = res.request();
    let reqBody: string | null = null;
    try { reqBody = req.postData() ?? null; } catch { /* */ }
    const reqHeaders: Record<string, string> = {};
    try { Object.assign(reqHeaders, req.headers()); } catch { /* */ }

    let resBody: string | null = null;
    try {
      const ct = res.headers()["content-type"] ?? "";
      if (ct.includes("json") || ct.includes("text") || ct.includes("html")) {
        resBody = await res.text();
      }
    } catch { /* */ }

    // Capturer les headers de réponse intéressants
    const resHeaders: Record<string, string> = {};
    try {
      const allH = res.headers();
      for (const [k, v] of Object.entries(allH)) {
        if (/auth|token|csrf|cookie|x-|refresh/i.test(k)) resHeaders[k] = v;
      }
    } catch { /* */ }

    // Sauvegarder
    captures.push({
      timestamp: new Date().toISOString(),
      method: req.method(),
      url,
      status: res.status(),
      reqHeaders,
      reqBody,
      resHeaders,
      resBody: resBody?.slice(0, 5000) ?? null,
    });

    // Afficher en temps réel
    if (isInterestingCall(url)) {
      const ico = res.ok() ? "✅" : res.status() === 401 ? "🔒" : res.status() === 403 ? "🚫" : "❌";
      console.log(`  │ ${ico} RES [${res.status()}] ${shortUrl(url)}`);

      // Headers de réponse importants
      if (resHeaders["authorization"]) console.log(`  │ ← Auth header: ${resHeaders["authorization"].slice(0, 60)}...`);
      if (resHeaders["refreshtoken"]) console.log(`  │ ← RefreshToken: ${resHeaders["refreshtoken"].slice(0, 60)}...`);
      if (resHeaders["csrftoken"]) console.log(`  │ ← CsrfToken: ${resHeaders["csrftoken"]}`);

      // Body de réponse
      if (resBody) {
        // Décoder et afficher de manière lisible
        try {
          const parsed = JSON.parse(resBody);
          const pretty = JSON.stringify(parsed, null, 2);
          if (pretty.length < 1500) {
            console.log(`  │ ← ${pretty.split("\n").join("\n  │    ")}`);
          } else {
            console.log(`  │ ← (${resBody.length} chars) ${resBody.slice(0, 800)}...`);
          }
        } catch {
          // Pas du JSON — afficher brut
          if (resBody.length < 500) {
            console.log(`  │ ← ${resBody}`);
          } else {
            console.log(`  │ ← (HTML ${resBody.length} chars)`);
          }
        }
      }
      console.log(`  └${"─".repeat(60)}`);
    }
  });

  // ── Ouvrir la page de login ────────────────────────────────────────────────
  console.log(`\n  🌐 Ouverture: ${LOGIN_URL}\n`);
  await page.goto(LOGIN_URL, { waitUntil: "load", timeout: 60_000 });

  // ── Attendre que l'utilisateur ait fini ────────────────────────────────────
  console.log("\n  ╔══════════════════════════════════════════════════════════════╗");
  console.log("  ║  Navigateur ouvert — fais tes actions manuellement.        ║");
  console.log("  ║  Appuie sur ENTRÉE ici quand tu as terminé.                ║");
  console.log("  ╚══════════════════════════════════════════════════════════════╝\n");

  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  // ── Générer le rapport ─────────────────────────────────────────────────────
  console.log("\n\n");
  printReport();

  // Sauvegarder en JSON
  const reportPath = "reschedule-flow-captures.json";
  writeFileSync(reportPath, JSON.stringify(captures, null, 2));
  console.log(`\n  📁 Captures JSON sauvées: ${reportPath} (${captures.length} appels)`);

  await browser.close();
  process.exit(0);
}

// ─── Rapport ─────────────────────────────────────────────────────────────────
function printReport(): void {
  console.log("═".repeat(70));
  console.log("  RAPPORT — TOUS LES APPELS API CAPTURÉS");
  console.log("═".repeat(70));

  const apiCalls = captures.filter(c => isInterestingCall(c.url));
  console.log(`\n  Total appels capturés: ${captures.length} (dont ${apiCalls.length} intéressants)\n`);

  // ── Séquence complète ──────────────────────────────────────────────────────
  console.log("  ┌─ SÉQUENCE COMPLÈTE DES APPELS API ─────────────────────────");
  for (let i = 0; i < apiCalls.length; i++) {
    const c = apiCalls[i];
    const ico = (c.status ?? 999) < 400 ? "✅" : "❌";
    console.log(`  │ ${i + 1}. ${ico} [${c.status}] ${c.method} ${shortUrl(c.url)}`);
    if (c.reqBody) console.log(`  │    req: ${c.reqBody.slice(0, 200)}`);
    if (c.resBody) console.log(`  │    res: ${c.resBody.slice(0, 300)}`);
  }
  console.log("  └────────────────────────────────────────────────────────────────");

  // ── IDs extraits ───────────────────────────────────────────────────────────
  const allBodies = apiCalls.map(c => (c.resBody ?? "") + (c.reqBody ?? "")).join("\n");
  const applicationIds = [...new Set(Array.from(allBodies.matchAll(/"applicationId"\s*:\s*"([^"]+)"/g)).map(m => m[1]))];
  const appointmentIds = [...new Set(Array.from(allBodies.matchAll(/"appointmentId"\s*:\s*(\d+)/g)).map(m => parseInt(m[1])))];
  const applicantIds = [...new Set(Array.from(allBodies.matchAll(/"applicantId"\s*:\s*(\d+)/g)).map(m => parseInt(m[1])))];
  const applicantUUIDs = [...new Set(Array.from(allBodies.matchAll(/"applicantUUID"\s*:\s*(\d+)/g)).map(m => parseInt(m[1])))];
  const slotIds = [...new Set(Array.from(allBodies.matchAll(/"slotId"\s*:\s*(\d+)/g)).map(m => parseInt(m[1])))];
  const postUserIds = [...new Set(Array.from(allBodies.matchAll(/"postUserId"\s*:\s*(\d+)/g)).map(m => parseInt(m[1])))];

  console.log("\n  ┌─ IDs EXTRAITS ─────────────────────────────────────────────");
  console.log(`  │ applicationIds  : ${applicationIds.join(", ") || "(aucun)"}`);
  console.log(`  │ appointmentIds  : ${appointmentIds.join(", ") || "(aucun)"}`);
  console.log(`  │ applicantIds    : ${applicantIds.join(", ") || "(aucun)"}`);
  console.log(`  │ applicantUUIDs  : ${applicantUUIDs.join(", ") || "(aucun)"}`);
  console.log(`  │ slotIds         : ${slotIds.join(", ") || "(aucun)"}`);
  console.log(`  │ postUserIds     : ${postUserIds.join(", ") || "(aucun)"}`);
  console.log("  └────────────────────────────────────────────────────────────────");

  // ── Appels reschedule spécifiques ──────────────────────────────────────────
  const rescheduleCalls = apiCalls.filter(c =>
    c.url.includes("reschedule") || c.url.includes("cancel") ||
    c.url.includes("getSlot") || c.url.includes("getFirstAvailable") ||
    c.url.includes("getpost") || c.url.includes("getTransformData") ||
    c.url.includes("getApplicationDetails") || c.url.includes("scheduledappointment") ||
    c.url.includes("sanitycheck") || c.url.includes("schedule")
  );

  if (rescheduleCalls.length > 0) {
    console.log("\n  ┌─ APPELS LIÉS AU RESCHEDULE ────────────────────────────────");
    for (const c of rescheduleCalls) {
      const ico = (c.status ?? 999) < 400 ? "✅" : "❌";
      console.log(`  │`);
      console.log(`  │ ${ico} [${c.status}] ${c.method} ${shortUrl(c.url)}`);
      console.log(`  │   Timestamp: ${c.timestamp}`);
      if (c.reqBody) {
        console.log(`  │   REQUEST BODY:`);
        try {
          const p = JSON.stringify(JSON.parse(c.reqBody), null, 2);
          for (const line of p.split("\n")) console.log(`  │     ${line}`);
        } catch { console.log(`  │     ${c.reqBody.slice(0, 500)}`); }
      }
      if (c.resBody) {
        console.log(`  │   RESPONSE BODY:`);
        try {
          const p = JSON.stringify(JSON.parse(c.resBody), null, 2);
          const lines = p.split("\n");
          for (const line of lines.slice(0, 30)) console.log(`  │     ${line}`);
          if (lines.length > 30) console.log(`  │     ... (${lines.length - 30} lignes de plus)`);
        } catch { console.log(`  │     ${c.resBody.slice(0, 500)}`); }
      }
      // Headers importants de la requête
      const auth = c.reqHeaders["authorization"];
      const csrf = c.reqHeaders["x-xsrf-token"];
      const cookie = c.reqHeaders["cookiename"] ?? c.reqHeaders["cookie"];
      if (auth) console.log(`  │   Auth: ${auth.slice(0, 60)}...`);
      if (csrf) console.log(`  │   X-XSRF-TOKEN: ${csrf}`);
      if (cookie) console.log(`  │   Cookie: ${cookie.slice(0, 100)}`);
    }
    console.log("  └────────────────────────────────────────────────────────────────");
  }

  // ── Payload PUT reschedule (si capturé) ────────────────────────────────────
  const putReschedule = apiCalls.find(c => c.method === "PUT" && c.url.includes("reschedule"));
  if (putReschedule) {
    console.log("\n  ┌─ 🎯 PUT RESCHEDULE CAPTURÉ ──────────────────────────────────");
    console.log(`  │ URL: ${shortUrl(putReschedule.url)}`);
    console.log(`  │ Status: ${putReschedule.status}`);
    console.log(`  │`);
    console.log(`  │ REQUEST PAYLOAD:`);
    if (putReschedule.reqBody) {
      try {
        const p = JSON.stringify(JSON.parse(putReschedule.reqBody), null, 2);
        for (const line of p.split("\n")) console.log(`  │   ${line}`);
      } catch { console.log(`  │   ${putReschedule.reqBody}`); }
    }
    console.log(`  │`);
    console.log(`  │ RESPONSE:`);
    if (putReschedule.resBody) {
      try {
        const p = JSON.stringify(JSON.parse(putReschedule.resBody), null, 2);
        for (const line of p.split("\n")) console.log(`  │   ${line}`);
      } catch { console.log(`  │   ${putReschedule.resBody}`); }
    }
    console.log(`  │`);
    console.log(`  │ HEADERS ENVOYÉS:`);
    const importantHeaders = ["authorization", "x-xsrf-token", "cookiename", "cookie",
      "content-type", "referer", "x-correlation-key"];
    for (const h of importantHeaders) {
      if (putReschedule.reqHeaders[h]) {
        console.log(`  │   ${h}: ${putReschedule.reqHeaders[h].slice(0, 100)}`);
      }
    }
    console.log("  └────────────────────────────────────────────────────────────────");
  }

  // ── Comparaison avec notre implémentation ──────────────────────────────────
  console.log("\n  ┌─ COMPARAISON AVEC NOTRE IMPLÉMENTATION ─────────────────────");
  console.log("  │");
  console.log("  │ Notre rescheduleUsaSlot() envoie :");
  console.log("  │   PUT /visaappointmentapi/appointments/reschedule");
  console.log("  │   Payload: [{ appointmentId, applicantUUID, appointmentLocationType,");
  console.log("  │     appointmentStatus, slotId, appointmentDt, appointmentTime,");
  console.log("  │     postUserId, applicantId, applicationId, rescheduleType }]");
  console.log("  │   Headers: Bearer + CookieName: XSRF-TOKEN=xxx + X-XSRF-TOKEN: xxx");
  console.log("  │");
  if (putReschedule?.reqBody) {
    try {
      const payload = JSON.parse(putReschedule.reqBody);
      const item = Array.isArray(payload) ? payload[0] : payload;
      const keys = Object.keys(item ?? {});
      console.log(`  │ Le portail Angular envoie :`);
      console.log(`  │   Clés: ${keys.join(", ")}`);
      console.log(`  │   Est un tableau: ${Array.isArray(payload) ? "OUI ✅" : "NON ❌"}`);
      console.log("  │");
      const expectedKeys = ["appointmentId", "applicantUUID", "appointmentLocationType",
        "appointmentStatus", "slotId", "appointmentDt", "appointmentTime",
        "postUserId", "applicantId", "applicationId", "rescheduleType"];
      const missing = expectedKeys.filter(k => !keys.includes(k));
      const extra = keys.filter(k => !expectedKeys.includes(k));
      if (missing.length > 0) console.log(`  │ ⚠️ Clés dans NOTRE impl mais PAS dans le portail: ${missing.join(", ")}`);
      if (extra.length > 0) console.log(`  │ ⚠️ Clés dans le PORTAIL mais PAS dans notre impl: ${extra.join(", ")}`);
      if (missing.length === 0 && extra.length === 0) console.log("  │ ✅ Payload IDENTIQUE !");
    } catch { /* */ }
  } else {
    console.log("  │ ⚠️ PUT reschedule non capturé (tu n'as pas été jusqu'au bout du flux)");
    console.log("  │    C'est normal si tu n'as pas sélectionné un créneau disponible.");
  }
  console.log("  └────────────────────────────────────────────────────────────────");

  console.log("\n" + "═".repeat(70));
}

// ─── Entry Point ─────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
