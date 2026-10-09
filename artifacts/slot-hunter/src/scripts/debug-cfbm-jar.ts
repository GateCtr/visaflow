/**
 * debug-cfbm-jar.ts — Piste A : inspecter précisément les cookies à chaque étape.
 *
 * Question : le GET initial pose-t-il __cf_bm ? CapSolver renvoie-t-il __cf_bm ?
 * Le GET post-solve renvoie-t-il bien __cf_bm + cf_clearance ensemble, et que répond CF ?
 *
 * On fait tout À LA MAIN (pas initWorkerSession) pour voir chaque Set-Cookie et chaque statut.
 */
import "dotenv/config";
import { Impit } from "impit";
import { solveSpainCloudflare } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";
import { parseSetCookiesFromHeaders } from "../spain-cookie-parser.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const START = Number(process.env.START_INDEX ?? 8888);
const N = Number(process.env.SWEEP_N ?? 3);

function addSticky(url: string, sid: string): string {
  return url.replace(/-sessionduration-/, `-session-${sid}-sessionduration-`);
}
const jarStr = (j: Record<string, string>) =>
  Object.entries(j).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
const names = (j: Record<string, string>) => Object.keys(j).join(",") || "(aucun)";
const hasToken = (b: string) => /name="token"\s+value="([^"]+)"/i.test(b) || /bkt_init_widget/i.test(b);
const isCf = (b: string, s: number) => s === 403 || /just a moment|_cf_chl_opt|cf-mitigated/i.test(b.slice(0, 3000));

async function main() {
  const KEY = (process.env.CAPSOLVER_API_KEY ?? "").trim();
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const size = getDecodoPoolSize();

  for (let i = 0; i < N; i++) {
    const base = getDecodoProxyForIndex((START + i) % size) ?? "";
    const sid = Math.random().toString(36).slice(2, 10);
    const proxy = addSticky(base, sid);
    const port = (base.match(/:(\d+)$/) ?? [])[1] ?? "?";
    console.log(`\n═══ #${i + 1} port ${port} sid ${sid} ═══`);

    const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 120_000 } as any);
    const jar: Record<string, string> = {};

    // 1) GET initial
    const r1 = await (impit.fetch(URL, { headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8" } } as any) as unknown as Promise<Response>);
    const b1 = await r1.text();
    Object.assign(jar, parseSetCookiesFromHeaders(r1.headers as any));
    console.log(`  1) GET initial → ${r1.status} ${b1.length}B | Set-Cookie noms: ${names(jar)} | __cf_bm=${jar.__cf_bm ? "✅ len=" + jar.__cf_bm.length : "❌ ABSENT"}`);

    if (!isCf(b1, r1.status)) {
      console.log(`  → pas de challenge, GET1 token=${hasToken(b1) ? "✅" : "?"} — stop`);
      continue;
    }

    // 2) CapSolver
    const cap = await solveSpainCloudflare(URL, KEY, proxy, b1, UA);
    if (!cap.success || !cap.session) { console.log(`  2) ❌ solve: ${cap.error}`); continue; }
    const capCookies = cap.session.allCookies ?? [];
    console.log(`  2) CapSolver OK | cookies rendus: ${capCookies.map(c => `${c.name}(len=${c.value.length})`).join(",") || "(aucun)"} | __cf_bm de CapSolver=${capCookies.find(c => c.name === "__cf_bm") ? "✅" : "❌ ABSENT"}`);

    // Variante A1 : jar initial (__cf_bm nôtre) + cf_clearance CapSolver
    const jarA1 = { ...jar };
    for (const c of capCookies) jarA1[c.name] = c.value;
    const rA1 = await (impit.fetch(URL, { headers: { "User-Agent": UA, "Cookie": jarStr(jarA1) } } as any) as unknown as Promise<Response>);
    const bA1 = await rA1.text();
    console.log(`  3a) GET post-solve [__cf_bm nôtre + cf_clearance] → ${rA1.status} ${bA1.length}B token=${hasToken(bA1) ? "🎉 PASS" : "❌"} encoreCF=${isCf(bA1, rA1.status) ? "oui" : "non"} | cookies envoyés: ${names(jarA1)}`);

    // Variante A2 : cf_clearance SEUL (reproduit l'ancien comportement supposé)
    const rA2 = await (impit.fetch(URL, { headers: { "User-Agent": UA, "Cookie": `cf_clearance=${jarA1.cf_clearance}` } } as any) as unknown as Promise<Response>);
    const bA2 = await rA2.text();
    console.log(`  3b) GET post-solve [cf_clearance SEUL] → ${rA2.status} ${bA2.length}B token=${hasToken(bA2) ? "🎉 PASS" : "❌"} encoreCF=${isCf(bA2, rA2.status) ? "oui" : "non"}`);
  }
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
