/**
 * test-pb-nbrowsers-parallel.ts — ARCHITECTURE RETENUE : N navigateurs SÉPARÉS en parallèle.
 *
 * Chaque dossier = 1 Chromium indépendant (userDataDir distinct + port Decodo/IP distinct),
 * franchit CF lui-même via solveCfChallenge, charge le widget (jQuery), scanne datetime/.
 * Valide : (1) N Chromium coexistent, (2) isolation totale, (3) scan concurrent réel,
 * (4) RAM par navigateur.
 */
import "dotenv/config";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, Page } from "puppeteer";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { solveCfChallenge } from "../cf-challenge-solver.js";
import { SAOPOLO_PORTAL_URL, getKnownIdsForPortal } from "../spain-portals.js";
import { getDecodoProxyForIndex, getDecodoPoolSize } from "../spain-decodo-pool.js";

puppeteer.use(StealthPlugin());

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const N = Number(process.env.N_BROWSERS ?? "3");
const START = Number(process.env.SPAIN_DECODO_START_INDEX ?? "8888");

function monthRange(offset: number) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}
const base = () => ({ type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC });
const okj = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);
function slotCount(raw: string): number { try { const o = JSON.parse(raw); return Array.isArray(o.Slots) ? o.Slots.length : 0; } catch { return 0; } }

function parseProxy(url: string): { server: string; username: string; password: string } | null {
  const m = url.match(/^https?:\/\/([^:]+):([^@]+)@(.+)$/);
  return m ? { username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]), server: "http://" + m[3] } : null;
}
function addSticky(url: string, sid: string): string { return url.replace(/-sessionduration-/, `-session-${sid}-sessionduration-`); }

async function jsonpOn(page: Page, endpoint: string, data: Record<string, string>): Promise<string> {
  const script = `
    (function(endpoint, data){return new Promise(function(resolve){
      var jq=window.jQuery; if(!jq){resolve('__ERR_NO_JQUERY');return;}
      var t=setTimeout(function(){resolve('__ERR_TIMEOUT');},18000);
      jq.ajax({url:${JSON.stringify(SRVSRC)}+'/onlinebookings/'+endpoint,dataType:'jsonp',jsonp:'callback',data:data,
        success:function(r){clearTimeout(t);try{resolve(JSON.stringify(r));}catch(e){resolve('__ERR_STR');}},
        error:function(_x,s){clearTimeout(t);resolve('__ERR_AJAX_'+String(s||'error'));}});
    });})(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})`;
  return (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 20000)),
  ])) as string;
}

const LAUNCH_ARGS = [
  "--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled",
  "--disable-infobars", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader-webgl",
  "--enable-webgl", `--user-agent=${UA}`, "--disable-v8-code-cache", "--disable-crash-reporter",
  "--no-first-run", "--no-default-browser-check",
];

interface Br { id: string; browser: Browser; page: Page; phpSessId?: string; cf?: boolean; jq?: boolean; solveMs?: number; rssMb?: number; pid?: number; }

async function launchOne(id: string, portIndex: number): Promise<Br> {
  const proxyRaw = getDecodoProxyForIndex(portIndex) ?? "";
  const proxy = parseProxy(addSticky(proxyRaw, Math.random().toString(36).slice(2, 10)));
  const userDataDir = mkdtempSync(join(tmpdir(), `spain-cf-${id}-`));
  const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser: Browser = await (puppeteer as any).launch({
    headless: true, userDataDir, executablePath,
    args: proxy ? [...LAUNCH_ARGS, `--proxy-server=${proxy.server}`] : LAUNCH_ARGS,
    protocolTimeout: 120_000,
  });
  const page = await browser.newPage();
  if (proxy) await page.authenticate({ username: proxy.username, password: proxy.password });
  await page.setUserAgent(UA);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  const t = Date.now();
  const res = await solveCfChallenge(page, { timeout: 65_000, targetUrl: URL, enableCapsolverFallback: !!process.env.CAPSOLVER_API_KEY });
  const solveMs = Date.now() - t;
  const jq = await page.waitForFunction("typeof window.jQuery === 'function'", { timeout: 25_000 }).then(() => true).catch(() => false);
  const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
  const phpSessId = cookies.find((c) => c.name === "PHPSESSID")?.value;
  const pid = browser.process()?.pid;
  let rssMb: number | undefined;
  try { if (pid) rssMb = Math.round(Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) / 1024); } catch { /* */ }
  return { id, browser, page, phpSessId, cf: res.success, jq, solveMs, rssMb, pid };
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  if (getDecodoPoolSize() === 0) { console.error("❌ pool Decodo vide"); process.exit(1); }
  console.log(`[nbrowsers] São Paulo | N=${N} navigateurs SÉPARÉS | ports Decodo ${START}..${START + N - 1}`);

  // Lancer les N navigateurs EN PARALLÈLE (en prod : étalé avant HH:13)
  const t0 = Date.now();
  const brs = await Promise.all(
    Array.from({ length: N }, (_, i) => launchOne(`B${i + 1}`, (START + i) % getDecodoPoolSize())),
  );
  console.log(`[nbrowsers] ✅ ${N} navigateurs lancés + CF en ${((Date.now() - t0) / 1000).toFixed(1)}s (parallèle)`);
  for (const b of brs) {
    console.log(`[nbrowsers] 🖥 ${b.id} — CF=${b.cf ? "✅" : "❌"} jQuery=${b.jq ? "✅" : "❌"} solve=${b.solveMs}ms PHPSESSID=${b.phpSessId ? b.phpSessId.slice(0, 12) + "…" : "❌"} RSS=${b.rssMb ?? "?"}Mo pid=${b.pid}`);
  }

  const ids = brs.map((b) => b.phpSessId ?? "");
  const uniq = new Set(ids.filter(Boolean));
  console.log(`\n[nbrowsers] ── Isolation PHPSESSID ── ${uniq.size}/${brs.length} distincts ${uniq.size === brs.length && !ids.includes("") ? "✅" : "❌"}`);

  // Scan datetime/ concurrent
  console.log(`\n[nbrowsers] ── Scan datetime/ concurrent ──`);
  const { start, end } = monthRange(1);
  await Promise.all(brs.map((b) => b.jq ? jsonpOn(b.page, "getagendas/", { ...base(), "services[]": known.serviceId }) : Promise.resolve("")));
  const scans = await Promise.all(brs.map(async (b) => ({ id: b.id, raw: b.jq ? await jsonpOn(b.page, "datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" }) : "__ERR_NO_JQUERY" })));
  for (const s of scans) console.log(`[nbrowsers]   ${s.id} datetime/ → ${okj(s.raw) ? s.raw.length + "B, " + slotCount(s.raw) + " slot(s) ✅" : "❌ " + s.raw.slice(0, 40)}`);

  const totalRss = brs.reduce((a, b) => a + (b.rssMb ?? 0), 0);
  const allCf = brs.every((b) => b.cf && b.jq);
  const allIso = uniq.size === brs.length && !ids.includes("");
  const allScan = scans.every((s) => okj(s.raw));
  console.log(`\n╔══════════════ VERDICT N NAVIGATEURS SÉPARÉS ══════════════╗`);
  console.log(`  CF + widget par navigateur : ${allCf ? "✅" : "❌"} (${brs.filter(b=>b.cf&&b.jq).length}/${brs.length})`);
  console.log(`  PHPSESSID isolés           : ${allIso ? "✅" : "❌"} (${uniq.size}/${brs.length})`);
  console.log(`  Scan datetime/ concurrent  : ${allScan ? "✅" : "❌"}`);
  console.log(`  RAM totale ${brs.length} navigateurs : ${totalRss}Mo (~${Math.round(totalRss / brs.length)}Mo/navigateur) → extrapolé 10 = ~${Math.round(totalRss / brs.length * 10)}Mo`);
  console.log(`  → ${allCf && allIso && allScan ? "✅✅ ARCHITECTURE VALIDÉE : N navigateurs séparés" : "à investiguer"}`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  for (const b of brs) await b.browser.close().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
