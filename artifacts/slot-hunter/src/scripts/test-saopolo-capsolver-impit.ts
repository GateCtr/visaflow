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

  log("INFO", `Proxy: ${ISP_PROXY_URL.replace(/:([^@:]+)@/, ":***@")}`);

  const impit = new Impit({ browser: "chrome", proxyUrl: ISP_PROXY_URL } as any);
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
    const proxyFmt = (() => { const u = new URL(ISP_PROXY_URL); return `${u.hostname}:${u.port||"80"}:${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`; })();
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

  // ═══ RÉSULTAT ═════════════════════════════════════════════════════════════
  section("RÉSULTAT");
  if (body4.length > 1000) {
    log("OK", `🎉🎉🎉 /main/ → ${body4.length}B — DONNÉES BOOKITIT !`);
    log("INFO", `Aperçu: ${body4.slice(0, 120)}`);
  } else if (body4.length > 0) {
    log("WARN", `/main/ → ${body4.length}B: ${body4.slice(0, 200)}`);
  } else {
    log("ERR", "/main/ → 0B après 3 tentatives");
  }

  process.exit(0);
}

main().catch((e) => { console.error("[FATAL]", e); process.exit(1); });
