/**
 * test-kinshasa-datetime-loop.ts — Teste datetime/ en boucle sur Kinshasa
 * avec agendaId=bkt391787 hardcodé (connu même quand getagendas/ retourne vide).
 *
 * HYPOTHÈSE : Même sans créneaux disponibles, datetime/ retourne un body positif
 * (JSONP avec Slots vides ou maxDays court) — PAS 0B. On peut donc boucler
 * indéfiniment sur datetime/ et détecter dès qu'un créneau apparaît.
 *
 * FLOW :
 *   1. Init CF (CapSolver) sur Kinshasa
 *   2. POST token → PHPSESSID
 *   3. GET /main/ (init PHP)
 *   4. getwidgetconfigurations/ + getservices/ (obligatoires)
 *   5. datetime/ × 6 avec agendaId=bkt391787 hardcodé (PAS de getagendas/)
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-kinshasa-datetime-loop.ts
 */

import "dotenv/config";
import { Impit } from "impit";

// ─── Constantes Kinshasa ──────────────────────────────────────────────────────
const KINSHASA_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";
const PUBLICKEY = "25028fcd7126544630b8da0c6e60722b5";
const KNOWN_SERVICE_ID = "bkt1181774"; // Tramitación de visas
const KNOWN_AGENDA_ID = "bkt391787";   // Connu même quand getagendas/ retourne vide

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const DATETIME_LOOPS = 6;

// ─── Proxy ────────────────────────────────────────────────────────────────────
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
  section("TEST KINSHASA : datetime/ × 6 avec agendaId hardcodé");

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

  log(`Portail  : Kinshasa (${PUBLICKEY.slice(0, 12)}…)`);
  log(`Proxy    : ${stickyProxy.replace(/:([^:@]+)@/, ":***@").slice(0, 60)}`);
  log(`Service  : ${KNOWN_SERVICE_ID} (hardcodé)`);
  log(`Agenda   : ${KNOWN_AGENDA_ID} (hardcodé — connu même si getagendas/ vide)`);
  log(`Loops    : ${DATETIME_LOOPS}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: stickyProxy } as any);
  const jar: Record<string, string> = {};
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

  // ═══ ÉTAPE 1 : CF solve ═══════════════════════════════════════════════════
  section("1 — CF solve (CapSolver)");
  const cfT0 = Date.now();
  const r1 = await (impit.fetch(KINSHASA_URL, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", "Accept-Language": "es-ES,es;q=0.9" },
  } as any) as unknown as Promise<Response>);
  const body1 = await r1.text();
  Object.assign(jar, extractSetCookies(r1.headers));

  if (r1.status === 403 || body1.includes("Just a moment")) {
    const proxyFmt = (() => { const u = new URL(stickyProxy); return `${u.hostname}:${u.port || "80"}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`; })();
    const cr = await fetch("https://api.capsolver.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, task: { type: "AntiCloudflareTask", websiteURL: KINSHASA_URL, userAgent: UA, html: body1, proxy: proxyFmt } }),
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
    log(`Pas de challenge CF (HTTP ${r1.status}) — ${body1.length}B`);
  }

  // ═══ ÉTAPE 2 : GET token + POST → PHPSESSID ═══════════════════════════════
  section("2 — GET token + POST → PHPSESSID");
  const rGet = await (impit.fetch(KINSHASA_URL, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*;q=0.8", Cookie: buildCookieStr(jar) },
  } as any) as unknown as Promise<Response>);
  const bodyGet = await rGet.text();
  Object.assign(jar, extractSetCookies(rGet.headers));
  const token = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1];
  if (!token) { log(`❌ Token absent (HTTP ${rGet.status}, ${bodyGet.length}B)`); process.exit(1); }

  const rPost = await (impit.fetch(KINSHASA_URL, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
      Cookie: buildCookieStr(jar), Referer: KINSHASA_URL, Origin: "https://www.citaconsular.es",
    },
    body: `token=${encodeURIComponent(token)}`,
  } as any) as unknown as Promise<Response>);
  await rPost.text();
  Object.assign(jar, extractSetCookies(rPost.headers));
  if (!jar.PHPSESSID) { log("❌ PHPSESSID absent"); process.exit(1); }
  log(`✅ PHPSESSID=${jar.PHPSESSID.slice(0, 10)}…`);

  // ═══ ÉTAPE 3 : /main/ + getwidgetconfigurations/ + getservices/ ════════════
  section("3 — /main/ + cfg + svc (init obligatoire)");
  const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let reqCounter = Date.now();

  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
    Referer: KINSHASA_URL,
    Cookie: buildCookieStr(jar),
  };

  function makeUrl(endpoint: string, extra?: Record<string, string>): string {
    reqCounter++;
    const qs = new URLSearchParams({
      callback: jqCallback, type: "default", publickey: PUBLICKEY,
      lang: "es", version: "4", src: KINSHASA_URL, srvsrc: "https://www.citaconsular.es",
      ...extra, _: String(reqCounter),
    });
    return `${BOOKITIT_BASE}/${endpoint}?${qs}`;
  }

  // /main/
  const rMain = await (impit.fetch(makeUrl("main/"), { headers } as any) as unknown as Promise<Response>);
  const bodyMain = await rMain.text();
  Object.assign(jar, extractSetCookies(rMain.headers));
  headers.Cookie = buildCookieStr(jar);
  log(`/main/ → ${bodyMain.length}B ${bodyMain.length > 1000 ? "✅" : "❌"}`);
  if (bodyMain.length < 100) { log("❌ /main/ 0B — proxy bloqué"); process.exit(1); }

  // getwidgetconfigurations/
  const rCfg = await (impit.fetch(makeUrl("getwidgetconfigurations/"), { headers } as any) as unknown as Promise<Response>);
  const bodyCfg = await rCfg.text();
  log(`cfg/ → ${bodyCfg.length}B`);

  // getservices/
  const rSvc = await (impit.fetch(makeUrl("getservices/"), { headers } as any) as unknown as Promise<Response>);
  const bodySvc = await rSvc.text();
  log(`svc/ → ${bodySvc.length}B`);

  // getagendas/ — appel NORMAL comme en prod (juste services[], PAS de agendas[])
  log(`\n📌 getagendas/ normal (services[]=${KNOWN_SERVICE_ID}, selectedPeople=1) — comme en prod`);
  const rAg = await (impit.fetch(makeUrl("getagendas/", {
    "services[]": KNOWN_SERVICE_ID,
    selectedPeople: "1",
  }), { headers } as any) as unknown as Promise<Response>);
  const bodyAg = await rAg.text();
  log(`getagendas/ → ${bodyAg.length}B`);
  if (bodyAg.length > 10) {
    log(`   aperçu: ${bodyAg.slice(0, 200)}`);
    // Parser pour voir si l'agenda est retourné
    try {
      const json = bodyAg.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
      const data = JSON.parse(json);
      const agendas = data?.Agendas ?? data?.agendas ?? [];
      log(`   Agendas retournés: ${agendas.length} → ${JSON.stringify(agendas.map((a: any) => a.id))}`);
    } catch { log(`   (parse error)`); }
  } else {
    log(`   ⚠️ 0B — pas de créneaux, agenda non retourné (attendu pour Kinshasa)`);
  }

  log(`\n→ getagendas/ fait (même si 0B). Maintenant datetime/ avec agenda=${KNOWN_AGENDA_ID} hardcodé`);
  log(`   HYPOTHÈSE : le serveur a "touché" la phase getagendas/ dans la session,`);
  log(`   peut-être que datetime/ fonctionnera avec l'agendaId forcé.`);

  // ═══ ÉTAPE 4 : datetime/ × 6 avec agenda hardcodé ═════════════════════════
  section(`4 — datetime/ × ${DATETIME_LOOPS} (agenda=${KNOWN_AGENDA_ID} hardcodé)`);

  const dtResults: Array<{ loop: number; bytes: number; slots: number; durationMs: number; body0B: boolean }> = [];
  const now = new Date();

  for (let i = 1; i <= DATETIME_LOOPS; i++) {
    if (i > 1) await new Promise<void>(r => setTimeout(r, 1500));

    // Scanner le mois en cours (ou alterner les mois pour varier)
    const monthOffset = (i - 1) % 3; // 0, 1, 2, 0, 1, 2
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const startDay = monthOffset === 0 ? String(now.getDate()).padStart(2, "0") : "01";
    const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${startDay}`;
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const end = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const url = makeUrl("datetime/", {
      "services[]": KNOWN_SERVICE_ID,
      "agendas[]": KNOWN_AGENDA_ID,
      start, end, selectedPeople: "1",
    });

    const t0 = Date.now();
    const r = await (impit.fetch(url, { headers } as any) as unknown as Promise<Response>);
    const body = await r.text();
    const duration = Date.now() - t0;

    const is0B = body.length === 0;
    let slots = 0;
    let maxDays = "";

    if (!is0B) {
      try {
        const json = body.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
        const data = JSON.parse(json);
        maxDays = data?.maxDays ?? "";
        const slotsArr = data?.Slots ?? [];
        for (const day of slotsArr) {
          if (day.state !== 1) continue;
          const times = day.times ?? {};
          for (const info of Object.values(times) as any[]) {
            if ((info?.freeSlots ?? 0) > 0) slots++;
          }
        }
      } catch { /* parse error is fine */ }
    }

    dtResults.push({ loop: i, bytes: body.length, slots, durationMs: duration, body0B: is0B });

    const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const status = is0B ? "❌ 0B" : slots > 0 ? `✅ ${slots} slot(s)` : `✅ body OK (0 slots)`;
    log(`  Loop ${i}/${DATETIME_LOOPS} [${monthLabel}]: ${status} | ${body.length}B | maxDays=${maxDays || "?"} | ${(duration / 1000).toFixed(2)}s`);
  }

  // ═══ RÉSUMÉ ════════════════════════════════════════════════════════════════
  section("RÉSUMÉ");

  const positiveCount = dtResults.filter(r => !r.body0B).length;
  const zeroCount = dtResults.filter(r => r.body0B).length;
  const avgMs = dtResults.reduce((s, r) => s + r.durationMs, 0) / dtResults.length;

  console.log(`\n  datetime/ avec agenda hardcodé (${KNOWN_AGENDA_ID}):`);
  console.log(`    Body positif : ${positiveCount}/${DATETIME_LOOPS} (= session PHP vivante)`);
  console.log(`    Body 0B      : ${zeroCount}/${DATETIME_LOOPS} (= session morte ou agenda invalide)`);
  console.log(`    Moy/appel    : ${(avgMs / 1000).toFixed(2)}s`);
  console.log(`    Total slots  : ${dtResults.reduce((s, r) => s + r.slots, 0)}`);

  if (positiveCount === DATETIME_LOOPS) {
    console.log(`\n  ✅ HYPOTHÈSE CONFIRMÉE :`);
    console.log(`     datetime/ répond avec un body positif même sans créneaux`);
    console.log(`     → On peut boucler indéfiniment avec l'agendaId hardcodé`);
    console.log(`     → Pas besoin d'appeler getagendas/ dans la boucle`);
    console.log(`     → Cycle = ~${(avgMs / 1000).toFixed(1)}s × (nombre de mois scannés)`);
  } else if (positiveCount > 0) {
    console.log(`\n  ⚠️  Résultats mitigés — certains appels retournent 0B`);
    console.log(`     L'agendaId hardcodé fonctionne parfois mais pas toujours`);
  } else {
    console.log(`\n  ❌ datetime/ retourne 0B — l'agendaId hardcodé ne fonctionne PAS`);
    console.log(`     sans getagendas/ dans l'init (le serveur ne l'associe pas à la session)`);
  }

  process.exit(0);
}

main().catch(e => { console.error("[FATAL]", e); process.exit(1); });
