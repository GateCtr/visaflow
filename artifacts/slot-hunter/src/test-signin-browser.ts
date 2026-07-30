/**
 * test-signin-browser.ts — Test signin/ via browser (session chaude) + diagnostic #signupsecondappointment
 *
 * But : voir la VRAIE réponse serveur de signin/ avec les endpoints booking,
 * en utilisant le browser plutôt qu'impit pour éviter le PHPSESSID froid.
 *
 * Ce test :
 *   1. Réutilise la session CF en mémoire/Redis (session chaude depuis le dernier scan)
 *   2. Appelle getwidgetconfigurations/ via browser → voit registration_type
 *   3. Appelle getagendas/ via browser → récupère agendaId
 *   4. Appelle signin/ via browser avec faux credentials → voit la VRAIE réponse serveur
 *   5. Si signin/ renvoie 0B → essaie les autres candidats
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/test-signin-browser.ts
 */

process.env.CHROMIUM_EXECUTABLE_PATH =
  process.env.CHROMIUM_EXECUTABLE_PATH ||
  "/home/runner/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { ensureSpainCfSession } from "./spain-soax-solver.js";
import { callBookititEndpointViaBrowser } from "./spain-persistent-browser.js";
import { scanSpainHttp } from "./spain-http-scanner.js";

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BASE = "https://www.citaconsular.es/onlinebookings/";
const PUBLICKEY = "2d01502f12dc08400e22aea87fb00ae34";
const SERVICE_ID = "bkt853215";
const REFERER = PORTAL_URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";

// Créneau confirmé par le scan précédent
const SLOT_DATE = "2026-09-01";
const SLOT_TIME = "09:00";

function sep(label: string) {
  console.log("\n" + "═".repeat(65));
  console.log(`  ${label}`);
  console.log("═".repeat(65));
}

function buildParams(endpoint: string, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams({
    callback: `cb${endpoint.replace(/\//g, "")}${Date.now()}`,
    type: "default",
    publickey: PUBLICKEY,
    lang: "es",
    version: "4",
    src: REFERER,
    srvsrc: SRVSRC,
    selectedPeople: "1",
    _: String(Date.now()),
    ...extra,
  });
  return q.toString();
}

async function browserCall(endpoint: string, extra: Record<string, string> = {}): Promise<string> {
  const url = `${BASE}${endpoint}?${buildParams(endpoint, extra)}`;
  console.log(`  → ${endpoint} (${Object.keys(extra).filter(k => !["services[]","agendas[]","date","time"].includes(k)).join(",")})`);
  const body = await callBookititEndpointViaBrowser(url);
  console.log(`     HTTP body: ${body.length}B — ${body.slice(0, 200) || "(vide)"}`);
  return body;
}

async function main() {
  sep("TEST SIGNIN via BROWSER — session chaude requise");

  // ── Étape 0 : Obtenir une session chaude ──────────────────────────────────
  // Si la session est déjà en mémoire depuis test-saopola-live.ts → réutilisation immédiate.
  // Sinon → on lance un scan pour chauffer la session + le cache Bookitit.
  let session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) {
    console.error("❌ Session CF indisponible");
    process.exit(1);
  }

  console.log(`✅ Session CF — source: ${session.source} | proxy: ${session.soaxProxyUrl?.replace(/:([^:@]+)@/, ":***@")}`);
  console.log(`   PHPSESSID principal: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 12) ?? "absent"}…`);

  // Si la session n'a pas de prefetch (session froide) → scan d'abord pour chauffer le cache
  if (!session.prefetchedMainHtml?.length && session.source === "playwright") {
    sep("SESSION FROIDE — Scan préalable pour chauffer le cache Bookitit");
    console.log("  Lancement scanSpainHttp pour initialiser getwidgetconfigurations/+getservices/+datetime/…");
    const scanResult = await scanSpainHttp(PORTAL_URL);
    console.log(`  Scan: ${scanResult.status} — ${scanResult.slotInfo ?? scanResult.errorMessage ?? ""}`);
    if (scanResult.status !== "found" && scanResult.status !== "not_found") {
      console.error("  ❌ Scan échoué — session pas chaude, arrêt.");
      process.exit(1);
    }
    // Refresh session après scan
    session = await ensureSpainCfSession(PORTAL_URL);
    if (!session) { console.error("❌ Session perdue après scan"); process.exit(1); }
  }

  // ── Étape 1 : getwidgetconfigurations/ → registration_type + captcha flag ──
  sep("1. getwidgetconfigurations/ via browser");
  const cfgBody = await browserCall("getwidgetconfigurations/");

  let registrationType = "2";
  let captchaFlag = "0";
  try {
    const m = cfgBody.match(/\((\{[\s\S]*\})\)/);
    if (m) {
      const cfg = JSON.parse(m[1]);
      const wc = cfg?.WidgetConfiguration ?? cfg;
      registrationType = String(wc?.registration_type ?? "2");
      captchaFlag = String(wc?.captcha ?? "0");
      console.log(`  ✅ registration_type=${registrationType} captcha=${captchaFlag}`);
      console.log(`  Hash Backbone attendu: ${
        registrationType === "3" ? "#signin" :
        registrationType === "2" ? "#signupsecondappointment → endpoint signin/" :
        registrationType === "1" ? "#signupfirstappointment → endpoint signupfirstappointment/" :
        "#signup → endpoint signup/"
      }`);
    }
  } catch { console.log("  ⚠️ Parsing échoué — raw ci-dessus"); }

  // ── Étape 2 : getagendas/ → agendaId ─────────────────────────────────────
  sep("2. getagendas/ via browser");
  const agBody = await browserCall("getagendas/", { "services[]": SERVICE_ID });

  let agendaId = "";
  if (agBody) {
    const ids = [...agBody.matchAll(/"id"\s*:\s*"?(\w+)"?/g)].map(m => m[1]);
    const agIds = [...agBody.matchAll(/"agenda(?:Id)?"\s*:\s*"?(\w+)"?/gi)].map(m => m[1]);
    agendaId = agIds[0] ?? ids[0] ?? "";
    console.log(`  agendaId extrait: ${agendaId || "(introuvable)"}`);
  }

  // ── Étape 3 : Appels auth via browser — tous les candidats ───────────────
  sep("3. Endpoints d'auth via browser (faux identifiants)");

  const authBase = {
    "services[]": SERVICE_ID,
    ...(agendaId ? { "agendas[]": agendaId } : {}),
    date: SLOT_DATE,
    time: SLOT_TIME,
    comments: "",
  };

  // Candidat A : signin/ avec logintype=document (Kinshasa confirmé par capture Burp)
  sep("3A. signin/ — logintype=document (passeport)");
  const signinBody = await browserCall("signin/", {
    ...authBase,
    logintype: "document",
    login: "AB123456",
    password: "FakePassword2026",
  });
  if (!signinBody) console.log("  ❌ 0B — session Bookitit pas encore initialisée pour cet endpoint");

  // Candidat B : signin/ avec logintype=email
  sep("3B. signin/ — logintype=email");
  const signinEmailBody = await browserCall("signin/", {
    ...authBase,
    logintype: "email",
    login: "test.saopola.fake@gmail.com",
    password: "FakePassword2026",
  });

  // Candidat C : signupfirstappointment/ (registration_type=1)
  sep("3C. signupfirstappointment/ — name+email");
  const signupFirstBody = await browserCall("signupfirstappointment/", {
    ...authBase,
    name: "TEST SAOPOLA",
    email: "test.saopola.fake@gmail.com",
  });

  // Candidat D : signup/ (fallback générique)
  sep("3D. signup/ — name+email");
  const signupBody = await browserCall("signup/", {
    ...authBase,
    name: "TEST SAOPOLA",
    email: "test.saopola.fake@gmail.com",
  });

  // ── Analyse finale ────────────────────────────────────────────────────────
  sep("CONCLUSION");
  const all = [
    { name: "signin/(document)", body: signinBody },
    { name: "signin/(email)", body: signinEmailBody },
    { name: "signupfirstappointment/", body: signupFirstBody },
    { name: "signup/", body: signupBody },
  ];

  for (const c of all) {
    if (!c.body) {
      console.log(`  ${c.name}: 0B — PHPSESSID pas initialisé ou endpoint incorrect`);
      continue;
    }
    const hasBktToken = c.body.includes("bktToken");
    const hasErrors = c.body.includes("errors");
    const hasSuccess = c.body.includes('"success":true') || c.body.includes('"success":"1"');
    const icon = hasBktToken ? "✅" : hasErrors ? "⚠️ " : hasSuccess ? "🎫" : "ℹ️ ";
    console.log(`  ${icon} ${c.name}: ${c.body.length}B — bktToken=${hasBktToken} errors=${hasErrors} success=${hasSuccess}`);
    if (c.body.length > 0 && c.body.length < 1000) {
      console.log(`     Réponse complète: ${c.body}`);
    }
  }

  console.log(`\n  registration_type=${registrationType} → hash Backbone attendu: ${
    registrationType === "2" ? "#signupsecondappointment (=signin/ côté HTTP)" :
    registrationType === "3" ? "#signin (=signin/ côté HTTP)" :
    registrationType === "1" ? "#signupfirstappointment" : "#signup"
  }`);
  console.log(`\n  Note : #signupsecondappointment étend SignInContainer (bundle Bookitit) →`);
  console.log(`         il n'y a PAS d'endpoint HTTP "signupsecondappointment/" — tout passe par signin/.`);
  console.log();
}

main().catch(err => { console.error("\n💥 Erreur:", err); process.exit(1); });
