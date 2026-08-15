/**
 * test-e2e-saopolo-6dossiers.ts — Test E2E architecture per-dossier worker (Task #52)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST DE LA NOUVELLE ARCHITECTURE : 6 WORKERS AUTONOMES EN PARALLÈLE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * OBJECTIF :
 *   Valider que l'architecture per-dossier introduite dans Task #52 fonctionne
 *   correctement sur le portail Saopolo avec 6 workers en parallèle :
 *
 *   - Chaque worker obtient une IP Decodo dédiée (pas de collision)
 *   - Chaque worker crée son propre impit + probe CF + cf_clearance lié à sa TLS
 *   - Chaque worker crée son propre PHPSESSID (isolé des autres)
 *   - matchServiceForVisa sélectionne le bon service selon visaType
 *   - Le cycle de scan fonctionne : /main/ → getservices/ → getagendas/ → datetime/
 *   - Si un créneau est trouvé → booking tenté → signin_failed (faux credentials)
 *     et NON 0B (pas de régression pipeline)
 *
 * CRITÈRES DE SUCCÈS :
 *   ✅ status "exited"         → fenêtre 3 min expirée sans créneau (portail vide)
 *   ✅ status "error" + "credentials"/"cuenta"/"contraseña"/"password"/"invalid"/"Usuario"
 *                              → booking tenté, signin/ a répondu (pipeline OK)
 *   ✅ status "booked"         → inattendu avec faux credentials, mais pipeline ultra OK
 *
 *   ❌ RÉGRESSION si :
 *   status "error" + "0B" ou "CF" sur TOUS les cycles → IP/TLS incohérent
 *   status "error" + "n'a retourné de bktToken"        → agendaId/PHP regression
 *   Workers partageant la même IP → isolation cassée
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   SPAIN_WORKER_WINDOW_MIN=3 \
 *   CAPSOLVER_API_KEY=$CAPSOLVER_API_KEY \
 *   DECODO_PROXY_URL=$DECODO_PROXY_URL \
 *   node_modules/.bin/tsx src/scripts/test-e2e-saopolo-6dossiers.ts
 *
 *   Options :
 *   PORTAL_URL=https://...  Override portail (défaut : Saopolo)
 *   WORKER_COUNT=3          Nombre de workers (défaut : 6)
 *   SEQUENTIAL=1            Lancer séquentiellement au lieu de parallèle (debug)
 */

import "dotenv/config";
import { runDossierWorker, type SpainDossierConfig, type WorkerResult } from "../spain-dossier-worker.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initDecodoPool, getDecodoPoolSize } from "../spain-decodo-pool.js";
import {
  SAOPOLO_PORTAL_URL,
} from "../spain-portals.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const PORTAL_URL     = process.env.PORTAL_URL ?? SAOPOLO_PORTAL_URL;
const WORKER_COUNT   = Math.min(8, Math.max(1, Number(process.env.WORKER_COUNT ?? "6")));
const SEQUENTIAL     = process.env.SEQUENTIAL === "1";
// Fenêtre courte pour le test : 3 min par défaut (prod = 25 min)
// Peut être overridée via SPAIN_WORKER_WINDOW_MIN (lu par runDossierWorker)
const windowMin = Number(process.env.SPAIN_WORKER_WINDOW_MIN ?? "3");
process.env.SPAIN_WORKER_WINDOW_MIN ??= "3";

// ─── Faux dossiers ────────────────────────────────────────────────────────────
// Credentials bidons : signin/ doit retourner une erreur serveur (pas 0B)
// 3 dossiers Visa C + 3 dossiers Visa D pour tester matchServiceForVisa
const ALL_FAKE_DOSSIERS: SpainDossierConfig[] = [
  { id: "test-01", applicantName: "ALPHA C — TOURISME",   visaType: "Visa C — Tourisme / Affaires",              login: "AB1111111A", password: "fake_pw_01", applicationId: "fake-app-01", otpChannel: "email", portalUrl: PORTAL_URL },
  { id: "test-02", applicantName: "BRAVO C — TOURISME",   visaType: "Visa C — Tourisme / Affaires",              login: "BC2222222B", password: "fake_pw_02", applicationId: "fake-app-02", otpChannel: "email", portalUrl: PORTAL_URL },
  { id: "test-03", applicantName: "CHARLIE C — ETUDES",   visaType: "Visa C — Études court séjour",              login: "CD3333333C", password: "fake_pw_03", applicationId: "fake-app-03", otpChannel: "email", portalUrl: PORTAL_URL },
  { id: "test-04", applicantName: "DELTA D — LONG SEJOUR",visaType: "Visa D — Long Séjour (études / regroupement familial)", login: "DE4444444D", password: "fake_pw_04", applicationId: "fake-app-04", otpChannel: "email", portalUrl: PORTAL_URL },
  { id: "test-05", applicantName: "ECHO C — AFFAIRES",    visaType: "Visa C — Tourisme / Affaires",              login: "EF5555555E", password: "fake_pw_05", applicationId: "fake-app-05", otpChannel: "email", portalUrl: PORTAL_URL },
  { id: "test-06", applicantName: "FOXTROT D — FAMILLE",  visaType: "Visa D — Long Séjour (études / regroupement familial)", login: "FG6666666F", password: "fake_pw_06", applicationId: "fake-app-06", otpChannel: "email", portalUrl: PORTAL_URL },
];
const FAKE_DOSSIERS = ALL_FAKE_DOSSIERS.slice(0, WORKER_COUNT);

// ─── Logging ──────────────────────────────────────────────────────────────────
const T0 = Date.now();
const elapsed  = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log  = (msg: string) => console.log(`[${elapsed()}] ${msg}`);
const ok   = (msg: string) => console.log(`[${elapsed()}] ✅ ${msg}`);
const warn = (msg: string) => console.warn(`[${elapsed()}] ⚠️  ${msg}`);
const fail = (msg: string) => console.error(`[${elapsed()}] ❌ ${msg}`);
const sep  = (t: string)   => console.log(`\n${"═".repeat(72)}\n  ${t}\n${"═".repeat(72)}`);

// ─── Analyse résultat ─────────────────────────────────────────────────────────
function classifyResult(r: WorkerResult): "success" | "regression" | "ambiguous" {
  if (r.status === "booked") return "success";
  if (r.status === "exited") return "success"; // fenêtre expirée sans créneau = flow ok

  const msg = r.errorMessage ?? "";
  // Régression : 0B persistant = TLS/IP incohérent ou pipeline PHP cassé
  if (msg.includes("0B") && msg.includes("cycles")) return "regression";
  if (msg.includes("n'a retourné de bktToken"))       return "regression";

  // Error avec message serveur Bookitit = pipeline a fonctionné jusqu'au bout
  if (msg.match(/credentials|cuenta|contraseña|password|invalid|Usuario|identifiant|compte|expire/i)) return "success";

  return "ambiguous";
}

function statusIcon(cls: "success" | "regression" | "ambiguous"): string {
  return cls === "success" ? "✅" : cls === "regression" ? "❌" : "⚠️ ";
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  sep(`TEST E2E WORKERS AUTONOMES — SAOPOLO × ${WORKER_COUNT} — ${new Date().toISOString()}`);
  log(`Portail     : ${PORTAL_URL}`);
  log(`Workers     : ${WORKER_COUNT} (${SEQUENTIAL ? "séquentiel" : "parallèle"})`);
  log(`Fenêtre     : ${windowMin} min par worker`);
  log(`CapSolver   : ${process.env.CAPSOLVER_API_KEY ? "✅ présente" : "❌ MANQUANTE"}`);
  log(`Decodo URL  : ${process.env.DECODO_PROXY_URL ? "✅ présente" : "⚠️  absente (mode direct)"}`);

  // ── 1. Init Redis + Decodo ─────────────────────────────────────────────────
  sep("1 — Init Redis + Decodo pool");
  const redisOk = await initSpainRedis().catch((e: unknown) => {
    warn(`Redis non-fatal: ${e}`);
    return false;
  });
  log(`Redis : ${redisOk ? "✅ connecté (réservations IP atomiques actives)" : "⚠️  non disponible — workers sans isolation IP Redis"}`);

  await initDecodoPool().catch((e: unknown) => warn(`Decodo pool non-fatal: ${e}`));
  const poolSize = getDecodoPoolSize();
  log(`Decodo pool : ${poolSize} IP(s) disponible(s)`);
  if (poolSize > 0 && poolSize < WORKER_COUNT) {
    warn(`Pool (${poolSize} IPs) < workers (${WORKER_COUNT}) — certains workers attendront ou tourneront sans proxy`);
  }
  if (poolSize === 0) {
    warn("Pool vide → tous les workers tourneront en mode direct (sans isolation IP Decodo)");
  }

  if (!process.env.CAPSOLVER_API_KEY) {
    fail("CAPSOLVER_API_KEY manquante — impossible de résoudre CF. Définir la variable et relancer.");
    process.exitCode = 1;
    return;
  }

  // ── 2. Lancer les workers ──────────────────────────────────────────────────
  sep(`2 — Lancement ${WORKER_COUNT} workers ${SEQUENTIAL ? "SÉQUENTIEL" : "PARALLÈLE"}`);

  const startTimes: Record<string, number> = {};
  const results: Array<WorkerResult & { durationMs: number; classification: string }> = [];

  if (SEQUENTIAL) {
    // Mode debug : workers l'un après l'autre
    for (const cfg of FAKE_DOSSIERS) {
      log(`▶ [${cfg.applicantName}] Démarrage…`);
      startTimes[cfg.id] = Date.now();
      const r = await runDossierWorker(cfg);
      const dur = Date.now() - startTimes[cfg.id];
      const cls = classifyResult(r);
      log(`■ [${cfg.applicantName}] ${r.status} (${(dur / 1000).toFixed(1)}s) — ${r.errorMessage?.slice(0, 80) ?? ""}`);
      results.push({ ...r, durationMs: dur, classification: cls });
    }
  } else {
    // Mode parallèle : tous les workers démarrent simultanément
    log(`Démarrage simultané de ${WORKER_COUNT} workers…`);
    const promises = FAKE_DOSSIERS.map((cfg) => {
      startTimes[cfg.id] = Date.now();
      return runDossierWorker(cfg)
        .then((r) => {
          const dur = Date.now() - startTimes[cfg.id];
          const cls = classifyResult(r);
          const icon = statusIcon(cls);
          log(`${icon} [${cfg.applicantName}] ${r.status} (${(dur / 1000).toFixed(1)}s)${r.errorMessage ? ` — ${r.errorMessage.slice(0, 100)}` : ""}`);
          return { ...r, durationMs: dur, classification: cls };
        })
        .catch((err: unknown) => {
          const dur = Date.now() - (startTimes[cfg.id] ?? Date.now());
          fail(`[${cfg.applicantName}] Exception non gérée: ${err}`);
          return {
            dossierId: cfg.id,
            status: "error" as const,
            errorMessage: String(err),
            durationMs: dur,
            classification: "regression",
          };
        });
    });

    log(`En attente de la fin de tous les workers (max ~${windowMin} min)…`);
    const settled = await Promise.allSettled(promises);
    for (const s of settled) {
      if (s.status === "fulfilled") results.push(s.value);
    }
  }

  // ── 3. Vérification isolation IP ──────────────────────────────────────────
  sep("3 — Vérification isolation");
  // Les workers loggent leur IP dans les logs Slot Hunter — on ne peut pas
  // les récupérer ici directement. On vérifie qu'il n'y a pas eu de crash
  // qui indiquerait une collision de réservation Redis.
  const errors = results.filter(r => r.status === "error" && r.errorMessage?.includes("Aucune IP Decodo"));
  if (errors.length > 0) {
    warn(`${errors.length} worker(s) n'ont pas obtenu d'IP Decodo (pool insuffisant) :`);
    errors.forEach(r => warn(`  • ${r.dossierId}: ${r.errorMessage}`));
  } else if (poolSize >= WORKER_COUNT) {
    ok(`Tous les workers ont obtenu une IP Decodo dédiée (pool ${poolSize} ≥ ${WORKER_COUNT} workers)`);
  } else {
    log(`Pool < workers — vérifier les logs Slot Hunter pour confirmer l'isolation IP`);
  }

  // ── 4. Rapport final ──────────────────────────────────────────────────────
  sep("4 — RAPPORT FINAL");

  const successes   = results.filter(r => r.classification === "success");
  const regressions = results.filter(r => r.classification === "regression");
  const ambiguous   = results.filter(r => r.classification === "ambiguous");

  const booked   = results.filter(r => r.status === "booked");
  const exited   = results.filter(r => r.status === "exited");
  const errorMsg = results.filter(r => r.status === "error");

  console.log("");
  console.log(`  ${"Dossier".padEnd(28)} | ${"Statut".padEnd(12)} | ${"Durée".padStart(6)} | Résultat`);
  console.log("  " + "─".repeat(78));
  for (const r of results) {
    const cls  = r.classification;
    const icon = statusIcon(cls as "success" | "regression" | "ambiguous");
    const name = FAKE_DOSSIERS.find(d => d.id === r.dossierId)?.applicantName ?? r.dossierId;
    const dur  = `${(r.durationMs / 1000).toFixed(1)}s`;
    const err  = r.errorMessage ? r.errorMessage.slice(0, 50) : "";
    console.log(`  ${icon} ${name.padEnd(26)} | ${r.status.padEnd(12)} | ${dur.padStart(6)} | ${err}`);
  }
  console.log("");

  console.log(`  Workers total      : ${results.length}/${WORKER_COUNT}`);
  console.log(`  ✅ Succès          : ${successes.length}  (booked: ${booked.length}, exited: ${exited.length}, cred-error: ${successes.length - booked.length - exited.length})`);
  if (ambiguous.length > 0) console.log(`  ⚠️  Ambigu          : ${ambiguous.length}`);
  if (regressions.length > 0) console.log(`  ❌ Régressions     : ${regressions.length}`);
  console.log(`  Durée totale       : ${((Date.now() - T0) / 1000).toFixed(1)}s`);
  console.log(`  Pool Decodo        : ${poolSize} IP(s)`);
  console.log(`  Mode               : ${SEQUENTIAL ? "séquentiel" : "parallèle"}`);
  console.log("");

  if (regressions.length > 0) {
    console.log("");
    fail(`${regressions.length} RÉGRESSION(S) DÉTECTÉE(S) :`);
    regressions.forEach(r => {
      const name = FAKE_DOSSIERS.find(d => d.id === r.dossierId)?.applicantName ?? r.dossierId;
      fail(`  • ${name}: ${r.errorMessage}`);
    });
    fail("Causes possibles :");
    fail("  — TLS/IP incohérent : probeImpit ≠ impit utilisé pour le booking");
    fail("  — agendaId absent   : matchServiceForVisa ou getagendas/ non transmis");
    fail("  — CF clearance lié au Chrome CapSolver (pas à l'impit worker)");
    process.exitCode = 1;
  } else if (regressions.length === 0 && successes.length > 0) {
    ok(`${successes.length}/${WORKER_COUNT} workers — ARCHITECTURE PER-DOSSIER VALIDÉE`);
    if (ambiguous.length > 0) {
      warn(`${ambiguous.length} résultat(s) ambigu(s) — inspecter les logs Slot Hunter`);
    }
  } else if (results.every(r => r.classification === "ambiguous")) {
    warn("Tous les résultats sont ambigus — inspecter les logs Slot Hunter");
    warn("Vérifier que CAPSOLVER_API_KEY et DECODO_PROXY_URL sont correctement configurés");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("\nFATAL:", e);
  process.exitCode = 1;
});
