import "dotenv/config";
import { solveSpainCloudflare, WORKER_UA } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";
import { Impit } from "impit";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";

async function main() {
  const KEY = process.env.CAPSOLVER_API_KEY ?? "";
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }

  const size = getDecodoPoolSize();
  let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
  // sessid frais hors de nos plages déjà testées
  const fresh = 2000 + Math.floor(Math.random() * 500);
  proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);

  console.log("WORKER_UA (impit) :", WORKER_UA);

  const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 120_000 } as any);
  const r1 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Accept": "text/html,*/*;q=0.8" } } as any) as any);
  const html = await r1.text();
  console.log("probe status:", r1.status, "len:", html.length);

  const res = await solveSpainCloudflare(URL, KEY, proxy, html, WORKER_UA);
  console.log("solve success:", res.success);
  console.log("CapSolver UA   :", JSON.stringify(res.session?.userAgent));
  console.log("UA == WORKER_UA ?", res.session?.userAgent === WORKER_UA);
  console.log("cf_clearance len:", res.session?.cfClearance?.length);

  // Re-GET avec le clearance + MÊME impit + MÊME UA, et regardons le statut/retour
  if (res.success && res.session) {
    const cookie = res.session.allCookies.map(c => `${c.name}=${c.value}`).join("; ");
    const r2 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Cookie": cookie } } as any) as any);
    const b2 = await r2.text();
    const hasToken = /name="token"\s+value="([^"]+)"/i.test(b2);
    const stillCf = /just a moment|_cf_chl_opt/i.test(b2.slice(0, 3000));
    console.log(`GET post-clearance: HTTP ${r2.status} | ${b2.length}B | token=${hasToken ? "✅" : "❌"} | encoreCF=${stillCf ? "OUI" : "non"}`);
  }
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
