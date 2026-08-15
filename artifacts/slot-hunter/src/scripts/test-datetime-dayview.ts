/**
 * Test ciblé : appel datetime/ en vue-jour (start=date&end=date)
 * Vérifie si le serveur retourne les heures et freeslots pour un jour disponible.
 *
 * Usage:
 *   SPAIN_HTTP_MODE=1 SPAIN_SESSION_MODE=capsolver-residential tsx src/scripts/test-datetime-dayview.ts
 */

import { ensureSpainCfSession, spainCfFetch } from "../spain-soax-solver.js";
import { initSpainRedis }                     from "../spain-redis-persistence.js";
import { restoreSpainSoaxStateFromRedis }     from "../spain-soax-solver.js";
/** Extrait le payload JSONP (callback(...) → objet interne). */
function parseJsonpPayload(text: string): unknown | null {
  const t = text.trim();
  const m = t.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// Portail Saopola (PASAPORTES) — 242 créneaux connus
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/#services";
const PUBLICKEY  = "2d01502f12dc08400e22aea87fb00ae34";
const SERVICE_ID = "bkt853215";   // [A] PASAPORTES
const AGENDA_ID  = "bkt439185";   // agenda connu (ajuster si besoin)

// Dates à tester (disponibles d'après le scan mensuel)
const TEST_DATES = ["2026-08-17", "2026-08-18", "2026-09-16"];

async function main() {
  console.log("=== TEST datetime/ VUE-JOUR ===\n");

  await initSpainRedis();
  await restoreSpainSoaxStateFromRedis();

  const session = await ensureSpainCfSession(PORTAL_URL);
  if (!session) { console.error("❌ Impossible d'obtenir une session CF"); process.exit(1); }
  console.log(`✅ Session CF obtenue — PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 12)}…\n`);

  const cb       = session.bookititState?.jqCallback ?? `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  const referer  = PORTAL_URL.replace(/#.*/, "/");
  const base     = "https://www.citaconsular.es/onlinebookings/";
  const headers = {
    Referer: referer,
    "X-Requested-With": "XMLHttpRequest",
    Accept: "text/javascript, application/javascript, */*; q=0.01",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Priority: "u=1, i",
  };

  let reqCounter = session.bookititState?.reqCounter ?? Date.now();

  for (const date of TEST_DATES) {
    console.log(`\n── Date: ${date} ──`);

    // 1. Vue MENSUELLE (comportement actuel — retourne times=[])
    const mo = date.slice(0, 7);
    const endOfMonth = new Date(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)), 0).toISOString().slice(0, 10);
    const qMonth = new URLSearchParams({
      callback: cb, type: "default", publickey: PUBLICKEY, lang: "es",
      "services[]": SERVICE_ID,
      "agendas[]": AGENDA_ID,
      version: "4", src: referer, srvsrc: "https://www.citaconsular.es",
      start: `${mo}-01`, end: endOfMonth,
      selectedPeople: "1", _: String(reqCounter++),
    });
    const resMonth = await spainCfFetch(`${base}datetime/?${qMonth}`, session, { headers });
    const rawMonth = resMonth?.ok ? await resMonth.text() : "";
    const parsedMonth = parseJsonpPayload(rawMonth) as Record<string, unknown> | null;
    const slotsMonth  = (parsedMonth?.Slots as unknown[]) ?? [];
    const dayMonth    = (slotsMonth as Record<string, unknown>[]).find(d => (d as Record<string, unknown>).date === date);
    const timesMonth  = dayMonth?.times;
    console.log(`  Vue mensuelle: ${rawMonth.length}B | day ${date} → times=${JSON.stringify(timesMonth)?.slice(0, 200)}`);

    // Petit délai pour éviter le burst
    await new Promise<void>(r => setTimeout(r, 800));

    // 2. Vue JOUR (start=date&end=date — ce que le widget fait après sélection)
    const qDay = new URLSearchParams({
      callback: cb, type: "default", publickey: PUBLICKEY, lang: "es",
      "services[]": SERVICE_ID,
      "agendas[]": AGENDA_ID,
      version: "4", src: referer, srvsrc: "https://www.citaconsular.es",
      start: date, end: date,                  // ← même date = vue jour
      selectedPeople: "1", _: String(reqCounter++),
    });
    const resDay = await spainCfFetch(`${base}datetime/?${qDay}`, session, { headers });
    const rawDay = resDay?.ok ? await resDay.text() : "";
    const parsedDay  = parseJsonpPayload(rawDay) as Record<string, unknown> | null;
    const slotsDay   = (parsedDay?.Slots as unknown[]) ?? [];
    const dayDetail  = (slotsDay as Record<string, unknown>[]).find(d => (d as Record<string, unknown>).date === date);
    const timesDay   = dayDetail?.times;
    console.log(`  Vue jour:      ${rawDay.length}B | times=${JSON.stringify(timesDay)?.slice(0, 400)}`);
    if (rawDay.length > 0 && rawDay.length < 200) console.log(`  Raw complet:   ${rawDay}`);

    await new Promise<void>(r => setTimeout(r, 800));
  }

  console.log("\n=== FIN TEST ===");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
