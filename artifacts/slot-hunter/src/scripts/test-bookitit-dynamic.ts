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
const PROXY_URL = process.argv[3] || (process.env.SPAIN_ISP_PROXY_URL ?? "");
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

  // ═══ 4. Scan créneaux (datetime/) — TOUS les mois jusqu'à maxDays ════════
  section("4 — Scan créneaux (datetime/) — navigation dynamique jusqu'à maxDays");

  const now = new Date();
  let totalSlots = 0;
  // Tableau détaillé des créneaux trouvés
  const allFoundSlots: Array<{ date: string; time: string; freeSlots: number; totalSlots: number; agenda: string }> = [];

  for (const ag of allAgendas) {
    let globalMaxDays: Date | null = null;
    let monthOffset = 0;
    let agendaSlots = 0;
    const MAX_MONTHS = 12; // sécurité : max 12 mois de scan
    let consecutiveEmpty = 0; // compteur de mois vides consécutifs

    log("INFO", `  Agenda: ${ag.agendaName} (${ag.agendaId}) — service: ${ag.serviceId}`);

    while (monthOffset < MAX_MONTHS) {
      const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
      const startStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      const endStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const monthLabel = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

      const rDt = await impit.fetch(makeUrl("datetime/", {
        "services[]": ag.serviceId,
        "agendas[]": ag.agendaId,
        start: startStr,
        end: endStr,
        selectedPeople: "1",
      }), { headers: cookieHeader() } as any) as unknown as Response;
      const bodyDt = await rDt.text();
      const dtData = parseJsonp(bodyDt) as any;

      // Parser maxDays de CETTE réponse (chaque mois peut avoir un maxDays différent)
      const maxDaysRaw: string = dtData?.maxDays ?? "";
      if (maxDaysRaw && maxDaysRaw.match(/^\d{4}-\d{2}-\d{2}$/)) {
        const parsed = new Date(maxDaysRaw + "T23:59:59");
        if (!globalMaxDays || parsed > globalMaxDays) {
          globalMaxDays = parsed;
        }
      }

      // Compter créneaux ce mois
      let slotsThisMonth = 0;
      for (const day of (dtData?.Slots ?? [])) {
        const times = day.times ?? {};
        if (typeof times === "object" && !Array.isArray(times)) {
          for (const [timeKey, info] of Object.entries(times) as [string, any][]) {
            const free = Number(info.freeSlots ?? 0);
            const total = Number(info.totalSlots ?? 0);
            const timeStr: string = info.time ?? timeKey;
            if (free > 0) {
              slotsThisMonth += free;
              allFoundSlots.push({
                date: day.date,
                time: timeStr,
                freeSlots: free,
                totalSlots: total,
                agenda: ag.agendaName,
              });
            }
          }
        }
      }

      agendaSlots += slotsThisMonth;
      const slotsLabel = slotsThisMonth > 0 ? `${slotsThisMonth} créneau(x)` : "0";
      log("INFO", `    ${monthLabel} : ${slotsLabel} | maxDays=${maxDaysRaw || "(absent)"}`);

      monthOffset++;

      // Logique d'arrêt : on s'arrête si maxDays du serveur interdit le mois SUIVANT
      // MAIS on scanne TOUJOURS au minimum 2 mois (M + M+1) car maxDays du mois courant
      // peut être "aujourd'hui" alors que le serveur a des créneaux en M+1/M+2.
      // Le vrai maxDays "horizon" ne se révèle qu'en demandant les mois futurs.
      if (monthOffset >= 2 && globalMaxDays) {
        const firstOfNextMonth = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        if (firstOfNextMonth > globalMaxDays) {
          log("INFO", `    ⏹ Fin : mois suivant ${firstOfNextMonth.toISOString().slice(0, 10)} > maxDays ${globalMaxDays.toISOString().slice(0, 10)}`);
          break;
        }
      }

      // Sécurité : si 3 mois vides consécutifs sans maxDays → arrêter
      if (slotsThisMonth === 0) {
        consecutiveEmpty++;
      } else {
        consecutiveEmpty = 0;
      }
      if (!globalMaxDays && consecutiveEmpty >= 3) {
        log("WARN", `    ⏹ 3 mois vides consécutifs sans maxDays — arrêt par sécurité`);
        break;
      }
    }

    totalSlots += agendaSlots;
    log("INFO", `  → Total agenda: ${agendaSlots} créneau(x) sur ${monthOffset} mois scannés (maxDays=${globalMaxDays?.toISOString().slice(0, 10) ?? "?"})`);
  }

  // ═══ TABLEAU DÉTAILLÉ ═════════════════════════════════════════════════════
  if (allFoundSlots.length > 0) {
    section("TABLEAU DES CRÉNEAUX");
    // Grouper par date
    const byDate = new Map<string, typeof allFoundSlots>();
    for (const s of allFoundSlots) {
      if (!byDate.has(s.date)) byDate.set(s.date, []);
      byDate.get(s.date)!.push(s);
    }
    // Afficher le tableau
    console.log("");
    console.log(`  ${"Date".padEnd(12)} | ${"Heure".padEnd(7)} | ${"Libres".padEnd(7)} | ${"Total".padEnd(7)} | Agenda`);
    console.log(`  ${"-".repeat(12)}-+-${"-".repeat(7)}-+-${"-".repeat(7)}-+-${"-".repeat(7)}-+-${"-".repeat(30)}`);
    for (const [date, slots] of [...byDate.entries()].sort()) {
      // Trier par heure
      slots.sort((a, b) => a.time.localeCompare(b.time));
      for (const s of slots) {
        console.log(`  ${s.date.padEnd(12)} | ${s.time.padEnd(7)} | ${String(s.freeSlots).padEnd(7)} | ${String(s.totalSlots).padEnd(7)} | ${s.agenda.slice(0, 30)}`);
      }
    }
    console.log("");
    // Résumé par date
    console.log(`  RÉSUMÉ PAR DATE :`);
    for (const [date, slots] of [...byDate.entries()].sort()) {
      const totalFree = slots.reduce((sum, s) => sum + s.freeSlots, 0);
      const nSlots = slots.length;
      console.log(`    ${date} : ${totalFree} place(s) sur ${nSlots} créneau(x) horaire(s)`);
    }
    console.log("");
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
