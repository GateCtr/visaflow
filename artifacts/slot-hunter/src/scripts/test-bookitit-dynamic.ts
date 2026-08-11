/**
 * test-bookitit-dynamic.ts — Flow HTTP dynamique pour tout portail Bookitit/citaconsular
 *
 * INPUT : juste l'URL du widget. Tout le reste est auto-découvert.
 * Aucun ID codé en dur.
 *
 * USAGE :
 *   npx tsx src/scripts/test-bookitit-dynamic.ts [URL_WIDGET]
 *   npx tsx src/scripts/test-bookitit-dynamic.ts https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/
 */

import "dotenv/config";
import { Impit } from "impit";

// ── Config ────────────────────────────────────────────────────────────────────
const WIDGET_URL = process.argv[2] || "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.env.SPAIN_ISP_PROXY_URL ?? "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// ── Helpers ───────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function buildCookieString(jar: Record<string, string>): string {
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
function parseJsonp(raw: string): unknown {
  const json = raw.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
  try { return JSON.parse(json); } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section("BOOKITIT DYNAMIC — Auto-découverte de portail");

  // Extraire la publickey depuis l'URL
  const pkMatch = WIDGET_URL.match(/widgetdefault\/([a-f0-9]+)/);
  if (!pkMatch) { log("ERR", `publickey non trouvée dans: ${WIDGET_URL}`); process.exit(1); }
  const publickey = pkMatch[1];
  const baseHost = new URL(WIDGET_URL).origin;
  const bookititBase = `${baseHost}/onlinebookings`;

  log("INFO", `Widget URL  : ${WIDGET_URL}`);
  log("INFO", `Public key  : ${publickey}`);
  log("INFO", `Host        : ${baseHost}`);
  log("INFO", `Proxy       : ${PROXY_URL ? PROXY_URL.replace(/:([^@:]+)@/, ":***@") : "(direct)"}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: PROXY_URL || undefined } as any);
  const jar: Record<string, string> = {};

  // ═══ 1. CF Solve ══════════════════════════════════════════════════════════
  section("1 — CF Solve (Capsolver)");
  const r1 = await impit.fetch(WIDGET_URL, { headers: { "User-Agent": UA } } as any) as unknown as Response;
  const body1 = await r1.text();
  Object.assign(jar, extractSetCookies(r1.headers));

  if (r1.status === 403 || body1.includes("Just a moment")) {
    log("INFO", `Challenge CF détecté (${r1.status}, ${body1.length}B)`);
    const proxyFmt = (() => { const u = new URL(PROXY_URL); return `${u.hostname}:${u.port||"80"}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`; })();
    const cr = await fetch("https://api.capsolver.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, task: { type: "AntiCloudflareTask", websiteURL: WIDGET_URL, userAgent: UA, html: body1, proxy: proxyFmt } }),
    });
    const cd = await cr.json() as any;
    if (cd.errorId) { log("ERR", `${cd.errorCode}: ${cd.errorDescription}`); process.exit(1); }
    log("INFO", `taskId: ${cd.taskId}`);
    for (let i = 0; i < 60; i++) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      const rr = await fetch("https://api.capsolver.com/getTaskResult", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: cd.taskId }),
      });
      const rd = await rr.json() as any;
      if (rd.status === "ready") { jar.cf_clearance = rd.solution?.cookies?.cf_clearance ?? ""; break; }
      if (rd.status === "failed") { log("ERR", `${rd.errorCode}`); process.exit(1); }
      if (i % 5 === 0) log("INFO", `polling… (${i*2}s)`);
    }
    if (!jar.cf_clearance) { log("ERR", "timeout"); process.exit(1); }
    log("OK", `cf_clearance: ${jar.cf_clearance.slice(0, 25)}…`);
  } else {
    log("OK", "Pas de challenge CF");
  }

  // Session jQuery (même callback pour toute la session)
  const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let reqCounter = Date.now();
  const headers = {
    "User-Agent": UA,
    "Accept": "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
    "Referer": WIDGET_URL,
    "Cookie": "", // sera rempli dynamiquement
  };
  function cookieHeader(): Record<string, string> { return { ...headers, Cookie: buildCookieString(jar) }; }
  function makeUrl(endpoint: string, extra?: Record<string, string>): string {
    reqCounter++;
    // Ordre important : callback → type → publickey → lang → [extra params] → version → src → srvsrc → [remaining extra] → _
    // Bookitit peut être strict sur l'ordre (Cuba bkt897578 retourne 0B sinon)
    const params: Array<[string, string]> = [
      ["callback", jqCallback],
      ["type", "default"],
      ["publickey", publickey],
      ["lang", "es"],
    ];
    // Injecter services[] et agendas[] ici (avant version, comme le widget natif)
    if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
    if (extra?.["agendas[]"]) params.push(["agendas[]", extra["agendas[]"]]);
    params.push(["version", version]);
    params.push(["src", WIDGET_URL]);
    params.push(["srvsrc", srvsrc]);
    // Autres params extra (selectedPeople, start, end, etc.)
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
      }
    }
    params.push(["_", String(reqCounter)]);
    const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return `${bookititBase}/${endpoint}?${qs}`;
  }

  // ═══ 2. GET widget + POST token ═══════════════════════════════════════════
  section("2 — Session init (GET widget + POST token + /main/)");
  const rGet = await impit.fetch(WIDGET_URL, { headers: { "User-Agent": UA, "Cookie": buildCookieString(jar) } } as any) as unknown as Response;
  const bodyGet = await rGet.text();
  Object.assign(jar, extractSetCookies(rGet.headers));
  const token = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1];
  if (!token) { log("ERR", `Token absent (${rGet.status}, ${bodyGet.length}B)`); process.exit(1); }
  log("INFO", `Token: ${token.slice(0, 20)}… | PHPSESSID: ${jar.PHPSESSID?.slice(0, 10) ?? "?"}…`);

  // POST token
  const rPost = await impit.fetch(WIDGET_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": buildCookieString(jar), "Referer": WIDGET_URL, "Origin": baseHost },
    body: `token=${encodeURIComponent(token)}`,
  } as any) as unknown as Response;
  const bodyPost = await rPost.text();
  Object.assign(jar, extractSetCookies(rPost.headers));

  // Extraire srvsrc et version dynamiquement depuis le POST response
  const srvsrcMatch = bodyPost.match(/srvsrc:\s*'([^']+)'/);
  const versionMatch = bodyPost.match(/loadermaec\.js\?v=(\d+)/);
  const srvsrc = srvsrcMatch?.[1] ?? baseHost;
  const version = versionMatch?.[1] ?? "4";
  log("INFO", `POST → ${rPost.status} | ${bodyPost.length}B | srvsrc=${srvsrc} | v=${version}`);

  // GET /main/
  const rMain = await impit.fetch(makeUrl("main/"), { headers: cookieHeader() } as any) as unknown as Response;
  const bodyMain = await rMain.text();
  if (bodyMain.length < 1000) { log("ERR", `/main/ → ${bodyMain.length}B`); process.exit(1); }
  log("OK", `/main/ → ${bodyMain.length}B`);

  // ═══ 3. Auto-découverte ════════════════════════════════════════════════════
  section("3 — Auto-découverte (getwidgetconfigurations + getservices + getagendas)");

  // getwidgetconfigurations
  const rCfg = await impit.fetch(makeUrl("getwidgetconfigurations/"), { headers: cookieHeader() } as any) as unknown as Response;
  const bodyCfg = await rCfg.text();
  const cfg = parseJsonp(bodyCfg) as any;
  log("INFO", `/getwidgetconfigurations/ → ${bodyCfg.length}B | registration_type=${cfg?.WidgetConfiguration?.registration_type ?? "?"}`);

  // getservices
  const rSvc = await impit.fetch(makeUrl("getservices/"), { headers: cookieHeader() } as any) as unknown as Response;
  const bodySvc = await rSvc.text();
  const svcData = parseJsonp(bodySvc) as any;
  const services: Array<{ id: string; name: string }> = svcData?.Services ?? [];
  log("OK", `${services.length} service(s) découvert(s) :`);
  for (const s of services) {
    log("INFO", `  • ${s.id} : ${(s.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 60)}`);
  }

  if (services.length === 0) { log("ERR", "Aucun service"); process.exit(1); }

  // Pour chaque service, découvrir les agendas
  // IMPORTANT : Bookitit n'autorise qu'UN getagendas/ par session.
  // On appelle uniquement pour le PREMIER service avec un nom non-vide.
  const allAgendas: Array<{ serviceId: string; serviceName: string; agendaId: string; agendaName: string }> = [];
  const targetService = services.find(s => (s.name ?? "").replace(/<[^>]*>/g, "").trim().length > 0) ?? services[0];
  if (targetService) {
    log("INFO", `  Service cible : ${targetService.id} (${(targetService.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 50)})`);
    const rAg = await impit.fetch(makeUrl("getagendas/", { "services[]": targetService.id, selectedPeople: "1" }), { headers: cookieHeader() } as any) as unknown as Response;
    const bodyAg = await rAg.text();
    log("INFO", `  getagendas/ ${targetService.id} → ${bodyAg.length}B : ${bodyAg.slice(0, 150)}`);
    const agData = parseJsonp(bodyAg) as any;
    const agendas = agData?.Agendas ?? [];
    for (const ag of agendas) {
      allAgendas.push({ serviceId: targetService.id, serviceName: targetService.name, agendaId: ag.id, agendaName: ag.name });
      log("INFO", `  → Agenda: ${ag.id} (${ag.name})`);
    }
  }
  log("OK", `${allAgendas.length} agenda(s) total`);

  // ═══ 4. Scan créneaux ═════════════════════════════════════════════════════
  section("4 — Scan créneaux (datetime/)");

  const now = new Date();
  let totalSlots = 0;

  for (const ag of allAgendas) {
    // Mois courant
    const startCur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
    const endCur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;
    const rDt = await impit.fetch(makeUrl("datetime/", { "services[]": ag.serviceId, "agendas[]": ag.agendaId, start: startCur, end: endCur, selectedPeople: "1" }), { headers: cookieHeader() } as any) as unknown as Response;
    const bodyDt = await rDt.text();
    const dtData = parseJsonp(bodyDt) as any;
    const maxDays = dtData?.maxDays ?? "";

    // Compter créneaux mois courant
    let slotsThisMonth = 0;
    for (const day of (dtData?.Slots ?? [])) {
      const times = day.times ?? {};
      if (typeof times === "object" && !Array.isArray(times)) {
        for (const [, info] of Object.entries(times) as [string, any][]) {
          slotsThisMonth += Number(info.freeSlots ?? 0);
        }
      }
    }

    // Mois suivant
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const startNext = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
    const endNext = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-${new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate()}`;
    const rDt2 = await impit.fetch(makeUrl("datetime/", { "services[]": ag.serviceId, "agendas[]": ag.agendaId, start: startNext, end: endNext, selectedPeople: "1" }), { headers: cookieHeader() } as any) as unknown as Response;
    const bodyDt2 = await rDt2.text();
    const dtData2 = parseJsonp(bodyDt2) as any;

    let slotsNextMonth = 0;
    for (const day of (dtData2?.Slots ?? [])) {
      const times = day.times ?? {};
      if (typeof times === "object" && !Array.isArray(times)) {
        for (const [time, info] of Object.entries(times) as [string, any][]) {
          const free = Number(info.freeSlots ?? 0);
          slotsNextMonth += free;
          if (free > 0 && totalSlots + slotsNextMonth <= 10) {
            log("INFO", `  📅 ${day.date} ${(info as any).time} — ${free} libre(s) [${ag.agendaName}]`);
          }
        }
      }
    }

    totalSlots += slotsThisMonth + slotsNextMonth;
    log("INFO", `  ${ag.agendaName} (${ag.serviceId}) : ${slotsThisMonth} ce mois + ${slotsNextMonth} mois suivant | maxDays=${maxDays}`);
  }

  // ═══ RÉSULTAT ═════════════════════════════════════════════════════════════
  section("RÉSULTAT");
  log("INFO", `Portail     : ${baseHost}`);
  log("INFO", `Public key  : ${publickey}`);
  log("INFO", `Services    : ${services.length}`);
  log("INFO", `Agendas     : ${allAgendas.length}`);
  log("INFO", `Total slots : ${totalSlots}`);

  if (totalSlots > 0) {
    log("OK", `🎉 ${totalSlots} CRÉNEAU(X) DISPONIBLE(S) !`);
  } else {
    log("INFO", "Aucun créneau disponible actuellement");
  }

  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
