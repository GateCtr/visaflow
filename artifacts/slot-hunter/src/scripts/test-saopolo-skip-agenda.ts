/**
 * Read-only direct datetime/ check for the known Saopolo and Kinshasa service
 * and agenda IDs. Skips POST token, /main/, getservices/, and getagendas/.
 *
 * Uses the correct proxy class per portal and keeps the same Impit client and
 * proxy for Cloudflare resolution, widget session creation, and datetime calls.
 * No reservation endpoint is called.
 *
 * Usage: cd artifacts/slot-hunter && npx tsx src/scripts/test-saopolo-skip-agenda.ts
 */

import "dotenv/config";
import { Impit } from "impit";
import {
  getPortalProxyType,
  KINSHASA_DEFAULT_AGENDA_ID,
  KINSHASA_DEFAULT_SERVICE_ID,
  KINSHASA_PORTAL_URL,
  KINSHASA_WIDGET_KEY,
  SAOPOLO_DEFAULT_AGENDA_ID,
  SAOPOLO_DEFAULT_SERVICE_ID,
  SAOPOLO_PORTAL_URL,
  SAOPOLO_WIDGET_KEY,
} from "../spain-portals.js";

type CookieJar = Record<string, string>;
type ImpitClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};
type PortalTarget = {
  label: string;
  portalUrl: string;
  widgetKey: string;
  serviceId: string;
  agendaId: string;
};
type DateRange = {
  start: string;
  end: string;
};
type DirectResult = {
  portal: string;
  success: boolean;
  durationMs: number;
  requests: number;
  validResponses: number;
  openDays: number;
  freeTimes: number;
  warning?: string;
};
type SolverTaskResponse = {
  errorId?: number;
  errorCode?: string;
  taskId?: string | number;
};
type SolverResultResponse = {
  errorId?: number;
  errorCode?: string;
  status?: string;
  solution?: {
    token?: string;
    cookies?: Record<string, string>;
  };
};
type DirectSession = {
  client: ImpitClient;
  target: PortalTarget;
  portalUrl: string;
  origin: string;
  bookititBase: string;
  jar: CookieJar;
  callback: string;
  requestCounter: number;
};

const TARGETS: PortalTarget[] = [
  {
    label: "Saopolo",
    portalUrl: SAOPOLO_PORTAL_URL,
    widgetKey: SAOPOLO_WIDGET_KEY,
    serviceId: SAOPOLO_DEFAULT_SERVICE_ID,
    agendaId: SAOPOLO_DEFAULT_AGENDA_ID,
  },
  {
    label: "Kinshasa",
    portalUrl: KINSHASA_PORTAL_URL,
    widgetKey: KINSHASA_WIDGET_KEY,
    serviceId: KINSHASA_DEFAULT_SERVICE_ID,
    agendaId: KINSHASA_DEFAULT_AGENDA_ID,
  },
];

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DATETIME_MONTHS = 3;
const T0 = Date.now();

function log(message: string): void {
  console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s] ${message}`);
}

function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function extractSetCookies(headers: Headers): CookieJar {
  const jar: CookieJar = {};
  const raw = headers.get("set-cookie") ?? "";
  for (const part of raw.split(/,(?=[^ ])/)) {
    const match = part.trim().match(/^([^=]+)=([^;]*)/);
    if (match) jar[match[1]] = match[2];
  }
  return jar;
}

function maskProxy(proxyUrl: string): string {
  try {
    const proxy = new URL(proxyUrl);
    return `${proxy.protocol}//${proxy.hostname}:${proxy.port || "default-port"}/[credentials hidden]`;
  } catch {
    return "(proxy configured)";
  }
}

function sanitizeError(message: string): string {
  return message
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[credentials hidden]@")
    .replace(/((?:token|cookie|sessionid)=)[^&\s]+/gi, "$1[redacted]");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseJsonp(raw: string): unknown | null {
  const value = raw.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const open = value.indexOf("(");
    const close = value.lastIndexOf(")");
    if (open < 0 || close <= open) return null;
    try {
      return JSON.parse(value.slice(open + 1, close));
    } catch {
      return null;
    }
  }
}

function countAvailableTimes(payload: unknown): { openDays: number; freeTimes: number } {
  const root = asRecord(payload);
  const days = Array.isArray(root?.Slots) ? root.Slots : [];
  let openDays = 0;
  let freeTimes = 0;
  for (const item of days) {
    const day = asRecord(item);
    if (!day || Number(day.state) !== 1) continue;
    openDays += 1;
    const times = day.times;
    const entries = Array.isArray(times)
      ? times
      : Object.values(asRecord(times) ?? {});
    for (const time of entries) {
      const record = asRecord(time);
      if (Number(record?.freeSlots ?? record?.freeslots ?? 0) > 0) freeTimes += 1;
    }
  }
  return { openDays, freeTimes };
}

function portalUrlWithoutHash(target: PortalTarget): string {
  return target.portalUrl.split("#")[0] ?? target.portalUrl;
}

function getProxyForPortal(target: PortalTarget): string {
  const proxyType = getPortalProxyType(target.widgetKey);
  const proxyUrl =
    proxyType === "residential"
      ? process.env.SPAIN_RESIDENTIAL_PROXY_URL
      : process.env.DECODO_PROXY_URL ?? process.env.SPAIN_ISP_PROXY_URL;
  if (!proxyUrl) {
    throw new Error(
      `${target.label}: proxy ${proxyType} non configuré pour ce portail.`,
    );
  }
  // Les identifiants ISP peuvent être liés à une IP fixe; ne pas les réécrire.
  return proxyType === "residential" ? stickyProxyUrl(proxyUrl) : proxyUrl;
}

function stickyProxyUrl(proxyUrl: string): string {
  try {
    const proxy = new URL(proxyUrl);
    const username = decodeURIComponent(proxy.username);
    const stickyId = Math.random().toString(36).slice(2, 10);
    if (username.includes("-session-")) {
      proxy.username = encodeURIComponent(
        username.replace(/-session-[^-]+/, `-session-${stickyId}`),
      );
    } else if (username.includes("sessionduration")) {
      proxy.username = encodeURIComponent(
        username.replace(/-sessionduration-[^-]+/, `-session-${stickyId}`),
      );
    }
    return proxy.toString();
  } catch {
    return proxyUrl;
  }
}

function capSolverProxyFormat(proxyUrl: string): string {
  const proxy = new URL(proxyUrl);
  return [
    proxy.hostname,
    proxy.port || "80",
    decodeURIComponent(proxy.username),
    decodeURIComponent(proxy.password),
  ].join(":");
}

function createImpit(proxyUrl: string): ImpitClient {
  return new Impit({ browser: "chrome", proxyUrl } as never) as unknown as ImpitClient;
}

async function resolveCloudflare(
  target: PortalTarget,
  portalUrl: string,
  client: ImpitClient,
  proxyUrl: string,
): Promise<CookieJar> {
  section(`${target.label} — résolution Cloudflare`);
  const response = await client.fetch(portalUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await response.text();
  const cookies = extractSetCookies(response.headers);
  const challenged =
    response.status === 403 ||
    /just a moment|un instant|verifying you are human|_cf_chl_opt/i.test(html);

  if (!challenged) {
    log(`${target.label} : pas de challenge (HTTP ${response.status}, ${html.length}B).`);
    return Object.fromEntries(
      Object.entries(cookies).filter(
        ([name]) => name.startsWith("cf_") || name.startsWith("__cf"),
      ),
    );
  }

  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY manquant.");
  log(`${target.label} : challenge détecté (HTTP ${response.status}, ${html.length}B).`);

  const createResponse = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: portalUrl,
        userAgent: USER_AGENT,
        html,
        proxy: capSolverProxyFormat(proxyUrl),
      },
    }),
  });
  const task = (await createResponse.json()) as SolverTaskResponse;
  if (!createResponse.ok || task.errorId || !task.taskId) {
    throw new Error(
      `CapSolver createTask a échoué (${task.errorCode ?? createResponse.status}).`,
    );
  }

  let clearance = "";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    const pollResponse = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_API_KEY, taskId: task.taskId }),
    });
    const result = (await pollResponse.json()) as SolverResultResponse;
    if (result.errorId) {
      throw new Error(`CapSolver a échoué (${result.errorCode ?? "erreur inconnue"}).`);
    }
    if (result.status === "failed") {
      throw new Error(`CapSolver a échoué (${result.errorCode ?? "tâche refusée"}).`);
    }
    if (result.status === "ready") {
      clearance =
        result.solution?.cookies?.cf_clearance ??
        result.solution?.token ??
        "";
      break;
    }
  }
  if (!clearance) throw new Error("Délai dépassé pendant la résolution Cloudflare.");

  cookies.cf_clearance = clearance;
  log(`${target.label} : résolution terminée; valeurs de cookies masquées.`);
  return Object.fromEntries(
    Object.entries(cookies).filter(
      ([name]) => name.startsWith("cf_") || name.startsWith("__cf"),
    ),
  );
}

function monthRanges(): DateRange[] {
  const now = new Date();
  const ranges: DateRange[] = [];
  for (let offset = 0; offset < DATETIME_MONTHS; offset += 1) {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
    const lastDay = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000);
    ranges.push({
      start: month.toISOString().slice(0, 10),
      end: lastDay.toISOString().slice(0, 10),
    });
  }
  return ranges;
}

async function openDirectSession(
  target: PortalTarget,
  client: ImpitClient,
  cfCookies: CookieJar,
): Promise<DirectSession> {
  const portalUrl = portalUrlWithoutHash(target);
  const origin = new URL(portalUrl).origin;
  const jar: CookieJar = { ...cfCookies };
  const response = await client.fetch(portalUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
      Cookie: cookieHeader(jar),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await response.text();
  Object.assign(jar, extractSetCookies(response.headers));
  log(
    `${target.label} GET widget → HTTP ${response.status}, ${html.length}B; ` +
      `PHPSESSID=${Boolean(jar.PHPSESSID)}. POST token ignoré; /main/ ignoré.`,
  );
  if (!jar.PHPSESSID) {
    throw new Error(`${target.label}: GET widget sans PHPSESSID.`);
  }

  return {
    client,
    target,
    portalUrl,
    origin,
    bookititBase: `${origin}/onlinebookings/`,
    jar,
    callback: `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
    requestCounter: Date.now(),
  };
}

function makeDatetimeUrl(
  session: DirectSession,
  range: DateRange,
): string {
  const query = new URLSearchParams();
  query.append("callback", session.callback);
  query.append("type", "default");
  query.append("publickey", session.target.widgetKey);
  query.append("lang", "es");
  query.append("services[]", session.target.serviceId);
  query.append("agendas[]", session.target.agendaId);
  query.append("version", "4");
  query.append("src", session.portalUrl);
  query.append("srvsrc", session.origin);
  query.append("start", range.start);
  query.append("end", range.end);
  query.append("selectedPeople", "1");
  session.requestCounter += 1;
  query.append("_", String(session.requestCounter));
  return `${session.bookititBase}datetime/?${query.toString()}`;
}

async function callDatetime(
  session: DirectSession,
  range: DateRange,
): Promise<{ status: number; body: string; durationMs: number }> {
  const started = Date.now();
  const response = await session.client.fetch(makeDatetimeUrl(session, range), {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "text/javascript, application/javascript, application/ecmascript, " +
        "application/x-ecmascript, */*; q=0.01",
      "Accept-Language": "fr-FR,fr;q=0.9",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Priority: "u=1, i",
      Referer: session.portalUrl,
      Cookie: cookieHeader(session.jar),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  Object.assign(session.jar, extractSetCookies(response.headers));
  return { status: response.status, body, durationMs: Date.now() - started };
}

async function testPortal(target: PortalTarget): Promise<DirectResult> {
  const started = Date.now();
  let requests = 0;
  let validResponses = 0;
  let openDays = 0;
  let freeTimes = 0;

  try {
    const proxyUrl = getProxyForPortal(target);
    const client = createImpit(proxyUrl);
    const portalUrl = portalUrlWithoutHash(target);
    log(`${target.label} : service=${target.serviceId}, agenda=${target.agendaId}; proxy=${maskProxy(proxyUrl)}.`);

    const cfCookies = await resolveCloudflare(target, portalUrl, client, proxyUrl);
    const session = await openDirectSession(target, client, cfCookies);
    const ranges = monthRanges();
    for (const range of ranges) {
      const response = await callDatetime(session, range);
      requests += 1;
      const payload = parseJsonp(response.body);
      if (response.status === 200 && response.body.length > 0 && payload !== null) {
        validResponses += 1;
      }
      const counts = countAvailableTimes(payload);
      openDays += counts.openDays;
      freeTimes += counts.freeTimes;
      log(
        `${target.label} datetime/ service=${target.serviceId} agenda=${target.agendaId} ` +
          `${range.start}→${range.end} → HTTP ${response.status}, ${response.body.length}B, ` +
          `${counts.openDays} jour(s) ouvert(s), ${counts.freeTimes} horaire(s) libre(s), ` +
          `${(response.durationMs / 1000).toFixed(2)}s`,
      );
    }

    return {
      portal: target.label,
      success: validResponses > 0,
      durationMs: Date.now() - started,
      requests,
      validResponses,
      openDays,
      freeTimes,
      warning:
        validResponses === 0
          ? "Aucune réponse datetime JSONP exploitable."
          : undefined,
    };
  } catch (error) {
    const warning = sanitizeError(
      error instanceof Error ? error.message : "Erreur inconnue.",
    );
    log(`${target.label} interrompu: ${warning}`);
    return {
      portal: target.label,
      success: false,
      durationMs: Date.now() - started,
      requests,
      validResponses,
      openDays,
      freeTimes,
      warning,
    };
  }
}

async function main(): Promise<void> {
  section("datetime/ direct — Saopolo");
  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY manquant.");
  log("Flux: Cloudflare → GET widget → datetime/ direct avec service[] + agenda[].");
  log("Aucun POST token, /main/, getservices/, getagendas/ ou appel de réservation.");

  const requestedPortal = process.argv
    .find((argument) => argument.startsWith("--portal="))
    ?.slice("--portal=".length)
    .toLowerCase();
  const targets = requestedPortal
    ? TARGETS.filter((target) => target.label.toLowerCase() === requestedPortal)
    : TARGETS.filter((target) => target.label.toLowerCase() === "saopolo");
  if (requestedPortal && targets.length === 0) {
    throw new Error("Portail inconnu; valeurs acceptées: saopolo, kinshasa.");
  }

  const results: DirectResult[] = [];
  for (const target of targets) {
    results.push(await testPortal(target));
  }

  section("Résumé direct datetime/");
  for (const result of results) {
    log(
      `${result.portal}: ${result.success ? "datetime OK" : "échec"} | ` +
        `${(result.durationMs / 1000).toFixed(2)}s | ` +
        `réponses JSONP=${result.validResponses}/${result.requests} | ` +
        `jours ouverts=${result.openDays} | horaires libres=${result.freeTimes}` +
        (result.warning ? ` | ${result.warning}` : ""),
    );
  }
}

main().catch((error: unknown) => {
  const message = sanitizeError(
    error instanceof Error ? error.message : "Erreur inconnue.",
  );
  console.error(`[direct-datetime-test] Arrêt: ${message}`);
  process.exitCode = 1;
});