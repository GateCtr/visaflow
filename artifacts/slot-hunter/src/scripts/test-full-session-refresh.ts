/**
 * test-full-session-refresh.ts — Teste la boucle idéale :
 *   CF solve (1 fois) → puis boucle N fois :
 *     GET widget (token) → POST token (nouveau PHPSESSID) → /main/ → cfg → svc → ag
 *
 * Le cf_clearance est réutilisé à chaque cycle (pas de re-solve).
 * On vérifie que chaque cycle obtient un PHPSESSID frais et que getagendas/ répond.
 *
 * USAGE :
 *   npx tsx src/scripts/test-full-session-refresh.ts [PROXY_URL]
 */

import "dotenv/config";
import { Impit } from "impit";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  buildDynamicSession,
  callDirect,
  makeDirectUrl,
  makeDirectHeaders,
  parseDirectJsonp,
  CALL_DIRECT_NETWORK_ERROR,
} from "../spain-bookitit-direct.js";
import type { SpainCfSession } from "../spain-soax-solver.js";

// ── Config ────────────────────────────────────────────────────────────────────
const PORTAL_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.argv[2] || (process.env.SPAIN_ISP_PROXY_URL ?? process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "");
const NUM_CYCLES = 3;

function log(msg: string): void {
  console.log(`[test-refresh] ${msg}`);
}

function section(title: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCookieStr(jar: Record<string, string>): string {
  return Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractCookies(headers: { get: (k: string) => string | null }): Record<string, string> {
  const result: Record<string, string> = {};
  const raw = headers.get("set-cookie") ?? "";
  for (const part of raw.split(/,(?=[^ ])/)) {
    const m = part.trim().match(/^([^=]+)=([^;]*)/);
    if (m) result[m[1].trim()] = m[2];
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  section("CONFIG");
  log(`Portal    : ${PORTAL_URL}`);
  log(`Proxy     : ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "(direct)"}`);
  log(`CapSolver : ${CAPSOLVER_API_KEY ? "✅" : "❌"}`);
  log(`Cycles    : ${NUM_CYCLES}`);

  if (!CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }

  // Sticky session
  const stickyId = Math.random().toString(36).slice(2, 10);
  let stickyProxy = PROXY_URL;
  if (PROXY_URL && PROXY_URL.includes("sessionduration")) {
    try {
      const u = new URL(PROXY_URL);
      const user = decodeURIComponent(u.username);
      const stickyUser = user.includes("-session-")
        ? user.replace(/-session-[^-]+/, `-session-${stickyId}`)
        : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${stickyId}$2`);
      u.username = encodeURIComponent(stickyUser);
      stickyProxy = u.toString();
    } catch { /* keep */ }
  }

  // ── 1. Init session CF (une seule fois) ─────────────────────────────────────
  section("1 — CF SOLVE (unique)");
  const portalUrl = PORTAL_URL.split("#")[0];
  const initResult = await initWorkerSession(stickyProxy, portalUrl, CAPSOLVER_API_KEY);
  if (!initResult) { console.error("❌ initWorkerSession échoué"); process.exit(1); }

  const { session, impit } = initResult;
  const cfClearance = session.cfClearance;
  log(`✅ cf_clearance: ${cfClearance.slice(0, 30)}…`);
  log(`   PHPSESSID initial: ${session.allCookies.find(c => c.name === "PHPSESSID")?.value?.slice(0, 12)}`);
  log(`   /main/ initial: ${session.prefetchedMainHtml?.length ?? 0}B`);

  // Garder le jar de base (cf_clearance + _ga etc)
  const baseJar: Record<string, string> = {};
  for (const c of session.allCookies) baseJar[c.name] = c.value;
  if (cfClearance) baseJar.cf_clearance = cfClearance;

  const UA = session.userAgent;
  const targetUrl = portalUrl.endsWith("/") ? portalUrl : portalUrl + "/";

  // ── 2. Boucle : GET token → POST token → /main/ → cfg → svc → ag ──────────
  for (let cycle = 1; cycle <= NUM_CYCLES; cycle++) {
    section(`CYCLE ${cycle}/${NUM_CYCLES} — Nouveau PHPSESSID + full init`);
    const t0 = Date.now();

    // Copier le jar de base (cf_clearance reste, PHPSESSID sera remplacé)
    const jar = { ...baseJar };
    delete jar.PHPSESSID; // on veut un nouveau

    // ── GET widget → token ────────────────────────────────────────────────────
    log("📡 GET widget (token)…");
    let token = "";
    try {
      const r = await (impit.fetch(targetUrl, {
        headers: { "User-Agent": UA, "Cookie": buildCookieStr(jar) },
      } as any) as unknown as Promise<Response>);
      const body = await r.text();
      Object.assign(jar, extractCookies(r.headers as any));
      token = body.match(/name="token"\s+value="([^"]+)"/i)?.[1] ?? "";
      const isCf = r.status === 403 || /just a moment|_cf_chl_opt/i.test(body.slice(0, 3000));
      log(`   HTTP ${r.status} | ${body.length}B | token=${token ? "✅" : "❌"} | cf=${isCf ? "⚠️ CHALLENGE" : "non"}`);
      if (isCf) {
        log("   ❌ CF challenge → cf_clearance expiré — arrêt du test");
        break;
      }
      if (!token) {
        log("   ❌ Token absent — page non reconnue");
        break;
      }
    } catch (e) {
      log(`   ❌ Erreur réseau: ${e}`);
      break;
    }

    // ── POST token → PHPSESSID + srvsrc ───────────────────────────────────────
    log("📡 POST token…");
    let srvsrc = "https://www.citaconsular.es";
    let version = "4";
    try {
      const r = await (impit.fetch(targetUrl, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": buildCookieStr(jar),
          "Referer": targetUrl,
          "Origin": new URL(targetUrl).origin,
        },
        body: `token=${encodeURIComponent(token)}`,
      } as any) as unknown as Promise<Response>);
      const body = await r.text();
      Object.assign(jar, extractCookies(r.headers as any));
      srvsrc = body.match(/srvsrc:\s*'([^']+)'/)?.[1] ?? srvsrc;
      version = body.match(/loadermaec\.js\?v=(\d+)/)?.[1] ?? version;
      log(`   HTTP ${r.status} | PHPSESSID=${jar.PHPSESSID?.slice(0, 12) ?? "❌"} | srvsrc=${srvsrc}`);
    } catch (e) {
      log(`   ❌ Erreur POST: ${e}`);
      break;
    }

    if (!jar.PHPSESSID) {
      log("   ❌ Pas de PHPSESSID — impossible de continuer");
      break;
    }

    // ── Construire une DynamicSession manuellement ────────────────────────────
    const publickey = targetUrl.match(/widgetdefault\/([^/?#]+)/)?.[1] ?? "";
    const bookititBase = `${new URL(targetUrl).origin}/onlinebookings`;
    const jqCallback = `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    let reqCounter = Date.now();

    const makeUrl = (endpoint: string, extra?: Record<string, string>): string => {
      reqCounter++;
      const params: Array<[string, string]> = [
        ["callback", jqCallback], ["type", "default"], ["publickey", publickey], ["lang", "es"],
      ];
      if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
      if (extra?.["agendas[]"]) params.push(["agendas[]", extra["agendas[]"]]);
      params.push(["version", version], ["src", targetUrl], ["srvsrc", srvsrc]);
      for (const [k, v] of Object.entries(extra ?? {})) {
        if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
      }
      params.push(["_", String(reqCounter)]);
      return `${bookititBase}/${endpoint}?${params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}`;
    };

    const headers = {
      "User-Agent": UA,
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Referer": targetUrl,
      "Cookie": buildCookieStr(jar),
    };

    const fetchJsonp = async (endpoint: string, extra?: Record<string, string>): Promise<unknown | null> => {
      const url = makeUrl(endpoint, extra);
      try {
        const r = await (impit.fetch(url, { headers: { ...headers, Cookie: buildCookieStr(jar) } } as any) as unknown as Promise<Response>);
        const body = await r.text();
        Object.assign(jar, extractCookies(r.headers as any));
        return parseDirectJsonp(body);
      } catch (e) {
        log(`   ❌ ${endpoint} erreur: ${e}`);
        return null;
      }
    };

    // ── GET /main/ ──────────────────────────────────────────────────────────────
    log("📡 GET main/…");
    const mainUrl = makeUrl("main/");
    try {
      const r = await (impit.fetch(mainUrl, { headers: { ...headers, Cookie: buildCookieStr(jar) } } as any) as unknown as Promise<Response>);
      const body = await r.text();
      Object.assign(jar, extractCookies(r.headers as any));
      log(`   main/ → ${body.length}B | HTTP ${r.status}`);
    } catch (e) {
      log(`   ❌ main/ erreur: ${e}`);
      break;
    }

    // ── getwidgetconfigurations/ ────────────────────────────────────────────────
    log("📡 GET cfg/…");
    const cfg = await fetchJsonp("getwidgetconfigurations/");
    log(`   cfg/ → ${JSON.stringify(cfg ?? "").length}B | ok=${cfg !== null}`);

    // ── getservices/ ────────────────────────────────────────────────────────────
    log("📡 GET svc/…");
    const svcPayload = await fetchJsonp("getservices/") as any;
    const services: Array<{ id: string; name: string }> = svcPayload?.Services ?? svcPayload?.services ?? [];
    log(`   svc/ → ${services.length} services | AllowAppointment=${svcPayload?.AllowAppointment}`);
    for (const s of services) {
      log(`     • ${s.id} "${(s.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 40)}"`);
    }

    // ── getagendas/ ─────────────────────────────────────────────────────────────
    const bestSvc = services.find(s => (s.name ?? "").replace(/<[^>]*>/g, "").trim().length > 0) ?? services[0];
    if (!bestSvc) { log("   ⚠️ Pas de service"); continue; }

    log(`📡 GET ag/ (service=${bestSvc.id})…`);
    const agPayload = await fetchJsonp("getagendas/", { "services[]": bestSvc.id, selectedPeople: "1" }) as any;
    const agendas = agPayload?.Agendas ?? agPayload?.agendas ?? [];
    const agendaId = agendas.find((a: any) => a?.id)?.id ?? "";
    log(`   ag/ → ${JSON.stringify(agPayload ?? "").length}B | agendaId="${agendaId}" | agendas=${agendas.length}`);

    // ── datetime/ (si agenda présent) ───────────────────────────────────────────
    if (agendaId) {
      log(`📡 GET datetime/ (mois courant)…`);
      const now = new Date();
      const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const endStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      const dt = await fetchJsonp("datetime/", {
        "services[]": bestSvc.id, "agendas[]": agendaId,
        start: startStr, end: endStr, selectedPeople: "1",
      });
      log(`   dt/ → ${JSON.stringify(dt ?? "").length}B | ok=${dt !== null}`);
    }

    const elapsed = Date.now() - t0;
    log(`✅ Cycle ${cycle} terminé en ${elapsed}ms — PHPSESSID: ${jar.PHPSESSID?.slice(0, 12)}`);

    if (cycle < NUM_CYCLES) {
      log("⏳ Pause 5s…");
      await sleep(5000);
    }
  }

  section("RÉSULTAT");
  log("Vérifier que chaque cycle obtient un PHPSESSID frais et que cfg/svc/ag répondent.");
  log("Si GET widget retourne un CF challenge → cf_clearance expiré (normal après ~2h).");
  process.exit(0);
}

main().catch(err => { console.error("❌", err); process.exit(1); });
