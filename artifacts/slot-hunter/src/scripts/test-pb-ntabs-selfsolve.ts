/**
 * test-pb-ntabs-selfsolve.ts — 1 navigateur, N ONGLETS, chaque onglet franchit CF LUI-MÊME.
 *
 * Hypothèse à valider : au lieu de 10 navigateurs (lourd) ou de contextes incognito qui
 * héritent du clearance (→ re-challenge), on ouvre N onglets dans UN SEUL navigateur et
 * CHAQUE onglet résout CF par lui-même via solveCfChallenge(page). Si ça marche :
 *   - 1 navigateur pour 10 dossiers (léger),
 *   - chaque onglet a son propre cf_clearance + PHPSESSID → isolation naturelle,
 *   - chaque onglet scanne son datetime/ indépendamment.
 *
 * On teste N=3 onglets : goto → solveCfChallenge (sans cache partagé) → jQuery ? →
 * PHPSESSID distinct ? → datetime/ in-page.
 */
import "dotenv/config";
import type { Browser, Page } from "puppeteer";
import { spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { solveCfChallenge } from "../cf-challenge-solver.js";
import { SAOPOLO_PORTAL_URL, getKnownIdsForPortal } from "../spain-portals.js";

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";
const N = Number(process.env.N_TABS ?? "3");

function monthRange(offset: number) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}
const base = () => ({ type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC });
const ok = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);
function slotCount(raw: string): number { try { const o = JSON.parse(raw); return Array.isArray(o.Slots) ? o.Slots.length : 0; } catch { return 0; } }

async function jsonpOn(page: Page, endpoint: string, data: Record<string, string>): Promise<string> {
  const script = `
    (function(endpoint, data) { return new Promise(function(resolve){
      var jq = window.jQuery; if(!jq){resolve('__ERR_NO_JQUERY');return;}
      var t = setTimeout(function(){resolve('__ERR_TIMEOUT');}, 18000);
      jq.ajax({url: ${JSON.stringify(SRVSRC)}+'/onlinebookings/'+endpoint, dataType:'jsonp', jsonp:'callback', data:data,
        success:function(r){clearTimeout(t);try{resolve(JSON.stringify(r));}catch(e){resolve('__ERR_STR');}},
        error:function(_x,s){clearTimeout(t);resolve('__ERR_AJAX_'+String(s||'error'));}});
    });})(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})`;
  return (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 20000)),
  ])) as string;
}

interface Tab { id: string; page: Page; phpSessId?: string; cf?: boolean; solveMs?: number; }

async function openTabSelfSolve(browser: Browser, proxyAuth: any, id: string): Promise<Tab> {
  const page = await browser.newPage();
  if (proxyAuth) await page.authenticate(proxyAuth);
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  // Chaque onglet résout CF LUI-MÊME. On N'passe PAS targetUrl/cfDomain → pas de cache partagé.
  const t = Date.now();
  const res = await solveCfChallenge(page, { timeout: 65_000, enableCapsolverFallback: !!process.env.CAPSOLVER_API_KEY });
  const solveMs = Date.now() - t;
  // Attendre jQuery (widget initialisé après franchissement)
  await page.waitForFunction("typeof window.jQuery === 'function'", { timeout: 20_000 }).catch(() => {});
  const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
  const phpSessId = cookies.find((c) => c.name === "PHPSESSID")?.value;
  return { id, page, phpSessId, cf: res.success, solveMs };
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  console.log(`[ntabs] São Paulo | N=${N} onglets | 1 navigateur | chaque onglet franchit CF lui-même`);

  // Lancer le navigateur (via le manager pour réutiliser proxy + args anti-détection)
  const browser = await (spainPersistentBrowser as any).getOrLaunchBrowser();
  const proxyUrlStr = (spainPersistentBrowser as any).getProxyUrl?.();
  const m = proxyUrlStr?.match(/^https?:\/\/([^:]+):([^@]+)@/);
  const proxyAuth = m ? { username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) } : null;
  console.log(`[ntabs] navigateur prêt | proxyAuth=${proxyAuth ? "✅" : "❌"}`);

  // Ouvrir N onglets SÉQUENTIELLEMENT (le solve CF simultané surchargerait ; en prod on étale avant HH:13)
  const tabs: Tab[] = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    const tab = await openTabSelfSolve(browser, proxyAuth, `TAB-${i + 1}`);
    tabs.push(tab);
    console.log(`[ntabs] 🗂 ${tab.id} — CF=${tab.cf ? "✅" : "❌"} solve=${tab.solveMs}ms (total ${Date.now() - t}ms) PHPSESSID=${tab.phpSessId ? tab.phpSessId.slice(0, 14) + "…" : "❌ ABSENT"} jQuery=${await tab.page.evaluate("typeof window.jQuery === 'function'").catch(() => false) ? "✅" : "❌"}`);
  }

  // Isolation PHPSESSID
  const ids = tabs.map((t) => t.phpSessId ?? "");
  const uniq = new Set(ids.filter(Boolean));
  console.log(`\n[ntabs] ── Isolation PHPSESSID ── ${uniq.size}/${tabs.length} distincts ${uniq.size === tabs.length && !ids.includes("") ? "✅" : "❌"}`);

  // Scan datetime/ indépendant par onglet (concurrent)
  console.log(`\n[ntabs] ── Scan datetime/ concurrent par onglet ──`);
  const { start, end } = monthRange(1);
  await Promise.all(tabs.map((t) => jsonpOn(t.page, "getagendas/", { ...base(), "services[]": known.serviceId })));
  const scans = await Promise.all(tabs.map(async (t) => ({ id: t.id, raw: await jsonpOn(t.page, "datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" }) })));
  for (const s of scans) console.log(`[ntabs]   ${s.id} datetime/ → ${ok(s.raw) ? s.raw.length + "B, " + slotCount(s.raw) + " slot(s) ✅" : "❌ " + s.raw.slice(0, 40)}`);

  const allCf = tabs.every((t) => t.cf);
  const allScanned = scans.every((s) => ok(s.raw));
  console.log(`\n╔══════════════ VERDICT N-ONGLETS SELF-SOLVE ══════════════╗`);
  console.log(`  CF franchi par chaque onglet : ${allCf ? "✅" : "❌"} (${tabs.filter(t=>t.cf).length}/${tabs.length})`);
  console.log(`  PHPSESSID isolés : ${uniq.size === tabs.length && !ids.includes("") ? "✅" : "❌"} (${uniq.size}/${tabs.length})`);
  console.log(`  Scan datetime/ indépendant : ${allScanned ? "✅" : "❌"}`);
  console.log(`  → ${allCf && allScanned ? "VIABLE : 1 navigateur + N onglets self-solve pour N dossiers" : "À investiguer"}`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
