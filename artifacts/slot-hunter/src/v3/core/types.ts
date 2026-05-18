/**
 * V3 Core Types — Interfaces communes pour le Hunter Bot V3 "Chasseur".
 *
 * Convention : aucune logique ici, uniquement des types/interfaces.
 * Chaque module importe depuis ce fichier pour garantir la cohérence.
 */

// ─── Login Budget ───────────────────────────────────────────────────────────

/** Phase d'allocation d'un login (détermine dans quel "pot" il est décompté). */
export type LoginPhase = "rush" | "standard" | "emergency";

/** Configuration du budget login pour un compte. */
export interface LoginBudgetConfig {
  /** Max logins/jour (défaut: 9, limite portail: 10, marge: 1). */
  maxPerDay: number;
  /** Allocation par phase. La somme DOIT être ≤ maxPerDay. */
  allocation: {
    rush: number;       // Logins réservés aux rush hours (défaut: 4)
    standard: number;   // Logins pour couverture normale (défaut: 3)
    emergency: number;  // Réserve crash proxy / erreur (défaut: 2)
  };
}

/** État du budget login d'un compte à un instant T. */
export interface LoginBudgetState {
  /** Nombre total de logins utilisés aujourd'hui. */
  totalUsed: number;
  /** Détail par phase. */
  usedByPhase: Record<LoginPhase, number>;
  /** Timestamps de chaque login (pour le 24h glissant). */
  loginTimestamps: number[];
  /** Timestamp du dernier login réussi. */
  lastLoginAt: number;
  /** Nombre de morts proxy aujourd'hui (diagnostic). */
  proxyDeathCount: number;
}

// ─── Account State ──────────────────────────────────────────────────────────

/** Rôle du compte dans la stratégie multi-compte. */
export type AccountRole = "eclaireur" | "confine" | "hybride";

/** État complet d'un compte géré par le session pool. */
export interface AccountState {
  /** Email du compte (lowercase). */
  username: string;
  /** Rôle stratégique. */
  role: AccountRole;
  /** Budget login courant. */
  budget: LoginBudgetState;
  /** Le compte est-il actuellement restreint par le portail ? */
  restricted: boolean;
  /** Deadline de fin de restriction (ms epoch). null si pas restreint. */
  restrictedUntil: number | null;
  /** Le token est-il actuellement valide ? */
  hasValidToken: boolean;
  /** Timestamp d'expiration du token courant. null si pas de token. */
  tokenExpiresAt: number | null;
  /** Le compte est-il en cooldown post-expiry (8-25 min) ? */
  inCooldown: boolean;
  /** Timestamp de fin de cooldown. null si pas en cooldown. */
  cooldownEndsAt: number | null;
}

// ─── Session Pool Config ────────────────────────────────────────────────────

/** Configuration globale du session pool. */
export interface SessionPoolConfig {
  /** Budget par défaut pour les comptes (overridable par hunterConfig). */
  defaultBudget: LoginBudgetConfig;
  /** Heure UTC de reset du compteur (défaut: 0 = minuit UTC). */
  resetHourUtc: number;
  /** Minimum absolu entre deux logins du même compte (ms). Défaut: 10 min. */
  minInterLoginMs: number;
  /** Activer le mode nuit (1 login nocturne autorisé). */
  nightModeEnabled: boolean;
}

// ─── Rush Windows ───────────────────────────────────────────────────────────

/** Fenêtre rush configurable. */
export interface RushWindow {
  /** Heure de début (format décimal, ex: 7.5 = 07:30). Heure locale Kinshasa (WAT = UTC+1). */
  start: number;
  /** Heure de fin (format décimal). */
  end: number;
  /** Jours de la semaine (1=Lun, 7=Dim). Si absent → tous les jours. */
  days?: number[];
}

// ─── Login Decision ─────────────────────────────────────────────────────────

/** Résultat de la décision "peut-on login maintenant ?". */
export interface LoginDecision {
  /** Autorisé ou non. */
  allowed: boolean;
  /** Phase qui serait débitée. */
  phase: LoginPhase;
  /** Raison du refus (si allowed=false). */
  reason?: string;
  /** Temps d'attente recommandé avant retry (ms). 0 si allowed. */
  waitMs: number;
  /** Budget restant après ce login (si allowed). */
  remaining: number;
}

// ─── HunterConfig V3 (Admin) ────────────────────────────────────────────────

/** Config V3 étendue — champs ajoutés au hunterConfig existant de Convex. */
export interface HunterConfigV3 {
  // === Existants (conservés de V2) ===
  embassyUsername: string;
  embassyPassword: string;
  isActive: boolean;
  portalApplicationId?: string;
  slotDateFrom?: string;
  slotDateDeadline?: string;
  rescheduleMode?: boolean;
  rescheduleExistingDate?: string;
  useResidentialProxy?: boolean;
  twoCaptchaApiKey?: string;
  capsolverApiKey?: string;
  preferredProxy?: string;         // "iproyal" | "brightdata" | "2captcha"

  // === NOUVEAUX V3 ===

  /** Rôle du compte dans la stratégie multi-compte.
   *  - "eclaireur" : RDV proche → calendrier ouvert 12 mois → scanne pour tous
   *  - "confine"   : RDV lointain → calendrier vide → reçoit les slots via blind booking
   *  - "hybride"   : scanne pour lui-même ET peut recevoir des blind bookings */
  accountRole?: AccountRole;

  /** Date du RDV actuel sur le portail (YYYY-MM-DD).
   *  Sert à déterminer automatiquement éclaireur vs confiné.
   *  Ex: "2026-06-15" → éclaireur, "2027-05-01" → confiné. */
  currentAppointmentDate?: string;

  /** Override du budget login journalier (défaut: 9). */
  maxLoginsPerDay?: number;

  /** Fenêtres rush personnalisées pour ce compte (override global).
   *  Si absent → utilise les rush windows globales (bot-config Convex). */
  rushWindows?: RushWindow[];

  /** Activer le blind booking cross-account pour ce dossier.
   *  Si true et role="confine" → reçoit les slots détectés par les éclaireurs.
   *  Si true et role="eclaireur" → publie ses découvertes aux confinés. */
  blindBookingEnabled?: boolean;

  /** Dates préférées pour le booking (pattern matching).
   *  Ex: ["2026-09-*", "2026-10-01", "2026-10-02"]
   *  Si un slot match une de ces dates → priorité maximale au booking.
   *  Les dates hors de cette liste sont quand même bookées si dans la fenêtre admin. */
  slotPriorityDates?: string[];

  /** Nombre max de mois à scanner dans le calendrier (défaut: 3).
   *  Un humain navigue rarement plus de 3 mois en avant. */
  maxMonthsToScan?: number;

  /** Activer le mode nuit pour ce compte (1 login nocturne 02:00 UTC). */
  nightModeEnabled?: boolean;
}

// ─── Events (pour le logging/stats) ─────────────────────────────────────────

/** Événement émis quand un login est consommé. */
export interface LoginConsumedEvent {
  username: string;
  phase: LoginPhase;
  timestamp: number;
  totalUsedToday: number;
  remainingToday: number;
  proxyProvider?: string;
}

/** Événement émis quand un login est refusé. */
export interface LoginDeniedEvent {
  username: string;
  phase: LoginPhase;
  reason: string;
  timestamp: number;
  totalUsedToday: number;
  waitMs: number;
}
