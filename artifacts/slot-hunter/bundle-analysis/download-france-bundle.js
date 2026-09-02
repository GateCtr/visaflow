/**
 * download-france-bundle.js — Télécharge le bundle JS du portail visas nationaux France
 * (consulat.gouv.fr, éditeur Troov, framework Nuxt.js / Vue SSR).
 *
 * Le portail est une SPA Nuxt : le HTML sert des chunks webpack depuis /app/*.js (+ /js/main.js).
 * Les noms de chunks portent un hash qui change à CHAQUE déploiement — on les extrait donc
 * DYNAMIQUEMENT du HTML (jamais de hardcode, sinon obsolète au prochain build).
 *
 * L'API backend est https://api.consulat.gouv.fr/api (REST).
 *
 * Usage : node bundle-analysis/download-france-bundle.js
 * Sortie : bundle-analysis/france-bundle/*.js + france-bundle.js (concaténé)
 */
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE = "https://consulat.gouv.fr";
// Page RDV Service des Visas — Ambassade de France à Kinshasa (cible du hunter).
const PAGE_PATH =
  "/ambassade-de-france-a-kinshasa/rendez-vous?name=Service%20des%20Visas";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const OUT_DIR = path.join(__dirname, "france-bundle");

/** GET HTTPS avec suivi de redirections et User-Agent navigateur. */
function httpsGet(url, referer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "fr-FR,fr;q=0.9",
        ...(referer ? { Referer: referer } : {}),
      },
    };
    https
      .get(opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpsGet(new URL(res.headers.location, url).href, referer));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      })
      .on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Récupérer le HTML de la page RDV.
  console.log(`1. GET ${BASE}${PAGE_PATH}`);
  const { status, body: html, headers } = await httpsGet(BASE + PAGE_PATH);
  console.log(`   HTTP ${status} — ${(html.length / 1024).toFixed(1)} KB`);
  console.log(`   server=${headers.server ?? "?"} | cf-ray=${headers["cf-ray"] ?? "(aucun)"}`);
  if (status !== 200) {
    console.error("   ❌ Page inaccessible");
    process.exit(1);
  }
  fs.writeFileSync(path.join(OUT_DIR, "page.html"), html);

  // 2. Extraire dynamiquement les URLs de scripts (/app/*.js, /js/*.js).
  const scriptUrls = new Set();
  const reSrc = /(?:src|href)="([^"]*\/(?:app|js)\/[^"]*\.js[^"]*)"/g;
  let m;
  while ((m = reSrc.exec(html)) !== null) {
    scriptUrls.add(m[1].startsWith("http") ? m[1] : BASE + m[1]);
  }
  // Aussi capter les preload.
  const rePreload = /rel="preload"\s+href="([^"]*\.js[^"]*)"/g;
  while ((m = rePreload.exec(html)) !== null) {
    scriptUrls.add(m[1].startsWith("http") ? m[1] : BASE + m[1]);
  }

  const urls = [...scriptUrls];
  console.log(`\n2. ${urls.length} chunk(s) JS détecté(s) :`);
  urls.forEach((u) => console.log(`     ${u.replace(BASE, "")}`));

  if (urls.length === 0) {
    console.error("   ❌ Aucun chunk JS trouvé — le format du HTML a peut-être changé.");
    process.exit(1);
  }

  // 3. Télécharger chaque chunk.
  console.log("\n3. Téléchargement des chunks…");
  let concat = "";
  let totalKB = 0;
  for (const url of urls) {
    const r = await httpsGet(url, BASE + PAGE_PATH);
    const kb = r.body.length / 1024;
    totalKB += kb;
    const name = url.split("/").pop().split("?")[0];
    fs.writeFileSync(path.join(OUT_DIR, name), r.body);
    concat += `\n\n/* ─────── ${url.replace(BASE, "")} (${kb.toFixed(1)} KB) ─────── */\n` + r.body;
    console.log(`   ${r.status === 200 ? "✅" : "❌"} ${name} — ${kb.toFixed(1)} KB`);
  }

  const concatPath = path.join(__dirname, "france-bundle.js");
  fs.writeFileSync(concatPath, concat);
  console.log(`\n✅ Bundle concaténé: bundle-analysis/france-bundle.js (${totalKB.toFixed(0)} KB total)`);
  console.log(`   Chunks individuels: bundle-analysis/france-bundle/`);

  // 4. Détection rapide d'endpoints / mots-clés d'intérêt pour le reverse.
  console.log("\n4. Détection d'endpoints & patterns (dans le bundle concaténé) :");
  const keywords = [
    "api.consulat.gouv.fr",
    "/api/",
    "appointment",
    "rendez-vous",
    "availabilit", // availabilities / availability
    "slot",
    "creneau",
    "reservation",
    "booking",
    "captcha",
    "recaptcha",
    "hcaptcha",
    "turnstile",
    "authorization",
    "Bearer",
    "team", // Troov "team" = entité consulat
    "service",
    "getAvailab",
    "book",
  ];
  for (const kw of keywords) {
    const count = concat.split(kw).length - 1;
    console.log(`   ${count > 0 ? "✅" : "❌"} ${kw}${count > 0 ? ` (${count}×)` : ""}`);
  }

  // 5. Extraire les chemins d'API littéraux ("/api/..." et URLs api.consulat.gouv.fr).
  console.log("\n5. Chemins d'API littéraux repérés (échantillon) :");
  const apiPaths = new Set();
  const reApi = /["'`](\/api\/[a-zA-Z0-9_\-/{}:.]+)["'`]/g;
  while ((m = reApi.exec(concat)) !== null) apiPaths.add(m[1]);
  const reApiHost = /https?:\\?\/\\?\/api\.consulat\.gouv\.fr(\/api\/[a-zA-Z0-9_\-/{}:.]*)?/g;
  while ((m = reApiHost.exec(concat)) !== null) if (m[1]) apiPaths.add(m[1]);
  const sample = [...apiPaths].slice(0, 60);
  sample.forEach((p) => console.log(`     ${p}`));
  console.log(`   (${apiPaths.size} chemin(s) unique(s) au total)`);
  fs.writeFileSync(
    path.join(OUT_DIR, "api-paths.txt"),
    [...apiPaths].sort().join("\n"),
  );
  console.log(`   → liste complète: bundle-analysis/france-bundle/api-paths.txt`);
}

main().catch((err) => {
  console.error("Erreur:", err.message);
  process.exit(1);
});
