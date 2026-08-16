/**
 * spain-slot-coordinator.ts — Coordinateur atomique de créneaux pour les workers autonomes
 *
 * Wraps les opérations Redis de réservation de créneau et d'IP exportées
 * depuis spain-redis-persistence.ts pour fournir une API de haut niveau
 * aux workers per-dossier (Task #52).
 *
 * GARANTIES :
 *   - tryClaimSlot : Lua atomique → un seul dossier obtient une place par invocation
 *   - Capacité : plusieurs dossiers peuvent réserver le même créneau si freeSlots > 1
 *   - TTL 90s : expire automatiquement si le booking échoue silencieusement
 */

export {
  tryClaimWorkerSlot as tryClaimSlot,
  /**
   * Libère la réservation d'UN dossier sur un créneau (atomic Lua dossier-specific).
   * Décrémente `booked` du groupSize de ce dossier uniquement.
   * Signature: (date, time, agendaId, dossierId)
   */
  releaseWorkerSlot as releaseSlotClaim,
  reserveWorkerIp,
  isIpReservedByOther,
  releaseWorkerIp,
  publishSlotSnapshot,
} from "./spain-redis-persistence.js";
