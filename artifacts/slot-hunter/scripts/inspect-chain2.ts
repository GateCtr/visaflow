import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import fs from "fs";
puppeteer.use(StealthPlugin());

const proxyUrl = process.env.DECODO_PROXY_URL!;
const u = new URL(proxyUrl);
const browser = await (puppeteer as any).launch({
  headless: true,
  args: ["--no-sandbox", `--proxy-server=http://${u.hostname}:${u.port}`, "--window-size=1280,800", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");

const log: string[] = [];
const L = (s: string) => { log.push(s); };

try {
  await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/", {
    waitUntil: "domcontentloaded", timeout: 60_000
  });
} catch(e: any) { L("Nav: " + e.message?.slice(0,60)); }

await new Promise(r => setTimeout(r, 6000));

const info = await page.evaluate(() => {
  const input = document.querySelector("input[id*='cf-chl-widget']") as HTMLInputElement;
  if (!input) return { error: "no input" };
  const widgetId = input.id.replace("cf-chl-widget-", "").replace("_response", "");
  
  // Remonter la chaîne de parents
  const chain: any[] = [];
  let el: HTMLElement | null = input;
  for (let d = 0; d < 12 && el; d++) {
    const r = el.getBoundingClientRect();
    chain.push({ d, tag: el.tagName, id: el.id, class: el.className.slice(0,50),
                 style: el.getAttribute("style"),
                 rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
    el = el.parentElement;
  }
  
  // Divs de taille widget (200-500 large, 30-120 haut)
  const candidates = Array.from(document.querySelectorAll("div")).filter(d => {
    const r = d.getBoundingClientRect();
    return r.width >= 200 && r.width <= 500 && r.height >= 30 && r.height <= 120 && r.y > 0 && r.x > 0;
  }).map(d => {
    const r = d.getBoundingClientRect();
    return { id: d.id, class: d.className.slice(0,50), style: d.getAttribute("style"),
             rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  });

  return { widgetId, chain, candidates };
});

L("Widget ID: " + (info as any).widgetId);
L("\n=== CHAIN ===");
(info as any).chain?.forEach((c: any) => L(JSON.stringify(c)));
L("\n=== CANDIDATES ===");
(info as any).candidates?.forEach((c: any) => L(JSON.stringify(c)));

// Frames
L("\n=== FRAMES ===");
for (const frame of page.frames()) {
  const url = frame.url();
  if (url !== "about:blank") L(`name="${frame.name()}" url=${url.slice(0, 120)}`);
}

// Ecrire dans un fichier
fs.writeFileSync("debug_dumps/inspect-chain-output.txt", log.join("\n"), "utf8");
await page.screenshot({ path: "debug_dumps/cf-headless.png" });
await browser.close();
process.exit(0);
