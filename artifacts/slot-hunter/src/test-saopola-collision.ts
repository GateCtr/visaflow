/**
 * test-saopola-collision.ts — Reproduction du scénario « N signin/ à l'instant T sur 1 place »
 *
 * Portail : Saopola (retrait passeports) → citaconsular.es
 * URL     : https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/
 *
 * OBJECTIF
 *   Valider empiriquement l'hypothèse observée en prod :
 *     « Quand N workers (N IP Decodo distinctes) appellent signin/ sur LE MÊME créneau
 *       au même instant T, le serveur Bookitit répond 0B à TOUS (collision). »
 *   Et vérifier si un créneau à 2+ places évite le problème (chaque signin/ vise
 *   une des places → pas de collision).
 *
 *   Ce test reproduit le chemin EXACT de la prod : N sessions isolées
 *   (initWorkerSession = solve CF + IP dédiée via sticky sid), initPhpState,
 *   scanDatetimeDirect, puis callDirect("getsigninfields/") + callDirect("signin/")
 *   lancés en Promise.all. C'est le chemin HTTP pur qui reçoit les 0B — PAS
 *   executeHttpBooking (browser/DOM) utilisé par les autres tests Saopola.
 *
 * SÉCURITÉ
 *   - Credentials FAUX (matricule bidon) → aucun booking réel possible.
 *   - Consomme N solves CapSolver + N IP Decodo (sticky). À lancer ponctuellement,
 *     pas en boucle (le portail est un système tiers réel).
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   npx tsx src/test-saopola-collision.ts
 *
 *   Variables :
 *     COLLISION_N=3            Nombre de sessions concurrentes (défaut 3)
 *     COLLISION_TARGET_FREE=1  Cible un créneau avec EXACTEMENT ce nombre de places
 *                              (1 = test collision ; 2 ou + = test multi-place).
 *                              Si absent → prend le 1er créneau bookable trouvé.
 *     DECODO_PROXY_URL=...     Proxy résidentiel Decodo (sticky sid = IP distincte)
 *     CAPSOLVER_API_KEY=...    Clé CapSolver
 */

import "dotenv/config";

import { initWorkerSession, type SpainCfSession } from "./spain-soax-solver.js";
import {
  initPhpState,
  scanDatetimeDirect,
  type SpainDossierConfig,
  type WorkerPhpState,
} from "./spain-dossier-worker.js";
import { callDirect, CALL_DIRECT_NETWORK_ERROR } from "./spain-bookitit-direct.js";
import {
  getDecodoPoolSize,
  getDecodoProxyForIndex,
} from "./spain-decodo-pool.js";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";

const N = process.env.COLLISION_N ? parseInt(process.env.COLLISION_N, 10) : 3;
const TARGET_FREE = process.env.COLLISION_TARGET_FREE
  ? parseInt(process.env.COLLISION_TARGET_FREE, 10)
  : 0; // 0 = pas de filtre (1er créneau bookable)

const CAPSOLVER_KEY =
  process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
// Fallback proxy (une seule URL) si le pool CSV est vide.
const BASE_PROXY = process.env.DECODO_PROXY_URL ?? "";

/**
 * Retourne l'URL proxy pour la session #i.
 * PRIORITÉ : pool CSV Decodo (decodo-proxies.csv, IP espagnoles dédiées par port).
 * Chaque session prend un PORT distinct du pool → exit IP distincte, comme la prod.
 * Fallback : DECODO_PROXY_URL + sticky sid (une seule base, N exit IP via sessid).
 */
function proxyForSession(i: number): string {
  const poolSize = getDecodoPoolSize();
  if (poolSize > 0) {
    // Répartir sur des ports distincts du pool (modulo si N > taille du pool).
    const url = getDecodoProxyForIndex(i % poolSize);
    if (url) return url;
  }
  if (BASE_PROXY) {
    const sid = Math.random().toString(36).slice(2, 10);
    return addStickySession(BASE_PROXY, sid);
  }
  return "";
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sep(label: string): void {
  console.log("\n" + "═".repeat(72));
  console.log(`  ${label}`);
  console.log("═".repeat(72));
}

function el(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Injecte un sticky session ID dans l'URL proxy Decodo → exit IP distincte par sid.
 * Copie locale de la logique du worker (spain-dossier-worker.addStickySession).
 */
function addStickySession(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch {
    return url;
  }
}

function fakeConfig(i: number): SpainDossierConfig {
  return {
    id: `collision-test-${i}`,
    applicantName: `COLLISION_TEST_${i}`,
    visaType: "visa touristique",
    login: `0000000${i}`,
    password: `FakePass_Collision_${i}`,
    applicationId: `collision-${i}`,
    otpChannel: "manual",
    portalUrl: PORTAL_URL,
  };
}

interface PreparedSession {
  idx: number;
  tag: string;
  session: SpainCfSession;
  phpState: WorkerPhpState;
  config: SpainDossierConfig;
}

// ─── Prépare une session isolée (solve CF + PHP init + scan) ──────────────────

async function prepareSession(i: number): Promise<PreparedSession | null> {
  const config = fakeConfig(i);
  const tag = `[S${i}]`;
  const stickyProxy = proxyForSession(i - 1); // i est 1-based, index pool 0-based
  const portHint = stickyProxy.match(/@[^:]+:(\d+)/)?.[1] ?? "?";

  console.log(`${tag} 🔐 initWorkerSession (proxy port=${portHint})…`);
  const t0 = Date.now();
  const res = await initWorkerSession(stickyProxy, PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res) {
    console.warn(`${tag} ❌ initWorkerSession échoué`);
    return null;
  }
  console.log(`${tag} ✅ session CF (${el(Date.now() - t0)}, cache=${res.cfFromCache})`);

  const phpState = await initPhpState(res.session, config, tag);
  if (!phpState) {
    console.warn(`${tag} ❌ initPhpState échoué`);
    return null;
  }

  return { idx: i, tag, session: res.session, phpState, config };
}

// ─── Un seul signin/ (chemin prod exact) ──────────────────────────────────────

interface SigninOutcome {
  idx: number;
  tag: string;
  gsfBytes: number;
  signinBytes: number;
  signin0B: boolean;
  hasBktToken: boolean;
  errorMessage?: string;
  startOffsetMs: number; // écart au T0 commun (montre la simultanéité réelle)
  gsfMs: number;
  signinMs: number;
}

async function attemptSignin(
  prep: PreparedSession,
  slot: { date: string; time: string; agendaId?: string },
  serviceId: string,
  t0Common: number,
): Promise<SigninOutcome> {
  const { tag, phpState } = prep;
  const ds = phpState.ds;
  const startOffsetMs = Date.now() - t0Common;

  const bookExtra: Record<string, string> = {
    "services[]": serviceId,
    date: slot.date,
    time: slot.time,
    selectedPeople: "1",
  };
  if (slot.agendaId) bookExtra["agendas[]"] = slot.agendaId;

  // getsigninfields/
  const gsfT0 = Date.now();
  const gsfPayload = (await callDirect(ds, "getsigninfields/", {
    "services[]": bookExtra["services[]"],
    "agendas[]": bookExtra["agendas[]"] ?? "",
    date: bookExtra.date,
    time: bookExtra.time,
    selectedPeople: bookExtra.selectedPeople,
  }, tag)) as unknown;
  const gsfMs = Date.now() - gsfT0;
  const gsfBytes = gsfPayload ? JSON.stringify(gsfPayload).length : 0;

  if (!gsfPayload) {
    return {
      idx: prep.idx, tag, gsfBytes, signinBytes: 0, signin0B: true,
      hasBktToken: false, errorMessage: "getsigninfields/ → 0B",
      startOffsetMs, gsfMs, signinMs: 0,
    };
  }

  // signin/
  const signinT0 = Date.now();
  const signinRaw = await callDirect(ds, "signin/", {
    ...bookExtra,
    logintype: "document",
    login: prep.config.login,
    password: prep.config.password,
    comments: "",
  });
  const signinMs = Date.now() - signinT0;

  const signinPayload =
    signinRaw === null || signinRaw === CALL_DIRECT_NETWORK_ERROR
      ? null
      : (signinRaw as Record<string, unknown>);
  const signinBytes = signinPayload ? JSON.stringify(signinPayload).length : 0;

  const inner = (signinPayload as any)?.Client ?? signinPayload;
  const bktToken = String(
    (signinPayload as any)?.Access?.bktToken ??
      inner?.bktToken ??
      (signinPayload as any)?.bktToken ??
      "",
  );
  const errors: Array<{ message?: string }> = Array.isArray(inner?.errors) ? inner.errors : [];

  return {
    idx: prep.idx, tag, gsfBytes, signinBytes,
    signin0B: signinPayload === null,
    hasBktToken: Boolean(bktToken),
    errorMessage: errors.length ? errors.map((e) => e.message).join(", ") : undefined,
    startOffsetMs, gsfMs, signinMs,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  sep(`TEST COLLISION signin/ — ${N} session(s) simultanée(s) (Saopola)`);
  console.log(`  Portail   : ${PORTAL_URL}`);
  console.log(`  Sessions  : ${N}`);
  console.log(`  Cible free: ${TARGET_FREE > 0 ? `EXACTEMENT ${TARGET_FREE} place(s)` : "1er créneau bookable"}`);
  const poolSize = getDecodoPoolSize();
  console.log(
    `  Proxy     : ${poolSize > 0 ? `pool CSV Decodo (${poolSize} IP espagnoles) ✅` : BASE_PROXY ? "DECODO_PROXY_URL (fallback) ✅" : "⚠️  aucun proxy (ni CSV ni DECODO_PROXY_URL)"}`,
  );
  console.log(`  CapSolver : ${CAPSOLVER_KEY ? "configuré ✅" : "⚠️  CAPSOLVER_API_KEY absent"}`);

  // ── Phase 1 : préparer N sessions isolées (en parallèle) ────────────────────
  sep("PHASE 1 — Préparation de N sessions isolées (solve CF + PHP init)");
  const prepared = (
    await Promise.all(Array.from({ length: N }, (_, i) => prepareSession(i + 1)))
  ).filter((p): p is PreparedSession => p !== null);

  if (prepared.length === 0) {
    console.error("\n  ⛔ Aucune session prête — abandon.");
    process.exit(1);
  }
  console.log(`\n  ✅ ${prepared.length}/${N} session(s) prête(s).`);

  // ── Phase 2 : scanner pour trouver un créneau cible ─────────────────────────
  sep("PHASE 2 — Scan datetime/ (via la 1ère session) → sélection du créneau");
  const scout = prepared[0];
  const scan = await scanDatetimeDirect(scout.phpState, scout.config, scout.tag);
  if (scan.status !== "found" || !scan.slots || scan.slots.length === 0) {
    console.log(`\n  ℹ️  Aucun créneau disponible (status=${scan.status}). Réessaie quand des créneaux sont visibles.`);
    process.exit(0);
  }

  console.log(`\n  📅 Créneaux trouvés (${scan.slots.length}) :`);
  for (const s of scan.slots.slice(0, 20)) {
    console.log(`       ${s.date} ${s.time}  [${s.freeslots < 0 ? "?" : s.freeslots} place(s)]${s.agendaId ? `  agenda=${s.agendaId}` : ""}`);
  }

  // Sélection du créneau cible
  const bookable = scan.slots.filter((s) => s.freeslots > 0);
  const target =
    TARGET_FREE > 0
      ? bookable.find((s) => s.freeslots === TARGET_FREE)
      : bookable[0];

  if (!target) {
    console.log(
      `\n  ⚠️  Aucun créneau avec ${TARGET_FREE > 0 ? `exactement ${TARGET_FREE} place(s)` : "des places libres"} ` +
      `— impossible de tester ce scénario maintenant.`,
    );
    console.log(`      Places disponibles : ${bookable.map((s) => `${s.time}:${s.freeslots}`).join(", ") || "aucune"}`);
    process.exit(0);
  }

  console.log(`\n  🎯 Créneau cible : ${target.date} ${target.time} — ${target.freeslots} place(s) | agenda=${target.agendaId ?? "?"}`);
  console.log(`     Les ${prepared.length} sessions vont appeler signin/ dessus À L'INSTANT T.`);

  // ── Phase 3 : N signin/ en Promise.all ──────────────────────────────────────
  sep(`PHASE 3 — ${prepared.length} × signin/ en Promise.all (instant T)`);
  const serviceId = scout.phpState.bestServiceId;
  const t0Common = Date.now();
  const outcomes = await Promise.all(
    prepared.map((p) =>
      attemptSignin(p, { date: target.date, time: target.time, agendaId: target.agendaId }, serviceId, t0Common),
    ),
  );

  // ── Résumé ──────────────────────────────────────────────────────────────────
  sep("RÉSUMÉ");
  outcomes.sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  for (const o of outcomes) {
    const verdict = o.hasBktToken
      ? "🎫 bktToken (signin OK)"
      : o.signin0B
        ? "❌ signin/ → 0B (COLLISION)"
        : `⚠️  signin sans token (${o.errorMessage ?? "?"})`;
    console.log(
      `  ${o.tag} start+${o.startOffsetMs}ms | gsf=${o.gsfBytes}B(${el(o.gsfMs)}) | ` +
      `signin=${o.signinBytes}B(${el(o.signinMs)}) → ${verdict}`,
    );
  }

  const zeroB = outcomes.filter((o) => o.signin0B).length;
  const withToken = outcomes.filter((o) => o.hasBktToken).length;
  const sansToken = outcomes.length - zeroB - withToken;

  console.log();
  console.log(`  📊 Sur ${outcomes.length} signin/ simultanés sur ${target.freeslots} place(s) :`);
  console.log(`       🎫 avec bktToken (OK)   : ${withToken}`);
  console.log(`       ❌ 0B (collision)        : ${zeroB}`);
  console.log(`       ⚠️  sans token (rejet)   : ${sansToken}`);
  console.log();

  // Interprétation
  if (target.freeslots === 1) {
    if (zeroB === outcomes.length) {
      console.log("  🔴 CONFIRMÉ — 1 place + N signin/ simultanés → 0B pour TOUS (collision serveur).");
      console.log("     → La sérialisation stricte (1 seul signin/ par place) est nécessaire.");
    } else if (withToken <= 1 && zeroB >= 1) {
      console.log("  🟠 PARTIEL — au plus 1 gagnant, les autres 0B/rejet. Collision présente mais 1 peut passer.");
    } else {
      console.log("  🟢 PAS de collision massive observée sur 1 place ce coup-ci (résultat à re-tester).");
    }
  } else {
    if (zeroB === 0) {
      console.log(`  🟢 ${target.freeslots} places → aucun 0B : le multi-place évite la collision.`);
    } else {
      console.log(`  🟠 ${target.freeslots} places mais ${zeroB} × 0B : collision partielle même en multi-place.`);
    }
  }
  console.log();
  console.log("  ⚠️  Credentials faux → aucun booking réel effectué (rejet serveur attendu).");
  console.log();
}

main().catch((err) => {
  console.error("\n💥 Erreur non gérée :", err);
  process.exit(1);
});
