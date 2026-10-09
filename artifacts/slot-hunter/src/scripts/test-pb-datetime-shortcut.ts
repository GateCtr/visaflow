/**
 * test-pb-datetime-shortcut.ts — VOIE "navigateur chaud + raccourci datetime (format HTTP)".
 *
 * Clé : on réutilise le FORMAT d'URL éprouvé du scanner HTTP prod (ordre strict des params),
 * MAIS on fait l'appel in-page via jQuery NATIF (dataType:'jsonp') — jQuery gère le callback
 * exactement comme le widget Bookitit. Les tentatives précédentes échouaient (22B) car elles
 * inventaient un callback jQuery... différent à chaque appel ; le widget/scanner réutilise un
 * callback géré par jQuery lui-même.
 *
 * On teste :
 *   A0) getagendas/ in-page (jQuery natif, serviceId connu) — amorce l'agenda côté session PHP.
 *   A)  datetime/ in-page (jQuery natif, services[]+agendas[] connus) sur 3 mois.
 *   B)  rescan datetime/ ×5 → latence par créneau.
 */
import "dotenv/config";
import { ensureSpainPersistentBrowserSession, spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { SAOPOLO_PORTAL_URL, getKnownIdsForPortal } from "../spain-portals.js";

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";

function monthRange(offset: number): { start: string; end: string; label: string } {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}

/**
 * Appelle un endpoint Bookitit in-page via jQuery NATIF JSONP.
 * jQuery génère/gère son propre callback (comme le widget) → pas de 22B.
 * `data` = objet de params (ordre géré par jQuery ; Bookitit tolère l'objet jQuery natif).
 */
async function jsonpInPage(endpoint: string, data: Record<string, string | string[]>): Promise<{ ms: number; raw: string }> {
  const page = spainPersistentBrowser.getActivePage();
  if (!page) return { ms: 0, raw: "__ERR_NO_PAGE" };
  const t = Date.now();
  const script = `
    (function(endpoint, data) {
      return new Promise(function(resolve) {
        var jq = window.jQuery;
        if (!jq) { resolve('__ERR_NO_JQUERY'); return; }
        var timer = setTimeout(function(){ resolve('__ERR_TIMEOUT'); }, 15000);
        jq.ajax({
          url: ${JSON.stringify(SRVSRC)} + '/onlinebookings/' + endpoint,
          dataType: 'jsonp',
          jsonp: 'callback',
          data: data,
          traditional: false,
          success: function(resp){ clearTimeout(timer); try { resolve(JSON.stringify(resp)); } catch(e){ resolve('__ERR_STRINGIFY'); } },
          error: function(_x, s){ clearTimeout(timer); resolve('__ERR_AJAX_' + String(s||'error')); }
        });
      });
    })(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})
  `;
  const raw = (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 17000)),
  ])) as string;
  return { ms: Date.now() - t, raw: raw ?? "" };
}

function baseData(): Record<string, string> {
  return { type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC };
}
function summarize(raw: string): string {
  try { const o = JSON.parse(raw); const s = Array.isArray(o.Slots) ? o.Slots.length : "?"; return `Slots=${s} maxDays=${o.maxDays ?? "?"} (${raw.length}B)`; }
  catch { return `(${raw.length}B)`; }
}
const ok = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ Portail inconnu"); process.exit(1); }
  console.log(`[shortcut] IDs São Paulo → service=${known.serviceId} agenda=${known.agendaId}`);

  const t0 = Date.now();
  const session = await ensureSpainPersistentBrowserSession(URL);
  if (!session) { console.error("❌ pas de session"); process.exit(1); }
  console.log(`[shortcut] ✅ CF franchi + navigateur chaud en ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log(`\n[shortcut] ── A0) getagendas/ in-page (jQuery natif) ──`);
  {
    const { ms, raw } = await jsonpInPage("getagendas/", { ...baseData(), "services[]": known.serviceId });
    console.log(`[shortcut]   getagendas/ → ${ms}ms | ${ok(raw) ? raw.length + "B ✅ " + raw.slice(0, 80) : "❌ " + raw.slice(0, 60)}`);
  }

  console.log(`\n[shortcut] ── A) datetime/ in-page (jQuery natif, IDs connus) — 3 mois ──`);
  for (let off = 0; off < 3; off++) {
    const { start, end, label } = monthRange(off);
    const { ms, raw } = await jsonpInPage("datetime/", {
      ...baseData(), "services[]": known.serviceId, "agendas[]": known.agendaId,
      start, end, selectedPeople: "1",
    });
    console.log(`[shortcut]   datetime/${label} → ${ms}ms | ${ok(raw) ? summarize(raw) : "❌ " + raw.slice(0, 50)}`);
  }

  console.log(`\n[shortcut] ── B) Rescan mois courant ×5 ──`);
  const times: number[] = [];
  const { start, end } = monthRange(0);
  for (let i = 0; i < 5; i++) {
    const { ms, raw } = await jsonpInPage("datetime/", {
      ...baseData(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1",
    });
    times.push(ms);
    console.log(`[shortcut]   rescan #${i + 1} → ${ms}ms | ${ok(raw) ? summarize(raw) : "❌ " + raw.slice(0, 40)}`);
  }
  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  console.log(`\n╔══════════════ VERDICT ══════════════╗`);
  console.log(`  Solve initial : ${((Date.now() - t0) / 1000).toFixed(0)}s (amorti)`);
  console.log(`  Rescan datetime/ : min ${Math.min(...times)}ms / moy ${avg}ms / max ${Math.max(...times)}ms`);
  console.log(`╚══════════════════════════════════════╝`);
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
