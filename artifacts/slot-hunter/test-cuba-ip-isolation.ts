/**
 * test-cuba-ip-isolation.ts — Isole si le 0B /main/ est IP-level Decodo ou global
 * Test 1: direct depuis Replit (sans proxy) → si 0B aussi = Bookitit bloque tout
 * Test 2: via Decodo → confirme ce qu'on sait déjà
 * Test 3: IP Decodo via httpbin
 */
import { Impit } from "impit";

const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";
const KINSHASA_PK = "25028fcd7126544630b8da0c6e60722b5";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function callMain(label: string, impit: InstanceType<typeof Impit>, pk: string) {
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${pk}/`;
  const tNow = Date.now();
  const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: pk, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
  const r = await (impit.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
    headers: {
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9",
      Referer: portalUrl,
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
    },
  } as any) as unknown as Response);
  const body = await r.text();
  console.log(`  [${label}] HTTP ${r.status} | bytes: ${body.length} | snippet: ${body.slice(0, 100)}`);
  return body.length;
}

// ─── Test IP detection ───────────────────────────────────────────────────────
const directImpit = new Impit({ browser: "chrome" } as any);
const decodoProxyUrl = process.env.DECODO_PROXY_URL;

console.log("═══ IP Detection ═══");
try {
  const r = await (directImpit.fetch("https://httpbin.org/ip", { headers: { "User-Agent": UA } } as any) as unknown as Promise<Response>);
  const j = await r.json() as any;
  console.log("Replit direct IP:", j.origin);
} catch (e) { console.log("Direct IP check failed:", e); }

if (decodoProxyUrl) {
  try {
    const decodoImpit = new Impit({ browser: "chrome", proxyUrl: decodoProxyUrl } as any);
    const r = await (decodoImpit.fetch("https://httpbin.org/ip", { headers: { "User-Agent": UA } } as any) as unknown as Promise<Response>);
    const j = await r.json() as any;
    console.log("Decodo proxy IP:", j.origin);
  } catch (e) { console.log("Decodo IP check failed:", e); }
} else {
  console.log("No DECODO_PROXY_URL configured");
}

// ─── Test /main/ sans proxy (direct Replit) ──────────────────────────────────
console.log("\n═══ Test /main/ SANS proxy (Replit direct) ═══");
await callMain("Cuba direct", directImpit, CUBA_PK);
await callMain("Kinshasa direct", directImpit, KINSHASA_PK);

// ─── Test /main/ via Decodo ──────────────────────────────────────────────────
if (decodoProxyUrl) {
  console.log("\n═══ Test /main/ VIA Decodo ═══");
  const decodoImpit = new Impit({ browser: "chrome", proxyUrl: decodoProxyUrl } as any);
  await callMain("Cuba Decodo", decodoImpit, CUBA_PK);
  await callMain("Kinshasa Decodo", decodoImpit, KINSHASA_PK);
}

// ─── Test portal (GET) via Decodo pour confirmer CF OK ───────────────────────
if (decodoProxyUrl) {
  console.log("\n═══ Test portal GET via Decodo ═══");
  const decodoImpit2 = new Impit({ browser: "chrome", proxyUrl: decodoProxyUrl } as any);
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;
  const rp = await (decodoImpit2.fetch(portalUrl, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none",
    },
  } as any) as unknown as Response);
  const hp = await rp.text();
  const isCf = /just a moment|verifying|_cf_chl_opt/i.test(hp.slice(0, 2000));
  const hasToken = /name="token"/.test(hp);
  console.log(`  Portal GET: HTTP ${rp.status} | bytes: ${hp.length} | CF challenge: ${isCf} | has token: ${hasToken}`);
  console.log(`  Set-Cookie: ${rp.headers.get("set-cookie")?.slice(0, 80) ?? "(none)"}`);
}

process.exit(0);
