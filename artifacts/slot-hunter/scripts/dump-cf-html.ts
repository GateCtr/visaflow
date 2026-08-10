import { Impit } from "impit";

const proxyUrl = process.env.SOAX_PROXY_URL;
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const TARGET = process.env.SPAIN_WIDGET_URL || "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

async function main() {
  const impit = new Impit({ browser: "chrome", ...(proxyUrl ? { proxyUrl } : {}) } as any);
  const masked = proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70) : "(direct)";
  console.error(`Proxy: ${masked}`);
  console.error(`Target: ${TARGET}`);

  const res = await (impit.fetch(TARGET, {
    headers: {
      "User-Agent": CHROME_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
  } as any) as unknown as Response);

  const body = await res.text();
  console.error(`HTTP ${(res as any).status} | ${body.length} chars`);
  console.error(`set-cookie: ${(res as any).headers?.get?.("set-cookie") ?? ""}`);

  // Print patterns we care about
  const checks = [
    ["__CF$cv$params", /window\.__CF\$cv\$params/.test(body)],
    ["_cf_chl_opt", /_cf_chl_opt/.test(body)],
    ["turnstile/v", /challenges\.cloudflare\.com\/turnstile/.test(body)],
    ["data-sitekey", /data-sitekey=/.test(body)],
    ["challenge-form", /id="challenge-form"/.test(body)],
    ["cH field", /['"']cH['"']\s*:/.test(body)],
    ["ray id", /Ray ID/.test(body)],
  ] as [string, boolean][];
  console.error("--- Pattern matches ---");
  for (const [name, match] of checks) console.error(`  ${match ? "✅" : "❌"} ${name}`);

  // Extract _cf_chl_opt if present
  const chlOptM = body.match(/_cf_chl_opt\s*=\s*(\{[^}]+\})/);
  if (chlOptM) console.error(`\n_cf_chl_opt: ${chlOptM[1]}`);

  // Extract any turnstile script src
  const tsM = body.match(/src="(https:\/\/challenges\.cloudflare\.com[^"]+)"/g);
  if (tsM) console.error(`\nTurnstile scripts: ${tsM.join("\n  ")}`);

  // Full HTML
  console.log(body);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
