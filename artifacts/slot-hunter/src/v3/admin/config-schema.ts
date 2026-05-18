/**
 * Config Schema V3 — Validation et transformation du hunterConfig admin.
 *
 * RESPONSABILITÉ :
 *   - Valider les champs V3 du hunterConfig (accountRole, rushWindows, etc.)
 *   - Extraire un LoginBudgetConfig depuis le hunterConfig d'un compte
 *   - Déterminer automatiquement le rôle (éclaireur/confiné) depuis currentAppointmentDate
 *   - Parser les rush windows depuis bot-config Convex (JSON string → RushWindow[])
 *
 * USAGE :
 *   const budget = extractBudgetFromConfig(job.hunterConfig);
 *   const role = resolveAccountRole(job.hunterConfig);
 *   const windows = parseRushWindowsFromBotConfig(configValue);
 */

import type {
  HunterConfigV3,
  AccountRole,
  LoginBudgetConfig,
  RushWindow,
} from "../core/types.js";

// ─── Constantes ─────────────────────────────────────────────────────────────

/** Seuil en mois pour déterminer éclaireur vs confiné automatiquement.
 *  Si le RDV est dans < 6 mois → éclaireur (calendrier ouvert).
 *  Si le RDV est dans > 6 mois → confiné (calendrier verrouillé). */
const ECLAIREUR_THRESHOLD_MONTHS = 6;

/** Budget par défaut si rien n'est configuré dans le hunterConfig. */
const DEFAULT_BUDGET: LoginBudgetConfig = {
  maxPerDay: 9,
  allocation: { rush: 4, standard: 3, emergency: 2 },
};

// ─── API publique ───────────────────────────────────────────────────────────

/**
 * Extrait un LoginBudgetConfig depuis le hunterConfig d'un dossier.
 * Respecte l'override admin (maxLoginsPerDay) ou utilise le défaut.
 */
export function extractBudgetFromConfig(config: Partial<HunterConfigV3>): LoginBudgetConfig {
  const maxPerDay = config.maxLoginsPerDay ?? DEFAULT_BUDGET.maxPerDay;

  // Si l'admin a défini un maxLoginsPerDay custom, recalculer l'allocation proportionnellement
  if (maxPerDay !== DEFAULT_BUDGET.maxPerDay) {
    // Proportions: rush=44%, standard=33%, emergency=22%
    const rush = Math.max(1, Math.round(maxPerDay * 0.44));
    const emergency = Math.max(1, Math.round(maxPerDay * 0.22));
    const standard = Math.max(1, maxPerDay - rush - emergency);

    return { maxPerDay, allocation: { rush, standard, emergency } };
  }

  return { ...DEFAULT_BUDGET };
}

/**
 * Détermine le rôle du compte (éclaireur/confiné/hybride).
 *
 * Ordre de priorité :
 *   1. accountRole explicite dans le config → utilisé tel quel
 *   2. currentAppointmentDate → calcul automatique (< 6 mois = éclaireur)
 *   3. Fallback → "hybride" (scanne pour lui-même)
 */
export function resolveAccountRole(config: Partial<HunterConfigV3>): AccountRole {
  // 1. Rôle explicite
  if (config.accountRole) {
    return config.accountRole;
  }

  // 2. Calcul depuis la date de RDV actuel
  if (config.currentAppointmentDate) {
    const apptDate = new Date(config.currentAppointmentDate);
    const now = new Date();
    const monthsDiff = (apptDate.getFullYear() - now.getFullYear()) * 12
      + (apptDate.getMonth() - now.getMonth());

    if (monthsDiff <= ECLAIREUR_THRESHOLD_MONTHS) {
      return "eclaireur";
    }
    return "confine";
  }

  // 3. Fallback
  return "hybride";
}

/**
 * Parse les rush windows depuis une string JSON (bot-config Convex).
 * Format attendu : '[{"start":7,"end":9.5,"days":[1,2,3,4,5]},{"start":12,"end":14}]'
 *
 * Retourne null si le parsing échoue (l'appelant conserve les windows par défaut).
 */
export function parseRushWindowsFromBotConfig(value: string | null): RushWindow[] | null {
  if (!value || !value.trim()) return null;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;

    const windows: RushWindow[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      const start = typeof obj.start === "number" ? obj.start : NaN;
      const end = typeof obj.end === "number" ? obj.end : NaN;
      if (isNaN(start) || isNaN(end) || start >= end || start < 0 || end > 24) continue;

      const days = Array.isArray(obj.days)
        ? (obj.days as unknown[]).filter((d): d is number => typeof d === "number" && d >= 1 && d <= 7)
        : undefined;

      windows.push({ start, end, days: days && days.length > 0 ? days : undefined });
    }

    return windows.length > 0 ? windows : null;
  } catch {
    return null;
  }
}

/**
 * Vérifie si un pattern de date prioritaire match une date donnée.
 * Patterns supportés :
 *   - "2026-09-*"    → tout septembre 2026
 *   - "2026-09-15"   → date exacte
 *   - "*-*-15"       → le 15 de chaque mois (future use)
 */
export function matchesPriorityDate(date: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;

  for (const pattern of patterns) {
    const parts = pattern.split("-");
    const dateParts = date.split("-");

    if (parts.length !== 3 || dateParts.length !== 3) continue;

    let match = true;
    for (let i = 0; i < 3; i++) {
      if (parts[i] === "*") continue; // Wildcard
      if (parts[i] !== dateParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }

  return false;
}

/**
 * Valide un hunterConfig V3 et retourne les erreurs.
 * Non-bloquant — les erreurs sont des warnings (le bot continue avec les défauts).
 */
export function validateConfigV3(config: Partial<HunterConfigV3>): string[] {
  const warnings: string[] = [];

  if (config.maxLoginsPerDay !== undefined) {
    if (config.maxLoginsPerDay < 1 || config.maxLoginsPerDay > 10) {
      warnings.push(`maxLoginsPerDay=${config.maxLoginsPerDay} hors plage [1-10] — utilisé défaut 9`);
    }
  }

  if (config.accountRole && !["eclaireur", "confine", "hybride"].includes(config.accountRole)) {
    warnings.push(`accountRole="${config.accountRole}" invalide — utilisé "hybride"`);
  }

  if (config.maxMonthsToScan !== undefined) {
    if (config.maxMonthsToScan < 1 || config.maxMonthsToScan > 12) {
      warnings.push(`maxMonthsToScan=${config.maxMonthsToScan} hors plage [1-12] — utilisé défaut 3`);
    }
  }

  if (config.currentAppointmentDate) {
    const d = new Date(config.currentAppointmentDate);
    if (isNaN(d.getTime())) {
      warnings.push(`currentAppointmentDate="${config.currentAppointmentDate}" invalide — ignoré`);
    }
  }

  if (config.slotPriorityDates) {
    const invalid = config.slotPriorityDates.filter(p => {
      const parts = p.split("-");
      return parts.length !== 3;
    });
    if (invalid.length > 0) {
      warnings.push(`slotPriorityDates invalides: ${invalid.join(", ")}`);
    }
  }

  return warnings;
}
