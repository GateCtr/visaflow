/**
 * test-pb-ncontexts-selfsolve.ts — 1 navigateur, N CONTEXTES INCOGNITO, chacun franchit CF LUI-MÊME.
 *
 * Dernière variante : contexte incognito = cookie store ISOLÉ (→ PHPSESSID distinct, résout le
 * problème des onglets qui partageaient le PHPSESSID) ET chaque contexte résout CF par lui-même
 * (→ son propre cf_clearance, résout le problème des contextes qui héritaient et re-challengeaient).
 *
 * Si ✅ : 10 dossiers = 1 navigateur + 10 contextes incognito isolés (léger ET isolé).
 * Si ❌ : fallback N navigateurs séparés (sûr, OK sur Railway Pro 32Go).
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
const N = Number(process.env.N_CTX ?? "3");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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

interface Ctx { id: string; page: Page; ctx: any; phpSessId?: string; cf?: boolean; solveMs?: number; jq?: boolean; }

async function openCtxSelfSolve(browser: Browser, proxyAuth: any, id: string): Promise<Ctx> {
  const ctx = await (browser as any).createBrowserContext(); // cookie store ISOLÉ
  const page: Page = await ctx.newPage();
  if (proxyAuth) await page.authenticate(proxyAuth);
  await page.setUserAgent(UA);
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  // Chaque contexte résout CF lui-même. PAS de targetUrl/cfDomain → pas de cache partagé.
  const t = Date.now();
  const res = await solveCfChallenge(page, { timeout: 65_000, enableCapsolverFallback: !!process.env.CAPSOLVER_API_KEY });
  const solveMs = Date.now() - t;
  // Après le franchissement CF, re-naviguer vers le widget pour charger jQuery (comme le PB).
  let jq = await page.waitForFunction("typeof window.jQuery === 'function'", { timeout: 8_000 }).then(() => true).catch(() => false);
  if (!jq) {
    // Diagnostic + re-navigation vers le widget (le solve laisse souvent la page sur l'écran CF).
    const diag = await page.evaluate(`JSON.stringify({title: document.title, url: location.href, hasJq: typeof window.jQuery==='function'})`).catch(() => "?");
    console.log(`[nctx]   🔬 ${id} post-solve: ${String(diag).slice(0, 160)}`);
    await page.goto(URL, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    jq = await page.waitForFunction("typeof window.jQuery === 'function'", { timeout: 20_000 }).then(() => true).catch(() => false);
    const diag2 = await page.evaluate(`JSON.stringify({title: document.title, hasJq: typeof window.jQuery==='function', hasBkt: typeof window.bkt_init_widget!=='undefined'})`).catch(() => "?");
    console.log(`[nctx]   🔬 ${id} après re-nav: ${String(diag2).slice(0, 160)}`);
  }
  const cookies = await page.cookies("https://www.citaconsular.es").catch(() => []);
  const phpSessId = cookies.find((c) => c.name === "PHPSESSID")?.value;
  return { id, page, ctx, phpSessId, cf: res.success, solveMs, jq };
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  console.log(`[nctx] São Paulo | N=${N} contextes incognito | chacun franchit CF lui-même`);

  const browser = await (spainPersistentBrowser as any).getOrLaunchBrowser();
  const proxyUrlStr = (spainPersistentBrowser as any).getProxyUrl?.();
  const m = proxyUrlStr?.match(/^https?:\/\/([^:]+):([^@]+)@/);
  const proxyAuth = m ? { username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) } : null;
  console.log(`[nctx] navigateur prêt | proxyAuth=${proxyAuth ? "✅" : "❌"}`);

  const ctxs: Ctx[] = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    const c = await openCtxSelfSolve(browser, proxyAuth, `CTX-${i + 1}`);
    ctxs.push(c);
    console.log(`[nctx] 🔒 ${c.id} — CF=${c.cf ? "✅" : "❌"} solve=${c.solveMs}ms (total ${Date.now() - t}ms) PHPSESSID=${c.phpSessId ? c.phpSessId.slice(0, 14) + "…" : "❌ ABSENT"} jQuery=${c.jq ? "✅" : "❌"}`);
  }

  const ids = ctxs.map((c) => c.phpSessId ?? "");
  const uniq = new Set(ids.filter(Boolean));
  console.log(`\n[nctx] ── Isolation PHPSESSID ── ${uniq.size}/${ctxs.length} distincts ${uniq.size === ctxs.length && !ids.includes("") ? "✅" : "❌"}`);

  console.log(`\n[nctx] ── Scan datetime/ concurrent par contexte ──`);
  const { start, end } = monthRange(1);
  await Promise.all(ctxs.map((c) => c.jq ? jsonpOn(c.page, "getagendas/", { ...base(), "services[]": known.serviceId }) : Promise.resolve("__ERR_NO_JQUERY")));
  const scans = await Promise.all(ctxs.map(async (c) => ({ id: c.id, raw: c.jq ? await jsonpOn(c.page, "datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" }) : "__ERR_NO_JQUERY" })));
  for (const s of scans) console.log(`[nctx]   ${s.id} datetime/ → ${ok(s.raw) ? s.raw.length + "B, " + slotCount(s.raw) + " slot(s) ✅" : "❌ " + s.raw.slice(0, 40)}`);

  const allCf = ctxs.every((c) => c.cf);
  const allIso = uniq.size === ctxs.length && !ids.includes("");
  const allScanned = scans.every((s) => ok(s.raw));
  console.log(`\n╔══════════════ VERDICT N-CONTEXTES SELF-SOLVE ══════════════╗`);
  console.log(`  CF franchi par chaque contexte : ${allCf ? "✅" : "❌"} (${ctxs.filter(c=>c.cf).length}/${ctxs.length})`);
  console.log(`  PHPSESSID isolés : ${allIso ? "✅" : "❌"} (${uniq.size}/${ctxs.length})`);
  console.log(`  Scan datetime/ indépendant : ${allScanned ? "✅" : "❌"}`);
  console.log(`  → ${allCf && allIso && allScanned ? "✅✅ VIABLE : 1 navigateur + N contextes incognito self-solve = léger ET isolé" : "fallback N navigateurs séparés"}`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  for (const c of ctxs) await c.ctx.close().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
