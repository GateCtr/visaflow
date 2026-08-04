import "dotenv/config";
import { Impit } from "impit";

async function main() {
  const proxyUrl = "http://sp8zzigoui:5mK3kr_L9uu3wiwMyT@dc.decodo.com:10001";
  console.log("PROXY:", proxyUrl?.replace(/:([^:@]+)@/, ":***@"));
  const impit = new Impit({
    browser: "chrome",
    proxyUrl,
  } as any);

  const res = await (impit.fetch(
    "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services",
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
      },
    } as any,
  ) as unknown as Response);

  const html = await res.text();
  console.log("STATUS:", res.status, "LEN:", html.length);
  console.log("SET-COOKIE:", res.headers.get("set-cookie") ?? "(none)");

  // Extract cRay from _cf_chl_opt (no quotes around property name in JS object literal)
  const cRayMatch = html.match(/cRay\s*:\s*['"]([^'"]+)['"]/);
  const cRay = cRayMatch?.[1];
  console.log("cRay:", cRay);

  // Extract orchestrator script src
  const orchMatch = html.match(/a\.src\s*=\s*'([^']+)'/);
  const orchPath = orchMatch?.[1];
  console.log("Orchestrator path:", orchPath);

  if (orchPath && cRay) {
    const orchUrl = `https://www.citaconsular.es${orchPath}`;
    console.log("Fetching orchestrator:", orchUrl);
    const orchRes = await (impit.fetch(orchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Referer": "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/",
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
    } as any) as unknown as Response);
    const orchScript = await orchRes.text();
    console.log("Orchestrator status:", orchRes.status, "len:", orchScript.length);
    // Search for Turnstile sitekey in the orchestrator script
    const skMatches = [
      orchScript.match(/challenges\.cloudflare\.com\/turnstile\/v[\d]+\/[a-z]\/([a-f0-9]{8,32})\/api\.js/),
      orchScript.match(/turnstile.*?sitekey['":\s]+['"]([a-f0-9A-Z0-9_\-]{8,64})['"]/i),
      orchScript.match(/["']sitekey["']\s*:\s*["']([a-f0-9A-Z0-9_\-]{8,64})["']/),
      orchScript.match(/\/g\/([a-f0-9]{8,32})\/api\.js/),
    ];
    console.log("Sitekey matches:", skMatches.map((m, i) => `[${i}] ${m?.[1] ?? "null"}`).join("  "));
    // Print first 2000 chars
    console.log("--- ORCH SCRIPT (first 2000) ---");
    console.log(orchScript.slice(0, 2000));
  }
}

main().catch(console.error);
