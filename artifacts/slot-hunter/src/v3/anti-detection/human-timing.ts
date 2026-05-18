/**
 * Human Timing V3 — Pauses gaussiennes et jitter réseau réalistes.
 *
 * RESPONSABILITÉ UNIQUE :
 *   Fournir des pauses qui imitent un humain réel (pas uniform random = signal bot).
 *   Distribution gaussienne centrée sur une valeur naturelle avec variabilité.
 *
 * ANTI-DÉTECTION :
 *   - Gaussian > Uniform (un humain a un rythme naturel centré)
 *   - Jitter réseau 30-200ms avant chaque requête (DNS + TCP + TLS + rendering)
 *   - Pauses inter-étapes variables selon l'action (navigation, lecture, réflexion)
 *   - Jamais 0ms entre deux requêtes (signal bot immédiat)
 *
 * USAGE :
 *   await humanPause("navigation");  // 1-3s gaussien
 *   await networkJitter();            // 30-200ms
 *   await interStepPause();           // 0.5-2s gaussien
 */

// ─── Distribution gaussienne (Box-Muller) ───────────────────────────────────

/** Génère un nombre gaussien entre min et max (centré au milieu). */
function gaussian(min: number, max: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const center = (min + max) / 2;
  const stddev = (max - min) * 0.25;
  return Math.max(min, Math.min(max, center + z * stddev));
}

// ─── Profils de pause ───────────────────────────────────────────────────────

/** Actions humaines avec leurs durées typiques. */
const PAUSE_PROFILES = {
  /** Navigation entre pages (clic flèche, onglet). */
  navigation: { min: 1000, max: 3000 },
  /** Lecture d'une page (scanning visuel). */
  reading: { min: 2000, max: 6000 },
  /** Réflexion (hésitation avant action). */
  thinking: { min: 1500, max: 4000 },
  /** Transition entre étapes du flow. */
  interStep: { min: 500, max: 2000 },
  /** Pause courte (micro-interaction). */
  micro: { min: 200, max: 800 },
  /** Pause longue (distraction, téléphone). */
  distraction: { min: 5000, max: 15000 },
} as const;

export type PauseType = keyof typeof PAUSE_PROFILES;

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Pause humaine gaussienne selon le type d'action.
 * Retourne la durée réelle de la pause (pour les logs).
 */
export async function humanPause(type: PauseType = "interStep"): Promise<number> {
  const profile = PAUSE_PROFILES[type];
  const ms = Math.round(gaussian(profile.min, profile.max));
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

/**
 * Jitter réseau réaliste (30-200ms).
 * Simule : DNS lookup + TCP connect + TLS handshake + rendering delay.
 * À appeler AVANT chaque requête réseau.
 */
export async function networkJitter(): Promise<number> {
  const ms = Math.round(30 + Math.random() * 170);
  await new Promise(r => setTimeout(r, ms));
  return ms;
}

/**
 * Pause entre deux étapes du scan (0.5-2s gaussien).
 * Plus naturelle qu'un délai fixe.
 */
export async function interStepPause(): Promise<number> {
  return humanPause("interStep");
}

/**
 * Pause de navigation entre mois du calendrier (1-3s).
 * Simule le clic sur la flèche ">" et l'attente du rendu.
 */
export async function monthNavigationPause(): Promise<number> {
  return humanPause("navigation");
}

/**
 * Pause de réflexion avant booking (1.5-4s).
 * Un humain hésite avant de cliquer "Confirmer".
 */
export async function preBookingPause(): Promise<number> {
  return humanPause("thinking");
}

/**
 * Décide si on doit simuler une distraction (5% du temps hors rush).
 * Un humain regarde parfois son téléphone entre deux actions.
 */
export async function maybeDistraction(isRush: boolean): Promise<number> {
  if (isRush) return 0; // Jamais en rush → capture maximale
  if (Math.random() > 0.05) return 0; // 5% de chance
  return humanPause("distraction");
}

/**
 * Génère un intervalle gaussien entre min et max (ms).
 * Utile quand on veut un intervalle custom sans profile prédéfini.
 */
export function gaussianInterval(min: number, max: number): number {
  return Math.round(gaussian(min, max));
}

/**
 * Sleep simple (non-gaussien, pour les cas où on veut exactement N ms).
 */
export async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}
