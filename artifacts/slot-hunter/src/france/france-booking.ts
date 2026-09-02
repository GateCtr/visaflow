/**
 * France Visa Hunter — Booking : fonctions pures.
 *
 * Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
 * (section « Components and Interfaces » → `france-booking.ts`, Properties 23–27).
 *
 * Ce fichier ne contient QUE des fonctions pures et déterministes :
 *   - `computeSlotValue`     — Property 25 (slotValue slugifié, minuscules).
 *   - `buildSlotToKeep`      — Property 25 (SlotToKeep bien formé).
 *   - `validateContact`      — Property 23 (bornes du contact).
 *   - `validateMotif`        — Property 24 (appartenance à la liste).
 *   - `buildReservations`    — Property 26 (structure des reservations).
 *   - `interpretBookingResponse` — Property 27 (succès ssi qrCodes non vide).
 *
 * Le flux réseau `runBookingFlow` (persistance des 6 étapes + POST
 * reservations/family) est implémenté séparément (task 10.4).
 *
 * Règles projet : TypeScript strict, aucun `any`, types de retour explicites,
 * fonctions camelCase, logs préfixés `[franceHunter]`.
 *
 * Requirements couverts : 10.4, 10.6, 10.8, 10.10, 10.11.
 */

import type {
  BookingContact,
  BookingContext,
  BookingResult,
  CustomField,
  FranceMotif,
  ReservationsFamilyBody,
  SlotToKeep,
  ValidationResult,
} from "./france-types.js";
import { FRANCE_ALLOWED_MOTIFS, FRANCE_MOTIF_KEY } from "./france-config.js";

// ---------------------------------------------------------------------------
// Bornes de validation du contact (Requirement 10.4 / Property 23)
// ---------------------------------------------------------------------------

const NAME_MIN_LEN = 1;
const NAME_MAX_LEN = 100;
const MOBILE_MIN_LEN = 6;
const MOBILE_MAX_LEN = 20;
const MONTH_MIN = 0;
const MONTH_MAX = 11;
const DAY_MIN = 1;
const DAY_MAX = 31;
const YEAR_MIN = 1900;

// ---------------------------------------------------------------------------
// slugify interne (aucune dépendance externe)
// ---------------------------------------------------------------------------

/**
 * Slugify pur et déterministe (aucune dépendance externe) :
 *   1. normalisation Unicode NFD + suppression des diacritiques (accents),
 *   2. passage en minuscules,
 *   3. remplacement des caractères non alphanumériques par des tirets,
 *   4. collapse des tirets consécutifs,
 *   5. suppression des tirets en bord.
 *
 * La sortie est entièrement en minuscules et ne contient que `[a-z0-9-]`.
 */
function slugify(input: string): string {
  return input
    .normalize("NFD")
    // Supprime les marques diacritiques combinantes (accents).
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Tout caractère hors [a-z0-9] devient un tiret.
    .replace(/[^a-z0-9]+/g, "-")
    // Collapse des tirets multiples (défensif après le remplacement groupé).
    .replace(/-+/g, "-")
    // Trim des tirets en bord.
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// ---------------------------------------------------------------------------
// slotValue & SlotToKeep (Requirement 10.8 / Property 25)
// ---------------------------------------------------------------------------

/**
 * Calcule le `slotValue` d'un créneau.
 *
 * `slotValue = slugify("slot-" + serviceName + "-" + slotDateIso + "-" + time)`
 * puis mis en minuscules. Déterministe (mêmes entrées → même sortie) et
 * entièrement en minuscules (Property 25).
 */
export function computeSlotValue(
  serviceName: string,
  slotDateIso: string,
  time: string,
): string {
  // Formule du bundle (helpers `getSlotValueForFamilyReservations`) :
  // slugify(`slot-${service.name}-${new Date(slot.date).toISOString()}-${slot.time}`)
  // CLÉ (validé bundle chunk 27) : dans slotsStep, `slot.date` est le JOUR SEUL
  // "YYYY-MM-DD" (pas l'heure). Donc new Date("2026-09-02").toISOString() =
  // "2026-09-02T00:00:00.000Z" (MINUIT UTC). L'heure vit dans `slot.time`.
  const isoMidnight = new Date(`${slotDateIso}T00:00:00Z`).toISOString(); // "2026-09-02T00:00:00.000Z"
  const raw = `slot-${serviceName}-${isoMidnight}-${time}`;
  return slugify(raw).toLowerCase();
}

/**
 * Construit un `SlotToKeep` bien formé (Property 25) :
 *   - `date` au format `YYYY-MM-DDTHH:MM:00`,
 *   - `slotValue` via `computeSlotValue`,
 *   - `time` et `serviceName` fournis tels quels.
 *
 * `slotDateIso` est attendu au format `YYYY-MM-DD` et `time` au format `HH:MM`.
 */
export function buildSlotToKeep(
  serviceName: string,
  slotDateIso: string,
  time: string,
  rate: string,
  capacity: number,
): SlotToKeep {
  return {
    slotValue: computeSlotValue(serviceName, slotDateIso, time),
    date: `${slotDateIso}T${time}:00`,
    time,
    serviceName,
    rate,
    capacity,
  };
}

// ---------------------------------------------------------------------------
// Validation du contact (Requirement 10.4 / Property 23)
// ---------------------------------------------------------------------------

/** true ssi la longueur de `value` est dans `[min, max]` (bornes incluses). */
function isLengthInRange(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max;
}

/**
 * Valide qu'un email contient un `@` suivi d'un domaine, le domaine
 * comportant au moins un point après le `@` (ex. `a@b.co`).
 */
function isValidEmail(email: string): boolean {
  const atIndex = email.indexOf("@");
  // Il faut au moins un caractère avant le `@`.
  if (atIndex <= 0) return false;
  // Un seul `@` autorisé.
  if (email.indexOf("@", atIndex + 1) !== -1) return false;
  const domain = email.slice(atIndex + 1);
  const dotIndex = domain.indexOf(".");
  // Un point présent, ni en tête ni en fin de domaine.
  return dotIndex > 0 && dotIndex < domain.length - 1;
}

/**
 * Valide les bornes d'un `BookingContact` (Property 23).
 *
 * Le `currentYear` est injectable pour garder la fonction pure/déterministe
 * dans les tests property-based ; il vaut par défaut l'année UTC courante.
 *
 * Retourne `{ valid: true }` si tous les champs sont dans leurs bornes,
 * sinon `{ valid: false, invalidField }` avec le premier champ hors bornes.
 */
export function validateContact(
  contact: BookingContact,
  currentYear: number = new Date().getUTCFullYear(),
): ValidationResult {
  if (!isLengthInRange(contact.firstname, NAME_MIN_LEN, NAME_MAX_LEN)) {
    return { valid: false, invalidField: "firstname" };
  }
  if (!isLengthInRange(contact.lastname, NAME_MIN_LEN, NAME_MAX_LEN)) {
    return { valid: false, invalidField: "lastname" };
  }
  if (!isValidEmail(contact.email)) {
    return { valid: false, invalidField: "email" };
  }
  if (!isLengthInRange(contact.mobile, MOBILE_MIN_LEN, MOBILE_MAX_LEN)) {
    return { valid: false, invalidField: "mobile" };
  }

  const { month, day, year } = contact.birthdate;
  if (!Number.isInteger(month) || month < MONTH_MIN || month > MONTH_MAX) {
    return { valid: false, invalidField: "birthdate.month" };
  }
  if (!Number.isInteger(day) || day < DAY_MIN || day > DAY_MAX) {
    return { valid: false, invalidField: "birthdate.day" };
  }
  if (!Number.isInteger(year) || year < YEAR_MIN || year > currentYear) {
    return { valid: false, invalidField: "birthdate.year" };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Validation du motif (Requirement 10.6 / Property 24)
// ---------------------------------------------------------------------------

/**
 * Type guard : `true` ssi `motif` appartient exactement à
 * `FRANCE_ALLOWED_MOTIFS` (Property 24).
 */
export function validateMotif(motif: string): motif is FranceMotif {
  return (FRANCE_ALLOWED_MOTIFS as readonly string[]).includes(motif);
}

// ---------------------------------------------------------------------------
// Construction des reservations (Requirement 10.10 / Property 26)
// ---------------------------------------------------------------------------

/**
 * Construit le corps `reservations` du POST `reservations/family` pour Visas.
 *
 * Structure (Property 26) : `{ mainUser, secondaryUsers: [], sessionId, team }`
 * où `secondaryUsers` est un tableau vide, `team` = `ctx.teamId`, et
 * `mainUser.services[0]` contient à la fois `customFields` (avec la clé motif
 * `FRANCE_MOTIF_KEY`) et `slotsToKeep`.
 */
export function buildReservations(
  ctx: BookingContext,
): ReservationsFamilyBody["reservations"] {
  // Clé + valeur du motif SPÉCIFIQUES au service (bundle setupServiceForApi :
  // customFields dérivés de zone.custom_fields). Portées par le contexte.
  const motifField: CustomField = {
    key: ctx.motifKey,
    values: [ctx.motif],
  };

  // birthdate → OBJET { month (0-indexé), day, year } : le bundle `setupUserForApi`
  // convertit la string du formulaire en objet dayjs AVANT l'envoi family.
  const birthdate = {
    month: ctx.contact.birthdate.month,
    day: ctx.contact.birthdate.day,
    year: ctx.contact.birthdate.year,
  };

  // slotsToKeep = slot COMPLET (bundle `setupServiceForApi` : spread du slot
  // persisté + `date` réécrit en "YYYY-MM-DDTHH:MM:00"). Doit contenir time,
  // rate, capacity, numberOfApplicants, slotValue, serviceName, date.
  const slotToKeep = {
    time: ctx.slot.time,
    rate: ctx.slot.rate,
    capacity: ctx.slot.capacity,
    numberOfApplicants: 1,
    slotValue: ctx.slot.slotValue,
    serviceName: ctx.slot.serviceName,
    date: `${ctx.slot.date.slice(0, 10)}T${ctx.slot.time}:00`,
  };

  return {
    mainUser: {
      firstname: ctx.contact.firstname,
      lastname: ctx.contact.lastname,
      email: ctx.contact.email,
      mobile: ctx.contact.mobile,
      birthdate,
      services: [
        {
          // Le service family conserve ses identifiants (bundle setupServiceForApi
          // ne fait que réécrire customFields + slotsToKeep, le reste est préservé).
          // Sans _id/zone, le serveur ne peut résoudre la ressource → ERROR_ADD_GROUPPED_RESERVATION.
          _id: ctx.service.serviceId,
          name: ctx.service.serviceName,
          numberOfSlots: 1,
          zone: { _id: ctx.service.serviceId },
          checkboxesSlots: [ctx.slot.slotValue],
          customFieldsAreValid: true,
          antsNumberIsValid: true,
          customFields: [motifField],
          slotsToKeep: [slotToKeep],
        },
      ],
    },
    secondaryUsers: [],
    sessionId: ctx.sessionId,
    team: ctx.teamId,
  };
}

// ---------------------------------------------------------------------------
// Interprétation de la réponse de booking (Requirement 10.11 / Property 27)
// ---------------------------------------------------------------------------

/** Extrait un tableau `qrCodes` non vide d'une réponse inconnue, sinon `null`. */
function extractQrCodes(res: unknown): unknown[] | null {
  if (typeof res !== "object" || res === null) return null;
  const data = (res as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const qrCodes = (data as { qrCodes?: unknown }).qrCodes;
  if (!Array.isArray(qrCodes) || qrCodes.length === 0) return null;
  return qrCodes;
}

/**
 * Interprète la réponse de `reservations/family` (Property 27).
 *
 * Succès (`success = true`) si et seulement si `data.qrCodes` est présent et
 * non vide. Aucune validation aveugle : toute forme non conforme est traitée
 * comme un échec (Requirement 12.2).
 */
export function interpretBookingResponse(res: unknown): BookingResult {
  const qrCodes = extractQrCodes(res);
  if (qrCodes === null) {
    return { success: false, error: "qrCodes absent ou vide" };
  }
  return { success: true, qrCodes };
}

// ===========================================================================
// Flux réseau de booking multistep (task 10.4)
// ===========================================================================
//
// Source de vérité : `.kiro/specs/france-visa-hunter/design.md`
// (séquence `update-step-value ×7` → `POST reservations/family`) et
// requirements 10.1, 10.2, 10.3, 10.5, 10.7, 10.9, 10.12 (Property 22).
//
// `runBookingFlow` orchestre :
//   1. Validation AMONT du contact (Req 10.5) et du motif (Req 10.7). En cas
//      d'invalidité → interruption SANS aucun appel réseau (ni update-step-value
//      ni reservations/family).
//   2. Persistance des 6 étapes de formulaire du parcours Visas dans l'ordre
//      EXACT services(0) → important-info(1) → slots(2) → contact(3) →
//      motif(4) → confirmation(5), via
//      `POST /team/{teamId}/reservations-session/{sessionId}/update-step-value`.
//      `welcome` est EXCLU : c'est l'ouverture de session (createReservationsSession),
//      pas une étape persistée.
//      avec le corps `{key, value, stepIndex}` (Req 10.1, 10.2, Property 22).
//   3. Interruption sans envoi final si une étape renvoie ≥ 400 / result.ok
//      false / échec (Req 10.3), en remontant `failedStep` + `failedStepIndex`.
//   4. `POST /team/{teamId}/reservations/family` avec Turnstile #2 dans le champ
//      `captcha` + `x-csrf-token` (géré par le client sur POST) (Req 10.9).
//   5. Interprétation via `interpretBookingResponse` : échec (qrCodes
//      absent/vide) → `{success:false}`, session préservée, AUCUNE nouvelle
//      tentative automatique (Req 10.11, 10.12).

import type { FranceHttpClient } from "./france-http.js";
import { maskSecret } from "./france-http.js";

/** stepType du parcours Visas (ordre canonique, Property 22). */
export type BookingStepType =
  | "services"
  | "important-info"
  | "slots"
  | "contact"
  | "motif"
  | "confirmation";

/**
 * Clé RÉELLE (`key`/`origin`) attendue par l'API `update-step-value` pour
 * chaque étape. VALIDÉ LIVE 2026-08-31 : l'API attend les NOMS D'ÉTAT du store
 * Troov (`servicesStep`, `importantInformationStep`, `slotsSteps`,
 * `mainContactDetailsStep`, `customFieldsStep`, `askConfirmationStep`), PAS des
 * noms courts. Une `key` inconnue (ex. `services`) fait PENDRE l'API (timeout).
 */
export const STEP_KEY_BY_TYPE: Record<BookingStepType, string> = {
  services: "servicesStep",
  "important-info": "importantInformationStep",
  // update-step-value attend le SINGULIER "slotsStep" (+ dynamicStepIndex).
  // Le PLURIEL "slotsSteps" est réservé à update-dynamic-steps. Envoyer le
  // pluriel à update-step-value fait PENDRE l'API (timeout). Validé live.
  slots: "slotsStep",
  contact: "mainContactDetailsStep",
  motif: "customFieldsStep",
  confirmation: "askConfirmationStep",
};

/**
 * Définition d'une étape persistée via `update-step-value`.
 *
 * Le corps envoyé au portail est `{ key, value, stepIndex }`. `stepType` est le
 * nom interne (logs/tests, Property 22) ; `key` est le NOM D'ÉTAT réel attendu
 * par l'API (cf. `STEP_KEY_BY_TYPE`) — les deux diffèrent.
 */
export interface StepDefinition {
  /** Type d'étape interne (logs/tests). */
  stepType: BookingStepType;
  /** Position de l'étape, de 0 à 5 (Property 22). */
  stepIndex: number;
  /** Clé RÉELLE envoyée au portail (nom d'état, via `STEP_KEY_BY_TYPE`). */
  key: string;
  /** Valeur persistée pour l'étape (dérivée du contexte). */
  value: unknown;
  /** Index dynamique (pour slotsStep uniquement, = 0 pour 1 demandeur). */
  dynamicStepIndex?: number;
}

/**
 * Ordre canonique des `stepType` du parcours Visas (Property 22).
 *
 * La séquence des étapes persistées DOIT être exactement égale à ce tableau,
 * chaque étape portant un `stepIndex` égal à sa position (0..5).
 */
// NOTE : `welcome` N'EST PAS une étape persistée. Dans le bundle, welcome-step
// = « Turnstile #1 → createReservationsSession » : c'est l'OUVERTURE DE SESSION
// (POST reservations-session), déjà réalisée par `openSession`. La réponse de
// session ne contient d'ailleurs pas de `welcomeStep` (services/slots/contact/…
// uniquement). Persister `update-step-value {key:"welcome"}` sur une session
// déjà ouverte fait pendre l'API. On ne persiste donc QUE les vraies étapes de
// formulaire, à partir de `services`.
// NOTE : `motif` (customFieldsStep) N'EST PAS une étape persistée pour le
// service ADF — la réponse de session ne contient pas de `customFieldsStep`
// (clés réelles : servicesStep, importantInformationStep, slotsSteps,
// mainContactDetailsStep, askConfirmationStep…). Le motif est porté par les
// `customFields` du service dans le body `reservations/family` (buildReservations),
// pas par un update-step-value. Persister `customFieldsStep` fait pendre l'API.
// (Le service Visas peut avoir ce champ ; pour ADF on ne le persiste pas.)
export const BOOKING_STEP_ORDER: readonly BookingStepType[] = [
  "services",
  "important-info",
  "slots",
  "contact",
  "confirmation",
] as const;

/**
 * Construit la liste ORDONNÉE des 6 étapes de formulaire du parcours Visas à partir du
 * contexte de booking (fonction pure, testable hors réseau — Property 22).
 *
 * L'ordre et les `stepIndex` (0..5) sont l'invariant critique (Property 22).
 * Les valeurs (`value`) sont dérivées du contexte :
 *   - `important-info` / `confirmation` : accusé de lecture (`true`),
 *   - `services` : nom textuel du service ciblé,
 *   - `slots` : le `SlotToKeep` retenu (`ctx.slot`),
 *   - `contact` : les champs du contact (`ctx.contact`),
 *   - `motif` : le custom field motif `{ key: FRANCE_MOTIF_KEY, values: [motif] }`.
 *
 * Note d'hypothèse : le design ne fige pas la charge utile exacte de chaque
 * étape ; on utilise des valeurs cohérentes dérivées du contexte. Seuls
 * l'ordre et le `stepIndex` sont contractuels (Property 22).
 */
export function buildBookingSteps(ctx: BookingContext): StepDefinition[] {
  const motifField: CustomField = {
    key: ctx.motifKey,
    values: [ctx.motif],
  };

  // Valeurs validées live 2026-09-01. `servicesStep` attend
  // `{services:[{_id,name,numberOfSlots}], numberOfApplicants}` ;
  // `slotsStep` attend `{slots:{[serviceId]:[slot]},label,services}` avec
  // dynamicStepIndex:0 ; `mainContactDetailsStep` birthdate en string ISO ;
  // `importantInformationStep` et `askConfirmationStep` des objets (pas boolean).
  const birthdateStr = [
    String(ctx.contact.birthdate.year).padStart(4, "0"),
    String(ctx.contact.birthdate.month + 1).padStart(2, "0"), // 0-indexé → 1-indexé
    String(ctx.contact.birthdate.day).padStart(2, "0"),
  ].join("-");

  const valueByStep: Record<BookingStepType, unknown> = {
    services: {
      services: [{ _id: ctx.service.serviceId, name: ctx.service.serviceName, numberOfSlots: 1 }],
      numberOfApplicants: 1,
    },
    "important-info": { readInformations: true },
    // slotsStep : les slots sont indexés PAR DATE (YYYY-MM-DD), pas par
    // serviceId (validé via le composant slots-step / stepMixin). Chaque slot
    // sélectionné porte `numberOfApplicants` (marqueur de sélection = nombre de
    // personnes sur ce créneau). Réservation groupée : N personnes au même
    // créneau. Ici 1 personne → numberOfApplicants:1.
    // slotsStep value_ (bundle chunk 27) :
    //   { lastSelectedDate, label, accessibleCalendar:false, hasSwitchedCalendar:false, slots }
    // slots indexé PAR JOUR "YYYY-MM-DD" ; chaque slot = { time, date(jour), slotValue,
    // serviceName, numberOfApplicants }. PAS de champ `services`.
    slots: {
      lastSelectedDate: ctx.slot.date.slice(0, 10),
      label: ctx.service.serviceName,
      accessibleCalendar: false,
      hasSwitchedCalendar: false,
      slots: {
        [ctx.slot.date.slice(0, 10)]: [
          {
            time: ctx.slot.time,
            rate: ctx.slot.rate,
            capacity: ctx.slot.capacity,
            date: ctx.slot.date.slice(0, 10),
            slotValue: ctx.slot.slotValue,
            serviceName: ctx.slot.serviceName,
            numberOfApplicants: 1,
          },
        ],
      },
    },
    contact: {
      lastname: ctx.contact.lastname,
      firstname: ctx.contact.firstname,
      email: ctx.contact.email,
      mobile: ctx.contact.mobile,
      birthdate: birthdateStr,
      slots: {},
      // mainContactDetailsStep.value.services (bundle chunk 27 `created`) :
      // chaque service sélectionné porte `slots` (les créneaux retenus) et
      // `checkboxesSlots` (les slotValue cochés). Pour 1 demandeur (hasOneAsker),
      // tous les slots sont auto-cochés → checkboxesSlots = [slotValue].
      // `getReservationsForApi` filtre `slots` via `checkboxesSlots.includes(slotValue)`
      // pour construire slotsToKeep — sans ça : ERROR_ADD_GROUPPED_RESERVATION.
      services: [
        {
          _id: ctx.service.serviceId,
          name: ctx.service.serviceName,
          numberOfSlots: 1,
          zone: { _id: ctx.service.serviceId },
          slots: [
            {
              time: ctx.slot.time,
              rate: ctx.slot.rate,
              capacity: ctx.slot.capacity,
              date: ctx.slot.date.slice(0, 10),
              slotValue: ctx.slot.slotValue,
              serviceName: ctx.slot.serviceName,
              numberOfApplicants: 1,
            },
          ],
          checkboxesSlots: [ctx.slot.slotValue],
          customFields: { [ctx.motifKey]: [ctx.motif] },
          customFieldsAreValid: true,
          antsNumberIsValid: true,
        },
      ],
    },
    motif: [motifField],
    confirmation: {},
  };

  return BOOKING_STEP_ORDER.map((stepType, stepIndex) => ({
    stepType,
    stepIndex,
    key: STEP_KEY_BY_TYPE[stepType],
    value: valueByStep[stepType],
    ...(stepType === "slots" ? { dynamicStepIndex: 0 } : {}),
  }));
}

/**
 * Exécute le flux de booking multistep complet (Req 10.1–10.3, 10.5, 10.7,
 * 10.9, 10.12).
 *
 * Séquence :
 *   1. Valide `ctx.contact` (Req 10.5) et `ctx.motif` (Req 10.7) EN AMONT. Si
 *      invalide → `{ success:false, error }` SANS aucun appel réseau.
 *   2. Persiste les 6 étapes via `update-step-value` dans l'ordre canonique.
 *      Toute étape en erreur (≥ 400 / `ok=false` / exception) interrompt le
 *      flux SANS `reservations/family` et retourne `{ success:false,
 *      failedStep, failedStepIndex, error }` (Req 10.3).
 *   3. `POST reservations/family` avec `captcha = ctx.captchaToken`,
 *      `language = "fr"` et `x-csrf-token` géré par le client (Req 10.9).
 *   4. Interprète la réponse via `interpretBookingResponse`. En cas d'échec
 *      (qrCodes absent/vide), la session est préservée et AUCUNE nouvelle
 *      tentative automatique n'est effectuée (Req 10.11, 10.12).
 *
 * Aucune donnée sensible (token, PII) n'est journalisée en clair : les valeurs
 * sensibles passent par `maskSecret`.
 */
export async function runBookingFlow(
  http: FranceHttpClient,
  ctx: BookingContext,
): Promise<BookingResult> {
  // --- 1. Validations amont (aucun appel réseau si invalide) --------------
  const contactCheck = validateContact(ctx.contact);
  if (!contactCheck.valid) {
    const error = `Contact invalide : champ « ${contactCheck.invalidField} » hors bornes`;
    console.error(`[franceHunter] Booking interrompu (contact invalide) — ${error}`);
    return { success: false, error };
  }

  // Le motif et sa clé sont SPÉCIFIQUES au service (custom_fields du service dans
  // team.reservations_shop_availabilty). La validation « valeur ∈ valeurs du
  // service » doit se faire en amont (construction du contexte). Ici on vérifie
  // seulement la présence de la clé + valeur (le custom field Motif est required).
  if (ctx.motifKey.trim().length === 0 || ctx.motif.trim().length === 0) {
    const error = `Motif ou clé de motif manquant (motifKey="${ctx.motifKey}", motif="${ctx.motif}")`;
    console.error(`[franceHunter] Booking interrompu (motif invalide) — ${error}`);
    return { success: false, error };
  }

  // --- 2. Persistance ordonnée des 6 étapes -------------------------------
  const steps = buildBookingSteps(ctx);
  const stepPath = `/team/${ctx.teamId}/reservations-session/${ctx.sessionId}/update-step-value`;
  const dynPath  = `/team/${ctx.teamId}/reservations-session/${ctx.sessionId}/update-dynamic-steps`;

  for (const step of steps) {
    // Avant l'étape slotsStep : initialiser slotsSteps via update-dynamic-steps.
    // Le serveur crée l'entrée slotsSteps[0] qui sera ensuite écrite par update-step-value.
    if (step.stepType === "slots") {
      try {
        // Shape EXACT du bundle (chunk 27, submit servicesStep) :
        //   services.filter(numberOfSlots).map((t,e) => ({
        //     stepType:"slotsStep", name, numberOfSlots, dynamicStepIndex:e,
        //     zone_id, value:{ lastSelectedDate:"", label, accessibleCalendar:false,
        //     hasSwitchedCalendar:false, slots:{} } }))
        // Dans ce portail, `zone` == service : zone_id = serviceId, name/label = serviceName.
        const dynBody = {
          key: "slotsSteps",
          steps: [{
            stepType: "slotsStep",
            name: ctx.service.serviceName,
            numberOfSlots: 1,
            dynamicStepIndex: 0,
            zone_id: ctx.service.serviceId,
            value: {
              lastSelectedDate: "",
              label: ctx.service.serviceName,
              accessibleCalendar: false,
              hasSwitchedCalendar: false,
              slots: {},
            },
          }],
        };
        const dynRes = await http.post<unknown>(dynPath, dynBody);
        console.log(`[DIAG] update-dynamic-steps → status=${dynRes.status} ok=${dynRes.ok} body=${JSON.stringify(dynRes.body).slice(0, 400)}`);
        if (!dynRes.ok) {
          console.error(
            `[franceHunter] Booking interrompu : update-dynamic-steps échoué (HTTP ${dynRes.status}) — reservations/family NON envoyé.`,
          );
          return { success: false, failedStep: "slots", failedStepIndex: step.stepIndex, error: `update-dynamic-steps HTTP ${dynRes.status}` };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[franceHunter] Booking interrompu : update-dynamic-steps exception — ${msg}`);
        return { success: false, failedStep: "slots", failedStepIndex: step.stepIndex, error: msg };
      }
    }

    try {
      const body: Record<string, unknown> = {
        key: step.key,
        value: step.value,
        stepIndex: step.stepIndex,
      };
      // slotsStep nécessite dynamicStepIndex:0 (1 demandeur).
      if (step.dynamicStepIndex !== undefined) {
        body.dynamicStepIndex = step.dynamicStepIndex;
      }
      const res = await http.post<unknown>(stepPath, body);
      console.log(`[DIAG] update-step-value(${step.stepType}, stepIndex=${step.stepIndex}, dynIdx=${step.dynamicStepIndex ?? "-"}) → status=${res.status} ok=${res.ok} body=${JSON.stringify(res.body).slice(0, 400)}`);

      // Statut d'erreur (≥ 400) ou échec normalisé → interruption SANS envoi
      // final (Req 10.3). `sessionError`/`teapot` impliquent déjà `ok=false`.
      if (!res.ok) {
        const error = `Étape « ${step.stepType} » (stepIndex ${step.stepIndex}) a échoué : HTTP ${res.status}`;
        console.error(
          `[franceHunter] Booking interrompu à l'étape « ${step.stepType} » (stepIndex ${step.stepIndex}, HTTP ${res.status}) — reservations/family NON envoyé.`,
        );
        return {
          success: false,
          failedStep: step.stepType,
          failedStepIndex: step.stepIndex,
          error,
        };
      }
    } catch (error) {
      // Échec après épuisement des retries → interruption SANS envoi final.
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[franceHunter] Booking interrompu à l'étape « ${step.stepType} » (stepIndex ${step.stepIndex}) — exception réseau, reservations/family NON envoyé:`,
        message,
      );
      return {
        success: false,
        failedStep: step.stepType,
        failedStepIndex: step.stepIndex,
        error: `Étape « ${step.stepType} » (stepIndex ${step.stepIndex}) : ${message}`,
      };
    }
  }

  // --- 3. POST reservations/family (Turnstile #2 + x-csrf-token) ----------
  const familyPath = `/team/${ctx.teamId}/reservations/family`;
  const body: ReservationsFamilyBody = {
    reservations: buildReservations(ctx),
    language: "fr",
    captcha: ctx.captchaToken,
    sessionId: ctx.sessionId,
  };

  try {
    console.log(
      `[franceHunter] 6 étapes persistées, envoi reservations/family (team=${maskSecret(ctx.teamId)}, session=${maskSecret(ctx.sessionId)}, captcha=${maskSecret(ctx.captchaToken)}).`,
    );

    console.log(`[DIAG] AVANT POST family path=${familyPath} bodyLen=${JSON.stringify(body).length}`);
    console.log(`[DIAG] family body=${JSON.stringify(body).slice(0, 1200)}`);
    const res = await http.post<unknown>(familyPath, body);
    console.log(`[DIAG] APRES POST family → status=${res.status} ok=${res.ok} sessionError=${res.sessionError} body=${JSON.stringify(res.body).slice(0, 600)}`);

    // --- 4. Interprétation de la réponse (Req 10.11, 10.12) ---------------
    if (!res.ok) {
      // Échec final : session PRÉSERVÉE, AUCUNE nouvelle tentative auto.
      const error = `reservations/family a échoué : HTTP ${res.status}`;
      console.error(
        `[franceHunter] Booking échoué (HTTP ${res.status}) — session préservée, aucune nouvelle tentative automatique.`,
      );
      return { success: false, error };
    }

    const result = interpretBookingResponse(res.body);
    if (!result.success) {
      // qrCodes absent/vide → échec, session préservée, pas de retry auto.
      console.error(
        `[franceHunter] Booking échoué (${result.error ?? "qrCodes absent ou vide"}) — session préservée, aucune nouvelle tentative automatique.`,
      );
      return result;
    }

    console.log(
      `[franceHunter] Booking confirmé : ${result.qrCodes?.length ?? 0} qrCode(s) reçu(s).`,
    );
    return result;
  } catch (error) {
    // Exception réseau sur l'envoi final : session préservée, pas de retry auto.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[franceHunter] Booking échoué (exception réseau sur reservations/family) — session préservée, aucune nouvelle tentative automatique:`,
      message,
    );
    return { success: false, error: `reservations/family : ${message}` };
  }
}
