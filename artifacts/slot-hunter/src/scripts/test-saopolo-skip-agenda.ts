/**
 * Compare deux flux de lecture seule pour São Paulo (Saopolo), en sautant /main/:
 *
 * A. Résolution Cloudflare → GET widget (PHPSESSID, sans POST token)
 *    → getservices/ → getagendas/ → datetime/
 * B. Résolution Cloudflare → GET widget + POST token
 *    → getservices/ → getagendas/ → datetime/
 *
 * Les deux variantes ont des sessions PHP isolées et partagent le même proxy
 * sticky et le même clearance Cloudflare. Aucun endpoint de réservation n'est appelé.
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/scripts/test-saopolo-skip-agenda.ts
 */

import "dotenv/config";
import { Impit } from "impit";
import {
  SAOPOLO_DEFAULT_SERVICE_ID,
  SAOPOLO_PORTAL_URL,
  SAOPOLO_WIDGET_KEY,
} from "../spain-portals.js";

type CookieJar = Record<string, string>;
type ImpitClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};
type BookititParams = {
  serviceId?: string;
  agendaId?: string;
  start?: string;
  end?: string;
};
type ServiceOption = {
  id: string;
  name: string;
};
type VariantResult = {
  name: string;
  downstreamOk: boolean;
  serviceListOk: boolean;
  durationMs: number;
  serviceName?: string;
  serviceId?: string;
  agendaCount?: number;
  datetimeCalls: number;
  validDatetimeResponses: number;
  freeTimes?: number;
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

const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PORTAL_URL = SAOPOLO_PORTAL_URL.split("#")[0];
const PORTAL_ORIGIN = new URL(PORTAL_URL).origin;
const BOOKITIT_BASE = `${PORTAL_ORIGIN}/onlinebookings`;
const PORTAL_PROXY_URL =
  process.env.SPAIN_RESIDENTIAL_PROXY_URL ??
  process.env.SPAIN_ISP_PROXY_URL ??
  "";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const DATETIME_MONTHS = 3;
const MAX_AGENDAS_TO_TEST = 3;
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
  if (value.length === 0) return null;
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

function findList(payload: unknown, ...keys: string[]): unknown[] {
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function parseServices(payload: unknown): ServiceOption[] {
  return findList(payload, "Services", "services")
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const id = String(record.id ?? record.serviceId ?? record.ServiceId ?? "");
      const name = String(record.name ?? record.serviceName ?? record.Name ?? "");
      return id ? { id, name: name.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() } : null;
    })
    .filter((service): service is ServiceOption => service !== null);
}

function chooseService(services: ServiceOption[]): ServiceOption | null {
  return (
    services.find((service) => /visa|visado|visados|tramita/i.test(service.name)) ??
    services.find((service) => service.id === SAOPOLO_DEFAULT_SERVICE_ID) ??
    services[0] ??
    null
  );
}

function getAgendaList(payload: unknown): Array<Record<string, unknown>> {
  return findList(payload, "Agendas", "agendas")
    .map(asRecord)
    .filter((agenda): agenda is Record<string, unknown> => agenda !== null);
}

function getAgendaId(agenda: Record<string, unknown>): string {
  return String(agenda.id ?? agenda.agendaId ?? agenda.AgendaId ?? "");
}

function monthRanges(): Array<{ start: string; end: string }> {
  const now = new Date();
  const ranges: Array<{ start: string; end: string }> = [];
  for (let offset = 0; offset < DATETIME_MONTHS; offset += 1) {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
    const start =
      offset === 0
        ? now.toISOString().slice(0, 10)
        : first.toISOString().slice(0, 10);
    ranges.push({ start, end: last.toISOString().slice(0, 10) });
  }
  return ranges;
}

function makeBookititUrl(
  endpoint: string,
  callback: string,
  requestCounter: number,
  params: BookititParams = {},
): string {
  const query = new URLSearchParams();
  query.set("callback", callback);
  query.set("type", "default");
  query.set("publickey", SAOPOLO_WIDGET_KEY);
  query.set("lang", "es");
  if (params.serviceId) query.append("services[]", params.serviceId);
  if (params.agendaId) query.append("agendas[]", params.agendaId);
  query.set("version", "4");
  query.set("src", PORTAL_URL);
  query.set("srvsrc", PORTAL_ORIGIN);
  if (params.start) query.set("start", params.start);
  if (params.end) query.set("end", params.end);
  if (params.serviceId || params.agendaId) query.set("selectedPeople", "1");
  query.set("_", String(requestCounter));
  return `${BOOKITIT_BASE}/${endpoint}?${query.toString()}`;
}

function createImpit(proxyUrl: string): ImpitClient {
  return new Impit({ browser: "chrome", proxyUrl } as never) as unknown as ImpitClient;
}

async function getProxy(): Promise<string> {
  if (PORTAL_PROXY_URL) return PORTAL_PROXY_URL;
  try {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const csvPath = path.resolve(import.meta.dirname ?? ".", "..", "..", "decodo-proxies.csv");
    const firstLine = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  } catch {
    // Fall through to an explicit configuration error.
  }
  throw new Error("Aucun proxy Saopolo configuré (SPAIN_RESIDENTIAL_PROXY_URL ou fichier de pool).");
}

function stickyProxyUrl(proxyUrl: string): string {
  try {
    const proxy = new URL(proxyUrl);
    const username = decodeURIComponent(proxy.username);
    const stickyId = Math.random().toString(36).slice(2, 10);
    if (username.includes("-session-")) {
      proxy.username = encodeURIComponent(username.replace(/-session-[^-]+/, `-session-${stickyId}`));
    } else if (username.includes("sessionduration")) {
      proxy.username = encodeURIComponent(username.replace(/-sessionduration-[^-]+/, `-session-${stickyId}`));
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

async function resolveCloudflare(proxyUrl: string): Promise<CookieJar> {
  section("Résolution Cloudflare");
  const impit = createImpit(proxyUrl);
  const response = await impit.fetch(PORTAL_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await response.text();
  const cookies = extractSetCookies(response.headers);
  const challenged = response.status === 403 || /Just a moment|cf-chl-/i.test(html);

  if (!challenged) {
    log(`Pas de challenge à résoudre (HTTP ${response.status}); cookies CF réutilisables: ${
      Object.keys(cookies).some((name) => name === "cf_clearance") ? "oui" : "non"
    }`);
    return Object.fromEntries(
      Object.entries(cookies).filter(([name]) => name.startsWith("cf_") || name.startsWith("__cf")),
    );
  }

  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY manquant.");
  log(`Challenge détecté (HTTP ${response.status}, ${html.length} caractères); résolution lancée.`);

  const createResponse = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_API_KEY,
      task: {
        type: "AntiCloudflareTask",
        websiteURL: PORTAL_URL,
        userAgent: USER_AGENT,
        html,
        proxy: capSolverProxyFormat(proxyUrl),
      },
      }),
  });
  const task = (await createResponse.json()) as SolverTaskResponse;
  if (!createResponse.ok || task.errorId || !task.taskId) {
    throw new Error(`CapSolver createTask a échoué (${task.errorCode ?? createResponse.status}).`);
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
    if (result.status === "ready") {
      clearance =
        result.solution?.cookies?.cf_clearance ??
        result.solution?.token ??
        "";
      break;
    }
    if (result.status === "failed") {
      throw new Error(`CapSolver a échoué (${result.errorCode ?? "tâche refusée"}).`);
    }
  }
  if (!clearance) throw new Error("Délai dépassé pendant la résolution Cloudflare.");

  cookies.cf_clearance = clearance;
  log("Résolution terminée; aucun jeton ni cookie n'est affiché.");
  return Object.fromEntries(
    Object.entries(cookies).filter(([name]) => name.startsWith("cf_") || name.startsWith("__cf")),
  );
}

type VariantSession = {
  client: ImpitClient;
  jar: CookieJar;
  callback: string;
  requestCounter: number;
};

async function startVariantSession(
  name: string,
  postToken: boolean,
  proxyUrl: string,
  cfCookies: CookieJar,
): Promise<VariantSession> {
  section(`${name} — ${postToken ? "GET widget + POST token" : "GET widget, sans POST token"}`);
  const client = createImpit(proxyUrl);
  const jar: CookieJar = { ...cfCookies };
  const getResponse = await client.fetch(PORTAL_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,*/*;q=0.8",
      "Accept-Language": "es-ES,es;q=0.9",
      Cookie: cookieHeader(jar),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const html = await getResponse.text();
  Object.assign(jar, extractSetCookies(getResponse.headers));
  const token = html.match(/name=["']token["']\s+value=["']([^"']+)["']/i)?.[1] ?? "";
  log(`GET widget → HTTP ${getResponse.status}, ${html.length}B; PHPSESSID=${Boolean(jar.PHPSESSID)}; formulaire=${Boolean(token)}`);

  if (!jar.PHPSESSID) {
    throw new Error(`${name}: le GET widget n'a pas créé de PHPSESSID.`);
  }
  if (postToken) {
    if (!token) throw new Error(`${name}: le formulaire ne contient pas de token.`);
    const postResponse = await client.fetch(PORTAL_URL, {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader(jar),
        Referer: PORTAL_URL,
        Origin: PORTAL_ORIGIN,
      },
      body: `token=${encodeURIComponent(token)}`,
      signal: AbortSignal.timeout(30_000),
    });
    await postResponse.text();
    Object.assign(jar, extractSetCookies(postResponse.headers));
    log(`POST token → HTTP ${postResponse.status}; PHPSESSID=${Boolean(jar.PHPSESSID)}`);
  } else {
    log("POST token ignoré; /main/ ignoré.");
  }

  return {
    client,
    jar,
    callback: `jQuery21109${Date.now()}_${Math.floor(Math.random() * 1e9)}`,
    requestCounter: Date.now(),
  };
}

async function callBookitit(
  session: VariantSession,
  endpoint: string,
  params: BookititParams = {},
): Promise<{ status: number; body: string; durationMs: number }> {
  session.requestCounter += 1;
  const url = makeBookititUrl(endpoint, session.callback, session.requestCounter, params);
  const started = Date.now();
  const response = await session.client.fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/javascript, application/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Dest": "empty",
      "Sec-Ch-Ua": '"Not;A=Brand";v="8", "Chromium";v="151"',
      "Sec-Ch-Ua-Platform": '"Windows"',
      "Sec-Ch-Ua-Mobile": "?0",
      Referer: PORTAL_URL,
      Cookie: cookieHeader(session.jar),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  Object.assign(session.jar, extractSetCookies(response.headers));
  return { status: response.status, body, durationMs: Date.now() - started };
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
    const times = asRecord(day.times);
    if (!times) continue;
    for (const time of Object.values(times)) {
      const record = asRecord(time);
      if (Number(record?.freeSlots ?? 0) > 0) freeTimes += 1;
    }
  }
  return { openDays, freeTimes };
}

async function runVariant(
  name: string,
  postToken: boolean,
  proxyUrl: string,
  cfCookies: CookieJar,
): Promise<VariantResult> {
  const started = Date.now();
  try {
    const session = await startVariantSession(name, postToken, proxyUrl, cfCookies);
    const serviceResponse = await callBookitit(session, "getservices/");
    const servicePayload = parseJsonp(serviceResponse.body);
    const services = parseServices(servicePayload);
    const serviceFromResponse = chooseService(services);
    const serviceListOk =
      serviceFromResponse !== null &&
      serviceResponse.status === 200 &&
      serviceResponse.body.length > 0;
    const service = serviceFromResponse ?? {
      id: SAOPOLO_DEFAULT_SERVICE_ID,
      name: "(ID Saopolo connu — repli de diagnostic)",
    };
    log(`${name} getservices/ → HTTP ${serviceResponse.status}, ${serviceResponse.body.length}B, ${services.length} service(s), ${(serviceResponse.durationMs / 1000).toFixed(2)}s`);
    if (!serviceFromResponse) {
      log(`${name} getservices/ sans service exploitable; poursuite du test avec l'ID connu ${service.id}.`);
    }
    log(`${name} service choisi → ${service.name || "(nom vide)"} [${service.id}]`);

    const agendaResponse = await callBookitit(session, "getagendas/", {
      serviceId: service.id,
    });
    const agendaPayload = parseJsonp(agendaResponse.body);
    const agendas = getAgendaList(agendaPayload)
      .map(getAgendaId)
      .filter(Boolean)
      .slice(0, MAX_AGENDAS_TO_TEST);
    log(`${name} getagendas/ → HTTP ${agendaResponse.status}, ${agendaResponse.body.length}B, ${agendas.length} agenda(s), ${(agendaResponse.durationMs / 1000).toFixed(2)}s`);

    const agendaTargets = agendas.length > 0 ? agendas : [""];
    let freeTimes = 0;
    let openDays = 0;
    let datetimeCalls = 0;
    let validDatetimeResponses = 0;
    for (const agendaId of agendaTargets) {
      for (const range of monthRanges()) {
        const datetimeResponse = await callBookitit(session, "datetime/", {
          serviceId: service.id,
          agendaId: agendaId || undefined,
          start: range.start,
          end: range.end,
        });
        const datetimePayload = parseJsonp(datetimeResponse.body);
        datetimeCalls += 1;
        if (
          datetimeResponse.status === 200 &&
          datetimeResponse.body.length > 0 &&
          datetimePayload !== null
        ) {
          validDatetimeResponses += 1;
        }
        const counts = countAvailableTimes(datetimePayload);
        freeTimes += counts.freeTimes;
        openDays += counts.openDays;
        log(
          `${name} datetime/ ${range.start}→${range.end} → HTTP ${datetimeResponse.status}, ` +
            `${datetimeResponse.body.length}B, ${counts.openDays} jour(s) ouvert(s), ` +
            `${counts.freeTimes} horaire(s) libre(s), ${(datetimeResponse.durationMs / 1000).toFixed(2)}s`,
        );
      }
    }

    return {
      name,
      downstreamOk:
        agendaResponse.status === 200 &&
        agendaResponse.body.length > 0 &&
        validDatetimeResponses > 0,
      serviceListOk,
      durationMs: Date.now() - started,
      serviceName: service.name,
      serviceId: service.id,
      agendaCount: agendas.length,
      datetimeCalls,
      validDatetimeResponses,
      freeTimes,
      warning:
        !serviceFromResponse
          ? "getservices/ n'a fourni aucun service; les étapes suivantes utilisent l'ID de diagnostic connu."
          : serviceResponse.status !== 200 || agendaResponse.status !== 200
            ? "Une étape service/agenda a répondu avec un statut inattendu."
            : undefined,
    };
  } catch (error) {
    const message = sanitizeError(
      error instanceof Error ? error.message : "Erreur inconnue.",
    );
    log(`${name} interrompu: ${message}`);
    return {
      name,
      downstreamOk: false,
      serviceListOk: false,
      durationMs: Date.now() - started,
      datetimeCalls: 0,
      validDatetimeResponses: 0,
      warning: message,
    };
  }
}

async function main(): Promise<void> {
  section("Saopolo — comparaison des deux flux sans /main/ ni réservation");
  if (!CAPSOLVER_API_KEY) throw new Error("CAPSOLVER_API_KEY manquant.");

  const proxyUrl = stickyProxyUrl(await getProxy());
  log(`Portail: São Paulo | proxy: ${maskProxy(proxyUrl)}`);

  const cfCookies = await resolveCloudflare(proxyUrl);
  const results = [
    await runVariant("A", false, proxyUrl, cfCookies),
    await runVariant("B", true, proxyUrl, cfCookies),
  ];

  section("Comparaison");
  for (const result of results) {
    log(
      `${result.name}: ${result.downstreamOk ? "agenda/datetime OK" : "échec aval"} | ` +
        `getservices=${result.serviceListOk ? "OK" : "vide"} | ` +
        `${(result.durationMs / 1000).toFixed(2)}s | ` +
        `service=${result.serviceId ?? "—"} | agendas=${result.agendaCount ?? 0} | ` +
        `datetime JSONP=${result.validDatetimeResponses}/${result.datetimeCalls} | ` +
        `horaires libres=${result.freeTimes ?? 0}` +
        (result.warning ? ` | ${result.warning}` : ""),
    );
  }
  log("Réservation: aucune. Endpoint /main/: non appelé.");
}

main().catch((error: unknown) => {
  const message = sanitizeError(
    error instanceof Error ? error.message : "Erreur inconnue.",
  );
  console.error(`[saopolo-flow-test] Arrêt: ${message}`);
  process.exitCode = 1;
});