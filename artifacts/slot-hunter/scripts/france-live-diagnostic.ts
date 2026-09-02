/**
 * france-live-diagnostic.ts — Diagnostic LIVE du hunter France (vrai réseau).
 *
 * Ce script N'IMPLÉMENTE aucune logique : il importe et exécute DIRECTEMENT les
 * fonctions de production du concern France (src/france/*), étape par étape, en
 * loggant pour chacune la fonction source et son résultat. En cas de problème,
 * la dernière étape « ▶ » affichée pointe exactement la fonction de prod à
 * inspecter.
 *
 * Il reproduit la séquence de `runFranceJob` (france-hunter.ts) mais de façon
 * pas-à-pas et bornée (quelques cycles de scan), pour un diagnostic rapide.
 *
 * ⚠️ VRAI RÉSEAU : effectue un vrai handshake, résout un vrai Turnstile via
 * CapSolver (coût réel), ouvre une vraie session et scanne le portail.
 *
 * ⚠️⚠️ MODE BOOKING (--book) : effectue une VRAIE réservation qui consomme un
 * créneau consulaire réel. AUCUNE annulation automatique n'est effectuée (le
 * concern France n'expose pas d'endpoint d'annulation). L'annulation doit être
 * faite MANUELLEMENT via l'email de confirmation. À n'utiliser qu'en pleine
 * connaissance de cause.
 *
 * Secrets (lus depuis .env, JAMAIS en dur — sinon fuite dans git) :
 *   - CAPSOLVER_API_KEY : clé CapSolver (Turnstile).
 *   - PROXY_URL         : proxy résidentiel/ISP FR.
 *
 * Tout le reste (cible + contact) est codé en dur dans les constantes TEST_*
 * en tête de fichier — à compléter (« << À REMPLIR >> ») avant de lancer.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   pnpm run france:diag              # diagnostic lecture seule (pas de booking)
 *   pnpm run france:diag -- --book    # diagnostic + RÉSERVATION RÉELLE
 */

import "dotenv/config";

import { createFranceHttpClient, maskSecret } from "../src/france/france-http.js";
import { performHandshake, resolveTeam } from "../src/france/france-handshake.js";
import { buildFrancePageUrl, solveFranceTurnstile } from "../src/france/france-turnstile.js";
import { openSession } from "../src/france/france-session.js";
import { computePollingDelay, scanWindow } from "../src/france/france-scanner.js";
import {
  buildSlotToKeep,
  runBookingFlow,
  validateContact,
} from "../src/france/france-booking.js";
import type {
  BookingContact,
  BookingContext,
  FranceServiceTarget,
  FranceSlot,
  SlotPublication,
} from "../src/france/france-types.js";
import type { FranceHttpClient } from "../src/france/france-http.js";

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION DE TEST EN DUR (script jetable de diagnostic)
// ───────────────────────────────────────────────────────────────────────────
// ⚠️ À COMPLÉTER avant de lancer : remplacez chaque « << À REMPLIR >> ».
//
// NOTE SÉCURITÉ : seuls la clé CapSolver et le proxy NE sont PAS en dur ici —
// ce sont des secrets réutilisables (clé API payante + identifiants proxy) qui
// ne doivent jamais partir dans git. Ils restent lus depuis .env
// (CAPSOLVER_API_KEY, PROXY_URL), déjà requis par le hunter. Tout le reste
// (cible + contact) est codé en dur pour ce test.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Slug du consulat — valeur RÉELLE validée en live le 2026-08-31
 * (bundle-analysis/france-bundle-2026-08-31.md → teamId 6230a987df141cedfef4a188).
 */
const TEST_CONSULATE_SLUG = "ambassade-de-france-a-kinshasa";

/**
 * Service cible : `serviceId` = _id technique (get-interval), `serviceName` =
 * nom textuel exact (availability, paramètre `name`).
 *
 * On vise le service **ADF** qui a des créneaux réels (11 j/21 en live), le seul
 * permettant de tester un booking de bout en bout. Le service « Visas »
 * (6346e242c47b29722d5f5f52) retourne `[]` (agenda vide) → aucun créneau à
 * réserver. Le nom textuel doit correspondre EXACTEMENT au libellé du portail.
 */
const TEST_SERVICE: FranceServiceTarget = {
  serviceId: "6346e242c47b29722d5f5f4e",
  // NOM TEXTUEL EXACT tel que l'API le connaît (lu depuis
  // reservations_shop_availabilty[].name). Le param `name` d'availability doit
  // matcher EXACTEMENT, sinon l'API renvoie [] (0 créneau) sans erreur.
  serviceName:
    "ADF - Demande d'inscription au Registre, de CNI/ passeport/déclaration de vol ou perte de documents",
};

/** Nombre de cycles de scan avant d'abandonner (diagnostic). */
const TEST_SCAN_CYCLES = 2;

/**
 * Variables d'env candidates pour l'URL du proxy, dans l'ordre de préférence.
 * On privilégie le proxy ISP Decodo ; replis ensuite. (Le `.env` de ce poste a
 * un PROXY_URL vide ; DECODO_PROXY_URL / SPAIN_ISP_PROXY_URL portent l'ISP.)
 */
const PROXY_ENV_CANDIDATES: readonly string[] = [
  "DECODO_PROXY_URL",
  "SPAIN_ISP_PROXY_URL",
  "PROXY_URL",
  "IPROYAL_PROXY_URL",
];

/**
 * Motif — SPÉCIFIQUE au service ADF. Clé + valeur lues depuis
 * team.reservations_shop_availabilty[ADF].custom_fields (sonde
 * france-probe-zones.ts). Le custom field "Motif" (required) du service ADF a
 * la clé "6480b20515fc40e7" ; les valeurs valides incluent
 * "Inscription au Registre " (ATTENTION : espace final significatif).
 * (Le service Visas a une clé/valeurs différentes — NE PAS confondre.)
 */
const TEST_MOTIF_KEY = "6480b20515fc40e7";
const TEST_MOTIF = "Inscription au Registre ";

/** Contact provisoire de la réservation de test (à annuler après). */
const TEST_CONTACT: BookingContact = {
  firstname: "Jean",
  lastname: "Test",
  email: "encoraplus@gmail.com",
  mobile: "+243900000000",
  birthdate: {
    month: 0, // 0-indexé : 0 = janvier … 11 = décembre
    day: 1,
    year: 1990,
  },
};

// ---------------------------------------------------------------------------
// Helpers de log (aucune logique métier)
// ---------------------------------------------------------------------------

function step(fn: string, detail: string): void {
  console.log(`\n▶ [${fn}] ${detail}`);
}

function ok(msg: string): void {
  console.log(`  ✅ ${msg}`);
}

function fail(fn: string, msg: string): void {
  console.error(`  ❌ ÉCHEC dans ${fn} — ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Lit une variable d'env requise, sinon termine le script avec un message clair. */
function requireEnv(name: string): string {
  const raw = process.env[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) {
    console.error(`\n[franceDiag] Variable d'environnement requise manquante : ${name}.`);
    console.error(`[franceDiag] Renseignez-la dans artifacts/slot-hunter/.env puis relancez.`);
    process.exit(1);
  }
  return value;
}

/** Refuse toute valeur laissée à l'état de placeholder « << À REMPLIR … >> ». */
function ensureFilled(label: string, value: string): void {
  if (value.includes("<< À REMPLIR")) {
    console.error(
      `\n[franceDiag] Valeur de test non renseignée : ${label}. ` +
        `Complétez les constantes TEST_* en haut de scripts/france-live-diagnostic.ts.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Construction du contact de booking (constantes en dur, validées par le prod)
// ---------------------------------------------------------------------------

/**
 * Valide le contact/motif de test codés en dur (TEST_CONTACT / TEST_MOTIF).
 * Utilise `validateContact` / `validateMotif` de prod pour rejeter tôt toute
 * configuration hors bornes AVANT de toucher le réseau.
 */
function buildBookingContact(): { contact: BookingContact; motif: string } {
  ensureFilled("TEST_CONTACT.firstname", TEST_CONTACT.firstname);
  ensureFilled("TEST_CONTACT.lastname", TEST_CONTACT.lastname);
  ensureFilled("TEST_CONTACT.mobile", TEST_CONTACT.mobile);

  const contactCheck = validateContact(TEST_CONTACT);
  if (!contactCheck.valid) {
    console.error(
      `\n[franceDiag] Contact de test invalide (champ « ${contactCheck.invalidField} » hors bornes). ` +
        `Corrigez les constantes TEST_CONTACT puis relancez.`,
    );
    process.exit(1);
  }

  // Le motif est SPÉCIFIQUE au service (custom_fields ADF) : la clé
  // TEST_MOTIF_KEY et la valeur TEST_MOTIF proviennent de la sonde
  // france-probe-zones.ts. On vérifie seulement leur présence (pas de liste
  // globale figée qui ne vaut que pour Visas).
  if (TEST_MOTIF.trim().length === 0 || TEST_MOTIF_KEY.trim().length === 0) {
    console.error(`\n[franceDiag] TEST_MOTIF / TEST_MOTIF_KEY manquant.`);
    process.exit(1);
  }

  return { contact: TEST_CONTACT, motif: TEST_MOTIF };
}

// ---------------------------------------------------------------------------
// Diagnostic principal
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const bookingEnabled = process.argv.includes("--book");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  DIAGNOSTIC LIVE — HUNTER FRANCE (consulat.gouv.fr)");
  console.log("  Chaque étape ▶ appelle DIRECTEMENT le code de prod.");
  console.log(`  Mode booking : ${bookingEnabled ? "⚠️ ACTIVÉ (réservation réelle)" : "désactivé (lecture seule)"}`);
  console.log(`  Mode réseau  : ${process.argv.includes("--no-proxy") ? "DIRECT (--no-proxy)" : "via proxy"}`);
  console.log("═══════════════════════════════════════════════════════════");

  // --- 0. Secrets (.env) + paramètres du service ----------------------------
  // Secrets lus directement depuis .env : CAPSOLVER_API_KEY (obligatoire) et le
  // proxy ISP (premier candidat non vide, Decodo en priorité — PROXY_URL est
  // vide sur ce poste). Aucun secret n'est codé en dur.
  step("requireEnv", "chargement CAPSOLVER_API_KEY depuis .env");
  const capsolverApiKey = requireEnv("CAPSOLVER_API_KEY");
  ok(`capsolver=${maskSecret(capsolverApiKey)}`);

  const noProxy = process.argv.includes("--no-proxy");
  let proxyUrl = "";
  if (noProxy) {
    step("resolveProxy", "mode --no-proxy : connexion DIRECTE (aucun proxy)");
    ok("proxy=(direct, sans proxy)");
  } else {
    step("resolveProxy", `sélection du proxy ISP parmi [${PROXY_ENV_CANDIDATES.join(", ")}]`);
    let proxySource = "";
    for (const candidate of PROXY_ENV_CANDIDATES) {
      const raw = process.env[candidate];
      const value = typeof raw === "string" ? raw.trim() : "";
      if (value.length > 0) {
        proxyUrl = value;
        proxySource = candidate;
        break;
      }
    }
    if (proxyUrl.length === 0) {
      fail(
        "resolveProxy",
        `aucune URL proxy non vide parmi ${PROXY_ENV_CANDIDATES.join(", ")}. ` +
          `Renseignez un proxy dans .env, ou relancez avec --no-proxy (connexion directe).`,
      );
      process.exit(1);
    }
    ok(`proxy=${proxySource} → ${maskSecret(proxyUrl)}`);
  }

  ensureFilled("TEST_CONSULATE_SLUG", TEST_CONSULATE_SLUG);
  ensureFilled("TEST_SERVICE.serviceId", TEST_SERVICE.serviceId);
  ensureFilled("TEST_SERVICE.serviceName", TEST_SERVICE.serviceName);
  const consulateSlug = TEST_CONSULATE_SLUG;
  const service: FranceServiceTarget = TEST_SERVICE;
  const scanCycles = TEST_SCAN_CYCLES;
  console.log(
    `  ℹ️ slug=${consulateSlug}, serviceId=${maskSecret(service.serviceId)}, ` +
      `serviceName="${service.serviceName}", cycles=${scanCycles}`,
  );

  // Si booking demandé : on valide le contact/motif TÔT (avant tout réseau).
  let bookingContact: BookingContact | null = null;
  let bookingMotif: string | null = null;
  if (bookingEnabled) {
    const built = buildBookingContact();
    bookingContact = built.contact;
    bookingMotif = built.motif;
    console.log(
      `  ℹ️ (booking) contact=${bookingContact.firstname} ${bookingContact.lastname}, ` +
        `email=${bookingContact.email}, motif="${bookingMotif}"`,
    );
    console.log(
      "  ⚠️ Une réservation RÉELLE sera tentée si un créneau est trouvé. " +
        "Aucune annulation automatique — à annuler manuellement via l'email de confirmation.",
    );
  }

  // --- 1. Handshake anti-bot -------------------------------------------------
  step("performHandshake", "HEAD /handshake (jetons x-gouv-*) via proxy");
  const authState = await performHandshake(proxyUrl);
  if (authState === null) {
    fail("performHandshake", "aucun jeton anti-bot obtenu après 3 tentatives.");
    process.exit(1);
  }
  ok(`appId=${maskSecret(authState.appId)}, handshake=${maskSecret(authState.handshakeToken)}`);

  // --- 2. Client HTTP isolé (onRehandshake sur 418) --------------------------
  step("createFranceHttpClient", "création du client HTTP France (proxy + auth)");
  const http = createFranceHttpClient(authState, proxyUrl, () =>
    performHandshake(proxyUrl),
  );
  ok("client HTTP prêt");

  // --- 3. Résolution du consulat → teamId ------------------------------------
  step("resolveTeam", `GET /team/slug/${consulateSlug}?lang=fr`);
  const team = await resolveTeam(http, consulateSlug);
  if (team === null) {
    fail("resolveTeam", `teamId introuvable pour le slug « ${consulateSlug} ».`);
    process.exit(1);
  }
  ok(`teamId=${maskSecret(team.teamId)}`);

  // --- 4. Turnstile #1 (session) ---------------------------------------------
  // URL RÉELLE de la page RDV (widget Turnstile) — sinon token rejeté (CAPTCHA_FAILED).
  const pageUrl = buildFrancePageUrl(consulateSlug, service.serviceName);
  step("solveFranceTurnstile(session)", `résolution CapSolver (coût réel) — page ${pageUrl}`);
  const sessionToken = await solveFranceTurnstile("session", capsolverApiKey, pageUrl);
  if (sessionToken === null) {
    fail("solveFranceTurnstile(session)", "aucun token résolu après 3 tentatives.");
    process.exit(1);
  }
  ok(`token session=${maskSecret(sessionToken)}`);

  // --- 5. Ouverture de session -----------------------------------------------
  step("openSession", "POST /team/{teamId}/reservations-session");
  const session = await openSession(
    http,
    team.teamId,
    service.serviceName,
    sessionToken,
    Date.now(),
  );
  if (session === null) {
    fail("openSession", "ouverture refusée (SESSION_ERROR ou 3 échecs).");
    process.exit(1);
  }
  ok(`sessionId=${maskSecret(session.sessionId)}, ttlMs=${session.ttlMs}`);

  // --- 6. Boucle de scan bornée ----------------------------------------------
  let prevExcluded: ReadonlySet<string> = new Set<string>();
  let publication: SlotPublication | null = null;
  // Carte jour → créneaux du dernier scan (pour choisir un jour FUTUR réservable :
  // le premier jour publié peut être AUJOURD'HUI, dont les créneaux ne sont plus
  // réservables au moment du family → ERROR_ADD_GROUPPED_RESERVATION).
  let lastDaySlots: ReadonlyMap<string, FranceSlot[]> = new Map<string, FranceSlot[]>();

  for (let cycle = 1; cycle <= scanCycles; cycle += 1) {
    step("scanWindow", `cycle ${cycle}/${scanCycles} — get-interval + exclude-days + availability`);
    const scan = await scanWindow(
      http,
      team.teamId,
      service,
      session.sessionId,
      prevExcluded,
    );

    if (scan === null) {
      fail(
        "scanWindow",
        "étape bloquante en échec (getInterval ou getExcludeDays). " +
          "Inspecter getInterval / getExcludeDays dans france-scanner.ts.",
      );
      // On n'arrête pas : on tente le cycle suivant après le délai de polling.
    } else {
      prevExcluded = scan.excludeDays;
      lastDaySlots = scan.daySlots;
      ok(
        `fenêtre=[${scan.window.start} → ${scan.window.end}], ` +
          `joursExclus=${scan.excludeDays.size}, joursScannés=${scan.daySlots.size}`,
      );

      let totalSlots = 0;
      for (const [day, slots] of scan.daySlots) {
        if (slots.length > 0) {
          console.log(`     • ${day} : ${slots.length} créneau(x) → ${slots.map((s) => s.time).join(", ")}`);
          totalSlots += slots.length;
        }
      }
      console.log(`     Σ créneaux disponibles ce cycle : ${totalSlots}`);

      if (scan.publication !== null) {
        publication = scan.publication;
        console.log(
          `  🎯 [detectPublication] PUBLICATION : raison=${scan.publication.reason}, ` +
            `jour=${scan.publication.day}, créneaux=${scan.publication.slots.length}`,
        );
        break;
      }
    }

    if (cycle < scanCycles) {
      const delayMs = computePollingDelay(30_000, Math.random());
      step("computePollingDelay", `attente ${Math.round(delayMs)} ms (base 30s ±20%) avant le prochain cycle`);
      await sleep(delayMs);
    }
  }

  // --- 7. Booking optionnel (--book) -----------------------------------------
  if (!bookingEnabled) {
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log(
      publication !== null
        ? "  RÉSULTAT : ✅ publication détectée (slot_found) — booking désactivé."
        : "  RÉSULTAT : ⚪ aucune publication sur les cycles testés (not_found).",
    );
    console.log("  Toutes les étapes ▶ ci-dessus ont appelé le code de prod.");
    console.log("═══════════════════════════════════════════════════════════");
    return;
  }

  if (publication === null) {
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  RÉSULTAT : ⚪ aucune publication — rien à réserver (booking non déclenché).");
    console.log("═══════════════════════════════════════════════════════════");
    return;
  }

  // Choix d'un jour RÉSERVABLE : on évite AUJOURD'HUI (les créneaux du jour même
  // ne sont plus réservables au moment du family → ERROR_ADD_GROUPPED_RESERVATION).
  // On prend le premier jour STRICTEMENT futur ayant des créneaux ; à défaut, on
  // retombe sur le jour de publication.
  const todayIso = new Date().toISOString().slice(0, 10);
  let bookingDay = publication.day;
  let firstSlot: FranceSlot | undefined = publication.slots[0];
  const futureDays = [...lastDaySlots.entries()]
    .filter(([day, slots]) => day > todayIso && slots.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (futureDays.length > 0) {
    const [day, slots] = futureDays[0];
    bookingDay = day;
    firstSlot = slots[0];
    console.log(`  ℹ️ Jour de booking choisi (futur, réservable) : ${bookingDay} (au lieu de ${publication.day}).`);
  } else {
    console.log(`  ⚠️ Aucun jour futur réservable trouvé — repli sur ${publication.day} (aujourd'hui = ${todayIso}).`);
  }

  if (firstSlot === undefined) {
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log(
      `  RÉSULTAT : ✅ publication (${publication.reason}) sans créneau exploitable — booking non déclenché.`,
    );
    console.log("═══════════════════════════════════════════════════════════");
    return;
  }

  if (bookingContact === null || bookingMotif === null) {
    fail("main", "contact/motif de booking manquants (état incohérent).");
    process.exit(1);
  }

  // Pause de récupération : le scan a fait ~34 requêtes availability et le
  // portail rate-limite les appels rapprochés (l'écriture slotsStep pend sinon).
  // On laisse le compteur retomber avant d'écrire la réservation.
  step("cooldown", "pause 20 s pour laisser le rate limit retomber avant le booking");
  await sleep(20_000);

  step("solveFranceTurnstile(booking)", "résolution CapSolver #2 (coût réel)");
  const bookingToken = await solveFranceTurnstile("booking", capsolverApiKey, pageUrl);
  if (bookingToken === null) {
    fail("solveFranceTurnstile(booking)", "aucun token résolu — booking abandonné.");
    process.exit(1);
  }
  ok(`token booking=${maskSecret(bookingToken)}`);

  step("buildSlotToKeep", `jour=${bookingDay}, heure=${firstSlot.time}`);
  const slot = buildSlotToKeep(service.serviceName, bookingDay, firstSlot.time, firstSlot.rate, firstSlot.capacity);
  ok(`slotValue=${slot.slotValue}, date=${slot.date}`);

  const bookingCtx: BookingContext = {
    teamId: team.teamId,
    sessionId: session.sessionId,
    service,
    contact: bookingContact,
    motifKey: TEST_MOTIF_KEY,
    motif: bookingMotif,
    slot,
    captchaToken: bookingToken,
  };

  console.log(
    "\n  ⚠️⚠️ RÉSERVATION RÉELLE EN COURS — email de confirmation attendu sur " +
      `${bookingContact.email}. À ANNULER MANUELLEMENT ensuite.`,
  );
  step("runBookingFlow", "persistance des 7 étapes + POST reservations/family");
  const result = await runBookingFlow(http as FranceHttpClient, bookingCtx);

  console.log("\n═══════════════════════════════════════════════════════════");
  if (result.success) {
    console.log(
      `  RÉSULTAT : ✅ BOOKING CONFIRMÉ — ${result.qrCodes?.length ?? 0} qrCode(s). ` +
        `Vérifiez ${bookingContact.email} et ANNULEZ la réservation.`,
    );
  } else {
    console.log(
      `  RÉSULTAT : ❌ booking échoué — ${result.error ?? "cause inconnue"} ` +
        `(étape=${result.failedStep ?? "n/a"}).`,
    );
  }
  console.log("═══════════════════════════════════════════════════════════");
}

main().catch((error: unknown) => {
  console.error(
    "\n[franceDiag] Erreur inattendue (hors fonctions France) :",
    error instanceof Error ? error.stack ?? error.message : error,
  );
  process.exit(1);
});
