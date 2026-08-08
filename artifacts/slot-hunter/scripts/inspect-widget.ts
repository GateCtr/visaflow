import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const proxyUrl = process.env.DECODO_PROXY_URL!;
const u = new URL(proxyUrl);

const browser = await (puppeteer as any).launch({
  headless: false,
  args: ["--no-sandbox", "--disable-setuid-sandbox",
         `--proxy-server=http://${u.hostname}:${u.port}`,
         "--window-size=1280,800"],
});

const page = await browser.newPage();
await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");

console.log("Navigating...");
try {
  await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/", {
    waitUntil: "domcontentloaded", timeout: 60_000
  });
} catch(e: any) { console.warn("Nav:", e.message?.slice(0,60)); }

await new Promise(r => setTimeout(r, 5000));

// 1. CDP getFrameTree — pour voir la structure complète des frames
const cdp = await page.createCDPSession();
try {
  const frameTree = await cdp.send("Page.getFrameTree");
  console.log("\n=== CDP Page.getFrameTree ===");
  console.log(JSON.stringify(frameTree, null, 2).slice(0, 3000));
} catch(e) { console.warn("getFrameTree:", e); }

// 2. Chercher la position du widget CF via DOM
const widgetInfo = await page.evaluate(() => {
  // L'input hidden CF-chl-widget
  const inputs = Array.from(document.querySelectorAll("input[id*='cf-chl-widget']"));
  const inputInfo = inputs.map(el => ({
    id: el.id, type: (el as HTMLInputElement).type,
    value: (el as HTMLInputElement).value.slice(0, 50),
    parentHTML: el.parentElement?.outerHTML?.slice(0, 300) ?? "",
    rect: (() => { const r = el.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height}; })(),
  }));

  // Body complet pour analyser la structure
  const bodyHTML = document.body?.innerHTML?.slice(0, 2000) ?? "";
  return { inputs: inputInfo, bodyHTML };
});
console.log("\n=== INPUT CF-WIDGET ===");
widgetInfo.inputs.forEach(i => console.log(JSON.stringify(i, null, 2)));
console.log("\n=== BODY HTML (2000 chars) ===");
console.log(widgetInfo.bodyHTML);

// 3. Coordonnées réelles de la frame via CDP
try {
  const frames = page.frames();
  for (const frame of frames) {
    const url = frame.url();
    if (url.includes("challenges.cloudflare.com")) {
      console.log(`\n=== FRAME CF: ${url.slice(0, 100)} ===`);
      console.log(`name: "${frame.name()}", id: "${frame._id ?? frame.id ?? 'n/a'}"`);
    }
  }
} catch(e) { console.warn("frames:", e); }

await cdp.detach();
await page.screenshot({ path: "debug_dumps/cf-widget-inspect.png" });
await browser.close();
