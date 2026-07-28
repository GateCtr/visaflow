/**
 * test-decodo-multiport.ts — Teste ports ISP Decodo en parallèle
 */
import { Impit } from "impit";

const base = process.env.DECODO_PROXY_URL!;
const parsed = new URL(base);
const user = decodeURIComponent(parsed.username);
const pass = decodeURIComponent(parsed.password);
const host = parsed.hostname;
const currentPort = parsed.port;

console.log(`Base user: ${user} | host: ${host} | current port: ${currentPort}`);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const CUBA_PK = "28330379fc95acafd31ee9e8938c278ff";

async function testPort(port: number | string): Promise<void> {
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  try {
    const impit = new Impit({ browser: "chrome", proxyUrl } as any);
    // Get IP
    const ri = await (impit.fetch("https://ipv4.icanhazip.com", {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(12_000),
    } as any) as unknown as Promise<Response>);
    const ip = (await ri.text()).trim();

    // Test /main/
    const portalUrl = `https://www.citaconsular.es/es/hosteds/widgetdefault/${CUBA_PK}/`;
    const tNow = Date.now();
    const q = new URLSearchParams({ callback: `jQ${tNow}`, type: "default", publickey: CUBA_PK, lang: "es", version: "4", src: portalUrl, _: String(tNow) });
    const impit2 = new Impit({ browser: "chrome", proxyUrl } as any);
    const rm = await (impit2.fetch(`https://www.citaconsular.es/onlinebookings/main/?${q}`, {
      headers: {
        "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
        Accept: "text/javascript, application/javascript, */*; q=0.01",
        "Accept-Language": "fr-FR,fr;q=0.9", Referer: portalUrl,
        "Sec-Fetch-Dest": "empty", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin",
      },
      signal: AbortSignal.timeout(12_000),
    } as any) as unknown as Promise<Response>);
    const body = await rm.text();
    const ct = rm.headers.get("content-type") ?? "";
    const icon = body.length > 0 ? "✅" : ct.includes("javascript") ? "🟡" : "❌";
    console.log(`port ${port}: IP=${ip} | /main/=${body.length}B | ct=${ct.slice(0,30)} ${icon}`);
    if (body.length > 0) console.log(`  snippet: ${body.slice(0, 120)}`);
  } catch (e) {
    console.log(`port ${port}: TIMEOUT/ERROR — ${(e as Error).message?.slice(0, 60)}`);
  }
}

// Test ports en parallèle
await Promise.all([
  testPort(currentPort),
  testPort(10002),
  testPort(10003),
  testPort(10004),
  testPort(10005),
]);

process.exit(0);
