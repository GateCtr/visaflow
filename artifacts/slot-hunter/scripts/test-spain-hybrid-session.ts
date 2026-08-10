/**
 * test-spain-hybrid-session.ts — Test du bootstrap hybride Espagne
 *
 * Valide l'architecture :
 *   Phase 1 — Browser (Puppeteer + cf-challenge-solver) :
 *     → Solve CF natif → Bienvenido dialog → Continuar → /main/ chargé
 *
 *   Phase 2 — impit (HTTP pur) :
 *     → Hérite contexte complet (cookies + UA + proxy + sec-ch-ua)
 *     → getservices/ → getagendas/ → confirmation que la session est chaude
 *
 * Usage :
 *   npx tsx scripts/test-spain-hybrid-session.ts [--portal kinshasa|saopolo] [--headed]
 */

import "dotenv/config";
import {
  bootstrapSpainSession,
  callBookititEndpoint,
  buildCookieString,
  loadProxyCsvFirst,
  type SpainBootstrapContext,
} from "../src/spain/spain-session-bootstrap.js";

// ─── Portails ─────────────────────────────────────────────────────────────────

const PORTALS: Record<string, { name: string; portalUrl: string; widgetKey: string; lang: "es" | "pt" }> = {
  kinshasa: {
    name: "Kinshasa (RDC)",
    portalUrl: "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/",
    widgetKey: "2d01502f12dc08400e22aea87fb00ae34",
    lang: "es",
  },
  saopolo: {
    name: "São Paulo (Brésil)",
    portalUrl: "https://www.citaconsular.es/pt/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/",
    widgetKey: "25028fcd7126544630b8da0c6e60722b5",
    lang: "pt",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const C = {
  RESET: "\x1b[0m", BOLD: "\x1b[1m", DIM: "\x1b[2m",
  RED: "\x1b[31m", GREEN: "\x1b[32m", YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m", MAGENTA: "\x1b[35m",
};

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function log(icon: string, msg: string, color = C.RESET): void {
  process.stdout.write(`${C.DIM}[${ts()}]${C.RESET} ${color}${icon}  ${msg}${C.RESET}\n`);
}

function ok(pass: boolean): string {
  return pass ? `${C.GREEN}✅${C.RESET}` : `${C.RED}❌${C.RESET}`;
}

function header(title: string): void {
  const line = "═".repeat(68);
  console.log(`\n${C.BOLD}${C.CYAN}${line}\n  ${title}\n${line}${C.RESET}\n`);
}

function elapsed(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ─── JSONP parser ─────────────────────────────────────────────────────────────

function parseJsonp(body: string): any {
  const m = body.match(/^(?:callback=)?[a-zA-Z0-9_$.]+\((.*)\);?$/s);
  if (m?.[1]) {
    try { return JSON.parse(m[1]); } catch { /* fall through */ }
  }
  try { return JSON.parse(body); } catch { return null; }
}

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs(): { portalKey: string; headed: boolean } {
  const args = process.argv.slice(2);
  let portalKey = "kinshasa";
  let headed = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--portal" && args[i + 1]) { portalKey = args[++i].toLowerCase(); }
    if (args[i] === "--headed") headed = true;
  }
  return { portalKey, headed };
}

// ─── Phase 2 — Validation impit ───────────────────────────────────────────────

interface Phase2Result {
  getservicesOk: boolean;
  servicesCount: number;
  services: Array<{ id: string; name: string }>;
  getagendasOk: boolean;
  agendasCount: number;
  errorMsg?: string;
}

async function runPhase2(
  ctx: SpainBootstrapContext,
  portalCfg: typeof PORTALS[string],
): Promise<Phase2Result> {
  const result: Phase2Result = {
    getservicesOk: false, servicesCount: 0, services: [],
    getagendasOk: false, agendasCount: 0,
  };

  const BASE_URL = "https://www.citaconsular.es/onlinebookings";
  const REFERER  = portalCfg.portalUrl;

  const commonParams: Record<string, string> = {
    type:       "default",
    publickey:  portalCfg.widgetKey,
    lang:       portalCfg.lang,
    version:    "4",
    src:        REFERER,
    srvsrc:     "https://www.citaconsular.es",
    callback:   `jsonp_${Date.now()}`,
    "_":        Date.now().toString(),
  };

  // ── 2a : getwidgetconfigurations/ (bootstrap PHP session côté serveur) ───────
  log("📡", "GET getwidgetconfigurations/ (init session PHP)…", C.CYAN);
  const t0 = Date.now();
  try {
    const { status, body } = await callBookititEndpoint(
      ctx, BASE_URL, "getwidgetconfigurations/", commonParams, REFERER,
    );
    log("ℹ️ ", `getwidgetconfigurations/ → ${status} | ${body.length}B | ${elapsed(Date.now() - t0)}`, C.DIM);
    if (body.length > 20) {
      const data = parseJsonp(body);
      log("ℹ️ ", `  → WidgetConfiguration: ${JSON.stringify(data?.WidgetConfiguration ?? data).slice(0, 80)}`, C.DIM);
    }
  } catch (e: any) {
    log("⚠️ ", `getwidgetconfigurations/ erreur (non-fatal): ${e.message?.slice(0, 80)}`, C.YELLOW);
  }

  // ── 2b : getservices/ ────────────────────────────────────────────────────────
  log("📡", "GET getservices/…", C.CYAN);
  const t1 = Date.now();
  try {
    const { status, body } = await callBookititEndpoint(
      ctx, BASE_URL, "getservices/",
      { ...commonParams, callback: `jsonp_${Date.now()}`, "_": Date.now().toString() },
      REFERER,
    );
    log("ℹ️ ", `getservices/ → ${status} | ${body.length}B | ${elapsed(Date.now() - t1)}`, C.DIM);

    if (body.length === 0) {
      result.errorMsg = "getservices/ → 0B (session non initialisée ou TLS fingerprint mismatch)";
      log("❌", result.errorMsg, C.RED);
      return result;
    }

    const data = parseJsonp(body);
    if (!data) {
      result.errorMsg = `getservices/ → body non-JSONP: ${body.slice(0, 120)}`;
      log("❌", result.errorMsg, C.RED);
      return result;
    }

    const services: any[] = data.Services ?? [];
    result.getservicesOk = services.length > 0;
    result.servicesCount = services.length;
    result.services = services.map((s: any) => ({
      id: String(s.id),
      name: (s.name ?? "").replace(/<[^>]*>/g, "").trim(),
    }));

    log(result.getservicesOk ? "✅" : "⚠️ ", `getservices/ → ${services.length} service(s)`, result.getservicesOk ? C.GREEN : C.YELLOW);
    for (const svc of result.services.slice(0, 5)) {
      log(" ", `   [${svc.id}] ${svc.name || "(nom masqué)"}`, C.DIM);
    }

    // ── 2c : getagendas/ pour le 1er service ──────────────────────────────────
    if (result.services.length > 0) {
      const firstSvcId = result.services[0].id;
      log("📡", `GET getagendas/ (service: ${firstSvcId})…`, C.CYAN);
      const t2 = Date.now();
      const { status: agStat, body: agBody } = await callBookititEndpoint(
        ctx, BASE_URL, "getagendas/",
        { ...commonParams, service_id: firstSvcId, callback: `jsonp_${Date.now()}`, "_": Date.now().toString() },
        REFERER,
      );
      log("ℹ️ ", `getagendas/ → ${agStat} | ${agBody.length}B | ${elapsed(Date.now() - t2)}`, C.DIM);

      if (agBody.length > 10) {
        const agData = parseJsonp(agBody);
        const agendas: any[] = agData?.Agendas ?? [];
        result.getagendasOk = agendas.length > 0;
        result.agendasCount = agendas.length;
        log(result.getagendasOk ? "✅" : "⚠️ ", `getagendas/ → ${agendas.length} agenda(s)`, result.getagendasOk ? C.GREEN : C.YELLOW);
      }
    }

  } catch (e: any) {
    result.errorMsg = `getservices/ exception: ${e.message?.slice(0, 120)}`;
    log("❌", result.errorMsg, C.RED);
  }

  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { portalKey, headed } = parseArgs();
  const portalCfg = PORTALS[portalKey];
  if (!portalCfg) {
    console.error(`❌ Portail inconnu: "${portalKey}". Disponibles: ${Object.keys(PORTALS).join(", ")}`);
    process.exit(1);
  }

  const line = "═".repeat(68);
  console.log(`\n${C.BOLD}${C.CYAN}${line}`);
  console.log("  TEST HYBRID SESSION — Espagne citaconsular.es");
  console.log(`${line}${C.RESET}\n`);

  log("🎯", `Portail  : ${C.BOLD}${portalCfg.name}${C.RESET}`, C.CYAN);
  log("🌐", `URL      : ${portalCfg.portalUrl}`, C.DIM);
  log("🔑", `Widget   : ${portalCfg.widgetKey}`, C.DIM);
  log("🖥️ ", `Headless : ${!headed}`, C.DIM);
  log("📦", `Proxy    : ${loadProxyCsvFirst().replace(/:([^:@]+)@/, ":***@").slice(0, 60)}`, C.DIM);

  // ════════════════════════════════════════════════════════════════════════════
  header("PHASE 1 — Bootstrap navigateur (CF + Continuar + /main/)");

  let ctx: SpainBootstrapContext;
  const t0 = Date.now();
  try {
    ctx = await bootstrapSpainSession(portalCfg.portalUrl, undefined, { headless: !headed });
  } catch (e: any) {
    log("❌", `Bootstrap échoué : ${e.message}`, C.RED);
    process.exit(1);
  }
  const bootstrapMs = Date.now() - t0;

  log("⏱️ ", `Bootstrap terminé en ${elapsed(bootstrapMs)}`, C.CYAN);
  log("🏷️ ", `Challenge: ${ctx.challengeType} | Résolu via: ${C.BOLD}${ctx.solvedBy}${C.RESET}`, C.CYAN);
  log("🍪", `cf_clearance : ${ctx.cfClearance ? `${ctx.cfClearance.slice(0, 30)}… ${C.GREEN}✅` : `${C.RED}absent (IP trusted → OK sans cookie)`}`, C.RESET);
  log("🍪", `PHPSESSID    : ${ctx.phpSessId ? `${ctx.phpSessId.slice(0, 20)}… ${C.GREEN}✅` : `${C.RED}❌ absent`}`, C.RESET);
  log("🍪", `Cookies total: ${ctx.cookies.length} — ${ctx.cookies.map((c) => c.name).join(", ")}`, C.DIM);
  log("🤖", `UA     : ${ctx.userAgent.slice(0, 70)}`, C.DIM);
  log("🔐", `sec-ch-ua : ${ctx.secChUa.slice(0, 70)}`, C.DIM);
  log("📦", `/main/ prefetch: ${ctx.prefetchedMainHtml.length}B`, ctx.prefetchedMainHtml.length > 10_000 ? C.GREEN : C.YELLOW);

  if (ctx.prefetchedMainHtml.length > 0) {
    const noHoras = /no hay horas disponibles/i.test(ctx.prefetchedMainHtml);
    log("📊", `Signal "No hay horas": ${noHoras ? "✅ détecté" : "❌ absent (créneaux peut-être dispo?)"}`, noHoras ? C.YELLOW : C.GREEN);
  }

  // ════════════════════════════════════════════════════════════════════════════
  header("PHASE 2 — Validation impit (session héritée)");

  log("🔗", `Cookie header (extrait): ${buildCookieString(ctx).slice(0, 80)}…`, C.DIM);

  const t1 = Date.now();
  const phase2 = await runPhase2(ctx, portalCfg);
  const phase2Ms = Date.now() - t1;

  // ════════════════════════════════════════════════════════════════════════════
  header("RAPPORT FINAL");

  const rows: Array<[string, boolean, string]> = [
    ["CF challenge résolu",       !!ctx.solvedBy && ctx.solvedBy !== "none", ctx.solvedBy],
    ["cf_clearance obtenu",       !!ctx.cfClearance,                         ctx.cfClearance ? `${ctx.cfClearance.slice(0, 20)}…` : "absent (IP trusted)"],
    ["PHPSESSID obtenu",          !!ctx.phpSessId,                           ctx.phpSessId ? `${ctx.phpSessId.slice(0, 15)}…` : "absent"],
    ["/main/ préchargé",          ctx.prefetchedMainHtml.length > 10_000,    `${ctx.prefetchedMainHtml.length}B`],
    ["getservices/ (données)",    phase2.getservicesOk,                      `${phase2.servicesCount} service(s)`],
    ["getagendas/ (données)",     phase2.getagendasOk,                       `${phase2.agendasCount} agenda(s)`],
  ];

  const pad = (s: string, n: number) => s.padEnd(n, " ");
  for (const [label, pass, detail] of rows) {
    console.log(`  ${ok(pass)}  ${pad(label, 30)} ${C.DIM}${detail}${C.RESET}`);
  }

  console.log();
  log("⏱️ ", `Phase 1 (browser) : ${elapsed(bootstrapMs)}`, C.DIM);
  log("⏱️ ", `Phase 2 (impit)   : ${elapsed(phase2Ms)}`, C.DIM);
  log("⏱️ ", `Total             : ${elapsed(bootstrapMs + phase2Ms)}`, C.CYAN);
  log("🌐", `Proxy utilisé     : ${ctx.proxyUrl.replace(/:([^:@]+)@/, ":***@")}`, C.DIM);

  if (phase2.errorMsg) {
    console.log();
    log("📝", `Note: ${phase2.errorMsg}`, C.YELLOW);
    log("💡", "Si 0B → vérifier que le même port proxy est sticky entre browser et impit", C.DIM);
  }

  if (!phase2.getservicesOk && !phase2.errorMsg) {
    console.log();
    log("💡", "getservices/ vide → session Bookitit pas initialisée", C.YELLOW);
    log("   ", "→ Vérifier que Continuar a bien été cliqué (logs Phase 1)", C.DIM);
    log("   ", "→ Vérifier que la même IP proxy est utilisée (sticky session)", C.DIM);
  }

  if (phase2.getservicesOk) {
    console.log();
    log("🎉", `${C.BOLD}${C.GREEN}SESSION HYBRIDE VALIDÉE — impit hérite correctement du browser${C.RESET}`, C.GREEN);
    log("🚀", "Prêt pour intégration dans le scanner spain-watcher-loop", C.GREEN);
  }

  console.log();
}

main().catch((e) => {
  console.error(`\nFatal: ${e.message ?? e}`);
  process.exit(1);
});
