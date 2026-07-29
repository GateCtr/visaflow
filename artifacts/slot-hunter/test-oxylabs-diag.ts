/**
 * test-oxylabs-diag.ts — diagnostic rapide Oxylabs Web Unlocker
 * Usage: cd artifacts/slot-hunter && node_modules/.bin/tsx test-oxylabs-diag.ts
 */
import "dotenv/config";
import nodeFetch from "node-fetch";
import { HttpsProxyAgent } from "https-proxy-agent";

process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const OXY_USER = process.env.OXYLABS_USERNAME ?? "";
const OXY_PASS = process.env.OXYLABS_PASSWORD ?? "";
const agent = new HttpsProxyAgent(`https://${OXY_USER}:${OXY_PASS}@unblock.oxylabs.io:60000`);

async function test(label: string, url: string, headers: Record<string, string> = {}) {
  process.stdout.write(`[${label}] GET ${url.slice(0, 70)} … `);
  try {
    const r = await nodeFetch(url, { method: "GET", agent, headers, timeout: 30_000 });
    const body = await r.text();
    // Récupérer tous les Set-Cookie
    const sc = (r.headers as any).raw?.()?.["set-cookie"] ?? [];
    console.log(`status=${r.status} body=${body.length}B cookies=[${sc.map((c: string) => c.split("=")[0]).join(",")}]`);
    if (body.length > 0 && body.length < 500) console.log(`       body: ${body.replace(/\n/g, " ").slice(0, 200)}`);
  } catch (e: unknown) {
    console.log(`ERR: ${String(e).slice(0, 100)}`);
  }
}

console.log("=".repeat(65));
console.log("DIAG Oxylabs Web Unlocker");
console.log(`  user: ${OXY_USER}  host: unblock.oxylabs.io:60000`);
console.log("=".repeat(65));

// 1. Connectivité de base (sans render)
await test("ip-sans-render  ", "https://ip.oxylabs.io/location");

// 2. Connectivité avec render html
await test("ip-avec-render  ", "https://ip.oxylabs.io/location", { "X-Oxylabs-Render": "html" });

// 3. URL simple publique sans render
await test("httpbin-sans    ", "https://httpbin.org/get");

// 4. URL simple publique avec render
await test("httpbin-avec    ", "https://httpbin.org/get", { "X-Oxylabs-Render": "html" });

// 5. citaconsular racine sans render
await test("cita-root-sans  ", "https://www.citaconsular.es/");

// 6. citaconsular racine avec render
await test("cita-root-avec  ", "https://www.citaconsular.es/", { "X-Oxylabs-Render": "html" });

// 7. citaconsular portail widget avec render
await test("cita-widget     ",
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/",
  { "X-Oxylabs-Render": "html" }
);

console.log("=".repeat(65));
