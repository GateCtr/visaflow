import type { UsaSession } from "./types.js";
import { USA_BASE, REFERER_DASHBOARD, WARMUP_INTERVAL_MS } from "./config.js";
import { botLog } from "../convexClient.js";
import {
  humanPause,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
} from "../humanBehavior.js";
import { usaFetch, authHeaders } from "./usa-http.js";

// ─── Nouvelles fonctions anti-détection ──────────────────────────────────────

/**
 * Pause aléatoire entre les étapes pour simuler le comportement humain
 */
export async function randomInterStepPause(minMs: number = 500, maxMs: number = 3000, jobId?: string): Promise<void> {
  const delay = minMs + Math.random() * (maxMs - minMs);
  if (delay > 1000) {
    console.log(`[human] Pause inter-étape: ${Math.round(delay / 1000)}s`);
    // Log les pauses significatives
    if (jobId && delay > 2000) {
      botLog({
        applicationId: jobId,
        step: "human_behavior",
        status: "ok",
        data: {
          type: "inter_step_pause",
          durationMs: delay,
          minMs,
          maxMs
        }
      });
    }
  }
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Définit différents flows possibles pour varier la séquence des requêtes
 */
type FlowStep = "login" | "status" | "ofc" | "dates" | "times" | "warmup" | "noise" | "transform";
const POSSIBLE_FLOWS: FlowStep[][] = [
  ["login", "status", "ofc", "dates", "times"],
  ["login", "status", "dates", "ofc", "times"],
  ["login", "ofc", "status", "dates", "times"],
  ["login", "dates", "status", "ofc", "times"],
  ["login", "warmup", "status", "ofc", "dates", "times"],
  ["login", "status", "warmup", "ofc", "dates", "times"]
];

/**
 * Sélectionne un flow aléatoire pour cette session
 */
export function selectRandomFlow(): FlowStep[] {
  const flow = POSSIBLE_FLOWS[Math.floor(Math.random() * POSSIBLE_FLOWS.length)];
  console.log(`[anti-detection] Flow sélectionné: ${flow.join(" → ")}`);
  return flow;
}

/**
 * Envoie des requêtes "bruit" occasionnelles pour simuler la navigation humaine
 */
export async function sendAntiDetectionNoise(
  session: UsaSession, 
  jobId?: string
): Promise<void> {
  if (Math.random() < 0.15) { // 15% du temps
    const noiseEndpoints = [
      `${USA_BASE}/api/help`,
      `${USA_BASE}/api/faq`,
      `${USA_BASE}/api/contact`,
      `${USA_BASE}/api/privacy`,
      `${USA_BASE}/visaapplicantui/home/dashboard/help`,
      `${USA_BASE}/visaapplicantui/home/dashboard/faq`
    ];
    
    const endpoint = noiseEndpoints[Math.floor(Math.random() * noiseEndpoints.length)];
    try {
      console.log(`[anti-detection] 📡 Requête bruit vers: ${endpoint}`);
      await usaFetch(endpoint, {
        method: "GET",
        headers: authHeaders(session.accessToken, REFERER_DASHBOARD, false)
      });
      
      // Log la requête bruit
      if (jobId) {
        botLog({
          applicationId: jobId,
          step: "anti_detection",
          status: "ok",
          data: {
            type: "noise_request",
            endpoint: endpoint,
            timestamp: Date.now()
          }
        });
      }
    } catch (error) {
      // Ignorer les erreurs (comportement humain - les requêtes peuvent échouer)
      console.log(`[anti-detection] Requête bruit échouée (comportement normal): ${error}`);
    }
  }
}

/**
 * Système de réputation de proxy pour éviter les IPs à risque
 */
interface ProxyReputation {
  proxyUrl: string;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  banScore: number; // 0-100, plus haut = plus risqué
}

const proxyReputations = new Map<string, ProxyReputation>();

/**
 * Met à jour la réputation d'un proxy après une requête
 */
export function updateProxyReputation(proxyUrl: string, success: boolean): void {
  const existing = proxyReputations.get(proxyUrl) || {
    proxyUrl,
    successCount: 0,
    failureCount: 0,
    lastUsed: Date.now(),
    banScore: 0
  };
  
  if (success) {
    existing.successCount++;
    // Réduire le banScore après des succès consécutifs
    existing.banScore = Math.max(0, existing.banScore - 5);
  } else {
    existing.failureCount++;
    // Augmenter le banScore après des échecs
    existing.banScore = Math.min(100, existing.banScore + 20);
  }
  
  existing.lastUsed = Date.now();
  proxyReputations.set(proxyUrl, existing);
  
  // Nettoyer les vieilles entrées (plus de 24h)
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const [url, rep] of proxyReputations.entries()) {
    if (rep.lastUsed < twentyFourHoursAgo) {
      proxyReputations.delete(url);
    }
  }
}

/**
 * Choisit le meilleur proxy disponible basé sur la réputation
 */
export function selectBestProxy(availableProxies: string[]): string | undefined {
  if (availableProxies.length === 0) return undefined;
  
  const reputations = availableProxies
    .map(url => proxyReputations.get(url) || {
      proxyUrl: url,
      successCount: 0,
      failureCount: 0,
      lastUsed: 0,
      banScore: 0
    })
    .filter(rep => rep.banScore < 50); // Éviter les proxies à haut risque
  
  if (reputations.length === 0) {
    // Tous les proxies ont un score élevé, prendre le moins pire
    return availableProxies[0];
  }
  
  // Priorité: faible banScore, puis succès élevés, puis récent
  const best = reputations.sort((a, b) => {
    if (a.banScore !== b.banScore) return a.banScore - b.banScore;
    if (a.successCount !== b.successCount) return b.successCount - a.successCount;
    return b.lastUsed - a.lastUsed;
  })[0];
  
  return best.proxyUrl;
}

// ─── Warm-up throttle : éviter d'appeler landingPage+sanityCheck+checkFcs à chaque cycle ──
// Ces 3 appels "anti-détection" font +3 requêtes par cycle. En tier tres_urgent (3-5 min),
// c'est 36-60 appels supplémentaires par heure juste pour le warm-up.
// Solution : warm-up max 1 fois toutes les WARMUP_INTERVAL_MS (8 min).

export const warmupLastCalledAt = new Map<string, number>(); // key = applicationId

/** Vrai si le warm-up doit être effectué (première fois ou > WARMUP_INTERVAL_MS depuis le dernier). */
export function shouldDoWarmup(applicationId: string): boolean {
  const last = warmupLastCalledAt.get(applicationId);
  return last === undefined || Date.now() - last > WARMUP_INTERVAL_MS;
}

/**
 * Exécute des étapes avec variabilité humaine (ordre aléatoire, pauses)
 */
export async function executeWithHumanVariability(
  steps: Array<{ name: string; execute: () => Promise<void>; critical?: boolean }>,
  context: string = "",
  jobId?: string
): Promise<void> {
  // Séparer les étapes critiques et non-critiques
  const criticalSteps = steps.filter(step => step.critical);
  const nonCriticalSteps = steps.filter(step => !step.critical);
  
  // Exécuter les étapes critiques dans l'ordre
  for (const step of criticalSteps) {
    console.log(`[human] ${context}Étape critique: ${step.name}`);
    await step.execute();
    await humanPause(300, `après ${step.name} `, jobId);
  }
  
  // Mélanger et exécuter les étapes non-critiques
  const shuffledSteps = shuffleArray(nonCriticalSteps);
  const stepsToExecute = randomSubset(shuffledSteps, 1, shuffledSteps.length);
  
  for (const step of stepsToExecute) {
    console.log(`[human] ${context}Étape aléatoire: ${step.name}`);
    await step.execute();
    await humanPause(500, `après ${step.name} `, jobId);
  }
  
  // 30% du temps : simuler un clic de menu supplémentaire
  if (Math.random() < 0.3) {
    await simulateMenuClick({}, jobId);
    await humanPause(200, "après clic menu ", jobId);
  }
  
  // 10% du temps : simuler un rafraîchissement
  if (Math.random() < 0.1) {
    await simulatePageRefresh(jobId);
  }
}

// ─── OFC round-robin : scanner 1 seule OFC par cycle (rotation) ─────────────
// Avec N OFCs et tier tres_urgent (3-5 min), scanner toutes les OFCs à chaque cycle =
// N×3 appels supplémentaires par cycle. Avec 3 OFCs → 9 appels → 108-180/heure.
// Solution : scanner 1 OFC par cycle en rotation. Chaque OFC est vérifiée toutes les N×(3-5) min.
// Acceptable car les créneaux n'apparaissent pas à la seconde — 10-15 min de latence est OK.
export const ofcCursor = new Map<string, number>(); // key = applicationId, value = index OFC courant

