/**
 * test-e2e-saopolo-6dossiers.ts
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST D'INTÉGRATION E2E — PIPELINE RÉEL WATCHER + BOOKING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * POURQUOI CE TEST EXISTE :
 *   Le watcher réel (spain-watcher-loop.ts) tourne dans un process isolé et
 *   lit ses dossiers depuis Convex. Chaque fois qu'une régression a brisé le
 *   pipeline (agendaId non transmis, getagendas/ consommé, getsigninfields/ 0B,
 *   signin/ 0B…), on ne l'a découvert qu'en prod — après avoir raté des créneaux.
 *
 *   Ce script exécute les VRAIES fonctions (runSpainHttpProbe + executeHttpBooking)
 *   dans les MÊMES conditions que la prod (mode capsolver-residential, PHPSESSID
 *   partagé, getagendas/ consommé une seule fois) avec 6 faux dossiers, sans
 *   réécrire la moindre ligne de logique métier.
 *
 * FLOW RÉPLIQUÉ (identique à spain-watcher-loop.ts) :
 *   1. Init Redis + Decodo pool
 *   2. Session CF (CapSolver) → PHPSESSID unique partagé
 *   3. getagendas/ → agendaId (capturé avant le probe pour simuler l'extraction
 *      du scan — en prod le probe capture l'agendaId dans _allSlots.agendaId)
 *   4. runSpainHttpProbe() → probe réel (getagendas/ retourne 0B : déjà consommé)
 *   5. 6 faux dossiers → executeHttpBooking() séquentiel avec agendaId transmis
 *      via bookingConfig.agendaId (exactement comme le watcher après le fix)
 *
 * CRITÈRES DE RÉUSSITE / ÉCHEC :
 *   ❌ RÉGRESSION si :
 *      signin_failed + errorMessage contient "n'a retourné de bktToken"
 *      → chaîne 0B : agendaId vide → datetime/ sans agendas[] →
 *        getsigninfields/ 0B → signin/ 0B → signin_failed
 *
 *   ✅ PIPELINE VALIDÉ si :
 *      signin_failed + errorMessage contient "password" / "credentials" /
 *        "cuenta" / "contraseña" / "invalid" / "Usuario"
 *        → signin/ a répondu avec une erreur serveur (faux credentials attendus)
 *      no_slots → flow complet, aucun créneau disponible actuellement
 *      booked   → inattendu avec faux credentials, mais le pipeline fonctionne
 *
 * USAGE :
 *   cd artifacts/slot-hunter
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   CAPSOLVER_API_KEY=$CAPSOLVER_API_KEY \
 *   DECODO_PROXY_URL=$DECODO_PROXY_URL \
 *   node_modules/.bin/tsx src/scripts/test-e2e-saopolo-6dossiers.ts
 *
 *   Override portail (par défaut : Saopolo) :
 *   PORTAL_URL=https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd.../
 *   SERVICE_ID=bkt1181774   (Kinshasa : TRAMITACIÓN DE VISADOS)
 */

import "dotenv/config";
import {
  ensureSpainCfSession,
  getActiveSpainCfSession,
  spainCfFetch,
  makeBookititUrl,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import {
  runSpainHttpProbe,
} from "../spain-http-scanner.js";
import {
  executeHttpBooking,
  type SpainBookingConfig,
  type ExtractedSlotInfo,
} from "../spain-http-booking.js";
import { matchServiceForVisa } from "../spain-service-mapping.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initDecodoPool } from "../spain-decodo-pool.js";
import {
  SAOPOLO_PORTAL_URL,
  SAOPOLO_DEFAULT_SERVICE_ID,
  KINSHASA_PORTAL_URL,
  KINSHASA_DEFAULT_SERVICE_ID,
} from "../spain-portals.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const PORTAL_URL: string = process.env.PORTAL_URL ?? SAOPOLO_PORTAL_URL;
const TARGET_SERVICE_ID: string = process.env.SERVICE_ID ?? SAOPOLO_DEFAULT_SERVICE_ID;
const VISA_TYPE = process.env.VISA_TYPE ?? "Visa C — Tourisme / Affaires";

// Date synthétique utilisée quand aucun slot réel n'est trouvé.
// On choisit 3 mois dans le futur — le serveur traitera le datetime/ et activera
// le nonce PHP même si la date n'a pas de créneaux (comportement confirmé 2026-08-12).
const syntheticSlotDate = (): string => {
  const d = new Date();
  d.setMonth(d.getMonth() + 3);
  return d.toISOString().slice(0, 10);
};
const SYNTHETIC_DATE = syntheticSlotDate();
const SYNTHETIC_TIME = "09:00";

// ─── 6 faux dossiers ─────────────────────────────────────────────────────────
// Credentials bidons — signin/ doit retourner une erreur "compte invalide",
// jamais 0B. Le 0B = régression pipeline.
const FAKE_DOSSIERS = [
  { id: "test-01", applicantName: "ALPHA TEST DOSSIER",   login: "AB1111111A", password: "fake_pw_test_01" },
  { id: "test-02", applicantName: "BRAVO TEST DOSSIER",   login: "BC2222222B", password: "fake_pw_test_02" },
  { id: "test-03", applicantName: "CHARLIE TEST DOSSIER", login: "CD3333333C", password: "fake_pw_test_03" },
  { id: "test-04", applicantName: "DELTA TEST DOSSIER",   login: "DE4444444D", password: "fake_pw_test_04" },
  { id: "test-05", applicantName: "ECHO TEST DOSSIER",    login: "EF5555555E", password: "fake_pw_test_05" },
  { id: "test-06", applicantName: "FOXTROT TEST DOSSIER", login: "FG6666666F", password: "fake_pw_test_06" },
] as const;

// ─── Logging ─────────────────────────────────────────────────────────────────
const T0 = Date.now();
const elapsed = () => `+${((Date.now() - T0) / 1000).toFixed(1)}s`;
const log  = (msg: string) => console.log(`[${elapsed()}] ${msg}`);
const ok   = (msg: string) => console.log(`[${elapsed()}] ✅ ${msg}`);
const warn = (msg: string) => console.warn(`[${elapsed()}] ⚠️  ${msg}`);
const fail = (msg: string) => console.error(`[${elapsed()}] ❌ ${msg}`);
const sep  = (title: string) => console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);

// ─── JSONP parser (pour l'appel getagendas/ manuel) ──────────────────────────
function parseJsonp(raw: string): unknown {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch { return null; }
  }
  const m = t.match(/^[^\(]+\(([\s\S]*)\);?\s*$/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function extractAgendaId(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const walk = (v: unknown): string => {
    if (!v || typeof v !== "object") return "";
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^id$|agenda.*id/i.test(k) && (typeof val === "string" || typeof val === "number")) {
        return String(val);
      }
      const found = walk(val);
      if (found) return found;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const found = walk(item);
        if (found) return found;
      }
    }
    return "";
  };
  return walk(parsed);
}

// ─── Appel getagendas/ manuel ─────────────────────────────────────────────────
// Appelé AVANT le probe (runSpainHttpProbe) pour capturer agendaId sur le
// PHPSESSID courant. Le probe consommera getagendas/ sur le même PHPSESSID
// (retour 0B) — mais on a déjà agendaId stocké.
// → Mirrors exactement ce que fait le scan interne avant d'exposer _allSlots.agendaId.
async function fetchAgendaIdManually(
  session: SpainCfSession,
  serviceId: string,
): Promise<string> {
  // makeBookititUrl exige session.bookititState (disponible en mode capsolver-residential)
  if (!session.bookititState) {
    warn("bookititState absent (mode non-capsolver ?) — agendaId non pré-récupérable");
    return "";
  }

  const JSONP_HEADERS = {
    Accept: "text/javascript, application/javascript, application/ecmascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Referer: PORTAL_URL,
  };

  const url = makeBookititUrl(session, "getagendas/", { "services[]": serviceId });
  const res = await spainCfFetch(url, session, { headers: JSONP_HEADERS });
  if (!res) return "";
  const raw = await res.text();
  log(`  getagendas/ pré-probe → HTTP ${res.status} | ${raw.length}B`);
  if (!raw.trim()) return "";
  const parsed = parseJsonp(raw);
  const agendaId = extractAgendaId(parsed);
  if (agendaId) {
    ok(`  agendaId capturé avant probe : ${agendaId}`);
  } else {
    warn(`  getagendas/ réponse non nulle mais agendaId non extrait — raw: ${raw.slice(0, 200)}`);
  }
  return agendaId;
}

// ─── Round-robin simplifié (miroir de assignSlotsRoundRobin du watcher) ───────
function assignSlotsSimple(
  dossierIds: string[],
  allSlots: Array<{ date: string; time: string; agendaId?: string }>,
): Map<string, { date: string; time: string; agendaId?: string }> {
  const assignments = new Map<string, { date: string; time: string; agendaId?: string }>();
  if (allSlots.length === 0) return assignments;
  dossierIds.forEach((id, i) => {
    assignments.set(id, allSlots[i % allSlots.length]);
  });
  return assignments;
}

// ─── Analyse du résultat booking : est-ce une régression ? ───────────────────
/**
 * Retourne true si le résultat est une RÉGRESSION (chaîne 0B).
 * La régression se manifeste par signin_failed + errorMessage contenant
 * "n'a retourné de bktToken" = aucun endpoint n'a répondu avec un bktToken
 * = signin/ + tous les fallbacks ont retourné 0B.
 */
function isRegression(status: string, errorMessage?: string): boolean {
  if (status !== "signin_failed") return false;
  return !!(errorMessage?.includes("n'a retourné de bktToken") ||
            errorMessage?.includes("retourné de bktToken"));
}

/**
 * Retourne true si le résultat prouve que le pipeline a fonctionné jusqu'à signin/.
 * "signin_failed" avec un message serveur = signin/ a répondu avec une erreur credentials.
 */
function isPipelineValid(status: string, errorMessage?: string): boolean {
  if (status === "no_slots")   return true;   // Flow complet, aucun créneau dispo
  if (status === "booked")     return true;   // Inattendu mais pipeline OK
  if (status !== "signin_failed") return false;
  // signin/ a répondu avec une erreur serveur (pas 0B)
  return !isRegression(status, errorMessage);
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  sep(`E2E PIPELINE RÉEL — SAOPOLO 6 DOSSIERS — ${new Date().toISOString()}`);
  log(`Portail     : ${PORTAL_URL}`);
  log(`Service ID  : ${TARGET_SERVICE_ID}`);
  log(`Visa type   : ${VISA_TYPE}`);
  log(`Mode        : ${process.env.SPAIN_SESSION_MODE ?? "(non défini — capsolver-residential requis)"}`);
  log(`Slot synth. : ${SYNTHETIC_DATE} ${SYNTHETIC_TIME} (utilisé si aucun slot réel)`);

  // ── 1. Init infrastructure (comme le watcher) ────────────────────────────
  sep("1 — Init Redis + Decodo pool");
  const redisOk = await initSpainRedis().catch((e: unknown) => {
    warn(`initSpainRedis non-fatal: ${e}`);
    return false;
  });
  log(`Redis : ${redisOk ? "✅ connecté" : "⚠️  non disponible (non-fatal)"}`);

  await initDecodoPool().catch((e: unknown) => {
    warn(`initDecodoPool non-fatal: ${e}`);
  });
  log("Decodo pool : initialisé");

  // ── 2. Session CF (premier obtain — establishes PHPSESSID) ───────────────
  sep("2 — Session CF (capsolver-residential)");
  const initialSession = await ensureSpainCfSession(PORTAL_URL);
  if (!initialSession) {
    fail("Impossible d'obtenir une session CF — vérifier CAPSOLVER_API_KEY + DECODO_PROXY_URL");
    process.exitCode = 1;
    return;
  }
  const phpSessId = initialSession.allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";
  ok(`Session établie — PHPSESSID: ${phpSessId.slice(0, 12)}… | source: ${initialSession.source}`);

  // ── 3. getagendas/ pré-probe — capture agendaId avant que le probe le consomme ─
  sep("3 — getagendas/ pré-probe (capture agendaId avant consommation par le scan)");
  log("IMPORTANT: getagendas/ n'est consommable qu'UNE fois par PHPSESSID en mode capsolver.");
  log("On le capture maintenant ; le probe (étape 4) aura 0B — mais on garde l'agendaId.");
  let agendaIdFromPreFetch = await fetchAgendaIdManually(initialSession, TARGET_SERVICE_ID);

  // ── 4. Probe réel (runSpainHttpProbe — identique au watcher) ─────────────
  sep("4 — runSpainHttpProbe() — scan réel (miroir exact du watcher)");
  const probeResult = await runSpainHttpProbe(PORTAL_URL);
  log(`Probe status : ${probeResult.status}`);
  if (probeResult.slotInfo)     log(`  slotInfo  : ${probeResult.slotInfo}`);
  if (probeResult.errorMessage) log(`  error     : ${probeResult.errorMessage}`);

  const allSlots = probeResult._allSlots ?? [];
  const services = probeResult._services ?? [];
  const mainHtml = probeResult._mainHtml ?? "";
  log(`  _allSlots : ${allSlots.length} créneau(x) trouvé(s)`);
  log(`  _services : ${services.length} service(s) — ${services.map(s => `"${s.serviceName}" (${s.serviceId})`).join(", ") || "aucun"}`);
  log(`  _mainHtml : ${mainHtml.length}B`);

  // agendaId final : depuis _allSlots (probe l'a trouvé) OU depuis le pré-fetch
  // (même logique que le watcher : _allSlots.agendaId → config.agendaId)
  const agendaIdFromProbe = allSlots[0]?.agendaId ?? "";
  const agendaId = agendaIdFromProbe || agendaIdFromPreFetch;
  log(`  agendaId  : ${agendaId || "(non disponible — booking sans agendas[])"}`);

  if (!agendaId) {
    warn("agendaId absent — ce test ne peut pas vérifier la chaîne getsigninfields/signin/");
    warn("→ Cela peut arriver si le portail ne répond pas à getagendas/ (maintenance, IP bloquée…)");
    warn("→ Résultat: no_slots attendu (datetime/ sans agendas[] retourne souvent 0 slot)");
  }

  // ── 5. Session active après probe ────────────────────────────────────────
  sep("5 — Session CF active après probe");
  const cfSession = getActiveSpainCfSession() ?? initialSession;
  const phpSessId2 = cfSession.allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";
  ok(`Session active — PHPSESSID: ${phpSessId2.slice(0, 12)}… | source: ${cfSession.source}`);
  if (phpSessId !== phpSessId2) {
    warn("PHPSESSID a changé entre init et probe → le probe a renouvelé la session CF");
    warn("→ agendaId pré-fetché était sur l'ancienne session — peut ne plus être valide");
  }

  // ── 6. Assignation des créneaux (round-robin, identique au watcher) ───────
  sep("6 — Assignation créneaux round-robin");
  const dossiersIds = FAKE_DOSSIERS.map(d => d.id);
  const slotAssignments = assignSlotsSimple(dossiersIds, allSlots);

  // Slot de fallback quand le probe n'a pas trouvé de créneaux réels.
  // targetDate + targetTime pré-assignés court-circuitent la recherche datetime/
  // dans executeHttpBooking et vont directement à getsigninfields/signin/.
  // C'est le chemin critique pour détecter la régression agendaId.
  const fallbackSlot = { date: SYNTHETIC_DATE, time: SYNTHETIC_TIME };

  for (const dossier of FAKE_DOSSIERS) {
    const assigned = slotAssignments.get(dossier.id);
    const slot = assigned ?? fallbackSlot;
    const slotSource = assigned ? "probe" : "synthétique";
    log(`  ${dossier.applicantName.padEnd(24)} → ${slot.date} ${slot.time} (${slotSource})`);
  }

  // ── 7. Booking séquentiel avec executeHttpBooking (fonction réelle) ───────
  sep("7 — executeHttpBooking séquentiel — 6 faux dossiers");
  log("Règle capsolver: booking séquentiel (PHPSESSID partagé → getsigninfields/ stateful)");

  const results: Array<{
    name: string;
    status: string;
    errorMessage?: string;
    durationMs: number;
    regression: boolean;
    valid: boolean;
  }> = [];

  for (const dossier of FAKE_DOSSIERS) {
    const assigned = slotAssignments.get(dossier.id);
    const slot = assigned ?? fallbackSlot;
    const slotAgendaId = assigned?.agendaId ?? agendaId;

    // ─── Même bookingConfig que le watcher après le fix (c300bb8) ─────────
    // La présence de agendaId ici est la régression testée :
    // si quelqu'un supprime cette ligne, isRegression() retournera true.
    const bookingConfig: SpainBookingConfig = {
      login:           dossier.login,
      password:        dossier.password,
      applicantName:   dossier.applicantName,
      applicationId:   dossier.id,
      otpChannel:      "email",
      targetServiceId: TARGET_SERVICE_ID,
      visaType:        VISA_TYPE,
      availableServices: services.length > 0 ? services : [
        { serviceId: TARGET_SERVICE_ID, serviceName: "Service test" },
      ],
      // ← CHAMPS CRITIQUES (testés par ce script) :
      targetDate:  slot.date,           // pre-assigned → skip datetime/ search
      targetTime:  slot.time,           // pre-assigned → skip datetime/ search
      agendaId:    slotAgendaId || undefined, // ← SI absent : régression détectée
    };

    log(`\n  ▶ ${dossier.applicantName} (${dossier.id})`);
    log(`    slot     : ${slot.date} ${slot.time}`);
    log(`    agendaId : ${slotAgendaId || "(absent)"}`);
    log(`    login    : ${dossier.login}`);

    const result = await executeHttpBooking(cfSession, PORTAL_URL, mainHtml, bookingConfig);

    const regression = isRegression(result.status, result.errorMessage);
    const valid      = isPipelineValid(result.status, result.errorMessage);

    if (regression) {
      fail(`  ${dossier.applicantName}: RÉGRESSION — ${result.status} | ${result.errorMessage}`);
    } else if (valid) {
      ok(`  ${dossier.applicantName}: Pipeline OK — ${result.status}${result.errorMessage ? ` (${result.errorMessage.slice(0, 120)})` : ""}`);
    } else {
      warn(`  ${dossier.applicantName}: Résultat ambigu — ${result.status} | ${result.errorMessage ?? ""}`);
    }

    results.push({
      name:         dossier.applicantName,
      status:       result.status,
      errorMessage: result.errorMessage,
      durationMs:   result.durationMs,
      regression,
      valid,
    });
  }

  // ── 8. Rapport final ─────────────────────────────────────────────────────
  sep("8 — RAPPORT FINAL");

  const regressions = results.filter(r => r.regression);
  const valids      = results.filter(r => r.valid && !r.regression);
  const ambiguous   = results.filter(r => !r.regression && !r.valid);

  console.log("");
  console.log("  Dossier                   | Statut          | ms    | Résultat");
  console.log("  " + "─".repeat(72));
  for (const r of results) {
    const icon = r.regression ? "❌" : r.valid ? "✅" : "⚠️ ";
    const err = r.errorMessage ? r.errorMessage.slice(0, 45) : "";
    console.log(
      `  ${icon} ${r.name.padEnd(24)} | ${r.status.padEnd(15)} | ${String(r.durationMs).padStart(5)}ms | ${err}`,
    );
  }
  console.log("");

  console.log(`  agendaId utilisé   : ${agendaId || "(absent)"}`);
  console.log(`  Probe status       : ${probeResult.status}`);
  console.log(`  Créneaux réels     : ${allSlots.length}`);
  console.log(`  Slot utilisé       : ${allSlots.length > 0 ? `${allSlots[0].date} ${allSlots[0].time} (réel)` : `${SYNTHETIC_DATE} ${SYNTHETIC_TIME} (synthétique)`}`);
  console.log("");

  if (regressions.length > 0) {
    fail(`${regressions.length} RÉGRESSION(S) DÉTECTÉE(S) !`);
    fail("→ signin/ retourne 0B = agendaId non transmis ou getsigninfields/ non amorcé");
    fail("→ Vérifier : bookingConfig.agendaId dans spain-watcher-loop.ts (assignedSlot?.agendaId)");
    fail("→ Vérifier : skip getagendas/ quand config.agendaId est fourni (spain-http-booking.ts)");
    process.exitCode = 1;
  } else if (valids.length === FAKE_DOSSIERS.length) {
    ok(`${valids.length}/${FAKE_DOSSIERS.length} dossiers — PIPELINE RÉEL VALIDÉ`);
    ok("signin/ répond avec une erreur serveur (credentials) ou no_slots = flux complet OK");
    if (!agendaId) {
      warn("Note: agendaId absent → test moins fort (ne vérifie pas la transmission agendaId)");
    }
  } else if (ambiguous.length > 0) {
    warn(`${ambiguous.length} résultat(s) ambigu(s) (ni régression confirmée, ni pipeline validé)`);
    warn("→ Inspecter les logs ci-dessus pour diagnostic");
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error("\nFATAL:", e);
  process.exitCode = 1;
});
