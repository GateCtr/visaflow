/**
 * Debug pas-à-pas du booking RK-Termin pour Jean Bernard.
 * Affiche l'HTML brut du formulaire showForm + tous les champs hidden.
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-jean-bernard.ts
 */

import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const p of ["../../.env", "../../.env.local", ".env", ".env.local"]) {
  const full = join(__dirname, p);
  if (existsSync(full)) { dotenv.config({ path: full, override: true }); }
}

import { initSession, rkGet, rkPost, buildUrl, randomDelay } from "./src/germanyPortal/rktermin-session.js";
import { extractCaptchaBase64, solveImageCaptcha } from "./src/germanyPortal/rktermin-captcha.js";
import { scanMonth, scanDay } from "./src/germanyPortal/rktermin-scan.js";
import { RKTERMIN_ENDPOINTS, RKTERMIN_BASE_URL } from "./src/germanyPortal/config.js";
import type { RKTerminConfig, RKTerminSession } from "./src/germanyPortal/types.js";

const config: RKTerminConfig = {
  locationCode:       "kins",
  realmId:            1276,
  categoryId:         3020,
  locale:             "en",
  applicantLastname:  "KAY MALIK",
  applicantFirstname: "YOUSEF",
  applicantEmail:     "encoraplus@gmail.com",
  dynamicFields: [
    { definitionId: 14389, index: 0, content: "Kongolesisch" },
    { definitionId: 14390, index: 1, content: "P00069429"    },
  ],
  maxExtraMonths: 0,
};

// ── Extraire TOUS les <input hidden> d'un HTML ────────────────────────────────
function extractHiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Chercher toutes les balises <input ... type="hidden" ... >
  // Supporte les attributs dans n'importe quel ordre, avec ou sans guillemets
  const inputRe = /<input[^>]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = inputRe.exec(html)) !== null) {
    const tag = m[0];
    // Vérifier que c'est un champ hidden (guillemets ou sans)
    if (!/type\s*=\s*["']?\s*hidden\s*["']?/i.test(tag)) continue;
    // Extraire name (avec ou sans guillemets)
    const nameM = tag.match(/\bname\s*=\s*["']([^"']*)["']/i)
                ?? tag.match(/\bname\s*=\s*([^\s>]+)/i);
    // Extraire value (avec ou sans guillemets)
    const valM  = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i)
                ?? tag.match(/\bvalue\s*=\s*([^\s>]+)/i);
    if (nameM?.[1]) {
      fields[nameM[1]] = valM?.[1] ?? "";
    }
  }
  return fields;
}

// ── Extraire un extrait HTML lisible autour des champs hidden ─────────────────
function dumpFormSection(html: string): string {
  // Trouver la balise <form> et extraire jusqu'à 3000 chars
  const formStart = html.toLowerCase().indexOf("<form");
  if (formStart === -1) return html.slice(0, 2000);
  return html.slice(formStart, formStart + 4000);
}

console.log("═══════════════════════════════════════════════════════");
console.log(" DEBUG BOOKING — Jean Bernard (KAY MALIK YOUSEF)");
console.log("═══════════════════════════════════════════════════════\n");

// ── STEP 1: Init session + captcha mois ──────────────────────────────────────
console.log("▶ STEP 1: initSession + captcha mois");
const { session: rawSession, result: monthResult } = await scanMonth(config);
let session = rawSession;

if (monthResult.status === "captcha_failed" || monthResult.status === "error") {
  console.error("❌ Scan mois échoué:", monthResult.status, (monthResult as any).errorMessage);
  process.exit(1);
}
console.log(`✅ Session créée, ${monthResult.availableDates.length} dates dispo`);
console.log(`   Dates: ${monthResult.availableDates.slice(0, 5).join(", ")}...`);

// ── STEP 2: Scan toutes les dates dispo jusqu'à trouver un créneau ───────────
console.log(`\n▶ STEP 2: scanDay — parcours des ${monthResult.availableDates.length} dates dispo`);

let slot: { date: string; openingPeriodId: string } | null = null;
for (const dateStr of monthResult.availableDates.slice(0, 5)) {
  console.log(`   → scanDay ${dateStr}`);
  const { session: daySession, result: dayResult } = await scanDay(session, config, dateStr);
  session = daySession;
  if (dayResult.status === "slots_found" && dayResult.slots.length > 0) {
    slot = dayResult.slots[0];
    console.log(`✅ Créneau: ${slot.date} openingPeriodId=${slot.openingPeriodId}`);
    break;
  }
  console.log(`   ↳ Aucun créneau le ${dateStr}`);
}

if (!slot) {
  console.error("❌ Aucun créneau disponible sur les 5 premières dates");
  process.exit(1);
}

// ── STEP 3: GET showForm — capturer l'HTML brut ───────────────────────────────
console.log("\n▶ STEP 3: GET appointment_showForm (avec Referer=showDay)");

const dayPageUrl = buildUrl(RKTERMIN_ENDPOINTS.appointmentShowDay, {
  locationCode: config.locationCode,
  realmId:      config.realmId,
  categoryId:   config.categoryId,
  dateStr:      slot.date,
});

await randomDelay(800, 1200);
const { html: formHtml, newSession: ns1 } = await rkGet(
  session,
  RKTERMIN_ENDPOINTS.appointmentShowForm,
  {
    locationCode:    config.locationCode,
    realmId:         config.realmId,
    categoryId:      config.categoryId,
    dateStr:         slot.date,
    openingPeriodId: slot.openingPeriodId,
  },
  { referer: dayPageUrl },
);
if (ns1) {
  session = { ...session, ...ns1 };
  console.log(`   → Nouveau cookie: ${JSON.stringify(ns1)}`);
}

// Afficher les champs hidden extraits
const hiddenFields = extractHiddenFields(formHtml);
console.log("\n━━━ CHAMPS HIDDEN EXTRAITS ━━━");
console.log(JSON.stringify(hiddenFields, null, 2));

// Afficher l'extrait HTML du formulaire (pour trouver les champs manquants)
console.log("\n━━━ HTML SECTION FORM (4000 chars) ━━━");
console.log(dumpFormSection(formHtml));
console.log("━━━ FIN HTML ━━━\n");

// ── STEP 4: Résoudre captcha booking ─────────────────────────────────────────
console.log("▶ STEP 4: Résolution captcha booking");
const captchaB64 = extractCaptchaBase64(formHtml);
if (!captchaB64) {
  console.error("❌ Captcha absent du showForm — HTML affiché ci-dessus pour diagnostic");
  process.exit(1);
}

const captchaResult = await solveImageCaptcha(captchaB64);
if (captchaResult.status !== "solved" || !captchaResult.text) {
  console.error("❌ Captcha non résolu:", captchaResult.status);
  process.exit(1);
}
console.log(`✅ Captcha résolu: "${captchaResult.text}"`);

// ── STEP 5: POST addAppointment ───────────────────────────────────────────────
console.log("\n▶ STEP 5: POST appointment_addAppointment");
await randomDelay(800, 1500);

const formReferer = buildUrl(RKTERMIN_ENDPOINTS.appointmentShowForm, {
  locationCode:    config.locationCode,
  realmId:         config.realmId,
  categoryId:      config.categoryId,
  dateStr:         slot.date,
  openingPeriodId: slot.openingPeriodId,
});

// ── IMPORTANT: utiliser les definitionId/index du formulaire (hiddenFields),
//   PAS ceux de la config (qui sont pour un realm différent).
//   Ex: realmId=1276 → 11598/11599 ; realmId=731 → 14389/14390.
const postData: Record<string, string> = {
  ...hiddenFields,                           // ← definitionId et index viennent du formulaire
  lastname:    config.applicantLastname,
  firstname:   config.applicantFirstname,
  email:       config.applicantEmail,
  emailrepeat: config.applicantEmail,
  captchaText: captchaResult.text,
  locationCode:    config.locationCode,
  realmId:         String(config.realmId),
  categoryId:      String(config.categoryId),
  openingPeriodId: slot.openingPeriodId,
  date:    slot.date,
  dateStr: slot.date,
  "action:appointment_addAppointment": "Submit",
};
// Seulement le contenu — definitionId et index déjà corrects via hiddenFields
for (const field of config.dynamicFields) {
  postData[`fields[${field.index}].content`] = field.content;
}

console.log("\nfields extraits du formulaire (definitionIds corrects):");
console.log(`  fields[0].definitionId = ${postData["fields[0].definitionId"]} (doit être 11598 pour realmId=1276)`);
console.log(`  fields[1].definitionId = ${postData["fields[1].definitionId"]} (doit être 11599 pour realmId=1276)`);
console.log("\nPOST body:", JSON.stringify(postData, null, 2));

// Le formulaire action="/rktermin/extern/appointment_showForm.do" — POSTer sur showForm, pas addAppointment
console.log(`\nEndpoint POST: ${RKTERMIN_ENDPOINTS.appointmentShowForm} (action du <form> HTML)`);

// Wrapper rkPost qui log aussi le status HTTP
import { Agent, ProxyAgent } from "undici";
import { RKTERMIN_HEADERS, RKTERMIN_BASE_URL } from "./src/germanyPortal/config.js";
import { getRKDispatcher, buildCookieHeader } from "./src/germanyPortal/rktermin-session.js";

const postUrl = `${RKTERMIN_BASE_URL}/${RKTERMIN_ENDPOINTS.appointmentShowForm}`;
const rawBody = new URLSearchParams(postData).toString();
console.log(`\nURL POST: ${postUrl}`);

const postRes = await fetch(postUrl, {
  method: "POST",
  headers: {
    ...RKTERMIN_HEADERS,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Cookie": buildCookieHeader(session),
    "Content-Type": "application/x-www-form-urlencoded",
    "Referer": formReferer,
    "Origin": RKTERMIN_BASE_URL,
  },
  body: rawBody,
  redirect: "follow",
  dispatcher: getRKDispatcher() as any,
} as any);

const resultHtml = await postRes.text();
console.log(`Status HTTP: ${postRes.status}`);
console.log(`Content-Length: ${resultHtml.length} chars`);
console.log(`URL finale (après redirect): ${postRes.url}`);

// ── STEP 6: Analyser la réponse ───────────────────────────────────────────────
console.log("\n━━━ RÉPONSE POST (texte nettoyé) ━━━");
const cleaned = resultHtml
  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 2000);
console.log(cleaned);
console.log("━━━ FIN RÉPONSE ━━━");

if (/successfully booked|erfolgreich gebucht/i.test(resultHtml)) {
  console.log("\n🎉 RÉSERVATION RÉUSSIE !");
} else if (/address.*manually|Adresse.*manuell|An error occurred while processing/i.test(resultHtml)) {
  console.log("\n❌ session_error — voir HTML ci-dessus");
} else if (/text was wrong|falsch/i.test(resultHtml)) {
  console.log("\n⚠️  Captcha incorrect");
} else {
  console.log("\n❓ Réponse inattendue — voir HTML ci-dessus");
  // Afficher plus de HTML pour diagnostic
  console.log("\n━━━ HTML BRUT RÉPONSE (3000 chars) ━━━");
  console.log(resultHtml.slice(0, 3000));
}
