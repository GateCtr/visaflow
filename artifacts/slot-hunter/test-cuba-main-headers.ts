/**
 * test-cuba-main-headers.ts — Capture les headers complets de /main/ pour diagnostiquer
 * le 0B. Teste via Decodo proxy avec différentes combinaisons.
 */
import { Impit } from "impit";

const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";
const KINSHASA_PK = "25028fcd7126544630b8da0c6e60722b5";
const SPAIN_PK = "25028fcd7126544630b8da0c6e60722b5"; // Kinshasa = Spain default
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const decodoProxyUrl = process.env.DECODO_PROXY_URL!;
if (!decodoProxyUrl) { console.error("❌ DECODO_PROXY_URL requis"); process.exit(1); }

// Masquer le password pour les logs
const masked = decodoProxyUrl.replace(/:([^:@]{4})[^:@]*@/, ":***@");
console.log("Proxy:", masked.slice(0, 80));

async function testMain(label: string, pk: string, extraHeaders: Record<string, string> = {}, proxyUrl = decodoProxyUrl) {
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${pk}/`;
  const tNow = Date.now();
  const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: pk, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
  try {
    const r = await (impit.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
      headers: {
        "User-Agent": UA,
        "X-Requested-With": "XMLHttpRequest",
        Accept: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        Referer: portalUrl,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
        Priority: "u=1, i",
        ...extraHeaders,
      },
    } as any) as unknown as Response);
    const body = await r.text();
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    console.log(`  [${label}] HTTP ${r.status} | bytes: ${body.length}`);
    console.log(`    headers: ${JSON.stringify(headers, null, 2).slice(0, 400)}`);
    if (body.length > 0) console.log(`    snippet: ${body.slice(0, 100)}`);
    return { status: r.status, bytes: body.length, headers, body };
  } catch (e) {
    console.log(`  [${label}] ERROR: ${e}`);
    return null;
  }
}

// ─── 1. Test baseline: Cuba + Kinshasa via Decodo ─────────────────────────────
console.log("\n═══ 1. Baseline Decodo ═══");
await testMain("Cuba baseline", CUBA_PK);
await testMain("Kinshasa baseline", KINSHASA_PK);

// ─── 2. Test sans X-Requested-With ────────────────────────────────────────────
console.log("\n═══ 2. Sans X-Requested-With ═══");
await testMain("no XHR header", CUBA_PK, { "X-Requested-With": "" });

// ─── 3. Test getservices/ directement (l'endpoint final) ──────────────────────
console.log("\n═══ 3. getservices/ directement ═══");
const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;
const impit3 = new Impit({ browser: "chrome", proxyUrl: decodoProxyUrl } as any);
const tNow3 = Date.now();
const q3 = new URLSearchParams({ callback: `jQ${tNow3}`, type: "default", publickey: CUBA_PK, lang: "es", version: "4", src: portalUrl, _: String(tNow3) });
try {
  const r = await (impit3.fetch(`https://www.citaconsular.es/onlinebookings/getservices/?${q3}`, {
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
  const hdrs: Record<string, string> = {};
  r.headers.forEach((v, k) => { hdrs[k] = v; });
  console.log(`  getservices/ direct → HTTP ${r.status} | bytes: ${body.length}`);
  console.log(`  headers: cf-ray=${hdrs["cf-ray"] ?? "(none)"} | content-type=${hdrs["content-type"] ?? "(none)"} | x-bookitit=${hdrs["x-bookitit"] ?? "(none)"}`);
  if (body.length > 0) console.log(`  snippet: ${body.slice(0, 200)}`);
} catch (e) { console.log("  getservices/ error:", e); }

// ─── 4. Portal GET + POST → puis /main/ avec le PHPSESSID résultant ───────────
console.log("\n═══ 4. Full portal flow → /main/ ═══");
const impit4 = new Impit({ browser: "chrome", proxyUrl: decodoProxyUrl } as any);
const cubaPortal = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;
let phpsessid = "";
// GET portal
const rp = await (impit4.fetch(cubaPortal, {
  headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
} as any) as unknown as Response);
const hp = await rp.text();
phpsessid = rp.headers.get("set-cookie")?.match(/PHPSESSID=([^;]+)/)?.[1] ?? "";
const token = hp.match(/name="token"\s+value="([^"]+)"/)?.[1] ?? "";
console.log(`  Portal GET: HTTP ${rp.status} | bytes: ${hp.length} | PHPSESSID: ${phpsessid.slice(0, 20)}… | token: ${token.slice(0, 20)}…`);

if (token) {
  const rpost = await (impit4.fetch(cubaPortal, {
    method: "POST",
    headers: {
      "User-Agent": UA, Cookie: `PHPSESSID=${phpsessid}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9",
      Origin: "https://www.citaconsular.es", Referer: cubaPortal,
      "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "same-origin", "Sec-Fetch-User": "?1",
    },
    body: `token=${encodeURIComponent(token)}`,
  } as any) as unknown as Response);
  const hpost = await rpost.text();
  const newPhp = rpost.headers.get("set-cookie")?.match(/PHPSESSID=([^;]+)/)?.[1] ?? phpsessid;
  phpsessid = newPhp;
  console.log(`  POST widget: HTTP ${rpost.status} | bytes: ${hpost.length} | PHPSESSID: ${phpsessid.slice(0, 20)}… | bkt_init: ${/bkt_init_widget/.test(hpost)}`);

  // Now call /main/ immediately after widget
  const tNow4 = Date.now();
  const q4 = new URLSearchParams({ callback: `jQ${tNow4}`, type: "default", publickey: CUBA_PK, lang: "es", version: "4", src: cubaPortal, _: String(tNow4) });
  const rm = await (impit4.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q4}`, {
    headers: {
      "User-Agent": UA, Cookie: `PHPSESSID=${phpsessid}`,
      "X-Requested-With": "XMLHttpRequest",
      Accept: "text/javascript, application/javascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9",
      Referer: cubaPortal,
      "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin", Priority: "u=1, i",
    },
  } as any) as unknown as Response);
  const bm = await rm.text();
  const hdrsM: Record<string, string> = {};
  rm.headers.forEach((v, k) => { hdrsM[k] = v; });
  console.log(`  /main/ after portal flow: HTTP ${rm.status} | bytes: ${bm.length}`);
  console.log(`    cf-ray: ${hdrsM["cf-ray"] ?? "(none)"} | content-type: ${hdrsM["content-type"] ?? "(none)"}`);
  if (bm.length > 0) console.log(`    snippet: ${bm.slice(0, 200)}`);
}

process.exit(0);
