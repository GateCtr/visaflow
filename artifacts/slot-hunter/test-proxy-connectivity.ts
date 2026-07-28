/**
 * test-proxy-connectivity.ts — Test rapide connectivité proxy + CF
 */
import { Impit } from "impit";

async function main() {
  const proxy = process.env.DECODO_PROXY_URL;
  console.log("proxy:", proxy ? proxy.slice(0, 60) + "…" : "MISSING");
  if (!proxy) process.exit(1);

  const impit = new Impit({ browser: "chrome", proxyUrl: proxy } as any);
  console.log("Fetch https://www.citaconsular.es/ via proxy…");
  const res = await (impit.fetch("https://www.citaconsular.es/", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(25_000),
  } as any) as unknown as Promise<Response>);
  const body = await (res as any).text() as string;
  console.log("HTTP", (res as any).status, "| bytes:", body.length);
  console.log("CF challenge:", /just a moment|verifying|_cf_chl_opt/i.test(body.slice(0, 3000)));
  console.log("snippet:", body.slice(0, 300).replace(/\s+/g, " "));
}

main().catch(err => { console.error("ERR:", err); process.exit(1); });
