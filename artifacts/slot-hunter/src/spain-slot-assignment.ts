/**
 * spain-slot-assignment.ts — Distribution déterministe des créneaux (P4 v2)
 *
 * PRINCIPE :
 *   Chaque dossier a un index fixe (0, 1, 2, ... N-1) attribué par l'orchestrateur
 *   au moment du spawn (tri alphabétique des IDs Convex = ordre stable).
 *
 *   L'assignement est DÉTERMINISTE : dossier[i] reçoit le slot[i] comme premier choix.
 *   Pas de hash, pas de hasard — zéro collision entre nos propres dossiers au premier
 *   choix tant que le nombre de slots ≥ nombre de dossiers.
 *
 * STRATÉGIE DE TRI DES SLOTS (avant assignement) :
 *   1. Slots avec free ≥ 2 d'abord (sûrs — peuvent accueillir plusieurs dossiers)
 *   2. À free égal, heures tardives d'abord (les humains prennent 08:30 en premier)
 *   3. Le tableau trié est ensuite "découpé" : dossier[i] commence à position[i]
 *
 * FALLBACK :
 *   Si plus de dossiers que de slots → les derniers dossiers commencent au début
 *   du tableau (wrap-around). En publication/race, Bookitit les départage ; hors race,
 *   le claim Redis historique reste actif.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlotCandidate {
  date: string;
  time: string;
  agendaId: string;
  freeslots: number;
}

// ─── Algorithme principal ─────────────────────────────────────────────────────

/**
 * Construit la liste ordonnée de créneaux à tenter pour un dossier donné.
 *
 * @param dossierId       ID unique du dossier
 * @param eligible        Tous les créneaux éligibles trouvés par le scan
 * @param groupSize       Nombre de personnes dans le dossier (1 par défaut)
 * @param totalDossiers   Nombre total de dossiers actifs sur ce portail
 * @param dossierIndex    Index fixe de ce dossier (0-based, attribué par l'orchestrateur)
 * @returns               Liste ordonnée de SlotCandidate à tenter séquentiellement
 */
export function buildSlotAssignment(
  dossierId: string,
  eligible: SlotCandidate[],
  groupSize: number = 1,
  totalDossiers: number = 1,
  dossierIndex?: number,
): SlotCandidate[] {
  if (eligible.length === 0) return [];

  // Si pas d'index fourni, fallback sur hash (compatibilité)
  const myIndex = dossierIndex ?? hashFallback(dossierId, totalDossiers);

  // ── Trier les slots par attractivité ───────────────────────────────────────
  // Priorité : date la plus proche d'abord (une annulation est plus précieuse),
  // puis free ≥ groupSize, puis heure (premières heures en premier pour les dates proches)
  const sorted = [...eligible].sort((a, b) => {
    // 1. Dates les plus proches en premier (priorité absolue)
    if (a.date !== b.date) return a.date.localeCompare(b.date);

    // 2. Slots qui peuvent accueillir notre groupSize en premier
    const aFits = a.freeslots >= groupSize ? 1 : 0;
    const bFits = b.freeslots >= groupSize ? 1 : 0;
    if (bFits !== aFits) return bFits - aFits;

    // 3. Plus de places libres = plus sûr (moins de risque "seleccionada")
    if (b.freeslots !== a.freeslots) return b.freeslots - a.freeslots;

    // 4. Heures les plus tôt d'abord (pour les dates proches, on veut le matin)
    return a.time.localeCompare(b.time);
  });

  // ── Assignement déterministe ───────────────────────────────────────────────
  // Dossier[i] commence à sorted[i % sorted.length]
  // Puis continue cycliquement : sorted[(i+1) % N], sorted[(i+2) % N], ...
  const startPos = myIndex % sorted.length;
  const result: SlotCandidate[] = [
    ...sorted.slice(startPos),
    ...sorted.slice(0, startPos),
  ];

  return result;
}

// ─── Fallback hash (si dossierIndex non fourni) ──────────────────────────────

function hashFallback(dossierId: string, totalDossiers: number): number {
  let h = 2166136261;
  for (let i = 0; i < dossierId.length; i++) {
    h ^= dossierId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % Math.max(1, totalDossiers);
}
