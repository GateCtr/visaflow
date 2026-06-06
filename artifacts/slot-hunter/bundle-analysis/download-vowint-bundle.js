/**
 * download-vowint-bundle.js — Télécharge le bundle JS du portail VOWINT (visaonweb.diplomatie.be)
 * Usage : node bundle-analysis/download-vowint-bundle.js
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
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
        "Referer": VOWINT_BASE,
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
  console.log("1. Téléchargement de la page VOWINT...");
  const { status, body: html } = await httpsGet(VOWINT_BASE + "/en/Account/Login");
  console.log(`   Page VOWINT: HTTP ${status} — ${html.length} bytes`);

  // Chercher les scripts
  const scripts = html.match(/src="([^"]*\.js[^"]*)"/g) || [];
  console.log(`   Scripts trouvés: ${scripts.length}`);
  scripts.forEach(s => console.log(`     ${s}`));

  // Chercher les bundles
  const bundles = html.match(/src="(\/bundles[^"]*)"/g) || [];
  console.log(`   Bundles trouvés: ${bundles.length}`);
  
  if (bundles.length === 0 && scripts.length === 0) {
    console.log("   ❌ Aucun script/bundle trouvé sur VOWINT");
    process.exit(1);
  }

  // Télécharger le premier script/bundle
  const scriptUrl = bundles.length > 0 
    ? bundles[0].match(/src="([^"]+)"/)[1]
    : scripts[0].match(/src="([^"]+)"/)[1];
  
  console.log(`\n2. Téléchargement du script: ${scriptUrl}`);
  const r = await httpsGet(VOWINT_BASE + scriptUrl);
  console.log(`   HTTP ${r.status} — ${(r.body.length / 1024).toFixed(0)} KB`);

  if (r.status !== 200) {
    console.error("   ❌ Impossible de télécharger le script");
    process.exit(1);
  }

  // Sauvegarder
  const outPath = path.join(__dirname, "vowint-bundle.js");
  fs.writeFileSync(outPath, r.body);
  console.log(`\n✅ Script VOWINT sauvé: bundle-analysis/vowint-bundle.js (${(r.body.length / 1024).toFixed(0)} KB)`);

  // Vérification rapide
  console.log("\n3. Contenu du script:");
  const keywords = [
    "SelectSlot",
    "BookAppointment",
    "ConfirmAppointment",
    "AvailableTimeSlots",
    "Integration",
    "Appointment",
    "Slot",
  ];
  for (const kw of keywords) {
    const found = r.body.includes(kw);
    console.log(`   ${found ? "✅" : "❌"} ${kw}`);
  }
}

main().catch(err => { console.error("Erreur:", err.message); process.exit(1); });
