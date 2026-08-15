/**
 * test-spain-watcher-portal-e2e.ts — E2E live d'un cycle Spain Watcher complet
 *
 * Exécute les mêmes étapes que startSpainWatcherLoop() pour UN portail donné :
 *   1. Init Redis + restauration session SOAX (si mode HTTP)
 *   2. Pre-warm session CF (ensureActiveSession)
 *   3. Verrou distribué Redis (optionnel)
 *   4. Probe (runSpainHttpProbe ou runSpainWatcherProbe selon le mode)
 *   5. Diagnostic services + exploration créneaux (si found + mode HTTP/PB)
 *   6. Auto-booking HTTP (optionnel — uniquement si credentials fournis)
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *
 *   # Mode persistent-browser (recommandé)
 *   SPAIN_SESSION_MODE=persistent-browser \
 *     npx tsx src/scripts/test-spain-watcher-portal-e2e.ts \
 *     "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/"
 *
 *   # Mode HTTP-only
 *   SPAIN_HTTP_MODE=1 \
 *     npx tsx src/scripts/test-spain-watcher-portal-e2e.ts "<portalUrl>"
 *
 *   # Avec auto-booking
 *   SPAIN_SESSION_MODE=persistent-browser \
 *     npx tsx src/scripts/test-spain-watcher-portal-e2e.ts "<portalUrl>" \
 *     --login user@example.com --password secret --visa-type "Visa C — Tourisme / Affaires"
 *
 * Options :
 *   --login EMAIL           Login Bookitit (active le booking)
 *   --password PASS         Mot de passe Bookitit
 *   --visa-type TEXT        Type de visa pour le matching service (défaut: Visa C — Tourisme / Affaires)
 *   --otp-channel CHANNEL   email | sms | manual (défaut: email)
 *   --applicant-name NAME   Nom affiché dans les logs
 *   --with-lock             Acquérir le verrou Redis (défaut: skip)
 *   --skip-prewarm          Ne pas pre-warm — réutiliser uniquement la session existante
 *   --help
 *
 * Prérequis selon le mode :
 *   persistent-browser → DECODO_PROXY_URL (ou SOAX_PROXY_URL)
 *   HTTP-only          → DECODO_PROXY_URL + CAPSOLVER_API_KEY
 *   Playwright legacy  → (optionnel) SPAIN_WATCHER_USE_PROXY=1
 */

import "dotenv/config";
import { runSpainWatcherProbe } from "../_legacy_spainPortal.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import {
  ensureSpainCfSession,
  getActiveSpainCfSession,
  restoreSpainSoaxStateFromRedis,
} from "../spain-soax-solver.js";
import {
  ensureSpainPersistentBrowserSession,
  getActiveSpainPersistentBrowserSession,
} from "../_legacy_spain-persistent-browser.js";
import {
  initSpainRedis,
  acquireSpainScannerLock,
  releaseSpainScannerLock,
  SPAIN_INSTANCE_ID,
} from "../spain-redis-persistence.js";
import {
  executeHttpBooking,
  extractServicesFromHtml,
  type SpainBookingConfig,
} from "../spain-http-booking.js";
import { matchServiceForVisa } from "../spain-service-mapping.js";
import {
  exploreAvailableSlots,
  formatExplorationForLogs,
} from "../spain-slot-explorer.js";

// ─── Mode watcher (identique à spain-watcher-loop.ts) ────────────────────────

const SPAIN_HTTP_MODE = process.env.SPAIN_HTTP_MODE === "1";
const SPAIN_PERSISTENT_BROWSER = process.env.SPAIN_SESSION_MODE === "persistent-browser";

function modeLabel(): string {
  if (SPAIN_PERSISTENT_BROWSER) return "persistent-browser 🌐";
  if (SPAIN_HTTP_MODE) return "HTTP-ONLY 🚀";
  return "Playwright legacy 🎭";
}

async function ensureActiveSession(portalUrl: string) {
  return SPAIN_PERSISTENT_BROWSER
    ? ensureSpainPersistentBrowserSession(portalUrl)
    : ensureSpainCfSession(portalUrl);
}

function getActiveSession() {
  return SPAIN_PERSISTENT_BROWSER
    ? getActiveSpainPersistentBrowserSession()
    : getActiveSpainCfSession();
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface CliOptions {
  portalUrl: string;
  login?: string;
  password?: string;
  visaType: string;
  otpChannel: "email" | "sms" | "manual";
  applicantName: string;
  withLock: boolean;
  skipPrewarm: boolean;
}

function printHelp(): void {
  console.log(`
Spain Watcher — test E2E portail (1 cycle complet)

Usage:
  npx tsx src/scripts/test-spain-watcher-portal-e2e.ts <portalUrl> [options]

Arguments:
  portalUrl                 URL complète du widget Bookitit citaconsular.es

Options:
  --login EMAIL             Login Bookitit → active l'auto-booking
  --password PASS           Mot de passe Bookitit
  --visa-type TEXT          Type de visa pour matching service
  --otp-channel CHANNEL     email | sms | manual (défaut: email)
  --applicant-name NAME     Nom dans les logs (défaut: e2e-test)
  --with-lock               Acquérir le verrou Redis distribué
  --skip-prewarm            Sauter le pre-warm CF
  --help                    Afficher cette aide

Variables d'environnement (héritées du watcher) :
  SPAIN_HTTP_MODE=1                    Mode scan HTTP pur
  SPAIN_SESSION_MODE=persistent-browser  Chromium persistant + scan HTTP
  DECODO_PROXY_URL / SOAX_PROXY_URL    Proxy Espagne
  CAPSOLVER_API_KEY                    Mode HTTP-only (solve CF)
  REDIS_URL                            Persistance session (optionnel)
`);
}

function parseArgs(argv: string[]): CliOptions | null {
  const args = [...argv];
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    printHelp();
    return null;
  }

  const portalUrl = args.shift()!;
  if (!portalUrl.startsWith("http")) {
    console.error("❌ Le premier argument doit être une URL de portail (https://...)");
    return null;
  }

  const opts: CliOptions = {
    portalUrl: portalUrl.replace(/\/?#.*$/, "").replace(/\/?$/, "/"),
    visaType: "Visa C — Tourisme / Affaires",
    otpChannel: "email",
    applicantName: "e2e-test",
    withLock: false,
    skipPrewarm: false,
  };

  while (args.length > 0) {
    const flag = args.shift()!;
    switch (flag) {
      case "--login":
        opts.login = args.shift();
        break;
      case "--password":
        opts.password = args.shift();
        break;
      case "--visa-type":
        opts.visaType = args.shift() ?? opts.visaType;
        break;
      case "--otp-channel": {
        const ch = (args.shift() ?? "email") as CliOptions["otpChannel"];
        if (ch !== "email" && ch !== "sms" && ch !== "manual") {
          console.error(`❌ --otp-channel invalide: ${ch}`);
          return null;
        }
        opts.otpChannel = ch;
        break;
      }
      case "--applicant-name":
        opts.applicantName = args.shift() ?? opts.applicantName;
        break;
      case "--with-lock":
        opts.withLock = true;
        break;
      case "--skip-prewarm":
        opts.skipPrewarm = true;
        break;
      default:
        console.error(`❌ Option inconnue: ${flag}`);
        return null;
    }
  }

  const bookingRequested = Boolean(opts.login || opts.password);
  if (bookingRequested && (!opts.login || !opts.password)) {
    console.error("❌ Auto-booking: --login ET --password sont requis ensemble");
    return null;
  }

  if (bookingRequested && !SPAIN_HTTP_MODE && !SPAIN_PERSISTENT_BROWSER) {
    console.warn(
      "⚠️  Auto-booking HTTP ignoré en mode Playwright legacy — " +
      "utilisez SPAIN_HTTP_MODE=1 ou SPAIN_SESSION_MODE=persistent-browser",
    );
  }

  return opts;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

const T0 = Date.now();

function ts(): string {
  return `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
}

function log(level: "INFO" | "WARN" | "ERROR" | "OK" | "STEP", msg: string): void {
  const icon = { INFO: "ℹ️ ", WARN: "⚠️ ", ERROR: "❌", OK: "✅", STEP: "▶️ " }[level];
  console.log(`[${ts()}] ${icon} ${msg}`);
}

function section(title: string): void {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(72)}`);
}

// ─── Cycle watcher (1 itération) ─────────────────────────────────────────────

async function runWatcherCycle(opts: CliOptions): Promise<number> {
  const { portalUrl } = opts;
  const cycleLabel = SPAIN_PERSISTENT_BROWSER ? "PB" : SPAIN_HTTP_MODE ? "HTTP" : "PW";
  const bookingEnabled =
    Boolean(opts.login && opts.password) &&
    (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER);

  section(`SPAIN WATCHER E2E — ${new Date().toISOString()}`);
  log("INFO", `Portail     : ${portalUrl}`);
  log("INFO", `Mode        : ${modeLabel()}`);
  log("INFO", `Instance    : ${SPAIN_INSTANCE_ID}`);
  log("INFO", `Auto-booking: ${bookingEnabled ? `OUI (${opts.applicantName})` : "NON"}`);
  log("INFO", `Verrou Redis: ${opts.withLock ? "activé" : "désactivé (défaut E2E)"}`);

  // ── Étape 1 : Redis ───────────────────────────────────────────────────────
  if (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER) {
    section("ÉTAPE 1 — Init Redis");
    const redisOk = await initSpainRedis().catch((e) => {
      log("WARN", `Redis init échoué (non-fatal): ${e}`);
      return false;
    });
    if (redisOk) {
      log("OK", "Redis connecté — session CF persistée entre runs");
    } else {
      log("INFO", "Redis absent — session en mémoire uniquement");
    }

    if (SPAIN_HTTP_MODE && !SPAIN_PERSISTENT_BROWSER) {
      await restoreSpainSoaxStateFromRedis().catch((e) => {
        log("WARN", `Restauration SOAX rotation échouée (non-fatal): ${e}`);
      });
    }
  } else {
    log("INFO", "Étape Redis ignorée (mode Playwright legacy)");
  }

  // ── Étape 2 : Pre-warm session CF ─────────────────────────────────────────
  if (!opts.skipPrewarm && (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)) {
    section("ÉTAPE 2 — Pre-warm session CF (ensureActiveSession)");
    const t0 = Date.now();
    const session = await ensureActiveSession(portalUrl).catch((e) => {
      log("ERROR", `Pre-warm CF échoué: ${e}`);
      return null;
    });
    if (!session) {
      log("ERROR", "Impossible d'établir la session CF — arrêt");
      return 1;
    }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    log("OK", `Session CF prête en ${elapsed}s`);
    log("INFO", `  source       : ${session.source ?? "(n/a)"}`);
    log("INFO", `  expire       : ${new Date(session.expiresAt).toISOString()}`);
    log("INFO", `  cf_clearance : ${session.cfClearance?.slice(0, 24) ?? "(absent)"}…`);
    log("INFO", `  cookies      : ${session.allCookies?.length ?? 0}`);
    log("INFO", `  prefetch     : ${(session as { prefetchedMainHtml?: string }).prefetchedMainHtml?.length ?? 0}B`);
  } else if (opts.skipPrewarm) {
    section("ÉTAPE 2 — Pre-warm CF (ignoré — --skip-prewarm)");
    const existing = getActiveSession();
    if (!existing) {
      log("WARN", "Aucune session CF active — le probe tentera un solve");
    } else {
      log("OK", `Session existante réutilisée (expire ${new Date(existing.expiresAt).toISOString()})`);
    }
  } else {
    section("ÉTAPE 2 — Pre-warm CF (ignoré — mode Playwright legacy)");
  }

  // ── Étape 3 : Verrou distribué ────────────────────────────────────────────
  let lockHeld = false;
  if (opts.withLock && (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)) {
    section("ÉTAPE 3 — Verrou Redis distribué");
    lockHeld = await acquireSpainScannerLock();
    if (!lockHeld) {
      log("WARN", "Verrou détenu par une autre instance — arrêt (retirer --with-lock ou attendez)");
      return 2;
    }
    log("OK", "Verrou acquis");
  } else {
    log("INFO", "Étape verrou ignorée (défaut E2E sans --with-lock)");
  }

  try {
    // ── Étape 4 : Probe ─────────────────────────────────────────────────────
    section(`ÉTAPE 4 — Probe [${cycleLabel}]`);
    log("STEP", `runSpain${SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER ? "Http" : "Watcher"}Probe → ${portalUrl}`);

    const probeT0 = Date.now();
    const result =
      SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER
        ? await runSpainHttpProbe(portalUrl)
        : await runSpainWatcherProbe(portalUrl);
    const probeMs = Date.now() - probeT0;

    log("INFO", `Durée probe : ${Math.round(probeMs / 1000)}s`);
    log("INFO", `Statut      : ${result.status}`);
    if (result.slotInfo) log("INFO", `Slot info   : ${result.slotInfo}`);
    if (result.errorMessage) log("WARN", `Erreur      : ${result.errorMessage}`);
    if (result.screenshotBase64) {
      log("INFO", `Screenshot  : ${Math.round(result.screenshotBase64.length / 1024)}KB base64`);
    }

    const mainHtml = (result as { _mainHtml?: string })._mainHtml;

    // ── Étape 5 : Diagnostic + exploration (comme le watcher) ───────────────
    if (
      result.status === "found" &&
      mainHtml &&
      (SPAIN_HTTP_MODE || SPAIN_PERSISTENT_BROWSER)
    ) {
      section("ÉTAPE 5 — Diagnostic services + exploration créneaux");

      const services = extractServicesFromHtml(mainHtml);
      if (services.length === 0) {
        log("WARN", "FAUX POSITIF PROBABLE — found mais 0 service #selectservice dans le HTML");
        const preview = mainHtml
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        log("INFO", `  HTML preview: ${preview}`);
      } else {
        log("OK", `${services.length} service(s) rendu(s) dans le HTML :`);
        for (const svc of services) {
          log("INFO", `  🎯 "${svc.serviceName}" → ${svc.serviceId}`);
        }

        const cfSession = getActiveSession();
        if (!cfSession) {
          log("WARN", "Pas de session CF active — exploration slots ignorée");
        } else {
          log("STEP", "exploreAvailableSlots()…");
          const exploreT0 = Date.now();
          const exploration = await exploreAvailableSlots(cfSession, portalUrl, services).catch(
            (e) => {
              log("WARN", `Exploration échouée (non-fatal): ${e}`);
              return null;
            },
          );
          if (exploration) {
            log("OK", `Exploration terminée en ${exploration.explorationDurationMs}ms — ${exploration.totalSlots} créneau(x)`);
            for (const line of formatExplorationForLogs(exploration)) {
              log("INFO", line.replace(/^\[spain-explore\]\s*/, ""));
            }
          }
        }
      }

      // ── Étape 6 : Auto-booking optionnel ──────────────────────────────────
      if (bookingEnabled) {
        section("ÉTAPE 6 — Auto-booking HTTP (optionnel)");

        const cfSession = getActiveSession();
        if (!cfSession) {
          log("ERROR", "Booking impossible — pas de session CF active");
        } else if (services.length === 0) {
          log("ERROR", "Booking impossible — aucun service extrait du HTML");
        } else {
          const matched = matchServiceForVisa(services, opts.visaType!);
          if (!matched) {
            log("ERROR", `Aucun service ne matche "${opts.visaType}" — services: ${services.map((s) => s.serviceName).join(", ")}`);
          } else {
            log("OK", `Service matché: "${matched.serviceName}" (${matched.serviceId})`);

            const bookingConfig: SpainBookingConfig = {
              login: opts.login!,
              password: opts.password!,
              applicantName: opts.applicantName,
              otpChannel: opts.otpChannel,
              targetServiceId: matched.serviceId,
              visaType: opts.visaType,
            };

            log("STEP", `executeHttpBooking() pour ${opts.applicantName}…`);
            const bookT0 = Date.now();
            const bookingResult = await executeHttpBooking(
              cfSession,
              portalUrl,
              mainHtml,
              bookingConfig,
            );
            const bookMs = Date.now() - bookT0;

            log("INFO", `Durée booking : ${Math.round(bookMs / 1000)}s`);
            log("INFO", `Statut booking: ${bookingResult.status}`);
            if (bookingResult.locator) log("OK", `Locator       : ${bookingResult.locator}`);
            if (bookingResult.errorMessage) log("WARN", `Erreur booking: ${bookingResult.errorMessage}`);
            if (bookingResult.confirmationPdf) {
              log("OK", `PDF confirmation: ${bookingResult.confirmationPdf.length} bytes`);
            }
          }
        }
      } else {
        log("INFO", "Étape booking ignorée (pas de --login/--password)");
      }
    } else if (result.status === "found" && !mainHtml) {
      log("INFO", "Créneau détecté (mode Playwright) — pas de _mainHtml, booking HTTP non applicable");
    } else if (result.status === "not_found") {
      section("ÉTAPE 5 — Résultat");
      log("OK", "Aucun créneau disponible (not_found) — le watcher fonctionne correctement");
    } else {
      section("ÉTAPE 5 — Résultat");
      log("ERROR", `Probe terminée en erreur: ${result.errorMessage ?? result.status}`);
    }

    // ── Résumé ──────────────────────────────────────────────────────────────
    section("RÉSUMÉ");
    log("INFO", `Mode    : ${modeLabel()}`);
    log("INFO", `Statut  : ${result.status}`);
    log("INFO", `Durée   : ${((Date.now() - T0) / 1000).toFixed(1)}s`);

    if (result.status === "error") return 1;
    return 0;
  } finally {
    if (lockHeld) {
      await releaseSpainScannerLock();
      log("INFO", "Verrou Redis libéré");
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    process.exit(process.argv.slice(2).some((a) => a === "--help" || a === "-h") ? 0 : 1);
    return;
  }

  const code = await runWatcherCycle(opts);
  process.exit(code);
}

main().catch((err) => {
  console.error("\n❌ Exception non gérée:", err);
  process.exit(1);
});
