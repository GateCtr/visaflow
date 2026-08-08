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

// Trouver la position du conteneur du widget via l'input hidden
const widgetCoords = await page.evaluate(() => {
  // CF place l'input hidden dans un div qui est le conteneur du widget
  const input = document.querySelector("input[id*='cf-chl-widget'][id$='_response']") as HTMLInputElement | null;
  if (!input) return null;

  // Remonter au conteneur parent qui a une taille visible
  let el: HTMLElement | null = input.parentElement;
  while (el) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 10 && rect.height > 10) {
      return {
        tag: el.tagName, id: el.id, class: el.className,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        style: el.getAttribute("style"),
        html: el.outerHTML.slice(0, 300),
      };
    }
    el = el.parentElement;
  }

  // Fallback : position de l'input lui-même dans le document flow
  const bodyRect = document.body.getBoundingClientRect();
  // Compter les éléments qui précèdent dans le DOM pour estimer la position
  const allDivs = Array.from(document.querySelectorAll("div")).map(d => {
    const r = d.getBoundingClientRect();
    return { id: d.id, class: d.className.slice(0,50), rect: {x:r.x, y:r.y, w:r.width, h:r.height} };
  }).filter(d => d.rect.w > 100 && d.rect.h > 30);

  return { tag: "BODY", id: "", class: "", rect: {x:0, y:0, w:bodyRect.width, h:bodyRect.height}, 
           style: null, html: "", allDivs: allDivs.slice(0, 20) };
});

console.log("\n=== WIDGET CONTAINER ===");
console.log(JSON.stringify(widgetCoords, null, 2));

// Screenshot avec annotation
await page.screenshot({ path: "debug_dumps/cf-widget-pos.png" });
console.log("Screenshot: debug_dumps/cf-widget-pos.png");

// Tester un clic à la position estimée du widget
// CF place le widget visuel exactement là où se trouve le conteneur
if ((widgetCoords as any)?.rect?.w > 10) {
  const wc = (widgetCoords as any).rect;
  const clickX = wc.x + 33; // checkbox est à ~33px du bord gauche
  const clickY = wc.y + wc.h / 2;
  console.log(`\n=== TEST CLIC [${Math.round(clickX)}, ${Math.round(clickY)}] ===`);
  console.log(`Conteneur: x=${wc.x} y=${wc.y} w=${wc.w} h=${wc.h}`);

  // Clic via mouse.click (plus fiable pour coordonnées viewport)
  await page.mouse.click(clickX, clickY, { delay: 50 });
  console.log("Clic envoyé !");

  await new Promise(r => setTimeout(r, 3000));

  // Vérifier si résolu
  const cookies = await page.cookies();
  const cfCookie = cookies.find((c: any) => c.name === "cf_clearance");
  console.log(`cf_clearance: ${cfCookie ? cfCookie.value.slice(0, 40) + "…" : "absent"}`);

  const title = await page.title();
  console.log(`Titre post-clic: "${title}"`);

  await page.screenshot({ path: "debug_dumps/cf-post-click.png" });
}

await browser.close();
