import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
puppeteer.use(StealthPlugin());

const proxyUrl = process.env.DECODO_PROXY_URL!;
const u = new URL(proxyUrl);

const browser = await (puppeteer as any).launch({
  headless: false,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox",
    `--proxy-server=http://${u.hostname}:${u.port}`,
    "--window-size=1280,800",
  ],
});

const page = await browser.newPage();
await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36");

// Intercepter turnstile.render()
await page.evaluateOnNewDocument(() => {
  (window as any).__cf_intercepted_sitekey = null;
  const defineIfNeeded = () => {
    if ((window as any).__cf_patched) return;
    (window as any).__cf_patched = true;
    const orig = (window as any).turnstile;
    Object.defineProperty(window, "turnstile", {
      configurable: true, get() { return orig; },
      set(t) {
        const origRender = t?.render;
        if (origRender) {
          t.render = function(el: any, opts: any) {
            if (opts?.sitekey) { (window as any).__cf_intercepted_sitekey = opts.sitekey; console.log("SITEKEY INTERCEPTED:", opts.sitekey); }
            return origRender.call(this, el, opts);
          };
        }
        Object.defineProperty(window, "turnstile", { configurable: true, value: t });
      }
    });
  };
  defineIfNeeded();
  document.addEventListener("DOMContentLoaded", defineIfNeeded);
});

console.log("Navigating...");
try {
  await page.goto("https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/", {
    waitUntil: "domcontentloaded", timeout: 60_000
  });
} catch(e: any) { console.warn("Nav timeout:", e.message?.slice(0,80)); }

await new Promise(r => setTimeout(r, 8000));

const result = await page.evaluate(() => {
  const iframes = Array.from(document.querySelectorAll("iframe")).map(f => ({
    src: f.src, id: f.id, title: f.title, class: f.className, w: f.offsetWidth, h: f.offsetHeight
  }));
  const scripts = Array.from(document.querySelectorAll("script[src]")).map(s => (s as HTMLScriptElement).src).filter(s => s.includes("challenge") || s.includes("turnstile") || s.includes("cloudflare"));
  const sitekeys = Array.from(document.querySelectorAll("[data-sitekey]")).map(e => e.getAttribute("data-sitekey"));
  const intercepted = (window as any).__cf_intercepted_sitekey;
  const cfOpt = JSON.stringify((window as any)._cf_chl_opt ?? null);
  return { title: document.title, url: location.href, iframes, scripts, sitekeys, intercepted, cfOpt, cookieStr: document.cookie.slice(0,200) };
});

console.log("=== INSPECTION ===");
console.log("Titre:", result.title);
console.log("URL:", result.url);
console.log("Iframes:", JSON.stringify(result.iframes, null, 2));
console.log("CF Scripts:", result.scripts);
console.log("Sitekeys DOM:", result.sitekeys);
console.log("Intercepted sitekey:", result.intercepted);
console.log("_cf_chl_opt:", result.cfOpt);
console.log("Cookie:", result.cookieStr);

await page.screenshot({ path: "debug_dumps/inspect-cf.png" });
console.log("Screenshot: debug_dumps/inspect-cf.png");
await browser.close();
