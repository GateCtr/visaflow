/**
 * download-bundle.js — Télécharge le bundle Angular du portail USA
 * Usage : node bundle-analysis/download-bundle.js
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const BASE = "https://www.usvisaappt.com";
const APP_PATH = "/visaapplicantui/";

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": BASE + APP_PATH,
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
  console.log("1. Récupération de la page principale...");
  const { status, body } = await httpsGet(BASE + APP_PATH);
  console.log(`   HTTP ${status} — ${body.length} bytes`);

  const match = body.match(/src="(main\.[a-f0-9]+\.js)"/);
  if (!match) {
    console.error("   ❌ Bundle main.*.js non trouvé dans le HTML");
    // Chercher tous les .js
    const jsFiles = body.match(/src="[^"]*\.js"/g);
    if (jsFiles) {
      console.log("   Fichiers JS trouvés :");
      jsFiles.forEach((f) => console.log("     " + f));
    }
    process.exit(1);
  }

  const bundleName = match[1];
  console.log(`   ✅ Bundle trouvé : ${bundleName}`);

  console.log("\n2. Téléchargement du bundle...");
  const bundleUrl = BASE + APP_PATH + bundleName;
  const { status: bStatus, body: bundleContent } = await httpsGet(bundleUrl);
  console.log(`   HTTP ${bStatus} — ${(bundleContent.length / 1024).toFixed(0)} KB`);

  if (bStatus !== 200) {
    console.error("   ❌ Échec du téléchargement");
    process.exit(1);
  }

  const outPath = path.join(__dirname, "bundle.js");
  fs.writeFileSync(outPath, bundleContent);
  console.log(`   ✅ Sauvegardé : bundle-analysis/bundle.js (${(bundleContent.length / 1024).toFixed(0)} KB)`);

  // Vérification rapide des endpoints
  console.log("\n3. Vérification endpoints...");
  const endpoints = [
    "modifyslot/getFirstAvailableMonth",
    "modifyslot/getSlotDates",
    "modifyslot/getSlotTime",
    "appointments/schedule",
    "appointments/reschedule",
    "appointments/showRescheduleButton",
    "deliverymission/config/missionId",
    "getUserHistoryApplicantPaymentStatus",
    "getLandingPageDeatils",
    "getTransformData",
  ];
  for (const ep of endpoints) {
    const found = bundleContent.includes(ep);
    console.log(`   ${found ? "✅" : "❌"} ${ep}`);
  }

  console.log("\n✅ Bundle téléchargé avec succès !");
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
