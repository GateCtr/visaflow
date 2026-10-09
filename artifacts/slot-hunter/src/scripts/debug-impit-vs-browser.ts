/**
 * debug-impit-vs-browser.ts — Isole CE QUI manque à impit vs le navigateur.
 *
 * 1. Lance le persistent-browser → obtient une session CF QUI MARCHE (cf_clearance + PHPSESSID)
 *    sur une IP donnée (DECODO_PROXY_URL).
 * 2. Rejoue le GET widget VIA IMPIT sur la MÊME IP, avec le clearance du navigateur,
 *    en testant plusieurs profils de headers :
 *      A. minimal (actuel prod : UA + Cookie)
 *      B. full-Chrome (UA + Accept + Accept-Language + sec-ch-ua + Sec-Fetch-* + Cookie)
 *    → Si A échoue et B passe : le problème est les HEADERS manquants.
 *    → Si A et B échouent avec un clearance pourtant valide : le problème est le TLS impit.
 */

import "dotenv/config";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

import { Impit } from "impit";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }
function stillCf(b: string) { return /just a moment|_cf_chl_opt/i.test(b.slice(0, 3000)); }

async function tryImpit(label: string, proxy: string, ua: string, cookie: string, headers: Record<string, string>) {
  const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 60_000 } as any);
  try {
    const r = await (impit.fetch(URL, { headers } as any) as any);
    const b = await r.text();
    console.log(`  [${label}] HTTP ${r.status} | ${b.length}B | token=${hasToken(b) ? "✅" : "❌"} | encoreCF=${stillCf(b) ? "OUI" : "non"}`);
    return hasToken(b);
  } catch (e) {
    console.log(`  [${label}] ERREUR: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

async function main() {
  const proxy = process.env.DECODO_PROXY_URL ?? "";
  if (!proxy) { console.error("❌ DECODO_PROXY_URL requis"); process.exit(1); }

  const { ensureSpainPersistentBrowserSession } = await import("../_legacy_spain-persistent-browser.js");
  console.log("═══ 1. Session via navigateur (qui marche) ═══");
  const session = await ensureSpainPersistentBrowserSession(URL.split("#")[0]);
  if (!session) { console.error("❌ PB session échouée"); process.exit(1); }

  const ua = session.userAgent;
  const cookie = (session.allCookies ?? []).map(c => `${c.name}=${c.value}`).join("; ");
  const cf = session.cfClearance;
  console.log(`UA navigateur : ${ua}`);
  console.log(`cf_clearance  : ${cf ? cf.length + "B" : "∅"}`);
  console.log(`cookies       : ${(session.allCookies ?? []).map(c => c.name).join(", ")}`);

  console.log("\n═══ 2. Rejeu du MÊME clearance via impit (même IP) ═══");

  // A. Profil minimal actuel (prod)
  await tryImpit("A/minimal", proxy, ua, cookie, {
    "User-Agent": ua,
    "Cookie": cookie,
  });

  // B. Profil full-Chrome (headers + client hints, ordre réaliste)
  await tryImpit("B/full-chrome", proxy, ua, cookie, {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "sec-ch-ua": '"Chromium";v="151", "Not.A/Brand";v="24", "Google Chrome";v="151"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
    "Cookie": cookie,
  });

  // C. Full-Chrome SANS cf_clearance (contrôle : vérifier qu'on retombe sur le challenge)
  await tryImpit("C/full-no-cf", proxy, ua, cookie.replace(/cf_clearance=[^;]+;?\s*/,""), {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
    "Cookie": cookie.replace(/cf_clearance=[^;]+;?\s*/,""),
  });

  console.log("\n═══ VERDICT ═══");
  console.log("Si A ❌ et B ✅ → ce sont les HEADERS manquants (fix simple côté impit).");
  console.log("Si A ❌ et B ❌ (avec clearance navigateur valide) → TLS impit incompatible.");
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
