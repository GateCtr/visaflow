/**
 * cev-slot-assignment.test.ts — Tests de l'allocation entrelacée des créneaux CEV.
 *
 * Objectif : prouver que l'entrelacement par pas de N (anti-collision interne) satisfait :
 *   (1) zéro recouvrement des PREMIERS choix entre comptes quand #créneaux ≥ #comptes ;
 *   (2) chaque compte reçoit une PERMUTATION COMPLÈTE des créneaux éligibles (aucun perdu) ;
 *   (3) le filtre maxDate (deadline) écarte les créneaux hors fenêtre ;
 *   (4) fallback correct quand #comptes > #créneaux (wrap-around sans crash).
 */

import { describe, expect, it } from "vitest";

import { buildCevSlotAssignment, type CevSlotCandidate } from "../cev-slot-assignment.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clé stable d'un créneau pour comparer les listes (date+heure). */
function slotKey(s: CevSlotCandidate): string {
  return `${s.date}|${s.time}`;
}

/** Génère N créneaux free:1 sur des dates distinctes croissantes. */
function makeSlots(n: number): CevSlotCandidate[] {
  const slots: CevSlotCandidate[] = [];
  for (let i = 0; i < n; i++) {
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(i / 28)).padStart(2, "0");
    slots.push({ date: `2026-${month}-${day}`, time: `0${(i % 9) + 1}:00`, free: 1 });
  }
  return slots;
}

// ─── (1) Zéro recouvrement des premiers choix ────────────────────────────────

describe("buildCevSlotAssignment — premiers choix distincts (#créneaux ≥ #comptes)", () => {
  it("18 créneaux, 10 comptes : les premiers choix ne se recouvrent jamais", () => {
    const eligible = makeSlots(18);
    const totalAccounts = 10;

    const firstChoices = new Set<string>();
    for (let i = 0; i < totalAccounts; i++) {
      const list = buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i);
      expect(list.length).toBeGreaterThan(0);
      firstChoices.add(slotKey(list[0]!));
    }
    // 10 premiers choix tous distincts → aucune collision interne au 1er essai.
    expect(firstChoices.size).toBe(totalAccounts);
  });

  it("k-ièmes choix divergent au maximum tant que l'offre dure", () => {
    const eligible = makeSlots(12);
    const totalAccounts = 4; // 12 / 4 = 3 niveaux pleins

    const lists = Array.from({ length: totalAccounts }, (_, i) =>
      buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i),
    );

    // Pour les 3 premiers rangs de choix (k=0,1,2), les comptes visent tous des créneaux distincts.
    for (let k = 0; k < 3; k++) {
      const atK = new Set(lists.map(l => slotKey(l[k]!)));
      expect(atK.size).toBe(totalAccounts);
    }
  });

  it("cas limite #créneaux == #comptes : premiers choix tous distincts", () => {
    const eligible = makeSlots(5);
    const totalAccounts = 5;
    const firstChoices = new Set<string>();
    for (let i = 0; i < totalAccounts; i++) {
      const list = buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i);
      firstChoices.add(slotKey(list[0]!));
    }
    expect(firstChoices.size).toBe(totalAccounts);
  });
});

// ─── (2) Permutation complète (aucun créneau perdu) ──────────────────────────

describe("buildCevSlotAssignment — permutation complète des créneaux éligibles", () => {
  it("chaque compte reçoit tous les créneaux (fallback complet), sans doublon", () => {
    const eligible = makeSlots(18);
    const totalAccounts = 10;
    const expectedKeys = new Set(eligible.map(slotKey));

    for (let i = 0; i < totalAccounts; i++) {
      const list = buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i);
      // Même cardinalité → aucun doublon ni perte.
      expect(list.length).toBe(eligible.length);
      const keys = new Set(list.map(slotKey));
      expect(keys.size).toBe(eligible.length);
      expect(keys).toEqual(expectedKeys);
    }
  });
});

// ─── (3) Filtre maxDate (deadline) ───────────────────────────────────────────

describe("buildCevSlotAssignment — filtre maxDate (deadline)", () => {
  const eligible: CevSlotCandidate[] = [
    { date: "2026-11-13", time: "09:00", free: 1 },
    { date: "2026-11-16", time: "10:00", free: 1 },
    { date: "2026-12-01", time: "11:00", free: 1 },
    { date: "2027-01-05", time: "08:00", free: 1 },
  ];

  it("écarte les créneaux après la deadline", () => {
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 1, 0, "2026-11-30");
    const dates = list.map(s => s.date);
    expect(dates).toContain("2026-11-13");
    expect(dates).toContain("2026-11-16");
    expect(dates).not.toContain("2026-12-01");
    expect(dates).not.toContain("2027-01-05");
    expect(list.length).toBe(2);
  });

  it("tous les créneaux hors deadline → liste vide", () => {
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 1, 0, "2026-01-01");
    expect(list.length).toBe(0);
  });

  it("deadline incluse (égalité date) → le créneau du jour exact est conservé", () => {
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 1, 0, "2026-11-16");
    expect(list.map(s => s.date)).toContain("2026-11-16");
    expect(list.map(s => s.date)).not.toContain("2026-12-01");
  });

  it("deadline mal formée ignorée (aucun filtrage)", () => {
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 1, 0, "pas-une-date");
    expect(list.length).toBe(eligible.length);
  });
});

// ─── (4) Fallback #comptes > #créneaux ───────────────────────────────────────

describe("buildCevSlotAssignment — fallback quand #comptes > #créneaux", () => {
  it("5 comptes, 3 créneaux : wrap-around sans crash, permutation complète par compte", () => {
    const eligible = makeSlots(3);
    const totalAccounts = 5;
    const expectedKeys = new Set(eligible.map(slotKey));

    for (let i = 0; i < totalAccounts; i++) {
      const list = buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i);
      // Chaque compte reçoit quand même les 3 créneaux (fallback complet).
      expect(list.length).toBe(3);
      expect(new Set(list.map(slotKey))).toEqual(expectedKeys);
    }
  });

  it("les 3 premiers comptes ont un créneau dédié distinct ; les rangs ≥ 3 wrappent", () => {
    const eligible = makeSlots(3);
    const totalAccounts = 5;

    const firsts = Array.from({ length: totalAccounts }, (_, i) =>
      slotKey(buildCevSlotAssignment(`acc-${i}`, eligible, 1, totalAccounts, i)[0]!),
    );
    // Rangs 0,1,2 → créneaux distincts (dédiés). Rangs 3,4 réutilisent (step=5 > len=3
    // → boucle dédiée vide, premier élément = début du complément sorted[0]).
    expect(new Set(firsts.slice(0, 3)).size).toBe(3);
  });

  it("liste éligible vide → liste vide", () => {
    expect(buildCevSlotAssignment("acc-0", [], 1, 3, 0)).toEqual([]);
  });

  it("un seul créneau, un seul compte → une seule entrée", () => {
    const eligible = makeSlots(1);
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 1, 0);
    expect(list.length).toBe(1);
    expect(slotKey(list[0]!)).toBe(slotKey(eligible[0]!));
  });
});

// ─── Tri d'attractivité conservé avant entrelacement ─────────────────────────

describe("buildCevSlotAssignment — tri d'attractivité conservé", () => {
  it("compte 0 vise bien le créneau le plus attractif (date la plus proche)", () => {
    const eligible: CevSlotCandidate[] = [
      { date: "2026-12-20", time: "09:00", free: 1 },
      { date: "2026-11-05", time: "09:00", free: 1 },
      { date: "2026-11-30", time: "09:00", free: 1 },
    ];
    const list = buildCevSlotAssignment("acc-0", eligible, 1, 3, 0);
    // Après tri, le 1er est la date la plus proche ; compte 0 (start=0) le vise en premier.
    expect(list[0]!.date).toBe("2026-11-05");
  });
});
