/**
 * debug-capsolver-sweep.ts — Boucle le flux PROD exact (CapSolver AntiCloudflareTask + impit)
 * sur N IP fraîches, et logue le détail de CHAQUE solve pour trouver la condition de succès.
 *
 * Objectif : prouver si "certaines IP passent" est encore vrai, et isoler ce qui les distingue
 * (longueur clearance, présence token vs cookie, cf-ray, statut GET).
 */
import "dotenv/config";
import { Impit } from "impit";
import { solveSpainCloudflare, WORKER_UA } from "../spain-soax-solver.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const N = Number(process.env.SWEEP_N ?? 15);

function hasToken(b: string) { return /name="token"\s+value="([^"]+)"/i.test(b); }

async function main() {
  const KEY = process.env.CAPSOLVER_API_KEY ?? "";
  if (!KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const size = getDecodoPoolSize();

  let ok = 0;
  for (let i = 0; i < N; i++) {
    // IP fraîche : sessid aléatoire large
    let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
    const fresh = 5000 + Math.floor(Math.random() * 4000);
    proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);

    const impit = new Impit({ browser: "chrome", proxyUrl: proxy, timeout: 60_000 } as any);
    try {
      // 1. probe → html challenge
      const r1 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Accept": "text/html,*/*;q=0.8" } } as any) as any);
      const html = await r1.text();
      if (r1.status !== 403) { console.log(`#${i+1} probe HTTP ${r1.status} (pas de challenge?) — skip`); continue; }

      // 2. CapSolver
      const res = await solveSpainCloudflare(URL, KEY, proxy, html, WORKER_UA);
      if (!res.success || !res.session) { console.log(`#${i+1} ❌ solve: ${res.error}`); continue; }
      const s = res.session;
      const cfLen = s.cfClearance?.length ?? 0;
      const cookieNames = (s.allCookies ?? []).map(c => c.name).join("+");
      const uaMatch = s.userAgent === WORKER_UA;

      // 3. GET widget avec le clearance (même impit)
      const cookie = (s.allCookies ?? []).map(c => `${c.name}=${c.value}`).join("; ");
      const r2 = await (impit.fetch(URL, { headers: { "User-Agent": WORKER_UA, "Cookie": cookie } } as any) as any);
      const b2 = await r2.text();
      const pass = hasToken(b2);
      const cfRay = (r2.headers as any).get?.("cf-ray") ?? "?";
      if (pass) ok++;
      console.log(`#${i+1} sid=${fresh} | clrLen=${cfLen} cookies=[${cookieNames}] uaMatch=${uaMatch} | GET=${r2.status} ${b2.length}B token=${pass ? "✅ PASS" : "❌"} cf-ray=${cfRay}`);
    } catch (e) {
      console.log(`#${i+1} ERREUR: ${e instanceof Error ? e.message.slice(0,60) : e}`);
    }
  }
  console.log(`\n═══ ${ok}/${N} IP ont PASSÉ (token obtenu) ═══`);
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
