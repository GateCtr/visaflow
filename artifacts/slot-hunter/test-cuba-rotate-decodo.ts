/**
 * test-cuba-rotate-decodo.ts — Teste l'IP Decodo sans le suffixe -ip-X.X.X.X
 * pour forcer une nouvelle IP du pool et débloquer /main/
 */
import { Impit } from "impit";

const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const originalProxyUrl = process.env.DECODO_PROXY_URL!;
if (!originalProxyUrl) { console.error("❌ DECODO_PROXY_URL requis"); process.exit(1); }

// Construire URL sans -ip-X.X.X.X pour obtenir une IP aléatoire du pool
const rotatedProxyUrl = originalProxyUrl.replace(/-ip-[\d.]+/, "");
const maskedOrig = originalProxyUrl.replace(/:([^:@]{4})[^:@]*@/, ":***@").slice(0, 100);
const maskedRot  = rotatedProxyUrl.replace(/:([^:@]{4})[^:@]*@/, ":***@").slice(0, 100);
console.log("Original proxy :", maskedOrig);
console.log("Rotated proxy  :", maskedRot);
console.log("");

async function getIp(impit: InstanceType<typeof Impit>): Promise<string> {
  try {
    const r = await (impit.fetch("https://ipv4.icanhazip.com", { headers: { "User-Agent": UA } } as any) as unknown as Promise<Response>);
    return (await r.text()).trim();
  } catch (e) { return `error: ${e}`; }
}

async function testMain(label: string, impit: InstanceType<typeof Impit>, pk = CUBA_PK) {
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${pk}/`;
  const tNow = Date.now();
  const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: pk, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
  try {
    const r = await (impit.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
      headers: {
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
        Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9", "Accept-Encoding": "gzip, deflate, br",
        Referer: portalUrl,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Priority: "u=1, i",
      },
    } as any) as unknown as Response);
    const body = await r.text();
    const ct = r.headers.get("content-type") ?? "";
    const cc = r.headers.get("cache-control") ?? "";
    console.log(`  [${label}] HTTP ${r.status} | bytes: ${body.length} | content-type: ${ct} | cache-control: ${cc}`);
    if (body.length > 0) console.log(`    snippet: ${body.slice(0, 150)}`);
    return body.length;
  } catch (e) {
    console.log(`  [${label}] ERROR: ${e}`);
    return -1;
  }
}

async function testPortal(label: string, impit: InstanceType<typeof Impit>) {
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;
  try {
    const r = await (impit.fetch(portalUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*", "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
    } as any) as unknown as Response);
    const body = await r.text();
    const isCf = /just a moment|verifying|_cf_chl_opt/i.test(body.slice(0, 2000));
    const hasToken = /name="token"/.test(body);
    console.log(`  [${label} portal] HTTP ${r.status} | bytes: ${body.length} | CF: ${isCf} | token: ${hasToken}`);
  } catch (e) { console.log(`  [${label} portal] ERROR: ${e}`); }
}

// ─── Test avec IP originale (grillée) ────────────────────────────────────────
console.log("═══ IP originale (grillée) ═══");
const origImpit = new Impit({ browser: "chrome", proxyUrl: originalProxyUrl } as any);
const origIp = await getIp(origImpit);
console.log(`IP: ${origIp}`);
await testMain("orig /main/ Cuba", origImpit);
await testPortal("orig", origImpit);

// ─── Test avec IP rotée ───────────────────────────────────────────────────────
console.log("\n═══ IP rotée (sans -ip-X.X.X.X) ═══");
const rotImpit = new Impit({ browser: "chrome", proxyUrl: rotatedProxyUrl } as any);
const rotIp = await getIp(rotImpit);
console.log(`IP: ${rotIp}`);
await testMain("rotée /main/ Cuba", rotImpit);
await testPortal("rotée", rotImpit);

// Si IP rotée fonctionne, tester Kinshasa aussi
const KINSHASA_PK = "25028fcd7126544630b8da0c6e60722b5";
const rotImpit2 = new Impit({ browser: "chrome", proxyUrl: rotatedProxyUrl } as any);
await testMain("rotée /main/ Kinshasa", rotImpit2, KINSHASA_PK);

process.exit(0);
