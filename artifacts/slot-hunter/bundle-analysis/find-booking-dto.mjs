/**
 * find-booking-dto.mjs — Extrait le contexte de construction du body de booking
 * (addFamilyReservations → reservations[]) et des étapes de session dans le bundle
 * concaténé France/Troov, pour documenter les DTOs exacts attendus par l'API.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(__dirname, "france-bundle.js"), "utf8");

function contexts(needle, before = 40, after = 260, max = 5) {
  const out = [];
  let i = 0;
  while ((i = bundle.indexOf(needle, i)) >= 0 && out.length < max) {
    const s = Math.max(0, i - before);
    out.push(bundle.slice(s, i + needle.length + after).replace(/\s+/g, " "));
    i += needle.length;
  }
  return out;
}

for (const kw of [
  "addFamilyReservations",
  "reservations:",
  "firstname",
  "lastname",
  "slots:",
  "serviceName",
  "standaloneServiceName",
  "askConfirmationStep",
  "mainContactDetailsStep",
]) {
  const ctx = contexts(kw);
  console.log(`\n═══ "${kw}" (${ctx.length}) ═══`);
  ctx.forEach((c) => console.log("  …" + c + "…"));
}
