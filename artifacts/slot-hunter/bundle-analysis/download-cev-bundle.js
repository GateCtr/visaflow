/**
 * download-cev-bundle.js — Télécharge le bundle JS du portail CEV (appointment.cloud.diplomatie.be)
 * Le bundle est accessible publiquement (pas besoin de session).
 * Usage : node bundle-analysis/download-cev-bundle.js
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const BUNDLE_PATH = "/bundles/scripts/sharedScripts";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Referer": CEV_BASE + "/Captcha",
      },
    };
    https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(new URL(res.headers.location, url).href));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    }).on("error", reject);
  });
}

async function main() {
  // 1. Essayer le bundle connu
  console.log(`1. Téléchargement ${CEV_BASE}${BUNDLE_PATH}...`);
  let { status, body } = await httpsGet(CEV_BASE + BUNDLE_PATH);
  console.log(`   HTTP ${status} — ${(body.length / 1024).toFixed(0)} KB`);

  if (status !== 200 || body.length < 1000) {
    // 2. Essayer de trouver le bundle depuis la page Captcha
    console.log("\n2. Fallback: extraction depuis la page /Captcha...");
    const { status: s2, body: html } = await httpsGet(CEV_BASE + "/Captcha");
    console.log(`   Page /Captcha: HTTP ${s2} — ${html.length} bytes`);

    // Chercher les scripts
    const scripts = html.match(/src="([^"]*\.js[^"]*)"/g) || [];
    console.log(`   Scripts trouvés: ${scripts.length}`);
    scripts.forEach(s => console.log(`     ${s}`));

    // Chercher les bundles
    const bundles = html.match(/src="(\/bundles[^"]*)"/g) || [];
    if (bundles.length > 0) {
      const bundleUrl = bundles[0].match(/src="([^"]+)"/)[1];
      console.log(`\n   Bundle trouvé: ${bundleUrl}`);
      const r = await httpsGet(CEV_BASE + bundleUrl);
      console.log(`   HTTP ${r.status} — ${(r.body.length / 1024).toFixed(0)} KB`);
      if (r.status === 200) {
        status = r.status;
        body = r.body;
      }
    }
  }

  if (status !== 200) {
    console.error("   ❌ Impossible de télécharger le bundle");
    process.exit(1);
  }

  // Sauvegarder
  const outPath = path.join(__dirname, "cev-bundle.js");
  fs.writeFileSync(outPath, body);
  console.log(`\n✅ Bundle CEV sauvé: bundle-analysis/cev-bundle.js (${(body.length / 1024).toFixed(0)} KB)`);

  // Vérification rapide
  console.log("\n3. Contenu du bundle:");
  const keywords = [
    "AvailableTimeSlots",
    "SetCaptchaToken",
    "SelectSlot",
    "BookAppointment",
    "ConfirmAppointment",
    "getAvailableTimeSlotsForPublic",
    "callPost",
    "SharedAjaxService",
    "setupSessionTimeout",
    "successfullCaptcha",
    "DoCancelRequestAppointment",
  ];
  for (const kw of keywords) {
    const found = body.includes(kw);
    console.log(`   ${found ? "✅" : "❌"} ${kw}`);
  }
}

main().catch(err => { console.error("Erreur:", err.message); process.exit(1); });
