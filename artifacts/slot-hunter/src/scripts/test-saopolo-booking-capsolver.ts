/**
 * test-saopolo-booking-capsolver.ts
 *
 * Test bout-en-bout du NOUVEAU SYSTÈME (capsolver-residential) sur Saopolo,
 * jusqu'à la tentative de booking avec de faux identifiants.
 *
 * Flow :
 *   1. Session CF via ensureSpainCfSession (SPAIN_SESSION_MODE=capsolver-residential)
 *   2. Session Bookitit isolée (PHPSESSID frais via /main/ dédié)
 *   3. getwidgetconfigurations/ → captcha flag + registration_type
 *   4. getservices/ → serviceId
 *   5. getagendas/ → agendaId
 *   6. datetime/ (mois par mois, dynamique) → premier créneau dispo
 *   7. signin/ avec FAUX credentials → log réponse brute serveur
 *   8. Si signin/ retourne 0B → log diagnostic + retry avec session re-isolée
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   CAPSOLVER_API_KEY=$CAPSOLVER_API_KEY \
 *   node_modules/.bin/tsx src/scripts/test-saopolo-booking-capsolver.ts
 */

import "dotenv/config";
import {
  ensureSpainCfSession,
  makeBookititUrl,
  spainCfFetch,
  cloneSpainCfSessionForDossier,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import { createIsolatedBookingSession } from "../spain-http-booking.js";
import {
  SAOPOLO_PORTAL_URL,
  SAOPOLO_DEFAULT_SERVICE_ID,
  CUBA_LMD_PORTAL_URL,
  CAMEROON_WIDGET_KEY,
  extractWidgetKey,
} from "../spain-portals.js";

// ── Portail cible (override via PORTAL_URL env var) ───────────────────────────
function buildPortalUrl(raw: string): string {
  // Accepte soit une URL complète, soit juste la widget key
  if (raw.startsWith("http")) return raw;
  return `https://www.citaconsular.es/es/hosteds/widgetdefault/${raw}/`;
}
const PORTAL_URL: string = process.env.PORTAL_URL
  ? buildPortalUrl(process.env.PORTAL_URL)
  : SAOPOLO_PORTAL_URL;

// ── Faux identifiants (aucun compte réel) ────────────────────────────────────
const FAKE_LOGIN    = "AB123456X";          // Format passeport espagnol fictif
const FAKE_PASSWORD = "fake_test_password_99";

// ── Helpers ───────────────────────────────────────────────────────────────────
const T0 = Date.now();
const ts = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log   = (msg: string)           => console.log(`[${ts()}] ${msg}`);
const ok    = (msg: string)           => console.log(`[${ts()}] ✅ ${msg}`);
const warn  = (msg: string)           => console.warn(`[${ts()}] ⚠️  ${msg}`);
const err   = (msg: string)           => console.error(`[${ts()}] ❌ ${msg}`);
const sep   = (title: string)         => console.log(
  `\n${"═".repeat(70)}\n  ${title}\n${"═".repeat(70)}`,
);

function parseJsonp(raw: string): unknown {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { return null; }
  }
  const m = t.match(/^[^\(]+\(([\s\S]*)\);?\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

const JSONP_HEADERS = {
  Accept: "text/javascript, application/javascript, application/ecmascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  Referer: PORTAL_URL,
};

// ── JSONP caller via spainCfFetch ────────────────────────────────────────────
async function callJsonp(
  session: SpainCfSession,
  endpoint: string,
  extra?: Record<string, string>,
): Promise<{ raw: string; parsed: unknown; httpStatus: number }> {
  const url = makeBookititUrl(session, endpoint, extra);
  const res = await spainCfFetch(url, session, { headers: JSONP_HEADERS });
  if (!res) return { raw: "", parsed: null, httpStatus: 0 };
  const raw = await res.text();
  return { raw, parsed: parseJsonp(raw), httpStatus: res.status };
}

// ── Extrait le premier ID dans une structure JSON imbriquée ──────────────────
function extractFirstId(obj: unknown, pattern: RegExp): string[] {
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (pattern.test(k) && (typeof val === "string" || typeof val === "number")) {
        ids.push(String(val));
      } else {
        walk(val);
      }
    }
    if (Array.isArray(v)) v.forEach(walk);
  };
  walk(obj);
  return [...new Set(ids)];
}

// ── Extrait le premier créneau dispo depuis la réponse datetime/ ─────────────
// Structure réelle Bookitit (confirmée par test-bookitit-dynamic.ts 2026-08-11) :
//   { "Slots": [{ "date": "2026-09-17", "times": { "key": { "time": "09:00", "freeSlots": 2, "totalSlots": 0 } } }], "maxDays": "2026-09-30" }
function extractFirstSlot(payload: unknown): { date: string; time: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const slotsArr = (payload as Record<string, unknown>).Slots;
  if (!Array.isArray(slotsArr)) return null;
  for (const day of slotsArr) {
    const date  = (day as Record<string, unknown>).date as string | undefined;
    const times = (day as Record<string, unknown>).times;
    if (!date || !times || typeof times !== "object") continue;
    for (const timeInfo of Object.values(times) as Array<Record<string, unknown>>) {
      const time = timeInfo.time as string | undefined;
      const free = Number(timeInfo.freeSlots ?? 0);
      if (time && free > 0) return { date, time };
    }
  }
  return null;
}

// ── Compte les créneaux libres dans une réponse datetime/ ────────────────────
function countSlots(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const slotsArr = (payload as Record<string, unknown>).Slots;
  if (!Array.isArray(slotsArr)) return 0;
  let n = 0;
  for (const day of slotsArr) {
    const times = (day as Record<string, unknown>).times;
    if (!times || typeof times !== "object") continue;
    for (const timeInfo of Object.values(times) as Array<Record<string, unknown>>) {
      if (Number(timeInfo.freeSlots ?? 0) > 0) n++;
    }
  }
  return n;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const portalLabel = extractWidgetKey(PORTAL_URL).slice(0, 12) + "…";
  sep(`TEST BOOKING CAPSOLVER-RESIDENTIAL — ${portalLabel} — ${new Date().toISOString()}`);
  log(`Portail : ${PORTAL_URL}`);
  log(`Mode    : ${process.env.SPAIN_SESSION_MODE ?? "(non défini)"}`);
  log(`Fake ID : ${FAKE_LOGIN} / ${FAKE_PASSWORD}`);

  // ── 1. Session CF ─────────────────────────────────────────────────────────
  sep("1 — Session CF (capsolver-residential)");
  const mainSession = await ensureSpainCfSession(PORTAL_URL);
  if (!mainSession?.bookititState) {
    err("Session nulle ou bookititState absent — arrêt");
    process.exit(1);
  }
  ok(`Session établie | /main/: ${mainSession.prefetchedMainHtml?.length ?? 0}B`);
  log(`  port        : ${new URL(mainSession.soaxProxyUrl).port}`);
  log(`  jqCallback  : ${mainSession.bookititState.jqCallback.slice(0, 40)}…`);
  log(`  srvsrc      : ${mainSession.bookititState.srvsrc}`);
  log(`  version     : ${mainSession.bookititState.version}`);

  // ── 2. Session Bookitit isolée (PHPSESSID frais) ──────────────────────────
  sep("2 — Session Bookitit isolée (PHPSESSID frais)");
  const isolated = await createIsolatedBookingSession(mainSession, PORTAL_URL);
  if (!isolated) {
    warn("Impossible d'obtenir session isolée — on continue avec la session principale");
  }
  const bookSession: SpainCfSession = isolated?.session ?? mainSession;
  const phpSessId = bookSession.allCookies.find(c => c.name === "PHPSESSID")?.value;
  ok(`PHPSESSID : ${phpSessId ? phpSessId.slice(0, 12) + "…" : "ABSENT"}`);

  // ── 3. getwidgetconfigurations/ ───────────────────────────────────────────
  sep("3 — getwidgetconfigurations/");
  const { raw: cfgRaw, parsed: cfgParsed, httpStatus: cfgStatus } =
    await callJsonp(bookSession, "getwidgetconfigurations/");
  log(`HTTP ${cfgStatus} | ${cfgRaw.length}B`);
  const widgetCfg = (cfgParsed as any)?.WidgetConfiguration ?? {};
  log(`  captcha          : ${widgetCfg.captcha ?? "N/A"}`);
  log(`  registration_type: ${widgetCfg.registration_type ?? "N/A"}`);
  log(`  waiting_list     : ${widgetCfg.waiting_list ?? "N/A"}`);
  if (cfgRaw.length < 10) warn("getwidgetconfigurations/ → 0B (PHPSESSID pas encore chaud ?)");

  const captchaRequired = widgetCfg.captcha && widgetCfg.captcha !== "0" && widgetCfg.captcha !== 0;
  if (captchaRequired) {
    warn("captcha ≠ 0 → hCaptcha requis pour le vrai booking (test avec gct= vide quand même)");
  } else {
    ok("captcha=0 → gct vide OK pour signin/");
  }

  // ── 4. getservices/ ───────────────────────────────────────────────────────
  sep("4 — getservices/");
  const { raw: svcRaw, parsed: svcParsed, httpStatus: svcStatus } =
    await callJsonp(bookSession, "getservices/", { selectedPeople: "1" });
  log(`HTTP ${svcStatus} | ${svcRaw.length}B`);
  log(`  snippet: ${svcRaw.slice(0, 200)}`);

  // Chercher le serviceId Pasaportes ou prendre le premier disponible
  const serviceIds = extractFirstId(svcParsed, /^id$|service.*id/i);
  const serviceId = serviceIds[0] ?? "";
  ok(`Service cible : ${serviceId} (${serviceIds.length} services trouvés)`);

  if (serviceIds.length === 0) {
    warn("Aucun service détecté → utilisation de l'ID hardcodé Saopolo");
  }

  // ── 5. getagendas/ ────────────────────────────────────────────────────────
  sep("5 — getagendas/");
  const { raw: agRaw, parsed: agParsed, httpStatus: agStatus } =
    await callJsonp(bookSession, "getagendas/", { "services[]": serviceId, selectedPeople: "1" });
  log(`HTTP ${agStatus} | ${agRaw.length}B`);
  log(`  snippet: ${agRaw.slice(0, 200)}`);

  const agendaIds = extractFirstId(agParsed, /^id$|agenda.*id/i);
  const agendaId = agendaIds[0] ?? "";
  ok(`Agenda : ${agendaId || "(aucun)"} (${agendaIds.length} agendas)`);

  // ── 6. datetime/ — navigation dynamique ──────────────────────────────────
  sep("6 — datetime/ (navigation dynamique jusqu'à maxDays)");
  let slotDate = "";
  let slotTime = "";

  const now = new Date();
  let globalMaxDays = "";
  let monthsWithNoSlots = 0;

  for (let mo = 0; mo < 12; mo++) {
    const d = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);

    // Stop si on dépasse maxDays (après au moins 2 mois)
    if (globalMaxDays && mo >= 2) {
      const nextFirst = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
      if (nextFirst > globalMaxDays) {
        log(`  ⏹ Fin : ${nextFirst} > maxDays ${globalMaxDays}`);
        break;
      }
    }

    const extra: Record<string, string> = {
      "services[]": serviceId,
      start,
      end,
      selectedPeople: "1",
    };
    if (agendaId) extra["agendas[]"] = agendaId;

    const { raw: dtRaw, parsed: dtParsed, httpStatus: dtStatus } =
      await callJsonp(bookSession, "datetime/", extra);

    // Extraire maxDays
    const md = (dtParsed as any)?.maxDays ?? (dtRaw.match(/"maxDays"\s*:\s*"([^"]+)"/)?.[1] ?? "");
    if (md && (!globalMaxDays || md > globalMaxDays)) globalMaxDays = md;

    // Compter les créneaux — structure réelle: {Slots: [{date, times: {key: {freeSlots, time}}}]}
    const monthSlots = countSlots(dtParsed);

    log(`  ${start.slice(0, 7)} → HTTP ${dtStatus} | ${dtRaw.length}B | ${monthSlots} créneau(x) | maxDays=${md || "N/A"}`);
    if (dtRaw.length > 100 && monthSlots === 0) {
      // Logguer la structure pour diagnostic
      log(`    snippet: ${dtRaw.slice(0, 300)}`);
    }

    if (monthSlots === 0 && dtRaw.length < 100) {
      monthsWithNoSlots++;
      if (monthsWithNoSlots >= 3) {
        warn("3 mois consécutifs vides sans maxDays → stop");
        break;
      }
    } else {
      monthsWithNoSlots = 0;
    }

    if (!slotDate || !slotTime) {
      const slot = extractFirstSlot(dtParsed);
      if (slot) {
        slotDate = slot.date;
        slotTime = slot.time;
      }
    }
  }

  if (!slotDate || !slotTime) {
    warn("Aucun créneau trouvé — on tente signin/ sans date/heure pour voir la réponse");
    slotDate = "2026-09-17";
    slotTime = "09:00";
    log(`  Créneau hardcodé : ${slotDate} ${slotTime} (connu actif depuis le test dynamique)`);
  } else {
    ok(`Créneau : ${slotDate} à ${slotTime}`);
  }

  // ── 6b. getsigninfields/ — probe du nonce PHP ────────────────────────────
  sep("6b — getsigninfields/ (nonce PHP — probe)");
  // Ce call est normalement déclenché automatiquement par le widget Backbone JS
  // quand il navigue vers #selecttime/{date}/{time}/{svc}/{ag}.
  // Le serveur PHP stocke un nonce dans la session AVANT d'accepter signin/.
  // → Tester si on peut déclencher ce nonce via HTTP pur.
  const signinFieldsExtra: Record<string, string> = {
    "services[]": serviceId,
    date: slotDate,
    time: slotTime,
    selectedPeople: "1",
  };
  if (agendaId) signinFieldsExtra["agendas[]"] = agendaId;

  const { raw: sfRaw, parsed: sfParsed, httpStatus: sfStatus } =
    await callJsonp(bookSession, "getsigninfields/", signinFieldsExtra);
  log(`HTTP ${sfStatus} | ${sfRaw.length}B`);
  log(`  Raw (400c) : ${sfRaw.slice(0, 400) || "(vide)"}`);
  log(`  Parsed     : ${JSON.stringify(sfParsed)?.slice(0, 300) || "null"}`);

  if (sfRaw.length === 0) {
    warn("getsigninfields/ → 0B — nonce PHP ne peut pas être déclenché via HTTP pur");
    warn("→ signin/ nécessite le widget Backbone actif (browser) pour ce portail (registration_type=2)");
  } else {
    ok("getsigninfields/ → réponse reçue ! Tentative signin/ avec le nonce…");
  }

  // ── 7. signin/ avec faux credentials ──────────────────────────────────────
  sep("7 — signin/ avec faux credentials");
  log(`  login     : ${FAKE_LOGIN}`);
  log(`  password  : ${FAKE_PASSWORD}`);
  log(`  date      : ${slotDate}`);
  log(`  time      : ${slotTime}`);
  log(`  serviceId : ${serviceId}`);
  log(`  agendaId  : ${agendaId}`);

  const signinExtra: Record<string, string> = {
    "services[]": serviceId,
    date: slotDate,
    time: slotTime,
    logintype: "document",
    login: FAKE_LOGIN,
    password: FAKE_PASSWORD,
    gct: "",
    comments: "",
    selectedPeople: "1",
  };
  if (agendaId) signinExtra["agendas[]"] = agendaId;

  const { raw: signinRaw, parsed: signinParsed, httpStatus: signinStatus } =
    await callJsonp(bookSession, "signin/", signinExtra);

  log(`\n  HTTP Status : ${signinStatus}`);
  log(`  Body size   : ${signinRaw.length}B`);
  log(`  Raw (500c)  :\n${signinRaw.slice(0, 500)}`);
  log(`  Parsed      : ${JSON.stringify(signinParsed, null, 2)}`);

  if (signinRaw.length === 0) {
    sep("7b — signin/ retourné 0B → retry avec session re-isolée");
    warn("signin/ → 0B sur session isolée → création d'une 2ème session isolée fraîche…");

    const isolated2 = await createIsolatedBookingSession(mainSession, PORTAL_URL);
    const bookSession2: SpainCfSession = isolated2?.session ?? bookSession;
    const php2 = bookSession2.allCookies.find(c => c.name === "PHPSESSID")?.value;
    log(`  Nouvelle PHPSESSID : ${php2 ? php2.slice(0, 12) + "…" : "ABSENT"}`);

    const { raw: s2Raw, parsed: s2Parsed, httpStatus: s2Status } =
      await callJsonp(bookSession2, "signin/", signinExtra);

    log(`\n  HTTP Status (retry) : ${s2Status}`);
    log(`  Body size   (retry) : ${s2Raw.length}B`);
    log(`  Raw (500c)  (retry) :\n${s2Raw.slice(0, 500)}`);
    log(`  Parsed      (retry) : ${JSON.stringify(s2Parsed, null, 2)}`);
  }

  // ── Résumé ────────────────────────────────────────────────────────────────
  sep("RÉSUMÉ FINAL");
  ok(`Session CF          : ✅ ${mainSession.prefetchedMainHtml?.length ?? 0}B /main/`);
  ok(`Session isolée      : ${isolated ? "✅" : "⚠️  (fallback session principale)"}`);
  log(`getwidgetconfigurations : ${cfgRaw.length > 0 ? "✅" : "❌"} (${cfgRaw.length}B)`);
  log(`getservices             : ${svcRaw.length > 0 ? "✅" : "❌"} (${svcRaw.length}B)`);
  log(`getagendas              : ${agRaw.length > 0 ? "✅" : "❌"} (${agRaw.length}B)`);
  log(`Créneau cible           : ${slotDate} ${slotTime}`);
  log(`signin/ réponse         : HTTP ${signinStatus} | ${signinRaw.length}B`);

  const signinData = signinParsed as any;
  if (signinData?.errors?.length > 0 || signinData?.error) {
    ok(`signin/ → ERREUR SERVEUR REÇUE (comportement attendu avec faux credentials):`);
    log(`  ${JSON.stringify(signinData.errors ?? signinData.error)}`);
  } else if (signinRaw.length === 0) {
    warn("signin/ → 0B — PHPSESSID non encore chaud pour cet endpoint (voir 7b)");
  } else if (signinData?.bktToken) {
    warn("signin/ → bktToken reçu avec faux credentials — comportement inattendu!");
    log(`  bktToken: ${String(signinData.bktToken).slice(0, 40)}`);
  } else {
    log(`signin/ réponse inattendue : ${JSON.stringify(signinData)?.slice(0, 300)}`);
  }
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
