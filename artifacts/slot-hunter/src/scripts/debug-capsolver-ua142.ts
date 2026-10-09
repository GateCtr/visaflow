/**
 * debug-capsolver-ua142.ts — Teste le flux CapSolver + impit avec couple TLS↔UA COHÉRENT.
 *
 * Hypothèse : impit n'imite que jusqu'à chrome142 en TLS, mais WORKER_UA=Chrome/151.
 * On force UA=Chrome/142 ET impit browser="chrome142" → couple TLS↔UA cohérent de bout en
 * bout (solve CapSolver avec UA142 + GET impit TLS142/UA142). On teste plusieurs IP.
 */
import "dotenv/config";
import { Impit } from "impit";
import { solveSpainCloudflare } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const N = Number(process.env.SWEEP_N ?? 8);

// Profils TLS↔UA strictement alignés (version TLS impit == version annoncée dans l'UA)
const PROFILES = [
  { tls: "chrome142", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" },
  { tls: "chrome136", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" },
];

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }

async function main() {
  const KEY = process.env.CAPSOLVER_API_KEY ?? "";
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const size = getDecodoPoolSize();

  for (const prof of PROFILES) {
    let ok = 0;
    console.log(`\n═══ Profil TLS=${prof.tls} / UA aligné ═══`);
    for (let i = 0; i < N; i++) {
      let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
      const fresh = 5000 + Math.floor(Math.random() * 4000);
      proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);

      const impit = new Impit({ browser: prof.tls as any, proxyUrl: proxy, timeout: 60_000 } as any);
      try {
        const r1 = await (impit.fetch(URL, { headers: { "User-Agent": prof.ua, "Accept": "text/html,*/*;q=0.8" } } as any) as any);
        const html = await r1.text();
        if (r1.status !== 403) { console.log(`  #${i+1} probe ${r1.status} — skip`); continue; }

        // IMPORTANT : passer prof.ua à CapSolver (pas WORKER_UA) → couple cohérent
        const res = await solveSpainCloudflare(URL, KEY, proxy, html, prof.ua);
        if (!res.success || !res.session) { console.log(`  #${i+1} ❌ solve: ${res.error}`); continue; }
        const s = res.session;

        const cookie = (s.allCookies ?? []).map(c => `${c.name}=${c.value}`).join("; ");
        const r2 = await (impit.fetch(URL, { headers: { "User-Agent": prof.ua, "Cookie": cookie } } as any) as any);
        const b2 = await r2.text();
        const pass = hasToken(b2);
        if (pass) ok++;
        console.log(`  #${i+1} sid=${fresh} clrLen=${s.cfClearance?.length} capsolverUA="${(s.userAgent||'').slice(28,50)}" | GET=${r2.status} ${b2.length}B token=${pass ? "✅ PASS" : "❌"}`);
      } catch (e) {
        console.log(`  #${i+1} ERREUR: ${e instanceof Error ? e.message.slice(0,50) : e}`);
      }
    }
    console.log(`  → ${ok}/${N} PASS pour ${prof.tls}`);
  }
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
