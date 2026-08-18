/**
 * spain-slot-assignment.ts — Algorithme de distribution intelligente à 3 niveaux (P4)
 *
 * OBJECTIF :
 *   Répartir les dossiers parallèles sur des créneaux DIFFÉRENTS pour maximiser
 *   le nombre de bookings lors d'une publication simultanée de créneaux.
 *
 * STRATÉGIE :
 *   Le tri des candidats est personnalisé par dossier (via dossierId hashé en index).
 *   Chaque dossier commence à un point différent du tableau → pas de collision.
 *   Le fallback cascade (P1) assure que si un créneau est pris, on descend au suivant.
 *
 * NIVEAUX DE DISTRIBUTION :
 *   1. Dates avec free ≥ 2 en priorité (sûres — moins de risque "seleccionada")
 *   2. Si toutes free = 1 → distribuer sur des dates différentes, heures éloignées
 *   3. Si une seule date → heures différentes, éloignées d'abord (les humains prennent 08:30)
 *
 * BOOKING GROUPE (groupSize > 1) :
 *   Priorité aux créneaux free ≥ groupSize ou aux paires adjacentes sur la même date.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlotCandidate {
  date: string;
  time: string;
  agendaId: string;
  freeslots: number;
}

// ─── Hash stable pour distribuer les dossiers ─────────────────────────────────

/**
 * Produit un index numérique stable à partir d'un dossierId (simple FNV-1a 32 bits).
 * Utilisé pour le round-robin : chaque dossier commence à un offset différent.
 */
function hashDossierId(dossierId: string): number {
  let h = 2166136261;
  for (let i = 0; i < dossierId.length; i++) {
    h ^= dossierId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0; // unsigned 32-bit
}

// ─── Algorithme principal ─────────────────────────────────────────────────────

/**
 * Construit la liste ordonnée de créneaux à tenter pour un dossier donné.
 *
 * L'ordre est optimisé pour :
 * 1. Minimiser les collisions entre nos propres dossiers (round-robin par hash)
 * 2. Éviter les créneaux que les humains prennent en premier (08:30, 09:00)
 * 3. Préférer les créneaux avec le plus de places (free ≥ 2 = sûrs)
 *
 * @param dossierId     ID unique du dossier (pour le hash de distribution)
 * @param eligible      Tous les créneaux éligibles trouvés par le scan (déjà filtrés par date window)
 * @param groupSize     Nombre de personnes dans le dossier (1 par défaut)
 * @param totalDossiers Nombre total de dossiers actifs sur ce portail (pour la distribution)
 * @returns             Liste ordonnée de SlotCandidate à tenter séquentiellement
 */
export function buildSlotAssignment(
  dossierId: string,
  eligible: SlotCandidate[],
  groupSize: number = 1,
  totalDossiers: number = 1,
): SlotCandidate[] {
  if (eligible.length === 0) return [];

  const dossierIndex = hashDossierId(dossierId) % Math.max(1, totalDossiers);

  // ── Analyser la structure des créneaux ─────────────────────────────────────
  const dateMap = new Map<string, SlotCandidate[]>();
  for (const s of eligible) {
    const arr = dateMap.get(s.date) ?? [];
    arr.push(s);
    dateMap.set(s.date, arr);
  }
  const dates = [...dateMap.keys()].sort();

  // Identifier les dates "sûres" (au moins un créneau avec free ≥ 2)
  const safeDates = dates.filter((d) =>
    dateMap.get(d)!.some((s) => s.freeslots >= 2),
  );

  // ── Niveau 1 : dates avec free ≥ 2 ─────────────────────────────────────────
  if (safeDates.length > 0) {
    return buildLevel1Assignment(safeDates, dateMap, dossierIndex, totalDossiers, groupSize);
  }

  // ── Niveau 2 : toutes free = 1, plusieurs dates ────────────────────────────
  if (dates.length > 1) {
    return buildLevel2Assignment(dates, dateMap, dossierIndex, totalDossiers);
  }

  // ── Niveau 3 : une seule date, tous free = 1 ──────────────────────────────
  return buildLevel3Assignment(dates[0], dateMap.get(dates[0])!, dossierIndex, totalDossiers);
}

// ─── Niveau 1 : Dates sûres (free ≥ 2) en priorité ───────────────────────────

function buildLevel1Assignment(
  safeDates: string[],
  dateMap: Map<string, SlotCandidate[]>,
  dossierIndex: number,
  totalDossiers: number,
  groupSize: number,
): SlotCandidate[] {
  const result: SlotCandidate[] = [];

  // Distribuer ce dossier sur une date sûre en round-robin
  const myDateIndex = dossierIndex % safeDates.length;
  const orderedDates = [
    ...safeDates.slice(myDateIndex),
    ...safeDates.slice(0, myDateIndex),
  ];

  // Pour chaque date sûre, ordonner les créneaux : free ≥ groupSize d'abord, heures éloignées
  for (const date of orderedDates) {
    const slots = dateMap.get(date)!;
    const sorted = [...slots].sort((a, b) => {
      // Prioriser free ≥ groupSize (assure que le claim passera)
      const aOk = a.freeslots >= groupSize ? 1 : 0;
      const bOk = b.freeslots >= groupSize ? 1 : 0;
      if (bOk !== aOk) return bOk - aOk;
      // À capacité égale, heures éloignées d'abord (DESC — les humains prennent les premières)
      return b.time.localeCompare(a.time);
    });
    result.push(...sorted);
  }

  // Ajouter les dates non-sûres en fallback (même logique que Niveau 2)
  const allDates = [...dateMap.keys()].sort();
  const unsafeDates = allDates.filter((d) => !safeDates.includes(d));
  for (const date of unsafeDates) {
    const slots = dateMap.get(date)!;
    const sorted = [...slots].sort((a, b) => b.time.localeCompare(a.time));
    result.push(...sorted);
  }

  return result;
}

// ─── Niveau 2 : Plusieurs dates, toutes free = 1 ─────────────────────────────

function buildLevel2Assignment(
  dates: string[],
  dateMap: Map<string, SlotCandidate[]>,
  dossierIndex: number,
  totalDossiers: number,
): SlotCandidate[] {
  const result: SlotCandidate[] = [];

  // Round-robin : ce dossier commence à une date différente des autres
  const myDateIndex = dossierIndex % dates.length;
  const orderedDates = [
    ...dates.slice(myDateIndex),
    ...dates.slice(0, myDateIndex),
  ];

  // Pour chaque date : commencer par l'heure la plus tardive
  // Les humains ouvrent la page et cliquent 08:30 en premier → nos dossiers prennent les heures éloignées
  for (const date of orderedDates) {
    const slots = dateMap.get(date)!;
    const sorted = [...slots].sort((a, b) => b.time.localeCompare(a.time));
    // Offset supplémentaire dans les heures pour distribuer les dossiers sur la même date
    const timeOffset = Math.floor(dossierIndex / dates.length) % sorted.length;
    const rotated = [...sorted.slice(timeOffset), ...sorted.slice(0, timeOffset)];
    result.push(...rotated);
  }

  return result;
}

// ─── Niveau 3 : Une seule date, tous free = 1 ────────────────────────────────

function buildLevel3Assignment(
  date: string,
  slots: SlotCandidate[],
  dossierIndex: number,
  totalDossiers: number,
): SlotCandidate[] {
  // Trier par heure DESC (éloignées d'abord — les humains prennent les premières)
  const sorted = [...slots].sort((a, b) => b.time.localeCompare(a.time));

  // Chaque dossier commence à un offset différent dans le tableau
  const offset = dossierIndex % sorted.length;
  return [...sorted.slice(offset), ...sorted.slice(0, offset)];
}
