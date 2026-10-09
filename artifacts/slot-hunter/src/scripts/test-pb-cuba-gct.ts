/**
 * test-pb-cuba-gct.ts — Valider l'injection du gct hCaptcha dans signin/ IN-PAGE (Cuba).
 *
 * Cuba = captchaRequired:true. En HTTP, signin/ reçoit gct=<token> en param. On vérifie que
 * la MÊME injection fonctionne in-page (jQuery JSONP). Flux :
 *   navigateur franchit CF → getagendas → datetime (slot) → getsigninfields → solve gct →
 *   signin/ AVEC gct in-page → STOP avant summary (SPAIN_TEST_NO_BOOKING=1).
 *
 * 2 inconnues : (1) CapSolver résout-il ce hCaptcha ? (NoneCap absent) (2) le gct in-page passe-t-il ?
 */
import "dotenv/config";
import { ensureSpainPersistentBrowserSession, spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { CUBA_LMD_PORTAL_URL, getKnownIdsForPortal, portalRequiresCaptcha } from "../spain-portals.js";
import { extractSpainLoginTypes } from "../spain-login-types.js";
import { solveSpainHcaptcha, HCAPTCHA_SITEKEY } from "../spain-http-booking.js";

process.env.SPAIN_TEST_NO_BOOKING = "1";

const URL = CUBA_LMD_PORTAL_URL.split("#")[0];
const PUBLICKEY = URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
const SRC = URL.replace(/\/?$/, "/");
const SRVSRC = "https://www.citaconsular.es";
const FAKE_LOGIN = "TESTCUBA000";
const FAKE_PASSWORD = "FAKEPASS123";

function monthRange(offset: number) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear(); const m = String(d.getMonth() + 1).padStart(2, "0");
  const last = new Date(y, d.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(last).padStart(2, "0")}`, label: `${y}-${m}` };
}
const base = () => ({ type: "default", publickey: PUBLICKEY, lang: "es", version: "4", src: SRC, srvsrc: SRVSRC });
const ok = (raw: string) => raw && !raw.startsWith("__ERR_") && /[\{\[]/.test(raw);

async function jsonpInPage(endpoint: string, data: Record<string, string>): Promise<string> {
  const page = spainPersistentBrowser.getActivePage();
  if (!page) return "__ERR_NO_PAGE";
  const script = `
    (function(endpoint,data){return new Promise(function(resolve){
      var jq=window.jQuery; if(!jq){resolve('__ERR_NO_JQUERY');return;}
      var t=setTimeout(function(){resolve('__ERR_TIMEOUT');},20000);
      jq.ajax({url:${JSON.stringify(SRVSRC)}+'/onlinebookings/'+endpoint,dataType:'jsonp',jsonp:'callback',data:data,
        success:function(r){clearTimeout(t);try{resolve(JSON.stringify(r));}catch(e){resolve('__ERR_STR');}},
        error:function(_x,s){clearTimeout(t);resolve('__ERR_AJAX_'+String(s||'error'));}});
    });})(${JSON.stringify(endpoint)}, ${JSON.stringify(data)})`;
  return (await Promise.race([
    page.evaluate(script) as Promise<string>,
    new Promise<string>((r) => setTimeout(() => r("__ERR_EVAL_TIMEOUT"), 22000)),
  ])) as string;
}

function firstSlot(raw: string, agendaId: string): { date: string; time: string; agendaId: string } | null {
  try {
    const o = JSON.parse(raw);
    if (!Array.isArray(o.Slots)) return null;
    for (const day of o.Slots) {
      const date = typeof day?.date === "string" ? day.date : "";
      if (!date) continue;
      const times = day.times;
      if (Array.isArray(times) && times.length === 0 && Number(day.state ?? day.status) === 1) return { date, time: "09:00", agendaId };
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;
      for (const [tk, v] of Object.entries(times).sort(([a], [b]) => a.localeCompare(b))) {
        const free = Number((v as any)?.freeSlots ?? (v as any)?.freeslots ?? -1);
        if (free > 0 || free === -1) return { date, time: /^\d{1,2}:\d{2}$/.test(tk) ? tk : "09:00", agendaId };
      }
    }
  } catch { /* */ }
  return null;
}

async function main() {
  const known = getKnownIdsForPortal(URL);
  if (!known) { console.error("❌ portail inconnu"); process.exit(1); }
  console.log(`[cuba-gct] Cuba service=${known.serviceId} agenda=${known.agendaId} | captchaRequired=${portalRequiresCaptcha(URL)}`);

  const session = await ensureSpainPersistentBrowserSession(URL);
  if (!session) { console.error("❌ pas de session"); process.exit(1); }
  console.log(`[cuba-gct] ✅ navigateur chaud (CF franchi)`);

  // getagendas amorce + datetime (plusieurs mois, jitter), Cuba a souvent des créneaux en M+2..M+5
  await jsonpInPage("getagendas/", { ...base(), "services[]": known.serviceId });
  let slot: { date: string; time: string; agendaId: string } | null = null;
  for (let off = 0; off < 6 && !slot; off++) {
    const { start, end, label } = monthRange(off);
    const raw = await jsonpInPage("datetime/", { ...base(), "services[]": known.serviceId, "agendas[]": known.agendaId, start, end, selectedPeople: "1" });
    const s = ok(raw) ? firstSlot(raw, known.agendaId) : null;
    console.log(`[cuba-gct] datetime/${label} → ${ok(raw) ? raw.length + "B" : "❌"} ${s ? "slot " + s.date + " " + s.time : "(0 slot)"}`);
    if (s) slot = s;
  }
  if (!slot) {
    const probe = monthRange(2);
    slot = { date: probe.start.slice(0, 8) + "15", time: "09:00", agendaId: known.agendaId };
    console.log(`[cuba-gct] ℹ️ Aucun créneau — slot forcé ${slot.date} pour tester la MÉCANIQUE (ne réserve rien).`);
  } else {
    console.log(`[cuba-gct] 🎯 Slot réel ${slot.date} ${slot.time}`);
  }

  // getsigninfields → arme + logintypes
  const gsf = await jsonpInPage("getsigninfields/", { ...base(), "services[]": known.serviceId, "agendas[]": slot.agendaId, date: slot.date, time: slot.time, selectedPeople: "1" });
  const gsfOk = ok(gsf) && gsf.length > 100;
  console.log(`[cuba-gct] getsigninfields/ → ${gsfOk ? gsf.length + "B ✅" : "❌ " + gsf.slice(0, 60)}`);
  if (!gsfOk) { console.log(`[cuba-gct] ⚠️ nonce non armé — stop`); process.exit(0); }
  let loginType = "document";
  try { loginType = extractSpainLoginTypes(JSON.parse(gsf))[0] ?? "document"; } catch { /* */ }

  // ── Résolution gct hCaptcha ──
  console.log(`[cuba-gct] 🧩 Résolution hCaptcha (sitekey ${HCAPTCHA_SITEKEY})…`);
  const t = Date.now();
  const gct = await solveSpainHcaptcha(HCAPTCHA_SITEKEY, URL);
  console.log(`[cuba-gct] gct ${gct ? "✅ obtenu (" + gct.length + " car., " + ((Date.now() - t) / 1000).toFixed(1) + "s)" : "❌ ÉCHEC (aucun solveur n'a résolu — NoneCap absent ?)"}`);
  if (!gct) {
    console.log(`[cuba-gct] ⚠️ Pas de gct → on NE peut PAS tester signin/ Cuba (en HTTP la prod break aussi sans gct).`);
    console.log(`[cuba-gct]    (Il faut une clé NONECAP_API_KEY pour résoudre le hCaptcha citaconsular.)`);
    process.exit(0);
  }

  // ── signin/ AVEC gct in-page ──
  const si = await jsonpInPage("signin/", {
    ...base(), "services[]": known.serviceId, date: slot.date, time: slot.time, selectedPeople: "1",
    "agendas[]": slot.agendaId, logintype: loginType, login: FAKE_LOGIN, password: FAKE_PASSWORD, comments: "", gct,
  });
  const siResponded = ok(si) && si.length > 20;
  console.log(`[cuba-gct] signin/ (gct in-page, creds factices) → ${siResponded ? "✅ réponse " + si.length + "B" : "❌ " + si.slice(0, 60)}`);
  console.log(`[cuba-gct]    snippet: ${si.slice(0, 200)}`);

  console.log(`\n╔══════════════ VERDICT GCT IN-PAGE CUBA ══════════════╗`);
  console.log(`  getsigninfields/ ${gsfOk ? "✅" : "❌"} | gct résolu ${gct ? "✅" : "❌"} | signin/ avec gct ${siResponded ? "✅ (réponse, pas 0B)" : "❌"}`);
  console.log(`  → ${gsfOk && gct && siResponded ? "✅ GCT IN-PAGE VALIDÉ : l'injection hCaptcha fonctionne in-page" : "voir détails ci-dessus"}`);
  console.log(`  summary/ JAMAIS appelé (SPAIN_TEST_NO_BOOKING=1)`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);
  process.exit(0);
}
main().catch((e) => { console.error("fatal:", e); process.exit(1); });
