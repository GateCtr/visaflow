/**
 * test-distribution-6dossiers.ts
 *
 * Teste la distribution équitable : 3 dossiers fake sur Saopolo + 3 sur Cuba.
 * Flow 100% HTTP manuel (capsolver-residential) — PAS de scanSpainHttp.
 *
 *   1. Session CF via ensureSpainCfSession
 *   2. Session isolée (PHPSESSID frais) pour le scan
 *   3. getservices/ → service cible (nom visible + AllowAppointment)
 *   4. getagendas/ → agendaId
 *   5. datetime/ mois par mois → collecte TOUS les créneaux (allSlots)
 *   6. Round-robin : dossierA→slot1, dossierB→slot2, dossierC→slot3
 *   7. Pour chaque dossier : session isolée propre → getsigninfields/ → signin/
 *   8. Log réponse serveur — succès si tous = "Usuario o contraseña incorrectos"
 *
 * Usage :
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   CAPSOLVER_API_KEY=xxx \
 *   node_modules/.bin/tsx src/scripts/test-distribution-6dossiers.ts
 */

import "dotenv/config";
import {
  ensureSpainCfSession,
  makeBookititUrl,
  spainCfFetch,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import { createIsolatedBookingSession } from "../spain-http-booking.js";
import { SAOPOLO_PORTAL_URL, CUBA_LMD_PORTAL_URL, extractWidgetKey } from "../spain-portals.js";

const T0 = Date.now();
const ts  = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log  = (msg: string) => console.log(`[${ts()}] ${msg}`);
const ok   = (msg: string) => console.log(`[${ts()}] ✅ ${msg}`);
const warn = (msg: string) => console.warn(`[${ts()}] ⚠️  ${msg}`);
const sep  = (t: string)   => console.log(`\n${"═".repeat(70)}\n  ${t}\n${"═".repeat(70)}`);
const dash = (t: string)   => console.log(`\n${"─".repeat(55)}\n  ${t}\n${"─".repeat(55)}`);

// ── JSONP helpers ─────────────────────────────────────────────────────────────
const JSONP_HEADERS = {
  Accept: "text/javascript, application/javascript, application/ecmascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
};

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

async function callJsonp(
  session: SpainCfSession,
  portalUrl: string,
  endpoint: string,
  extra?: Record<string, string>,
): Promise<{ raw: string; parsed: unknown; status: number }> {
  const url = makeBookititUrl(session, endpoint, extra);
  const referer = portalUrl.replace(/\/?$/, "/");
  const res = await spainCfFetch(url, session, { headers: { ...JSONP_HEADERS, Referer: referer } });
  if (!res) return { raw: "", parsed: null, status: 0 };
  const raw = await res.text();
  return { raw, parsed: parseJsonp(raw), status: res.status };
}

function extractFirstId(obj: unknown, pattern: RegExp): string[] {
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (pattern.test(k) && (typeof val === "string" || typeof val === "number")) ids.push(String(val));
      else walk(val);
    }
    if (Array.isArray(v)) v.forEach(walk);
  };
  walk(obj);
  return [...new Set(ids)];
}

// Extrait TOUS les créneaux d'une réponse datetime/
// Structure Bookitit : {Slots: [{date, times: {key: {time, freeSlots}}}], maxDays}
function extractAllSlots(payload: unknown): Array<{ date: string; time: string; freeslots: number }> {
  const out: Array<{ date: string; time: string; freeslots: number }> = [];
  if (!payload || typeof payload !== "object") return out;
  const arr = (payload as any).Slots;
  if (!Array.isArray(arr)) return out;
  for (const day of arr) {
    const date  = day.date as string | undefined;
    const times = day.times;
    if (!date || !times || typeof times !== "object") continue;
    for (const info of Object.values(times) as Array<Record<string, unknown>>) {
      const time = info.time as string | undefined;
      const free = Number(info.freeSlots ?? -1);
      if (time) out.push({ date, time, freeslots: free });
    }
  }
  return out;
}

// ── Round-robin distribution ──────────────────────────────────────────────────
interface FakeDossier { id: string; name: string; login: string; password: string; }

function assignRoundRobin(
  dossiers: FakeDossier[],
  allSlots: Array<{ date: string; time: string; freeslots: number }>,
): Map<string, { date: string; time: string }> {
  const map = new Map<string, { date: string; time: string }>();
  if (!allSlots.length || !dossiers.length) return map;

  const sorted = [...allSlots].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    return d !== 0 ? d : a.time.localeCompare(b.time);
  });

  let cursor = 0;
  for (const d of dossiers) {
    let assigned = false;
    for (let i = cursor; i < sorted.length; i++) {
      const slot = sorted[i];
      if (slot.freeslots !== -1 && slot.freeslots < 1) continue;
      map.set(d.id, { date: slot.date, time: slot.time });
      cursor = i + 1;
      assigned = true;
      break;
    }
    // Repli depuis le début si cursor épuisé
    if (!assigned) {
      for (const slot of sorted) {
        if (slot.freeslots !== -1 && slot.freeslots < 1) continue;
        map.set(d.id, { date: slot.date, time: slot.time });
        break;
      }
    }
  }
  return map;
}

// ── Dossiers fake ─────────────────────────────────────────────────────────────
function makeDossiers(prefix: string): FakeDossier[] {
  return [1, 2, 3].map(n => ({
    id: `${prefix}-${n}`,
    name: `${prefix} Fake #${n}`,
    login: `fake${n}@test.cd`,
    password: `fake_password_${n}_99`,
  }));
}

// ── Test d'un portail ─────────────────────────────────────────────────────────
async function testPortal(label: string, portalUrl: string, dossiers: FakeDossier[]) {
  sep(`PORTAIL ${label} — ${extractWidgetKey(portalUrl).slice(0, 16)}…`);

  // 1. Session CF principale
  log(`🔐 Session CF...`);
  const mainSession = await ensureSpainCfSession(portalUrl);
  if (!mainSession?.bookititState) {
    warn(`Session CF nulle — abandon ${label}`);
    return;
  }
  ok(`Session CF prête | port=${new URL(mainSession.soaxProxyUrl).port}`);

  // 2. Session isolée pour le scan (1 seule — règle 9 : 1 getagendas/ par PHPSESSID)
  const isoScan = await createIsolatedBookingSession(mainSession, portalUrl);
  const scanSession: SpainCfSession = isoScan?.session ?? mainSession;
  const phpScan = scanSession.allCookies.find(c => c.name === "PHPSESSID")?.value;
  ok(`PHPSESSID scan : ${phpScan ? phpScan.slice(0, 12) + "…" : "ABSENT"}`);

  // 3. getwidgetconfigurations/ — réchauffe la session PHP avant getservices/
  const { raw: cfgRaw, status: cfgSt } =
    await callJsonp(scanSession, portalUrl, "getwidgetconfigurations/");
  log(`getwidgetconfigurations/ → HTTP ${cfgSt} | ${cfgRaw.length}B`);
  if (cfgRaw.length < 10) warn("getwidgetconfigurations/ vide — session peut-être froide");

  // 4. getservices/ — service cible = nom visible + AllowAppointment
  const { raw: svcRaw, parsed: svcParsed, status: svcSt } =
    await callJsonp(scanSession, portalUrl, "getservices/", { selectedPeople: "1" });
  log(`getservices/ → HTTP ${svcSt} | ${svcRaw.length}B`);
  if (svcRaw.length < 10) { warn("getservices/ vide — abandon"); return; }

  const svcList: any[] = (svcParsed as any)?.Services ?? (svcParsed as any)?.services ?? [];
  const rawSvcs = svcList.map(s => ({
    id: String(s.id ?? "").trim(),
    name: String(s.name ?? s.nombre ?? s.titulo ?? "").replace(/<[^>]+>/g, "").trim(),
    allow: s.AllowAppointment !== false && s.allowappointment !== false,
  })).filter(s => s.id);

  for (const s of rawSvcs) log(`  svc ${s.id} | "${s.name}" | allow=${s.allow}`);

  const targetSvc = rawSvcs.find(s => s.allow && s.name.length > 0)
    ?? rawSvcs.find(s => s.allow)
    ?? rawSvcs[0];
  const serviceId = targetSvc?.id ?? "";
  ok(`Service cible : ${serviceId} "${targetSvc?.name ?? ""}"`);
  if (!serviceId) { warn("Aucun service — abandon"); return; }

  // 4. getagendas/ — 1 seul appel par session
  const { raw: agRaw, parsed: agParsed, status: agSt } =
    await callJsonp(scanSession, portalUrl, "getagendas/", { "services[]": serviceId, selectedPeople: "1" });
  log(`getagendas/ → HTTP ${agSt} | ${agRaw.length}B | raw: ${agRaw}`);
  const agendaId = extractFirstId(agParsed, /^id$|agenda.*id/i)[0] ?? "";
  ok(`Agenda : ${agendaId || "(aucun)"}`);

  // 5. datetime/ mois par mois → TOUS les créneaux
  dash("datetime/ — scan complet tous mois");
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  let globalMaxDays  = "";
  let emptyStreak    = 0;
  const allSlots: Array<{ date: string; time: string; freeslots: number }> = [];

  for (let mo = 0; mo < 12; mo++) {
    const d     = new Date(now.getFullYear(), now.getMonth() + mo, 1);
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);

    // Stop si 1er du mois suivant > maxDays (min 2 mois : M + M+1)
    if (globalMaxDays && mo >= 1) {
      const nextFirst = new Date(now.getFullYear(), now.getMonth() + mo + 1, 1).toISOString().slice(0, 10);
      if (nextFirst > globalMaxDays) {
        log(`  ⏹ next=${nextFirst} > maxDays=${globalMaxDays} — stop`);
        break;
      }
    }

    const extra: Record<string, string> = { "services[]": serviceId, start, end, selectedPeople: "1" };
    if (agendaId) extra["agendas[]"] = agendaId;

    const { raw, parsed, status } = await callJsonp(scanSession, portalUrl, "datetime/", extra);
    const md = (parsed as any)?.maxDays ?? (raw.match(/"maxDays"\s*:\s*"([^"]+)"/)?.[1] ?? "");
    // Ignorer maxDays <= aujourd'hui (signal "mois vide", pas limite globale)
    if (md && md > today && (!globalMaxDays || md > globalMaxDays)) globalMaxDays = md;

    const monthSlots = extractAllSlots(parsed);
    for (const s of monthSlots) allSlots.push(s);

    log(`  ${start.slice(0, 7)} → HTTP ${status} | ${raw.length}B | ${monthSlots.length} créneaux | maxDays=${md || "—"}`);

    if (monthSlots.length === 0 && raw.length < 100) {
      emptyStreak++;
      if (!globalMaxDays && emptyStreak >= 3) { warn("3 mois vides sans maxDays → stop"); break; }
    } else {
      emptyStreak = 0;
    }
  }

  ok(`Total créneaux collectés : ${allSlots.length}`);
  if (allSlots.length === 0) { warn("Aucun créneau — abandon"); return; }

  // 6. Distribution round-robin
  dash(`Round-robin ${allSlots.length} créneaux → ${dossiers.length} dossiers`);
  const assignments = assignRoundRobin(dossiers, allSlots);
  for (const d of dossiers) {
    const a = assignments.get(d.id);
    log(`  ${d.name} → ${a ? `${a.date} ${a.time}` : "⚠️ aucun créneau"}`);
  }

  // Vérifier que les dossiers ont bien des créneaux différents
  const assignedSlots = dossiers.map(d => assignments.get(d.id)).filter(Boolean);
  const unique = new Set(assignedSlots.map(a => `${a!.date}|${a!.time}`));
  if (unique.size === assignedSlots.length) {
    ok(`✅ Tous les ${assignedSlots.length} dossiers ont un créneau DIFFÉRENT`);
  } else {
    warn(`Partage de créneaux : ${unique.size} créneaux uniques pour ${assignedSlots.length} dossiers (normal si peu de disponibilités)`);
  }

  // 7. Booking séquentiel — PHPSESSID partagé en mode capsolver (lié au solve CF).
  // getsigninfields/ est stateful par PHPSESSID côté serveur : appels simultanés
  // sur le même PHPSESSID → N-1 dossiers reçoivent 0B (testé et confirmé).
  // Vrai parallèle = 1 solve CF par dossier → coût prohibitif (~20s + $0.01/dossier).
  dash(`Booking × ${dossiers.length} (fake credentials, séquentiel)`);

  for (const dossier of dossiers) {
    const assigned = assignments.get(dossier.id);
    if (!assigned) { log(`  ${dossier.name} → pas de créneau — skip`); continue; }

    const iso = await createIsolatedBookingSession(mainSession, portalUrl);
    const bookSess: SpainCfSession = iso?.session ?? mainSession;

    // datetime/ est appelé automatiquement dans executeHttpBooking (chemin pré-confirmé)
    // pour activer le nonce PHP de getsigninfields/. Ici on le réplique manuellement
    // pour le test afin de reproduire le même comportement.
    const slotMonth = assigned.date.slice(0, 7);
    const dtExtra: Record<string, string> = {
      "services[]": serviceId,
      start: `${slotMonth}-01`,
      end: `${slotMonth}-${String(new Date(Number(slotMonth.slice(0, 4)), Number(slotMonth.slice(5, 7)), 0).getDate()).padStart(2, "0")}`,
      selectedPeople: "1",
    };
    if (agendaId) dtExtra["agendas[]"] = agendaId;
    const { raw: dtRaw, status: dtSt } = await callJsonp(bookSess, portalUrl, "datetime/", dtExtra);
    log(`  ${dossier.name} | datetime/ (${slotMonth}) → HTTP ${dtSt} | ${dtRaw.length}B`);

    const sfExtra: Record<string, string> = {
      "services[]": serviceId,
      date: assigned.date,
      time: assigned.time,
      selectedPeople: "1",
    };
    if (agendaId) sfExtra["agendas[]"] = agendaId;
    const { raw: sfRaw } = await callJsonp(bookSess, portalUrl, "getsigninfields/", sfExtra);
    log(`  ${dossier.name} | getsigninfields/ → ${sfRaw.length}B`);

    const signinExtra: Record<string, string> = {
      "services[]": serviceId,
      date: assigned.date,
      time: assigned.time,
      logintype: "document",
      login: dossier.login,
      password: dossier.password,
      gct: "",
      comments: "",
      selectedPeople: "1",
    };
    if (agendaId) signinExtra["agendas[]"] = agendaId;

    const { raw: signinRaw, parsed: signinParsed, status: signinSt } =
      await callJsonp(bookSess, portalUrl, "signin/", signinExtra);

    const errors = (signinParsed as any)?.Client?.errors
      ?? (signinParsed as any)?.errors
      ?? (signinParsed as any)?.error;
    const errMsg = Array.isArray(errors) ? errors.map((e: any) => e.message).join(", ") : String(errors ?? "");

    log(`  ${dossier.name} | créneau=${assigned.date} ${assigned.time}`);
    log(`    signin/ → HTTP ${signinSt} | ${signinRaw.length}B`);
    log(`    raw     : ${signinRaw.slice(0, 500) || "(vide)"}`);

    if (errMsg.includes("contraseña") || errMsg.includes("password") || errMsg.includes("Usuario")) {
      ok(`    ✅ ${dossier.name} — serveur atteint (mauvais credentials = normal)`);
    } else if (signinRaw.length === 0) {
      warn(`    ${dossier.name} — 0B (session froide)`);
    } else {
      warn(`    ${dossier.name} — réponse inattendue`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  sep(`TEST DISTRIBUTION 6 DOSSIERS — ${new Date().toISOString()}`);

  const portalFilter = process.env.PORTAL_ONLY;

  if (!portalFilter || portalFilter === "saopolo") {
    await testPortal("Saopolo (RDC)", SAOPOLO_PORTAL_URL, makeDossiers("Saopolo"));
  }
  if (!portalFilter || portalFilter === "cuba") {
    await testPortal("Cuba (LMD)", CUBA_LMD_PORTAL_URL, makeDossiers("Cuba"));
  }

  sep(`FIN — ${((Date.now() - T0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
