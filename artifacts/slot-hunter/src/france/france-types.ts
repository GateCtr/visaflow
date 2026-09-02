/**
 * France Visa Hunter — Types partagés.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (sections « Components and Interfaces » et « Data Models »).
 *
 * TypeScript strict : aucun `any`, propriétés optionnelles marquées,
 * `type` pour les unions, `interface` pour les objets.
 *
 * Requirements couverts : 13.3 (typage strict, pas de `any`),
 * 14.1 / 14.2 (identifiants portés par la config du Job, jamais en dur ;
 * séparation stricte `serviceId` / `serviceName`).
 */

// ---------------------------------------------------------------------------
// Motifs autorisés
// ---------------------------------------------------------------------------

/**
 * Motifs autorisés pour le custom field Visas (key `54cfd964c63f3386`).
 *
 * Note : la constante runtime `FRANCE_ALLOWED_MOTIFS` vit dans
 * `france-config.ts` (task 1.2) ; ce type union est déclaré ici (règle
 * « `type` pour les unions ») et réutilisé par la config, qui garantit à la
 * compilation que la liste runtime couvre exactement cette union.
 */
export type FranceMotif =
  | "Regroupement familial"
  | "Visa retour"
  | "Reunification familial"
  | "Stagiaire associé"
  | "Conjoint de Français - Installation"
  | "Etudiant"
  | "Autres";

// ---------------------------------------------------------------------------
// Configuration du Job France
// ---------------------------------------------------------------------------

/**
 * Cible de service. Sépare l'identifiant technique (`_id`, pour `get-interval`)
 * du nom textuel (pour `availability` + `slotValue`) — Requirement 14.2.
 */
export interface FranceServiceTarget {
  /** `_id` du service, utilisé par `get-interval`. */
  serviceId: string;
  /** Nom textuel complet, utilisé par `availability` et `slotValue`. */
  serviceName: string;
}

/**
 * Configuration France portée par le Job (aucun identifiant codé en dur) —
 * Requirements 14.1, 14.2.
 */
export interface FranceJobConfig {
  /** Slug du consulat, ex. "ambassade-de-france-a-kinshasa". */
  consulateSlug: string;
  /** Service cible (id + nom). */
  service: FranceServiceTarget;
  /** Contact principal de la réservation. */
  contact: BookingContact;
  /**
   * Clé du custom field Motif du service cible (SPÉCIFIQUE au service, lue
   * depuis team.reservations_shop_availabilty[service].custom_fields[].key).
   */
  motifKey: string;
  /**
   * Valeur du motif : DOIT correspondre à une valeur `custom_fields[].values[].name`
   * du service (espaces finaux inclus).
   */
  motif: string;
  /** Réservation automatique si un créneau est trouvé. */
  autoBook: boolean;
  /** Intervalle de polling en ms (jitter ±20 % appliqué à l'exécution). */
  scanIntervalMs: number;
}

// ---------------------------------------------------------------------------
// DTOs API (source : bundle-analysis/france-bundle-2026-08-31.md)
// ---------------------------------------------------------------------------

/** Créneau — GET /reservations/availability. */
export interface FranceSlot {
  /** "HH:MM". */
  time: string;
  /** "0.00" — chaîne décimale à 2 décimales. */
  rate: string;
  /** Entier positif. */
  capacity: number;
}

/** GET /reservations/get-interval. */
export interface GetIntervalResponse {
  /** "YYYY-MM-DD". */
  start: string;
  /** "YYYY-MM-DD". */
  end: string;
}

/** POST /reservations/exclude-days → tableau de "YYYY-MM-DD". */
export type ExcludeDaysResponse = string[];

/** Body POST /reservations/exclude-days. */
export interface ExcludeDaysBody {
  /** { [serviceId]: true }. */
  session: Record<string, true>;
  sessionId: string;
}

/** Contact principal (mois birthdate 0-indexé, convention dayjs). */
export interface BookingContact {
  /** 1..100 caractères. */
  firstname: string;
  /** 1..100 caractères. */
  lastname: string;
  /** Contient `@` + domaine. */
  email: string;
  /** 6..20 caractères. */
  mobile: string;
  /** Mois 0-indexé (month ∈ [0, 11]). */
  birthdate: { month: number; day: number; year: number };
}

/** Custom field Motif. */
export interface CustomField {
  key: string;
  values: string[];
}

/** Slot conservé pour le booking. */
export interface SlotToKeep {
  /** slugifié. */
  slotValue: string;
  /** "YYYY-MM-DDTHH:MM:00". */
  date: string;
  /** "HH:MM". */
  time: string;
  serviceName: string;
  /** "0.00" — repris du créneau availability (persisté dans slotsStep). */
  rate: string;
  /** Capacité du créneau — reprise du créneau availability. */
  capacity: number;
  /** Nombre de demandeurs sur ce créneau (1 pour une réservation simple). */
  numberOfApplicants?: number;
}

export interface ServiceForApi {
  /** Identifiant technique du service (obligatoire côté serveur). */
  _id?: string;
  /** Nom textuel du service. */
  name?: string;
  /** Nombre de créneaux pour ce service. */
  numberOfSlots?: number;
  /** Zone (== service dans ce portail) : { _id }. */
  zone?: { _id: string };
  /** slotValue cochés (auto-cochés pour 1 demandeur). */
  checkboxesSlots?: string[];
  customFieldsAreValid?: boolean;
  antsNumberIsValid?: boolean;
  customFields: CustomField[];
  slotsToKeep: SlotToKeep[];
}

/**
 * Utilisateur tel qu'envoyé à `reservations/family`. Le `birthdate` est un
 * OBJET `{month,day,year}` (month 0-indexé, convention dayjs) — voir bundle
 * chunk 27 `setupUserForApi` qui convertit la string en objet avant l'envoi.
 * (Le mainContactDetailsStep, lui, reçoit une STRING — c'est une étape distincte.)
 */
export interface UserForApi {
  firstname: string;
  lastname: string;
  email: string;
  mobile: string;
  /** { month (0-indexé), day, year } — converti par setupUserForApi. */
  birthdate: { month: number; day: number; year: number };
  services: ServiceForApi[];
}

/** Body POST /team/{teamId}/reservations/family. */
export interface ReservationsFamilyBody {
  reservations: {
    mainUser: UserForApi;
    /** [] pour Visas (reservation_people_max = 1). */
    secondaryUsers: UserForApi[];
    sessionId: string;
    /** teamId. */
    team: string;
  };
  language: "fr";
  /** Turnstile #2. */
  captcha: string;
  sessionId: string;
}

/** Réponse booking. */
export interface ReservationsFamilyResponse {
  data: { qrCodes: unknown[] };
}

// ---------------------------------------------------------------------------
// Résultats & états
// ---------------------------------------------------------------------------

/** Raison de détection de publication. */
export type SlotPublicationReason = "availability" | "exclude_days_retraction";

export interface SlotPublication {
  reason: SlotPublicationReason;
  /** "YYYY-MM-DD". */
  day: string;
  slots: FranceSlot[];
}

export interface BookingResult {
  success: boolean;
  qrCodes?: unknown[];
  /** stepType ayant échoué. */
  failedStep?: string;
  failedStepIndex?: number;
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  /** Nom du champ hors bornes. */
  invalidField?: string;
}

/** Fenêtre de scan (`end >= start`). */
export interface ScanWindow {
  /** "YYYY-MM-DD". */
  start: string;
  /** "YYYY-MM-DD" (>= start). */
  end: string;
}

/** Session de réservation (TTL 30 min). */
export interface ReservationSession {
  sessionId: string;
  /** Horodatage d'ouverture (temps injecté). */
  openedAtMs: number;
  /** 30 * 60_000. */
  ttlMs: number;
}

// ---------------------------------------------------------------------------
// État d'authentification & client HTTP
// ---------------------------------------------------------------------------

/** État d'authentification anti-bot courant (mutable, par Job). */
export interface FranceAuthState {
  /** = x-csrf-token courant. */
  handshakeToken: string;
  /** x-gouv-app-id. */
  appId: string;
  /** Dernier x-gouv-limit observé. */
  rateLimit?: string;
}

/** Résultat normalisé d'une requête HTTP. */
export interface FranceHttpResult<T> {
  status: number;
  ok: boolean;
  body: T | null;
  /** true si 404 { message: "SESSION_ERROR" }. */
  sessionError: boolean;
  /** true si 418 (handshake absent/invalide). */
  teapot: boolean;
}

/** Résultat normalisé d'une requête HEAD (pas de corps typé). */
export interface FranceHttpHeadResult {
  status: number;
  ok: boolean;
  /** Headers de réponse (clés en minuscules). */
  headers: Record<string, string>;
  /** true si 418 (handshake absent/invalide). */
  teapot: boolean;
}

/** Méthode HTTP supportée par le client France. */
export type FranceHttpMethod = "GET" | "POST" | "PUT" | "HEAD";

/** Options optionnelles d'une requête HTTP. */
export interface FranceRequestOptions {
  /** Headers additionnels (fusionnés avec les headers x-gouv-* injectés). */
  headers?: Record<string, string>;
  /** Paramètres de query string. */
  query?: Record<string, string>;
  /** Timeout spécifique en ms (défaut : FRANCE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Nombre maximal de tentatives (défaut : FRANCE_MAX_RETRIES). */
  maxRetries?: number;
  /** AbortSignal externe pour annuler la requête. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Turnstile & contexte de booking
// ---------------------------------------------------------------------------

/** But d'une résolution Turnstile (2 tokens distincts par parcours). */
export type TurnstilePurpose = "session" | "booking";

/**
 * Contexte transmis au flux de booking multistep.
 * Regroupe tout ce qui est nécessaire pour persister les 7 étapes puis
 * appeler `POST reservations/family`.
 */
export interface BookingContext {
  /** teamId du consulat résolu. */
  teamId: string;
  /** Session de réservation active. */
  sessionId: string;
  /** Service cible (id + nom). */
  service: FranceServiceTarget;
  /** Contact principal validé. */
  contact: BookingContact;
  /**
   * Clé du custom field Motif du service cible. SPÉCIFIQUE au service :
   * lue depuis team.reservations_shop_availabilty[service]._id → custom_fields[].key.
   * (ADF : "6480b20515fc40e7", Visas : "54cfd964c63f3386"). Ne pas coder en dur.
   */
  motifKey: string;
  /**
   * Valeur du motif : DOIT correspondre EXACTEMENT à une des valeurs
   * `custom_fields[].values[].name` du service (espaces finaux inclus).
   */
  motif: string;
  /** Créneau retenu pour la réservation. */
  slot: SlotToKeep;
  /** Token Turnstile #2 (booking). */
  captchaToken: string;
}

// ---------------------------------------------------------------------------
// Configuration d'environnement
// ---------------------------------------------------------------------------

/** Clés/secrets lus depuis l'environnement (jamais en dur) — Requirement 12.1. */
export interface FranceEnvConfig {
  /** Clé API CapSolver (résolution Turnstile proxyless). */
  capsolverApiKey: string;
  /** URL du proxy résidentiel FR utilisé pour le scan/booking. */
  proxyUrl: string;
}
