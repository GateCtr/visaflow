/**
 * debug-jsdsolver-direct.ts — Teste le JSDSolver impit pur (le flux "d'avant") sur Sao Paulo.
 * S'il réussit → le fix est de router vers JSDSolver. S'il échoue sur __CF$cv$params absent
 * → confirme que CF a migré vers un JSD passif (chl_page) non géré par ce solveur.
 */
import "dotenv/config";
import { JSDSolver } from "../jsd-solver.js";
import { Impit } from "impit";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

async function main() {
  const proxy = process.env.DECODO_PROXY_URL ?? "";
  if (!proxy) { console.error("❌ DECODO_PROXY_URL requis"); process.exit(1); }

  // Probe pour voir le HTML du challenge
  const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 60_000 } as any);
  const r = await (impit.fetch(URL, { headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8" } } as any) as any);
  const html = await r.text();
  console.log(`probe: HTTP ${r.status} | ${html.length}B`);
  console.log(`__CF$cv$params présent : ${/window\.__CF\$cv\$params/.test(html) ? "OUI" : "NON"}`);
  console.log(`chl_page orchestrate   : ${/orchestrate\/chl_page/.test(html) ? "OUI" : "NON"}`);
  console.log(`turnstile sitekey      : ${/challenges\.cloudflare\.com\/turnstile/.test(html) ? "OUI" : "NON"}`);

  console.log("\n═══ Tentative JSDSolver (impit pur) ═══");
  const solver = new JSDSolver(URL, UA, proxy, impit);
  const res = await solver.solve(45_000, html);
  console.log(`JSDSolver success: ${res.success}`);
  if (!res.success) console.log(`  erreur: ${res.error}`);
  else console.log(`  cf_clearance: ${res.session?.cfClearance?.length}B`);
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
