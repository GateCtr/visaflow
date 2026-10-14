/**
 * extract-usvs-inline.mjs — Extrait les scripts inline du HTML capturé de
 * usvisascheduling.com et les sauvegarde en fichiers .js séparés + un index.
 *
 * Usage : node bundle-analysis/extract-usvs-inline.mjs [dateDir]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dateDir = process.argv[2] || new Date().toISOString().slice(0, 10);
const dir = path.join(__dirname, "usvisascheduling", dateDir);
const htmlPath = path.join(dir, "index.html");

if (!fs.existsSync(htmlPath)) {
  console.error(`❌ index.html introuvable : ${htmlPath}`);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, "utf-8");
const scriptRe = /<script([^>]*)>([\s\S]*?)<\/script>/gi;

let m;
let i = 0;
const index = [];
while ((m = scriptRe.exec(html)) !== null) {
  const attrs = m[1].trim();
  const body = m[2];
  i += 1;
  // Détecter un src externe (rare ici)
  const srcMatch = /src=["']([^"']+)["']/.exec(attrs);
  const typeMatch = /type=["']([^"']+)["']/.exec(attrs);
  const type = typeMatch ? typeMatch[1] : "application/javascript";

  if (srcMatch) {
    index.push({ i, kind: "external", src: srcMatch[1], type, bytes: 0 });
    continue;
  }
  if (!body.trim()) continue;

  // Nom de fichier selon type
  const ext = /handlebars|template|html/i.test(type) ? "hbs" : "js";
  const fname = `inline-${String(i).padStart(2, "0")}.${ext}`;
  fs.writeFileSync(path.join(dir, fname), body);
  index.push({ i, kind: "inline", type, filename: fname, bytes: body.length });
  console.log(`  📄 ${fname} (${(body.length / 1024).toFixed(1)} KB) type=${type}`);
}

fs.writeFileSync(path.join(dir, "scripts-index.json"), JSON.stringify(index, null, 2));

// Résumé analytique rapide sur le plus gros bundle inline
const biggest = index.filter((e) => e.kind === "inline").sort((a, b) => b.bytes - a.bytes)[0];
if (biggest) {
  const code = fs.readFileSync(path.join(dir, biggest.filename), "utf-8");
  const keywords = [
    "ember", "handlebars", "jsonp", "/api/", "https://", "appointment",
    "schedule", "reschedule", "slot", "captcha", "login", "oauth", "token",
    "csrf", "salesforce", "visualforce",
  ];
  console.log(`\n🔎 Analyse de ${biggest.filename} (${(biggest.bytes / 1024).toFixed(1)} KB) :`);
  for (const kw of keywords) {
    const c = (code.match(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) || []).length;
    if (c > 0) console.log(`   ${kw.padEnd(14)} : ${c}`);
  }
  // Extraire les URLs absolues et chemins d'API visibles
  const urls = [...new Set((code.match(/https?:\/\/[a-zA-Z0-9._\-/]+/g) || []))].slice(0, 40);
  fs.writeFileSync(path.join(dir, "extracted-urls.txt"), urls.join("\n"));
  console.log(`\n   ${urls.length} URL(s) absolue(s) distinctes → extracted-urls.txt`);
}

console.log(`\n✅ ${index.length} script(s) traité(s). Index → scripts-index.json`);
console.log(`📁 ${dir}`);
