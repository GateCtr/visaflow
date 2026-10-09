/**
 * debug-capsolver-exitip.ts — Vérifie si CapSolver sort sur LA MÊME IP que nous.
 *
 * On demande à CapSolver de résoudre le CF d'un endpoint qui RÉVÈLE l'IP vue par le serveur,
 * en passant NOTRE proxy. Puis on compare avec l'IP que NOTRE client voit via le même proxy.
 * Si les IP diffèrent → le cf_clearance est lié à une autre IP → 403 inévitable.
 *
 * Note : on utilise ip-api via le serveur Go (notre IP proxy réelle) + on logue l'IP que
 * CapSolver déclare utiliser (si dispo). Surtout, on teste le cf-ray colo pour voir si
 * CapSolver et nous tapons le même datacenter CF.
 */
import "dotenv/config";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

const GO = process.env.TLS_PROXY_URL ?? "http://127.0.0.1:8787";

async function goFetch(url: string, proxy: string, ua: string, profile = "chrome_133") {
  const r = await fetch(`${GO}/fetch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, proxy, userAgent: ua, profile }),
  });
  return r.json() as Promise<{ status: number; body: string; cfRay: string; error?: string }>;
}

async function main() {
  const size = getDecodoPoolSize();
  let proxy = getDecodoProxyForIndex(Math.floor(Math.random() * size)) ?? "";
  const fresh = 5000 + Math.floor(Math.random() * 4000);
  proxy = proxy.replace(/EScz8ic9if97ji\d+/, `EScz8ic9if97ji${fresh}`);
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

  console.log(`sid utilisé : ${fresh}`);

  // 1. Notre IP de sortie via CE proxy, vue par le serveur Go
  const r1 = await goFetch("https://api.ipify.org?format=json", proxy, ua);
  console.log(`IP vue par NOUS (Go+proxy) : ${r1.body}`);

  // 2. Combien d'IP distinctes derrière ce même sid sur plusieurs appels rapides ?
  const ips = new Set<string>();
  for (let i = 0; i < 4; i++) {
    const r = await goFetch("https://api.ipify.org?format=json", proxy, ua);
    try { ips.add(JSON.parse(r.body).ip); } catch { /* */ }
  }
  console.log(`IP distinctes sur 4 appels (même sid) : ${[...ips].join(", ")} → ${ips.size === 1 ? "STABLE ✅" : "ROTATIVE ⚠️"}`);

  // 3. cf-ray colo vu par nous sur le portail
  const r3 = await goFetch("https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/", proxy, ua);
  console.log(`cf-ray colo (nous) : ${r3.cfRay} | status ${r3.status}`);

  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
