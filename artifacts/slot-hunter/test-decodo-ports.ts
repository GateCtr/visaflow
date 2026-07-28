/**
 * test-decodo-ports.ts — Teste différents ports Decodo pour trouver une IP non-bannie
 */
import { Impit } from "impit";

const base = process.env.DECODO_PROXY_URL!;
if (!base) { console.error("❌ DECODO_PROXY_URL requis"); process.exit(1); }

// Extraire user:pass@host
const parsed = new URL(base);
const user = decodeURIComponent(parsed.username);
const pass = decodeURIComponent(parsed.password);
const host = parsed.hostname;

console.log(`Base: ${user}@${host}`);
console.log("");

// Ports ISP Decodo connus
const ports = [10001, 10002, 10003, 10004, 10005, 10000, 5000, 5001, 5002, 5003];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function testPort(port: number): Promise<{ port: number; ip: string; mainBytes: number; portalStatus: number }> {
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  const impit = new Impit({ browser: "chrome", proxyUrl } as any);

  let ip = "?";
  try {
    const r = await (impit.fetch("https://ipv4.icanhazip.com", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(10_000),
    } as any) as unknown as Promise<Response>);
    ip = (await r.text()).trim();
  } catch (e) {
    ip = `err:${(e as Error).message?.slice(0, 30)}`;
    return { port, ip, mainBytes: -1, portalStatus: -1 };
  }

  const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";
  const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;

  // Test portal GET
  let portalStatus = -1;
  try {
    const impit2 = new Impit({ browser: "chrome", proxyUrl } as any);
    const r = await (impit2.fetch(portalUrl, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
    } as any) as unknown as Promise<Response>);
    await r.text();
    portalStatus = r.status;
  } catch {}

  // Test /main/
  let mainBytes = -1;
  try {
    const impit3 = new Impit({ browser: "chrome", proxyUrl } as any);
    const tNow = Date.now();
    const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: CUBA_PK, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
    const r = await (impit3.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
      headers: {
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
        Accept: "text/javascript, application/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9", Referer: portalUrl,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      },
    } as any) as unknown as Promise<Response>);
    mainBytes = (await r.text()).length;
  } catch {}

  return { port, ip, mainBytes, portalStatus };
}

// Test les ports en séquence
for (const port of ports) {
  const result = await testPort(port);
  const status = result.mainBytes > 0 ? "✅ WORKS" : result.mainBytes === 0 ? "❌ 0B" : "⚠️ ERR";
  console.log(`port ${result.port}: IP=${result.ip} | portal=${result.portalStatus} | /main/=${result.mainBytes}B ${status}`);
  // Stop early if we find a working port
  if (result.mainBytes > 0) {
    console.log(`\n✅ Port ${result.port} fonctionne ! Nouvelle DECODO_PROXY_URL :`);
    const newUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${result.port}`;
    console.log(newUrl.replace(/:([^:@]{4})[^:@]*@/, ":***@"));
    break;
  }
}

process.exit(0);
