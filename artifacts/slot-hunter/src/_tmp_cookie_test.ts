import { parseSetCookies } from "./spain-cookie-parser.js";

const cases: Array<[string, string, string]> = [
  // PHPSESSID avec virgule interne (cas Kinshasa)
  ["PHPSESSID=Gn0w,I8xABCDEF; path=/; HttpOnly, cf_clearance=abc123; path=/; Secure", "Gn0w,I8xABCDEF", "abc123"],
  // PHPSESSID sans virgule (cas Saopola)
  ["PHPSESSID=ODhjnKo0Q9HV; path=/, cf_clearance=xyz789; path=/", "ODhjnKo0Q9HV", "xyz789"],
  // Valeur commençant par virgule encodée décodée en littéral
  ["PHPSESSID=,rSomeValue123; path=/", ",rSomeValue123", ""],
  // Expires avec virgule de date (ne doit pas casser)
  ["PHPSESSID=abc123; expires=Wed, 09 Jun 2027 10:18:14 GMT; path=/", "abc123", ""],
];

let ok = true;
for (const [raw, expectPhp, expectCf] of cases) {
  const r = parseSetCookies(raw);
  const phpOk = r.PHPSESSID === expectPhp;
  const cfOk = (r.cf_clearance ?? "") === expectCf;
  console.log(`${phpOk && cfOk ? "✅" : "❌"} PHPSESSID=${JSON.stringify(r.PHPSESSID)} (attendu ${JSON.stringify(expectPhp)}) | cf=${JSON.stringify(r.cf_clearance ?? "")}`);
  if (!phpOk || !cfOk) ok = false;
}
console.log(ok ? "\nTOUS OK — les PHPSESSID avec virgule sont préservés" : "\nECHEC");
process.exit(ok ? 0 : 1);
