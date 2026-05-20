// ─── CEV Setup Loop — établissement automatique de sessions (needs_setup) ────
// Extracted from index.ts

import { getPendingCevSetups, resetCevSetupLock, recordCevSetupLoginFail, reportSlotFound } from "../convexClient.js";
import { runCevDirectSessionSetup } from "../cevBooking.js";
import { setupCevSessionHttp } from "../cevHttpSetup.js";

// Timeout global par setup : 4 min (le lock Convex dure 13 min)
const CEV_SETUP_TIMEOUT_MS = 4 * 60_000;

// ─── Compteur local de clics GetEAppointmentUrl (limite 4/heure, marge de sécurité) ──
// Empêche de déclencher le rate-limit VOWINT avant que le serveur ne nous bloque.
const MAX_CLICKS_PER_HOUR = 4; // 5 max côté serveur, on garde 1 de marge
const CLICK_WINDOW_MS = 60 * 60_000; // 1 heure
let clickTimestamps: number[] = [];

function canClick(): boolean {
  const now = Date.now();
  // Purger les clics > 1h
  clickTimestamps = clickTimestamps.filter(t => now - t < CLICK_WINDOW_MS);
  return clickTimestamps.length < MAX_CLICKS_PER_HOUR;
}

function recordClick(): void {
  clickTimestamps.push(Date.now());
}

function getNextClickAvailableIn(): number {
  if (clickTimestamps.length === 0) return 0;
  const oldest = clickTimestamps[0];
  const availableAt = oldest + CLICK_WINDOW_MS;
  return Math.max(0, availableAt - Date.now());
}

export async function startCevSetupLoop(): Promise<void> {
  console.log("[CEV-SETUP] Boucle de setup sessions CEV démarrée");
  let heartbeatCounter = 0;

  // ── Tracking local des échecs consécutifs par session ──────────────────────
  const sessionFailTracker = new Map<string, { count: number; firstFailAt: number; lastError: string }>();
  const IMPLICIT_RATE_LIMIT_THRESHOLD = 3;
  const IMPLICIT_RATE_LIMIT_WINDOW_MS = 45 * 60_000;

  while (true) {
    try {
      const pending = await getPendingCevSetups();
      heartbeatCounter++;

      console.log(`[CEV-SETUP] ♥ check — ${pending.length} session(s) à établir (iter=${heartbeatCounter})`);

      // Séquentiellement (Playwright est lourd, pas en parallèle)
      for (const s of pending) {
        const isCredMode = !!(s.vowintEmail && s.vowintPassword);
        console.log(
          `[CEV-SETUP] ▶ Établissement session=${s.sessionId} mode=${isCredMode ? "vowint-credentials" : "url-direct"}`
        );

        // ── Stratégie 1 : HTTP pur (rapide, ~5s, pas de Playwright) ──────────
        let r: { success: boolean; error?: string; sessionCookie?: string; validUntilMs?: number; integrationUrl?: string };

        if (isCredMode) {
          // Vérifier la limite de clics AVANT de lancer le setup
          if (!canClick()) {
            const waitMs = getNextClickAvailableIn();
            const waitMin = Math.ceil(waitMs / 60_000);
            console.log(`[CEV-SETUP] ⏳ Limite ${MAX_CLICKS_PER_HOUR} clics/h atteinte — prochain clic disponible dans ${waitMin} min (session=${s.sessionId})`);
            r = { success: false, error: "LOCAL_RATE_LIMIT_WAIT" };
            // Ne pas fallback Playwright — juste attendre
            continue;
          }

          console.log(`[CEV-SETUP] 🌐 Tentative HTTP pur session=${s.sessionId} (clics: ${clickTimestamps.length}/${MAX_CLICKS_PER_HOUR})...`);
          const httpResult = await setupCevSessionHttp(
            s.vowintEmail!,
            s.vowintPassword!,
            s.applicationId,
            s.applicationId,
            s.vowintAppUrl,
          );

          if (httpResult.success) {
            // Enregistrer le clic (GetEAppointmentUrl a été appelé avec succès)
            recordClick();
            console.log(`[CEV-SETUP] 🔑 Session HTTP réussie session=${s.sessionId} — verdict: slotsAvailable=${httpResult.slotsAvailable} (clics: ${clickTimestamps.length}/${MAX_CLICKS_PER_HOUR})`);

            if (httpResult.slotsAvailable) {
              // Slots dispo → activer la session pour polling immédiat + booking
              const { activateCevSession } = await import("../convexClient.js");
              const activated = await activateCevSession(
                s.sessionId,
                httpResult.sessionCookie!,
                httpResult.validUntilMs,
                httpResult.integrationUrl,
              );
              if (activated) {
                r = { success: true };
                console.log(`[CEV-SETUP] 🚨 SLOTS DISPONIBLES session=${s.sessionId} — booking prioritaire`);
                await reportSlotFound({
                  applicationId: s.applicationId,
                  date: "detection_http",
                  time: new Date().toISOString(),
                  location: "CEV - Ambassade de Belgique (HTTP pur)",
                });
              } else {
                r = { success: false, error: "CONVEX_ACTIVATE_FAILED" };
              }
            } else {
              // NoAvailability → session déjà consommée côté serveur, inutile de l'activer pour polling.
              // On enregistre directement "no_slot" pour éviter un poll qui retournerait session_expired.
              r = { success: true };
              const { recordCevSessionCheck } = await import("../convexClient.js");
              await recordCevSessionCheck(s.sessionId, "no_slot");
              console.log(`[CEV-SETUP] 📡 Pas de créneaux — session consommée (NoAvailability) — skip polling session=${s.sessionId}`);
            }

          } else {
            console.log(`[CEV-SETUP] 🌐 HTTP échoué (${httpResult.error}) — fallback Playwright...`);
            r = { success: false, error: httpResult.error };
          }
        } else {
          r = { success: false, error: "NO_CREDENTIALS_FOR_HTTP" };
        }

        // ── Stratégie 2 : Playwright (fallback si HTTP échoue) ───────────────
        const skipPlaywright = (
          r.error === "CEV_VOWINT_SESSION_FAILED" ||
          r.error === "SESSION_EXPIRED_AFTER_REDIRECT" ||
          r.error === "PLAYWRIGHT_UNAVAILABLE" ||
          (r.error ?? "").includes("RATE_LIMIT") ||
          (r.error ?? "").includes("TooManyAttempts")
        );

        if (!r.success && !skipPlaywright) {
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
          sessionFailTracker.delete(s.sessionId as string);
        } else {
          console.log(`[CEV-SETUP] ❌ Échec session=${s.sessionId}: ${r.error}`);

          const isLoginFailure = r.error === "CEV_VOWINT_SESSION_FAILED";
          const isTimeout = r.error === "TIMEOUT_4MIN";
          const isSessionDead = r.error === "CEV_SESSION_DEAD_NO_POLL";
          const isTooManyAttempts = (r.error ?? "").includes("TooManyAttempts") || (r.error ?? "").includes("RATE_LIMIT");
          const isRateLimit = isTooManyAttempts;

          if (isTooManyAttempts) {
            console.log(`[CEV-SETUP] 🚫 RATE-LIMIT VOWINT session=${s.sessionId} — lock 60 min (blocage VOWINT)`);
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
          } else if (isSessionDead) {
            console.log(`[CEV-SETUP] 🔒 Session=${s.sessionId} cookie seul insuffisant pour poll (401) — lock maintenu 13 min`);
          } else if (isLoginFailure && !isRateLimit) {
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
            console.log(`[CEV-SETUP] 🔓 Déverrouillage session=${s.sessionId} (timeout)`);
            await resetCevSetupLock(s.sessionId).catch(() => {});
          } else {
            const sid = s.sessionId as string;
            const tracker = sessionFailTracker.get(sid);
            const now = Date.now();

            if (tracker && (now - tracker.firstFailAt) < IMPLICIT_RATE_LIMIT_WINDOW_MS) {
              tracker.count += 1;
              tracker.lastError = r.error ?? "UNKNOWN";
            } else {
              sessionFailTracker.set(sid, { count: 1, firstFailAt: now, lastError: r.error ?? "UNKNOWN" });
            }

            const currentTracker = sessionFailTracker.get(sid)!;
            if (currentTracker.count >= IMPLICIT_RATE_LIMIT_THRESHOLD) {
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
              sessionFailTracker.delete(sid);
            } else {
              console.log(`[CEV-SETUP] ⚠️  Échec ${currentTracker.count}/${IMPLICIT_RATE_LIMIT_THRESHOLD} session=${s.sessionId} (${r.error}) — lock 13 min normal`);
            }
          }
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

    await new Promise((r) => setTimeout(r, 60_000));
  }
}
