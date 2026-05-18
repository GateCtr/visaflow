/**
 * Stealth Alternation V3 — Alternance d'endpoints pour masquer le pattern scan.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Décider quel endpoint appeler à chaque itération du refresh continu.
 *   Le portail ne doit pas voir 100% getFirstAvailableMonth en boucle.
 *
 * CONCEPT :
 *   Un humain qui cherche un créneau ne fait pas que F5 sur une page.
 *   Il navigue : dashboard → calendrier → retour dashboard → calendrier.
 *   On simule ce pattern en alternant :
 *     - 2/3 → getFirstAvailableMonth (le vrai check)
 *     - 1/3 → getLandingPageDetails (navigation dashboard, léger)
 *
 * ANTI-DÉTECTION :
 *   - Le ratio n'est PAS fixe (33%±10% par fenêtre)
 *   - Jamais plus de 4 getFirstAvailableMonth consécutifs
 *   - Jamais plus de 2 getLandingPage consécutifs
 *   - Pattern reset à chaque nouvelle fenêtre de scan
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScanEndpoint = "firstAvailableMonth" | "landingPage";

// ─── État ───────────────────────────────────────────────────────────────────

interface AlternationState {
  /** Compteur de getFirstAvailableMonth consécutifs. */
  consecutiveMain: number;
  /** Compteur de getLandingPage consécutifs. */
  consecutiveLanding: number;
  /** Total de chaque type dans la fenêtre courante. */
  mainCount: number;
  landingCount: number;
}

const states = new Map<string, AlternationState>();

function getState(username: string): AlternationState {
  const key = username.toLowerCase();
  if (!states.has(key)) {
    states.set(key, { consecutiveMain: 0, consecutiveLanding: 0, mainCount: 0, landingCount: 0 });
  }
  return states.get(key)!;
}

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Décide quel endpoint appeler pour la prochaine itération.
 * Respecte le ratio ~2/3 main + 1/3 landing avec contraintes de consécutivité.
 */
export function pickNextEndpoint(username: string): ScanEndpoint {
  const state = getState(username);

  // Contrainte : max 4 main consécutifs → forcer landing
  if (state.consecutiveMain >= 4) {
    state.consecutiveMain = 0;
    state.consecutiveLanding++;
    state.landingCount++;
    return "landingPage";
  }

  // Contrainte : max 2 landing consécutifs → forcer main
  if (state.consecutiveLanding >= 2) {
    state.consecutiveLanding = 0;
    state.consecutiveMain++;
    state.mainCount++;
    return "firstAvailableMonth";
  }

  // Ratio variable : ~33% landing (±10%)
  const targetLandingRatio = 0.33 + (Math.random() - 0.5) * 0.1;
  const total = state.mainCount + state.landingCount;
  const currentLandingRatio = total > 0 ? state.landingCount / total : 0;

  if (currentLandingRatio < targetLandingRatio) {
    // Besoin de plus de landing pour atteindre le ratio
    state.consecutiveLanding++;
    state.consecutiveMain = 0;
    state.landingCount++;
    return "landingPage";
  }

  // Par défaut : main (le vrai check)
  state.consecutiveMain++;
  state.consecutiveLanding = 0;
  state.mainCount++;
  return "firstAvailableMonth";
}

/**
 * Reset l'état d'alternance (à chaque nouvelle fenêtre de scan).
 */
export function resetAlternation(username: string): void {
  states.delete(username.toLowerCase());
}

/**
 * Retourne les stats de l'alternance (pour les logs).
 */
export function getAlternationStats(username: string): { mainCount: number; landingCount: number; ratio: string } {
  const state = getState(username);
  const total = state.mainCount + state.landingCount;
  const ratio = total > 0 ? `${Math.round((state.landingCount / total) * 100)}%` : "0%";
  return { mainCount: state.mainCount, landingCount: state.landingCount, ratio };
}
