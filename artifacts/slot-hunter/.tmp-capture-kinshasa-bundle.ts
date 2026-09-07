import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { initSpainRedis } from "./src/spain-redis-persistence.js";
import { initDecodoPool, getDecodoProxyForIndex } from "./src/spain-decodo-pool.js";
import { initWorkerSession } from "./src/spain-soax-solver.js";
import { KINSHASA_PORTAL_URL } from "./src/spain-portals.js";

function addStickySession(proxyUrl: string, sid: string): string {
  try {
    const u = new URL(proxyUrl);
    const user = decodeURIComponent(u.username);
    const sticky = user.includes("-session-")
      ? user.replace(/-session-[^-:@]+/, `-session-${sid}`)
      : user.replace(/(-sessionduration-[^-:@]+)?$/, `-session-${sid}$1`);
    u.username = encodeURIComponent(sticky);
    return u.toString();
  } catch {
    return proxyUrl;
  }
}

function cookieHeader(session: any): string {
  const values = (session.allCookies ?? []).map((c: any) => `${c.name}=${c.value}`);
  if (session.cfClearance && !values.some((v: string) => v.startsWith("cf_clearance="))) {
    values.push(`cf_clearance=${session.cfClearance}`);
  }
  return values.join("; ");
}

async function main(): Promise<void> {
const outDir = resolvePath("bundle-analysis/kinshasa");
mkdirSync(outDir, { recursive: true });

await initSpainRedis().catch(() => {});
await initDecodoPool();
const baseProxy = getDecodoProxyForIndex(0);
if (!baseProxy) throw new Error("No Decodo proxy available");
const stickyProxy = addStickySession(baseProxy, `bundle${Date.now().toString(36).slice(-8)}`);
const apiKey = process.env.CAPSOLVER_API_KEY ?? "";
if (!apiKey) throw new Error("CAPSOLVER_API_KEY missing");

const targetUrl = KINSHASA_PORTAL_URL.split("#")[0];
const init = await initWorkerSession(stickyProxy, targetUrl, apiKey);
if (!init) throw new Error("Kinshasa session initialization failed");
const { session, impit } = init;
const html = session.prefetchedMainHtml ?? "";
const widgetUrl = session.bookititState?.widgetUrl ?? targetUrl;
const cookie = cookieHeader(session);
const urls: string[] = [];
for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
  const src = match[1];
  if (!src) continue;
  const url = new URL(src, widgetUrl).href;
  if (!urls.includes(url)) urls.push(url);
}
const manifest: Array<{ url: string; file: string; status: number; bytes: number }> = [];
for (let i = 0; i < urls.length; i++) {
  const url = urls[i];
  try {
    const res = await (impit.fetch(url, {
      headers: {
        "User-Agent": session.userAgent,
        Accept: "*/*",
        Referer: widgetUrl,
        Cookie: cookie,
      },
    } as any) as unknown as Promise<Response>);
    const body = Buffer.from(await res.arrayBuffer());
    const file = `${String(i + 1).padStart(3, "0")}-${new URL(url).pathname.split("/").pop() || "script.js"}`.replace(/[^A-Za-z0-9._-]/g, "_");
    writeFileSync(resolvePath(outDir, file), body);
    manifest.push({ url, file, status: res.status, bytes: body.length });
    console.log(`${res.status} ${body.length}B ${file}`);
  } catch (error) {
    manifest.push({ url, file: "", status: 0, bytes: 0 });
    console.warn(`FETCH_FAILED ${url} ${error instanceof Error ? error.message : String(error)}`);
  }
}
writeFileSync(resolvePath(outDir, "manifest.json"), JSON.stringify({ portal: targetUrl, scripts: manifest }, null, 2));
console.log(`SCRIPT_COUNT ${urls.length}`);
console.log(`SAVED ${manifest.filter((x) => x.status >= 200 && x.status < 300).length}`);

}

main().catch((error) => { console.error(error); process.exit(1); });
