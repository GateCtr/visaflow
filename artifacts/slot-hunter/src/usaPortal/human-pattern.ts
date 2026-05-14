/**
 * Gestion des patterns humains pour éviter la détection
 * Un humain ne reste pas connecté 24h/24 avec des refresh automatiques
 */

import {
  MAX_HUMAN_SESSION_MS,
  MIN_SESSION_BREAK_MS,
  MAX_SESSION_BREAK_MS,
  HUMAN_ACTIVE_START_HOUR,
  HUMAN_ACTIVE_END_HOUR,
} from "./config.js";

// Stocker l'historique des sessions par compte
const sessionHistory = new Map<
  string,
  {
    sessionStart: number;
    totalActiveTime: number;
    lastBreakEnd: number;
    consecutiveSessions: number;
  }
>();

/**
 * Vérifie si une nouvelle session est "humaine"
 * Retourne false si besoin de faire une pause longue
 */
export function shouldStartNewSession(username: string): { ok: boolean; reason: string; waitMs?: number } {
  const cacheKey = username.toLowerCase();
  const now = Date.now();
  const nowHour = new Date(now).getHours();
  
  // 1. Vérifier les heures d'activité humaine
  if (nowHour < HUMAN_ACTIVE_START_HOUR || nowHour >= HUMAN_ACTIVE_END_HOUR) {
    const nextActiveHour = nowHour < HUMAN_ACTIVE_START_HOUR 
      ? HUMAN_ACTIVE_START_HOUR 
      : HUMAN_ACTIVE_START_HOUR + 24; // Demain
    const waitMs = (nextActiveHour - nowHour) * 60 * 60 * 1000;
    return {
      ok: false,
      reason: `Heure non humaine (${nowHour}h). Attente jusqu'à ${HUMAN_ACTIVE_START_HOUR}h`,
      waitMs,
    };
  }
  
  const history = sessionHistory.get(cacheKey);
  
  // Première session du compte
  if (!history) {
    sessionHistory.set(cacheKey, {
      sessionStart: now,
      totalActiveTime: 0,
      lastBreakEnd: now,
      consecutiveSessions: 1,
    });
    return { ok: true, reason: "Première session" };
  }
  
  const timeSinceLastBreak = now - history.lastBreakEnd;
  const totalSessionTime = history.totalActiveTime + (now - history.sessionStart);
  
  // 2. Vérifier durée totale de session (max 3 heures)
  if (totalSessionTime >= MAX_HUMAN_SESSION_MS) {
    const breakDuration = MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
    sessionHistory.set(cacheKey, {
      sessionStart: 0,
      totalActiveTime: 0,
      lastBreakEnd: now + breakDuration,
      consecutiveSessions: 0,
    });
    return {
      ok: false,
      reason: `Session trop longue (${Math.round(totalSessionTime / 3600000)}h). Pause de ${Math.round(breakDuration / 3600000)}h`,
      waitMs: breakDuration,
    };
  }
  
  // 3. Vérifier sessions consécutives (max 3-5)
  if (history.consecutiveSessions >= 3 + Math.floor(Math.random() * 3)) { // 3-5 sessions
    const breakDuration = MIN_SESSION_BREAK_MS + Math.random() * (MAX_SESSION_BREAK_MS - MIN_SESSION_BREAK_MS);
    sessionHistory.set(cacheKey, {
      sessionStart: 0,
      totalActiveTime: 0,
      lastBreakEnd: now + breakDuration,
      consecutiveSessions: 0,
    });
    return {
      ok: false,
      reason: `Trop de sessions consécutives (${history.consecutiveSessions}). Pause de ${Math.round(breakDuration / 3600000)}h`,
      waitMs: breakDuration,
    };
  }
  
  // 4. Mettre à jour l'historique
  sessionHistory.set(cacheKey, {
    sessionStart: history.sessionStart || now,
    totalActiveTime: history.totalActiveTime,
    lastBreakEnd: history.lastBreakEnd,
    consecutiveSessions: history.consecutiveSessions + 1,
  });
  
  return { ok: true, reason: "Pattern humain OK" };
}

/**
 * Marque la fin d'une session (logout ou erreur)
 */
export function markSessionEnd(username: string): void {
  const cacheKey = username.toLowerCase();
  const history = sessionHistory.get(cacheKey);
  
  if (history && history.sessionStart > 0) {
    const sessionDuration = Date.now() - history.sessionStart;
    sessionHistory.set(cacheKey, {
      sessionStart: 0,
      totalActiveTime: history.totalActiveTime + sessionDuration,
      lastBreakEnd: history.lastBreakEnd,
      consecutiveSessions: history.consecutiveSessions,
    });
  }
}

/**
 * Vérifie si on est dans une période de pause
 */
export function isInBreakPeriod(username: string): boolean {
  const cacheKey = username.toLowerCase();
  const history = sessionHistory.get(cacheKey);
  
  if (!history) return false;
  
  const now = Date.now();
  if (history.lastBreakEnd > now) {
    const remainingMs = history.lastBreakEnd - now;
    const remainingHours = Math.round(remainingMs / 3600000 * 10) / 10;
    console.log(`[human] ⏸️  Pause en cours: ${remainingHours}h restantes`);
    return true;
  }
  
  return false;
}

/**
 * Obtient le statut du pattern humain
 */
export function getHumanPatternStatus(username: string): {
  inBreak: boolean;
  breakRemainingMs?: number;
  consecutiveSessions: number;
  totalActiveHours: number;
} {
  const cacheKey = username.toLowerCase();
  const history = sessionHistory.get(cacheKey);
  const now = Date.now();
  
  if (!history) {
    return { inBreak: false, consecutiveSessions: 0, totalActiveHours: 0 };
  }
  
  const inBreak = history.lastBreakEnd > now;
  const breakRemainingMs = inBreak ? history.lastBreakEnd - now : undefined;
  const totalActiveHours = Math.round(history.totalActiveTime / 3600000 * 10) / 10;
  
  return {
    inBreak,
    breakRemainingMs,
    consecutiveSessions: history.consecutiveSessions,
    totalActiveHours,
  };
}