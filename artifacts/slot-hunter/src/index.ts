import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, getPendingBotTest, type HunterJob, getActiveCevSessions, recordCevSessionCheck, getPendingCevSetups, resetCevSetupLock, recordCevSetupLoginFail, reportSlotFound, loadCevBookingConfig, getSpainWatcherConfig, uploadFile, reportSpainWatcherScan } from "./convexClient.js";
import { runHunterSession, runBotTestSession, type SessionResult } from "./navigator.js";
import { runCevCheck, runCevDirectSessionSetup, bookWithExistingSession } from "./cevBooking.js";
import { bookCevViaHttp, setCevDiscoveredConfig } from "./cevHttpBooking.js";
import { pollCevSlot } from "./cevPolling.js";
import { setupCevSessionHttp } from "./cevHttpSetup.js";
import { navigateCevRedirectWithPlaywright } from "./cevPlaywrightNavigate.js";
import { USA_ENC_SEC_KEY, updateAesKey } from "./usaPortal.js";
import { proxyPool } from "./browser.js";
import { detectPublicIp } from "./proxyPool.js";
import { runSpainSession, runSpainWatcherProbe } from "./spainPortal.js";

// ─── CEV Setup loop — établissement automatique de sessions (needs_setup) ────
// Tourne en background ; pour chaque session needs_setup claimée :
// lance un Playwright qui navigue vers l'URL directe, résout hCaptcha, persiste le cookie.
// Coût : ~60-120s par setup (captcha externe), zéro VOWINT requis.

// Timeout global par setup : 4 min (le lock Convex dure 13 min)
const CEV_SETUP_TIMEOUT_MS = 4 * 60_000;

async function startCevSetupLoop(): Promise<void> {
  console.log("[CEV-SETUP] Boucle de setup sessions CEV démarrée");
  let heartbeatCounter = 0;
  while (true) {
    try {
      const pending = await getPendingCevSetups();
      heartbeatCounter++;

      // Log à chaque itération pour diagnostic (setup peut prendre plusieurs minutes)
      console.log(`[CEV-SETUP] ♥ check — ${pending.length} session(s) à établir (iter=${heartbeatCounter})`);


      // Séquentiellement (Playwright est lourd, pas en parallèle)
      for (const s of pending) {
        const isCredMode = !!(s.vowintEmail && s.vowintPassword);
        console.log(
          `[CEV-SETUP] ▶ Établissement session=${s.sessionId} mode=${isCredMode ? "vowint-credentials" : "url-direct"}`
        );

        // ── Stratégie 1 : HTTP pur (rapide, ~5s, pas de Playwright) ──────────
        // Essayer d'abord en HTTP si on a les credentials VOWINT
        let r: { success: boolean; error?: string; sessionCookie?: string; validUntilMs?: number; integrationUrl?: string };

        if (isCredMode) {
          console.log(`[CEV-SETUP] 🌐 Tentative HTTP pur session=${s.sessionId}...`);
          const httpResult = await setupCevSessionHttp(
            s.vowintEmail!,
            s.vowintPassword!,
            s.applicationId,
            s.applicationId,
            s.vowintAppUrl,
          );

          if (httpResult.success) {
            // ── APPROCHE HYBRIDE ─────────────────────────────────────────────
            // Si needsPlaywrightNavigation = true : le cookie est obtenu mais le
            // poll direct (401) ne marche pas. On lance Playwright pour naviguer
            // vers redirectUrl avec le cookie injecté — PAS de re-login, PAS de re-captcha.
            // Coût : 0 clic VOWINT, 0 captcha, juste ~10s de browser.
            if (httpResult.needsPlaywrightNavigation && httpResult.redirectUrl) {
              console.log(`[CEV-SETUP] 🎭 Approche hybride session=${s.sessionId} — Playwright navigue vers redirectUrl (cookie déjà obtenu)`);

              const fullCookie = `ASP.NET_SessionId=${httpResult.sessionCookie}; PreferredCulture=en-US`;
              const navResult = await navigateCevRedirectWithPlaywright(
                fullCookie,
                httpResult.redirectUrl,
                s.applicationId,
              );

              if (navResult.status === "slot_found") {
                // 🚨 SLOTS TROUVÉS — activer la session pour booking
                console.log(`[CEV-SETUP] 🚨 SLOTS TROUVÉS via hybride session=${s.sessionId}!`);
                const { activateCevSession } = await import("./convexClient.js");
                await activateCevSession(
                  s.sessionId,
                  httpResult.sessionCookie!,
                  httpResult.validUntilMs,
                  httpResult.integrationUrl,
                );
                // Déclencher le booking immédiatement
                await reportSlotFound({
                  applicationId: s.applicationId,
                  date: "detection_hybride",
                  time: new Date().toISOString(),
                  location: "CEV - Ambassade de Belgique (hybride)",
                });
                r = { success: true };
              } else if (navResult.status === "no_availability") {
                // Pas de créneaux — session consommée (single-use), lock maintenu 13 min
                console.log(`[CEV-SETUP] ℹ️  Pas de créneaux (hybride) session=${s.sessionId} — lock expire dans ~13 min`);
                r = { success: true }; // Pas une erreur, juste pas de slots
              } else {
                // Erreur navigation
                console.log(`[CEV-SETUP] ❌ Erreur hybride session=${s.sessionId}: ${navResult.error}`);
                r = { success: false, error: navResult.error ?? "PLAYWRIGHT_NAV_ERROR" };
              }
            } else {
              // Cas normal : poll direct a fonctionné (no_slots ou slots_found)
              console.log(`[CEV-SETUP] 🔑 Session HTTP réussie session=${s.sessionId} — activation pour polling (slotsAvailable=${httpResult.slotsAvailable})`);
              const { activateCevSession } = await import("./convexClient.js");
              const activated = await activateCevSession(
                s.sessionId,
                httpResult.sessionCookie!,
                httpResult.validUntilMs,
                httpResult.integrationUrl,
              );
              if (activated) {
                r = { success: true };
                if (httpResult.slotsAvailable) {
                  console.log(`[CEV-SETUP] 🚨 SLOTS POSSIBLES session=${s.sessionId} — booking prioritaire`);
                } else {
                  console.log(`[CEV-SETUP] 📡 Session activée pour polling session=${s.sessionId}`);
                }
              } else {
                r = { success: false, error: "CONVEX_ACTIVATE_FAILED" };
              }
            }
          } else {
            console.log(`[CEV-SETUP] 🌐 HTTP échoué (${httpResult.error}) — fallback Playwright...`);
            r = { success: false, error: httpResult.error };
          }
        } else {
          r = { success: false, error: "NO_CREDENTIALS_FOR_HTTP" };
        }

        // ── Stratégie 2 : Playwright (fallback si HTTP échoue) ───────────────
        // NE PAS lancer Playwright si :
        // - CEV_VOWINT_SESSION_FAILED : identifiants VOWINT invalides
        // - CEV_SESSION_DEAD_NO_POLL : cookie CEV ne permet pas le poll direct (401)
        //   → le serveur exige de naviguer vers redirectUrl, ce qui TUE la session.
        //   Playwright ferait la même chose et grillerait un clic VOWINT pour rien.
        //   → Laisser le lock 13 min expirer naturellement.
        // - RATE_LIMIT / ErrorTooManyAttempts : compte bloqué 60 min
        const skipPlaywright = (
          r.error === "CEV_VOWINT_SESSION_FAILED" ||
          (r.error ?? "").includes("RATE_LIMIT") ||
          (r.error ?? "").includes("TooManyAttempts")
        );

        if (!r.success && !skipPlaywright) {
          // Timeout global de 4 min — si Playwright bloque
          let timedOut = false;
          const timeoutHandle = setTimeout(() => { timedOut = true; }, CEV_SETUP_TIMEOUT_MS);

          const playwrightResult = await Promise.race([
            runCevDirectSessionSetup(
              isCredMode
                ? { vowintEmail: s.vowintEmail!, vowintPassword: s.vowintPassword!, vowintAppUrl: s.vowintAppUrl }
                : s.integrationUrl,
              s.sessionId,
              s.applicationId,
            ),
            new Promise<{ success: false; error: string }>(resolve =>
              setTimeout(() => resolve({ success: false, error: "TIMEOUT_4MIN" }), CEV_SETUP_TIMEOUT_MS)
            ),
          ]);
          clearTimeout(timeoutHandle);

          r = playwrightResult;
          if (!r.success && (timedOut || r.error === "TIMEOUT_4MIN")) {
            r = { success: false, error: "TIMEOUT_4MIN" };
          }
        }

        if (r.success) {
          console.log(`[CEV-SETUP] ✅ Session établie session=${s.sessionId}`);
          // NE PAS resetCevSetupLock ici — le lock de 13 min doit expirer naturellement
          // pour respecter la limite de 5 clics/heure VOWINT.
          // On ne reset le lock que si la session a été activée (slots trouvés),
          // car dans ce cas le status passe à "active" et la session sort du pool needs_setup.
          // Pour le cas "pas de créneaux", la session reste needs_setup et le lock
          // empêche un re-check avant 13 min (60/5 = 12 min minimum entre clics).
        } else {
          console.log(`[CEV-SETUP] ❌ Échec session=${s.sessionId}: ${r.error}`);

          const isLoginFailure = r.error === "CEV_VOWINT_SESSION_FAILED";
          const isTimeout = r.error === "TIMEOUT_4MIN";
          const isSessionDead = r.error === "CEV_SESSION_DEAD_NO_POLL";
          const isTooManyAttempts = (r.error ?? "").includes("TooManyAttempts") || (r.error ?? "").includes("RATE_LIMIT");
          // Ne pas compter comme login failure si c'est un rate limit (bouton désactivé)
          // ou si le setup a été déclenché par un auto_renewal (session expirée normalement)
          const isRateLimit = isTooManyAttempts;

          if (isTooManyAttempts) {
            // VOWINT rate-limit atteint (5 clics/heure) — PAUSER la session
            // Le compte est bloqué pendant 60 minutes par VOWINT.
            console.log(`[CEV-SETUP] 🚫 RATE-LIMIT VOWINT session=${s.sessionId} — session PAUSÉE (60 min de blocage VOWINT)`);
            try {
              const loginResult = await recordCevSetupLoginFail(s.sessionId, r.error ?? "RATE_LIMIT_TOO_MANY_ATTEMPTS");
              if (loginResult.paused) {
                console.log(`[CEV-SETUP] 🔐 Session=${s.sessionId} AUTO-PAUSÉE — trop de clics bouton RDV`);
              }
            } catch (err) {
              console.warn(`[CEV-SETUP] recordCevSetupLoginFail échoué: ${err}`);
            }
            // NE PAS reset le lock — laisser expirer naturellement (13 min)
          } else if (isSessionDead) {
            // Le cookie CEV seul ne permet pas le poll API (401).
            // Le serveur exige de naviguer vers redirectUrl, ce qui consumer la session.
            // → NE PAS relancer Playwright (même résultat), NE PAS reset le lock.
            // → Laisser le lock de 13 min expirer naturellement.
            // → Le prochain cycle fera un nouveau setup complet (1 clic VOWINT).
            console.log(`[CEV-SETUP] 🔒 Session=${s.sessionId} cookie seul insuffisant pour poll (401) — lock maintenu 13 min`);
            // Pas de resetCevSetupLock → la session ne sera pas re-tentée avant 13 min
          } else if (isLoginFailure && !isRateLimit) {
            // Échec de login VOWINT : incrémenter le compteur persisté dans Convex.
            // Après 3 échecs cumulés (même après redémarrages Railway) → session auto-pausée.
            try {
              const loginResult = await recordCevSetupLoginFail(s.sessionId, r.error);
              if (loginResult.paused) {
                console.log(`[CEV-SETUP] 🔐 Session=${s.sessionId} AUTO-PAUSÉE après ${loginResult.loginFailCount} échecs de login — vérifier identifiants VOWINT`);
              } else {
                console.log(`[CEV-SETUP] ⚠️  Login fail #${loginResult.loginFailCount}/3 session=${s.sessionId} — lock libéré, prochaine tentative dans 60s`);
              }
            } catch (err) {
              console.warn(`[CEV-SETUP] recordCevSetupLoginFail échoué: ${err} — reset lock pour retry`);
              await resetCevSetupLock(s.sessionId).catch(() => {});
            }
          } else if (isTimeout) {
            // Timeout Playwright : déverrouiller pour permettre une nouvelle tentative immédiate
            console.log(`[CEV-SETUP] 🔓 Déverrouillage session=${s.sessionId} (timeout)`);
            await resetCevSetupLock(s.sessionId).catch(() => {});
          }
          // Autres erreurs (HCAPTCHA_FAILED, NO_SESSION_COOKIE…) : le lock expire naturellement (13 min)
        }
      }
    } catch (err) {
      console.warn("[CEV-SETUP] Erreur boucle:", err);
    }

    // Intervalle de boucle : 60s. Le rate limiting est géré par le lock Convex (13 min)
    // qui empêche de re-checker la même session trop vite.
    // Avec un lock de 13 min → max ~4-5 checks/heure par session.
    // La limite VOWINT est 5 clics/heure → le lock de 13 min la respecte avec marge.
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

// ─── CEV Sessions polling — boucle parallèle indépendante ───────────────────
// Tourne en background sans bloquer la boucle principale du bot Playwright.
// Pour chaque session active : check toutes les pollIntervalMs (défaut 30s).
// Coût : ~50ms par check, zéro captcha, zéro Playwright.
async function startCevPollingLoop(): Promise<void> {
  console.log("[CEV-POLL] Boucle de polling sessions CEV démarrée");
  while (true) {
    try {
      // L'API fait le claim atomique côté Convex : on ne reçoit QUE des sessions
      // dues qui sont maintenant lockées 30s pour empêcher un autre worker
      // (instance dupliquée, redémarrage) de les check en parallèle.
      const due = await getActiveCevSessions();

      if (due.length > 0) {
        console.log(`[CEV-POLL] ${due.length} session(s) claimée(s) à checker`);
      }

      // Check séquentiel — évite les bursts parallèles qui génèrent des 500 Convex
      for (const s of due) {
        const t0 = Date.now();
        const r = await pollCevSlot(s.integrationUrl, s.sessionCookie);
        const ms = Date.now() - t0;

        if (r.status === "slot_found") {
          console.log(`[CEV-POLL] 🚨 SLOT TROUVÉ session=${s.sessionId} (${ms}ms) — lancement booking Playwright`);
          // Notifier Convex immédiatement (état "slot_found" visible côté admin)
          await recordCevSessionCheck(s.sessionId, "slot_found");

          // ── Stratégie primaire : HTTP pur (~5-10s, sans Playwright) ──────────
          // ── Fallback       : Playwright UI (~2-3 min, si HTTP échoue) ────────
          try {
            let booked = false;
            let bookedDate: string | undefined;
            let bookedTime: string | undefined;
            let bookedCode: string | undefined;
            let bookedScreenshot: string | undefined;

            // Tentative 1 : HTTP pur (rapide, zéro browser)
            console.log(`[CEV-POLL] 🌐 Tentative booking HTTP session=${s.sessionId}...`);
            const httpResult = await bookCevViaHttp(s.integrationUrl, s.sessionCookie, s.applicationId);

            if (httpResult.success) {
              booked        = true;
              bookedDate    = httpResult.bookedDate;
              bookedTime    = httpResult.bookedTime;
              bookedCode    = httpResult.confirmationCode;
              console.log(`[CEV-POLL] ✅ BOOKING HTTP RÉUSSI session=${s.sessionId} code=${bookedCode ?? 'N/A'} date=${bookedDate ?? '?'}`);
            } else if (httpResult.needsPlaywright !== false) {
              // HTTP a signalé qu'un Playwright peut mieux gérer (form complexe, redirect, etc.)
              console.log(`[CEV-POLL] 🎭 HTTP insuffisant (${httpResult.error}) — fallback Playwright session=${s.sessionId}...`);
              const playwrightResult = await bookWithExistingSession(
                s.integrationUrl,
                s.sessionCookie,
                s.applicationId,
              );
              if (playwrightResult.success) {
                booked           = true;
                bookedDate       = playwrightResult.bookedDate;
                bookedTime       = playwrightResult.bookedTime;
                bookedCode       = playwrightResult.confirmationCode;
                bookedScreenshot = playwrightResult.screenshotStorageId;
                console.log(`[CEV-POLL] ✅ BOOKING PLAYWRIGHT RÉUSSI session=${s.sessionId} code=${bookedCode ?? 'N/A'} date=${bookedDate ?? '?'}`);
              } else {
                console.log(`[CEV-POLL] ❌ Playwright aussi échoué session=${s.sessionId}: ${playwrightResult.error}`);
              }
            } else {
              // HTTP a retourné une erreur définitive (ex: SESSION_EXPIRED, NO_AVAILABILITY)
              console.log(`[CEV-POLL] ❌ Booking HTTP erreur définitive session=${s.sessionId}: ${httpResult.error}`);
            }

            if (booked) {
              // Notifier Convex → markSlotFound → timer 48h + paywall succès
              await reportSlotFound({
                applicationId:       s.applicationId,
                date:                bookedDate          ?? '',
                time:                bookedTime          ?? '',
                location:            'CEV - Ambassade de Belgique',
                confirmationCode:    bookedCode,
                screenshotStorageId: bookedScreenshot,
              });
            }
            // Si booking échoué : session déjà marquée "slot_found" dans Convex → admin peut intervenir
          } catch (bookErr) {
            console.warn(`[CEV-POLL] Crash booking session=${s.sessionId}:`, bookErr);
          }
        } else if (r.status === "session_expired") {
          console.log(`[CEV-POLL] ⏱️  Session expirée session=${s.sessionId} (${ms}ms) — demande re-setup...`);
          await recordCevSessionCheck(s.sessionId, "session_expired", "auto_renewal_requested");
          // Reset le lock/compteur d'échecs pour que la boucle de setup puisse reprendre
          // (sinon l'auto-pause bloque indéfiniment après 3 anciens échecs)
          await resetCevSetupLock(s.sessionId).catch(() => {});
        } else if (r.status === "error") {
          console.log(`[CEV-POLL] ❌ Erreur session=${s.sessionId}: ${r.error} (${ms}ms)`);
          await recordCevSessionCheck(s.sessionId, "error", r.error);
        } else {
          // no_slot — log discret
          await recordCevSessionCheck(s.sessionId, "no_slot");
        }
      }
    } catch (err) {
      console.warn("[CEV-POLL] Erreur boucle:", err);
    }

    // Polling fréquent (5s) — la condition "due" filtre selon pollIntervalMs de chaque session
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

// ─── Tier intervals : temps MINIMUM entre deux checks du MÊME dossier ──────
// tres_urgent : 3-5 min hors rush, 1-2 min pendant les rush hours.
// Safe car le token JWT USA est en cache 55 min → aucun re-login supplémentaire.
const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent:  { min:  3 * 60_000, max:  5 * 60_000 },
  urgent:       { min: 15 * 60_000, max: 20 * 60_000 },
  prioritaire:  { min: 25 * 60_000, max: 35 * 60_000 },
  standard:     { min: 45 * 60_000, max: 60 * 60_000 },
};

// ─── Rush Hours : fenêtres de sortie de créneaux — consulat USA Kinshasa ────
// Heure locale Kinshasa = UTC+1. Estimations basées sur les patterns observés :
//   00h00-02h00 → maintenance système / libération nocturne
//   07h00-09h00 → ouverture de journée
//   12h00-14h00 → pause déjeuner (annulations traitées)
// Pendant ces fenêtres, tres_urgent passe à 1-2 min (toujours safe, token en cache).
const RUSH_WINDOWS: { start: number; end: number }[] = [
  { start:  0, end:  2 },
  { start:  7, end:  9 },
  { start: 12, end: 14 },
];
const RUSH_INTERVAL_MIN_MS =      60_000; // 1 min
const RUSH_INTERVAL_MAX_MS =  2 * 60_000; // 2 min
const RUSH_SILENCE_MIN_MS   =      45_000; // 45 s
const RUSH_SILENCE_MAX_MS   =      90_000; // 90 s

// Kinshasa = UTC+1
function getKinshasaHour(): number {
  return (new Date().getUTCHours() + 1) % 24;
}

function isRushHour(): boolean {
  const h = getKinshasaHour();
  return RUSH_WINDOWS.some(({ start, end }) => h >= start && h < end);
}

// ─── Silence Radio : IP cooldown entre deux incursions consécutives ─────────
// Normal : 2-3 min entre dossiers de tiers DIFFÉRENTS.
// Entre dossiers du MÊME tier (stagger mode) : réduit à 30-60s pour maximiser
// la couverture temporelle — les scans sont déjà décalés dans l'intervalle.
// Rush hours : 45-90 s (session USA API ~2 min → cycle total ~3 min).
const SILENCE_RADIO_MIN_MS = 2 * 60_000;
const SILENCE_RADIO_MAX_MS = 3 * 60_000;
const SILENCE_RADIO_SAME_TIER_MIN_MS = 30_000;  // 30s entre dossiers staggerés
const SILENCE_RADIO_SAME_TIER_MAX_MS = 60_000;  // 60s entre dossiers staggerés

// ─── Polling quand aucun job n'est dû ───────────────────────────────────────
const IDLE_POLL_MIN_MS = 60_000;
const IDLE_POLL_MAX_MS = 90_000;

const URGENCY_ORDER: Record<string, number> = {
  tres_urgent: 0,
  urgent: 1,
  prioritaire: 2,
  standard: 3,
};

const MAX_LOGIN_FAILURES = 3;
// Auto-pause après N erreurs transitoires consécutives (429/403/réseau) sur le même dossier.
// Évite d'harceler le portail en boucle si le compte est rate-limité ou bloqué.
const MAX_CONSECUTIVE_ERRORS = 5;

// ─── Stagger : décalage automatique des dossiers pour couverture maximale ───
// Quand plusieurs dossiers partagent le même tier (ex: 3× tres_urgent),
// leurs échéances sont réparties uniformément dans l'intervalle du tier.
// Ex: tier tres_urgent (3-5 min), 3 dossiers → décalés de ~1m20 entre eux.
// Cela garantit une couverture quasi-continue au lieu de 3 scans simultanés.
const staggerOffsets = new Map<string, number>(); // jobId → offset en ms
let lastStaggeredTier: string | null = null; // pour le silence radio réduit

// ─── Vérification bundle portail USA (clé AES) ───────────────────────────────
// Une fois par jour : télécharge le bundle Angular du portail et vérifie que
// la clé AES hardcodée est toujours présente. Si elle a changé, pause tous les
// jobs USA et logue une alerte claire pour correction manuelle.
const BUNDLE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastBundleCheckAt = 0; // 0 = jamais vérifié → s'exécute au démarrage

const consecutiveLoginFailures = new Map<string, number>();
const consecutiveErrors = new Map<string, number>();
const pausedJobs = new Set<string>();
// Jobs terminés (slot_found) — ne doivent PAS être reset par syncAdminResets.
// Seul un changement explicite dans Convex (isActive=false puis true) peut les relancer.
const completedJobs = new Set<string>();

function log(level: "INFO" | "WARN" | "ERROR", msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

/**
 * Prochaine échéance planifiée par job, calculée une seule fois après chaque cycle.
 * Séparé de getIntervalMs pour éviter les effets de bord lors des appels multiples
 * à getNextCheckDue dans le même tour de boucle (filter + sort + getTimeUntilNextDue).
 */
const scheduledNextDue = new Map<string, number>();

/**
 * Génère un intervalle aléatoire pour un tier, en évitant de répéter
 * une valeur trop proche de la dernière utilisée pour ce tier.
 * Pour tres_urgent pendant une rush hour : utilise RUSH_INTERVAL (1-2 min).
 * À appeler UNE SEULE FOIS par cycle (dans handleResult), pas dans getNextCheckDue.
 */
const lastIntervalUsed = new Map<string, number>();
let lastRushState: boolean | null = null; // pour logger les transitions rush ↔ normal

function generateIntervalMs(urgencyTier: string): number {
  const rush = urgencyTier === "tres_urgent" && isRushHour();

  // Logger les transitions rush ↔ normal
  if (rush !== lastRushState) {
    lastRushState = rush;
    if (rush) {
      const h = getKinshasaHour();
      log("INFO", `⚡ RUSH HOUR activé (${h}h00 Kinshasa) — intervalle tres_urgent → 1-2 min`);
    } else {
      log("INFO", "📻 RUSH HOUR terminé — retour intervalle normal tres_urgent (3-5 min)");
    }
  }

  const cfg = rush
    ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
    : (URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard);

  const last = lastIntervalUsed.get(urgencyTier);
  // Anti-répétition : écart minimal 30s en rush, 90s en normal
  const minGap = rush ? 30_000 : 90_000;
  let interval = cfg.min + Math.random() * (cfg.max - cfg.min);

  if (last !== undefined) {
    let attempts = 0;
    while (Math.abs(interval - last) < minGap && attempts < 6) {
      interval = cfg.min + Math.random() * (cfg.max - cfg.min);
      attempts++;
    }
  }

  lastIntervalUsed.set(urgencyTier, interval);
  return Math.round(interval);
}

function getSilenceRadioMs(): number {
  if (isRushHour()) {
    return Math.round(RUSH_SILENCE_MIN_MS + Math.random() * (RUSH_SILENCE_MAX_MS - RUSH_SILENCE_MIN_MS));
  }
  // Silence réduit si le prochain job est du même tier (scans staggerés)
  if (lastStaggeredTier !== null) {
    return Math.round(SILENCE_RADIO_SAME_TIER_MIN_MS + Math.random() * (SILENCE_RADIO_SAME_TIER_MAX_MS - SILENCE_RADIO_SAME_TIER_MIN_MS));
  }
  return Math.round(SILENCE_RADIO_MIN_MS + Math.random() * (SILENCE_RADIO_MAX_MS - SILENCE_RADIO_MIN_MS));
}

function formatMs(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m${sec}s`;
}

// ─── Stagger : répartition uniforme des dossiers dans l'intervalle du tier ──
/**
 * Calcule et applique les décalages initiaux pour les dossiers actifs.
 * Appelée UNE FOIS au démarrage et quand de nouveaux dossiers apparaissent.
 *
 * Logique : pour N dossiers du même tier, l'intervalle est divisé en N parts.
 * Chaque dossier reçoit un offset = (index / N) × intervalle_tier.
 * Les dossiers sont triés par ID pour garantir un ordre stable.
 *
 * Ex: 3 dossiers tres_urgent (intervalle moyen 4 min) :
 *   - Dossier A : offset 0s   → scan à T+0
 *   - Dossier B : offset 80s  → scan à T+1m20
 *   - Dossier C : offset 160s → scan à T+2m40
 *   → Couverture : un scan toutes les ~80s au lieu de 3 en même temps
 */
function staggerInitialSchedules(jobs: HunterJob[]): void {
  const activeJobs = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    !completedJobs.has(j.id),
  );

  // Grouper par tier
  const byTier = new Map<string, HunterJob[]>();
  for (const job of activeJobs) {
    const tier = job.urgencyTier ?? "standard";
    const group = byTier.get(tier) ?? [];
    group.push(job);
    byTier.set(tier, group);
  }

  const now = Date.now();

  for (const [tier, tierJobs] of byTier.entries()) {
    if (tierJobs.length <= 1) continue; // Pas besoin de stagger pour un seul dossier

    // Trier par ID pour un ordre stable (même résultat à chaque appel)
    tierJobs.sort((a, b) => a.id.localeCompare(b.id));

    const rush = tier === "tres_urgent" && isRushHour();
    const cfg = rush
      ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
      : (URGENCY_INTERVAL[tier] ?? URGENCY_INTERVAL.standard);
    const avgInterval = (cfg.min + cfg.max) / 2;

    // Diviser l'intervalle en N parts égales
    const staggerStep = Math.round(avgInterval / tierJobs.length);

    for (let i = 0; i < tierJobs.length; i++) {
      const job = tierJobs[i];
      const offset = i * staggerStep;
      staggerOffsets.set(job.id, offset);

      // Ne planifier que si le job n'a PAS déjà une échéance (premier démarrage)
      if (!scheduledNextDue.has(job.id)) {
        const due = now + offset;
        scheduledNextDue.set(job.id, due);
      }
    }

    log("INFO", `📐 Stagger ${tier}: ${tierJobs.length} dossiers décalés de ${formatMs(staggerStep)} (intervalle ${formatMs(avgInterval)})`);
    for (let i = 0; i < tierJobs.length; i++) {
      const job = tierJobs[i];
      const offset = staggerOffsets.get(job.id) ?? 0;
      log("INFO", `   └─ [${job.applicantName}] offset +${formatMs(offset)}`);
    }
  }
}

/**
 * Retourne l'heure planifiée pour le prochain check du job.
 * Lit depuis scheduledNextDue (calculé une seule fois dans handleResult).
 * Si aucune valeur n'est encore planifiée (premier cycle), retourne 0 → dû immédiatement.
 */
function getNextCheckDue(job: HunterJob): number {
  const scheduled = scheduledNextDue.get(job.id);
  if (scheduled !== undefined) return scheduled;
  // Fallback : si Convex a un lastCheckAt, utiliser un intervalle minimum fixe
  const lastCheck = job.lastCheckAt ?? job.hunterConfig.lastCheckAt;
  if (!lastCheck) return 0;
  const cfg = URGENCY_INTERVAL[job.urgencyTier] ?? URGENCY_INTERVAL.standard;
  return lastCheck + cfg.min;
}

function findNextDueJob(jobs: HunterJob[]): HunterJob | null {
  const now = Date.now();

  const due = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    getNextCheckDue(j) <= now,
  );

  if (due.length === 0) return null;

  due.sort((a, b) => {
    const tierDiff = (URGENCY_ORDER[a.urgencyTier] ?? 3) - (URGENCY_ORDER[b.urgencyTier] ?? 3);
    if (tierDiff !== 0) return tierDiff;
    return getNextCheckDue(a) - getNextCheckDue(b);
  });

  return due[0];
}

/**
 * Vérifie si un autre dossier du même tier est dû prochainement (< 2 min).
 * Utilisé pour décider si le silence radio doit être réduit (mode stagger).
 * Ignore le dossier qu'on vient de traiter (currentTier match + pas le même job).
 */
function findNextDueJobSoon(jobs: HunterJob[], currentTier: string): HunterJob | null {
  const now = Date.now();
  const soonThreshold = now + 2 * 60_000; // dans les 2 prochaines minutes

  const candidates = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    !completedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    j.urgencyTier === currentTier &&
    getNextCheckDue(j) <= soonThreshold &&
    getNextCheckDue(j) > now, // pas encore dû mais bientôt
  );

  return candidates.length > 0 ? candidates[0] : null;
}

function getTimeUntilNextDue(jobs: HunterJob[]): number {
  const now = Date.now();

  const active = jobs.filter((j) =>
    !pausedJobs.has(j.id) &&
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl,
  );

  if (active.length === 0) return IDLE_POLL_MAX_MS;

  const minDue = Math.min(...active.map((j) => getNextCheckDue(j)));
  const waitMs = Math.max(minDue - now, 0);

  return Math.min(Math.max(waitMs, IDLE_POLL_MIN_MS), IDLE_POLL_MAX_MS);
}

function syncAdminResets(freshJobs: HunterJob[]): void {
  const freshJobIds = new Set(freshJobs.map((j) => j.id));

  for (const jobId of pausedJobs) {
    if (!freshJobIds.has(jobId)) {
      // Job supprimé de Convex — nettoyer toutes les structures pour éviter une fuite mémoire.
      pausedJobs.delete(jobId);
      completedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);
      continue;
    }
    // Ne JAMAIS reset un job terminé (slot_found) automatiquement.
    // Un job completed ne peut reprendre que si l'admin le désactive puis le réactive
    // (transition isActive false → true), ce qui est géré côté Convex.
    if (completedJobs.has(jobId)) {
      continue;
    }
    const freshJob = freshJobs.find((j) => j.id === jobId);
    if (freshJob && freshJob.hunterConfig.isActive) {
      log("INFO", `[${freshJob.applicantName}] Admin reset détecté — reprise`);
      pausedJobs.delete(jobId);
      consecutiveLoginFailures.delete(jobId);
      consecutiveErrors.delete(jobId);
      scheduledNextDue.delete(jobId);  // forcer un check immédiat après reset admin
    }
  }

  // Nettoyer completedJobs pour les jobs supprimés de Convex
  for (const jobId of completedJobs) {
    if (!freshJobIds.has(jobId)) completedJobs.delete(jobId);
  }

  for (const jobId of consecutiveLoginFailures.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveLoginFailures.delete(jobId);
  }
  for (const jobId of consecutiveErrors.keys()) {
    if (!freshJobIds.has(jobId)) consecutiveErrors.delete(jobId);
  }
  for (const jobId of scheduledNextDue.keys()) {
    if (!freshJobIds.has(jobId)) scheduledNextDue.delete(jobId);
  }
  for (const jobId of staggerOffsets.keys()) {
    if (!freshJobIds.has(jobId)) staggerOffsets.delete(jobId);
  }
}

async function handleResult(job: HunterJob, result: SessionResult): Promise<void> {
  log("INFO", `[${job.applicantName}] Résultat: ${result}`);

  switch (result) {
    case "slot_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      pausedJobs.add(job.id);
      completedJobs.add(job.id);
      log("INFO", `[${job.applicantName}] ✅ CRÉNEAU TROUVÉ — dossier retiré de la file`);
      return; // pas de reschedule : le job est terminé

    case "login_failed": {
      consecutiveErrors.delete(job.id);
      const loginFails = (consecutiveLoginFailures.get(job.id) ?? 0) + 1;
      consecutiveLoginFailures.set(job.id, loginFails);
      log("WARN", `[${job.applicantName}] Échec login #${loginFails}/${MAX_LOGIN_FAILURES}`);

      if (loginFails >= MAX_LOGIN_FAILURES) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_LOGIN_FAILURES} échecs consécutifs — auto-pause`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${loginFails} login failures consécutives — vérifier les identifiants`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
        return; // pas de reschedule : le job est en pause
      }
      break;
    }

    case "error": {
      consecutiveLoginFailures.delete(job.id);
      const errCount = (consecutiveErrors.get(job.id) ?? 0) + 1;
      consecutiveErrors.set(job.id, errCount);
      log("WARN", `[${job.applicantName}] Erreur transitoire #${errCount}/${MAX_CONSECUTIVE_ERRORS} — prochain cycle selon tier`);

      // Auto-pause si le dossier génère trop d'erreurs consécutives (429/403/réseau)
      // pour éviter de harceler le portail en boucle sur un compte rate-limité
      if (errCount >= MAX_CONSECUTIVE_ERRORS) {
        pausedJobs.add(job.id);
        log("ERROR", `[${job.applicantName}] ${MAX_CONSECUTIVE_ERRORS} erreurs consécutives — auto-pause (compte potentiellement bloqué)`);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: `Auto-paused: ${errCount} erreurs transitoires consécutives — vérifier statut portail`,
            shouldPause: true,
          });
        } catch (err) {
          log("WARN", `[${job.applicantName}] Heartbeat pause échoué: ${err}`);
        }
        return; // pas de reschedule : le job est en pause
      }
      break;
    }

    case "captcha":
      log("WARN", `[${job.applicantName}] Bloqué par CAPTCHA — prochain cycle prévu selon tier`);
      break;

    case "payment_required":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      log("WARN", `[${job.applicantName}] 💳 Paiement portail requis — frais consulaires non validés par le portail`);
      break;

    case "not_found":
      consecutiveLoginFailures.delete(job.id);
      consecutiveErrors.delete(job.id);
      log("INFO", `[${job.applicantName}] Aucun créneau disponible`);
      break;
  }

  // Planifier le prochain cycle : générer l'intervalle UNE SEULE FOIS ici,
  // stocké dans scheduledNextDue, lu de façon déterministe par getNextCheckDue.
  // Le stagger est maintenu : on utilise l'intervalle du tier mais on conserve
  // l'offset relatif du dossier pour garder la répartition uniforme.
  const intervalMs = generateIntervalMs(job.urgencyTier);
  const nextDue = Date.now() + intervalMs;
  scheduledNextDue.set(job.id, nextDue);
  log("INFO", `[${job.applicantName}] Prochain check dans ${formatMs(intervalMs)} (${new Date(nextDue).toLocaleTimeString("fr-CD")})`);

  // Tracker le tier du dernier job exécuté pour adapter le silence radio
  lastStaggeredTier = job.urgencyTier;
}

/**
 * Tente d'extraire la clé AES depuis le bundle Angular en clair.
 *
 * Stratégie en deux passes :
 *  1. Cherche une chaîne base64 (44 chars, terminée par "=") au voisinage
 *     immédiat (<300 chars) des mots-clés chiffrement connus dans le bundle.
 *  2. Si rien n'est trouvé, collecte toutes les chaînes base64 de 44 chars
 *     présentes dans le bundle — le portail n'en contient généralement qu'une.
 *
 * Retourne la clé ou null si introuvable.
 */
function extractAesKeyFromBundle(bundleText: string): string | null {
  const KEY_REGEX = /[A-Za-z0-9+/]{43}=/g;
  const CONTEXT_KEYWORDS = ["PBKDF2", "pbkdf2", "encryptSecretKey", "secretKey", "encKey", "AES", "CryptoJS", "encrypt"];

  // Passe 1 : chercher près des mots-clés de chiffrement
  for (const keyword of CONTEXT_KEYWORDS) {
    const idx = bundleText.indexOf(keyword);
    if (idx === -1) continue;
    const window = bundleText.slice(Math.max(0, idx - 300), idx + 300);
    const match = window.match(KEY_REGEX);
    if (match && match[0].length === 44) return match[0];
  }

  // Passe 2 : collecter toutes les chaînes base64 de 44 chars dans le bundle entier
  const allMatches = [...bundleText.matchAll(KEY_REGEX)]
    .map((m) => m[0])
    .filter((s) => s.length === 44);
  if (allMatches.length === 1) return allMatches[0]; // unique → c'est elle

  return null;
}

/**
 * Vérifie une fois par jour que la clé AES du portail USA n'a pas changé.
 *
 * Comportement si la clé a changé :
 *  - Tente d'extraire automatiquement la nouvelle clé depuis le bundle.
 *  - Si trouvée → mise à jour en mémoire immédiate (updateAesKey), les jobs
 *    reprennent sans interruption. Aucun rebuild/redéploiement requis.
 *  - Si introuvable → pause de tous les jobs USA + alerte (cas exceptionnel).
 */
async function checkPortalBundleKey(activeJobs: HunterJob[]): Promise<void> {
  const now = Date.now();
  if (now - lastBundleCheckAt < BUNDLE_CHECK_INTERVAL_MS) return;
  lastBundleCheckAt = now;

  log("INFO", "🔍 Vérification bundle portail USA (quotidienne)...");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  const BUNDLE_CHECK_RETRY_MS = 30 * 60 * 1000;

  try {
    // 1. Trouver le nom du bundle Angular actuel (hash content-based)
    const htmlRes = await fetch("https://www.usvisaappt.com/visaapplicantui/", {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    const html = await htmlRes.text();
    const match = html.match(/src="(main\.[a-f0-9]+\.js)"/);
    if (!match) {
      log("WARN", "🔍 Bundle check : impossible de trouver le nom du bundle — retry dans 30 min");
      lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
      return;
    }
    const bundleName = match[1];

    // 2. Télécharger le bundle
    const bundleRes = await fetch(`https://www.usvisaappt.com/visaapplicantui/${bundleName}`, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.usvisaappt.com/visaapplicantui/login",
      },
    });
    if (!bundleRes.ok) {
      log("WARN", `🔍 Bundle check : téléchargement échoué (HTTP ${bundleRes.status}) — retry dans 30 min`);
      lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
      return;
    }
    const bundleText = await bundleRes.text();

    // 3. Vérifier si la clé actuelle est toujours présente
    if (bundleText.includes(USA_ENC_SEC_KEY)) {
      log("INFO", `🔍 Bundle check ✅ — clé AES inchangée (bundle: ${bundleName})`);
      return;
    }

    // 4. Clé absente → tenter l'extraction automatique
    log("WARN", `🔍 Bundle check : clé AES introuvable dans ${bundleName} — extraction automatique en cours...`);
    const newKey = extractAesKeyFromBundle(bundleText);

    if (newKey) {
      // ✅ Nouvelle clé extraite — mise à jour en mémoire, les jobs continuent
      const oldKey = USA_ENC_SEC_KEY;
      updateAesKey(newKey);
      log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      log("INFO", "🔑 CLÉ AES MISE À JOUR AUTOMATIQUEMENT — aucune action requise");
      log("INFO", `   Bundle         : ${bundleName}`);
      log("INFO", `   Ancienne clé   : ${oldKey}`);
      log("INFO", `   Nouvelle clé   : ${newKey}`);
      log("INFO", "   Les jobs USA reprennent avec la nouvelle clé immédiatement.");
      log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      return;
    }

    // 5. Extraction échouée → pause + alerte (cas exceptionnel — structure du bundle changée)
    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("ERROR", "🔴 ALERTE BUNDLE : clé AES changée ET extraction automatique impossible !");
    log("ERROR", `   Bundle actuel  : ${bundleName}`);
    log("ERROR", `   Clé en code    : ${USA_ENC_SEC_KEY}`);
    log("ERROR", "   ACTION REQUISE : inspecter le bundle manuellement,");
    log("ERROR", "   puis mettre à jour USA_ENC_SEC_KEY dans usaPortal.ts.");
    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const usaJobs = activeJobs.filter((j) => j.destination === "usa");
    for (const job of usaJobs) {
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `⚠️ Clé AES du portail USA changée (bundle: ${bundleName}) et extraction automatique impossible. Intervention requise.`,
          shouldPause: true,
        });
        log("WARN", `[${job.applicantName}] Mis en pause — clé AES périmée et non-extractible`);
      } catch (err) {
        log("WARN", `[${job.applicantName}] Erreur envoi pause heartbeat: ${err}`);
      }
    }
  } catch (err) {
    lastBundleCheckAt = now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS;
    log("WARN", `🔍 Bundle check : erreur réseau — retry dans 30 min (${err})`);
  }
}

// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────
// Boucle indépendante, tourne en background.
// Intervalle configurable depuis Convex (défaut 15 min).
// Si un créneau est trouvé : upload screenshot → Convex → email admin.

async function startSpainWatcherLoop(): Promise<void> {
  log("INFO", "[SPAIN-WATCHER] Boucle démarrée");
  while (true) {
    try {
      const config = await getSpainWatcherConfig();

      if (!config || !config.isActive) {
        // Veilleur inactif ou non configuré — check toutes les 2 min
        await new Promise((r) => setTimeout(r, 2 * 60_000));
        continue;
      }

      const intervalMs = (config.intervalMin ?? 15) * 60_000;
      log("INFO", `[SPAIN-WATCHER] Probe → ${config.portalUrl} (intervalle: ${config.intervalMin ?? 15} min)`);

      const result = await runSpainWatcherProbe(config.portalUrl);
      log(
        "INFO",
        `[SPAIN-WATCHER] Résultat: ${result.status}${result.slotInfo ? ` — ${result.slotInfo}` : ""}${result.errorMessage ? ` (${result.errorMessage})` : ""}`,
      );

      // Upload screenshot si créneau trouvé OU si not_found (diagnostic visuel de la page)
      let screenshotStorageId: string | undefined;
      if ((result.status === "found" || result.status === "not_found") && result.screenshotBase64) {
        screenshotStorageId = await uploadFile(result.screenshotBase64, "image/png") ?? undefined;
      }

      // Reporter le résultat à Convex (qui enverra l'email si found)
      await reportSpainWatcherScan({
        status: result.status,
        slotInfo: result.slotInfo,
        screenshotStorageId,
        errorMessage: result.errorMessage,
      });

      await new Promise((r) => setTimeout(r, intervalMs));
    } catch (err) {
      log("WARN", `[SPAIN-WATCHER] Erreur boucle: ${err} — retry dans 5 min`);
      await new Promise((r) => setTimeout(r, 5 * 60_000));
    }
  }
}

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "true";
  const convexUrl = process.env.CONVEX_SITE_URL;
  const hunterKey = process.env.HUNTER_API_KEY;

  log("INFO", "=== Joventy Hunter démarrage (Joventy Shuffle v2) ===");
  log("INFO", `Mode: ${dryRun ? "DRY RUN" : "PRODUCTION"}`);
  log("INFO", `Convex: ${convexUrl ? "configuré" : "MANQUANT"}`);
  log("INFO", `Hunter API Key: ${hunterKey ? "configurée" : "MANQUANTE"}`);

  // Lancer la boucle de setup CEV en background (établit les sessions needs_setup via Playwright)
  startCevSetupLoop().catch((err) => {
    console.error("[CEV-SETUP] Boucle crashée:", err);
  });

  // Lancer la boucle de polling CEV en background (indépendante de Playwright)
  startCevPollingLoop().catch((err) => {
    console.error("[CEV-POLL] Boucle crashée:", err);
  });

  // Lancer le veilleur Espagne en background (scan créneaux Bookitit citaconsular.es)
  startSpainWatcherLoop().catch((err) => {
    console.error("[SPAIN-WATCHER] Boucle crashée:", err);
  });

  // ─── Auto-config CEV : charger les endpoints confirmés depuis Convex ─────
  // Après le premier booking HTTP réussi, la config est persistée dans Convex.
  // Au prochain démarrage, on la charge en mémoire → skip de la discovery phase.
  // Non bloquant : si Convex est inaccessible, la discovery normale s'enclenche.
  try {
    const savedConfig = await loadCevBookingConfig();
    if (savedConfig) {
      setCevDiscoveredConfig(savedConfig);
      log("INFO", `CEV auto-config chargée ✅ — endpoint=${savedConfig.submitEndpoint} successCount=${savedConfig.successCount}`);
    } else {
      log("INFO", "CEV auto-config: aucune config sauvegardée — discovery complète au premier booking");
    }
  } catch (err) {
    log("WARN", `CEV auto-config: chargement échoué (non bloquant) — ${err}`);
  }

  // Détection IP + initialisation ProxyPool (refresh whitelist 2captcha immédiat + boucle auto 25 min)
  const serverIp = await detectPublicIp();
  if (serverIp) {
    log("INFO", `IP serveur (Railway): ${serverIp}`);
    if (process.env.TWOCAPTCHA_API_KEY) {
      await proxyPool.initialize(serverIp);
    }
  } else {
    log("WARN", "IP serveur: indéterminée (ipify.org inaccessible)");
  }

  const brightdataStatus = process.env.BRIGHTDATA_PROXY_URL ? "BrightData ✅ (CEV belge)" : null;
  const iproyalStatus    = process.env.IPROYAL_PROXY_URL    ? "iProyal ✅ (Espagne)"      : null;
  const fallbackStatus   = proxyPool.isConfigured
    ? `2captcha résidentiel rotatif ✅ (IP: ${serverIp ?? "?"})`
    : process.env.PROXY_URL
      ? "statique (PROXY_URL)"
      : "aucun ⚠️ — IP fixe Railway exposée";
  const proxyStatus = [brightdataStatus, iproyalStatus, fallbackStatus].filter(Boolean).join(" | ");
  log("INFO", `Proxy: ${proxyStatus}`);
  log("INFO", "Intervalles tier — tres_urgent:3-5m (rush:1-2m)  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio: normal ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)} | stagger ${formatMs(SILENCE_RADIO_SAME_TIER_MIN_MS)}–${formatMs(SILENCE_RADIO_SAME_TIER_MAX_MS)} | rush ${formatMs(RUSH_SILENCE_MIN_MS)}–${formatMs(RUSH_SILENCE_MAX_MS)}`);
  log("INFO", `Rush windows Kinshasa (UTC+1): 00h-02h | 07h-09h | 12h-14h — actif maintenant: ${isRushHour() ? "OUI ⚡" : "non"}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  // ─── Statut solveurs hCaptcha CEV ────────────────────────────────────────
  const antiCaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const capsolverKey   = process.env.CAPSOLVER_API_KEY;
  const twoCaptchaKey  = process.env.TWOCAPTCHA_API_KEY;
  const accessCookie   = process.env.HCAPTCHA_ACCESSIBILITY_COOKIE;
  log("INFO", [
    "CEV hCaptcha solveurs:",
    accessCookie ? "Accessibility ✅ (prioritaire)" : "Accessibility ❌ (HCAPTCHA_ACCESSIBILITY_COOKIE absent)",
    antiCaptchaKey ? "AntiCaptcha ✅" : "AntiCaptcha ❌ (ANTICAPTCHA_API_KEY absent — REQUIS pour domaines gov)",
    capsolverKey   ? "CapSolver ✅ (sitekey gov blacklistée en 2026-04 — peut échouer)" : "CapSolver ❌",
    twoCaptchaKey  ? "2captcha ✅ (hCaptcha non supporté sur ce compte)" : "2captcha ❌",
  ].join(" | "));

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL et HUNTER_API_KEY sont requis — arrêt");
    process.exit(1);
  }

  while (true) {
    try {
      const pendingTest = await getPendingBotTest();
      if (pendingTest) {
        log("INFO", `🧪 Test bot détecté — ${pendingTest.destination} (${pendingTest.portalUrl})`);
        try {
          await runBotTestSession(pendingTest);
          log("INFO", `🧪 Test bot terminé — ${pendingTest.destination}`);
        } catch (err) {
          log("ERROR", `Erreur test bot ${pendingTest.destination}: ${err}`);
        }
        continue;
      }
    } catch (err) {
      log("WARN", `Vérification pending tests échouée (non critique): ${err}`);
    }

    let jobs: HunterJob[];
    try {
      jobs = await getActiveJobs();
    } catch (err) {
      log("ERROR", `Échec récupération jobs: ${err} — retry dans 30s`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }

    syncAdminResets(jobs);

    // Stagger : répartir les dossiers du même tier dans l'intervalle
    // (recalcule si de nouveaux dossiers apparaissent ou si le tier change)
    staggerInitialSchedules(jobs);

    // Vérification quotidienne du bundle portail USA (non bloquante)
    await checkPortalBundleKey(jobs);

    const due = findNextDueJob(jobs);

    if (!due) {
      const waitMs = getTimeUntilNextDue(jobs);
      const activeCount = jobs.filter((j) => !pausedJobs.has(j.id) && j.hunterConfig?.isActive).length;

      if (activeCount === 0) {
        log("INFO", "Aucun dossier actif — polling dans 90s");
      } else {
        const tierCounts = jobs
          .filter((j) => !pausedJobs.has(j.id) && j.hunterConfig?.isActive)
          .reduce<Record<string, number>>((acc, j) => {
            acc[j.urgencyTier] = (acc[j.urgencyTier] ?? 0) + 1;
            return acc;
          }, {});
        const tierStr = Object.entries(tierCounts).map(([t, n]) => `${n}×${t}`).join(", ");
        log("INFO", `Aucun dossier dû (${tierStr}) — prochain check dans ${formatMs(waitMs)}`);
      }

      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const overdueMs = Date.now() - getNextCheckDue(due);
    const overdueStr = overdueMs > 0 ? ` (+${formatMs(overdueMs)} de retard)` : "";
    log("INFO", `▶ [${due.applicantName}] Check ${due.urgencyTier}${overdueStr}`);

    let result: SessionResult;
    try {
      if (due.destination === "schengen") {
        const cevResult = await runCevCheck(due);
        // Mapper SchengenSessionResult → SessionResult
        result = cevResult === "slot_found" ? "slot_found"
               : cevResult === "error"      ? "error"
               : "not_found"; // 'not_found' et 'rate_limited' → pas de créneau, on reschedule normalement
      } else if (due.destination === "spain" || due.destination === "espagne" || due.destination === "es") {
        const spainUrl = due.portalUrl ?? (due.hunterConfig as { scheduleUrl?: string } | undefined)?.scheduleUrl ?? "";
        if (!spainUrl) {
          log("WARN", `[${due.applicantName}] ⚠️ Espagne — URL Bookitit manquante. Renseignez-la dans la config Hunter admin.`);
          await sendHeartbeat({ applicationId: due.id, result: "error", errorMessage: "URL Bookitit Espagne manquante — configurez scheduleUrl dans le panneau admin" });
          result = "error";
        } else {
          log("INFO", `[${due.applicantName}] 🇪🇸 Espagne → ${spainUrl}`);
          result = await runSpainSession(due);
        }
      } else {
        result = await runHunterSession(due);
      }
    } catch (err) {
      result = "error";
      log("ERROR", `[${due.applicantName}] Erreur session non capturée: ${err}`);
    }

    await handleResult(due, result);

    if (result !== "slot_found") {
      // Adapter le silence radio selon le contexte :
      // - Si un autre dossier du même tier est bientôt dû (stagger), silence réduit
      // - Sinon, silence normal pour cooldown IP
      const nextJob = findNextDueJobSoon(jobs, due.urgencyTier);
      if (nextJob) {
        lastStaggeredTier = due.urgencyTier;
      } else {
        lastStaggeredTier = null;
      }
      const silenceMs = getSilenceRadioMs();
      const silenceType = lastStaggeredTier ? "stagger" : isRushHour() ? "rush" : "normal";
      log("INFO", `📻 Silence radio ${formatMs(silenceMs)} (${silenceType})...`);
      await new Promise((r) => setTimeout(r, silenceMs));
    }
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
