/**
 * extract-france-sources.js — Récupère les source maps (.js.map) des chunks du portail
 * France/Troov et reconstruit les SOURCES ORIGINALES non minifiées à partir de
 * `sourcesContent`. Les .js.map sont publiquement accessibles (HTTP 200 confirmé),
 * ce qui donne le code Vue/JS lisible (vrais noms de fonctions, chemins d'API).
 *
 * Usage : node bundle-analysis/extract-france-sources.js
 * Prérequis : avoir lancé download-france-bundle.js (france-bundle/*.js présents).
 * Sortie : bundle-analysis/france-bundle/sources/<arborescence source d'origine>
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = "https://consulat.gouv.fr";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const BUNDLE_DIR = path.join(__dirname, "france-bundle");
const SOURCES_DIR = path.join(BUNDLE_DIR, "sources");

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    https
      .get(
        {
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: { "User-Agent": UA, Accept: "*/*", Referer: BASE + "/" },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return resolve(httpsGet(new URL(res.headers.location, url).href));
          }
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        },
      )
      .on("error", reject);
  });
}

/** Nettoie un chemin source webpack pour un chemin de fichier sûr sur disque. */
function safeSourcePath(src) {
  return src
    .replace(/^webpack:\/\//, "")
    .replace(/[?#].*$/, "")
    .replace(/[<>:"|*]/g, "_")
    .replace(/\.\.(\/|\\)/g, "__/") // neutralise les remontées de répertoire
    .replace(/^\/+/, "");
}

async function main() {
  if (!fs.existsSync(BUNDLE_DIR)) {
    console.error("❌ france-bundle/ absent — lancer d'abord download-france-bundle.js");
    process.exit(1);
  }
  if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });

  // Les chunks locaux téléchargés (on ignore bootstrap CDN).
  const chunks = fs
    .readdirSync(BUNDLE_DIR)
    .filter((f) => f.endsWith(".js") && f !== "page.html");

  let totalSources = 0;
  const interestingFiles = [];

  for (const chunk of chunks) {
    const mapUrl = `${BASE}/app/${chunk}.map`;
    const { status, body } = await httpsGet(mapUrl);
    if (status !== 200 || body.length < 100) {
      console.log(`   ⚠️  ${chunk}.map — HTTP ${status} (ignoré)`);
      continue;
    }
    let map;
    try {
      map = JSON.parse(body);
    } catch {
      console.log(`   ⚠️  ${chunk}.map — JSON invalide (ignoré)`);
      continue;
    }
    const sources = map.sources ?? [];
    const contents = map.sourcesContent ?? [];
    if (contents.length === 0) {
      console.log(`   ⚠️  ${chunk}.map — pas de sourcesContent (ignoré)`);
      continue;
    }

    let written = 0;
    for (let i = 0; i < sources.length; i++) {
      const content = contents[i];
      if (typeof content !== "string" || content.length === 0) continue;
      // Filtrer le bruit node_modules : on garde surtout le code applicatif Troov.
      const rel = safeSourcePath(sources[i]);
      if (rel.includes("node_modules")) continue;
      const outPath = path.join(SOURCES_DIR, rel);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, content);
      written++;
      totalSources++;

      // Repérer les fichiers d'intérêt (API, services, store, appointment, reservation).
      const low = rel.toLowerCase();
      if (
        /api|service|store|appointment|reservation|availab|booking|team|captcha|turnstile|http|axios|repository/.test(
          low,
        )
      ) {
        interestingFiles.push(rel);
      }
    }
    console.log(`   ✅ ${chunk}.map — ${written} source(s) applicative(s) extraite(s)`);
  }

  console.log(`\n✅ ${totalSources} fichier(s) source extrait(s) → bundle-analysis/france-bundle/sources/`);
  console.log(`\nFichiers d'intérêt (API / services / réservation) :`);
  [...new Set(interestingFiles)].sort().forEach((f) => console.log(`   ${f}`));
}

main().catch((e) => {
  console.error("Erreur:", e.message);
  process.exit(1);
});
