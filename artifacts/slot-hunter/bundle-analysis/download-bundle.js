/**
 * download-bundle.js — Télécharge le bundle Angular du portail USA
 * Usage : node bundle-analysis/download-bundle.js
 * 
 * Modifié pour sauvegarder dans un dossier 'usa' et télécharger tous les fichiers JS
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

// Créer le dossier usa s'il n'existe pas
const usaDir = path.join(__dirname, "..", "usa");
if (!fs.existsSync(usaDir)) {
  fs.mkdirSync(usaDir, { recursive: true });
  console.log(`📁 Dossier créé : ${usaDir}`);
}

function httpsGet(url, referer = BASE + APP_PATH) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": referer,
      },
    };
    https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(new URL(res.headers.location, url).href, referer));
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on("error", reject);
  });
}

async function downloadFile(url, filename, referer = BASE + APP_PATH) {
  console.log(`   📥 Téléchargement: ${filename}`);
  const { status, body } = await httpsGet(url, referer);
  if (status === 200) {
    const filePath = path.join(usaDir, filename);
    fs.writeFileSync(filePath, body);
    console.log(`   ✅ Sauvegardé: ${filename} (${(body.length / 1024).toFixed(1)} KB)`);
    return body;
  } else {
    console.log(`   ❌ Échec: ${filename} (HTTP ${status})`);
    return null;
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║   Téléchargement bundle portail USA                 ║");
  console.log("║   Dossier de destination: usa/                      ║");
  console.log("╚══════════════════════════════════════════════════════╝\n");

  console.log("1. Récupération de la page principale...");
  const { status, body: htmlContent } = await httpsGet(BASE + APP_PATH);
  console.log(`   HTTP ${status} — ${htmlContent.length} bytes`);

  // Sauvegarder le HTML principal
  fs.writeFileSync(path.join(usaDir, "index.html"), htmlContent);
  console.log(`   ✅ HTML sauvegardé: usa/index.html`);

  // Extraire tous les fichiers JS
  const jsMatches = htmlContent.match(/src="([^"]*\.js)"/g) || [];
  const jsFiles = jsMatches.map(match => match.replace('src="', '').replace('"', ''));
  
  console.log(`\n2. Fichiers JS trouvés (${jsFiles.length}):`);
  jsFiles.forEach((file, i) => console.log(`   ${i + 1}. ${file}`));

  // Télécharger tous les fichiers JS
  console.log("\n3. Téléchargement des fichiers...");
  
  for (const jsFile of jsFiles) {
    const fullUrl = jsFile.startsWith("http") ? jsFile : BASE + APP_PATH + jsFile;
    const filename = jsFile.split("/").pop();
    await downloadFile(fullUrl, filename);
  }

  // Identifier le bundle principal (main.*.js)
  const mainBundle = jsFiles.find(file => file.includes("main.") && file.endsWith(".js"));
  
  if (mainBundle) {
    console.log(`\n4. Analyse du bundle principal: ${mainBundle}`);
    const mainBundlePath = path.join(usaDir, mainBundle.split("/").pop());
    const bundleContent = fs.readFileSync(mainBundlePath, "utf8");
    
    // Vérification des endpoints critiques
    console.log("\n5. Vérification endpoints critiques...");
    const endpoints = [
      "getUserHistoryApplicantPaymentStatus",
      "pendingAppoStatus",
      "cancellable",
      "applicationId",
      "appointmentrequest/getallbyuser",
      "modifyslot/getFirstAvailableMonth",
      "modifyslot/getSlotDates",
      "modifyslot/getSlotTime",
      "appointments/schedule",
      "appointments/reschedule",
      "appointments/showRescheduleButton",
      "getTransformData",
      "getApplicationDetails",
      "missionId",
      "applicantId",
      "appointmentId",
      "applicantUUID"
    ];
    
    for (const ep of endpoints) {
      const found = bundleContent.includes(ep);
      console.log(`   ${found ? "✅" : "❌"} ${ep}`);
    }

    // Recherche spécifique de la logique pendingAppoStatus/cancellable
    console.log("\n6. Analyse logique pendingAppoStatus/cancellable...");
    
    // Chercher des patterns dans le bundle
    const pendingPatterns = [
      /pendingAppoStatus\s*[=:]\s*0/g,
      /cancellable\s*[=:]\s*true/g,
      /pendingAppoStatus\s*[=:]\s*1/g,
      /getAppIdByUserId/g,
      /synchronizeAccount/g
    ];
    
    for (const pattern of pendingPatterns) {
      const matches = bundleContent.match(pattern);
      if (matches) {
        console.log(`   🔍 ${pattern.source}: ${matches.length} occurrence(s)`);
      }
    }

    // Extraire des extraits de code autour de pendingAppoStatus
    const pendingIndex = bundleContent.indexOf("pendingAppoStatus");
    if (pendingIndex !== -1) {
      const snippet = bundleContent.substring(
        Math.max(0, pendingIndex - 200),
        Math.min(bundleContent.length, pendingIndex + 300)
      );
      console.log(`\n7. Extrait de code autour de 'pendingAppoStatus':`);
      console.log("   ──────────────────────────────────────────");
      console.log(snippet.split("\n").map(line => `   ${line}`).join("\n"));
      console.log("   ──────────────────────────────────────────");
      
      // Sauvegarder l'extrait
      fs.writeFileSync(path.join(usaDir, "pendingAppoStatus-snippet.js"), snippet);
      console.log(`   📝 Extrait sauvegardé: usa/pendingAppoStatus-snippet.js`);
    }

    // Recherche de la logique d'interprétation
    console.log("\n8. Recherche logique d'interprétation des statuts...");
    const logicPatterns = [
      /if\s*\(.*pendingAppoStatus.*\)/g,
      /switch\s*\(.*pendingAppoStatus.*\)/g,
      /pendingAppoStatus\s*[!=]==\s*0/g,
      /pendingAppoStatus\s*[!=]==\s*1/g,
      /cancellable\s*[!=]==\s*true/g,
      /cancellable\s*[!=]==\s*false/g
    ];
    
    let logicFound = false;
    for (const pattern of logicPatterns) {
      const matches = bundleContent.match(pattern);
      if (matches && matches.length > 0) {
        console.log(`   🔍 ${pattern.source}: ${matches.length} occurrence(s)`);
        logicFound = true;
      }
    }
    
    if (!logicFound) {
      console.log("   ⚠️ Aucune logique d'interprétation trouvée directement");
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║   Téléchargement terminé                            ║");
  console.log("║   Fichiers sauvegardés dans: usa/                   ║");
  console.log("╚══════════════════════════════════════════════════════╝");
  console.log(`\n📁 Contenu du dossier 'usa':`);
  const files = fs.readdirSync(usaDir);
  files.forEach((file, i) => {
    const stats = fs.statSync(path.join(usaDir, file));
    console.log(`   ${i + 1}. ${file} (${(stats.size / 1024).toFixed(1)} KB)`);
  });
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
