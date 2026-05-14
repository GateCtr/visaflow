/**
 * Découpe un scan-slot-booking **monolithique** (~2000 lignes) en usa-scan-*.ts + orchestrateur fin.
 *
 * Ne pas lancer sur `scan-slot-booking.ts` déjà modulaire (imports `./usa-scan-types.js`).
 * Préparer une copie monolithique, par exemple :
 *   git show <commit>:artifacts/slot-hunter/src/usaPortal/scan-slot-booking.ts > src/usaPortal/scan-slot-booking.monolith.ts
 * Puis :
 *   set USA_SCAN_MONOLITH_INPUT=src/usaPortal/scan-slot-booking.monolith.ts   (chemin relatif au cwd slot-hunter)
 *   node scripts/split-usa-scan-booking.mjs
 *
 * Numéros de ligne : structure du monolithe tel qu’avant le premier découpage (mai 2026).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTAL = path.join(__dirname, "../src/usaPortal");

const defaultMono = path.join(PORTAL, "scan-slot-booking.monolith.ts");
const defaultCurrent = path.join(PORTAL, "scan-slot-booking.ts");
const INPUT = process.env.USA_SCAN_MONOLITH_INPUT
  ? path.resolve(process.cwd(), process.env.USA_SCAN_MONOLITH_INPUT)
  : fs.existsSync(defaultMono)
    ? defaultMono
    : defaultCurrent;

const rawInput = fs.readFileSync(INPUT, "utf8");
if (rawInput.includes('from "./usa-scan-types.js"') || rawInput.includes("from './usa-scan-types.js'")) {
  console.error(
    "[split-usa-scan-booking] Fichier source déjà modulaire (référence usa-scan-types).\n" +
      "Placez le monolithe sous scan-slot-booking.monolith.ts ou définissez USA_SCAN_MONOLITH_INPUT vers une copie complète (~2000 lignes)."
  );
  process.exit(1);
}

const lines = rawInput.split(/\r?\n/);
const slice = (a, b) => lines.slice(a - 1, b).join("\n");

/** Exports requis pour que tsc reconnaisse les modules générés. */
function exportifyTypes(src) {
  return src
    .replace(/^interface /gm, "export interface ")
    .replace(/^function normalizeOfc/m, "export function normalizeOfc")
    .replace(/^function toYMD/m, "export function toYMD")
    .replace(/^function lastDayOfMonth/m, "export function lastDayOfMonth");
}

function exportifyPreflight(src) {
  return src
    .replace(/^async function callLandingPage/m, "export async function callLandingPage")
    .replace(/^async function callSanityCheck/m, "export async function callSanityCheck")
    .replace(/^async function checkFcsPayment/m, "export async function checkFcsPayment");
}

function exportifyDetails(src) {
  return src
    .replace(/^async function getUsaApplicationDetails/m, "export async function getUsaApplicationDetails")
    .replace(/^async function getUsaTransformData/m, "export async function getUsaTransformData")
    .replace(/^async function getUsaOfcList/m, "export async function getUsaOfcList");
}

function exportifyBook(src) {
  return src
    .replace(/^interface UsaBookingPayload/m, "export interface UsaBookingPayload")
    .replace(/^interface UsaBookingEntry/m, "export interface UsaBookingEntry")
    .replace(/^type UsaBookingResponse/m, "export type UsaBookingResponse")
    .replace(/^interface UsaBookingResult/m, "export interface UsaBookingResult")
    .replace(/^function reportSlotDiscovery_batch/m, "export function reportSlotDiscovery_batch")
    .replace(/^async function bookUsaSlot/m, "export async function bookUsaSlot")
    .replace(/^async function rescheduleUsaSlot/m, "export async function rescheduleUsaSlot");
}

const typesBody = [slice(73, 157), "", slice(501, 508), "", slice(229, 235)].join("\n");

const typesFile = exportifyTypes(`/**
 * Types et utilitaires purs pour le scan de créneaux / booking portail USA.
 * Extrait de scan-slot-booking.ts (découpage maintenance).
 */

${typesBody}
`);

const preflightFile = exportifyPreflight(`/**
 * Warm-up API : landing, sanity check, FCS (pré-scan).
 */
import type { UsaSession } from "./types.js";
import {
  USA_LANDING_PAGE_URL,
  USA_SANITY_CHECK_URL,
  USA_FCS_CHECK_URL,
  REFERER_DASHBOARD,
  REFERER_CREATE_APT,
} from "./config.js";
import { usaFetch, sessionHeaders } from "./usa-http.js";

${slice(159, 227)}
`);

const detailsFile = exportifyDetails(`/**
 * Détails demande, transform data, liste OFC.
 */
import type { UsaSession } from "./types.js";
import type { UsaAppDetails, UsaOfc, UsaOfcRaw } from "./usa-scan-types.js";
import { normalizeOfc } from "./usa-scan-types.js";
import {
  USA_APP_DETAILS_URL,
  USA_TRANSFORM_DATA_URL,
  USA_OFC_LIST_URL,
  REFERER_CREATE_APT,
  REFERER_REQUESTS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, authHeaders, sessionHeaders } from "./usa-http.js";

${slice(237, 494)}
`);

const findBody = slice(510, 823).replace(
  /^async function findFirstSlotForOfc/m,
  "export async function findFirstSlotForOfc"
);

const findFile = `/**
 * Recherche du premier créneau disponible pour un OFC (mois → dates → heures).
 */
import type { UsaSession } from "./types.js";
import type { SlotDiscoveryEvent } from "../convexClient.js";
import type {
  UsaOfc,
  UsaAppDetails,
  UsaFirstAvailableMonthResponse,
  UsaSlotDate,
  UsaTimeSlot,
  SlotFound,
} from "./usa-scan-types.js";
import { toYMD, lastDayOfMonth } from "./usa-scan-types.js";
import {
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  REFERER_CREATE_APT,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, authHeaders, sessionHeaders } from "./usa-http.js";

${findBody}
`;

const bookFile = exportifyBook(`/**
 * Booking / reschedule + helpers (format UI time, batch discovery).
 */
import type { UsaSession } from "./types.js";
import type { UsaTimeSlot } from "./usa-scan-types.js";
import type { SlotDiscoveryEvent } from "../convexClient.js";
import { reportSlotDiscoveryBatch } from "../convexClient.js";
import {
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  REFERER_MANAGE_APT,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody } from "./account-restriction.js";
import { usaFetch, sessionHeaders } from "./usa-http.js";

${slice(894, 921)}

${slice(856, 874)}

${slice(834, 838)}

${slice(933, 1057)}

${slice(1073, 1164)}
`);

const confirmationFile = `/**
 * Téléchargement lettre de confirmation PDF.
 */
import type { UsaSession } from "./types.js";
import {
  USA_SANITY_CHECK_URL,
  USA_CONFIRMATION_LETTER_URL,
  REFERER_REQUESTS,
} from "./config.js";
import { usaFetch, sessionHeaders } from "./usa-http.js";

${slice(1166, 1245)}
`;

const scanOrchestrator = `/**
 * Orchestration du scan de créneaux USA (API directe) + rapport Convex.
 * Logique métier détaillée : usa-scan-types, preflight, details, find, book, confirmation.
 */
import type { SessionResult, UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import {
  reportSlotFound,
  sendHeartbeat,
  uploadFile,
  botLog,
} from "../convexClient.js";
import {
  humanPause,
  shouldSimulateNetworkError,
  simulateNetworkTimeout,
  simulateMenuClick,
  simulatePageRefresh,
} from "../humanBehavior.js";
import { randomDelay } from "../browser.js";
import {
  USA_SEARCH_URL,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
  WARMUP_INTERVAL_MS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { markAccountRestricted } from "./account-restriction.js";
import {
  usaFetch,
  authHeaders,
  updateSessionActivity,
  tokenCache,
} from "./usa-http.js";
import {
  randomInterStepPause,
  selectRandomFlow,
  sendAntiDetectionNoise,
  executeWithHumanVariability,
  shouldDoWarmup,
  warmupLastCalledAt,
  ofcCursor,
} from "./anti-detection.js";
import type { UsaOfc, UsaAppDetails, SlotFound } from "./usa-scan-types.js";
import { toYMD } from "./usa-scan-types.js";
import { callLandingPage, callSanityCheck } from "./usa-scan-preflight.js";
import { getUsaApplicationDetails, getUsaTransformData, getUsaOfcList } from "./usa-scan-details.js";
import { findFirstSlotForOfc } from "./usa-scan-find.js";
import { bookUsaSlot, rescheduleUsaSlot, reportSlotDiscovery_batch } from "./usa-scan-book.js";
import type { UsaBookingResult } from "./usa-scan-book.js";
import { downloadUsaConfirmationPdf } from "./usa-scan-confirmation.js";

export { downloadUsaConfirmationPdf };

${slice(1247, 2033)}
`;

fs.writeFileSync(path.join(PORTAL, "usa-scan-types.ts"), typesFile);
fs.writeFileSync(path.join(PORTAL, "usa-scan-preflight.ts"), preflightFile);
fs.writeFileSync(path.join(PORTAL, "usa-scan-details.ts"), detailsFile);
fs.writeFileSync(path.join(PORTAL, "usa-scan-find.ts"), findFile);
fs.writeFileSync(path.join(PORTAL, "usa-scan-book.ts"), bookFile);
fs.writeFileSync(path.join(PORTAL, "usa-scan-confirmation.ts"), confirmationFile);
fs.writeFileSync(path.join(PORTAL, "scan-slot-booking.ts"), scanOrchestrator);

console.log(`[split-usa-scan-booking] OK — source=${INPUT}`);
console.log("Puis : npm run build (dans artifacts/slot-hunter)");
