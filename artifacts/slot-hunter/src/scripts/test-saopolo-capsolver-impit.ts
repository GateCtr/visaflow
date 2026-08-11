/**
 * test-saopolo-capsolver-impit.ts — Capsolver + Impit avec retry POST+/main/
 *
 * Si /main/ retourne 0B, on re-GET portail (token frais) + re-POST + retry.
 * C'est le même comportement que le vrai navigateur ("retour + renvoyer le form").
 */

import "dotenv/config";
import { Impit } from "impit";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const ISP_PROXY_URL = process.env.SPAIN_ISP_PROXY_URL ?? "";
const STICKY_PROXY = ISP_PROXY_URL;

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

async function main(): Promise<void> {
  section("SAOPOLO — Capsolver + Impit (retry POST+/main/)");

  if (!CAPSOLVER_API_KEY || !ISP_PROXY_URL) {
    log("ERR", `Manque: ${!CAPSOLVER_API_KEY ? "CAPSOLVER_API_KEY " : ""}${!ISP_PROXY_URL ? "SPAIN_ISP_PROXY_URL" : ""}`);
    process.exit(1);
  }

  log("INFO", `Proxy: ${STICKY_PROXY.replace(/:([^@:]+)@/, ":***@").slice(0, 60)}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: STICKY_PROXY } as any);
  const jar: Record<string, string> = {};

  // ═══ ÉTAPE 1 : GET challenge CF ═══════════════════════════════════════════
  section("1 — GET challenge CF");
  const r1 = await impit.fetch(SAOPOLO_URL, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9" },
  } as any) as unknown as Response;
  const body1 = await r1.text();
  Object.assign(jar, extractSetCookies(r1.headers));
  log("INFO", `HTTP ${r1.status} | ${body1.length}B`);

  // ═══ ÉTAPE 2 : Capsolver ══════════════════════════════════════════════════
  if (r1.status === 403 || body1.includes("Just a moment")) {
    section("2 — Capsolver AntiCloudflareTask");
    const proxyFmt = (() => { const u = new URL(STICKY_PROXY); return `${u.hostname}:${u.port||"80"}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`; })();
    log("STEP", "createTask…");
    const cr = await fetch("https://api.capsolver.com/createTask", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, task: { type: "AntiCloudflareTask", websiteURL: SAOPOLO_URL, userAgent: UA, html: body1, proxy: proxyFmt } }),
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
      if (rd.status === "ready") { jar.cf_clearance = rd.solution?.cookies?.cf_clearance ?? rd.solution?.token ?? ""; break; }
      if (rd.status === "failed") { log("ERR", `${rd.errorCode}`); process.exit(1); }
      if (i % 5 === 0) log("INFO", `polling… (${i*2}s)`);
    }
    if (!jar.cf_clearance) { log("ERR", "timeout"); process.exit(1); }
    log("OK", `cf_clearance: ${jar.cf_clearance.slice(0, 25)}…`);
  }

  // ═══ ÉTAPE 3+4 : GET token + POST + /main/ (avec retry) ══════════════════
  section("3+4 — POST + /main/ (retry si 0B)");

  let body4 = "";
  const MAX = 3;

  for (let attempt = 1; attempt <= MAX; attempt++) {
    log("STEP", `── Tentative ${attempt}/${MAX} ──`);

    // GET portail → token frais
    const rGet = await impit.fetch(SAOPOLO_URL, {
      headers: { "User-Agent": UA, "Accept": "text/html,*/*;q=0.8", "Cookie": buildCookieString(jar) },
    } as any) as unknown as Response;
    const bodyGet = await rGet.text();
    Object.assign(jar, extractSetCookies(rGet.headers));
    const tkn = bodyGet.match(/name="token"\s+value="([^"]+)"/i)?.[1];
    if (!tkn) { log("WARN", `Token absent (HTTP ${rGet.status}, ${bodyGet.length}B)`); continue; }
    log("INFO", `GET → ${bodyGet.length}B | token=${tkn.slice(0, 20)}… | PHPSESSID=${jar.PHPSESSID?.slice(0, 10) ?? "?"}…`);

    // POST token
    const rPost = await impit.fetch(SAOPOLO_URL, {
      method: "POST",
      headers: {
        "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": buildCookieString(jar), "Referer": SAOPOLO_URL, "Origin": "https://www.citaconsular.es",
      },
      body: `token=${encodeURIComponent(tkn)}`,
    } as any) as unknown as Response;
    const bodyPost = await rPost.text();
    Object.assign(jar, extractSetCookies(rPost.headers));
    log("INFO", `POST → ${rPost.status} | ${bodyPost.length}B`);

    // GET /main/ immédiatement
    const cb = `jQuery${Math.random().toString().slice(2, 18)}_${Date.now()}`;
    const qs = new URLSearchParams({ callback: cb, type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es", version: "4", src: SAOPOLO_URL, _: String(Date.now()) });
    const mainUrl = `${BOOKITIT_BASE}/main/?${qs}`;

    const rMain = await impit.fetch(mainUrl, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/javascript, application/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
        "Sec-Ch-Ua": '"Not;A=Brand";v="8", "Chromium";v="151"',
        "Sec-Ch-Ua-Platform": '"Windows"', "Sec-Ch-Ua-Mobile": "?0",
        "Referer": SAOPOLO_URL,
        "Cookie": buildCookieString(jar),
      },
    } as any) as unknown as Response;
    body4 = await rMain.text();
    log("INFO", `/main/ → ${rMain.status} | ${body4.length}B | ct=${rMain.headers.get("content-type") ?? "?"}`);

    if (body4.length > 100) { log("OK", `🎉 /main/ a répondu ! (${body4.length}B)`); break; }
    if (attempt < MAX) { log("WARN", "0B — retry dans 2s…"); await new Promise<void>((r) => setTimeout(r, 2000)); }
  }

  // ═══ RÉSULTAT /main/ — sauvegarder pour analyse ════════════════════════════
  section("RÉSULTAT /main/");
  if (body4.length > 1000) {
    log("OK", `🎉 /main/ → ${body4.length}B`);
    // Sauvegarder le contenu pour analyse
    const fs = await import("node:fs");
    fs.writeFileSync("saopolo-main-response.html", body4);
    log("INFO", "Contenu sauvé → saopolo-main-response.html");
  } else {
    log("ERR", `/main/ → ${body4.length}B — arrêt`);
    process.exit(1);
  }

  // Helper pour les appels JSONP Bookitit
  const bookititHeaders = {
    "User-Agent": UA,
    "Accept": "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty",
    "Sec-Ch-Ua": '"Not;A=Brand";v="8", "Chromium";v="151"',
    "Sec-Ch-Ua-Platform": '"Windows"', "Sec-Ch-Ua-Mobile": "?0",
    "Referer": SAOPOLO_URL,
    "Cookie": buildCookieString(jar),
  };

  // Un seul callback jQuery pour toute la session (comme le vrai widget)
  const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
  let reqCounter = Date.now();

  function makeJsonpUrl(endpoint: string, extraParams?: Record<string, string>): string {
    reqCounter++;
    const qs = new URLSearchParams({ callback: jqCallback, type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34", lang: "es", version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es", ...extraParams, _: String(reqCounter) });
    return `${BOOKITIT_BASE}/${endpoint}?${qs}`;
  }

  // ═══ GET /getwidgetconfigurations/ (initialise l'état serveur) ═════════════
  section("GET /getwidgetconfigurations/ (init state)");
  const rCfg = await impit.fetch(makeJsonpUrl("getwidgetconfigurations/"), { headers: bookititHeaders } as any) as unknown as Response;
  const bodyCfg = await rCfg.text();
  log("INFO", `/getwidgetconfigurations/ → ${rCfg.status} | ${bodyCfg.length}B`);
  if (bodyCfg.length > 50) log("INFO", `Aperçu: ${bodyCfg.slice(0, 150)}`);

  // ═══ GET /getservices/ ═════════════════════════════════════════════════════
  section("GET /getservices/ (liste des services)");
  const rSvc = await impit.fetch(makeJsonpUrl("getservices/"), { headers: bookititHeaders } as any) as unknown as Response;
  const bodySvc = await rSvc.text();
  log("INFO", `/getservices/ → ${rSvc.status} | ${bodySvc.length}B`);

  // Parse JSONP
  const svcJson = bodySvc.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
  try {
    const svcData = JSON.parse(svcJson);
    const services = svcData.services ?? svcData.Services ?? [];
    log("OK", `${services.length} service(s) trouvé(s)`);
    for (const s of services.slice(0, 5)) {
      log("INFO", `  • ${s.id ?? s.Id} : ${(s.name ?? s.Name ?? "?").slice(0, 50)}`);
    }
  } catch {
    log("WARN", `Parse error — aperçu: ${bodySvc.slice(0, 200)}`);
  }

  // ═══ GET /getagendas/ ═════════════════════════════════════════════════════
  section("GET /getagendas/ (agendas pour Pasaportes bkt853215)");
  const rAg = await impit.fetch(makeJsonpUrl("getagendas/", { "services[]": "bkt853215" }), { headers: bookititHeaders } as any) as unknown as Response;
  const bodyAg = await rAg.text();
  log("INFO", `/getagendas/ → ${rAg.status} | ${bodyAg.length}B`);
  log("INFO", `getagendas/ raw: ${bodyAg}`);

  const agJson = bodyAg.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
  try {
    const agData = JSON.parse(agJson);
    const agendas = agData.agendas ?? agData.Agendas ?? [];
    log("OK", `${agendas.length} agenda(s)`);
    for (const a of agendas.slice(0, 5)) {
      log("INFO", `  • ${a.idAgenda ?? a.id} : ${(a.agendaName ?? a.name ?? "?").slice(0, 40)}`);
    }
  } catch {
    log("WARN", `Parse error — aperçu: ${bodyAg.slice(0, 200)}`);
  }

  // ═══ GET /datetime/ (créneaux du mois en cours + suivant) ══════════════════
  section("GET /datetime/ (créneaux Pasaportes)");
  const now = new Date();
  // Mois en cours
  const startCurrent = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endCurrent = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;
  const dtParams = new URLSearchParams({
    callback: jqCallback,
    type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34",
    lang: "es", "services[]": "bkt853215", "agendas[]": "bkt301070",
    version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
    start: startCurrent, end: endCurrent, selectedPeople: "1",
    _: String(++reqCounter),
  });
  const rDt = await impit.fetch(`${BOOKITIT_BASE}/datetime/?${dtParams}`, { headers: bookititHeaders } as any) as unknown as Response;
  const bodyDt = await rDt.text();
  log("INFO", `/datetime/ → ${rDt.status} | ${bodyDt.length}B`);
  log("INFO", `datetime/ raw: ${bodyDt.slice(0, 300)}`);

  // Appel mois suivant (septembre)
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const startNext = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;
  const endNext = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-${new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate()}`;
  const dtParams2 = new URLSearchParams({
    callback: jqCallback,
    type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34",
    lang: "es", "services[]": "bkt853215", "agendas[]": "bkt301070",
    version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
    start: startNext, end: endNext, selectedPeople: "1",
    _: String(++reqCounter),
  });
  const rDt2 = await impit.fetch(`${BOOKITIT_BASE}/datetime/?${dtParams2}`, { headers: bookititHeaders } as any) as unknown as Response;
  const bodyDt2 = await rDt2.text();
  log("INFO", `/datetime/ M+1 → ${rDt2.status} | ${bodyDt2.length}B`);
  if (bodyDt2.length > 200) log("INFO", `datetime/ M+1 aperçu: ${bodyDt2.slice(0, 300)}`);

  const dtJson = bodyDt.replace(/^[^(]+\(/, "").replace(/\);?\s*$/, "");
  try {
    const dtData = JSON.parse(dtJson);
    const slots = dtData.Slots ?? dtData.slots ?? [];
    log("OK", `${slots.length} jour(s) avec données`);
    let totalFree = 0;
    for (const day of slots.slice(0, 10)) {
      const times = day.times ?? {};
      for (const [time, info] of Object.entries(times) as [string, any][]) {
        const free = Number(info.freeSlots ?? 0);
        if (free > 0) {
          totalFree += free;
          log("INFO", `  📅 ${day.date} ${time} — ${free} créneau(x) libre(s) (agenda: ${day.agenda ?? "?"})`);
        }
      }
    }
    if (totalFree === 0) log("INFO", "  Aucun créneau libre ce mois-ci (\"No hay horas\")");
    else log("OK", `🎉 ${totalFree} créneau(x) libre(s) détecté(s) !`);
  } catch {
    log("WARN", `Parse error — aperçu: ${bodyDt.slice(0, 200)}`);
  }

  section("FIN — Flow HTTP complet réussi !");

  // ═══ ÉTAPE BONUS : Test signin (faux identifiants) ════════════════════════
  section("BONUS — Test signin (faux ID → erreur attendue)");

  // Prendre un créneau du mois suivant pour le test
  const testDate = "2026-09-16";
  const testTime = "09:10";

  // D'abord getsigninfields/ (requis avant signin/)
  const rFields = await impit.fetch(makeJsonpUrl("getsigninfields/", { "services[]": "bkt853215" }), { headers: bookititHeaders } as any) as unknown as Response;
  const bodyFields = await rFields.text();
  log("INFO", `/getsigninfields/ → ${rFields.status} | ${bodyFields.length}B`);

  // Ensuite signin/ avec les faux identifiants
  const signinParams = new URLSearchParams({
    callback: jqCallback,
    type: "default", publickey: "2d01502f12dc08400e22aea87fb00ae34",
    lang: "es", "services[]": "bkt853215", "agendas[]": "bkt301070",
    version: "4", src: SAOPOLO_URL, srvsrc: "https://www.citaconsular.es",
    date: testDate, time: testTime, selectedPeople: "1",
    logintype: "document",
    login: "FAKE123456",
    password: "FAKEPASS123",
    comments: "",
    _: String(++reqCounter),
  });
  const rSignin = await impit.fetch(`${BOOKITIT_BASE}/signin/?${signinParams}`, { headers: bookititHeaders } as any) as unknown as Response;
  const bodySignin = await rSignin.text();
  log("INFO", `/signin/ → ${rSignin.status} | ${bodySignin.length}B`);
  log("INFO", `signin/ raw: ${bodySignin.slice(0, 300)}`);

  if (bodySignin.includes("incorrectos")) {
    log("OK", "🎉 Signin fonctionne ! Erreur 'Usuario o contraseña incorrectos' = attendu");
  } else if (bodySignin.length === 0) {
    log("ERR", "0B — même problème que les autres endpoints");
  } else {
    log("INFO", `Réponse inattendue — vérifier`);
  }

  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
