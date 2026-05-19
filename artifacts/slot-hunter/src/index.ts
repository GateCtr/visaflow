import * as dotenv from "dotenv";
dotenv.config();

import { getActiveJobs, sendHeartbeat, getPendingBotTest, type HunterJob, getActiveCevSessions, recordCevSessionCheck, getPendingCevSetups, resetCevSetupLock, recordCevSetupLoginFail, reportSlotFound, loadCevBookingConfig, getSpainWatcherConfig, uploadFile, reportSpainWatcherScan, getBotConfigValue } from "./convexClient.js";
import { runHunterSession, runBotTestSession, type SessionResult } from "./navigator.js";
import { runCevCheck, runCevDirectSessionSetup, bookWithExistingSession } from "./cevBooking.js";
import { bookCevViaHttp, setCevDiscoveredConfig } from "./cevHttpBooking.js";
import { pollCevSlot } from "./cevPolling.js";
import { setupCevSessionHttp } from "./cevHttpSetup.js";
import { USA_ENC_SEC_KEY, updateAesKey } from "./usaPortal.js";
import { proxyPool } from "./browser.js";
import { detectPublicIp } from "./proxyPool.js";
import { autoWhitelistIp } from "./ip-whitelist.js";
import { sendAdminBundleCheckReport, type BundleCheckReport } from "./adminReporting.js";
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

  // ── Tracking local des échecs consécutifs par session ──────────────────────
  // Si une session échoue N fois de suite (sans rate-limit explicite détecté),
  // c'est probablement un rate-limit VOWINT non détecté ("onglet mauvais",
  // page d'erreur inattendue, etc.). On escalade vers un lock 60 min.
  const sessionFailTracker = new Map<string, { count: number; firstFailAt: number; lastError: string }>();
  const IMPLICIT_RATE_LIMIT_THRESHOLD = 3; // 3 échecs consécutifs → traiter comme rate-limit
  const IMPLICIT_RATE_LIMIT_WINDOW_MS = 45 * 60_000; // fenêtre de 45 min (3 × lock de 13 min)

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
            // ── Session HTTP activée — le redirect a été suivi, verdict obtenu ──
            // needsPlaywrightNavigation est toujours false maintenant (session activée via HTTP)
            console.log(`[CEV-SETUP] 🔑 Session HTTP réussie session=${s.sessionId} — verdict: slotsAvailable=${httpResult.slotsAvailable}`);
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
                console.log(`[CEV-SETUP] 🚨 SLOTS DISPONIBLES session=${s.sessionId} — booking prioritaire`);
                // Déclencher le booking immédiatement
                await reportSlotFound({
                  applicationId: s.applicationId,
                  date: "detection_http",
                  time: new Date().toISOString(),
                  location: "CEV - Ambassade de Belgique (HTTP pur)",
                });
              } else {
                console.log(`[CEV-SETUP] 📡 Pas de créneaux — session activée pour polling session=${s.sessionId}`);
              }
            } else {
              r = { success: false, error: "CONVEX_ACTIVATE_FAILED" };
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
        // - SESSION_EXPIRED_AFTER_REDIRECT : session activée mais expirée (re-captcha nécessaire)
        // - RATE_LIMIT / ErrorTooManyAttempts : compte bloqué 60 min
        const skipPlaywright = (
          r.error === "CEV_VOWINT_SESSION_FAILED" ||
          r.error === "SESSION_EXPIRED_AFTER_REDIRECT" ||
          r.error === "PLAYWRIGHT_UNAVAILABLE" ||
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
          // Reset le tracker d'échecs consécutifs (succès = pas de rate-limit)
          sessionFailTracker.delete(s.sessionId as string);
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
            // VOWINT rate-limit atteint (5 clics/heure) — lock 60 min + incrémente compteur
            // Le compte est bloqué pendant 60 minutes par VOWINT.
            console.log(`[CEV-SETUP] 🚫 RATE-LIMIT VOWINT session=${s.sessionId} — lock 60 min (blocage VOWINT)`);
            // Reset le tracker implicite — rate-limit explicite détecté, pas besoin d'inférer
            sessionFailTracker.delete(s.sessionId as string);
            try {
              const loginResult = await recordCevSetupLoginFail(s.sessionId, r.error ?? "RATE_LIMIT_TOO_MANY_ATTEMPTS");
              if (loginResult.paused) {
                console.log(`[CEV-SETUP] 🔐 Session=${s.sessionId} AUTO-PAUSÉE — trop de clics bouton RDV (${loginResult.loginFailCount}/3)`);
              } else {
                console.log(`[CEV-SETUP] ⚠️  Rate-limit #${loginResult.loginFailCount}/3 session=${s.sessionId} — prochaine tentative dans 60 min`);
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
                const backoffMin = loginResult.loginFailCount === 1 ? 2 : loginResult.loginFailCount === 2 ? 5 : 10;
                console.log(`[CEV-SETUP] ⚠️  Login fail #${loginResult.loginFailCount}/3 session=${s.sessionId} — prochaine tentative dans ${backoffMin} min`);
              }
            } catch (err) {
              console.warn(`[CEV-SETUP] recordCevSetupLoginFail échoué: ${err}`);
            }
          } else if (isTimeout) {
            // Timeout Playwright : déverrouiller pour permettre une nouvelle tentative immédiate
            console.log(`[CEV-SETUP] 🔓 Déverrouillage session=${s.sessionId} (timeout)`);
            await resetCevSetupLock(s.sessionId).catch(() => {});
          } else {
            // ── Autres erreurs (HCAPTCHA_FAILED, NO_SESSION_COOKIE, NO_INTEGRATION_URL…) ──
            // Tracker les échecs consécutifs : si on échoue trop souvent sans rate-limit
            // explicite, c'est probablement un rate-limit déguisé (ex: VOWINT retourne
            // une page inattendue/"onglet mauvais" au lieu de l'URL d'intégration).
            const sid = s.sessionId as string;
            const tracker = sessionFailTracker.get(sid);
            const now = Date.now();

            if (tracker && (now - tracker.firstFailAt) < IMPLICIT_RATE_LIMIT_WINDOW_MS) {
              tracker.count += 1;
              tracker.lastError = r.error ?? "UNKNOWN";
            } else {
              // Première erreur ou fenêtre expirée → reset
              sessionFailTracker.set(sid, { count: 1, firstFailAt: now, lastError: r.error ?? "UNKNOWN" });
            }

            const currentTracker = sessionFailTracker.get(sid)!;
            if (currentTracker.count >= IMPLICIT_RATE_LIMIT_THRESHOLD) {
              // Trop d'échecs consécutifs dans la fenêtre → traiter comme rate-limit implicite
              console.log(`[CEV-SETUP] 🚫 RATE-LIMIT IMPLICITE session=${s.sessionId} — ${currentTracker.count} échecs en ${Math.round((now - currentTracker.firstFailAt) / 60_000)} min (dernier: ${currentTracker.lastError}) → lock 60 min`);
              try {
                const loginResult = await recordCevSetupLoginFail(s.sessionId, `IMPLICIT_RATE_LIMIT_${currentTracker.count}_FAILURES (dernier: ${currentTracker.lastError})`);
                if (loginResult.paused) {
                  console.log(`[CEV-SETUP] 🔐 Session=${s.sessionId} AUTO-PAUSÉE (rate-limit implicite, ${loginResult.loginFailCount}/3)`);
                } else {
                  console.log(`[CEV-SETUP] ⚠️  Rate-limit implicite #${loginResult.loginFailCount}/3 session=${s.sessionId} — prochaine tentative dans 60 min`);
                }
              } catch (err) {
                console.warn(`[CEV-SETUP] recordCevSetupLoginFail (implicite) échoué: ${err}`);
              }
              // Reset le tracker après escalade
              sessionFailTracker.delete(sid);
            } else {
              console.log(`[CEV-SETUP] ⚠️  Échec ${currentTracker.count}/${IMPLICIT_RATE_LIMIT_THRESHOLD} session=${s.sessionId} (${r.error}) — lock 13 min normal`);
            }
          }
          // Le lock Convex (13 min min) empêche la prochaine tentative pendant un délai raisonnable
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Executable doesn't exist") || errMsg.includes("browserType.launch")) {
        console.warn("[CEV-SETUP] Erreur boucle: Playwright indisponible (image Docker obsolète) — retry dans 60s");
      } else {
        console.warn("[CEV-SETUP] Erreur boucle:", err);
      }
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
          // NE PAS resetCevSetupLock ici — le lock de 3 min posé par internalRecordCheck
          // empêche un re-setup immédiat et évite de spam VOWINT.
          // Le setup reprendra après expiration du lock (3 min minimum entre tentatives).
        } else if (r.status === "error") {
          console.log(`[CEV-POLL] ❌ Erreur session=${s.sessionId}: ${r.error} (${ms}ms)`);
          // Si l'erreur est "URL d'entrée invalide", c'est que l'integrationUrl n'a pas
          // été capturée correctement — marquer session_expired pour forcer un re-setup
          // (mais via le lock de 3 min, pas immédiat).
          if (r.error?.includes("URL d'entrée invalide")) {
            await recordCevSessionCheck(s.sessionId, "session_expired", "auto_renewal_requested");
          } else {
            await recordCevSessionCheck(s.sessionId, "error", r.error);
          }
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

// ─── Mode Parallèle (OFC Watcher partagé) ──────────────────────────────────
// Quand PARALLEL_WATCHER_MODE=1, le polling USA est géré par un OFC Watcher
// partagé + keep-alive per-account. Le scheduler séquentiel n'a plus besoin de :
//   - Stagger (le watcher poll pour tout le monde)
//   - Lancer les sessions de scan USA (runHunterSession) — le watcher s'en charge
// Le scheduler reste actif UNIQUEMENT pour :
//   - Les jobs CEV (schengen) et Espagne (spain/espagne/es)
//   - La vérification du bundle portail USA (clé AES)
//   - Les bot tests manuels
//   - syncAdminResets (détection pause/reprise admin)
const isParallelMode = process.env.PARALLEL_WATCHER_MODE === "1" || process.env.PARALLEL_WATCHER_MODE === "true";

// V3 mode flag — mis à jour au démarrage via bot-config Convex
let isV3Mode = false;

// ─── Tier intervals : temps MINIMUM entre deux checks du MÊME dossier ──────
// tres_urgent : 3-5 min hors rush, 1-2 min pendant les rush hours.
// Safe car le token JWT USA est en cache 55 min → aucun re-login supplémentaire.
const URGENCY_INTERVAL: Record<string, { min: number; max: number }> = {
  tres_urgent:  { min:  5 * 60_000, max: 10 * 60_000 },
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
const RUSH_INTERVAL_MIN_MS =  5 * 60_000; // 5 min — aligné sur le MIN_SCAN_INTERVAL de impl.ts pour éviter les cycles gaspillés
const RUSH_INTERVAL_MAX_MS =  7 * 60_000; // 7 min — garde un avantage vs normal (5-10 min) tout en restant safe
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
const IDLE_POLL_MIN_MS = 30_000;  // FIX 1: réduit à 30s (radio silence est per-dossier maintenant)
const IDLE_POLL_MAX_MS = 45_000;

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

// ─── FIX 1 : Radio Silence PER-DOSSIER ─────────────────────────────────────
// Remplace le `await sleep(2-3min)` global qui bloquait l'event loop.
// Chaque dossier a son propre cooldown. Le scheduler poll toutes les 30s
// et ne lance que les dossiers dont le silence est terminé.
const radioSilenceUntil = new Map<string, number>();

/** Vérifie si un dossier est encore en période de silence radio. */
function isInRadioSilence(jobId: string): boolean {
  const until = radioSilenceUntil.get(jobId);
  if (!until) return false;
  if (Date.now() >= until) {
    radioSilenceUntil.delete(jobId);
    return false;
  }
  return true;
}

/** Applique un silence radio per-dossier après un cycle. */
function applyRadioSilence(jobId: string, sameTierNext: boolean): void {
  let silenceMs: number;
  if (isRushHour()) {
    silenceMs = Math.round(RUSH_SILENCE_MIN_MS + Math.random() * (RUSH_SILENCE_MAX_MS - RUSH_SILENCE_MIN_MS));
  } else if (sameTierNext) {
    silenceMs = Math.round(SILENCE_RADIO_SAME_TIER_MIN_MS + Math.random() * (SILENCE_RADIO_SAME_TIER_MAX_MS - SILENCE_RADIO_SAME_TIER_MIN_MS));
  } else {
    silenceMs = Math.round(SILENCE_RADIO_MIN_MS + Math.random() * (SILENCE_RADIO_MAX_MS - SILENCE_RADIO_MIN_MS));
  }
  radioSilenceUntil.set(jobId, Date.now() + silenceMs);
  const silenceType = isRushHour() ? "rush" : sameTierNext ? "stagger" : "normal";
  log("INFO", `📻 [${jobId.slice(-6)}] Silence radio per-dossier ${formatMs(silenceMs)} (${silenceType})`);
}

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

// ─── Distribution gaussienne pour les intervalles (anti-pattern bot) ─────────
// Un uniform random produit une distribution plate → signature de bot.
// Un humain a un rythme naturel CENTRÉ sur une valeur avec des écarts occasionnels.
// Box-Muller transform : génère un nombre aléatoire normalement distribué.
function gaussianRandom(mean: number, stddev: number, minClamp: number, maxClamp: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const raw = mean + z * stddev;
  return Math.max(minClamp, Math.min(raw, maxClamp));
}

// ─── Skip intelligent : simuler un humain distrait (HORS rush uniquement) ───
// Un humain ne scanne pas avec une régularité parfaite. Parfois il rate un cycle
// (regarde son téléphone, va aux toilettes, perd le WiFi 30s).
// JAMAIS pendant les rush hours → aucune perte de capture quand les créneaux apparaissent.
function shouldSkipCycle(urgencyTier: string): boolean {
  if (isRushHour()) return false; // JAMAIS skip en rush → probabilité de capture maximale
  if (urgencyTier === "tres_urgent") return Math.random() < 0.05; // 5% hors rush
  if (urgencyTier === "urgent") return Math.random() < 0.07; // 7% hors rush
  return Math.random() < 0.10; // 10% pour prioritaire/standard (plus cool)
}

function generateIntervalMs(urgencyTier: string): number {
  const rush = urgencyTier === "tres_urgent" && isRushHour();

  // Logger les transitions rush ↔ normal
  if (rush !== lastRushState) {
    lastRushState = rush;
    if (rush) {
      const h = getKinshasaHour();
      log("INFO", `⚡ RUSH HOUR activé (${h}h00 Kinshasa) — intervalle tres_urgent → 3-4 min`);
    } else {
      log("INFO", "📻 RUSH HOUR terminé — retour intervalle normal tres_urgent (5-10 min)");
    }
  }

  const cfg = rush
    ? { min: RUSH_INTERVAL_MIN_MS, max: RUSH_INTERVAL_MAX_MS }
    : (URGENCY_INTERVAL[urgencyTier] ?? URGENCY_INTERVAL.standard);

  const last = lastIntervalUsed.get(urgencyTier);
  // Anti-répétition : écart minimal 30s en rush, 90s en normal
  const minGap = rush ? 30_000 : 90_000;

  // ── Distribution gaussienne au lieu de uniform random ───────────────────────
  // Centre = milieu de la plage, écart-type = ~25% de la plage.
  // Résultat : 68% des intervalles sont proches du centre (naturel),
  //            27% sont plus courts ou plus longs (variabilité),
  //            5% sont aux extrêmes (humain très distrait ou très pressé).
  const center = (cfg.min + cfg.max) / 2;
  const stddev = (cfg.max - cfg.min) * 0.25;
  let interval = gaussianRandom(center, stddev, cfg.min, cfg.max);

  if (last !== undefined) {
    let attempts = 0;
    while (Math.abs(interval - last) < minGap && attempts < 6) {
      interval = gaussianRandom(center, stddev, cfg.min, cfg.max);
      attempts++;
    }
  }

  lastIntervalUsed.set(urgencyTier, interval);
  return Math.round(interval);
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
      const baseOffset = i * staggerStep;
      // CORRECTION 16/05/2026 : Ajouter un jitter ±25% pour briser la corrélation
      // inter-comptes. Sans jitter, le portail observe que N comptes se connectent
      // TOUJOURS dans le même ordre avec des délais constants = signal multi-comptes.
      const jitter = (Math.random() * 0.5 - 0.25) * staggerStep;
      const offset = Math.max(0, Math.round(baseOffset + jitter));
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
    !isInRadioSilence(j.id) &&  // FIX 1: respect per-dossier radio silence
    j.hunterConfig?.isActive === true &&
    !!j.portalUrl &&
    getNextCheckDue(j) <= now &&
    // Mode parallèle / V3 : le OFC Watcher ou V3 gère le polling USA → exclure les jobs USA
    // du scheduler séquentiel. Seuls CEV (schengen) et Espagne restent gérés ici.
    !((isParallelMode || isV3Mode) && (j.destination === "usa" || (!j.destination || j.destination === ""))),
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
 * Vérifie si un autre dossier du même tier est dû prochainement (< 4 min).
 * Utilisé pour décider si le silence radio doit être réduit (mode stagger).
 * Ignore le dossier qu'on vient de traiter (currentTier match + pas le même job).
 *
 * Seuil à 4 min (et non 2 min) car quand le stagger est exactement 2 min,
 * un seuil de 2 min rate le dossier suivant de justesse (condition > now).
 * Avec 4 min le bot détecte toujours le prochain dossier staggeré et utilise
 * le silence radio réduit (30-60s) au lieu du normal (2-3 min).
 */
function findNextDueJobSoon(jobs: HunterJob[], currentTier: string): HunterJob | null {
  const now = Date.now();
  const soonThreshold = now + 4 * 60_000; // dans les 4 prochaines minutes (couvre stagger 2min)

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
    !!j.portalUrl &&
    // Mode parallèle / V3 : ignorer les jobs USA (gérés par OFC Watcher ou V3)
    !((isParallelMode || isV3Mode) && (j.destination === "usa" || (!j.destination || j.destination === ""))),
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
      radioSilenceUntil.delete(jobId); // FIX 1: cleanup
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
      radioSilenceUntil.delete(jobId); // FIX 1: clear radio silence on admin reset
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
  for (const jobId of radioSilenceUntil.keys()) {
    if (!freshJobIds.has(jobId)) radioSilenceUntil.delete(jobId);
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
      // ── AUTO-PAUSE : paiement non confirmé ─────────────────────────────────
      // Le portail USA ne retourne aucun créneau sans paiement MRV VERIFIED.
      // Scanner en boucle est inutile (résultats vides) et augmente le risque
      // de détection (pattern bot: scanner sans paiement = impossible pour un humain).
      // On met le job en pause jusqu'à ce que l'admin relance après paiement.
      pausedJobs.add(job.id);
      log("WARN", `[${job.applicantName}] 💳 Paiement MRV non confirmé — auto-pause (reprendra après reset admin)`);
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "payment_required",
          errorMessage: "Paiement MRV non confirmé (paymentStatus ≠ VERIFIED) — bot en pause. Effectuez le paiement sur usvisaappt.com puis relancez.",
          shouldPause: true,
        });
      } catch (err) {
        log("WARN", `[${job.applicantName}] Heartbeat pause payment échoué: ${err}`);
      }
      return; // pas de reschedule : le job est en pause

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
  const baseIntervalMs = generateIntervalMs(job.urgencyTier);
  // ── Per-dossier jitter sur l'intervalle (16/05/2026) ──────────────────────
  // Le generateIntervalMs produit un intervalle par TIER (partagé entre dossiers).
  // Ajouter un jitter PER-DOSSIER de ±15% pour désynchroniser les dossiers du même tier.
  // Résultat: même si le tier donne "4 min", Dossier A obtient 3.6 min et B obtient 4.4 min.
  const perDossierJitter = (Math.random() * 0.3 - 0.15) * baseIntervalMs;
  const intervalMs = Math.max(60_000, Math.round(baseIntervalMs + perDossierJitter));
  const nextDue = Date.now() + intervalMs;
  scheduledNextDue.set(job.id, nextDue);
  log("INFO", `[${job.applicantName}] Prochain check dans ${formatMs(intervalMs)} (${new Date(nextDue).toLocaleTimeString("fr-CD")})`);

  // ── FIX 3 : Coordination inter-dossiers ─────────────────────────────────────
  // Quand un dossier se reschedule loin (ex: 19 min), vérifier si un autre dossier
  // du même tier couvre les 5 prochaines minutes. Si non → avancer le frère
  // à now + 3-5 min pour éviter un gap de couverture.
  coordinateSiblings(job);
}

/**
 * FIX 3 : Coordination inter-dossiers.
 * Quand un dossier termine et se reschedule loin (ex: 19 min), on vérifie si
 * un autre dossier du même tier va couvrir les 5 prochaines minutes.
 * Si aucun ne couvre → on avance le frère le plus proche à now + 3-5 min.
 * Évite les gaps de couverture quand un dossier dort et l'autre aussi.
 */
function coordinateSiblings(currentJob: HunterJob): void {
  const now = Date.now();
  const tier = currentJob.urgencyTier;
  const COVERAGE_GAP_THRESHOLD_MS = 5 * 60_000; // 5 min sans couverture = gap
  const ADVANCE_MIN_MS = 3 * 60_000; // avancer à +3 min minimum
  const ADVANCE_MAX_MS = 5 * 60_000; // avancer à +5 min maximum

  // Trouver les frères du même tier (actifs, pas en pause, pas le job courant)
  const siblings: { jobId: string; name: string; due: number }[] = [];
  for (const [jobId, due] of scheduledNextDue.entries()) {
    if (jobId === currentJob.id) continue;
    if (pausedJobs.has(jobId)) continue;
    if (completedJobs.has(jobId)) continue;
    if (isInRadioSilence(jobId)) continue;
    // On ne peut pas facilement accéder au tier depuis le jobId seul,
    // donc on utilise staggerOffsets comme proxy (seuls les jobs du même tier ont des offsets)
    // Mais c'est imparfait — on vérifie via le prochain cycle de stagger
    siblings.push({ jobId, name: jobId.slice(-6), due });
  }

  if (siblings.length === 0) return;

  // Vérifier si un frère couvre les 5 prochaines minutes
  const coverageEnd = now + COVERAGE_GAP_THRESHOLD_MS;
  const siblingCovering = siblings.find(s => s.due >= now && s.due <= coverageEnd);

  if (siblingCovering) {
    // Un frère couvre déjà → pas besoin d'intervenir
    return;
  }

  // Aucun frère ne couvre → trouver le plus proche et l'avancer
  // Trier par échéance la plus proche
  const sortedSiblings = siblings
    .filter(s => s.due > coverageEnd) // seulement ceux qui sont APRÈS le gap
    .sort((a, b) => a.due - b.due);

  if (sortedSiblings.length === 0) return;

  const target = sortedSiblings[0];
  const advanceMs = ADVANCE_MIN_MS + Math.random() * (ADVANCE_MAX_MS - ADVANCE_MIN_MS);
  const newDue = now + Math.round(advanceMs);

  // Seulement avancer si ça représente un gain réel (> 2 min d'avance)
  if (target.due - newDue < 2 * 60_000) return;

  scheduledNextDue.set(target.jobId, newDue);
  log("INFO", `[coordination] ${currentJob.applicantName} dort → frère [${target.name}] avancé à +${formatMs(Math.round(advanceMs))} (était dans ${formatMs(target.due - now)})`);
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
      // PILLAR 4 : Envoyer le rapport admin quotidien
      await sendBundleReport(activeJobs, bundleName, true, false, USA_ENC_SEC_KEY);
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
      // PILLAR 4 : Rapport admin — clé auto-extraite
      await sendBundleReport(activeJobs, bundleName, true, true, newKey, oldKey);
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

// ─── PILLAR 4 : Helper pour envoyer le rapport admin ────────────────────────
async function sendBundleReport(
  activeJobs: HunterJob[],
  bundleName: string,
  aesKeyValid: boolean,
  aesKeyAutoExtracted: boolean,
  currentAesKey: string,
  previousAesKey?: string,
): Promise<void> {
  try {
    const report: BundleCheckReport = {
      bundleName,
      aesKeyValid,
      aesKeyAutoExtracted,
      currentAesKey,
      previousAesKey,
      activeJobsCount: activeJobs.filter(j => j.hunterConfig?.isActive && !pausedJobs.has(j.id)).length,
      pausedJobsCount: pausedJobs.size,
      completedJobsCount: completedJobs.size,
      errorJobsCount: [...consecutiveErrors.values()].filter(v => v >= 3).length,
      jobDetails: activeJobs
        .filter(j => j.hunterConfig?.isActive)
        .slice(0, 20)
        .map(j => ({
          applicantName: j.applicantName,
          urgencyTier: j.urgencyTier,
          lastResult: j.hunterConfig.lastResult ?? "",
          lastCheckAt: j.hunterConfig.lastCheckAt ?? null,
        })),
      checkedAt: Date.now(),
      proxyPoolStatus: proxyPool.isConfigured ? `Gateway mode (eu.proxy.2captcha.com:2334)` : "Unconfigured (direct)",
      serverIp: proxyPool.getState().serverIp,
    };
    await sendAdminBundleCheckReport(report);
  } catch (err) {
    log("WARN", `[admin-report] Erreur envoi rapport: ${err}`);
  }
}

// ─── Spain Watcher Loop — veille créneaux Espagne ────────────────────────────

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

  // Détection IP + initialisation ProxyPool (mode gateway — auth user:pass, pas de whitelist)
  const serverIp = await detectPublicIp();
  if (serverIp) {
    log("INFO", `IP serveur (Railway): ${serverIp}`);

    // Auto-whitelist chez IPRoyal + vérification 2Captcha
    const whitelistResult = await autoWhitelistIp(serverIp);
    if (whitelistResult.iproyal.ok) {
      log("INFO", `IPRoyal whitelist: ✅ ${whitelistResult.iproyal.message}`);
    } else {
      log("WARN", `IPRoyal whitelist: ❌ ${whitelistResult.iproyal.message}`);
    }
    if (whitelistResult.twocaptcha.ok) {
      log("INFO", `2Captcha whitelist: ✅ ${whitelistResult.twocaptcha.message}`);
    } else {
      log("WARN", `2Captcha whitelist: ❌ ${whitelistResult.twocaptcha.message}`);
    }

    if (process.env.TWOCAPTCHA_API_KEY) {
      await proxyPool.initialize(serverIp);
    }
  } else {
    log("WARN", "IP serveur: indéterminée (ipify.org inaccessible)");
  }

  const brightdataStatus = process.env.BRIGHTDATA_PROXY_URL ? "BrightData ✅ (CEV belge)" : null;
  const iproyalStatus    = process.env.IPROYAL_PROXY_URL    ? "iProyal ✅ (Espagne)"      : null;
  const fallbackStatus   = proxyPool.isConfigured
    ? `2captcha gateway ✅ (eu.proxy.2captcha.com:2334 — auth user:pass, region=cd)`
    : process.env.PROXY_URL
      ? "statique (PROXY_URL)"
      : "aucun ⚠️ — IP fixe Railway exposée";
  const proxyStatus = [brightdataStatus, iproyalStatus, fallbackStatus].filter(Boolean).join(" | ");
  log("INFO", `Proxy: ${proxyStatus}`);
  log("INFO", "Intervalles tier — tres_urgent:5-10m (rush:3-4m)  urgent:15-20m  prioritaire:25-35m  standard:45-60m");
  log("INFO", `Silence radio: normal ${formatMs(SILENCE_RADIO_MIN_MS)}–${formatMs(SILENCE_RADIO_MAX_MS)} | stagger ${formatMs(SILENCE_RADIO_SAME_TIER_MIN_MS)}–${formatMs(SILENCE_RADIO_SAME_TIER_MAX_MS)} | rush ${formatMs(RUSH_SILENCE_MIN_MS)}–${formatMs(RUSH_SILENCE_MAX_MS)}`);
  log("INFO", `Rush windows Kinshasa (UTC+1): 00h-02h | 07h-09h | 12h-14h — actif maintenant: ${isRushHour() ? "OUI ⚡" : "non"}`);
  log("INFO", `Auto-pause après: ${MAX_LOGIN_FAILURES} login_failed consécutifs`);

  // ─── Mode parallèle : log d'information ────────────────────────────────────
  if (isParallelMode) {
    log("INFO", `═══════════════════════════════════════════════════════════════`);
    log("INFO", `🔀 MODE PARALLÈLE DÉTECTÉ (PARALLEL_WATCHER_MODE=1)`);
    log("INFO", `   → Scheduler séquentiel: CEV + Espagne + bundle check UNIQUEMENT`);
    log("INFO", `   → Jobs USA: polling délégué au OFC Watcher partagé`);
    log("INFO", `   → Stagger désactivé (inutile avec watcher centralisé)`);
    log("INFO", `═══════════════════════════════════════════════════════════════`);
  }

  // ─── Statut solveurs hCaptcha CEV ────────────────────────────────────────
  const antiCaptchaKey = process.env.ANTICAPTCHA_API_KEY;
  const capsolverKey   = process.env.CAPSOLVER_API_KEY;
  const twoCaptchaKey  = process.env.TWOCAPTCHA_API_KEY;
  
  log("INFO", [
    "CEV hCaptcha solveurs:",
  
    antiCaptchaKey ? "AntiCaptcha ✅" : "AntiCaptcha ❌ (ANTICAPTCHA_API_KEY absent — REQUIS pour domaines gov)",
    capsolverKey   ? "CapSolver ✅ (sitekey gov blacklistée en 2026-04 — peut échouer)" : "CapSolver ❌",
    twoCaptchaKey  ? "2captcha ✅ (hCaptcha non supporté sur ce compte)" : "2captcha ❌",
  ].join(" | "));

  if (!convexUrl || !hunterKey) {
    log("ERROR", "CONVEX_SITE_URL et HUNTER_API_KEY sont requis — arrêt");
    process.exit(1);
  }

  // ─── MODE SELECTION : V3 > Parallèle > Séquentiel ──────────────────────────
  // Source de vérité : bot-config Convex (clé: v3_mode, parallel_watcher_mode)
  // Priorité :
  //   1. v3_mode=1       → V3 Chasseur (scan-session complet : login → multi-mois → booking → discovery)
  //   2. parallel_watcher_mode=1 → OFC Watcher partagé (détection rapide, pas de scan complet)
  //   3. Aucun           → Mode séquentiel legacy (impl.ts)
  let v3Mode = false;
  let parallelMode = false;

  // ── Vérifier v3_mode AVANT parallel_watcher_mode ──
  try {
    const v3Value = await getBotConfigValue("v3_mode");
    v3Mode = v3Value === "1";
    isV3Mode = v3Mode; // Update module-level flag for top-level functions
    if (v3Mode) {
      log("INFO", "[v3] ✅ Mode V3 Chasseur activé via bot-config Convex (v3_mode=1)");
    }
  } catch {
    // Convex inaccessible — v3_mode reste false, on essaie parallel ensuite
  }

  // ── Redis: restaurer les sessions persistées (évite les re-logins au restart) ──
  // Initialisé AVANT la décision de mode pour que les deux paths (parallèle/séquentiel)
  // bénéficient de la persistance des sessions.
  const { initTokenCacheRedis, disconnectRedis } = await import("./usaPortal/token-cache-redis.js");
  const restoredSessions = await initTokenCacheRedis();
  if (restoredSessions > 0) {
    log("INFO", `[redis-cache] 🔑 ${restoredSessions} session(s) restaurée(s) — re-login évité`);
  }

  // FIX-20: Restaurer les restrictions depuis Redis (survit aux redéploiements)
  const { initRestrictionRedis } = await import("./usaPortal/account-restriction.js");
  const restoredRestrictions = await initRestrictionRedis();
  if (restoredRestrictions > 0) {
    log("INFO", `[redis-cache] 🔒 ${restoredRestrictions} restriction(s) restaurée(s) — re-login évité pour comptes restreints`);
  }

  // ── V3 Chasseur : initialisation budget login + rush windows + prediction ──
  const { initV3 } = await import("./v3/index.js");
  await initV3(convexUrl, hunterKey);

  // Graceful shutdown: flush les sessions vers Redis avant de quitter
  const gracefulShutdown = async (signal: string) => {
    log("INFO", `[shutdown] Signal ${signal} reçu — flush Redis...`);
    await disconnectRedis();
    process.exit(0);
  };
  process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
  process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });

  if (!v3Mode) {
    try {
      const convexValue = await getBotConfigValue("parallel_watcher_mode");
      parallelMode = convexValue === "1";
      if (parallelMode) {
        log("INFO", "[parallel] Mode parallèle activé via bot-config Convex (parallel_watcher_mode=1)");
      } else {
        // Fallback env var (pour les tests locaux ou si Convex n'a pas encore la clé)
        parallelMode = process.env.PARALLEL_WATCHER_MODE === "1";
        if (parallelMode) {
          log("INFO", "[parallel] Mode parallèle activé via env PARALLEL_WATCHER_MODE=1 (fallback)");
        }
      }
    } catch {
      parallelMode = process.env.PARALLEL_WATCHER_MODE === "1";
      if (parallelMode) {
        log("WARN", "[parallel] Convex inaccessible — fallback sur env PARALLEL_WATCHER_MODE=1");
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODE V3 CHASSEUR — Boucle principale autonome
  // ═══════════════════════════════════════════════════════════════════════════
  if (v3Mode) {
    log("INFO", "═══════════════════════════════════════════════════════════════");
    log("INFO", "🎯 MODE V3 CHASSEUR ACTIVÉ (v3_mode=1)");
    log("INFO", "   → runScanSession complet : login → preflight → multi-mois → booking → discovery");
    log("INFO", "   → Intervalles pilotés par scan-orchestrator (rush/standard/night/burst)");
    log("INFO", "═══════════════════════════════════════════════════════════════");

    let runScanSession: any, getNextScanDecision: any, getCurrentPredictionScore: any, getCompetitionMedianMs: any, resolveAccountRole: any, extractBudgetFromConfig: any, getRemainingLogins: any, tokenCache: any, setUsaSessionProxy: any, getUsaSession: any, pollBlindBookingEvents: any, attemptBlindBooking: any;
    try {
      ({ runScanSession } = await import("./v3/scan/scan-session.js"));
      ({ getNextScanDecision } = await import("./v3/scan/scan-orchestrator.js"));
      ({ getCurrentPredictionScore, getCompetitionMedianMs } = await import("./v3/intelligence/prediction-engine.js"));
      ({ resolveAccountRole, extractBudgetFromConfig } = await import("./v3/admin/config-schema.js"));
      ({ getRemainingLogins } = await import("./v3/core/session-pool.js"));
      ({ tokenCache, setUsaSessionProxy } = await import("./usaPortal/usa-http.js"));
      ({ getUsaSession } = await import("./usaPortal/usa-session.js"));
      ({ pollBlindBookingEvents, attemptBlindBooking } = await import("./v3/booking/booking-blind.js"));
      // Import reportSlotDiscovery for confiné blind booking discoveries
      var { reportSlotDiscovery } = await import("./convexClient.js");
    } catch (importErr) {
      log("ERROR", `[v3] ❌ CRASH à l'import des modules V3: ${importErr}`);
      log("ERROR", `[v3] Stack: ${importErr instanceof Error ? importErr.stack : String(importErr)}`);
      log("ERROR", `[v3] V3 mode désactivé — fallback mode séquentiel`);
      v3Mode = false;
      isV3Mode = false;
    }

    // Boucle V3 — tourne en continu pour les dossiers USA actifs
    const v3Loop = async () => {
      while (true) {
        // Re-check v3_mode à chaque cycle (admin peut désactiver à chaud)
        const currentV3Setting = await getBotConfigValue("v3_mode").catch(() => null);
        if (currentV3Setting !== "1") {
          log("INFO", "[v3-loop] ⛔ v3_mode désactivé via bot-config — arrêt de la boucle V3.");
          break;
        }

        let jobs: HunterJob[];
        try {
          jobs = await getActiveJobs();
        } catch (err) {
          log("ERROR", `[v3-loop] Échec récupération jobs: ${err} — retry dans 30s`);
          await new Promise(r => setTimeout(r, 30_000));
          continue;
        }

        const usaJobs = jobs.filter(j =>
          j.destination === "usa" &&
          j.hunterConfig?.isActive === true &&
          !pausedJobs.has(j.id) &&
          !completedJobs.has(j.id) &&
          !!j.hunterConfig.embassyUsername  // USA n'a pas de portalUrl (URL fixe usvisaappt.com)
        );

        if (usaJobs.length === 0) {
          // DEBUG: Loguer pourquoi aucun job n'est trouvé
          const allUsaRaw = jobs.filter(j => j.destination === "usa");
          const reasons = allUsaRaw.map(j => {
            if (!j.hunterConfig?.isActive) return `${j.applicantName}: inactive`;
            if (pausedJobs.has(j.id)) return `${j.applicantName}: paused`;
            if (completedJobs.has(j.id)) return `${j.applicantName}: completed`;
            if (!j.hunterConfig.embassyUsername) return `${j.applicantName}: no embassyUsername`;
            return `${j.applicantName}: SHOULD BE ACTIVE (?)`;
          });
          log("INFO", `[v3-loop] Aucun dossier USA actif — polling dans 60s (total USA bruts: ${allUsaRaw.length}, raisons: ${reasons.join(" | ")})`);
          await new Promise(r => setTimeout(r, 60_000));
          continue;
        }

        // Trier par urgence
        const sortedJobs = [...usaJobs].sort((a, b) => {
          const tiers: Record<string, number> = { tres_urgent: 0, urgent: 1, prioritaire: 2, standard: 3 };
          return (tiers[a.urgencyTier] ?? 3) - (tiers[b.urgencyTier] ?? 3);
        });

        // Log les jobs trouvés et leurs rôles à chaque tick
        const rolesStr = sortedJobs.map(j => `${j.applicantName}(${resolveAccountRole(j.hunterConfig as any)})`).join(", ");
        log("INFO", `[v3-loop] ${sortedJobs.length} job(s) USA actifs: ${rolesStr}`);

        // ── RESET BUDGET ADMIN ──────────────────────────────────────────────
        // Vérifie si l'admin a demandé un reset de budget pour un des comptes actifs.
        // Clé bot-config : "reset_budget:<username>" = "7" (valeur = nouveau budget max)
        // Après reset : écrase la clé avec "done" pour signaler la consommation.
        for (const job of sortedJobs) {
          const uname = job.hunterConfig.embassyUsername;
          if (!uname) continue;
          try {
            const resetVal = await getBotConfigValue(`reset_budget:${uname}`).catch(() => null);
            if (resetVal && resetVal !== "done") {
              const newMax = parseInt(resetVal, 10) || 7;
              const { resetBudget } = await import("./v3/core/session-pool.js");
              resetBudget(uname, newMax);
              log("INFO", `[v3-loop] 🔄 Budget reset à ${newMax} pour ${uname} (demande admin)`);
              // Marquer comme consommé via POST bot-config
              try {
                await fetch(`${convexUrl}/hunter/bot-config`, {
                  method: "POST",
                  headers: { "X-Hunter-Key": hunterKey!, "Content-Type": "application/json" },
                  body: JSON.stringify({ key: `reset_budget:${uname}`, value: "done" }),
                });
              } catch { /* non-bloquant */ }
            }
          } catch { /* non-bloquant */ }
        }

        // ═══════════════════════════════════════════════════════════════════
        // FIX: DEUX PASSES — éclaireurs d'abord, confinés ensuite.
        //
        // Problème résolu :
        //   Avant ce fix, la boucle unique triée par urgence traitait les confinés
        //   AVANT l'éclaireur (si plus urgents). Les confinés faisaient pollBlindBookingEvents
        //   → 0 events (le broadcast n'avait pas eu lieu car l'éclaireur n'avait pas scanné).
        //   Au tick suivant (5-10 min plus tard), les events Convex avaient expiré (TTL < 5 min).
        //
        // Solution :
        //   PASSE 1 : Éclaireurs scannent → broadcastSlotDiscovery() émet les events
        //   PASSE 2 : Confinés poll → reçoivent les events fraîchement broadcastés
        // ═══════════════════════════════════════════════════════════════════

        const eclaireurJobs = sortedJobs.filter(j => resolveAccountRole(j.hunterConfig as any) !== "confine");
        const confineJobs = sortedJobs.filter(j => resolveAccountRole(j.hunterConfig as any) === "confine");

        // ── PASSE 1 : ÉCLAIREURS (scan + broadcast) ──────────────────────
        let scannedOne = false;
        for (const job of eclaireurJobs) {
          const username = job.hunterConfig.embassyUsername;
          const role = resolveAccountRole(job.hunterConfig as any);

          // Demander à l'orchestrateur si on doit scanner maintenant
          const cachedEntry = tokenCache.get(username.toLowerCase());
          const hasValidToken = !!(cachedEntry && Date.now() < cachedEntry.expiresAt);
          const remaining = getRemainingLogins(username);

          const decision = getNextScanDecision({
            accountRole: role,
            predictionScore: getCurrentPredictionScore(username),
            competitionMedianMs: getCompetitionMedianMs(username),
            loginsRemaining: remaining,
            hasValidToken,
            scanIntensity: "normal",
            nightMode: job.hunterConfig.nightModeEnabled ? "minimal" : "off",
          });

          if (!decision.shouldScan) {
            // FIX: Deadlock — si pas de token MAIS budget login disponible,
            // forcer le scan pour que runScanSession puisse faire le login.
            // Sans ça: pas de token → shouldScan=false → pas de login → pas de token → ∞
            if (!hasValidToken && remaining > 0) {
              log("INFO", `[v3-loop] 🔑 ${job.applicantName} — pas de token mais budget disponible (${remaining} logins restants) → forcer login`);
            } else {
              continue;
            }
          }

          log("INFO", `[v3-loop] ▶ ${job.applicantName} — ${decision.reason} (phase: ${decision.phase}, interval: ${Math.round(decision.intervalMs / 1000)}s)`);

          // Lancer la session V3 complète
          const outcome = await runScanSession({
            jobId: job.id,
            hunterConfig: job.hunterConfig as any,
            existingSession: hasValidToken ? {
              accessToken: cachedEntry!.accessToken,
              refreshToken: cachedEntry!.refreshToken,
              csrfToken: cachedEntry!.csrfToken,
              userID: cachedEntry!.userID,
              fullName: cachedEntry!.fullName,
              applicationId: null,
              pendingAppoStatus: null,
              missionId: 323,
              allowedOfcs: cachedEntry!.allowedOfcs ?? [],
            } : undefined,
            getSession: async (proxyUrl) => {
              setUsaSessionProxy(proxyUrl ?? undefined);
              const session = await getUsaSession(
                job.hunterConfig.embassyUsername,
                job.hunterConfig.embassyPassword,
                job.hunterConfig.twoCaptchaApiKey,
              );
              setUsaSessionProxy(undefined);
              return session;
            },
            convexSiteUrl: convexUrl!,
            hunterApiKey: hunterKey!,
          });

          log("INFO", `[v3-loop] ✅ ${job.applicantName} — résultat: ${outcome}`);

          if (outcome === "slot_captured") {
            completedJobs.add(job.id);
            pausedJobs.add(job.id);
            await sendHeartbeat({ applicationId: job.id, result: "slot_found" });
          } else if (outcome === "restricted") {
            pausedJobs.add(job.id);
          } else if (outcome === "payment_required") {
            pausedJobs.add(job.id);
            await sendHeartbeat({ applicationId: job.id, result: "payment_required", errorMessage: "Paiement MRV non vérifié" });
          }

          // ── KEEP-ALIVE ENTRE LES SCANS ──────────────────────────────────────
          // Le portail déconnecte après 15 min d'inactivité. L'intervalle entre scans
          // est de 5-10 min (standard) — 2 cycles consécutifs sans activité = 10-20 min = disconnect.
          // Solution : pendant l'attente, pinger getLandingPageDeatils toutes les 8-12 min.
          //
          // FIX 19/05/2026: Si des confinés sont en attente, SKIP le long waitMs pour que
          // PASSE 2 démarre immédiatement après le scan. Le délai de 219s entre détection
          // et tentative venait de ce waitMs (144s) + 5s propagation. Maintenant: 5s seulement.
          // Le keep-alive est maintenu uniquement si PAS de confinés (ou scan sans broadcast).
          const waitMs = Math.max(decision.intervalMs, 30_000);
          const INTER_SCAN_PING_INTERVAL_MS = 8 * 60_000 + Math.random() * 4 * 60_000; // 8-12 min

          // Vérifier si le token est encore valide — si oui, lancer un keep-alive temporaire
          const postScanCache = tokenCache.get(username.toLowerCase());
          const postScanTokenValid = !!(postScanCache && Date.now() < postScanCache.expiresAt);

          // Si des confinés attendent des broadcasts → skip le wait long (PASSE 2 immédiate)
          if (confineJobs.length > 0) {
            // Pas de wait — les confinés doivent tenter le blind booking ASAP
            // Le keep-alive n'est pas nécessaire car le prochain scan sera dans ~30s après PASSE 2
            log("INFO", `[v3-loop] ⚡ Skip waitMs (${Math.round(waitMs / 1000)}s) — ${confineJobs.length} confiné(s) en attente, PASSE 2 immédiate`);
          } else if (postScanTokenValid && waitMs > INTER_SCAN_PING_INTERVAL_MS * 0.8) {
            // L'attente est assez longue pour risquer un timeout portail — pinger
            const { startKeepAlive: startInterScanKA } = await import("./v3/anti-detection/keep-alive.js");
            const interScanKA = startInterScanKA(
              { accessToken: postScanCache!.accessToken, applicationId: cachedEntry?.applicationId ?? null, missionId: 323 } as any,
              job.id,
              { minIntervalMs: 8 * 60_000, maxIntervalMs: 12 * 60_000 },
            );
            // Attendre l'intervalle puis arrêter le keep-alive
            await new Promise(r => setTimeout(r, waitMs));
            interScanKA.stop();
          } else {
            // Attente courte ou pas de token → simple sleep
            await new Promise(r => setTimeout(r, waitMs));
          }

          scannedOne = true;
          break; // Un seul éclaireur par tick (radio silence entre les dossiers)
        }

        // ── PASSE 2 : CONFINÉS (poll blind booking events) ───────────────
        // Exécutée APRÈS la passe éclaireur, donc les events broadcastés sont disponibles.
        // IMPORTANT: On poll TOUJOURS les confinés, même si l'éclaireur n'a pas scanné ce tick.
        // Un broadcast d'un tick précédent peut encore être pending (TTL 5 min dans Convex).
        if (scannedOne && confineJobs.length > 0) {
          // Délai pour laisser le broadcast Convex se propager (fire-and-forget → mutation → commit)
          // 5s pour couvrir la latence réseau + exécution mutation Convex
          await new Promise(r => setTimeout(r, 5_000));
          log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${confineJobs.length} confiné(s) après scan éclaireur`);
        } else if (confineJobs.length > 0) {
          // Pas de scan éclaireur ce tick, mais on poll quand même (events d'un tick précédent)
          log("INFO", `[v3-loop] 📡 PASSE 2 — polling ${confineJobs.length} confiné(s) (éclaireur non éligible ce tick)`);
        }

        for (const job of confineJobs) {
          const username = job.hunterConfig.embassyUsername;
          try {
            const events = await pollBlindBookingEvents(username, convexUrl!, hunterKey!);
            log("INFO", `[v3-loop] 🔍 ${job.applicantName} (confiné) poll → ${events.length} event(s) pending`);
            if (events.length > 0) {
              log("INFO", `[v3-loop] 📡 ${job.applicantName} (confiné) — ${events.length} blind booking(s) reçu(s)`);

              // ── FIX 19/05/2026: PREFLIGHT UNE SEULE FOIS avant la boucle des events ──
              // Avant : le preflight (resolveApplicationId + runPreflight) était fait pour CHAQUE
              // slotId dans la boucle → 6-12 appels API inutiles, +30s de latence.
              // Après : fait UNE FOIS avant la boucle, réutilisé pour tous les events.

              // 1. Token check + réveil d'urgence (une seule fois)
              let cachedConf = tokenCache.get(username.toLowerCase());
              let hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);

              if (!hasToken) {
                const budgetRemaining = getRemainingLogins(username);
                if (budgetRemaining <= 0) {
                  log("WARN", `[v3-loop] ${job.applicantName} (confiné) — SLOT DÉTECTÉ mais budget épuisé (0 logins restants) — impossible de réveiller`);
                  continue;
                }
                log("INFO", `[v3-loop] ⚡ ${job.applicantName} (confiné) — RÉVEIL D'URGENCE ! Slot détecté, login immédiat (budget: ${budgetRemaining} restants)`);
                try {
                  setUsaSessionProxy(undefined);
                  const freshSession = await getUsaSession(
                    job.hunterConfig.embassyUsername,
                    job.hunterConfig.embassyPassword,
                    job.hunterConfig.twoCaptchaApiKey,
                  );
                  setUsaSessionProxy(undefined);
                  if (freshSession) {
                    const { recordLogin } = await import("./v3/core/session-pool.js");
                    recordLogin(username, "emergency");
                    cachedConf = tokenCache.get(username.toLowerCase());
                    hasToken = !!(cachedConf && Date.now() < cachedConf.expiresAt);
                    log("INFO", `[v3-loop] ✅ ${job.applicantName} (confiné) — réveil réussi en urgence, token valide`);
                  } else {
                    log("WARN", `[v3-loop] ${job.applicantName} (confiné) — réveil échoué (login null) — slot perdu`);
                    continue;
                  }
                } catch (loginErr) {
                  log("ERROR", `[v3-loop] ${job.applicantName} (confiné) — réveil échoué: ${loginErr} — slot perdu`);
                  continue;
                }
              }

              if (!hasToken || !cachedConf) {
                log("WARN", `[v3-loop] ${job.applicantName} (confiné) — token toujours invalide après réveil — skip`);
                continue;
              }

              // 2. Preflight UNE SEULE FOIS (résoudre applicantId GSS, applicationId, appointmentId)
              let confAppDetails: { applicantId: string | number; applicationId: string; appointmentId?: number; applicantUUID?: number | string } | null = null;
              try {
                const { checkUsaAppointmentRequestStatus, fetchCancellableSessionIds } = await import("./usaPortal/appointments-api.js");
                const { runPreflight } = await import("./v3/scan/scan-preflight.js");

                const confSession = {
                  accessToken: cachedConf!.accessToken,
                  refreshToken: cachedConf!.refreshToken,
                  csrfToken: cachedConf!.csrfToken ?? "",
                  userID: cachedConf!.userID,
                  fullName: cachedConf!.fullName,
                  applicationId: null as string | null,
                  pendingAppoStatus: null,
                  missionId: 323,
                  allowedOfcs: cachedConf!.allowedOfcs ?? [],
                } as any;

                const reqStatus = await checkUsaAppointmentRequestStatus(confSession, undefined);
                let confApplicationId = reqStatus.applicationId ?? "";

                if (!confApplicationId && reqStatus.status === "cancellable") {
                  await fetchCancellableSessionIds(confSession, { id: job.id, hunterConfig: job.hunterConfig } as any);
                  confApplicationId = confSession.applicationId ?? "";
                }

                if (!confApplicationId) {
                  log("WARN", `[v3-loop] ${job.applicantName} (confiné) — applicationId introuvable — blind booking impossible`);
                  continue;
                }

                const preflight = await runPreflight(confSession, confApplicationId, 323);
                confAppDetails = {
                  applicantId: preflight.appDetails.applicantId,
                  applicationId: confApplicationId,
                  appointmentId: preflight.appDetails.appointmentId,
                  applicantUUID: preflight.appDetails.applicantUUID as number | undefined,
                };
                log("INFO", `[v3-loop] ✅ ${job.applicantName} (confiné) — preflight OK: applicantId=${confAppDetails.applicantId} appId=${confApplicationId}`);
              } catch (preflightErr) {
                log("ERROR", `[v3-loop] ${job.applicantName} (confiné) — preflight échoué: ${preflightErr} — blind booking impossible`);
                continue;
              }

              // 3. Boucle sur les events — tenter chaque slotId sans refaire le preflight
              for (const event of events) {
                const blindResult = await attemptBlindBooking(event, {
                  accessToken: cachedConf!.accessToken,
                  applicationId: confAppDetails.applicationId,
                  applicantId: confAppDetails.applicantId,
                  appointmentId: confAppDetails.appointmentId,
                  applicantUUID: confAppDetails.applicantUUID as number | undefined,
                  missionId: 323,
                  mode: job.hunterConfig.rescheduleMode ? "reschedule" : "schedule",
                  csrfToken: cachedConf!.csrfToken ?? "",
                  existingLocationType: job.hunterConfig.rescheduleMode ? "POST" : undefined,
                });
                if (blindResult.success) {
                  log("INFO", `[v3-loop] 🎉 BLIND BOOKING RÉUSSI — ${job.applicantName} (confiné) — ${event.date} ${event.time}`);

                  reportSlotDiscovery({
                    applicationId: job.id,
                    destination: "usa",
                    office: event.office,
                    dateFound: event.date,
                    timeFound: event.time,
                    outcome: "captured",
                    context: { slotId: event.slotId, via: "blind_booking", sourceUsername: event.sourceUsername },
                    mode: job.hunterConfig.rescheduleMode ? "reschedule" : "schedule",
                  });

                  try {
                    const session = { accessToken: cachedConf!.accessToken, applicationId: confAppDetails.applicationId, missionId: 323, applicantId: confAppDetails.applicantId } as any;
                    const pdf = await (await import("./usaPortal/usa-scan-confirmation.js")).downloadUsaConfirmationPdf(session, confAppDetails.applicationId, blindResult.appointmentId);
                    let pdfStorageId: string | undefined;
                    if (pdf) {
                      pdfStorageId = (await uploadFile(pdf.toString("base64"), "application/pdf")) ?? undefined;
                    }
                    await reportSlotFound({
                      applicationId: job.id,
                      date: event.date,
                      time: event.time,
                      location: `${event.office} — Ambassade USA (blind booking via ${event.sourceUsername.slice(0, 8)}…)`,
                      confirmationCode: blindResult.appointmentId?.toString(),
                      screenshotStorageId: pdfStorageId,
                    });
                  } catch (postErr) {
                    log("WARN", `[v3-loop] ⚠️ Post-booking confiné échoué (non-bloquant): ${postErr}`);
                  }
                  completedJobs.add(job.id);
                  pausedJobs.add(job.id);
                  await sendHeartbeat({ applicationId: job.id, result: "slot_found" });
                  break;
                }
                // Slot pris (409) ou autre échec → tenter le prochain slotId broadcasté
                if (blindResult.statusCode === 409) {
                  log("INFO", `[v3-loop] ⚠️ ${job.applicantName} (confiné) — slot ${event.slotId?.toString().slice(0, 10)}… pris (409) — tentative suivante...`);
                }
              }
            }
          } catch (pollErr) {
            log("WARN", `[v3-loop] Erreur polling confiné ${username.slice(0,8)}…: ${pollErr}`);
          }
        }

        // Si aucun job n'était éligible ce tick
        if (!scannedOne && confineJobs.length === 0) {
          await new Promise(r => setTimeout(r, 30_000));
        } else if (!scannedOne) {
          // Éclaireur pas éligible mais confinés ont été traités — attente courte
          await new Promise(r => setTimeout(r, 15_000));
        }
      }
    };

    // Lancer la boucle V3 en background (non-bloquant — le scheduler séquentiel continue pour CEV/Espagne)
    if (v3Mode) {
      v3Loop().catch(err => {
        log("ERROR", `[v3-loop] Fatal: ${err}`);
      });
    }
  }

  if (parallelMode && !v3Mode) {
    log("INFO", "═══════════════════════════════════════════════════════════════");
    log("INFO", "🚀 MODE PARALLÈLE ACTIVÉ (PARALLEL_WATCHER_MODE=1)");
    log("INFO", "   → OFC Watcher partagé + Booking Race + Keep-Alive per-account");
    log("INFO", "═══════════════════════════════════════════════════════════════");

    // Importer les modules du nouveau système
    const { startOfcWatcher, subscribeToOfcWatcher, makeOfcKey } = await import("./usaPortal/ofc-watcher.js");
    const { runBookingRace } = await import("./usaPortal/booking-race.js");
    const { registerAccountForKeepAlive, startAccountsMonitor, getReadyAccountCount, getAccountsStatus, setRotationPeerCountFn } = await import("./usaPortal/accounts-keep-alive.js");

    // FIX-19: Configurer le comptage de pairs pour le repos adaptatif.
    // Un compte "seul de son type" (ex: seul reschedule) aura un repos court (15-30min).
    // Le peerCount est basé sur le nombre de comptes gérés - 1 (fallback simple).
    // TODO: Pour une vraie différenciation NEW/RESCHEDULE, il faudrait passer
    // le statut de chaque compte et compter les peers du même statut.
    setRotationPeerCountFn((_username: string) => {
      // Compter les comptes avec token valide (hors le courant)
      const readyCount = getReadyAccountCount();
      return Math.max(0, readyCount - 1);
    });

    // Démarrer le accounts monitor (surveillance tokens — PAS de re-login automatique)
    startAccountsMonitor();

    // Boucle d'initialisation : enregistrer les dossiers USA et démarrer les watchers
    let watcherInitialized = false;

    // FIX-19: Set partagé entre initParallelWatchers et parallelReloginLoop
    // pour éviter les re-inscriptions inutiles au premier tick du relogin loop.
    const alreadyRegisteredUsernames = new Set<string>();

    const initParallelWatchers = async () => {
      let jobs: HunterJob[];
      try {
        jobs = await getActiveJobs();
      } catch (err) {
        log("ERROR", `[parallel] Échec récupération jobs: ${err} — retry dans 30s`);
        return;
      }

      const usaJobs = jobs.filter(j =>
        j.destination === "usa" &&
        j.hunterConfig?.isActive === true &&
        !pausedJobs.has(j.id) &&
        !completedJobs.has(j.id) &&
        !!j.portalUrl,
      );

      if (usaJobs.length === 0) {
        log("INFO", "[parallel] Aucun dossier USA actif — mode legacy uniquement");
        return;
      }

      log("INFO", `[parallel] ${usaJobs.length} dossier(s) USA actif(s) — inscription keep-alive...`);

      // 1. Inscrire chaque compte pour le keep-alive permanent
      for (const job of usaJobs) {
        await registerAccountForKeepAlive(job);
        alreadyRegisteredUsernames.add(job.hunterConfig.embassyUsername.toLowerCase());
      }

      const readyCount = getReadyAccountCount();
      log("INFO", `[parallel] ${readyCount}/${usaJobs.length} comptes prêts (token valide)`);

      // 2. Démarrer le watcher OFC (pour Kinshasa = 1 seul OFC, usa:Kinshasa:323)
      // FIX-20: Essayer chaque compte par ordre d'urgence jusqu'à en trouver un
      // avec un token valide qui peut bootstrap. Ne plus forcer le premier compte
      // (qui peut être restreint après un redéploiement).
      const sortedByTier = [...usaJobs].sort((a, b) => {
        const ta = URGENCY_ORDER[a.urgencyTier] ?? 3;
        const tb = URGENCY_ORDER[b.urgencyTier] ?? 3;
        return ta - tb;
      });

      // L'OFC key pour Kinshasa (le seul OFC USA au Congo)
      const ofcKey = makeOfcKey("usa", "Kinshasa", 323);

      // Callback de slot détecté → lancer la booking race
      const onSlotDetected = async (event: any, subscribers: any[]) => {
        log("INFO", `[parallel] 🚨 SLOT BROADCAST → ${subscribers.length} participants en course!`);
        const raceResult = await runBookingRace(event, subscribers);
        if (raceResult.successCount > 0) {
          log("INFO", `[parallel] 🏆 BOOKING RÉUSSI par ${raceResult.winnerJobId?.slice(-6)} en ${Math.round(raceResult.durationMs / 1000)}s`);
          // Marquer le winner comme completed
          if (raceResult.winnerJobId) {
            completedJobs.add(raceResult.winnerJobId);
            pausedJobs.add(raceResult.winnerJobId);
          }
        } else {
          log("WARN", `[parallel] ❌ Booking race échouée — slot expiré ou tous les participants en erreur`);
        }
      };

      // ── Bootstrap : résoudre les données OFC AVANT de démarrer le watcher ────
      // FIX-20: Essayer chaque compte (par urgence) jusqu'à trouver un bootstrap réussi.
      // Un compte restreint ou sans token valide (re-login en cours) sera skippé.
      const { bootstrapAccountData } = await import("./usaPortal/parallel-bootstrap.js");

      let watcherJob: HunterJob | null = null;
      let watcherUsername = "";
      let bootstrapResult: Awaited<ReturnType<typeof bootstrapAccountData>> | null = null;

      // FIX-22: Importer isAccountRestricted pour skip les comptes restreints AVANT bootstrap.
      // Sans ça, le bootstrap tente des comptes fraîchement restreints (restriction découverte
      // pendant registerAccountForKeepAlive quelques ms plus tôt) et échoue avec TOKEN_EXPIRED.
      const { isAccountRestricted: isRestricted } = await import("./usaPortal/account-restriction.js");

      for (const candidateJob of sortedByTier) {
        const candidateUsername = candidateJob.hunterConfig.embassyUsername;

        // FIX-22: Skip les comptes restreints — inutile de tenter un bootstrap sans token valide
        if (isRestricted(candidateUsername)) {
          log("WARN", `[parallel] Skip bootstrap ${candidateUsername.slice(0, 12)}… — compte RESTREINT`);
          continue;
        }

        log("INFO", `[parallel] Tentative bootstrap: ${candidateUsername.slice(0, 12)}…`);
        const result = await bootstrapAccountData(candidateJob, candidateUsername);
        if (result.success && result.ofcList.length > 0) {
          watcherJob = candidateJob;
          watcherUsername = candidateUsername;
          bootstrapResult = result;
          break;
        }
        log("WARN", `[parallel] Bootstrap échoué pour ${candidateUsername.slice(0, 12)}… — ${result.error ?? "aucun OFC"} — essai suivant...`);
      }

      if (!watcherJob || !bootstrapResult) {
        log("ERROR", `[parallel] Bootstrap échoué pour TOUS les comptes (${sortedByTier.length}) — watcher non démarré`);
        log("ERROR", `[parallel] Attente re-login — le relogin loop relancera le watcher`);
        return;
      }

      // Résoudre le proxy du watcher élu — respecte proxy_priority de botConfig
      // JAMAIS de mode direct — si aucun proxy ne fonctionne, ABORT le watcher.
      let watcherProxy: string | undefined;
      if (watcherJob.hunterConfig.useResidentialProxy) {
        const { resolveProxyWithFailover } = await import("./usaPortal/accounts-keep-alive.js");
        watcherProxy = await resolveProxyWithFailover(watcherUsername, watcherJob.id, watcherJob.hunterConfig);

        if (!watcherProxy) {
          log("ERROR", `[parallel] ❌ TOUS LES PROXIES DOWN — watcher NON démarré (pas de mode direct)`);
          return;
        }
        log("INFO", `[parallel] Watcher proxy résolu via resolveProxyWithFailover`);
      }

      // Utiliser le premier OFC résolu (Kinshasa)
      const resolvedOfc = bootstrapResult.ofcList[0];
      log("INFO", `[parallel] Bootstrap OK — OFC: ${resolvedOfc.postName} (postUserId: ${resolvedOfc.postUserId})`);

      // Démarrer le watcher avec les VRAIES données OFC
      startOfcWatcher(
        ofcKey,
        resolvedOfc,
        323, // missionId USA
        watcherUsername,
        watcherProxy,
        onSlotDetected,
      );

      // 3. Inscrire TOUS les dossiers comme subscribers du watcher
      // Bootstrap chaque compte pour résoudre ses appDetails
      for (const job of usaJobs) {
        const username = job.hunterConfig.embassyUsername;

        // FIX-20: Ne pas résoudre proxy/bootstrap pour les comptes sans token valide.
        // Ils ne peuvent pas scanner ni booker — le proxy sera résolu au re-login.
        const { tokenCache: tc } = await import("./usaPortal/usa-http.js");
        const subCached = tc.get(username.toLowerCase());
        const subHasToken = subCached && Date.now() < subCached.expiresAt;

        let subProxy: string | undefined;
        if (subHasToken && job.hunterConfig.useResidentialProxy) {
          const { resolveProxyWithFailover } = await import("./usaPortal/accounts-keep-alive.js");
          subProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
        }

        // Bootstrap les données de chaque subscriber (seulement si token valide)
        let subAppDetails = bootstrapResult.appDetails;
        if (subHasToken && username.toLowerCase() !== watcherUsername.toLowerCase()) {
          // Bootstrap séparé pour les autres comptes (ils ont leur propre applicantId)
          const subBootstrap = await bootstrapAccountData(job, username);
          if (subBootstrap.appDetails) {
            subAppDetails = subBootstrap.appDetails;
          }
        } else if (!subHasToken && username.toLowerCase() !== watcherUsername.toLowerCase()) {
          // Pas de token → utiliser les données de base du job (seront mises à jour au re-login/re-bootstrap)
          subAppDetails = null;
        }

        subscribeToOfcWatcher(ofcKey, {
          jobId: job.id,
          username,
          proxyUrl: subProxy,
          job,
          appDetails: subAppDetails ?? {
            applicantId: bootstrapResult.appDetails?.applicantId ?? "0",
            applicationId: "",
            visaType: bootstrapResult.visaType,
            visaClass: bootstrapResult.visaClass,
          },
          rescheduleYN: job.hunterConfig.rescheduleMode,
          dateFrom: job.hunterConfig.slotDateFrom,
          dateDeadline: job.hunterConfig.slotDateDeadline,
        });
      }

      watcherInitialized = true;
      log("INFO", `[parallel] ✅ Watcher OFC Kinshasa démarré — ${usaJobs.length} subscriber(s)`);
      log("INFO", `[parallel] Status comptes: ${JSON.stringify(getAccountsStatus())}`);
    };

    // Init async (non-bloquant — la boucle legacy démarre en parallèle)
    initParallelWatchers().catch(err => {
      log("ERROR", `[parallel] Erreur initialisation watchers: ${err}`);
    });

    // ── Scheduler de re-login + auto-inscription pour le mode parallèle ───────
    // Ce loop fait 2 choses :
    //   1. Inscrit les nouveaux dossiers USA activés APRÈS le démarrage
    //   2. Re-login les comptes dormants quand le cooldown est terminé
    // Vérifie toutes les 3-5 min (variable).
    const { isAccountReadyForRelogin, performScheduledRelogin, getRestTimeRemaining, getSessionsRemainingToday, registerAccountForKeepAlive: registerAccount, getIndependentCooldownRemaining } = await import("./usaPortal/accounts-keep-alive.js");
    const { subscribeToOfcWatcher: subscribeLate, makeOfcKey: makeKey, hasActiveWatcher } = await import("./usaPortal/ofc-watcher.js");

    // FIX-21: Safety net — timestamp du dernier re-login par compte.
    // Même si toutes les autres vérifications sont passées, imposer un
    // minimum absolu de 10 min entre deux tentatives de login pour le même compte.
    // Cela protège contre les edge cases non prévus (race conditions, bugs futurs).
    const lastReloginAttemptAt = new Map<string, number>();
    const MIN_RELOGIN_INTERVAL_MS = 10 * 60_000; // 10 min minimum entre deux tentatives

    const parallelReloginLoop = async () => {
      // FIX-19: Utiliser le Set partagé pré-peuplé par initParallelWatchers
      // pour éviter de re-inscrire les comptes déjà gérés au premier tick.
      const registeredUsernames = alreadyRegisteredUsernames;

      while (true) {
        // Vérifier toutes les 3-5 min (variable)
        const checkInterval = 3 * 60_000 + Math.random() * 2 * 60_000;
        await new Promise(r => setTimeout(r, checkInterval));

        try {
          // ── FIX-22: Re-check parallel_watcher_mode à chaque tick ────────────
          // Si l'admin a désactivé le mode parallèle, arrêter cette boucle proprement.
          // La boucle ne se relancera qu'au prochain redémarrage Railway.
          const currentParallelSetting = await getBotConfigValue("parallel_watcher_mode");
          if (currentParallelSetting !== "1") {
            log("INFO", `[parallel-relogin] ⛔ Mode parallèle désactivé via bot-config (parallel_watcher_mode=${currentParallelSetting ?? "null"}) — arrêt de la boucle.`);
            // Stopper le watcher OFC s'il est actif
            const stopOfcKey = makeKey("usa", "Kinshasa", 323);
            if (hasActiveWatcher(stopOfcKey)) {
              const { stopOfcWatcher } = await import("./usaPortal/ofc-watcher.js");
              stopOfcWatcher(stopOfcKey);
              log("INFO", `[parallel-relogin] 🛑 OFC Watcher arrêté.`);
            }
            break; // Sortir du while(true)
          }

          // ── FIX: Auto-retry watcher si pas actif ──────────────────────────────
          // Si initParallelWatchers a échoué au démarrage (proxies down, bootstrap KO),
          // retenter à chaque tick tant qu'il n'y a pas de watcher actif.
          // Évite le deadlock : tokens valides + pas de watcher = rien ne se passe.
          const watcherOfcKey = makeKey("usa", "Kinshasa", 323);
          if (!hasActiveWatcher(watcherOfcKey)) {
            log("INFO", `[parallel-relogin] 🔄 Pas de watcher actif — retenter initParallelWatchers...`);
            await initParallelWatchers();
            if (hasActiveWatcher(watcherOfcKey)) {
              log("INFO", `[parallel-relogin] ✅ Watcher démarré avec succès au retry`);
            }
          }

          const jobs = await getActiveJobs();
          const usaJobs = jobs.filter(j =>
            j.destination === "usa" &&
            j.hunterConfig?.isActive === true &&
            !pausedJobs.has(j.id) &&
            !completedJobs.has(j.id) &&
            !!j.portalUrl
          );

          for (const job of usaJobs) {
            const username = job.hunterConfig.embassyUsername;
            const key = username.toLowerCase();

            // ── Auto-inscription : inscrire les comptes pas encore gérés ──────
            if (!registeredUsernames.has(key)) {
              log("INFO", `[parallel-relogin] 🆕 Nouveau dossier détecté: ${username.slice(0, 12)}… — inscription keep-alive + watcher`);
              const registered = await registerAccount(job);
              if (registered) {
                registeredUsernames.add(key);
                // Inscrire aussi comme subscriber du watcher OFC Kinshasa
                const ofcKey = makeKey("usa", "Kinshasa", 323);
                if (hasActiveWatcher(ofcKey)) {
                  let subProxy: string | undefined;
                  if (job.hunterConfig.useResidentialProxy) {
                    const { resolveProxyWithFailover } = await import("./usaPortal/accounts-keep-alive.js");
                    subProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
                  }

                  // Bootstrap les données du nouveau compte
                  const { bootstrapAccountData } = await import("./usaPortal/parallel-bootstrap.js");
                  const bootResult = await bootstrapAccountData(job, username);

                  subscribeLate(ofcKey, {
                    jobId: job.id,
                    username,
                    proxyUrl: subProxy,
                    job,
                    appDetails: bootResult.appDetails ?? {
                      applicantId: "0",
                      applicationId: "",
                      visaType: bootResult.visaType || "NIV",
                      visaClass: bootResult.visaClass || "",
                    },
                    rescheduleYN: job.hunterConfig.rescheduleMode,
                    dateFrom: job.hunterConfig.slotDateFrom,
                    dateDeadline: job.hunterConfig.slotDateDeadline,
                  });
                  log("INFO", `[parallel-relogin] ✅ ${username.slice(0, 12)}… inscrit au watcher OFC Kinshasa`);
                } else {
                  // Pas de watcher actif → lancer le watcher avec ce compte
                  log("INFO", `[parallel-relogin] 🚀 Aucun watcher actif — lancement avec ${username.slice(0, 12)}…`);
                  await initParallelWatchers();
                }
              }
              continue; // Passer au prochain job (celui-ci vient d'être inscrit)
            }

            // ── Rotation + re-login pour les comptes déjà inscrits ────────────
            const restTime = getRestTimeRemaining(username);
            const sessionsLeft = getSessionsRemainingToday(username);
            
            if (restTime > 0) {
              // Log uniquement toutes les ~15 min pour éviter le spam
              continue;
            }
            
            if (sessionsLeft <= 0) {
              continue;
            }

            if (isAccountReadyForRelogin(username)) {
              // FIX-21: Safety net — vérifier le minimum absolu entre re-logins.
              // Même si isAccountReadyForRelogin() dit OK, imposer 10 min minimum
              // depuis la dernière TENTATIVE (pas le dernier succès) pour ce compte.
              const lastAttempt = lastReloginAttemptAt.get(key) ?? 0;
              const timeSinceLastAttempt = Date.now() - lastAttempt;
              if (timeSinceLastAttempt < MIN_RELOGIN_INTERVAL_MS) {
                const waitMin = Math.round((MIN_RELOGIN_INTERVAL_MS - timeSinceLastAttempt) / 60_000);
                log("INFO", `[parallel-relogin] ⏱️ ${username.slice(0, 12)}… — safety net: attente ${waitMin}min (min 10min entre tentatives)`);
                continue;
              }

              // Enregistrer la tentative AVANT le login (même si elle échoue)
              lastReloginAttemptAt.set(key, Date.now());

              log("INFO", `[parallel-relogin] 🔑 ${username.slice(0, 12)}… prêt pour re-login (cooldown terminé, ${sessionsLeft} sessions restantes)`);
              const success = await performScheduledRelogin(username);
              if (success) {
                log("INFO", `[parallel-relogin] ✅ ${username.slice(0, 12)}… re-login réussi`);

                // FIX-22: Si aucun watcher n'est actif (bootstrap initial échoué car tous
                // les comptes étaient restreints), RELANCER initParallelWatchers maintenant
                // qu'un compte est connecté. C'est la promesse du message d'erreur initial :
                // "Attente re-login — le relogin loop relancera le watcher"
                const ofcKey = makeKey("usa", "Kinshasa", 323);
                if (!hasActiveWatcher(ofcKey)) {
                  log("INFO", `[parallel-relogin] 🚀 Aucun watcher actif — lancement avec ${username.slice(0, 12)}… (post re-login)`);
                  await initParallelWatchers();
                } else if (hasActiveWatcher(ofcKey)) {
                  try {
                    const { bootstrapAccountData } = await import("./usaPortal/parallel-bootstrap.js");
                    const bootResult = await bootstrapAccountData(job, username);
                    if (bootResult.success && bootResult.appDetails) {
                      // Résoudre le proxy pour ce compte (respecte proxy_priority)
                      let rebootProxy: string | undefined;
                      if (job.hunterConfig.useResidentialProxy) {
                        const { resolveProxyWithFailover } = await import("./usaPortal/accounts-keep-alive.js");
                        rebootProxy = await resolveProxyWithFailover(username, job.id, job.hunterConfig);
                      }
                      // Mettre à jour le subscriber avec les nouvelles données
                      subscribeLate(ofcKey, {
                        jobId: job.id,
                        username,
                        proxyUrl: rebootProxy,
                        job,
                        appDetails: bootResult.appDetails,
                        rescheduleYN: job.hunterConfig.rescheduleMode,
                        dateFrom: job.hunterConfig.slotDateFrom,
                        dateDeadline: job.hunterConfig.slotDateDeadline,
                      });
                      log("INFO", `[parallel-relogin] 🔄 ${username.slice(0, 12)}… re-bootstrap OK — subscriber mis à jour`);
                    }
                  } catch (bootErr) {
                    log("WARN", `[parallel-relogin] ⚠️ Re-bootstrap échoué pour ${username.slice(0, 12)}…: ${bootErr}`);
                  }
                }
              } else {
                log("WARN", `[parallel-relogin] ⏳ ${username.slice(0, 12)}… re-login refusé (cooldown/restriction en cours)`);
              }
              // Radio silence entre re-logins de comptes différents (2-4 min)
              const silence = 2 * 60_000 + Math.random() * 2 * 60_000;
              await new Promise(r => setTimeout(r, silence));
            }
          }
        } catch (err) {
          log("WARN", `[parallel-relogin] Erreur: ${err}`);
        }
      }
    };

    // Lancer en background (non-bloquant)
    parallelReloginLoop().catch(err => {
      log("ERROR", `[parallel-relogin] Fatal: ${err}`);
    });
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
    // En mode parallèle, le stagger est inutile pour les jobs USA car le OFC Watcher
    // gère le polling de manière centralisée. On skip pour éviter de planifier des
    // scheduledNextDue qui empêchent les jobs d'être "dûs" (bug: jobs jamais lancés).
    // En mode V3, les jobs USA sont gérés par la boucle V3 autonome — pas de stagger.
    if (!isParallelMode && !v3Mode) {
      staggerInitialSchedules(jobs);
    }

    // Vérification quotidienne du bundle portail USA (non bloquante)
    await checkPortalBundleKey(jobs);

    // En mode parallèle, exclure les dossiers USA de la boucle legacy
    // (ils sont gérés par le watcher OFC + booking race)
    // En mode V3, exclure les dossiers USA (gérés par la boucle V3 autonome)
    const legacyJobs = (parallelMode || v3Mode)
      ? jobs.filter(j => j.destination !== "usa")
      : jobs;

    const due = findNextDueJob(legacyJobs);

    if (!due) {
      const waitMs = getTimeUntilNextDue(jobs);
      const usaExcluded = isParallelMode || v3Mode;
      const activeCount = jobs.filter((j) =>
        !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
        !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === "")))
      ).length;

      if (activeCount === 0) {
        if (v3Mode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par V3 Chasseur — polling dans 90s");
        } else if (isParallelMode) {
          log("INFO", "Scheduler séquentiel idle — jobs USA gérés par OFC Watcher — polling dans 90s");
        } else {
          log("INFO", "Aucun dossier actif — polling dans 90s");
        }
      } else {
        const tierCounts = jobs
          .filter((j) =>
            !pausedJobs.has(j.id) && j.hunterConfig?.isActive &&
            !(usaExcluded && (j.destination === "usa" || (!j.destination || j.destination === "")))
          )
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

    // ── Skip intelligent : simuler un humain distrait (HORS rush uniquement) ──
    // Un humain ne scanne pas avec une perfection mécanique. Parfois il rate un cycle.
    // JAMAIS pendant les rush hours → capture maximale quand les créneaux apparaissent.
    if (shouldSkipCycle(due.urgencyTier)) {
      log("INFO", `[${due.applicantName}] 💭 Skip aléatoire (humain distrait) — cycle ignoré`);
      // Replanifier normalement comme si c'était un not_found
      const skipInterval = generateIntervalMs(due.urgencyTier);
      scheduledNextDue.set(due.id, Date.now() + skipInterval);
      log("INFO", `[${due.applicantName}] Prochain check dans ${formatMs(skipInterval)}`);
      // Silence radio réduit (skip = pas de requête envoyée → pas besoin de cooldown long)
      await new Promise((r) => setTimeout(r, 5_000 + Math.random() * 10_000));
      continue;
    }

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
      // FIX 1: Per-dossier radio silence (non-blocking) instead of global await sleep
      // Determine if a same-tier sibling is due soon (for reduced silence)
      const nextJob = findNextDueJobSoon(jobs, due.urgencyTier);
      const sameTierNext = !!nextJob;
      applyRadioSilence(due.id, sameTierNext);
    }

    // FIX 1: Polling rapide (pas de sleep global) — la boucle reboucle en ~30s
    // Le filtre isInRadioSilence() empêche de relancer un dossier trop tôt
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
