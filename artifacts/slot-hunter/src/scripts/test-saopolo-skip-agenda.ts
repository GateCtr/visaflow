/**
 * test-saopolo-skip-agenda.ts — Teste si getagendas/ fonctionne en boucle
 * après un seul appel /main/ (skip getwidgetconfigurations/ + getservices/).
 *
 * HYPOTHÈSE : Les services et configs Sao Paulo sont connus :
 *   - serviceId = bkt853215
 *   - agendaId = bkt301070 (attendu)
 *   - publickey = 2d01502f12dc08400e22aea87fb00ae34
 *
 * FLOW :
 *   1. Init CF (CapSolver)
 *   2. GET widget → token
 *   3. POST token → PHPSESSID
 *   4. GET /main/ (une fois — requis pour init PHP)
 *   5. Appeler getagendas/ × 6 (PAS de cfg, PAS de svc)
 *   6. Si agenda OK → datetime/ × 3
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-saopolo-skip-agenda.ts
 */

import "dotenv/config";
import { Impit } from "impit";

// ─── Constantes Sao Paulo (connues, stables) ──────────────────────────────────
const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";
const PUBLICKEY = "2d01502f12dc08400e22aea87fb00ae34";
const KNOWN_SERVICE_ID = "bkt853215";
const KNOWN_AGENDA_ID = "bkt301070"; // attendu dans la réponse

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const LOOP_COUNT = 6;

// ─── Proxy résidentiel (Sao Paulo exige résidentiel, ISP → 0B) ───────────────
async function getProxy(): Promise<string> {
  if (process.env.SPAIN_RESIDENTIAL_PROXY_URL) return process.env.SPAIN_RESIDENTIAL_PROXY_URL;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const csvPath = path.resolve(import.meta.dirname ?? ".", "..", "..", "decodo-proxies.csv");
    const lines = fs.readFileSync(csvPath, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length > 0) return lines[0].trim();
  } catch { /* ignore */ }
  return process.env.SPAIN_ISP_PROXY_URL ?? "";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(msg: string): void { console.log(`[${ts()}] ${msg}`); }
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function buildCookieStr(jar: Record<string, string>): string {
  return Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}
function extractSetCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = {};
  const raw = headers.get("set-cookie") ?? "";
  for (const part of raw.split(/,(?=[^ ])/)) {
    const m = part.trim().match(/^([^=]+)=([^;]*)/);
    if (m) cookies[m[1]] = m[2];
  }
  return cookies;
}

async function main(): Promise<void> {
  section("TEST : getagendas/ direct × 6 (skip /main/ + cfg + svc)");

  if (!CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }
  const PROXY_URL = await getProxy();
  if (!PROXY_URL) { console.error("❌ Aucun proxy disponible"); process.exit(1); }

  // Sticky session
  const stickyId = Math.random().toString(36).slice(2, 10);
  let stickyProxy = PROXY_URL;
  if (PROXY_URL.includes("sessionduration") || PROXY_URL.includes("session-")) {
    try {
      const u = new URL(PROXY_URL);
      const user = decodeURIComponent(u.username);
      const stickyUser = user.includes("-session-")
        ? user.replace(/-session-[^-]+/, `-session-${stickyId}`)
        : `${user}-session-${stickyId}`;
      u.username = encodeURIComponent(stickyUser);
      stickyProxy = u.toString();
    } catch { /* keep */ }
  }

  log(`Proxy    : ${stickyProxy.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}`);
  log(`Service  : ${KNOWN_SERVICE_ID} (connu)`);
  log(`Loops    : ${LOOP_COUNT}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: stickyProxy } as any);
  const jar: Record<string, string> = {};
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

  // ═══ ÉTAPE 1 : GET challenge CF + CapSolver ═══════════════════════════════
  section("1 — CF solve (CapSolver)");
  const cfT0 = Date.now();
  const r1 = await (impit.fetch(SAOPOLO_URL, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9" },
  } as any) as unknown as Promise<Response>);
  const body1 = await r1.text();
  Object.assign(jar, extractSetCookies(r1.headers));

  if (r1.status === 403 || body1.includes("Just a moment")) {
    const proxyFmt = (() => { const u = new URL(stickyProxy); return `${u.hostname}:${u.port || "80"}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`; })();
    const cr = await fetch("https://api.capsolver.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, task: { type: "AntiCloudflareTask", websiteURL: SAOPOLO_URL, userAgent: UA, html: body1, proxy: proxyFmt } }),
    });
    const cd = await cr.json() as any;
    if (cd.errorId) { log(`❌ CapSolver: ${cd.errorCode}: ${cd.errorDescription}`); process.exit(1); }
    log(`Task: ${cd.taskId}`);
    for (let i = 0; i < 60; i++) {
      await new Promise<void>(r => setTimeout(r, 2000));
      const rr = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: cd.taskId }),
      });
      const rd = await rr.json() as any;
      if (rd.status === "ready") { jar.cf_clearance = rd.solution?.cookies?.cf_clearance ?? rd.solution?.token ?? ""; break; }
      if (rd.status === "failed") { log(`❌ ${rd.errorCode}`); process.exit(1); }
    }
    if (!jar.cf_clearance) { log("❌ timeout CF"); process.exit(1); }
    log(`✅ cf_clearance OK (${((Date.now() - cfT0) / 1000).toFixed(1)}s)`);
  } else {
    log(`Pas de challenge CF (HTTP ${r1.status})`);
  }

  // ═══ ÉTAPE 2 : GET token + POST → PHPSESSID ═══════════════════════════════
  section("2 — GET token + POST → PHPSESSID");
  const initT0 = Date.now();
  const rGet = await (impit.fetch(SAOPOLO_URL, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", Cookie: buildCookieStr(jar) },
  } as any) as unknown as Promise<Response>);
  const bodyGet = await rGet.text();
  Object.assign(jar, extractSetCookies(rGet.headers));
  const token = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1];
  if (!token) { log(`❌ Token absent (HTTP ${rGet.status}, ${bodyGet.length}B)`); process.exit(1); }

  const rPost = await (impit.fetch(SAOPOLO_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
      Cookie: buildCookieStr(jar), Referer: SAOPOLO_URL, Origin: "https://www.citaconsular.es",
    },
    body: `token=${encodeURIComponent(token)}`,
  } as any) as unknown as Promise<Response>);
  await rPost.text();
  Object.assign(jar, extractSetCookies(rPost.headers));
  const initDuration = Date.now() - initT0;

  if (!jar.PHPSESSID) { log("❌ PHPSESSID absent"); process.exit(1); }
  log(`✅ PHPSESSID=${jar.PHPSESSID.slice(0, 10)}… (${(initDuration / 1000).toFixed(1)}s)`);

  // ═══ ÉTAPE 2b : GET /main/ (obligatoire pour init PHP) ═════════════════════
  section("2b — GET /main/ (init session PHP)");
  const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let reqCounter = Date.now();

  const bookititHeaders: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
    "Sec-Ch-Ua": '"Not;A=Brand";v="8", "Chromium";v="151"',
    "Sec-Ch-Ua-Platform": '"Windows"', "Sec-Ch-Ua-Mobile": "?0",
    Referer: SAOPOLO_URL,
    Cookie: buildCookieStr(jar),
  };

  reqCounter++;
  const mainQs = new URLSearchParams({
    callback: jqCallback, type: "default", publickey: PUBLICKEY,
    lang: "es", version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
    _: String(reqCounter),
  });
  const mainUrl = `${BOOKITIT_BASE}/main/?${mainQs}`;

  const mainT0 = Date.now();
  const rMain = await (impit.fetch(mainUrl, { headers: bookititHeaders } as any) as unknown as Promise<Response>);
  const bodyMain = await rMain.text();
  Object.assign(jar, extractSetCookies(rMain.headers));
  const mainDuration = Date.now() - mainT0;

  if (bodyMain.length < 100) {
    log(`❌ /main/ → ${bodyMain.length}B (trop court) — IP bloquée?`);
    process.exit(1);
  }
  log(`✅ /main/ → ${bodyMain.length}B (${(mainDuration / 1000).toFixed(2)}s)`);
  log(`⚠️  PAS de getwidgetconfigurations/, PAS de getservices/ → directement getagendas/`);

  // Mettre à jour les cookies dans les headers Bookitit
  bookititHeaders.Cookie = buildCookieStr(jar);

  // ═══ ÉTAPE 3 : getagendas/ × 6 (après /main/, skip cfg+svc) ════════════════
  section(`3 — getagendas/ × ${LOOP_COUNT} (après /main/, skip cfg+svc)`);

  const agResults: Array<{ loop: number; bytes: number; agendaId: string; durationMs: number; ok: boolean }> = [];

  for (let i = 1; i <= LOOP_COUNT; i++) {
    if (i > 1) await new Promise<void>(r => setTimeout(r, 1500)); // délai anti-pattern

    reqCounter++;
    const qs = new URLSearchParams({
      callback: jqCallback, type: "default", publickey: PUBLICKEY,
      lang: "es", "services[]": KNOWN_SERVICE_ID, selectedPeople: "1",
      version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
      _: String(reqCounter),
    });
    const url = `${BOOKITIT_BASE}/getagendas/?${qs}`;

    const t0 = Date.now();
    const r = await (impit.fetch(url, { headers: bookititHeaders } as any) as unknown as Promise<Response>);
    const body = await r.text();
    const duration = Date.now() - t0;

    // Parse JSONP
    let agendaId = "";
    let parsed = false;
    try {
      const json = body.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
      const data = JSON.parse(json);
      const agendas = data?.Agendas ?? data?.agendas ?? [];
      agendaId = agendas.find((a: any) => a?.id)?.id ?? "";
      parsed = true;
    } catch { /* parse error */ }

    const ok = body.length > 10 && parsed;
    agResults.push({ loop: i, bytes: body.length, agendaId, durationMs: duration, ok });

    const status = !ok ? "❌ 0B/erreur" : agendaId ? `✅ agenda=${agendaId}` : "⚠️ vide (pas de créneaux?)";
    log(`  Loop ${i}/${LOOP_COUNT}: ${status} | ${body.length}B | ${(duration / 1000).toFixed(2)}s`);
  }

  // ═══ ÉTAPE 4 : Si agenda OK, tester datetime/ × 3 aussi ═══════════════════
  const lastAgenda = agResults[agResults.length - 1];
  let dtResults: Array<{ loop: number; bytes: number; slots: number; durationMs: number }> = [];

  if (lastAgenda?.agendaId) {
    section(`4 — datetime/ × 3 (avec agenda=${lastAgenda.agendaId}, même session)`);

    const now = new Date();
    for (let i = 1; i <= 3; i++) {
      if (i > 1) await new Promise<void>(r => setTimeout(r, 1500));

      const d = new Date(now.getFullYear(), now.getMonth() + (i - 1), 1);
      const startDay = i === 1 ? String(now.getDate()).padStart(2, "0") : "01";
      const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${startDay}`;
      const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDayOfMonth).padStart(2, "0")}`;

      reqCounter++;
      const qs = new URLSearchParams({
        callback: jqCallback, type: "default", publickey: PUBLICKEY,
        lang: "es", "services[]": KNOWN_SERVICE_ID, "agendas[]": lastAgenda.agendaId,
        version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
        start, end, selectedPeople: "1",
        _: String(reqCounter),
      });
      const url = `${BOOKITIT_BASE}/datetime/?${qs}`;

      const t0 = Date.now();
      const r = await (impit.fetch(url, { headers: bookititHeaders } as any) as unknown as Promise<Response>);
      const body = await r.text();
      const duration = Date.now() - t0;

      let slots = 0;
      try {
        const json = body.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
        const data = JSON.parse(json);
        const slotsArr = data?.Slots ?? [];
        for (const day of slotsArr) {
          if (day.state !== 1) continue;
          const times = day.times ?? {};
          for (const info of Object.values(times) as any[]) {
            if ((info?.freeSlots ?? 0) > 0) slots++;
          }
        }
      } catch { /* parse error */ }

      dtResults.push({ loop: i, bytes: body.length, slots, durationMs: duration });
      log(`  datetime/ M+${i - 1}: ${body.length}B | ${slots} slots | ${(duration / 1000).toFixed(2)}s`);
    }
  }

  // ═══ RÉSUMÉ ════════════════════════════════════════════════════════════════
  section("RÉSUMÉ");

  const okCount = agResults.filter(r => r.ok).length;
  const avgAgMs = agResults.reduce((s, r) => s + r.durationMs, 0) / agResults.length;
  const avgDtMs = dtResults.length > 0 ? dtResults.reduce((s, r) => s + r.durationMs, 0) / dtResults.length : 0;

  console.log(`\n  getagendas/ direct (sans /main/ ni cfg ni svc):`);
  console.log(`    Succès     : ${okCount}/${LOOP_COUNT}`);
  console.log(`    Moy/appel  : ${(avgAgMs / 1000).toFixed(2)}s`);
  console.log(`    AgendaId   : ${agResults.filter(r => r.agendaId).length}/${LOOP_COUNT} retournent un agendaId`);

  if (dtResults.length > 0) {
    console.log(`\n  datetime/ (après getagendas/ direct):`);
    console.log(`    Moy/appel  : ${(avgDtMs / 1000).toFixed(2)}s`);
    console.log(`    Total slots: ${dtResults.reduce((s, r) => s + r.slots, 0)}`);
  }

  // Comparaison avec le cycle complet
  const cycleMinimal = avgAgMs + (avgDtMs * 3); // 1 agenda + 3 datetime (3 mois)
  const cycleComplet = 8630; // mesuré précédemment

  console.log(`\n  ┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`  │  Cycle complet (refreshSessionAndScan)  : ~8.63s              │`);
  console.log(`  │  Cycle minimal (agenda + 3×datetime)    : ~${(cycleMinimal / 1000).toFixed(2)}s              │`);
  console.log(`  │  Gain                                   : ~${((cycleComplet - cycleMinimal) / 1000).toFixed(1)}s/cycle (${(cycleComplet / cycleMinimal).toFixed(1)}×)  │`);
  console.log(`  └─────────────────────────────────────────────────────────────────┘`);

  if (okCount === LOOP_COUNT) {
    log(`\n✅ HYPOTHÈSE CONFIRMÉE : getagendas/ fonctionne après /main/ SANS cfg ni svc`);
    log(`   Le cycle minimal = POST token → /main/ → getagendas/ → datetime/ × N`);
    log(`   On skip getwidgetconfigurations/ + getservices/ = 2 requêtes économisées`);
  } else if (okCount > 0) {
    log(`\n⚠️  Résultats mitigés : ${okCount}/${LOOP_COUNT} OK — getagendas/ instable sans cfg/svc`);
  } else {
    log(`\n❌ getagendas/ ne fonctionne PAS sans cfg+svc — retour 0B`);
    log(`   getwidgetconfigurations/ et/ou getservices/ sont requis avant getagendas/`);
  }

  process.exit(0);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
