/**
 * test-overview-probe.ts — Sonde la page Overview CEV pour VOWINT6323902
 *
 * OBJECTIF :
 *   Reproduire le flux complet pour un dossier dont un autre dossier du même
 *   type passeport a déjà un RDV → page /Integration/VOW/Overview.
 *   Dump le HTML brut + extrait le lien "Nouveau rendez-vous" (Cas 1) ou
 *   détecte la limite atteinte (Cas 2).
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   CEV_TEST_VOWINT_REF="VOWINT6323902" npx tsx scripts/test-overview-probe.ts
 *
 *   # Avec compte différent de CEV_EMAIL :
 *   CEV_PROBE_EMAIL="autre@mail.com" \
 *   CEV_PROBE_PASSWORD="motdepasse" \
 *   CEV_TEST_VOWINT_REF="VOWINT6323902" \
 *   npx tsx scripts/test-overview-probe.ts
 *
 * VARIABLES :
 *   CEV_TEST_VOWINT_REF   Référence dossier (obligatoire, défaut: VOWINT6323902)
 *   CEV_PROBE_EMAIL       Email compte VOWINT (défaut: CEV_EMAIL)
 *   CEV_PROBE_PASSWORD    Mot de passe (défaut: CEV_PASSWORD)
 *   ANTICAPTCHA_API_KEY   Clé Anti-Captcha (au moins une requise)
 *   CAPSOLVER_API_KEY     Alternative à Anti-Captcha
 *   TWOCAPTCHA_API_KEY    Alternative
 *   DECODO_PROXY_URL      Proxy (recommandé — diplo.be bloque les IPs hors Belgique)
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { setupCevSessionHttp } from "../src/cevHttpSetup.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const VOWINT_REF = process.env.CEV_TEST_VOWINT_REF ?? "VOWINT6323902";
const EMAIL      = process.env.CEV_PROBE_EMAIL    ?? process.env.CEV_EMAIL    ?? "";
const PASSWORD   = process.env.CEV_PROBE_PASSWORD ?? process.env.CEV_PASSWORD ?? "";
const CLIENT_ID  = `overview-probe-${VOWINT_REF}-${Date.now()}`;

// ─── Couleurs terminal ────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const RE = "\x1b[31m";
const D = "\x1b[2m";

const ok   = (m: string) => console.log(`${G}  ✅ ${m}${R}`);
const warn = (m: string) => console.log(`${Y}  ⚠️  ${m}${R}`);
const err  = (m: string) => console.log(`${RE}  ❌ ${m}${R}`);
const info = (m: string) => console.log(`${C}  ℹ️  ${m}${R}`);
const dim  = (m: string) => console.log(`${D}     ${m}${R}`);

function section(t: string) {
  console.log(`\n${B}${"═".repeat(65)}${R}`);
  console.log(`${B}  ${t}${R}`);
  console.log(`${B}${"═".repeat(65)}${R}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  section(`🔬 CEV Overview Probe — ${VOWINT_REF}`);

  if (!EMAIL || !PASSWORD) {
    err("CEV_EMAIL / CEV_PASSWORD manquants (ou CEV_PROBE_EMAIL / CEV_PROBE_PASSWORD)");
    process.exit(1);
  }
  const hasCaptcha = !!(process.env.ANTICAPTCHA_API_KEY || process.env.CAPSOLVER_API_KEY || process.env.TWOCAPTCHA_API_KEY);
  if (!hasCaptcha) {
    err("Aucune clé captcha — ANTICAPTCHA_API_KEY / CAPSOLVER_API_KEY / TWOCAPTCHA_API_KEY requis");
    process.exit(1);
  }

  info(`Compte  : ${EMAIL.slice(0, 30)}...`);
  info(`Dossier : ${VOWINT_REF}`);
  info(`Client  : ${CLIENT_ID}`);

  const t0 = Date.now();

  section("📡 Setup session CEV (login + captcha + redirects)");
  info("Lancement setupCevSessionHttp()...");

  const result = await setupCevSessionHttp(
    EMAIL,
    PASSWORD,
    CLIENT_ID,
    CLIENT_ID,
    VOWINT_REF,
  );

  const elapsed = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  section(`📊 Résultat (${elapsed})`);

  if (!result.success) {
    err(`Setup échoué : ${result.error}`);

    if (result.error?.includes("RATE_LIMIT")) {
      warn("→ Limite 5 clics/heure atteinte — attendre 60+ min");
    } else if (result.error === "NO_INTEGRATION_URL") {
      warn("→ GetEAppointmentUrl vide — vérifier que le dossier est actif");
    } else if (result.error === "HCAPTCHA_FAILED") {
      warn("→ Résolution captcha échouée");
    } else if (result.error === "MULTI_SESSION_NOT_ALLOWED") {
      warn("→ URL d'intégration déjà utilisée dans une autre session (~30 min)");
    }
    process.exit(1);
  }

  ok(`Setup réussi en ${elapsed}`);
  dim(`sessionCookie    : ${result.sessionCookie?.slice(0, 25)}...`);
  dim(`integrationUrl   : ${result.integrationUrl?.slice(0, 80)}...`);
  dim(`validUntilMs     : ${result.validUntilMs ? new Date(result.validUntilMs).toISOString() : "(non défini)"}`);
  dim(`slotsAvailable   : ${result.slotsAvailable}`);
  dim(`overviewState    : ${result.overviewState ?? "(non Overview)"}`);

  // ── Analyse du verdict ──────────────────────────────────────────────────────

  if (result.overviewState === 'new_appointment_available') {
    console.log(`\n${G}${B}  ✅ CAS 1 CONFIRMÉ — "Nouveau rendez-vous" détecté et suivi !${R}`);
    ok("Le lien 'Nouveau rendez-vous' a été extrait depuis la page Overview");

    if (result.slotsAvailable) {
      console.log(`\n${G}${B}  🎯 CRÉNEAUX DISPONIBLES ! SelectSlot atteint.${R}`);
      ok(`selectSlotUrl : ${result.selectSlotUrl?.slice(0, 100)}`);
      if (result.selectSlotHtml) {
        ok(`selectSlotHtml : ${result.selectSlotHtml.length} chars reçus`);
        // Sauvegarder pour analyse
        const dumpFile = path.join(process.cwd(), `overview-probe-selectslot-${VOWINT_REF}.html`);
        fs.writeFileSync(dumpFile, result.selectSlotHtml);
        ok(`HTML sauvegardé → ${dumpFile}`);
      }
    } else {
      warn("Lien suivi → NoAvailability (aucun créneau pour ce dossier pour l'instant)");
      info("→ Le flux fonctionne — il n'y a juste pas de créneau disponible actuellement");
    }

  } else if (result.overviewState === 'limit_reached') {
    console.log(`\n${Y}${B}  ⚠️  CAS 2 — Limite de RDV atteinte pour ce dossier${R}`);
    warn("Aucun lien 'Nouveau rendez-vous' détecté → seul 'Annuler' disponible");
    warn("→ Ce dossier a déjà atteint le nombre maximum de rendez-vous autorisés");
    info("→ Pour débloquer : annuler le RDV existant (non encore implémenté)");

  } else if (result.slotsAvailable) {
    console.log(`\n${G}${B}  🎯 CRÉNEAUX DISPONIBLES (pas de page Overview — accès direct SelectSlot)${R}`);
    ok(`selectSlotUrl : ${result.selectSlotUrl?.slice(0, 100)}`);

  } else {
    warn("Pas de créneaux (NoAvailability) — le flux ne passe pas par Overview pour ce dossier");
    info("→ Pour tester l'Overview, utiliser un dossier dont un autre dossier du même passeport a déjà un RDV");
  }

  // ── Instructions botLog ─────────────────────────────────────────────────────
  section("📋 Logs Convex (analyse HTML Overview)");
  info(`Client ID pour filtrer les botLogs : ${CLIENT_ID}`);
  info("→ Chercher les steps:");
  dim("  • cev_http_verdict_overview_detected  — HTML brut de la page Overview");
  dim("  • cev_http_overview_new_appointment_follow — href extrait");
  dim("  • cev_http_overview_new_rdv_chain     — résultat du suivi");
  dim("  • cev_http_overview_limit_reached     — Cas 2 détecté");
  console.log();
}

main().catch(e => {
  console.error(`\n${RE}ERREUR FATALE:${R}`, e);
  process.exit(1);
});
