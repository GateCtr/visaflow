/**
 * cev-slot-assignment.ts — Distribution déterministe des créneaux CEV par index de compte.
 *
 * Porté de spain-slot-assignment.ts, adapté à CEV.
 *
 * PRINCIPE :
 *   Chaque compte CEV a un index fixe (0, 1, 2, … N-1) attribué par le dossier-loop
 *   au moment de la découverte (tri stable des identifiants d'application).
 *
 *   L'assignement est DÉTERMINISTE : compte[i] reçoit le créneau[i] comme premier choix.
 *   Pas de hasard — zéro collision entre nos propres comptes au premier essai tant que
 *   le nombre de créneaux ≥ nombre de comptes.
 *
 * CAS CEV TYPIQUE (publication 2026-09-02) :
 *   « 33 places » = 33 jours distincts × 1 place. Avec N comptes (N ≤ 33), chaque
 *   compte vise un JOUR distinct dès le premier essai → pas de bataille sur le 1er jour.
 *
 * TRI DES CRÉNEAUX (avant décalage) :
 *   1. Date la plus proche d'abord (une annulation proche est plus précieuse).
 *   2. À date égale, créneaux pouvant accueillir le groupe (free ≥ groupSize) d'abord.
 *   3. Puis plus de places libres (moins de risque de collision).
 *   4. Puis heure la plus tôt.
 *
 * FALLBACK :
 *   Plus de comptes que de créneaux → wrap-around cyclique ; le claim Redis
 *   (tryClaimCevSlot) départage les recoupements en ~1 ms, sans attente.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CevSlotCandidate {
  date: string;
  time: string;
  /** Places libres pour ce créneau (souvent 1 sur CEV). */
  free: number;
}

// ─── Algorithme principal ─────────────────────────────────────────────────────

/**
 * Construit la liste ordonnée de créneaux à tenter pour un compte donné.
 *
 * @param accountId     Identifiant unique du compte (application CEV)
 * @param eligible      Tous les créneaux détectés (inline SelectSlot)
 * @param groupSize     Nombre de personnes du dossier (1 par défaut)
 * @param totalAccounts Nombre total de comptes CEV actifs
 * @param accountIndex  Index fixe de ce compte (0-based) ; fallback hash si absent
 * @param maxDate       Date limite MAX "YYYY-MM-DD" (incluse). Les créneaux APRÈS cette
 *                      date sont écartés. Si tout est écarté → liste vide → aucun booking.
 *                      Résolution attendue côté appelant : deadline par AppId > globale > aucune.
 * @returns             Liste ordonnée de créneaux à tenter séquentiellement (cascade)
 */
export function buildCevSlotAssignment(
  accountId: string,
  eligible: CevSlotCandidate[],
  groupSize: number = 1,
  totalAccounts: number = 1,
  accountIndex?: number,
  maxDate?: string,
): CevSlotCandidate[] {
  if (eligible.length === 0) return [];

  // ── Filtre date limite MAX (par AppId ou globale, résolue par l'appelant) ───
  // Comparaison lexicographique sûre sur des dates ISO "YYYY-MM-DD".
  // Si aucun créneau ne reste dans la fenêtre → liste vide → le dossier ne booke rien.
  const withinDeadline = (maxDate && /^\d{4}-\d{2}-\d{2}$/.test(maxDate))
    ? eligible.filter(s => s.date <= maxDate)
    : eligible;
  if (withinDeadline.length === 0) return [];

  // Index effectif : fourni par le dossier-loop, sinon hash déterministe (compat).
  const myIndex = accountIndex ?? hashFallback(accountId, totalAccounts);

  // ── Tri par attractivité ──────────────────────────────────────────────────
  const sorted = [...withinDeadline].sort((a, b) => {
    // 1. Date la plus proche d'abord (priorité absolue)
    if (a.date !== b.date) return a.date.localeCompare(b.date);

    // 2. Créneaux qui peuvent accueillir notre groupSize d'abord
    const aFits = a.free >= groupSize ? 1 : 0;
    const bFits = b.free >= groupSize ? 1 : 0;
    if (bFits !== aFits) return bFits - aFits;

    // 3. Plus de places libres = plus sûr
    if (b.free !== a.free) return b.free - a.free;

    // 4. Heure la plus tôt d'abord
    return a.time.localeCompare(b.time);
  });

  // ── Décalage cyclique par index de compte ───────────────────────────────────
  // Compte[i] commence à sorted[i % N], puis continue cycliquement.
  const startPos = ((myIndex % sorted.length) + sorted.length) % sorted.length;
  return [...sorted.slice(startPos), ...sorted.slice(0, startPos)];
}

// ─── Date limite par AppId ────────────────────────────────────────────────────

/**
 * Parse le CSV `cevDossierDeadlines` en map { VOWINTREF (maj) → "YYYY-MM-DD" }.
 * Format : "VOWINT6085888=2026-10-15,VOWINT6085889=2026-11-30".
 * Les entrées mal formées (date non ISO) sont ignorées silencieusement.
 */
export function parseCevDossierDeadlines(raw: string | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || !raw.trim()) return map;
  for (const part of raw.split(",")) {
    const [refRaw, dateRaw] = part.split("=");
    const ref = refRaw?.trim().toUpperCase();
    const date = dateRaw?.trim();
    if (ref && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      map.set(ref, date);
    }
  }
  return map;
}

/**
 * Résout la date limite MAX applicable à un dossier :
 *   1. deadline par AppId (cevDossierDeadlines) si présente,
 *   2. sinon deadline globale (slotDateDeadline),
 *   3. sinon undefined (aucune limite).
 *
 * @param vowintRef       Référence VOWINT du dossier (ex: "VOWINT6085888")
 * @param perDossier      Map issue de parseCevDossierDeadlines
 * @param globalDeadline  Date limite globale "YYYY-MM-DD" (slotDateDeadline) ou undefined
 */
export function resolveCevDeadline(
  vowintRef: string,
  perDossier: Map<string, string>,
  globalDeadline?: string,
): string | undefined {
  const perApp = perDossier.get(vowintRef.trim().toUpperCase());
  if (perApp) return perApp;
  if (globalDeadline && /^\d{4}-\d{2}-\d{2}$/.test(globalDeadline)) return globalDeadline;
  return undefined;
}

// ─── Fallback hash (si accountIndex non fourni) ──────────────────────────────

function hashFallback(accountId: string, totalAccounts: number): number {
  let h = 2166136261;
  for (let i = 0; i < accountId.length; i++) {
    h ^= accountId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % Math.max(1, totalAccounts);
}
