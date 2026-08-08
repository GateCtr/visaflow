import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const proxyUrl = process.env.DECODO_PROXY_URL!;
const u = new URL(proxyUrl);
const browser = await (puppeteer as any).launch({
  headless: false,
  args: ["--no-sandbox", `--proxy-server=http://${u.hostname}:${u.port}`, "--window-size=1280,800"],
});
const page = await browser.newPage();
await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");

try {
  await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/", {
    waitUntil: "domcontentloaded", timeout: 60_000
  });
} catch(e: any) { console.warn("Nav:", e.message?.slice(0,60)); }

await new Promise(r => setTimeout(r, 6000));

// Inspection approfondie du conteneur direct du widget
const info = await page.evaluate(() => {
  // L'input réponse
  const input = document.querySelector("input[id*='cf-chl-widget']");
  if (!input) return { error: "input not found" };

  const widgetId = input.id.replace("cf-chl-widget-", "").replace("_response", "");

  // CF met un div.cf-turnstile-wrapper ou un div avec un style grid autour
  // Chercher dans toute la chaîne de parents
  const chain: any[] = [];
  let el: HTMLElement | null = input as HTMLElement;
  let depth = 0;
  while (el && depth < 10) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    chain.push({
      depth, tag: el.tagName, id: el.id, class: el.className.slice(0, 60),
      style: el.getAttribute("style"),
      display: style.display, position: style.position,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    });
    el = el.parentElement;
    depth++;
  }

  // Tous les éléments avec une taille "widget" (petits, ~300x65)
  const candidates = Array.from(document.querySelectorAll("div")).filter(d => {
    const r = d.getBoundingClientRect();
    return r.width >= 200 && r.width <= 500 && r.height >= 30 && r.height <= 120 && r.y > 0;
  }).map(d => {
    const r = d.getBoundingClientRect();
    return { id: d.id, class: d.className.slice(0, 60), style: d.getAttribute("style"),
             rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  });

  // Position de l'élément pointé par document.elementFromPoint au centre
  const center = document.elementFromPoint(640, 400);

  return { widgetId, chain, candidates, centerEl: center ? { tag: center.tagName, id: center.id, class: (center as HTMLElement).className.slice(0,60) } : null };
});

console.log("Widget ID:", (info as any).widgetId);
console.log("\n=== CHAIN depuis input ===");
(info as any).chain?.forEach((c: any) => console.log(JSON.stringify(c)));
console.log("\n=== CANDIDATES (taille widget) ===");
(info as any).candidates?.forEach((c: any) => console.log(JSON.stringify(c)));
console.log("\n=== Element au centre de la page ===", JSON.stringify((info as any).centerEl));

// Chercher via page.frames() l'URL complète du widget frame
console.log("\n=== FRAMES ===");
for (const frame of page.frames()) {
  const url = frame.url();
  if (url.includes("challenges.cloudflare.com")) {
    console.log(`Frame CF: ${url}`);
    // Extraire le widget ID de l'URL
    const m = url.match(/\/rch\/([a-z0-9]+)\//);
    if (m) console.log(`Widget ID from URL: ${m[1]}`);
  }
}

await page.screenshot({ path: "debug_dumps/cf-chain.png" });
await browser.close();
