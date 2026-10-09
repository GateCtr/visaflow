/**
 * test-pb-multidossier-isolation.ts — Isolation N dossiers sur São Paulo.
 *
 * But : valider qu'avec UN navigateur partagé (CF franchi 1×), on peut ouvrir N contextes
 * incognito simultanés — un par dossier — chacun avec SON PHPSESSID isolé, et faire les
 * appels in-page (getagendas/datetime/getsigninfields) dans chaque contexte sans que les
 * sessions se croisent.
 *
 * Vérifications :
 *   1. Les N PHPSESSID sont TOUS DIFFÉRENTS (isolation réelle).
 *   2. Chaque contexte peut appeler datetime/ in-page et obtenir une réponse valide.
 *   3. Les appels concurrents inter-dossiers ne se cassent pas mutuellement.
 */
import "dotenv/config";
import type { Browser, Page } from "puppeteer";
import { ensureSpainPersistentBrowserSession, spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { SAOPOLO_PORTAL_URL, getKnownIdsForPortal } from "../spain-portals.js";

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";
const N = Number(process.env.N_DOSSIERS ?? "3");

function monthRange(offset: number) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}

/** Appel JSONP in-page via jQuery natif, dans une PAGE donnée (contexte incognito du dossier). */
async function jsonpInPageOn(page: Page, endpoint: string, data: Record<string, string>): Promise<string> {
  const script = `
    (function(endpoint, data) {
      return new Promise(function(resolve) {
        var jq = window.jQuery; if (!jq) { resolve('__ERR_NO_JQUERY'); return; }
        var timer = setTimeout(function(){ resolve('__ERR_TIMEOUT'); }, 18000);
        jq.ajax({ url: ${JSON.stringify(SRVSRC)} + '/onlinebookings/' + endpoint,
          dataType:'jsonp', jsonp:'callback', data:data,
          success:function(r){ clearTimeout(timer); try{resolve(JSON.stringify(r));}catch(e){resolve('__ERR_STR');} },
          error:function(_x,s){ clearTimeout(timer); resolve('__ERR_AJAX_'+String(s||'error')); } });
      });
    })(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})`;
  return (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 20000)),
  ])) as string;
}

const base = () => ({ type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC });
const ok = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);
function slotCount(raw: string): number { try { const o = JSON.parse(raw); return Array.isArray(o.Slots) ? o.Slots.length : 0; } catch { return 0; } }

interface Dossier { id: string; page: Page; ctx: any; phpSessId?: string; }

function parseProxyAuth(proxyUrl: string | undefined): { username: string; password: string } | null {
  if (!proxyUrl) return null;
  const m = proxyUrl.match(/^https?:\/\/([^:]+):([^@]+)@/);
  return m ? { username: decodeURIComponent(m[1]), password: decodeURIComponent(m[2]) } : null;
}

async function openDossierContext(browser: Browser, cfSession: any, id: string, proxyAuth: { username: string; password: string } | null): Promise<Dossier> {
  const ctx = await (browser as any).createBrowserContext();
  const page: Page = await ctx.newPage();
  // Auth proxy (le contexte incognito hérite du --proxy-server mais pas des credentials).
  if (proxyAuth) await page.authenticate(proxyAuth);
  await page.setUserAgent(cfSession.userAgent);
  // Injecter les cookies CF (sans PHPSESSID) via CDP
  const inject = cfSession.allCookies.filter((c: any) => c.name !== "PHPSESSID").map((c: any) => ({
    name: c.name, value: c.value, domain: ".citaconsular.es", path: "/", secure: c.name === "cf_clearance",
  }));
  if (inject.length) {
    const cdp = await page.createCDPSession();
    for (const ck of inject) await cdp.send("Network.setCookie", ck).catch(() => {});
    await cdp.detach().catch(() => {});
  }
  // Charger le widget (pas /main/ JSONP mais la page widget → jQuery dispo + PHPSESSID frais)
  await page.goto(URL, { waitUntil: "networkidle0", timeout: 45_000 });
  // Diagnostic : que montre la page incognito ? (challenge CF ? widget ? jQuery ?)
  const diag = await page.evaluate(`(function(){
    return JSON.stringify({
      title: document.title,
      hasJQuery: typeof window.jQuery === 'function',
      hasBkt: typeof window.bkt_init_widget !== 'undefined',
      bodyStart: (document.body ? document.body.innerText : '').slice(0, 80),
      scripts: Array.prototype.slice.call(document.scripts).map(function(s){return s.src;}).filter(Boolean).slice(0,8)
    });
  })()`).catch((e: any) => `__ERR_${e}`);
  console.log(`[iso]   🔬 ${id} page: ${String(diag).slice(0, 300)}`);
  await page.waitForFunction("typeof window.jQuery === 'function'", { timeout: 20_000 }).catch(() => {
    console.warn(`[iso]   ⚠️ ${id}: jQuery non détecté après 20s`);
  });
  const cookies = await page.cookies("https://www.citaconsular.es");
  const phpSessId = cookies.find((c) => c.name === "PHPSESSID")?.value;
  return { id, page, ctx, phpSessId };
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  console.log(`[iso] São Paulo | N=${N} dossiers | service=${known.serviceId} agenda=${known.agendaId}`);

  // 1) Navigateur partagé + CF franchi une seule fois
  const t0 = Date.now();
  const cfSession = await ensureSpainPersistentBrowserSession(URL);
  if (!cfSession) { console.error("❌ pas de session CF"); process.exit(1); }
  const browser = await (spainPersistentBrowser as any).getOrLaunchBrowser();
  const proxyAuth = parseProxyAuth((spainPersistentBrowser as any).getProxyUrl?.());
  console.log(`[iso] ✅ navigateur partagé + CF franchi en ${((Date.now() - t0) / 1000).toFixed(1)}s | proxyAuth=${proxyAuth ? "✅" : "❌"}`);

  // 2) Ouvrir N contextes incognito isolés (séquentiel pour /main/ PHPSESSID propre)
  const dossiers: Dossier[] = [];
  for (let i = 0; i < N; i++) {
    const t = Date.now();
    const d = await openDossierContext(browser, cfSession, `DOSSIER-${i + 1}`, proxyAuth);
    dossiers.push(d);
    console.log(`[iso] 🔒 ${d.id} ouvert (${Date.now() - t}ms) PHPSESSID=${d.phpSessId ? d.phpSessId.slice(0, 14) + "…" : "❌ ABSENT"}`);
  }

  // 3) Vérifier l'isolation des PHPSESSID
  const ids = dossiers.map((d) => d.phpSessId ?? "");
  const uniq = new Set(ids.filter(Boolean));
  console.log(`\n[iso] ── Isolation PHPSESSID ──`);
  console.log(`[iso]   ${uniq.size}/${dossiers.length} PHPSESSID distincts ${uniq.size === dossiers.length && !ids.includes("") ? "✅ ISOLÉS" : "❌ COLLISION ou absent"}`);

  // 4) Chaque dossier : getagendas/ puis datetime/ in-page DANS SON contexte (concurrents)
  console.log(`\n[iso] ── Scan concurrent in-page par dossier ──`);
  const { start, end } = monthRange(1); // mois +1 (où on avait vu des slots)
  await Promise.all(dossiers.map(async (d) => {
    await jsonpInPageOn(d.page, "getagendas/", { ...base(), "services[]": known.serviceId });
  }));
  const scans = await Promise.all(dossiers.map(async (d) => {
    const raw = await jsonpInPageOn(d.page, "datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" });
    return { id: d.id, raw };
  }));
  for (const s of scans) {
    console.log(`[iso]   ${s.id} datetime/ → ${ok(s.raw) ? s.raw.length + "B, " + slotCount(s.raw) + " slot(s) ✅" : "❌ " + s.raw.slice(0, 40)}`);
  }

  const allScanned = scans.every((s) => ok(s.raw));
  console.log(`\n╔══════════════ VERDICT ISOLATION N-DOSSIERS ══════════════╗`);
  console.log(`  PHPSESSID isolés : ${uniq.size === dossiers.length && !ids.includes("") ? "✅" : "❌"} (${uniq.size}/${dossiers.length})`);
  console.log(`  Scan concurrent in-page : ${allScanned ? "✅ tous les dossiers ont scanné" : "❌ au moins un échec"}`);
  console.log(`  → ${uniq.size === dossiers.length && allScanned ? "ISOLATION VIABLE : N dossiers / 1 navigateur partagé" : "À investiguer"}`);
  console.log(`╚═══════════════════════════════════════════════════════════╝`);

  for (const d of dossiers) await d.ctx.close().catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
