/**
 * test-spain-decodo-unlocker.ts
 *
 * Decodo Scraper API → cookies → impit /main/
 * ─────────────────────────────────────────────────────────────────
 * Endpoint : POST https://scraper-api.decodo.com/v2/scrape
 * Auth     : Authorization: Bearer DECODO_UNLOCKER_TOKEN
 * Réponse  : { results: [{ content, cookies, headers, status_code }] }
 *
 * Stratégie :
 *   1. Scraper le portail via Decodo (avec JS rendering)
 *      → Decodo résout CF dans un vrai browser côté serveur
 *      → on récupère PHPSESSID + cf_clearance dans results[0].cookies
 *   2. Fetch /main/ via impit (Chrome TLS) avec ces cookies
 *
 * Watchdog 180s — arrêt immédiat si ça bloque.
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-spain-decodo-unlocker.ts
 */
import "dotenv/config";
import { Impit } from "impit";

const TOKEN  = process.env.DECODO_UNLOCKER_TOKEN ?? "";
const TARGET = process.env.TEST_PORTAL_URL ??
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const API    = "https://scraper-api.decodo.com/v2/scrape";

// Watchdog 180s
const watchdog = setTimeout(() => {
  console.error("\n⏱️ WATCHDOG 180s — arrêt forcé");
  process.exit(4);
}, 180_000);
watchdog.unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

interface DecodoCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
}

interface DecodoResult {
  content: string;
  headers: Record<string, string>;
  cookies: DecodoCookie[];
  status_code: number;
  task_id?: string;
}

interface DecodoResponse {
  results: DecodoResult[];
}

/** Construit Cookie: header ordonné PHPSESSID avant cf_clearance */
function buildCookieHeader(cookies: DecodoCookie[]): string {
  const map = new Map(cookies.map((c) => [c.name, c.value]));
  const order = ["_ga", "_ga_F3TYSDL945", "PHPSESSID"];
  const parts: string[] = [];
  for (const name of order) {
    const v = map.get(name);
    if (v) parts.push(`${name}=${v}`);
  }
  for (const [k, v] of map) {
    if (k !== "cf_clearance" && !order.includes(k)) parts.push(`${k}=${v}`);
  }
  const cf = map.get("cf_clearance");
  if (cf) parts.push(`cf_clearance=${cf}`);
  return parts.join("; ");
}

/** Appel Decodo Scraper API */
async function decodoScrape(url: string, render: boolean, label: string): Promise<DecodoResult | null> {
  const body: Record<string, unknown> = { url };
  if (render) body["headless"] = "html"; // Decodo : headless=html active le JS rendering

  process.stdout.write(`[${label}] POST ${url.slice(0, 70)} render=${render} … `);
  const t = Date.now();

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(170_000),
    });

    const elapsed = ((Date.now() - t) / 1000).toFixed(1);
    const json = await res.json() as DecodoResponse;
    const r = json?.results?.[0];

    if (!r) {
      console.log(`status=${res.status} — pas de results (${elapsed}s) raw=${JSON.stringify(json).slice(0, 100)}`);
      return null;
    }

    const cookieNames = r.cookies.map((c) => c.name).join(", ") || "aucun";
    console.log(`status=${r.status_code} content=${r.content.length}B cookies=[${cookieNames}] (${elapsed}s)`);
    return r;
  } catch (e: unknown) {
    console.log(`ERR: ${String(e).slice(0, 120)}`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log("=".repeat(65));
console.log("TEST Decodo Scraper API → cookies → impit /main/");
console.log(`  TOKEN  : ${TOKEN ? "✅ (set)" : "❌ manquant"}`);
console.log(`  Target : ${TARGET}`);
console.log("=".repeat(65));

if (!TOKEN) {
  console.error("❌ DECODO_UNLOCKER_TOKEN manquant — arrêt");
  clearTimeout(watchdog);
  process.exit(1);
}

const t0 = Date.now();

// ── Étape 0 : connectivité avec URL simple ────────────────────────────────────
await decodoScrape("https://httpbin.org/get", false, "httpbin-sans-render");
await decodoScrape("https://httpbin.org/get", true,  "httpbin-avec-render");

// ── Étape 1a : portail sans render (rapide) ───────────────────────────────────
console.log("");
const r1 = await decodoScrape(TARGET, false, "portail-sans-render");
if (r1) {
  const hasCf = r1.cookies.some((c) => c.name === "cf_clearance");
  const hasPhp = r1.cookies.some((c) => c.name === "PHPSESSID");
  const isCfPage = /un instant|just a moment|challenge-platform/i.test(r1.content.slice(0, 500));
  console.log(`  → CF page: ${isCfPage ? "⛔ oui" : "✅ non"}  cf_clearance: ${hasCf ? "✅" : "❌"}  PHPSESSID: ${hasPhp ? "✅" : "❌"}`);
}

// ── Étape 1b : portail avec JS rendering ─────────────────────────────────────
console.log("");
console.log("[portail-avec-render] ⏳ JS rendering (peut prendre 30-60s)…");
const r2 = await decodoScrape(TARGET, true, "portail-avec-render");

if (!r2) {
  console.error("\n❌ Decodo n'a pas pu scraper le portail — arrêt");
  clearTimeout(watchdog);
  process.exit(2);
}

const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
const cfCookie   = r2.cookies.find((c) => c.name === "cf_clearance");
const phpCookie  = r2.cookies.find((c) => c.name === "PHPSESSID");

console.log(`\n[étape1] 🍪 Cookies obtenus (${elapsed1}s) :`);
console.log(`  cf_clearance : ${cfCookie  ? "✅ " + cfCookie.value.slice(0, 50) + "…"  : "❌ absent"}`);
console.log(`  PHPSESSID    : ${phpCookie ? "✅ " + phpCookie.value.slice(0, 30) + "…" : "❌ absent"}`);
console.log(`  tous         : [${r2.cookies.map((c) => c.name).join(", ")}]`);
console.log(`  content      : ${r2.content.length}B — snippet: "${r2.content.slice(0, 120).replace(/\n/g, " ")}"`);

if (!phpCookie && !cfCookie) {
  console.error("\n❌ Aucun cookie CF/PHP — Decodo n'a pas résolu la session Bookitit");
  clearTimeout(watchdog);
  process.exit(2);
}

// ── Étape 2 : /main/ via impit + cookies Decodo ───────────────────────────────
console.log(`\n[étape2] 🎯 Fetch /main/ via impit (Chrome TLS) + cookies Decodo…`);

const impit = new Impit({ browser: "chrome" } as any);

const publickey = TARGET.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const cbName    = `jQueryBooking${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const mainQuery = new URLSearchParams({
  callback: cbName, type: "default", publickey, lang: "es",
  version: "4", src: TARGET.replace(/\/?$/, "/"), _: String(Date.now()),
});
const mainUrl = `https://www.citaconsular.es/onlinebookings/main/?${mainQuery}`;

const chromeMajor = UA.match(/Chrome\/(\d+)/)?.[1] ?? "142";
const cookieHeader = buildCookieHeader(r2.cookies);
console.log(`  Cookie: ${cookieHeader.slice(0, 100)}…`);

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
}).catch((e: unknown) => { console.error(`[étape2] ❌ impit: ${e}`); return null; }) as Response | null;

const elapsed2 = ((Date.now() - t0) / 1000).toFixed(1);

if (!mainRes) { clearTimeout(watchdog); process.exit(1); }

const mainBody = await mainRes.text().catch(() => "");
const isCfBlock = /un instant|just a moment|challenge-platform/i.test(mainBody.slice(0, 500));
const ok = mainBody.length > 100 && !isCfBlock && !mainBody.trim().startsWith("<!DOCTYPE");

console.log(`  status=${mainRes.status} body=${mainBody.length}B isCfBlock=${isCfBlock}`);
if (mainBody.length > 0) {
  console.log(`  snippet: "${mainBody.slice(0, 200).replace(/\n/g, " ")}"`);
}

// ── Résultat final ────────────────────────────────────────────────────────────
console.log("\n" + "=".repeat(65));
console.log(ok
  ? `✅ SUCCÈS (${elapsed2}s) — /main/ ${mainBody.length}B reçu`
  : `❌ ÉCHEC  (${elapsed2}s) — /main/ ${mainBody.length}B (${mainRes.status})${isCfBlock ? " [CF block]" : ""}`
);
console.log(`   cf_clearance : ${cfCookie  ? "✅ obtenu via Decodo" : "❌ absent"}`);
console.log(`   PHPSESSID    : ${phpCookie ? "✅ obtenu via Decodo" : "❌ absent"}`);
console.log("=".repeat(65));

clearTimeout(watchdog);
process.exit(ok ? 0 : 2);
