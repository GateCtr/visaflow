/**
 * spain-bookitit-direct.ts
 *
 * Expose les mêmes fonctions que test-bookitit-dynamic.ts sous forme exportable.
 *
 * Règle fondamentale : on appelle toujours impit.fetch() DIRECTEMENT avec le
 * même jar + callback que le dynamic test — jamais via callBookititEndpoint /
 * spainCfFetch qui introduisent des différences de headers causant 0B.
 *
 * Usage :
 *   const ds = buildDynamicSession(session);
 *   const cfg  = await callDirect(ds, "getwidgetconfigurations/");
 *   const svcs = await callDirect(ds, "getservices/");
 *   const ags  = await callDirect(ds, "getagendas/", { "services[]": svcId, selectedPeople: "1" });
 *   const dt   = await callDirect(ds, "datetime/",   { "services[]": svcId, "agendas[]": agId, start, end, selectedPeople });
 */

import type { SpainCfSession } from "./spain-soax-solver.js";
import { Impit } from "impit";
import {
  inspectSetCookieHeader,
  parseSetCookies,
} from "./spain-cookie-parser.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DynamicSession {
  /** Instance impit partagée — la même que dans initWorkerSession */
  impit: InstanceType<typeof Impit>;
  /** Cookie jar : toutes les paires name/value (cf_clearance, PHPSESSID, _ga…) */
  jar: Record<string, string>;
  /** User-Agent Chrome utilisé pour toute la session */
  userAgent: string;
  /** jQuery callback fixé pour la durée de la session */
  jqCallback: string;
  /** Compteur de requêtes (incrémenté par makeUrl) */
  reqCounter: number;
  /** publickey extraite de l'URL du portail */
  publickey: string;
  /** Version du loader Bookitit (ex : "4") */
  version: string;
  /** URL du portail (src Bookitit) — avec trailing slash */
  widgetUrl: string;
  /** srvsrc retourné par POST token */
  srvsrc: string;
  /** Base des endpoints Bookitit (ex : "https://www.citaconsular.es/onlinebookings") */
  bookititBase: string;
  /** Session source — permet de persister les Set-Cookie reçus pendant le flow. */
  session?: SpainCfSession;
}

// ─── Constructeur ─────────────────────────────────────────────────────────────

/**
 * Construit un DynamicSession à partir d'un SpainCfSession établi par initWorkerSession.
 *
 * Toute la session PHP doit avoir été initialisée par initWorkerSession avant cet appel :
 *   probe → CF solve → GET portail → POST token → GET /main/
 */
export function buildDynamicSession(session: SpainCfSession): DynamicSession | null {
  const state = session.bookititState;
  const impit = session._ownImpit;

  if (!state || !impit) {
    console.warn("[bookitit-direct] buildDynamicSession: bookititState ou _ownImpit absent");
    return null;
  }

  // Construire le jar depuis session.allCookies (même ordre que le dynamic test)
  const jar: Record<string, string> = {};
  for (const c of session.allCookies) {
    jar[c.name] = c.value;
  }
  // cf_clearance vient de session.cfClearance (source de vérité)
  if (session.cfClearance) jar["cf_clearance"] = session.cfClearance;

  return {
    impit,
    jar,
    userAgent: session.userAgent,
    jqCallback: state.jqCallback,
    reqCounter: state.reqCounter,
    publickey: state.publickey,
    version: state.version,
    widgetUrl: state.widgetUrl,
    srvsrc: state.srvsrc,
    bookititBase: state.bookititBase,
    session,
  };
}

/**
 * Lit les valeurs de logintype exposées par le formulaire
 * « historique et annulations » du portail courant.
 *
 * Le résultat est mémorisé pour la durée de la DynamicSession afin de ne pas
 * refaire cet appel à chaque tentative de créneau.
 */
// ─── Helpers internes (identiques au dynamic test) ────────────────────────────

function buildCookieString(jar: Record<string, string>): string {
  return Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
}

type CookieTraceValue = { length: number; fingerprint: string };
const cookieTraceSnapshots = new WeakMap<object, Map<string, CookieTraceValue>>();

function traceSecretFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getCookieTraceSnapshot(jar: Record<string, string>): Map<string, CookieTraceValue> {
  return new Map(
    Object.entries(jar)
      .filter(([, value]) => Boolean(value))
      .map(([name, value]) => [
        name,
        { length: value.length, fingerprint: traceSecretFingerprint(value) },
      ]),
  );
}

function formatCookieTrace(ds: DynamicSession): string {
  const current = getCookieTraceSnapshot(ds.jar);
  const previous = cookieTraceSnapshots.get(ds);
  let state = "INITIAL";

  if (previous) {
    const names = new Set([...previous.keys(), ...current.keys()]);
    const changed = [...names].some((name) => {
      const before = previous.get(name);
      const after = current.get(name);
      return before?.length !== after?.length || before?.fingerprint !== after?.fingerprint;
    });
    state = changed ? "CHANGED" : "UNCHANGED";
  }

  cookieTraceSnapshots.set(ds, current);
  const cookies = [...current.entries()]
    .map(([name, value]) => `${name}(len=${value.length},fp=${value.fingerprint})`)
    .join(",");
  return `cookieState=${state} cookieCount=${current.size} ` +
    `cookieHeaderBytes=${buildCookieString(ds.jar).length} cookies=${cookies || "-"}`;
}

function formatSetCookieTrace(response: Response): string {
  const values = getSetCookieValues(response);
  const raw = values.join("\n");
  if (!raw) return "set-cookie=none";
  const diagnostic = inspectSetCookieHeader(raw);
  const entries = diagnostic.entries
    .map((entry) =>
      `${entry.name}(len=${entry.length},fp=${entry.fingerprint},comma=${entry.literalCommas},%2C=${entry.encodedCommas})`,
    )
    .join(",");
  return (
    `set-cookie=present rawBytes=${diagnostic.rawLength} rawFp=${diagnostic.rawFingerprint} ` +
    `segments=${diagnostic.segmentCount} invalid=${diagnostic.invalidSegmentCount} ` +
    `duplicates=${diagnostic.duplicateNames.join(",") || "-"} ` +
    `entries=${entries || "-"}`
  );
}

function getSetCookieValues(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie().filter((value): value is string => Boolean(value));
    if (values.length > 0) return values;
  }
  if (typeof headers.raw === "function") {
    const values = headers.raw()["set-cookie"] ?? headers.raw()["Set-Cookie"] ?? [];
    if (values.length > 0) return values.filter((value): value is string => Boolean(value));
  }
  const raw = headers.get("set-cookie") ?? "";
  return raw ? [raw] : [];
}

/**
 * Bookitit peut renouveler PHPSESSID pendant getsigninfields/ ou signin/.
 * Le jar manuel envoyé par makeDirectHeaders doit donc suivre les Set-Cookie
 * reçus, sinon l'appel suivant continue avec une session PHP obsolète.
 */
function mergeResponseCookies(ds: DynamicSession, response: Response): void {
  const raw = getSetCookieValues(response).join("\n");
  if (!raw) return;

  const diagnostic = inspectSetCookieHeader(raw);
  const received = diagnostic.cookies;
  for (const [name, value] of Object.entries(received)) {
    // Une valeur vide représente une suppression (Max-Age=0/Expires passée).
    if (value) ds.jar[name] = value;
    else delete ds.jar[name];
  }

  if (ds.session) {
    ds.session.allCookies = Object.entries(ds.jar)
      .filter(([, value]) => Boolean(value))
      .map(([name, value]) => ({ name, value }));
    if (Object.hasOwn(received, "cf_clearance")) {
      ds.session.cfClearance = received.cf_clearance || "";
    }
  }

  const jarState = getCookieTraceSnapshot(ds.jar);
  const mismatches = diagnostic.entries
    .filter((entry) => {
      const jarEntry = jarState.get(entry.name);
      return entry.length > 0
        ? jarEntry?.length !== entry.length || jarEntry.fingerprint !== entry.fingerprint
        : jarEntry !== undefined;
    })
    .map((entry) => entry.name);
  console.log(
    `[bookitit-trace] COOKIE-PARSE ` +
    `rawFp=${diagnostic.rawFingerprint} segments=${diagnostic.segmentCount} ` +
    `parsed=${diagnostic.entries.length} invalid=${diagnostic.invalidSegmentCount} ` +
    `duplicates=${diagnostic.duplicateNames.join(",") || "-"} ` +
    `jarCompare=${mismatches.length ? `MISMATCH(${mismatches.join(",")})` : "MATCH"}`,
  );
}

/**
 * Construit l'URL JSONP Bookitit.
 *
 * Ordre des paramètres : callback → type → publickey → lang →
 *   [services[]] → [agendas[]] → version → src → srvsrc →
 *   [autres extra] → _
 *
 * Bookitit peut être strict sur l'ordre (Cuba bkt897578 retourne 0B sinon).
 */
export function makeDirectUrl(ds: DynamicSession, endpoint: string, extra?: Record<string, string>): string {
  ds.reqCounter++;
  const params: Array<[string, string]> = [
    ["callback", ds.jqCallback],
    ["type",     "default"],
    ["publickey", ds.publickey],
    ["lang",     "es"],
  ];
  if (extra?.["services[]"]) params.push(["services[]", extra["services[]"]]);
  if (extra?.["agendas[]"])  params.push(["agendas[]",  extra["agendas[]"]]);
  params.push(["version", ds.version]);
  params.push(["src",     ds.widgetUrl]);
  params.push(["srvsrc",  ds.srvsrc]);
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (k !== "services[]" && k !== "agendas[]") params.push([k, v]);
  }
  params.push(["_", String(ds.reqCounter)]);
  const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${ds.bookititBase}/${endpoint}?${qs}`;
}

/**
 * Headers identiques au dynamic test — X-Requested-With, Accept, Sec-Fetch-*, Cookie.
 */
export function makeDirectHeaders(ds: DynamicSession): Record<string, string> {
  return {
    "User-Agent":        ds.userAgent,
    "Accept":            "text/javascript, application/javascript, */*; q=0.01",
    "X-Requested-With":  "XMLHttpRequest",
    "Sec-Fetch-Site":    "same-origin",
    "Sec-Fetch-Mode":    "cors",
    "Sec-Fetch-Dest":    "empty",
    "Referer":           ds.widgetUrl,
    "Cookie":            buildCookieString(ds.jar),
  };
}

const BOOKING_TRACE_ENDPOINTS = new Set(["getsigninfields/", "signin/"]);
const signinFieldsComparison = new Map<string, { contentFp: string; schemaFp: string }>();
const BOOKING_TRACE_REDACTED_KEYS = new Set([
  "callback",
  "publickey",
  "src",
  "srvsrc",
  "login",
  "password",
  "bktToken",
  "comments",
  "_",
]);

function formatBookingTraceUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const query = [...parsed.searchParams.entries()]
    .map(([key, value]) => {
      if (BOOKING_TRACE_REDACTED_KEYS.has(key)) {
        return `${key}=[REDACTED]`;
      }
      return `${key}=${value}`;
    })
    .join("&");
  return `${parsed.origin}${parsed.pathname}?${query}`;
}

function logBookingRequestTrace(
  endpoint: string,
  url: string,
  ds: DynamicSession,
  headers: Record<string, string>,
  attempt: number,
): void {
  if (!BOOKING_TRACE_ENDPOINTS.has(endpoint)) return;
  console.log(
    `[bookitit-trace] REQUEST ${endpoint} attempt=${attempt + 1} ` +
    `url=${formatBookingTraceUrl(url)} ` +
    `headers=${Object.keys(headers).sort().join(",")} ${formatCookieTrace(ds)}`,
  );
}

function logBookingResponseCookieTrace(endpoint: string, response: Response): void {
  if (!BOOKING_TRACE_ENDPOINTS.has(endpoint)) return;
  console.log(`[bookitit-trace] RESPONSE-COOKIES ${endpoint} ${formatSetCookieTrace(response)}`);
}

/**
 * Parse une réponse JSONP Bookitit.
 * Compatible avec les préfixes `jQuery...({...})` et `callback={...}`.
 */
export function parseDirectJsonp(raw: string): unknown | null {
  return parseDirectJsonpDetailed(raw).payload;
}

type DirectPayloadParse = {
  payload: unknown | null;
  shape: "empty" | "callback-prefix" | "jsonp" | "json" | "other";
  parsed: boolean;
  error: "empty" | "invalid-json" | "invalid-jsonp" | null;
};

function parseDirectJsonpDetailed(raw: string): DirectPayloadParse {
  let src = raw.replace(/^\uFEFF/, "").trim();
  if (!src) {
    return { payload: null, shape: "empty", parsed: false, error: "empty" };
  }

  let shape: DirectPayloadParse["shape"] = "other";
  const hasCallbackPrefix = /^callback\s*=/i.test(src);
  if (hasCallbackPrefix) {
    src = src.replace(/^callback\s*=\s*/i, "");
    shape = "callback-prefix";
  }

  const jsonp = src.match(/^[\w$.]+\(([\s\S]*)\)\s*;?\s*$/);
  if (jsonp) {
    try {
      return {
        payload: JSON.parse(jsonp[1].trim()),
        shape: hasCallbackPrefix ? "callback-prefix" : "jsonp",
        parsed: true,
        error: null,
      };
    } catch {
      return {
        payload: null,
        shape: hasCallbackPrefix ? "callback-prefix" : "jsonp",
        parsed: false,
        error: "invalid-jsonp",
      };
    }
  }

  if (src.startsWith("{") || src.startsWith("[")) shape = "json";
  try {
    return { payload: JSON.parse(src), shape, parsed: true, error: null };
  } catch {
    return { payload: null, shape, parsed: false, error: shape === "json" ? "invalid-json" : null };
  }
}

function fingerprintText(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "-";
  return Object.keys(value as Record<string, unknown>).sort().slice(0, 20).join("|") || "-";
}

function countErrors(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const errors = (value as Record<string, unknown>).errors;
  return Array.isArray(errors) ? errors.length : 0;
}

function payloadTraceSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "payload=scalar";
  if (Array.isArray(payload)) return `payload=array(${payload.length})`;

  const root = payload as Record<string, unknown>;
  const client = root.Client && typeof root.Client === "object" ? root.Client : null;
  const access = root.Access && typeof root.Access === "object" ? root.Access : null;
  const customFields = root.CustomFields && typeof root.CustomFields === "object"
    ? root.CustomFields
    : null;
  const clientRecord = client as Record<string, unknown> | null;
  const accessRecord = access as Record<string, unknown> | null;

  const hasToken = Boolean(
    root.bktToken ||
    accessRecord?.bktToken ||
    clientRecord?.bktToken,
  );
  const errors = countErrors(clientRecord) || countErrors(root);

  return [
    `payload=object`,
    `keys=${objectKeys(root)}`,
    `clientKeys=${objectKeys(client)}`,
    `accessKeys=${objectKeys(access)}`,
    `customFieldsKeys=${objectKeys(customFields)}`,
    `errors=${errors}`,
    `bktToken=${hasToken ? "yes" : "no"}`,
  ].join(" ");
}

const DYNAMIC_PAYLOAD_KEY = /^(?:_|callback|nonce|token|bktToken|csrf|session|cookie|timestamp|createdAt|updatedAt)$/i;

function payloadSchema(value: unknown, depth = 0): unknown {
  if (depth > 10) return "depth-limit";
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      items: value.slice(0, 50).map((item) => payloadSchema(item, depth + 1)),
    };
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, payloadSchema((value as Record<string, unknown>)[key], depth + 1)]),
    );
  }
  return typeof value;
}

function payloadContentFingerprint(value: unknown, key = "", depth = 0): unknown {
  if (depth > 10) return "depth-limit";
  if (DYNAMIC_PAYLOAD_KEY.test(key)) return "[dynamic]";
  if (typeof value === "string") {
    return { type: "string", length: value.length, fingerprint: fingerprintText(value) };
  }
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => payloadContentFingerprint(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((childKey) => [
          childKey,
          payloadContentFingerprint((value as Record<string, unknown>)[childKey], childKey, depth + 1),
        ]),
    );
  }
  return value;
}

function signinFieldsComparisonTrace(ds: DynamicSession, payload: unknown): string {
  if (!payload || typeof payload !== "object") return "gsfCompare=UNPARSED";

  const contentFp = fingerprintText(JSON.stringify(payloadContentFingerprint(payload)));
  const schemaFp = fingerprintText(JSON.stringify(payloadSchema(payload)));
  const key = `${ds.bookititBase}|${ds.publickey}`;
  const previous = signinFieldsComparison.get(key);
  const contentState = !previous
    ? "INITIAL"
    : previous.contentFp === contentFp
    ? "UNCHANGED"
    : "CHANGED";
  const schemaState = !previous
    ? "INITIAL"
    : previous.schemaFp === schemaFp
    ? "UNCHANGED"
    : "CHANGED";
  signinFieldsComparison.set(key, { contentFp, schemaFp });

  const root = payload as Record<string, unknown>;
  const customFields = root.CustomFields && typeof root.CustomFields === "object"
    ? root.CustomFields as Record<string, unknown>
    : null;
  const clients = customFields && Array.isArray(customFields.Clients) ? customFields.Clients : [];
  const fieldShapes = clients.slice(0, 30).map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field)) return typeof field;
    return Object.keys(field as Record<string, unknown>).sort().join("|") || "-";
  });

  return [
    `gsfCompare=content:${contentState}`,
    `schema:${schemaState}`,
    `contentFp=${contentFp}`,
    `schemaFp=${schemaFp}`,
    `rootKeys=${objectKeys(payload)}`,
    `clients=${clients.length}`,
    `fieldShapes=${fieldShapes.join(";") || "-"}`,
  ].join(" ");
}

function responseHeader(response: Response, name: string): string {
  return response.headers.get(name) ?? "-";
}

function responseUrlTrace(response: Response): string {
  const raw = response.url || "-";
  if (raw === "-") return raw;
  try {
    return formatBookingTraceUrl(raw);
  } catch {
    return "invalid-url";
  }
}

function logBookingResponseTrace(
  endpoint: string,
  requestUrl: string,
  response: Response,
  body: string,
  parsed: DirectPayloadParse,
): void {
  if (!BOOKING_TRACE_ENDPOINTS.has(endpoint)) return;
  const requestParams = new URL(requestUrl).searchParams;
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  const contentType = responseHeader(response, "content-type");
  const contentLength = responseHeader(response, "content-length");
  const retryAfter = responseHeader(response, "retry-after");
  // Aperçu du corps brut : essentiel pour diagnostiquer un "0B" — distingue un vrai
  // corps vide (HTTP 200 + 0B) d'un challenge CF, d'un HTML d'erreur ou d'un JSONP
  // d'erreur non parsé. On masque login/password éventuellement reflétés.
  const bodyPreview = body
    .slice(0, 300)
    .replace(/(login|password)=[^&";]*/gi, "$1=[REDACTED]")
    .replace(/\s+/g, " ");
  console.log(
    `[bookitit-trace] RESPONSE ${endpoint} ` +
    `HTTP=${response.status} ok=${response.ok ? "yes" : "no"} ` +
    `statusText=${response.statusText || "-"} redirected=${response.redirected ? "yes" : "no"} ` +
    `url=${responseUrlTrace(response)} ` +
    `raw=${body.length}B utf8=${bodyBytes} bodyFp=${fingerprintText(body)} ` +
    `contentType=${contentType} contentLength=${contentLength} retryAfter=${retryAfter} ` +
    `shape=${parsed.shape} parsed=${parsed.parsed ? "yes" : "no"} parseError=${parsed.error ?? "-"} ` +
    `date=${requestParams.get("date") ?? "-"} time=${requestParams.get("time") ?? "-"} ` +
    `svc=${requestParams.get("services[]") ?? "-"} ag=${requestParams.get("agendas[]") ?? "-"} ` +
    `${payloadTraceSummary(parsed.payload)} ` +
    `bodyPreview="${bodyPreview}"`,
  );
}

// ─── Appel direct ─────────────────────────────────────────────────────────────

/**
 * Appelle un endpoint Bookitit directement via impit.fetch — exactement comme le
 * dynamic test. Retourne le payload parsé, ou un sentinel distinguant surcharge
 * HTTP, erreur réseau et réponse vide.
 *
 * @param ds        DynamicSession (impit + jar + état jQuery)
 * @param endpoint  Ex : "getservices/", "datetime/"
 * @param extra     Paramètres supplémentaires (services[], agendas[], start, end…)
 * @param tag       Préfixe worker pour les logs (ex: "[WORKER:RANIA GHOUL]")
 */
/** Timeout par défaut pour les appels Bookitit (120s — protège contre les blocages
 *  infinis tout en laissant le temps au serveur de répondre sous forte charge). */
const CALL_DIRECT_TIMEOUT_MS = 120_000;

/** Codes HTTP transitoires : surcharge, rate limit ou connexion interrompue. */
const RETRYABLE_HTTP_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
/**
 * Nombre de retries sur les statuts transitoires ou erreur réseau.
 * Pendant le pic de publication, le serveur Bookitit crache des 504 pendant
 * plusieurs secondes (surcharge réelle côté serveur, pas notre fait). 2 retries
 * ne suffisent pas : beaucoup de workers abandonnent le scan et ratent les créneaux.
 * Configurable via SPAIN_BOOKITIT_MAX_RETRIES (défaut 2 = 3 tentatives).
 */
const CALL_DIRECT_MAX_RETRIES = ((): number => {
  const v = Number(process.env.SPAIN_BOOKITIT_MAX_RETRIES ?? "2");
  return Math.max(1, Number.isFinite(v) ? Math.round(v) : 2);
})();
/** Backoff de base entre retries (ms). Plafonné à CALL_DIRECT_RETRY_MAX_MS. */
const CALL_DIRECT_RETRY_BASE_MS = 400;
/** Plafond du backoff — évite d'exploser le temps de cycle pendant le pic. */
const CALL_DIRECT_RETRY_MAX_MS = 1_500;

/** Backoff plafonné : 400, 800, 1200, 1500, 1500… (pas d'explosion exponentielle). */
function retryBackoffMs(attempt: number): number {
  return Math.min(CALL_DIRECT_RETRY_BASE_MS * (attempt + 1) + attempt * 200, CALL_DIRECT_RETRY_MAX_MS);
}

function retryAfterMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(seconds * 1_000, 250), CALL_DIRECT_RETRY_MAX_MS);
    }
    const dateMs = Date.parse(raw) - Date.now();
    if (Number.isFinite(dateMs) && dateMs >= 0) {
      return Math.min(Math.max(dateMs, 250), CALL_DIRECT_RETRY_MAX_MS);
    }
  }
  return retryBackoffMs(attempt);
}

export async function callDirect(
  ds: DynamicSession,
  endpoint: string,
  extra?: Record<string, string>,
  tag?: string,
): Promise<unknown | null | typeof CALL_DIRECT_NETWORK_ERROR | typeof CALL_DIRECT_HTTP_OVERLOAD> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const prefix = tag ? `[bookitit-direct] ${tag}` : "[bookitit-direct]";

  for (let attempt = 0; attempt <= CALL_DIRECT_MAX_RETRIES; attempt++) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), CALL_DIRECT_TIMEOUT_MS);
      // Le flow de booking réutilise le même jar, en le mettant à jour si
      // Bookitit renouvelle PHPSESSID via Set-Cookie.
      const headers = makeDirectHeaders(ds);
      logBookingRequestTrace(endpoint, url, ds, headers, attempt);
      const res = await (ds.impit.fetch(url, { headers, signal: controller.signal } as any) as unknown as Promise<Response>);
      clearTimeout(timeout);
      timeout = undefined;
      logBookingResponseCookieTrace(endpoint, res);
      mergeResponseCookies(ds, res);
      const body = await res.text();
      const parsed = parseDirectJsonpDetailed(body);
      logBookingResponseTrace(endpoint, url, res, body, parsed);
      if (endpoint === "getsigninfields/") {
        console.log(
          `[bookitit-trace] GSF-COMPARE portalFp=${fingerprintText(`${ds.bookititBase}|${ds.publickey}`)} ` +
          `${signinFieldsComparisonTrace(ds, parsed.payload)}`,
        );
      }
      if (!res.ok) {
        // Retry uniquement sur les statuts transitoires. Les 4xx métier
        // (400/401/403/404/409/422) restent déterministes et ne sont pas répétés.
        if (RETRYABLE_HTTP_CODES.has(res.status) && attempt < CALL_DIRECT_MAX_RETRIES) {
          const backoff = retryAfterMs(res, attempt);
          console.warn(`${prefix} ${endpoint} → HTTP ${res.status} — retry ${attempt + 1}/${CALL_DIRECT_MAX_RETRIES} dans ${backoff}ms`);
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        if (RETRYABLE_HTTP_CODES.has(res.status)) {
          console.warn(`${prefix} ${endpoint} → HTTP ${res.status} après retries — réponse transitoire non résolue`);
          return CALL_DIRECT_HTTP_OVERLOAD;
        }
        console.warn(`${prefix} ${endpoint} → HTTP ${res.status}`);
        return null;
      }
      return parsed.payload;
    } catch (e) {
      if (timeout) clearTimeout(timeout);
      // Retry sur erreur réseau (TLS corrompue, proxy timeout, CONNECT cassé)
      if (attempt < CALL_DIRECT_MAX_RETRIES) {
        const backoff = retryBackoffMs(attempt);
        console.warn(`${prefix} ${endpoint} → erreur réseau: ${e} — retry ${attempt + 1}/${CALL_DIRECT_MAX_RETRIES} dans ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      console.warn(`${prefix} ${endpoint} → erreur réseau: ${e}`);
      return CALL_DIRECT_NETWORK_ERROR;
    }
  }
  // Épuisement des retries (ne devrait jamais arriver grâce au return dans la boucle)
  return null;
}

/**
 * Sentinel retourné par callDirect() quand l'appel échoue à cause d'une erreur
 * réseau (ProxyTunnelError, TimeoutError, etc.), à distinguer d'une réponse HTTP
 * vide légitime (null retourné par parseDirectJsonp sur corps vide).
 */
export const CALL_DIRECT_NETWORK_ERROR: unique symbol = Symbol("CALL_DIRECT_NETWORK_ERROR");

/**
 * Sentinel retourné quand Bookitit a répondu un statut transitoire (408/425/429/
 * 500/502/503/504) après tous les retries.
 * Il ne faut pas le confondre avec une réponse 0B ni avec une panne proxy :
 * le worker conserve son identité et retente le cycle sans rotation IP.
 */
export const CALL_DIRECT_HTTP_OVERLOAD: unique symbol = Symbol("CALL_DIRECT_HTTP_OVERLOAD");
