/**
 * test-saopolo-hybrid-timing.ts — Valide l'approche HYBRIDE : navigateur pour la session CF,
 * puis requêtes HTTP (JSONP) EN ARRIÈRE-PLAN DEPUIS LA PAGE, en sautant les étapes lourdes.
 *
 * Mesure le TIMING : le solve CF initial se fait UNE FOIS (coûteux). Ensuite chaque cycle
 * datetime/ via callBookititViaJQueryInPage doit être rapide (<2s) pour tenir sous les
 * contraintes de créneaux (<40s). On boucle N cycles et on chronomètre chacun.
 *
 * USAGE :
 *   CHROMIUM_EXECUTABLE_PATH=/opt/playwright/chromium-1232/chrome-linux64/chrome \
 *   DECODO_PROXY_URL="http://...@host:port" \
 *   npx tsx src/scripts/test-saopolo-hybrid-timing.ts
 */
import "dotenv/config";
process.env.SPAIN_SESSION_MODE = "persistent-browser";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const LOOPS = Number(process.env.LOOPS ?? 6);

function log(m: string) { console.log(`[hybrid] ${m}`); }

async function main() {
  const { ensureSpainPersistentBrowserSession, callBookititViaJQueryInPage } =
    await import("../_legacy_spain-persistent-browser.js");

  // ── 1. Session CF via navigateur (UNE FOIS) ─────────────────────────────────
  const t0 = Date.now();
  log(`═══ 1. Solve CF initial (navigateur) ═══`);
  const session = await ensureSpainPersistentBrowserSession(SAOPOLO_URL.split("#")[0]);
  const solveMs = Date.now() - t0;
  if (!session) { console.error("❌ session PB échouée"); process.exit(1); }
  const bs: any = (session as any).bookititState ?? {};
  const php = session.allCookies?.find((c) => c.name === "PHPSESSID");
  log(`✅ Session prête en ${(solveMs/1000).toFixed(1)}s | PHPSESSID=${php ? "✅" : "❌"} | srvsrc=${bs.srvsrc} v=${bs.version}`);

  // Construire une URL datetime/ (mois courant) depuis bookititState
  const publickey = bs.publickey ?? SAOPOLO_URL.match(/widgetdefault\/([^/?#]+)/)?.[1] ?? "";
  const base = bs.bookititBase ?? "https://www.citaconsular.es/onlinebookings";
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const end = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${lastDay}`;

  // On a besoin d'un service + agenda. On les prend via getservices/ + getagendas/ une fois.
  const buildUrl = (endpoint: string, extra: Record<string,string> = {}) => {
    const cb = `jQuery21109${Date.now()}_${Math.floor(Math.random()*1e9)}`;
    const p = new URLSearchParams({ callback: cb, type: "default", publickey, lang: "es",
      version: bs.version ?? "4", src: SAOPOLO_URL, srvsrc: bs.srvsrc ?? "", _: String(Date.now()) });
    for (const [k,v] of Object.entries(extra)) p.append(k, v);
    return `${base}/${endpoint}?${p.toString()}`;
  };
  const parseJsonp = (s: string) => { try { const m = s.match(/\(([\s\S]*)\)[;\s]*$/); return JSON.parse(m ? m[1] : s); } catch { return null; } };

  // ── 3. Boucle de CYCLES COMPLETS (nouveau PHPSESSID à chaque scan) ──────────
  // Comme la prod : à chaque cycle on refait getwidgetconfigurations/ → getservices/ →
  // getagendas/ → datetime/ (nouveau PHPSESSID), SANS re-solver CF (cf_clearance réutilisé).
  log(`\n═══ 3. Cycles COMPLETS × ${LOOPS} (nouveau PHPSESSID/cycle, cf_clearance réutilisé) ═══`);
  const times: number[] = [];
  for (let i=1; i<=LOOPS; i++) {
    const ts = Date.now();

    // a. getwidgetconfigurations/ → (ré)initialise la session PHP → nouveau PHPSESSID
    const cfgRaw = await callBookititViaJQueryInPage(buildUrl("getwidgetconfigurations/"));
    // b. getservices/
    const svcRaw = await callBookititViaJQueryInPage(buildUrl("getservices/"));
    const svc = parseJsonp(svcRaw);
    const services = svc?.Services ?? svc?.services ?? [];
    const svcId = services.find((s:any)=> (s.name??"").replace(/<[^>]*>/g,"").trim())?.id ?? services[0]?.id ?? "";
    // c. getagendas/
    const agRaw = await callBookititViaJQueryInPage(buildUrl("getagendas/", { "services[]": svcId, selectedPeople: "1" }));
    const ag = parseJsonp(agRaw);
    const agendaId = (ag?.Agendas ?? ag?.agendas ?? []).find((a:any)=>a?.id)?.id ?? "";
    // d. datetime/
    const dtRaw = agendaId ? await callBookititViaJQueryInPage(buildUrl("datetime/", {
      "services[]": svcId, "agendas[]": agendaId, start, end, selectedPeople: "1",
    })) : "";

    const ms = Date.now() - ts;
    times.push(ms);
    const cfgOk = cfgRaw.length > 2 && !cfgRaw.startsWith("__ERR");
    const svcOk = services.length > 0;
    const dtOk = dtRaw.length > 2 && !dtRaw.startsWith("__ERR");
    log(`  cycle ${i}/${LOOPS}: cfg=${cfgOk?"✅":"❌"} svc=${svcOk?services.length:"❌"} ag=${agendaId?"✅":"∅"} dt=${dtOk?dtRaw.length+"B":"∅"} | ${ms}ms (${(ms/1000).toFixed(1)}s)`);
    await new Promise(r=>setTimeout(r, 300));
  }

  const avg = times.reduce((a,b)=>a+b,0)/times.length;
  const min = Math.min(...times), max = Math.max(...times);
  log(`\n═══ RÉSULTAT TIMING ═══`);
  log(`Solve CF initial (1×, réutilisé ~115min) : ${(solveMs/1000).toFixed(1)}s`);
  log(`Cycle COMPLET (nouveau PHPSESSID) moy    : ${(avg/1000).toFixed(2)}s (min ${(min/1000).toFixed(2)}s / max ${(max/1000).toFixed(2)}s)`);
  log(`→ ${avg < 40000 ? "✅ VIABLE sous 40s" : "⚠️ dépasse 40s"} — un scan complet = ~${(avg/1000).toFixed(1)}s (hors solve CF)`);
  process.exit(0);
}
main().catch(e => { console.error("fatal:", e); process.exit(1); });
