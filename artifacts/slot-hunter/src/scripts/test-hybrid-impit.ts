/**
 * test-hybrid-impit.ts — Diagnostic hybride : session browser → impit prend le relais
 *
 * OBJECTIF : tester si impit peut exécuter le flux Bookitit complet en utilisant
 * les cookies CF obtenus par le browser Chromium (cf_clearance + PHPSESSID).
 *
 * FLUX TESTÉ (étape par étape) :
 *   1. Restaurer la session depuis Redis (établie par le browser Chromium)
 *   2. STEP A : GET portail → "Continue / Continuar" form ou widget SPA direct ?
 *   3. STEP B : POST token → widget HTML Bookitit
 *   4. STEP C : GET /main/ via impit → oClientValues JSON
 *   5. STEP D : GET getagendas/ via impit → agendas JSON
 *   6. STEP E : GET datetime/ via impit → créneaux
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-hybrid-impit.ts
 *   npx tsx src/scripts/test-hybrid-impit.ts saopola    # portail São Paulo
 *   npx tsx src/scripts/test-hybrid-impit.ts kinshasa   # portail Kinshasa (défaut)
 */

import "dotenv/config";
import {
  restoreSpainCfSessionFromRedis,
  initSpainRedis,
} from "../spain-redis-persistence.js";
import {
  spainCfFetch,
  getSpainImpit,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import {
  KINSHASA_PORTAL_URL,
  KINSHASA_WIDGET_KEY,
  KINSHASA_DEFAULT_SERVICE_ID,
  SAOPOLO_PORTAL_URL,
  SAOPOLO_WIDGET_KEY,
} from "../spain-portals.js";

// ─── Configuration ────────────────────────────────────────────────────────────
// Usage: npx tsx src/scripts/test-hybrid-impit.ts [kinshasa|saopola] [--isp]
//   --isp  : force utilisation du proxy ISP (isp.decodo.com) au lieu du DC proxy de la session
const PORTAL_ARG = (process.argv[2] ?? "kinshasa").toLowerCase().replace(/^--/, "");
const IS_SAOPOLA = PORTAL_ARG === "saopola" || PORTAL_ARG === "sao" || PORTAL_ARG === "sp";
const FORCE_ISP  = process.argv.includes("--isp") || process.argv.includes("isp");

const PORTAL_URL  = IS_SAOPOLA ? SAOPOLO_PORTAL_URL.replace(/#.*$/, "")  : KINSHASA_PORTAL_URL.replace(/#.*$/, "");
const WIDGET_KEY  = IS_SAOPOLA ? SAOPOLO_WIDGET_KEY  : KINSHASA_WIDGET_KEY;
// Saopola pasaportes service ID (from video: bkt8S3215)
const SERVICE_ID  = IS_SAOPOLA ? "bkt8S3215" : KINSHASA_DEFAULT_SERVICE_ID;
const PORTAL_NAME = IS_SAOPOLA ? "São Paulo (Saopola)" : "Kinshasa";
const BASE_BKT    = "https://www.citaconsular.es/onlinebookings/";

// ─── Log helpers ──────────────────────────────────────────────────────────────
const t0 = Date.now();
const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const now = () => new Date().toISOString().slice(11, 23);

function section(title: string) {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}
function step(n: string, title: string) {
  console.log(`\n  ┌─ STEP ${n}: ${title}`);
}
function ok(msg: string)    { console.log(`  │  ✅ ${msg}`); }
function warn(msg: string)  { console.log(`  │  ⚠️  ${msg}`); }
function fail(msg: string)  { console.log(`  │  ❌ ${msg}`); }
function info(msg: string)  { console.log(`  │  ℹ️  ${msg}`); }
function done(status: "✅ PASS" | "❌ FAIL" | "⚠️  SKIP", msg = "") {
  console.log(`  └─ ${status}${msg ? " — " + msg : ""}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractToken(html: string): string | null {
  return (
    html.match(/name="token"\s+value="([^"]+)"/) ??
    html.match(/<input[^>]+name=["']token["'][^>]+value=["']([^"']+)["']/i) ??
    html.match(/<input[^>]+value=["']([a-f0-9]{20,})["'][^>]+name=["']token["']/i)
  )?.[1] ?? null;
}

function isCfChallenge(html: string): boolean {
  return /un instant|just a moment|verifying you are human|_cf_chl_opt/i.test(html.slice(0, 5_000));
}

function isWidgetSpa(html: string): boolean {
  return /bkt_init_widget|idBktWidget|onlinebookings/i.test(html);
}

function hasContinueButton(html: string): boolean {
  return /Continue\s*\/\s*Continuar|Para solicitar cita|To request an appointment/i.test(html);
}

function extractJsonp(body: string): string | null {
  const m = body.match(/^[a-zA-Z0-9_$]+\(([\s\S]+)\)\s*;?\s*$/);
  return m ? m[1] : null;
}

function cookieSummary(cookies: Array<{ name: string; value: string }>): string {
  return cookies.map(c => `${c.name}=${c.value.slice(0, 12)}…`).join(" | ");
}

async function fetchRaw(
  session: SpainCfSession,
  url: string,
  opts?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string; ct: string; size: number } | null> {
  const res = await spainCfFetch(url, session, {
    method: opts?.method ?? "GET",
    headers: opts?.headers,
    body: opts?.body,
  });
  if (!res) return null;
  const body = await res.text().catch(() => "");
  const ct   = res.headers.get("content-type") ?? "";
  return { status: res.status, body, ct, size: body.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function testAjaxEndpoints(
  label: string,
  session: SpainCfSession,
  widgetReferer: string,
): Promise<{ getservices: boolean; getagendas: boolean; datetime: boolean }> {
  const results = { getservices: false, getagendas: false, datetime: false };
  const ts = Date.now();

  // getservices/
  const svcQ = new URLSearchParams({
    callback: `jQuerySvc${ts}`, type: "default", publickey: WIDGET_KEY,
    lang: "es", version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es", _: String(ts),
  });
  const svcR = await fetchRaw(session, `${BASE_BKT}getservices/?${svcQ}`, {
    headers: { "Accept": "*/*", "Referer": widgetReferer, "Sec-Fetch-Dest": "empty",
               "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" },
  });
  const svcOk = (svcR?.size ?? 0) > 0 && !(svcR?.ct ?? "").startsWith("text/html");
  console.log(`  │  [${label}] getservices/  → HTTP ${svcR?.status} | ${svcR?.size}B | ct=${svcR?.ct?.split(";")[0]} ${svcOk ? "✅" : "❌"}`);
  results.getservices = svcOk;

  // getagendas/
  const agQ = new URLSearchParams({
    callback: `jQueryAg${ts}`, type: "default", publickey: WIDGET_KEY,
    lang: "es", version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es", "services[]": SERVICE_ID, _: String(ts + 1),
  });
  const agR = await fetchRaw(session, `${BASE_BKT}getagendas/?${agQ}`, {
    headers: { "Accept": "*/*", "Referer": widgetReferer, "Sec-Fetch-Dest": "empty",
               "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" },
  });
  const agOk = (agR?.size ?? 0) > 0 && !(agR?.ct ?? "").startsWith("text/html");
  console.log(`  │  [${label}] getagendas/  → HTTP ${agR?.status} | ${agR?.size}B | ct=${agR?.ct?.split(";")[0]} ${agOk ? "✅" : "❌"}`);
  results.getagendas = agOk;

  // datetime/
  const nextMonth = new Date(Date.now() + 32 * 86400_000).toISOString().slice(0, 7);
  const dtQ = new URLSearchParams({
    callback: `jQueryDt${ts}`, type: "default", publickey: WIDGET_KEY,
    lang: "es", version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es", "services[]": SERVICE_ID,
    start: `${nextMonth}-01`, _: String(ts + 2),
  });
  const dtR = await fetchRaw(session, `${BASE_BKT}datetime/?${dtQ}`, {
    headers: { "Accept": "*/*", "Referer": widgetReferer, "Sec-Fetch-Dest": "empty",
               "Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "same-origin" },
  });
  const dtOk = (dtR?.size ?? 0) > 0 && !(dtR?.ct ?? "").startsWith("text/html");
  console.log(`  │  [${label}] datetime/    → HTTP ${dtR?.status} | ${dtR?.size}B | ct=${dtR?.ct?.split(";")[0]} ${dtOk ? "✅" : "❌"}`);
  results.datetime = dtOk;

  return results;
}

async function main() {
  section(`🧪 Diagnostic Hybride — Portail ${PORTAL_NAME}  [${now()}]`);
  console.log(`  Portal URL : ${PORTAL_URL}`);
  console.log(`  Widget key : ${WIDGET_KEY}`);
  console.log(`  Service ID : ${SERVICE_ID}`);
  console.log(`  Proxy mode : ${FORCE_ISP ? "ISP forcé (--isp)" : "DC proxy (session)"}`);

  // ── 0. Init Redis + restaurer session ───────────────────────────────────────
  section("STEP 0 — Restauration session depuis Redis");
  await initSpainRedis();

  const redisData = await restoreSpainCfSessionFromRedis();
  if (!redisData) {
    fail("Aucune session dans Redis. Lance d'abord le scanner pour établir une session browser.");
    process.exit(1);
  }

  const ageMin = Math.round((Date.now() - redisData.createdAt) / 60_000);
  const remMin = Math.round((redisData.expiresAt - Date.now()) / 60_000);
  ok(`Session trouvée — source=${redisData.source} | âge=${ageMin}min | expire dans ${remMin}min`);
  info(`Cookies : ${cookieSummary(redisData.allCookies)}`);
  info(`cf_clearance : ${redisData.cfClearance.slice(0, 40)}…`);
  info(`Proxy : ${(redisData.soaxProxyUrl || "AUCUN").replace(/:([^:@]+)@/, ":***@").slice(0, 60)}`);
  info(`prefetchedMainHtml : ${(redisData.prefetchedMainHtml?.length ?? 0)}B`);

  if (remMin <= 0) {
    fail("Session expirée ! Relance le scanner pour obtenir une nouvelle session.");
    process.exit(1);
  }

  // ── Créer session hybride — source=undefined pour forcer impit sur /onlinebookings/ ──
  // Note : spainCfFetch route vers le browser CDP quand source==="playwright".
  // On override source pour que TOUS les appels passent par impit.
  const session: SpainCfSession = {
    ...redisData,
    source: undefined,    // ← force impit pour les endpoints /onlinebookings/
    prefetchedMainHtml: undefined, // ← pas de cache prefetch (on veut tester live)
  } as SpainCfSession;

  ok(`Session hybride créée (source overridé → impit pour tous les endpoints)`);

  // ── STEP A : GET portail ────────────────────────────────────────────────────
  step("A", `GET portail ${PORTAL_URL.slice(0, 70)}`);
  const aRes = await fetchRaw(session, PORTAL_URL, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Upgrade-Insecure-Requests": "1",
    },
  });

  if (!aRes) {
    fail("Aucune réponse réseau (proxy coupé ?)");
    done("❌ FAIL", "réseau");
    process.exit(1);
  }

  info(`HTTP ${aRes.status} | ${aRes.size}B | ct=${aRes.ct.split(";")[0]}`);
  info(`Preview: ${aRes.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`);

  const stepA_cfBlock  = isCfChallenge(aRes.body) || aRes.status === 403;
  const stepA_hasCont  = hasContinueButton(aRes.body);
  const stepA_hasToken = extractToken(aRes.body);
  const stepA_isSpa    = isWidgetSpa(aRes.body);

  if (stepA_cfBlock) {
    fail("CF challenge actif sur le portail HTML — impit bloqué même avec cf_clearance browser");
    info("→ Cause probable : CF fait une distinction entre la page PHP et les endpoints JSONP");
    info("→ Conséquence : hybrid impossible pour le GET portail, il faut garder le browser pour cette étape");
    done("❌ FAIL", "CF bloque la page portail HTML pour impit");
  } else if (stepA_hasToken || stepA_hasCont) {
    ok(`Page "Continue / Continuar" reçue — token=${stepA_hasToken ? '"' + stepA_hasToken.slice(0, 20) + '…"' : "absent (?)"}`);
    done("✅ PASS", "portail HTML accessible via impit");
  } else if (stepA_isSpa) {
    ok("Widget SPA direct (PHPSESSID chaud — pas de page Continue)");
    done("✅ PASS", "widget SPA direct — pas besoin du POST token");
  } else {
    warn(`Réponse inattendue — ni CF ni Continue ni Widget. Status=${aRes.status}`);
    info("HTML raw (500c): " + aRes.body.slice(0, 500));
    done("⚠️  SKIP", "réponse inconnue — continuer manuellement");
  }

  // ── STEP B : POST token Continue ────────────────────────────────────────────
  let widgetHtml = stepA_isSpa ? aRes.body : "";
  const widgetReferer = PORTAL_URL.replace(/\/?$/, "/");

  if (!stepA_cfBlock && !stepA_isSpa && stepA_hasToken) {
    step("B", `POST token → ${widgetReferer.slice(0, 70)}`);
    info(`token="${stepA_hasToken.slice(0, 30)}…"`);

    const bRes = await fetchRaw(session, widgetReferer, {
      method: "POST",
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cache-Control": "max-age=0",
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": "https://www.citaconsular.es",
        "Referer": PORTAL_URL,
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      body: `token=${encodeURIComponent(stepA_hasToken)}`,
    });

    if (!bRes) {
      fail("POST token sans réponse réseau");
      done("❌ FAIL");
    } else {
      info(`HTTP ${bRes.status} | ${bRes.size}B | ct=${bRes.ct.split(";")[0]}`);
      const bIsSpa  = isWidgetSpa(bRes.body);
      const bIsCf   = isCfChallenge(bRes.body);
      info(`Preview: ${bRes.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)}`);

      if (bIsCf) {
        fail("CF challenge dans la réponse POST — CF bloque le POST après le GET");
        done("❌ FAIL", "CF challenge post POST");
      } else if (bIsSpa) {
        ok(`Widget SPA reçu après POST (${bRes.size}B)`);
        widgetHtml = bRes.body;
        done("✅ PASS");
      } else if (bRes.status === 302 || bRes.status === 301) {
        ok(`Redirect ${bRes.status} → widget chargé via redirect`);
        done("✅ PASS", "redirect");
      } else {
        warn("Réponse POST non reconnue (ni SPA ni CF ni redirect)");
        info("HTML raw (500c): " + bRes.body.slice(0, 500));
        done("⚠️  SKIP");
      }
    }
  } else if (!stepA_cfBlock && !stepA_isSpa && !stepA_hasToken) {
    step("B", "POST token");
    warn("Pas de token dans la page Continue — impossible de POST");
    info("HTML raw (500c): " + aRes.body.slice(0, 500));
    done("⚠️  SKIP", "token absent");
  }

  // ── STEP C : GET /main/ via impit ───────────────────────────────────────────
  step("C", "GET /main/ via impit");
  const ts = Date.now();
  const mainParams = new URLSearchParams({
    callback: `jQueryHybrid${ts}`,
    type: "default",
    publickey: WIDGET_KEY,
    lang: "es",
    version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es",
    _: String(ts),
  });

  const cRes = await fetchRaw(session, `${BASE_BKT}main/?${mainParams}`, {
    headers: {
      "Accept": "*/*",
      "Referer": widgetReferer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!cRes) {
    fail("GET /main/ sans réponse réseau");
    done("❌ FAIL");
  } else {
    info(`HTTP ${cRes.status} | ${cRes.size}B | ct=${cRes.ct.split(";")[0]}`);
    if (cRes.size === 0) {
      fail("/main/ retourne 0B — CF bloque ou PHPSESSID invalide pour cet endpoint");
      info("→ Si source=playwright fonctionne mais impit=0B : TLS session mismatch");
      done("❌ FAIL", "0B — impit bloqué pour /main/");
    } else if (cRes.body.includes("oClientValues") || cRes.body.includes("bkt_init_widget")) {
      ok(`/main/ JSONP reçu (${cRes.size}B) — oClientValues présent`);
      const preview = cRes.body.slice(0, 200).replace(/\s+/g, " ");
      info(`Preview: ${preview}`);
      done("✅ PASS");
    } else if (isCfChallenge(cRes.body)) {
      fail("/main/ → CF challenge HTML (interstitiel)");
      done("❌ FAIL", "CF challenge");
    } else {
      warn(`/main/ → réponse inattendue (${cRes.size}B, ct=${cRes.ct})`);
      info(`Preview: ${cRes.body.slice(0, 300)}`);
      done("⚠️  SKIP", "réponse non reconnue");
    }
  }

  // ── STEP D : GET getagendas/ via impit ─────────────────────────────────────
  step("D", `GET getagendas/?services[]=${SERVICE_ID} via impit`);
  const agTs = Date.now();
  const agParams = new URLSearchParams({
    callback: `jQueryHybridAg${agTs}`,
    type: "default",
    publickey: WIDGET_KEY,
    lang: "es",
    version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    _: String(agTs),
  });

  const dRes = await fetchRaw(session, `${BASE_BKT}getagendas/?${agParams}`, {
    headers: {
      "Accept": "*/*",
      "Referer": widgetReferer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!dRes) {
    fail("GET getagendas/ sans réponse réseau");
    done("❌ FAIL");
  } else {
    info(`HTTP ${dRes.status} | ${dRes.size}B | ct=${dRes.ct.split(";")[0]}`);
    if (dRes.size === 0) {
      fail("getagendas/ → 0B (même problème que dans le browser)");
      done("❌ FAIL", "0B");
    } else if (dRes.ct.includes("text/html") && dRes.size < 200) {
      fail("getagendas/ → HTML redirect (serveur exige état session PHP)");
      info(`Body: ${dRes.body.slice(0, 200)}`);
      done("❌ FAIL", "HTML redirect");
    } else if (dRes.body.includes('"Agendas"') || dRes.body.includes('"id"')) {
      ok(`getagendas/ JSONP reçu (${dRes.size}B)`);
      const parsed = extractJsonp(dRes.body);
      if (parsed) {
        try {
          const obj = JSON.parse(parsed);
          const agendas = obj?.Agendas ?? [];
          ok(`${agendas.length} agenda(s) trouvé(s)`);
          for (const ag of agendas.slice(0, 3)) {
            info(`  Agenda: id=${ag.id} name=${ag.name}`);
          }
        } catch { info("Parsing JSON échoué mais JSONP reçu"); }
      }
      done("✅ PASS");
    } else {
      warn("Réponse getagendas/ non reconnue");
      info(`Preview: ${dRes.body.slice(0, 300)}`);
      done("⚠️  SKIP");
    }
  }

  // ── STEP E : GET datetime/ via impit ───────────────────────────────────────
  step("E", `GET datetime/?services[]=${SERVICE_ID} via impit`);
  const dtTs = Date.now();
  const curMonth = new Date().toISOString().slice(0, 7);
  const nextMonth = new Date(Date.now() + 32 * 86400_000).toISOString().slice(0, 7);
  const startDate = `${nextMonth}-01`;

  const dtParams = new URLSearchParams({
    callback: `jQueryHybridDt${dtTs}`,
    type: "default",
    publickey: WIDGET_KEY,
    lang: "es",
    version: "4",
    src: `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/`,
    srvsrc: "https://www.citaconsular.es",
    "services[]": SERVICE_ID,
    start: startDate,
    _: String(dtTs),
  });

  const eRes = await fetchRaw(session, `${BASE_BKT}datetime/?${dtParams}`, {
    headers: {
      "Accept": "*/*",
      "Referer": widgetReferer,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!eRes) {
    fail("GET datetime/ sans réponse réseau");
    done("❌ FAIL");
  } else {
    info(`HTTP ${eRes.status} | ${eRes.size}B | ct=${eRes.ct.split(";")[0]}`);
    if (eRes.size === 0) {
      fail("datetime/ → 0B");
      done("❌ FAIL", "0B");
    } else if (eRes.body.includes('"slots"') || eRes.body.includes('"hours"') || eRes.body.includes('"time"') || eRes.body.includes('"Huecos"')) {
      ok(`datetime/ JSONP reçu (${eRes.size}B) — créneaux présents`);
      info(`Preview: ${eRes.body.slice(0, 250)}`);
      done("✅ PASS");
    } else if (eRes.body.includes('"NoHours"') || eRes.body.includes('"nohours"') || eRes.body.includes("NoHay")) {
      ok(`datetime/ → "No hay horas" (${eRes.size}B) — portail accessible mais 0 créneau ce mois`);
      done("✅ PASS", "accessible — 0 créneau (normal)");
    } else {
      warn("Réponse datetime/ non reconnue");
      info(`Preview: ${eRes.body.slice(0, 300)}`);
      done("⚠️  SKIP");
    }
  }

  // ── STEP F : Test proxy ISP pour endpoints AJAX ─────────────────────────────
  section("STEP F — Comparatif DC proxy vs ISP proxy pour endpoints AJAX");

  const ispProxyUrl = process.env.DECODO_PROXY_URL;
  const dcProxyUrl  = redisData.soaxProxyUrl;

  info(`DC  proxy : ${(dcProxyUrl ?? "AUCUN").replace(/:([^:@]+)@/, ":***@").slice(0, 70)}`);
  info(`ISP proxy : ${ispProxyUrl ? ispProxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 70) : "❌ DECODO_PROXY_URL non défini"}`);

  const widgetReferer2 = PORTAL_URL.replace(/\/?$/, "/");

  step("F1", "DC proxy — getservices/ + getagendas/ + datetime/ via impit");
  const dcSession: SpainCfSession = { ...session };
  const dcResults = await testAjaxEndpoints("DC", dcSession, widgetReferer2);
  done(
    (dcResults.getservices || dcResults.getagendas || dcResults.datetime)
      ? "✅ PASS" : "❌ FAIL",
    `getservices=${dcResults.getservices ? "✅" : "❌"} getagendas=${dcResults.getagendas ? "✅" : "❌"} datetime=${dcResults.datetime ? "✅" : "❌"}`,
  );

  let ispResults = { getservices: false, getagendas: false, datetime: false };
  if (!ispProxyUrl) {
    step("F2", "ISP proxy — SKIP (DECODO_PROXY_URL non défini)");
    done("⚠️  SKIP", "env var manquante");
  } else {
    step("F2", "ISP proxy — getservices/ + getagendas/ + datetime/ via impit");
    // Utiliser le proxy ISP avec les mêmes cookies de session (PHPSESSID + cf_clearance)
    // Le PHPSESSID a été créé via DC proxy — on teste si le serveur PHP valide par IP ou pas.
    const ispSession: SpainCfSession = {
      ...session,
      soaxProxyUrl: ispProxyUrl,  // ← override proxy → ISP au lieu de DC
    } as SpainCfSession;
    ispResults = await testAjaxEndpoints("ISP", ispSession, widgetReferer2);
    done(
      (ispResults.getservices || ispResults.getagendas || ispResults.datetime)
        ? "✅ PASS" : "❌ FAIL",
      `getservices=${ispResults.getservices ? "✅" : "❌"} getagendas=${ispResults.getagendas ? "✅" : "❌"} datetime=${ispResults.datetime ? "✅" : "❌"}`,
    );
  }

  // ── Résumé ─────────────────────────────────────────────────────────────────
  section(`Résumé — Portail ${PORTAL_NAME}  [${elapsed()}]`);
  const dcLabel = dcResults.getagendas ? "✅ DC fonctionne" : "❌ DC bloqué";
  const ispLabel = ispProxyUrl
    ? (ispResults.getagendas ? "✅ ISP fonctionne → mode hybride possible" : "❌ ISP bloqué aussi")
    : "⚠️  ISP non testé";

  console.log(`
  Proxy DC       : ${(dcProxyUrl ?? "AUCUN").replace(/:([^:@]+)@/, ":***@").slice(0, 60)}
  Proxy ISP      : ${ispProxyUrl ? ispProxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "N/A"}
  Session âge    : ${ageMin}min | expire dans : ${remMin}min
  Source Redis   : ${redisData.source}

  STEP A  (GET portail)        : ${stepA_cfBlock ? "❌ CF bloque" : stepA_isSpa ? "✅ SPA direct" : stepA_hasToken ? "✅ Continue form" : "⚠️  inconnu"}
  STEP B  (POST token)         : voir logs ci-dessus
  STEP C  (/main/ impit)       : voir logs ci-dessus
  STEP D  (getagendas/ DC)     : voir logs ci-dessus
  STEP E  (datetime/ DC)       : voir logs ci-dessus
  STEP F1 (AJAX DC proxy)      : ${dcLabel}
  STEP F2 (AJAX ISP proxy)     : ${ispLabel}
  `);

  if (ispResults.getagendas) {
    console.log("  🎯 CONCLUSION: ISP proxy contourne le blocage Bookitit PHP server.");
    console.log("     → Implémenter hybrid: browser (DC) pour CF solve + impit ISP pour AJAX.");
  } else if (!ispResults.getagendas && !dcResults.getagendas) {
    console.log("  🔴 CONCLUSION: Les deux proxies sont bloqués.");
    console.log("     → Le blocage est probablement au niveau du PHPSESSID (IP mismatch PHP session).");
    console.log("     → Solution: faire un CF solve complet via le proxy ISP (browser + ISP proxy).");
  }
}

main().catch((err) => {
  console.error("\n💥 Erreur fatale:", err);
  process.exit(1);
});
