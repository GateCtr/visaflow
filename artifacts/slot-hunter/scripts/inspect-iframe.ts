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

// Logger tous les frames au fur et à mesure
page.on("framenavigated", (frame: any) => {
  const url = frame.url();
  if (url !== "about:blank" && url !== "about:srcdoc") {
    console.log(`[FRAME NAVIGATED] name="${frame.name()}" url=${url.slice(0, 100)}`);
  }
});

console.log("Navigating...");
try {
  await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/", {
    waitUntil: "domcontentloaded", timeout: 60_000
  });
} catch(e: any) { console.warn("Nav:", e.message?.slice(0,60)); }

// Attendre que le JS CF charge
await new Promise(r => setTimeout(r, 5000));

// Inspection exhaustive
const result = await page.evaluate(() => {
  // 1. Toutes les iframes avec TOUS leurs attributs
  const allIframes = Array.from(document.querySelectorAll("iframe")).map(f => ({
    id: f.id, name: f.name, title: f.title, src: f.src,
    class: f.className, w: f.offsetWidth, h: f.offsetHeight,
    style: f.getAttribute("style"), allow: f.getAttribute("allow"),
    attrSrc: f.getAttribute("src"),
    visible: f.offsetParent !== null,
    display: getComputedStyle(f).display,
    rect: (() => { const r = f.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height}; })(),
  }));

  // 2. Shadow DOM — CF peut injecter dans un shadow root
  const shadowHosts: string[] = [];
  const allElements = document.querySelectorAll("*");
  for (const el of Array.from(allElements)) {
    if ((el as any).shadowRoot) {
      const iframesInShadow = (el as any).shadowRoot.querySelectorAll("iframe");
      if (iframesInShadow.length > 0) {
        shadowHosts.push(`${el.tagName}#${el.id} → ${iframesInShadow.length} iframes`);
      }
    }
  }

  // 3. Div conteneur CF Turnstile
  const cfContainers = Array.from(document.querySelectorAll(
    ".cf-turnstile, [data-cf-turnstile], #challenge-stage, #challenge-running, .challenge-container, [id*='cf-'], [class*='cf-']"
  )).map(el => ({ tag: el.tagName, id: el.id, class: el.className.slice(0, 80), innerHTML: el.innerHTML.slice(0, 200) }));

  return { allIframes, shadowHosts, cfContainers, title: document.title, iframeCount: allIframes.length };
});

console.log("=== IFRAMES ===");
console.log(`Total: ${result.iframeCount}`);
result.allIframes.forEach((f, i) => console.log(`[${i}]`, JSON.stringify(f)));

console.log("\n=== SHADOW DOM ===");
result.shadowHosts.forEach(h => console.log(" -", h));

console.log("\n=== CF CONTAINERS ===");
result.cfContainers.forEach(c => console.log(JSON.stringify(c)));

// 4. Frames Puppeteer
console.log("\n=== PAGE.FRAMES() ===");
for (const frame of page.frames()) {
  const url = frame.url();
  if (url !== "about:blank") {
    console.log(`name="${frame.name()}" url=${url.slice(0, 100)}`);
  }
}

await page.screenshot({ path: "debug_dumps/cf-iframe-inspect.png" });
console.log("\nScreenshot sauvegardé");
await new Promise(r => setTimeout(r, 2000));
await browser.close();
