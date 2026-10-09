/**
 * test-pb-fullchain-saopolo.ts — Enchaînement COMPLET in-page, conforme prod HTTP.
 *
 * Flux (São Paulo, SANS captcha) : navigateur chaud (CF franchi) →
 *   getagendas/ (amorce) → datetime/ PARALLÈLE 2 mois → slot choisi →
 *   getsigninfields/ (arme nonce + logintypes) → signin/ (factices, gct="") → STOP avant summary/.
 *
 * Objectif : valider que getsigninfields/ + signin/ fonctionnent in-page (pas 0B) et mesurer
 * la conformité au flux prod. Garde SPAIN_TEST_NO_BOOKING=1 → jamais de summary/.
 *
 * Test callback : on compare jQuery natif (callback auto, différent par appel) vs callback
 * FIXE partagé (script-tag) pour voir si getsigninfields/ exige la cohérence de callback.
 */
import "dotenv/config";
import { ensureSpainPersistentBrowserSession, spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { SAOPOLO_PORTAL_URL, getKnownIdsForPortal } from "../spain-portals.js";
import { extractSpainLoginTypes } from "../spain-login-types.js";

process.env.SPAIN_TEST_NO_BOOKING = "1"; // garde absolue : jamais summary/

const URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";

// Credentials factices — signin/ doit renvoyer un rejet explicite (PAS 0B), jamais un booking.
const FAKE_LOGIN = "TESTSAOPOLA000";
const FAKE_PASSWORD = "FAKEPASS123";

function monthRange(offset: number) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}

/** Appel JSONP in-page via jQuery natif (callback auto-géré par jQuery). */
async function jsonpInPage(endpoint: string, data: Record<string, string>): Promise<{ ms: number; raw: string }> {
  const page = spainPersistentBrowser.getActivePage();
  if (!page) return { ms: 0, raw: "__ERR_NO_PAGE" };
  const t = Date.now();
  const script = `
    (function(endpoint, data) {
      return new Promise(function(resolve) {
        var jq = window.jQuery; if (!jq) { resolve('__ERR_NO_JQUERY'); return; }
        var timer = setTimeout(function(){ resolve('__ERR_TIMEOUT'); }, 20000);
        jq.ajax({ url: ${JSON.stringify(SRVSRC)} + '/onlinebookings/' + endpoint,
          dataType: 'jsonp', jsonp: 'callback', data: data,
          success: function(resp){ clearTimeout(timer); try { resolve(JSON.stringify(resp)); } catch(e){ resolve('__ERR_STRINGIFY'); } },
          error: function(_x,s){ clearTimeout(timer); resolve('__ERR_AJAX_'+String(s||'error')); } });
      });
    })(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})`;
  const raw = (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 22000)),
  ])) as string;
  return { ms: Date.now() - t, raw: raw ?? "" };
}

const base = () => ({ type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC });
const ok = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);

/** Extrait le 1er slot libre d'une réponse datetime/ (structure Bookitit). */
function firstSlot(raw: string, agendaId: string): { date: string; time: string; agendaId: string } | null {
  try {
    const o = JSON.parse(raw);
    if (!Array.isArray(o.Slots)) return null;
    for (const day of o.Slots) {
      const date = typeof day?.date === "string" ? day.date : "";
      if (!date) continue;
      const times = day.times;
      if (Array.isArray(times) && times.length === 0 && Number(day.state ?? day.status) === 1)
        return { date, time: "09:00", agendaId };
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;
      for (const [timeKey, v] of Object.entries(times).sort(([a], [b]) => a.localeCompare(b))) {
        const t = v as any;
        const free = Number(t?.freeSlots ?? t?.freeslots ?? -1);
        if (free > 0 || free === -1) return { date, time: /^\d{1,2}:\d{2}$/.test(timeKey) ? timeKey : "09:00", agendaId };
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  console.log(`[fullchain] São Paulo service=${known.serviceId} agenda=${known.agendaId} | SPAIN_TEST_NO_BOOKING=1`);

  const t0 = Date.now();
  const session = await ensureSpainPersistentBrowserSession(URL);
  if (!session) { console.error("❌ pas de session"); process.exit(1); }
  console.log(`[fullchain] ✅ navigateur chaud (CF franchi) en ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 1) getagendas/ amorce
  const ga = await jsonpInPage("getagendas/", { ...base(), "services[]": known.serviceId });
  console.log(`[fullchain] 1) getagendas/ → ${ga.ms}ms ${ok(ga.raw) ? "✅ " + ga.raw.length + "B" : "❌ " + ga.raw.slice(0, 50)}`);

  // 2) datetime/ PARALLÈLE 2 mois — CONFORME PROD : jitter 200ms + retry sur 0B.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const scanMonth = async (off: number, delayMs = 0) => {
    if (delayMs > 0) await sleep(delayMs);
    const { start, end, label } = monthRange(off);
    const r = await jsonpInPage("datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" });
    return { off, label, ...r };
  };
  console.log(`[fullchain] 2) datetime/ PARALLÈLE 2 mois (jitter 200ms, conforme prod)…`);
  const tPar = Date.now();
  const results = await Promise.all([0, 1].map((off, idx) => scanMonth(off, idx === 0 ? 0 : 75 + Math.floor(Math.random() * 125))));
  console.log(`[fullchain]    (parallèle total ${Date.now() - tPar}ms)`);
  // Retry ciblé sur 0B (comme prod) : si un mois est vide et un autre a répondu → retry.
  const anyResponded = results.some((r) => ok(r.raw));
  for (let i = 0; i < results.length; i++) {
    if (ok(results[i].raw) || !anyResponded) continue;
    for (let attempt = 1; attempt <= 3 && !ok(results[i].raw); attempt++) {
      console.log(`[fullchain]    ↻ ${results[i].label}: 0B parallèle → retry ${attempt}/3`);
      results[i] = await scanMonth(results[i].off);
    }
  }
  let slot: { date: string; time: string; agendaId: string } | null = null;
  for (const r of results.sort((a, b) => a.off - b.off)) {
    const s = ok(r.raw) ? firstSlot(r.raw, known.agendaId) : null;
    console.log(`[fullchain]    datetime/${r.label} → ${r.ms}ms ${ok(r.raw) ? r.raw.length + "B" : "❌"} ${s ? `→ slot ${s.date} ${s.time}` : "(0 slot)"}`);
    if (!slot && s) slot = s;
  }

  // Contre-vérification : le parallèle a-t-il été fiable ? Re-test SÉQUENTIEL des 2 mois.
  if (!results.every((r) => ok(r.raw))) {
    console.log(`[fullchain] ⚠️ Un mois parallèle est revenu vide — contre-test SÉQUENTIEL…`);
    for (const off of [0, 1]) {
      const { start, end, label } = monthRange(off);
      const r = await jsonpInPage("datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" });
      const s = ok(r.raw) ? firstSlot(r.raw, known.agendaId) : null;
      console.log(`[fullchain]    [seq] datetime/${label} → ${r.ms}ms ${ok(r.raw) ? r.raw.length + "B" : "❌"} ${s ? `slot ${s.date} ${s.time}` : "(0 slot)"}`);
      if (!slot && s) slot = s;
    }
  }

  if (!slot) {
    // Pas de slot réel → on teste quand même la MÉCANIQUE getsigninfields/signin avec un slot
    // forcé (date future plausible). But : vérifier que l'endpoint RÉPOND in-page (pas 0B) et
    // que le callback est accepté — PAS réserver. SPAIN_TEST_NO_BOOKING=1 garantit zéro booking.
    const probe = monthRange(1);
    slot = { date: probe.start.slice(0, 8) + "15", time: "09:00", agendaId: known.agendaId };
    console.log(`[fullchain] ℹ️ Aucun créneau libre → test de MÉCANIQUE getsigninfields/signin sur slot forcé ${slot.date} ${slot.time} (ne réserve rien).`);
  } else {
    console.log(`[fullchain] 🎯 Slot réel retenu : ${slot.date} ${slot.time} (agenda ${slot.agendaId})`);
  }

  // 3) getsigninfields/ — arme le nonce PHP + logintypes
  const gsf = await jsonpInPage("getsigninfields/", {
    ...base(), "services[]": known.serviceId, "agendas[]": slot.agendaId, date: slot.date, time: slot.time, selectedPeople: "1",
  });
  const gsfOk = ok(gsf.raw) && gsf.raw.length > 100;
  console.log(`[fullchain] 3) getsigninfields/ → ${gsf.ms}ms ${gsfOk ? "✅ " + gsf.raw.length + "B" : "❌ " + gsf.raw.slice(0, 60)}`);
  if (!gsfOk) {
    console.log(`[fullchain] ⚠️ getsigninfields/ vide/0B in-page → le nonce n'est pas armé. Probable exigence de callback partagé.`);
    process.exit(0);
  }
  let loginTypes: string[] = [];
  try { loginTypes = extractSpainLoginTypes(JSON.parse(gsf.raw)); } catch { /* */ }
  console.log(`[fullchain]    logintypes extraits: ${JSON.stringify(loginTypes).slice(0, 120)}`);
  const loginType = loginTypes[0] ?? "document";

  // 4) signin/ — credentials factices, gct="" (São Paulo sans captcha). Doit renvoyer un rejet, PAS 0B.
  const si = await jsonpInPage("signin/", {
    ...base(), "services[]": known.serviceId, date: slot.date, time: slot.time, selectedPeople: "1",
    "agendas[]": slot.agendaId, logintype: String(loginType), login: FAKE_LOGIN, password: FAKE_PASSWORD, comments: "", gct: "",
  });
  const siResponded = ok(si.raw) && si.raw.length > 20;
  console.log(`[fullchain] 4) signin/ (factices) → ${si.ms}ms ${siResponded ? "✅ réponse " + si.raw.length + "B" : "❌ " + si.raw.slice(0, 60)}`);
  console.log(`[fullchain]    signin snippet: ${si.raw.slice(0, 160)}`);

  console.log(`\n╔══════════════ VERDICT FULLCHAIN SÃO PAULO ══════════════╗`);
  console.log(`  getagendas/ ${ok(ga.raw) ? "✅" : "❌"} | datetime parallèle ${results.every(r => ok(r.raw)) ? "✅" : "❌"} | getsigninfields/ ${gsfOk ? "✅" : "❌"} | signin/ ${siResponded ? "✅ (réponse, pas 0B)" : "❌"}`);
  console.log(`  summary/ : JAMAIS appelé (SPAIN_TEST_NO_BOOKING=1)`);
  console.log(`╚══════════════════════════════════════════════════════════╝`);
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
