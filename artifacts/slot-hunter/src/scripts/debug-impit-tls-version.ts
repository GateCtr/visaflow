/**
 * debug-impit-tls-version.ts — Teste l'alignement TLS JA3/JA4 ↔ UA.
 *
 * Hypothèse : impit imite au max chrome142 en TLS, mais WORKER_UA annonce Chrome/151
 * → mismatch TLS↔UA → CF rejette le cf_clearance (403).
 *
 * Protocole : on obtient un cf_clearance VALIDE via le navigateur (PB), puis on le rejoue
 * via impit avec DIFFÉRENTES versions TLS, chacune avec un UA ASSORTI à la version TLS.
 */

import "dotenv/config";
process.env.SPAIN_SESSION_MODE = "persistent-browser";
import { Impit } from "impit";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }
function stillCf(b: string) { return /just a moment|_cf_chl_opt/i.test(b.slice(0, 3000)); }

// UA assortis à chaque version TLS impit
const PROFILES: Array<{ tls: string; ua: string }> = [
  { tls: "chrome142", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" },
  { tls: "chrome136", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" },
  { tls: "chrome131", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
];

async function rejouer(label: string, proxy: string, tls: string, ua: string, cookie: string) {
  const impit = new Impit({ browser: tls as any, proxyUrl: proxy, timeout: 60_000 } as any);
  try {
    const r = await (impit.fetch(URL, {
      headers: {
        "User-Agent": ua,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Cookie": cookie,
      },
    } as any) as any);
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
  console.log("═══ Session navigateur (clearance valide) ═══");
  const session = await ensureSpainPersistentBrowserSession(URL.split("#")[0]);
  if (!session) { console.error("❌ PB échoué"); process.exit(1); }
  const cookie = (session.allCookies ?? []).map(c => `${c.name}=${c.value}`).join("; ");
  console.log(`UA navigateur: ${session.userAgent}`);
  console.log(`cf_clearance : ${session.cfClearance?.length}B | cookies: ${(session.allCookies ?? []).map(c=>c.name).join(", ")}`);

  console.log("\n═══ Rejeu via impit avec TLS aligné sur UA ═══");
  for (const p of PROFILES) {
    await rejouer(`${p.tls}`, proxy, p.tls, p.ua, cookie);
  }

  console.log("\n═══ VERDICT ═══");
  console.log("Si une version passe (token ✅) → fix = aligner browser TLS impit + UA sur cette version.");
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
