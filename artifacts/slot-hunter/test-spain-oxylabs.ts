/**
 * test-spain-oxylabs.ts
 *
 * Approche Oxylabs Web Unlocker
 * ─────────────────────────────────────────────────────────────────────────────
 * Stratégie :
 *   1. GET portail via Oxylabs Web Unlocker  → cookies PHPSESSID + cf_clearance
 *      (Oxylabs résout CF dans un vrai browser côté serveur)
 *   2. Fetch /main/ via impit (Chrome TLS) avec ces cookies
 *      (impit a le bon fingerprint TLS, les cookies sont déjà CF-valides)
 *
 * Watchdog 90s — arrêt immédiat si ça bloque.
 *
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-oxylabs.ts
 */
import "dotenv/config";
import nodeFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Impit } from "impit";

// ── Config ────────────────────────────────────────────────────────────────────
const OXY_USER  = process.env.OXYLABS_USERNAME ?? "";
const OXY_PASS  = process.env.OXYLABS_PASSWORD ?? "";
const OXY_HOST  = "unblock.oxylabs.io:60000";
const TARGET    = process.env.TEST_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const UA        = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

// Oxylabs Web Unlocker utilise un certificat TLS auto-signé sur leur proxy
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

// Watchdog 180s (docs Oxylabs : JS rendering peut prendre jusqu'à 180s)
const watchdog = setTimeout(() => {
  console.error("\n⏱️ WATCHDOG 180s — arrêt forcé");
  process.exit(4);
}, 180_000);
watchdog.unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse les Set-Cookie bruts en map name→value */
function parseCookies(raw: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw) {
    const [pair] = line.split(";");
    const [name, ...rest] = pair.trim().split("=");
    if (name) map.set(name.trim(), rest.join("=").trim());
  }
  return map;
}

/** Construit la string Cookie: ordonnée pour Bookitit/CF */
function buildCookieHeader(cookies: Map<string, string>): string {
  const order = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  const parts: string[] = [];
  for (const name of order) {
    const v = cookies.get(name);
    if (v) parts.push(`${name}=${v}`);
  }
  for (const [k, v] of cookies) {
    if (k !== "cf_clearance" && !order.includes(k)) parts.push(`${k}=${v}`);
  }
  const cf = cookies.get("cf_clearance");
  if (cf) parts.push(`cf_clearance=${cf}`);
  return parts.join("; ");
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=".repeat(60));
console.log("TEST Oxylabs Web Unlocker → cookies → impit /main/");
console.log(`  OXYLABS_USERNAME : ${OXY_USER ? "✅ " + OXY_USER : "❌ manquant"}`);
console.log(`  OXYLABS_PASSWORD : ${OXY_PASS ? "✅ (set)" : "❌ manquant"}`);
console.log(`  Proxy            : https://${OXY_HOST}`);
console.log(`  Target           : ${TARGET}`);
console.log("=".repeat(60));

if (!OXY_USER || !OXY_PASS) {
  console.error("❌ OXYLABS_USERNAME / OXYLABS_PASSWORD manquants — arrêt");
  clearTimeout(watchdog);
  process.exit(1);
}

const agent = new HttpsProxyAgent(`https://${OXY_USER}:${OXY_PASS}@${OXY_HOST}`);
const t0 = Date.now();

// ── Étape 0 : test connectivité ───────────────────────────────────────────────
console.log("\n[step0] 🔌 Test connectivité Oxylabs…");
try {
  const probe = await nodeFetch("https://ip.oxylabs.io/location", {
    method: "GET",
    agent,
    headers: { "User-Agent": UA },
  });
  const body = await probe.text();
  console.log(`[step0] ✅ status=${probe.status} body=${body.slice(0, 120)}`);
} catch (e) {
  console.error(`[step0] ❌ Connectivité échouée: ${e}`);
  clearTimeout(watchdog);
  process.exit(1);
}

// ── Étape 1 : GET portail via Oxylabs ─────────────────────────────────────────
console.log(`\n[step1] 🌐 GET portail via Oxylabs Web Unlocker…`);
console.log(`[step1]    URL: ${TARGET}`);

const portalRes = await nodeFetch(TARGET, {
  method: "GET",
  agent,
  timeout: 175_000, // docs Oxylabs : JS rendering jusqu'à 180s
  headers: {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,fr-FR;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Upgrade-Insecure-Requests": "1",
    // JS rendering : Oxylabs exécute un vrai browser côté serveur, résout CF,
    // retourne le HTML final + les cookies de session (PHPSESSID, cf_clearance).
    "X-Oxylabs-Render": "html",
  },
}).catch((e: unknown) => { console.error(`[step1] ❌ Erreur: ${e}`); return null; });

if (!portalRes) { clearTimeout(watchdog); process.exit(1); }

const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[step1] status=${portalRes.status} (${elapsed1}s)`);

// Log tous les Set-Cookie
const rawSetCookies: string[] = [];
portalRes.headers.forEach((val, key) => {
  if (key.toLowerCase() === "set-cookie") {
    rawSetCookies.push(val);
    console.log(`[step1] Set-Cookie: ${val.slice(0, 100)}`);
  }
});
// node-fetch stocke set-cookie en liste séparée
const setCookieList = (portalRes.headers.raw?.() as Record<string, string[]>)?.["set-cookie"] ?? rawSetCookies;

const portalHtml = await portalRes.text().catch(() => "");
console.log(`[step1] body: ${portalHtml.length}B — snippet: "${portalHtml.slice(0, 120).replace(/\n/g, " ")}"`);

const cookies = parseCookies(setCookieList);
const phpSessId  = cookies.get("PHPSESSID") ?? "";
const cfClearance = cookies.get("cf_clearance") ?? "";

console.log(`\n[step1] 🍪 Cookies extraits:`);
console.log(`  PHPSESSID   : ${phpSessId ? phpSessId.slice(0, 30) + "…" : "❌ absent"}`);
console.log(`  cf_clearance: ${cfClearance ? cfClearance.slice(0, 50) + "…" : "❌ absent"}`);
console.log(`  tous        : ${[...cookies.keys()].join(", ")}`);

if (!phpSessId && !cfClearance) {
  console.error("\n❌ Aucun cookie utile obtenu — Oxylabs n'a pas résolu CF ou portail ne définit pas de session");
  console.log("   Vérifier: le compte Oxylabs a-t-il le produit 'Web Unlocker' activé?");
  clearTimeout(watchdog);
  process.exit(2);
}

// ── Étape 2 : /main/ via impit + cookies Oxylabs ─────────────────────────────
console.log(`\n[step2] 🎯 Fetch /main/ via impit (Chrome TLS) + cookies Oxylabs…`);

const impit = new Impit({ browser: "chrome" } as any);

const publickey = TARGET.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const cbName    = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const mainQuery = new URLSearchParams({
  callback: cbName,
  type: "default",
  publickey,
  lang: "es",
  version: "4",
  src: TARGET.replace(/\/?$/, "/"),
  _: String(Date.now()),
});
const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;
console.log(`[step2] URL: ${mainUrl.slice(0, 120)}…`);

const chromeMajor = UA.match(/Chrome\/(\d+)/)?.[1] ?? "142";
const cookieHeader = buildCookieHeader(cookies);

const mainRes = await (impit as any).fetch(mainUrl, {
  method: "GET",
  headers: {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9,fr-FR;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cookie": cookieHeader,
    "Referer": TARGET,
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Ch-Ua": `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
  },
}).catch((e: unknown) => { console.error(`[step2] ❌ impit error: ${e}`); return null; }) as Response | null;

const elapsed2 = ((Date.now() - t0) / 1000).toFixed(1);

if (!mainRes) {
  clearTimeout(watchdog);
  process.exit(1);
}

const mainBody = await mainRes.text().catch(() => "");
const ok = mainBody.length > 100 && !mainBody.trim().startsWith("<!DOCTYPE");

console.log(`[step2] status=${mainRes.status} body=${mainBody.length}B`);
if (mainBody.length > 0) {
  console.log(`[step2] snippet: "${mainBody.slice(0, 200).replace(/\n/g, " ")}"`);
}

// ── Résultat ──────────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(60));
console.log(ok
  ? `✅ SUCCÈS (${elapsed2}s) — /main/ ${mainBody.length}B`
  : `❌ ÉCHEC (${elapsed2}s) — /main/ ${mainBody.length}B (${mainRes.status})`
);
console.log(`   cf_clearance : ${cfClearance ? "✅ obtenu via Oxylabs" : "❌ absent"}`);
console.log(`   PHPSESSID    : ${phpSessId ? "✅ obtenu via Oxylabs" : "❌ absent"}`);
if (!ok && mainBody.length > 0) {
  const isCf = /un instant|just a moment|cloudflare/i.test(mainBody.slice(0, 500));
  console.log(`   /main/ est   : ${isCf ? "⛔ page CF challenge (cf_clearance non accepté par impit)" : "⚠️ réponse inattendue"}`);
}
console.log("=".repeat(60));

clearTimeout(watchdog);
process.exit(ok ? 0 : 2);
