/**
 * debug-capsolver-nohtml.ts — Teste l'architecture documentée dans spain-impit-tls-reuse.md :
 * AntiCloudflareTask SANS champ `html` → CapSolver fetch la page + exécute le JS du challenge
 * interactif dans SON Chrome via NOTRE proxy → cf_clearance lié à l'IP (pas au TLS).
 * Puis n'importe quel impit sur la MÊME IP + ce clearance → JSONP 200.
 *
 * On compare AVEC html (actuel, échoue) vs SANS html (doc dit : marche) sur plusieurs IP.
 */
import "dotenv/config";
import { Impit } from "impit";
import { solveSpainCloudflare, WORKER_UA } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const N = Number(process.env.SWEEP_N ?? 5);

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }
function isCf(b: string) { return /un instant|just a moment|verifying you are human|_cf_chl_opt/i.test(b.slice(0, 3000)); }

async function run(withHtml: boolean) {
  const KEY = process.env.CAPSOLVER_API_KEY!;
  const size = getDecodoPoolSize();
  let ok = 0;
  console.log(`\n═══ ${withHtml ? "AVEC html (actuel)" : "SANS html (doc validée)"} ═══`);
  for (let i = 0; i < N; i++) {
    let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
    const fresh = 5000 + Math.floor(Math.random() * 4000);
    proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);
    const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 60_000 } as any);
    try {
      // probe (toujours, pour avoir le html si besoin + poser PHPSESSID initial)
      const r1 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Accept": "text/html,*/*;q=0.8" } } as any) as any);
      const html = await r1.text();

      // solve : AVEC ou SANS html
      const res = withHtml
        ? await solveSpainCloudflare(URL, KEY, proxy, html, WORKER_UA)
        : await solveSpainCloudflare(URL, KEY, proxy); // ← SANS html ni UA
      if (!res.success || !res.session) { console.log(`  #${i+1} ❌ solve: ${res.error}`); continue; }

      const jar: Record<string,string> = {};
      for (const c of res.session.allCookies ?? []) jar[c.name] = c.value;
      const cookie = Object.entries(jar).map(([k,v])=>`${k}=${v}`).join("; ");

      // GET widget avec le clearance, MÊME impit, MÊME proxy
      const r2 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Cookie": cookie } } as any) as any);
      const b2 = await r2.text();
      const pass = hasToken(b2);
      if (pass) ok++;
      console.log(`  #${i+1} sid=${fresh} clrLen=${res.session.cfClearance?.length} | GET=${r2.status} ${b2.length}B token=${pass?"✅ PASS":"❌"} encoreCF=${isCf(b2)?"OUI":"non"}`);
    } catch (e) {
      console.log(`  #${i+1} ERREUR: ${e instanceof Error ? e.message.slice(0,60) : e}`);
    }
  }
  console.log(`  → ${ok}/${N} PASS`);
  return ok;
}

async function main() {
  if (!process.env.CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const noHtml = await run(false);   // la piste documentée en premier
  const withHtml = await run(true);  // le comportement actuel pour comparaison
  console.log(`\n═══ VERDICT ═══`);
  console.log(`SANS html : ${noHtml}/${N} | AVEC html : ${withHtml}/${N}`);
  console.log(noHtml > withHtml ? "✅ SANS html est la solution (conforme à spain-impit-tls-reuse.md)" : "⚠️ pas de différence nette — creuser ailleurs");
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
