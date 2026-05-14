/**
 * Lit src/usaPortal.ts et produit src/usaPortal/impl.ts (logique principale sans blocs extraits).
 * Exécuter depuis artifacts/slot-hunter : node scripts/splice-usa-portal.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = path.join(root, "src");
const srcFile = path.join(src, "usaPortal.ts");
const outDir = path.join(src, "usaPortal");
const outFile = path.join(outDir, "impl.ts");

const L = fs.readFileSync(srcFile, "utf8").split(/\r?\n/);

let head = L.slice(0, 21).join("\n");
head = head.replace(/^import \{ createCipheriv, pbkdf2Sync, randomBytes \} from "crypto";\r?\n/, "");
head = head
  .replace(`from "./browser.js"`, `from "../browser.js"`)
  .replace(`from "./convexClient.js"`, `from "../convexClient.js"`)
  .replace(`from "./humanBehavior.js"`, `from "../humanBehavior.js"`);

// Inclut ofcCursor (ligne 510) ; exclut crypto + interfaces (déjà dans ./types et ./crypto)
const anti = L.slice(277, 510).join("\n");
const httpTokenBlock = L.slice(570, 776).join("\n"); // tokenCache … refreshUsaToken
const httpTransportBlock = L.slice(895, 1116).join("\n"); // authHeaders … usaFetch
const httpBlock = `${httpTokenBlock}\n\n${httpTransportBlock}`;
const tail = L.slice(1117).join("\n"); // ligne 1118+

const imports = `import type { SessionResult, CachedToken, UsaSession, UsaAppointmentRequest, UsaLoginResponse } from "./types.js";
import {
  USA_BASE,
  USA_LOGIN_URL,
  USA_LOGOUT_URL,
  USA_REFRESH_URL,
  USA_PAYMENT_STATUS_URL,
  USA_APPT_REQUESTS_URL,
  USA_MISSION_ID,
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
  TOKEN_REFRESH_BUFFER_MS,
  USA_PORTAL_IDLE_TIMEOUT_MS,
  MAX_AUTH_IDLE_MS,
  MAX_SESSION_ABSOLUTE_MS,
  PROXY_EXPIRY_BUFFER_MS,
  REFERER_LOGIN,
  REFERER_DASHBOARD,
  REFERER_REQUESTS,
  REFERER_CREATE_APT,
  REFERER_MANAGE_APT,
  KEEP_ALIVE_INTERVAL_MS,
  WARMUP_INTERVAL_MS,
} from "./config.js";
import { RateLimitError, AccountBlockedError, TokenExpiredError, AccountRestrictedError } from "./errors.js";
import {
  isAccountRestricted,
  markAccountRestricted,
  isRestrictedBody,
  getAccountRestrictionDeadline,
} from "./account-restriction.js";
import { encryptPortalCredentials } from "./crypto.js";
`;

let fixedTail = tail.replace(
  /const until = accountRestrictedUntil\.get\(cacheKey\)!/,
  "const until = getAccountRestrictionDeadline(username)!",
);
fixedTail = fixedTail.replace(/\baccountRestrictedUntil\.get\(/g, "getAccountRestrictionDeadline(");

let body = `${head}

${imports}

${anti}

${httpBlock}

${fixedTail}
`;

// Évite double déclaration avec ./config.js
body = body.replace(/const KEEP_ALIVE_INTERVAL_MS = 8 \* 60 \* 1000[^\n]*/g, "");
body = body.replace(/const WARMUP_INTERVAL_MS = 8 \* 60 \* 1000[^\n]*/g, "");

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, body + "\n");
console.log("Wrote", outFile, "lines", body.split("\n").length);
