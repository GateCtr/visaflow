/**
 * Extrait anti-detection.ts, usa-http.ts, scan-slot-booking.ts et recompacte impl.ts
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(__dirname, "..", "src", "usaPortal");
const implPath = path.join(dir, "impl.ts");
const L = fs.readFileSync(implPath, "utf8").split(/\r?\n/);

function omitRanges(lines, ranges) {
  const skip = new Set();
  for (const [a, b] of ranges) {
    for (let i = a - 1; i <= b - 1; i++) skip.add(i);
  }
  return lines.filter((_, i) => !skip.has(i));
}

// ─── usa-http : lignes 310–736 + sessionHeaders 2074–2085 (AVANT anti qui importe usa-http) ───
let httpSlice = L.slice(309, 736).join("\n");
httpSlice = httpSlice
  .replace(/^const tokenCache/m, "export const tokenCache")
  .replace(/^const pendingLogin/m, "export const pendingLogin")
  .replace(/^function parseJwtExpiry/m, "export function parseJwtExpiry")
  .replace(/^function isCachedTokenValid/m, "export function isCachedTokenValid")
  .replace(/^async function sendKeepAliveIfNeeded/m, "export async function sendKeepAliveIfNeeded")
  .replace(/^function updateSessionActivity/m, "export function updateSessionActivity")
  .replace(/^async function refreshUsaToken/m, "export async function refreshUsaToken")
  .replace(/^function authHeaders/m, "export function authHeaders")
  .replace(/^const USA_UA_POOL/m, "export const USA_UA_POOL")
  .replace(/^function pickSessionUa/m, "export function pickSessionUa")
  .replace(/^async function usaFetch/m, "export async function usaFetch");

const sessionHdr = L.slice(2073, 2085).join("\n").replace(/^function sessionHeaders/m, "export function sessionHeaders");

const usaHttpFile = `import { ProxyAgent } from "undici";
import { Impit } from "impit";
import { proxyPool } from "../browser.js";
import { getVariableBrowserHeaders } from "../humanBehavior.js";
import type { CachedToken } from "./types.js";
import {
  USA_REFRESH_URL,
  USA_LANDING_PAGE_URL,
  TOKEN_REFRESH_BUFFER_MS,
  MAX_AUTH_IDLE_MS,
  MAX_SESSION_ABSOLUTE_MS,
  PROXY_EXPIRY_BUFFER_MS,
  USA_MISSION_ID,
  REFERER_LOGIN,
  REFERER_DASHBOARD,
  REFERER_CREATE_APT,
  KEEP_ALIVE_INTERVAL_MS,
} from "./config.js";

${httpSlice}

${sessionHdr}

export function setActiveSessionUaFromPoolIndex(i: number): void {
  _sessionUa = USA_UA_POOL[i];
}
`;
fs.writeFileSync(path.join(dir, "usa-http.ts"), usaHttpFile + "\n");

// ─── anti-detection (lignes 76–307) ───
const antiSlice = L.slice(75, 307).join("\n");
const antiFile = `import type { UsaSession } from "./types.js";
import { USA_BASE, REFERER_DASHBOARD, WARMUP_INTERVAL_MS } from "./config.js";
import { botLog } from "../convexClient.js";
import {
  humanPause,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
} from "../humanBehavior.js";
import { usaFetch, authHeaders } from "./usa-http.js";

${antiSlice
  .replace(/^async function randomInterStepPause/m, "export async function randomInterStepPause")
  .replace(/^function selectRandomFlow/m, "export function selectRandomFlow")
  .replace(/^async function sendAntiDetectionNoise/m, "export async function sendAntiDetectionNoise")
  .replace(/^function updateProxyReputation/m, "export function updateProxyReputation")
  .replace(/^function selectBestProxy/m, "export function selectBestProxy")
  .replace(/^function shouldDoWarmup/m, "export function shouldDoWarmup")
  .replace(/^const warmupLastCalledAt/m, "export const warmupLastCalledAt")
  .replace(/^async function executeWithHumanVariability/m, "export async function executeWithHumanVariability")
  .replace(/^const ofcCursor/m, "export const ofcCursor")}
`;
fs.writeFileSync(path.join(dir, "anti-detection.ts"), antiFile + "\n");

// ─── scan-slot-booking : 1980–2064 puis 2087–fin (sans sessionHeaders) ───
const scanA = L.slice(1979, 2064).join("\n");
const scanB = L.slice(2086).join("\n");

const scanFile = `import type { SessionResult, UsaSession } from "./types.js";
import type { HunterJob, SlotDiscoveryEvent } from "../convexClient.js";
import {
  reportSlotFound,
  sendHeartbeat,
  uploadFile,
  botLog,
  reportSlotDiscovery,
  reportSlotDiscoveryBatch,
} from "../convexClient.js";
import {
  humanLikeDelay,
  humanPause,
  shouldSimulateNetworkError,
  simulateNetworkTimeout,
  shuffleArray,
  randomSubset,
  simulateMenuClick,
  simulatePageRefresh,
  estimateExecutionTime,
  printExecutionTimeReport,
} from "../humanBehavior.js";
import { randomDelay, proxyPool, launchBrowser } from "../browser.js";
import {
  USA_BASE,
  USA_ADMIN_URL,
  USA_APPOINTMENT_URL,
  USA_NOTIFICATION_URL,
  USA_PAYMENT_URL,
  USA_WORKFLOW_URL,
  USA_APPLICANT_API_URL,
  USA_OFC_LIST_URL,
  USA_TRANSFORM_DATA_URL,
  USA_FIRST_AVAILABLE_MONTH_URL,
  USA_SLOT_DATES_URL,
  USA_SLOT_TIMES_URL,
  USA_APP_DETAILS_URL,
  USA_CONFIRMATION_LETTER_URL,
  USA_SCHEDULE_URL,
  USA_RESCHEDULE_URL,
  USA_SEARCH_URL,
  USA_SCHEDULED_INFO_URL,
  USA_SHOW_RESCHEDULE_BUTTON_URL,
  USA_LANDING_PAGE_URL,
  USA_SANITY_CHECK_URL,
  USA_FCS_CHECK_URL,
  USA_MISSION_ID,
  REFERER_DASHBOARD,
  REFERER_REQUESTS,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
  WARMUP_INTERVAL_MS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import { isRestrictedBody, markAccountRestricted } from "./account-restriction.js";
import {
  usaFetch,
  authHeaders,
  sessionHeaders,
  updateSessionActivity,
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

${scanA}

${scanB}
`;

// Exports scan + download : préfixer scanUsaSlotsViaAPI et download
const scanFixed = scanFile
  .replace(/^async function scanUsaSlotsViaAPI/m, "export async function scanUsaSlotsViaAPI")
  .replace(/^export async function downloadUsaConfirmationPdf/m, "export async function downloadUsaConfirmationPdf")
  .replace(/^async function downloadUsaConfirmationPdf/m, "export async function downloadUsaConfirmationPdf");

fs.writeFileSync(path.join(dir, "scan-slot-booking.ts"), scanFixed + "\n");

// ─── impl : retirer [76–307], [310–736], [2074–2085], [1980–L] puis insérer imports ───
const newLines = omitRanges(L, [
  [76, 307],
  [310, 736],
  [2074, 2085],
  [1980, L.length],
]);

let implOut = newLines.join("\n");
const insertAfter = '} from "../humanBehavior.js";';
const pos = implOut.indexOf(insertAfter);
if (pos === -1) throw new Error("humanBehavior import");
const insertPos = implOut.indexOf("\n", pos) + 1;
const extra = `
import {
  tokenCache,
  pendingLogin,
  usaFetch,
  authHeaders,
  sessionHeaders,
  makeIproyalStickyUrl,
  setUsaSessionProxy,
  pickSessionUa,
  USA_UA_POOL,
  setActiveSessionUaFromPoolIndex,
  parseJwtExpiry,
  isCachedTokenValid,
  sendKeepAliveIfNeeded,
  updateSessionActivity,
  refreshUsaToken,
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
import { scanUsaSlotsViaAPI, downloadUsaConfirmationPdf } from "./scan-slot-booking.js";
`;
implOut = implOut.slice(0, insertPos) + extra + implOut.slice(insertPos);
implOut = implOut.replace(
  /_sessionUa = USA_UA_POOL\[sessionUaIdx\];/g,
  "setActiveSessionUaFromPoolIndex(sessionUaIdx);",
);

fs.writeFileSync(implPath, implOut + "\n");
console.log("OK: anti-detection.ts, usa-http.ts, scan-slot-booking.ts, impl.ts");
