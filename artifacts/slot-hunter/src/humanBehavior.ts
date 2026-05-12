/**
 * Fonctions pour simuler un comportement humain dans le bot USA
 */

import { botLog } from "./convexClient.js";

/**
 * Distribution humaine des pauses (loi de puissance)
 * - 70% du temps : pauses courtes (0.5x à 1x base)
 * - 25% du temps : pauses moyennes (1x à 3x base)  
 * - 5% du temps : pauses longues (3x à 8x base)
 */
export function humanLikeDelay(baseMs: number): number {
  const r = Math.random();
  if (r < 0.7) {
    // Courtes pauses fréquentes
    return baseMs * (0.5 + Math.random() * 0.5);
  }
  if (r < 0.95) {
    // Pauses moyennes
    return baseMs * (1 + Math.random() * 2);
  }
  // Longues pauses rares
  return baseMs * (3 + Math.random() * 5);
}

/**
 * Pause humaine avec log
 */
export async function humanPause(baseMs: number, context: string = "", jobId?: string): Promise<void> {
  const delay = humanLikeDelay(baseMs);
  if (delay > 2000) {
    console.log(`[human] ${context}Pause de ${Math.round(delay / 1000)}s`);
    // Log les pauses longues dans botLog si jobId fourni
    if (jobId && delay > 5000) {
      botLog({
        applicationId: jobId,
        step: "human_behavior",
        status: "ok",
        data: {
          type: "long_pause",
          durationMs: delay,
          context: context.trim()
        }
      });
    }
  }
  await new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * Génère des headers légèrement variables pour éviter le "trop parfait".
 * 
 * RÈGLES DE SÉCURITÉ (ne JAMAIS violer) :
 * - Ne JAMAIS supprimer les headers Sec-Fetch-* (le serveur les vérifie → 401 sinon)
 * - Ne JAMAIS supprimer Accept-Encoding ou le simplifier (absence de br/zstd = fingerprint bot)
 * - Ne JAMAIS ajouter de Cookie (conflit avec la session réelle → 401)
 * - Ne JAMAIS modifier Authorization, Content-Type, Origin, Referer
 * 
 * Variabilité SAFE uniquement :
 * - Accept-Language : variations mineures (ordre des langues, ajout d'une locale)
 * - Cache-Control / Pragma : suppression de l'un des deux (les navigateurs varient)
 * - X-Correlation-key : déjà aléatoire par construction
 */
export function getVariableBrowserHeaders(baseHeaders: Record<string, string>, jobId?: string): Record<string, string> {
  const headers = { ...baseHeaders };
  const r = Math.random();
  let modifications: string[] = [];

  // Headers CRITIQUES — ne JAMAIS toucher
  // Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, Sec-CH-UA*, 
  // Accept-Encoding, Authorization, Content-Type, Origin, Referer, User-Agent, Cookie

  // 15% du temps : supprimer Pragma (certains Chrome ne l'envoient pas systématiquement)
  if (r < 0.15) {
    delete headers["Pragma"];
    modifications.push("pragma_removed");
  }

  // 10% du temps : variante Accept-Language (ordre légèrement différent)
  if (r > 0.85 && r < 0.95) {
    const langVariants = [
      "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "fr-CD,fr;q=0.9,en;q=0.8",
      "fr;q=0.9,en-US;q=0.8,en;q=0.7,fr-CD;q=0.6",
      "fr-CD,fr;q=0.9,en-US;q=0.8,en;q=0.7,ln;q=0.5",
    ];
    headers["Accept-Language"] = langVariants[Math.floor(Math.random() * langVariants.length)];
    modifications.push("accept_language_varied");
  }

  // 8% du temps : ajouter Cache-Control: no-store en plus de no-cache (variante navigateur)
  if (r > 0.42 && r < 0.50) {
    headers["Cache-Control"] = "no-cache, no-store";
    modifications.push("cache_control_extended");
  }

  // Log les modifications si jobId fourni et modifications effectuées
  if (jobId && modifications.length > 0) {
    botLog({
      applicationId: jobId,
      step: "human_behavior",
      status: "ok",
      data: {
        type: "headers_variability",
        modifications: modifications,
        randomValue: r
      }
    });
  }

  return headers;
}

/**
 * Simule une erreur réseau occasionnelle (comportement humain)
 * Retourne true si une erreur doit être simulée
 */
export function shouldSimulateNetworkError(jobId?: string): boolean {
  const shouldSimulate = Math.random() < 0.02;
  
  // Log la décision de simuler une erreur si jobId fourni
  if (jobId && shouldSimulate) {
    botLog({
      applicationId: jobId,
      step: "human_behavior",
      status: "warn",
      data: {
        type: "network_error_simulated_decision",
        probability: 0.02,
        decision: true
      }
    });
  }
  
  return shouldSimulate;
}

/**
 * Simule un timeout réseau
 */
export async function simulateNetworkTimeout(delayMs: number = 2000, jobId?: string): Promise<void> {
  console.log(`[human] ⏱️ Timeout réseau simulé (${delayMs}ms)`);
  
  // Log le timeout réseau dans botLog si jobId fourni
  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "human_behavior",
      status: "warn",
      data: {
        type: "network_timeout_simulated",
        durationMs: delayMs
      }
    });
  }
  
  await new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Mélange un tableau (Fisher-Yates shuffle)
 */
export function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Sélectionne un sous-ensemble aléatoire d'un tableau
 */
export function randomSubset<T>(array: T[], min: number = 1, max?: number): T[] {
  const count = Math.floor(Math.random() * (max ? Math.min(max, array.length) : array.length)) + min;
  const shuffled = shuffleArray(array);
  return shuffled.slice(0, Math.min(count, array.length));
}

/**
 * Simule un clic humain sur un menu non-essentiel
 */
export async function simulateMenuClick(session: any, jobId?: string): Promise<void> {
  const fakeEndpoints = [
    '/api/help',
    '/api/faq', 
    '/api/contact',
    '/api/privacy',
    '/api/terms'
  ];
  
  const endpoint = fakeEndpoints[Math.floor(Math.random() * fakeEndpoints.length)];
  console.log(`[human] 🖱️ Clic simulé sur ${endpoint}`);
  
  // Log le clic de menu dans botLog si jobId fourni
  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "human_behavior",
      status: "ok",
      data: {
        type: "menu_click_simulated",
        endpoint: endpoint
      }
    });
  }
  
  // Ne pas attendre la réponse (fire-and-forget comme un vrai navigateur)
  try {
    // Simuler juste le début de la requête
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));
  } catch {
    // Ignorer les erreurs
  }
}

/**
 * Simule un rafraîchissement de page
 */
export async function simulatePageRefresh(jobId?: string): Promise<void> {
  console.log(`[human] 🔄 Rafraîchissement de page simulé`);
  
  // Log le rafraîchissement dans botLog si jobId fourni
  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "human_behavior",
      status: "ok",
      data: {
        type: "page_refresh_simulated"
      }
    });
  }
  
  await humanPause(500, "après rafraîchissement ", jobId);
}

/**
 * Calcule le temps d'exécution estimé avec les améliorations humaines
 */
export function estimateExecutionTime(
  baseTimeMs: number,
  humanFactor: number = 1.5, // Facteur multiplicateur pour comportement humain
  jobId?: string
): { min: number; avg: number; max: number } {
  const min = Math.round(baseTimeMs * 1.2 / 1000); // +20%
  const avg = Math.round(baseTimeMs * humanFactor / 1000);
  const max = Math.round(baseTimeMs * 2.0 / 1000); // +100%
  
  // Log l'estimation de temps dans botLog si jobId fourni
  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "execution_time",
      status: "ok",
      data: {
        type: "time_estimation",
        baseTimeMs: baseTimeMs,
        humanFactor: humanFactor,
        estimatedMin: min,
        estimatedAvg: avg,
        estimatedMax: max
      }
    });
  }
  
  return { min, avg, max };
}

/**
 * Affiche un rapport de temps d'exécution
 */
export function printExecutionTimeReport(
  stepName: string,
  baseTimeMs: number,
  humanTimeMs: number,
  jobId?: string
): void {
  const increase = ((humanTimeMs - baseTimeMs) / baseTimeMs * 100).toFixed(1);
  console.log(`[time] ${stepName}:`);
  console.log(`  Base: ${Math.round(baseTimeMs / 1000)}s`);
  console.log(`  Humain: ${Math.round(humanTimeMs / 1000)}s (+${increase}%)`);
  
  // Log le rapport de temps dans botLog si jobId fourni
  if (jobId) {
    botLog({
      applicationId: jobId,
      step: "execution_time",
      status: "ok",
      data: {
        type: "time_report",
        stepName: stepName,
        baseTimeMs: baseTimeMs,
        humanTimeMs: humanTimeMs,
        increasePercent: parseFloat(increase)
      }
    });
  }
}

/**
 * Log le début d'une session avec comportement humain.
 * Format lisible : durée en "Xs" ou "Xm Ys", heure locale ISO.
 */
export function logHumanBehaviorStart(jobId: string, context: string = ""): void {
  botLog({
    applicationId: jobId,
    step: "session_start",
    status: "ok",
    data: {
      portal: context,
      startedAt: new Date().toISOString(),
    }
  });
  console.log(`[human] 🧠 Début session comportement humain pour ${context}`);
}

/**
 * Log la fin d'une session avec comportement humain.
 * Format lisible : durée en "Xs" ou "Xm Ys", heure locale ISO.
 */
export function logHumanBehaviorEnd(jobId: string, context: string = "", durationMs?: number): void {
  // Formater la durée de façon lisible
  let durationStr = "";
  if (durationMs !== undefined) {
    if (durationMs < 60_000) {
      durationStr = `${(durationMs / 1000).toFixed(1)}s`;
    } else {
      const mins = Math.floor(durationMs / 60_000);
      const secs = Math.round((durationMs % 60_000) / 1000);
      durationStr = `${mins}m ${secs}s`;
    }
  }

  botLog({
    applicationId: jobId,
    step: "session_end",
    status: "ok",
    data: {
      portal: context,
      duration: durationStr || undefined,
      endedAt: new Date().toISOString(),
    }
  });
  console.log(`[human] ✅ Fin session comportement humain pour ${context}${durationStr ? ` (${durationStr})` : ""}`);
}