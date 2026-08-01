/**
 * ─── Diagnostic réseau Germany RK-Termin ────────────────────────────────────
 *
 * Reproduit et valide le correctif de l'incident « initSession failed:
 * fetch failed (cause: ConnectTimeoutError) » observé en production.
 *
 * Usage :
 *   pnpm --filter @workspace/slot-hunter run germany:diag
 *   GERMANY_PROXY_URL=http://user:pass@host:port pnpm ... run germany:diag
 *
 * Le script :
 *   1. Vérifie la classification des erreurs (transitoire vs métier)
 *   2. Résout le DNS de service2.diplo.de (détection IPv6 injoignable)
 *   3. Mesure le temps d'établissement de connexion TCP/TLS
 *   4. Exécute un vrai initSession() et affiche le résultat
 */
import { lookup } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import {
  initSession,
  isConnectionError,
  isTransientNetworkError,
  describeNetworkError,
} from "../src/germanyPortal/rktermin-session.js";
import { RKTERMIN_TIMING } from "../src/germanyPortal/config.js";
import type { RKTerminConfig } from "../src/germanyPortal/types.js";

const HOST = "service2.diplo.de";

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "✅" : "❌"} ${label} → ${String(actual)}${ok ? "" : ` (attendu: ${String(expected)})`}`);
}

function sep(title: string): void {
  console.log(`\n─── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
}

// ─── 1. Classification des erreurs ──────────────────────────────────────────

function testErrorClassification(): void {
  sep("1. Classification des erreurs");

  // Erreur réelle observée en production (undici)
  const connectTimeout = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Connect Timeout Error (attempted addresses: 139.12.255.252:443, timeout: 10000ms)"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
      name: "ConnectTimeoutError",
    }),
  });

  check("ConnectTimeoutError = erreur de connexion", isConnectionError(connectTimeout), true);
  check("ConnectTimeoutError = transitoire", isTransientNetworkError(connectTimeout), true);
  check(
    "Message propagé par initSession = transitoire",
    isTransientNetworkError("initSession failed: fetch failed (cause: ConnectTimeoutError: Connect Timeout Error)"),
    true,
  );
  check("ECONNRESET = transitoire", isTransientNetworkError(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), true);
  check("HeadersTimeout = transitoire", isTransientNetworkError(Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })), true);
  check("HeadersTimeout ≠ erreur de connexion", isConnectionError(Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })), false);

  // Erreurs « métier » : elles DOIVENT rester comptabilisées pour l'auto-pause
  check("Captcha non trouvé ≠ transitoire", isTransientNetworkError("Captcha non trouvé"), false);
  check("Config invalide ≠ transitoire", isTransientNetworkError("Configuration RK-Termin incomplète"), false);
  check("Email invalide ≠ transitoire", isTransientNetworkError("Please enter a valid E-Mail Adress"), false);

  // Robustesse
  check("undefined ≠ transitoire", isTransientNetworkError(undefined), false);
  const cyclic: { message: string; cause?: unknown } = { message: "boom" };
  cyclic.cause = cyclic; // référence circulaire → ne doit pas boucler à l'infini
  check("cause circulaire gérée", isTransientNetworkError(cyclic), false);
}

// ─── 2. Résolution DNS ──────────────────────────────────────────────────────

async function testDns(): Promise<string | null> {
  sep("2. Résolution DNS");
  try {
    const addresses = await lookup(HOST, { all: true });
    for (const a of addresses) {
      console.log(`  • IPv${a.family} ${a.address}`);
    }
    const v6 = addresses.filter(a => a.family === 6);
    if (v6.length > 0) {
      console.log("  ⚠️  Adresse IPv6 présente — autoSelectFamily évite d'attendre le timeout si la route v6 est morte");
    }
    return addresses[0]?.address ?? null;
  } catch (err) {
    failures++;
    console.log(`  ❌ DNS KO: ${describeNetworkError(err)}`);
    return null;
  }
}

// ─── 3. Handshake TCP/TLS ───────────────────────────────────────────────────

async function testTlsHandshake(): Promise<void> {
  sep("3. Handshake TCP/TLS (mesure du temps de connexion)");
  const started = Date.now();

  await new Promise<void>(resolve => {
    const socket = tlsConnect(
      { host: HOST, port: 443, servername: HOST, timeout: RKTERMIN_TIMING.connectTimeoutMs },
      () => {
        const ms = Date.now() - started;
        const overDefault = ms > 10_000;
        console.log(`  ${overDefault ? "⚠️ " : "✅"} Connexion établie en ${ms}ms${overDefault ? " — au-delà des 10s du dispatcher undici par défaut !" : ""}`);
        socket.destroy();
        resolve();
      },
    );
    socket.on("timeout", () => {
      console.log(`  ❌ Timeout après ${Date.now() - started}ms (connectTimeout=${RKTERMIN_TIMING.connectTimeoutMs}ms)`);
      socket.destroy();
      resolve();
    });
    socket.on("error", err => {
      console.log(`  ❌ ${describeNetworkError(err)} (après ${Date.now() - started}ms)`);
      resolve();
    });
  });
}

// ─── 4. initSession réel ────────────────────────────────────────────────────

async function testInitSession(): Promise<void> {
  sep("4. initSession() réel (avec retry + backoff)");

  const config: RKTerminConfig = {
    locationCode: "kins",
    realmId: 731,
    categoryId: 3672, // Studium — celui du dossier en incident
    locale: "en",
    applicantLastname: "",
    applicantFirstname: "",
    applicantEmail: "",
    dynamicFields: [],
  };

  const started = Date.now();
  try {
    const { session, html } = await initSession(config);
    console.log(`  ✅ Session obtenue en ${Date.now() - started}ms — JSESSIONID=${session.jsessionId.slice(0, 8)}… KEKS=${session.keks} (${html.length} chars)`);
  } catch (err) {
    const transient = isTransientNetworkError(err);
    console.log(`  ${transient ? "⚠️ " : "❌"} Échec après ${Date.now() - started}ms: ${describeNetworkError(err)}`);
    console.log(`     → classée ${transient ? "TRANSITOIRE (cooldown, dossier conservé actif)" : "MÉTIER (comptabilisée pour l'auto-pause)"}`);
    if (!transient) failures++;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══ Diagnostic réseau Germany RK-Termin ═══");
  console.log(`  connectTimeout : ${RKTERMIN_TIMING.connectTimeoutMs}ms`);
  console.log(`  requestTimeout : ${RKTERMIN_TIMING.requestTimeoutMs}ms`);
  console.log(`  retry          : ${RKTERMIN_TIMING.networkRetry.maxAttempts} tentatives (base ${RKTERMIN_TIMING.networkRetry.baseDelayMs}ms)`);
  console.log(`  proxy          : ${process.env.GERMANY_PROXY_URL ?? process.env.RKTERMIN_PROXY_URL ? "configuré" : "aucun (accès direct)"}`);

  testErrorClassification();
  await testDns();
  await testTlsHandshake();
  await testInitSession();

  sep("Résultat");
  if (failures === 0) {
    console.log("  ✅ Tous les contrôles sont passés");
  } else {
    console.log(`  ❌ ${failures} contrôle(s) en échec`);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error("Diagnostic crashé:", err);
  process.exitCode = 1;
});
