/**
 * test-impit-jsd-bookitit.ts — Test flow complet Impit-only (JSD solver → Bookitit)
 *
 * Utilise spain-impit-session.ts (JSD solver natif) pour obtenir un cf_clearance
 * lié au JA3 d'Impit, puis reproduit le flow widget Bookitit en HTTP pur.
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   SPAIN_SESSION_MODE=impit npx tsx src/scripts/test-impit-jsd-bookitit.ts
 */

import "dotenv/config";
import { ensureSpainImpitSession } from "../_legacy_spain-impit-session.js";
import { getSpainImpit, spainCfFetch, type SpainCfSession } from "../spain-soax-solver.js";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const BOOKITIT_BASE = "https://www.citaconsular.es/onlinebookings";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string): void {
  const icons: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}

async function main(): Promise<void> {
  console.log("═".repeat(72));
  console.log("  TEST IMPIT JSD → BOOKITIT (100% HTTP, pas de browser)");
  console.log("═".repeat(72));

  // Force impit mode
  process.env.SPAIN_SESSION_MODE = "impit";

  log("STEP", "ensureSpainImpitSession (JSD solver via Impit)…");
  const session = await ensureSpainImpitSession(SAOPOLO_URL);

  if (!session) {
    log("ERR", "Session Impit échouée — JSD solver n'a pas pu résoudre CF");
    process.exit(1);
  }

  log("OK", `Session Impit obtenue !`);
  log("INFO", `cf_clearance : ${session.cfClearance.slice(0, 30)}…`);
  log("INFO", `PHPSESSID    : ${session.allCookies.find((c) => c.name === "PHPSESSID")?.value.slice(0, 12) ?? "absent"}…`);
  log("INFO", `UA           : ${session.userAgent.slice(0, 60)}`);
  log("INFO", `Proxy        : ${session.soaxProxyUrl?.replace(/:([^@:]+)@/, ":***@").slice(0, 50) ?? "direct"}`);

  // Tester /main/ via spainCfFetch (utilise le même impit)
  log("STEP", "Test spainCfFetch → /main/ JSONP…");

  const mainUrl = `${BOOKITIT_BASE}/main/?type=default&publickey=2d01502f12dc08400e22aea87fb00ae34&lang=es&version=4&callback=cb&_=${Date.now()}`;
  const resp = await spainCfFetch(mainUrl, session);

  if (!resp) {
    log("ERR", "spainCfFetch retourne null — requête échouée");
    process.exit(1);
  }

  const body = await resp.text();
  log("INFO", `/main/ → HTTP ${resp.status} | ${body.length}B`);

  if (body.length === 0) {
    log("ERR", "/main/ → 0B — session Impit non acceptée par Bookitit");
  } else if (body.includes('"Exception"')) {
    log("WARN", `/main/ → Exception : ${body.slice(0, 150)}`);
    log("INFO", "→ Le token POST form est probablement nécessaire pour initialiser le widget");
  } else if (body.length > 1000) {
    log("OK", `🎉 /main/ → ${body.length}B de données RÉELLES via Impit pur !`);
    log("INFO", `Aperçu : ${body.slice(0, 150)}`);
  } else {
    log("WARN", `/main/ → ${body.length}B : ${body.slice(0, 200)}`);
  }

  console.log("\n" + "═".repeat(72));
  log("INFO", "Test terminé.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
