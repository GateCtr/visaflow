/**
 * spain-service-mapping.ts — Mapping entre les types de visa Joventy et les services Bookitit
 *
 * ARCHITECTURE :
 *   Le portail Bookitit citaconsular.es affiche des "services" (types de RDV).
 *   Les noms de services sont en espagnol, mais les types de visa dans Convex sont en français.
 *   Ce module fait le matching à l'exécution via des patterns regex/keywords.
 *
 *   IMPORTANT : Les serviceId numériques changent potentiellement (dynamiques côté Bookitit).
 *   On matche par NOM de service, pas par ID.
 *
 * TYPES DE VISA JOVENTY (constants.ts) :
 *   - "Visa C — Tourisme / Affaires"
 *   - "Visa C — Études court séjour"
 *   - "Visa D — Long Séjour (études / regroupement familial)"
 *
 * SERVICES BOOKITIT ATTENDUS (noms espagnols typiques) :
 *   - "Visado de corta estancia" / "Visado C" / "Visa Schengen" → Court Séjour
 *   - "Visado Nacional" / "Visado de larga estancia" / "Visado D" → Long Séjour
 *   - "Recogida de pasaporte" → Retrait passeport (pas un visa)
 *   - "Información" → Renseignements (pas un visa)
 */

import type { ExtractedSlotInfo } from "./spain-http-booking.js";

// ─── Patterns de matching ────────────────────────────────────────────────────

interface ServicePattern {
  /** Catégorie de visa Joventy (préfixe du visaType) */
  visaCategory: "C" | "D";
  /** Patterns regex pour matcher le nom du service Bookitit (espagnol) */
  patterns: RegExp[];
}

const SERVICE_PATTERNS: ServicePattern[] = [
  {
    visaCategory: "C",
    patterns: [
      /corta\s*estancia/i,
      /visa(do)?\s*c\b/i,
      /schengen/i,
      /court\s*s[eé]jour/i,
      /short\s*stay/i,
      /turismo/i,
      /negocios/i,
    ],
  },
  {
    visaCategory: "D",
    patterns: [
      /larga\s*estancia/i,
      /visa(do)?\s*(nacional|d)\b/i,
      /long\s*s[eé]jour/i,
      /nacional/i,
      /long\s*stay/i,
      /estudios/i,
      /reagrupaci[oó]n/i,
      /residencia/i,
    ],
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrait la catégorie de visa (C ou D) depuis le visaType Joventy.
 * Ex: "Visa C — Tourisme / Affaires" → "C"
 *     "Visa D — Long Séjour (études / regroupement familial)" → "D"
 */
export function extractVisaCategory(visaType: string): "C" | "D" | null {
  const m = visaType.match(/visa\s*(c|d)\b/i);
  if (!m) return null;
  return m[1].toUpperCase() as "C" | "D";
}

/**
 * Trouve le service Bookitit correspondant au visaType du dossier.
 *
 * @param services - Services extraits du HTML (via extractServicesFromHtml)
 * @param visaType - Type de visa du dossier Joventy (ex: "Visa C — Tourisme / Affaires")
 * @returns Le service matché, ou null si aucun match
 */
export function matchServiceForVisa(
  services: ExtractedSlotInfo[],
  visaType: string,
): ExtractedSlotInfo | null {
  const category = extractVisaCategory(visaType);

  if (!category) {
    // Si on ne peut pas déterminer la catégorie, prendre le premier service
    console.warn(`[spain-mapping] ⚠️ Impossible de déterminer la catégorie de visa pour "${visaType}" — fallback premier service`);
    return services[0] ?? null;
  }

  // Trouver les patterns pour cette catégorie
  const patternDef = SERVICE_PATTERNS.find((p) => p.visaCategory === category);
  if (!patternDef) {
    console.warn(`[spain-mapping] ⚠️ Pas de patterns pour catégorie ${category}`);
    return services[0] ?? null;
  }

  // Matcher le nom du service
  for (const service of services) {
    const name = service.serviceName;
    for (const pattern of patternDef.patterns) {
      if (pattern.test(name)) {
        console.log(`[spain-mapping] ✅ Match: "${name}" (ID: ${service.serviceId}) ↔ "${visaType}" (pattern: ${pattern})`);
        return service;
      }
    }
  }

  // Fallback : si un seul service disponible, le prendre (cas fréquent : un seul type de RDV ouvert)
  if (services.length === 1) {
    console.log(`[spain-mapping] ⚠️ Pas de match pattern pour "${visaType}" mais un seul service dispo → fallback "${services[0].serviceName}"`);
    return services[0];
  }

  console.warn(`[spain-mapping] ❌ Aucun service ne matche "${visaType}" parmi: ${services.map((s) => s.serviceName).join(", ")}`);
  return null;
}

/**
 * Pour chaque dossier, trouve le service approprié.
 * Retourne un tableau de { dossier, service } avec seulement les matches réussis.
 */
export function matchDossiersToServices<T extends { visaType: string }>(
  services: ExtractedSlotInfo[],
  dossiers: T[],
): Array<{ dossier: T; service: ExtractedSlotInfo }> {
  const results: Array<{ dossier: T; service: ExtractedSlotInfo }> = [];

  for (const dossier of dossiers) {
    const service = matchServiceForVisa(services, dossier.visaType);
    if (service) {
      results.push({ dossier, service });
    }
  }

  return results;
}
