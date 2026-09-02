/**
 * find-turnstile-sitekey.mjs — Cherche la sitekey Turnstile + le contexte de rendu du
 * widget dans le bundle concaténé France/Troov (lignes minifiées très longues → on
 * scanne le contenu brut avec indexOf, pas ligne par ligne).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(__dirname, "france-bundle.js"), "utf8");

function contexts(needle, span = 90, max = 8) {
  const out = [];
  let i = 0;
  const low = bundle.toLowerCase();
  const n = needle.toLowerCase();
  while ((i = low.indexOf(n, i)) >= 0 && out.length < max) {
    const s = Math.max(0, i - span);
    out.push(bundle.slice(s, i + needle.length + span).replace(/\s+/g, " "));
    i += needle.length;
  }
  return out;
}

for (const kw of ["sitekey", "turnstile", "TURNSTILE", "data-sitekey", "0x4AAAAA", "challenges.cloudflare"]) {
  const ctx = contexts(kw);
  console.log(`\n═══ "${kw}" (${ctx.length}) ═══`);
  ctx.forEach((c) => console.log("  …" + c + "…"));
}

// Recherche directe d'une sitekey Turnstile (format 0x + 22 chars base62).
const skMatches = [...bundle.matchAll(/0x4[A-Za-z0-9_-]{20,}/g)].map((m) => m[0]);
console.log(`\n═══ sitekeys 0x4… détectées: ${[...new Set(skMatches)].join(", ") || "AUCUNE"} ═══`);
