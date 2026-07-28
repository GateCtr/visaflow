/**
 * test-decodo-port1002.ts — Test rapide port 1002 Decodo
 */
import { Impit } from "impit";

const base = process.env.DECODO_PROXY_URL!;
const parsed = new URL(base);
const user = decodeURIComponent(parsed.username);
const pass = decodeURIComponent(parsed.password);
const host = parsed.hostname;

const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:1002`;
console.log("Testing port 1002:", proxyUrl.replace(/:([^:@]{4})[^:@]*@/, ":***@"));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";
const KINSHASA_PK = "25028fcd7126544630b8da0c6e60722b5";

// IP check
let ip = "?";
try {
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);
  const r = await (impit.fetch("https://ipv4.icanhazip.com", { headers: { "User-Agent": UA } } as any) as unknown as Promise<Response>);
  ip = (await r.text()).trim();
  console.log("IP:", ip);
} catch (e) { console.log("IP check error:", e); process.exit(1); }

async function testMain(label: string, pk: string) {
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${pk}/`;
  const tNow = Date.now();
  const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: pk, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);
  const r = await (impit.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
    headers: {
      "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "gzip, deflate, br",
      Referer: portalUrl,
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Priority: "u=1, i",
    },
  } as any) as unknown as Promise<Response>);
  const body = await r.text();
  const ct = r.headers.get("content-type") ?? "";
  const icon = body.length > 0 ? "✅" : "❌";
  console.log(`${icon} [${label}] HTTP ${r.status} | bytes: ${body.length} | ct: ${ct}`);
  if (body.length > 0) console.log(`   snippet: ${body.slice(0, 150)}`);
}

async function testPortal(pk: string) {
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${pk}/`;
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);
  const r = await (impit.fetch(portalUrl, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
  } as any) as unknown as Promise<Response>);
  const body = await r.text();
  const isCf = /just a moment|verifying|_cf_chl_opt/i.test(body.slice(0, 2000));
  const hasToken = /name="token"/.test(body);
  console.log(`  portal GET: HTTP ${r.status} | bytes: ${body.length} | CF: ${isCf} | token: ${hasToken}`);
}

console.log("\n─── Portal ───");
await testPortal(CUBA_PK);

console.log("\n─── /main/ ───");
await testMain("Cuba", CUBA_PK);
await testMain("Kinshasa", KINSHASA_PK);

process.exit(0);
