/**
 * france-config.test.ts — Tests unitaires de configuration France
 * (feature france-visa-hunter, task 1.3).
 *
 * Couverture :
 *   - `FRANCE_ALLOWED_MOTIFS` contient exactement les 7 motifs attendus,
 *     sans doublon et dans l'ordre canonique (Requirement 10.6).
 *   - `loadFranceEnv` lit les secrets depuis `process.env` uniquement et lève
 *     une erreur explicite préfixée `[franceHunter]` nommant la variable
 *     manquante — aucune valeur en dur (Requirements 12.1, 10.6).
 *
 * Aucun secret réel n'est utilisé : les tests injectent des valeurs factices
 * dans un `process.env` sauvegardé/restauré autour de chaque cas.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FRANCE_ALLOWED_MOTIFS,
  FRANCE_MOTIF_KEY,
  loadFranceEnv,
} from "../france/france-config.js";
import type { FranceMotif } from "../france/france-types.js";

// ─── Motifs attendus (miroir du contrat design, Requirement 10.6) ────────────

const EXPECTED_MOTIFS: readonly FranceMotif[] = [
  "Regroupement familial",
  "Visa retour",
  "Reunification familial",
  "Stagiaire associé",
  "Conjoint de Français - Installation",
  "Etudiant",
  "Autres",
];

// ─── FRANCE_ALLOWED_MOTIFS ────────────────────────────────────────────────────

describe("FRANCE_ALLOWED_MOTIFS", () => {
  it("contient exactement 7 motifs", () => {
    expect(FRANCE_ALLOWED_MOTIFS).toHaveLength(7);
  });

  it("correspond exactement à la liste canonique (ordre inclus)", () => {
    expect(FRANCE_ALLOWED_MOTIFS).toEqual(EXPECTED_MOTIFS);
  });

  it("ne contient aucun doublon", () => {
    const unique = new Set<string>(FRANCE_ALLOWED_MOTIFS);
    expect(unique.size).toBe(FRANCE_ALLOWED_MOTIFS.length);
  });

  it("ne contient que des chaînes non vides", () => {
    for (const motif of FRANCE_ALLOWED_MOTIFS) {
      expect(typeof motif).toBe("string");
      expect(motif.trim().length).toBeGreaterThan(0);
    }
  });

  it("expose une clé de custom field Motif stable", () => {
    expect(FRANCE_MOTIF_KEY).toBe("54cfd964c63f3386");
  });
});

// ─── loadFranceEnv ────────────────────────────────────────────────────────────
//
// loadFranceEnv lit CAPSOLVER_API_KEY et PROXY_URL depuis process.env.
// On sauvegarde/restaure ces clés autour de chaque test pour l'isolation.

describe("loadFranceEnv", () => {
  const ENV_KEYS = ["CAPSOLVER_API_KEY", "PROXY_URL"] as const;
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = saved[key];
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
  });

  it("charge la config quand toutes les clés sont présentes", () => {
    process.env.CAPSOLVER_API_KEY = "test-capsolver-key";
    process.env.PROXY_URL = "http://user:pass@proxy.example:8000";

    const cfg = loadFranceEnv();

    expect(cfg).toEqual({
      capsolverApiKey: "test-capsolver-key",
      proxyUrl: "http://user:pass@proxy.example:8000",
    });
  });

  it("nettoie les espaces autour des valeurs", () => {
    process.env.CAPSOLVER_API_KEY = "  key-with-spaces  ";
    process.env.PROXY_URL = "\thttp://proxy.example:8000\n";

    const cfg = loadFranceEnv();

    expect(cfg.capsolverApiKey).toBe("key-with-spaces");
    expect(cfg.proxyUrl).toBe("http://proxy.example:8000");
  });

  it("lève une erreur explicite si CAPSOLVER_API_KEY manque", () => {
    process.env.PROXY_URL = "http://proxy.example:8000";
    // CAPSOLVER_API_KEY absente (supprimée dans beforeEach)

    expect(() => loadFranceEnv()).toThrowError(/CAPSOLVER_API_KEY/);
    expect(() => loadFranceEnv()).toThrowError(/\[franceHunter\]/);
  });

  it("lève une erreur explicite si PROXY_URL manque", () => {
    process.env.CAPSOLVER_API_KEY = "test-capsolver-key";
    // PROXY_URL absente

    expect(() => loadFranceEnv()).toThrowError(/PROXY_URL/);
    expect(() => loadFranceEnv()).toThrowError(/\[franceHunter\]/);
  });

  it("traite une valeur vide comme manquante", () => {
    process.env.CAPSOLVER_API_KEY = "";
    process.env.PROXY_URL = "http://proxy.example:8000";

    expect(() => loadFranceEnv()).toThrowError(/CAPSOLVER_API_KEY/);
  });

  it("traite une valeur composée uniquement d'espaces comme manquante", () => {
    process.env.CAPSOLVER_API_KEY = "test-capsolver-key";
    process.env.PROXY_URL = "   ";

    expect(() => loadFranceEnv()).toThrowError(/PROXY_URL/);
  });

  it("lève une erreur quand aucune clé n'est définie", () => {
    // Les deux clés sont absentes (supprimées dans beforeEach).
    expect(() => loadFranceEnv()).toThrow(Error);
  });
});
