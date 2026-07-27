/**
 * test-validate-cookie.ts — Valide un cf_clearance obtenu via CapSolver
 * Usage: CAPSOLVER_API_KEY=xxx npx tsx test-validate-cookie.ts
 */

import { execSync } from "child_process";

const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const RAW_PROXY    = process.env.PROXY_2CAPTCHA ?? "";

if (!CAPSOLVER_KEY) { console.error("❌ Manque CAPSOLVER_API_KEY"); process.exit(1); }
if (!RAW_PROXY)     { console.error("❌ Manque PROXY_2CAPTCHA");    process.exit(1); }

// ─── Parse proxy (host:port:user:pass ou http://user:pass@host:port) ──────────
function normalizeProxy(raw: string): string {
  const s = raw.startsWith("http") ? raw : `http://${raw}`;
  try {
    const u = new URL(s);
    if (u.username) return s; // déjà standard
  } catch { /* fall through */ }
  const bare = s.replace(/^https?:\/\//, "");
  const parts = bare.split(":");
  if (parts.length < 4) throw new Error(`Format proxy non reconnu: ${raw}`);
  const [host, port, user, ...passParts] = parts;
  const pass = passParts.join(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
}

const PROXY = normalizeProxy(RAW_PROXY);
const PROXY_SAFE = PROXY.replace(/:([^:@]+)@/, ":<PASS>@");

const TARGET = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

// ─── 1. Vérifier IP du proxy ──────────────────────────────────────────────────
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  Validation cookie CF + proxy 2captcha");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`Proxy  : ${PROXY_SAFE}\n`);

try {
  const ipRaw = execSync(`curl -s --proxy "${PROXY}" "http://ip-api.com/json/?fields=query,country,countryCode,city,org" --max-time 15`, { encoding: "utf8" });
  const ip = JSON.parse(ipRaw);
  console.log(`IP proxy : ${ip.query}  |  ${ip.country} (${ip.countryCode})  |  ${ip.city}`);
  console.log(`ASN      : ${ip.org}`);
  if (ip.countryCode === "ES") console.log("✅ IP espagnole !");
  else console.warn(`⚠️  IP non-espagnole (${ip.countryCode})`);
} catch (e) {
  console.warn(`⚠️  Impossible de vérifier IP: ${e instanceof Error ? e.message : e}`);
}

// ─── 2. Solve CF ──────────────────────────────────────────────────────────────
console.log("\n🚀 Lancement AntiCloudflareTask…");

const proxyForCapsolver = PROXY.replace(/^http:\/\/([^:]+):([^@]+)@(.+)$/, "http://$1:$2@$3");
const t0 = Date.now();

const createRes = await fetch("https://api.capsolver.com/createTask", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    clientKey: CAPSOLVER_KEY,
    task: { type: "AntiCloudflareTask", websiteURL: TARGET, proxy: proxyForCapsolver },
  }),
  signal: AbortSignal.timeout(30_000),
});
const create = await createRes.json() as { errorId: number; taskId?: string; errorDescription?: string; errorCode?: string };
if (create.errorId !== 0 || !create.taskId) {
  console.error(`❌ createTask échoué: ${create.errorDescription ?? create.errorCode}`);
  process.exit(1);
}
console.log(`Task : ${create.taskId}`);

let cfClearance = "";
let ua = "";
let cookies: Record<string, string> = {};

for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 5_000));
  const poll = await fetch("https://api.capsolver.com/getTaskResult", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: create.taskId }),
    signal: AbortSignal.timeout(15_000),
  }).then(r => r.json()) as { errorId: number; status?: string; errorCode?: string; errorDescription?: string; solution?: { cookies?: Record<string, string>; token?: string; userAgent?: string } };

  if (poll.status === "ready" && poll.solution) {
    cfClearance = poll.solution.cookies?.["cf_clearance"] ?? poll.solution.token ?? "";
    ua = poll.solution.userAgent ?? "";
    cookies = poll.solution.cookies ?? {};
    break;
  }
  if (poll.errorId !== 0) {
    const code = poll.errorCode ?? `errorId=${poll.errorId}`;
    if (code.includes("UNSOLVABLE") || code.includes("ERROR_PROXY")) {
      console.error(`❌ Erreur fatale: ${code}`); process.exit(1);
    }
    if (i % 4 === 0) console.log(`  Poll #${i+1} — ${code}`);
    continue;
  }
  if (poll.status === "failed") { console.error(`❌ Task failed`); process.exit(1); }
  if (i % 4 === 0) console.log(`  Poll #${i+1} — en cours (${Math.round((Date.now()-t0)/1000)}s)`);
}

if (!cfClearance) { console.error("❌ Pas de cf_clearance (timeout)"); process.exit(1); }

const elapsed = Math.round((Date.now() - t0) / 1000);
console.log(`\n✅ Solve réussi en ${elapsed}s`);
console.log(`cf_clearance : ${cfClearance.slice(0, 60)}…`);
console.log(`User-Agent   : ${ua.slice(0, 80)}`);

// ─── 3. Valider le cookie sur citaconsular.es ─────────────────────────────────
console.log("\n🔍 Test du cookie sur citaconsular.es…");

const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

// Écrire un script curl dans /tmp pour éviter les problèmes de quoting shell
const curlScript = `/tmp/test_cf_curl.sh`;
const scriptContent = `#!/bin/sh
curl -s -o /tmp/cf_response.html \\
  --proxy '${PROXY}' \\
  -H 'User-Agent: ${ua}' \\
  -H 'Cookie: ${cookieHeader}' \\
  -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \\
  -H 'Accept-Language: es-ES,es;q=0.9' \\
  --max-time 25 \\
  -w '%{http_code}' \\
  '${TARGET}'
`;
const { writeFileSync, chmodSync } = await import("fs");
writeFileSync(curlScript, scriptContent);
chmodSync(curlScript, "755");

try {
  const httpCode = execSync(`sh ${curlScript}`, { encoding: "utf8" }).trim();
  const size = execSync(`wc -c < /tmp/cf_response.html`, { encoding: "utf8" }).trim();
  const sizeN = parseInt(size);

  console.log(`HTTP status    : ${httpCode}`);
  console.log(`Taille réponse : ${sizeN} bytes`);

  if (httpCode === "200" && sizeN > 2000) {
    console.log("\n🎉 SUCCÈS — Le cookie fonctionne !");
    console.log("   → La configuration 2captcha + CapSolver est opérationnelle.\n");
    // Afficher un extrait du HTML
    const snippet = execSync(`head -c 300 /tmp/cf_response.html`, { encoding: "utf8" });
    console.log("Extrait HTML :\n" + snippet);
  } else if (httpCode === "403") {
    console.log("\n❌ 403 — Cloudflare rejette le cookie.");
    console.log("   Causes possibles :");
    console.log("   • IP non-espagnole (vérifier le ciblage pays dans la zone 2captcha)");
    console.log("   • Cookie lié à une autre IP (le solve s'est fait depuis une IP différente de la validation)");
  } else if (httpCode === "200" && sizeN < 2000) {
    console.log("\n⚠️  200 mais réponse trop petite — possible challenge JS interstitiel");
    const snippet = execSync(`head -c 500 /tmp/cf_response.html`, { encoding: "utf8" });
    console.log("Extrait:\n" + snippet);
  } else {
    console.log(`\n⚠️  Status inattendu: ${httpCode} / ${sizeN}b`);
  }
} catch (e) {
  console.error(`❌ Erreur curl: ${e instanceof Error ? e.message : e}`);
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`RÉSUMÉ : cf_clearance=${cfClearance ? "✅" : "❌"} | Durée=${elapsed}s`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
