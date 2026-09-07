/**
 * Compare l'ancien et le nouveau parsing sur les vrais Set-Cookie des portails.
 *
 * Le test ne logue jamais les valeurs de cookies. Il affiche uniquement :
 * - noms de cookies ;
 * - longueurs ;
 * - présence de virgule / %2C / double encodage ;
 * - empreinte SHA-256 tronquée pour comparer deux étapes sans révéler la valeur.
 *
 * Usage :
 *   pnpm spain:test:cookie-parser
 *
 * Variables optionnelles :
 *   COOKIE_TEST_CYCLES=3
 *   COOKIE_TEST_SKIP_CYCLES=1
 *   COOKIE_TEST_PORTAL=saopolo|kinshasa
 */
import "dotenv/config";

import { createHash } from "node:crypto";
import {
  initDecodoPool,
  getDecodoPoolSize,
  getDecodoProxyForIndex,
} from "../spain-decodo-pool.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import {
  initWorkerSession,
  type SetCookieTrace,
  type SpainCfSession,
} from "../spain-soax-solver.js";
import {
  initPhpState,
  type SpainDossierConfig,
} from "../spain-dossier-worker.js";
import {
  buildDynamicSession,
  makeDirectHeaders,
  makeDirectUrl,
  type DynamicSession,
} from "../spain-bookitit-direct.js";
import { parseSetCookies } from "../spain-cookie-parser.js";
import { KINSHASA_PORTAL_URL, SAOPOLO_PORTAL_URL } from "../spain-portals.js";

type CookieMap = Record<string, string>;

const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
const CYCLES = Math.max(1, Number(process.env.COOKIE_TEST_CYCLES ?? "3") || 3);
const SKIP_CYCLES = process.env.COOKIE_TEST_SKIP_CYCLES === "1";
const SELECTED_PORTAL = (process.env.COOKIE_TEST_PORTAL ?? "both").toLowerCase();

const PORTALS = [
  { name: "Saopolo", url: SAOPOLO_PORTAL_URL, proxyIndex: 0 },
  { name: "Kinshasa", url: KINSHASA_PORTAL_URL, proxyIndex: 1 },
].filter(({ name }) =>
  SELECTED_PORTAL === "both" ||
  (SELECTED_PORTAL === "saopolo" && name === "Saopolo") ||
  (SELECTED_PORTAL === "kinshasa" && name === "Kinshasa"),
);

function addStickySession(url: string, sid: string): string {
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch {
    return url;
  }
}

function proxyForIndex(index: number): string {
  const poolSize = getDecodoPoolSize();
  if (poolSize > 0) return getDecodoProxyForIndex(index % poolSize) ?? "";
  return process.env.DECODO_PROXY_URL ?? process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "";
}

/**
 * Reproduction exacte de l'ancien parser avant spain-cookie-parser.ts.
 * Il séparait sur toute virgule suivie d'un caractère non-espace.
 */
function legacyParseSetCookies(raw: string): CookieMap {
  const result: CookieMap = {};
  for (const part of raw.split(/,(?=[^ ])/)) {
    const match = part.trim().match(/^([^=;]+)=([^;]*)/);
    if (match) result[match[1].trim()] = match[2];
  }
  return result;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function describeValue(value: string | undefined): string {
  if (value === undefined) return "ABSENT";
  const literalCommas = (value.match(/,/g) ?? []).length;
  const encodedCommas = (value.match(/%2c/gi) ?? []).length;
  const doubleEncodedCommas = (value.match(/%252c/gi) ?? []).length;
  return [
    `len=${value.length}`,
    `sha=${fingerprint(value)}`,
    `literalComma=${literalCommas}`,
    `%2C=${encodedCommas}`,
    `%252C=${doubleEncodedCommas}`,
  ].join(" ");
}

function summarizeMap(map: CookieMap): string {
  const names = Object.keys(map);
  return names.length ? names.join(", ") : "(aucun)";
}

function compareMaps(label: string, oldMap: CookieMap, newMap: CookieMap): number {
  const names = [...new Set([...Object.keys(oldMap), ...Object.keys(newMap)])].sort();
  let differences = 0;

  for (const name of names) {
    const oldValue = oldMap[name];
    const newValue = newMap[name];
    const same = oldValue === newValue;
    if (!same) differences++;
    console.log(
      `    ${same ? "OK" : "DIFF"} ${label} ${name} | ancien: ${describeValue(oldValue)} | nouveau: ${describeValue(newValue)}`,
    );
  }
  if (names.length === 0) console.log(`    INFO ${label}: aucun cookie dans ce header`);
  return differences;
}

function mergeParsedValues(values: string[]): CookieMap {
  const result: CookieMap = {};
  for (const value of values) Object.assign(result, parseSetCookies(value));
  return result;
}

function compareTrace(trace: SetCookieTrace): number {
  const raw = trace.raw;
  const oldMap = legacyParseSetCookies(raw);
  const newMap = parseSetCookies(raw);

  console.log(
    `  [${trace.phase}] rawLen=${raw.length} ` +
    `headersArray=${trace.values.length} ` +
    `ancien=[${summarizeMap(oldMap)}] nouveau=[${summarizeMap(newMap)}]`,
  );

  let differences = compareMaps(trace.phase, oldMap, newMap);

  // Certains runtimes exposent les headers séparément via getSetCookie().
  // Cette comparaison vérifie le résultat sans dépendre du format fusionné de get().
  if (trace.values.length > 0) {
    const arrayMap = mergeParsedValues(trace.values);
    const rawNames = Object.keys(newMap).sort().join(",");
    const arrayNames = Object.keys(arrayMap).sort().join(",");
    if (rawNames !== arrayNames) {
      differences++;
      console.log(`    DIFF ${trace.phase} get() vs getSetCookie(): noms différents`);
      console.log(`      get(): [${rawNames || "aucun"}]`);
      console.log(`      getSetCookie(): [${arrayNames || "aucun"}]`);
    }
  }
  return differences;
}

function cookieMapFromSession(session: SpainCfSession): CookieMap {
  return Object.fromEntries(session.allCookies.map(({ name, value }) => [name, value]));
}

function requestCookieMap(ds: DynamicSession): CookieMap {
  const cookie = makeDirectHeaders(ds).Cookie ?? "";
  const map: CookieMap = {};
  for (const part of cookie.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator > 0) map[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return map;
}

function compareCookieMaps(label: string, before: CookieMap, after: CookieMap): number {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let differences = 0;
  for (const name of names) {
    const same = before[name] === after[name];
    if (!same) differences++;
    console.log(
      `    ${same ? "STABLE" : "CHANGED"} ${label} ${name} | avant: ${describeValue(before[name])} | après: ${describeValue(after[name])}`,
    );
  }
  return differences;
}

async function runCycle(ds: DynamicSession, serviceId: string, agendaId: string, cycle: number): Promise<SetCookieTrace> {
  const now = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const end = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
  const extra: Record<string, string> = {
    "services[]": serviceId,
    start,
    end,
    selectedPeople: "1",
  };
  if (agendaId) extra["agendas[]"] = agendaId;

  const before = requestCookieMap(ds);
  const url = makeDirectUrl(ds, "datetime/", extra);
  const res = await (ds.impit.fetch(url, { headers: makeDirectHeaders(ds) } as any) as unknown as Promise<Response>);
  const body = await res.text();
  const raw = (res.headers as any).get?.("set-cookie") ?? "";
  const values = typeof (res.headers as any).getSetCookie === "function"
    ? ((res.headers as any).getSetCookie() as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const after = requestCookieMap(ds);

  console.log(`  cycle=${cycle} datetime/ HTTP=${res.status} body=${body.length}B Set-Cookie=${raw.length ? "oui" : "non"}`);
  const changed = compareCookieMaps(`cycle-${cycle}`, before, after);
  if (changed > 0) {
    console.log(`    ALERTE: le header Cookie client a changé pendant le cycle ${cycle}`);
  }
  return { phase: `datetime-cycle-${cycle}`, raw, values };
}

async function testPortal(portal: typeof PORTALS[number]): Promise<number> {
  console.log(`\n${"=".repeat(78)}\nPORTAIL ${portal.name}\n${"=".repeat(78)}`);
  const baseProxy = proxyForIndex(portal.proxyIndex);
  if (!baseProxy) {
    console.error("  ❌ Aucun proxy Decodo configuré");
    return 1;
  }
  if (!CAPSOLVER_KEY) {
    console.error("  ❌ CAPSOLVER_API_KEY manquante");
    return 1;
  }

  const traces: SetCookieTrace[] = [];
  const stickyProxy = addStickySession(baseProxy, `cookie-test-${portal.name.toLowerCase()}-${Date.now()}`);
  const result = await initWorkerSession(
    stickyProxy,
    portal.url.split("#")[0],
    CAPSOLVER_KEY,
    (trace) => traces.push(trace),
  );
  if (!result) {
    console.error("  ❌ initWorkerSession échoué");
    return 1;
  }

  let differences = 0;
  console.log(`\n  Comparaison ancien parser / nouveau parser (${traces.length} réponses)`);
  for (const trace of traces) differences += compareTrace(trace);

  const sessionMap = cookieMapFromSession(result.session);
  console.log(`\n  Cookies finaux de session : [${summarizeMap(sessionMap)}]`);
  for (const [name, value] of Object.entries(sessionMap)) {
    console.log(`    SESSION ${name} | ${describeValue(value)}`);
  }

  if (!SKIP_CYCLES) {
    const config: SpainDossierConfig = {
      id: `cookie-parser-${portal.name.toLowerCase()}`,
      applicantName: "COOKIE_PARSER_TEST",
      visaType: "visa",
      login: "",
      password: "",
      applicationId: `cookie-parser-${portal.name.toLowerCase()}`,
      otpChannel: "manual",
      portalUrl: portal.url,
    };
    const phpState = await initPhpState(result.session, config, `[COOKIE-${portal.name}]`);
    if (!phpState) {
      console.log("  ⚠️ initPhpState échoué : comparaison inter-cycles ignorée");
    } else {
      const beforeCycles = requestCookieMap(phpState.ds);
      console.log(`\n  Vérification stabilité sur ${CYCLES} cycle(s) datetime/ sans booking`);
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        const trace = await runCycle(phpState.ds, phpState.bestServiceId, phpState.agendaId, cycle);
        differences += compareTrace(trace);
      }
      differences += compareCookieMaps("session globale", beforeCycles, requestCookieMap(phpState.ds));
    }
  }

  console.log(
    differences === 0
      ? `\n  ✅ ${portal.name}: ancien et nouveau parser donnent le même résultat ; cookies stables sur les cycles testés.`
      : `\n  ❌ ${portal.name}: ${differences} différence(s) détectée(s) entre les parsers ou pendant les cycles.`,
  );
  return differences > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  console.log("=== TEST COMPARATIF PARSER COOKIES SAOPOLO / KINSHASA ===");
  console.log(`Portails: ${PORTALS.map((p) => p.name).join(", ") || "aucun"}`);
  console.log(`Cycles datetime/: ${SKIP_CYCLES ? "désactivés" : CYCLES}`);
  await initSpainRedis();
  await initDecodoPool();

  let failures = 0;
  for (const portal of PORTALS) {
    try {
      failures += await testPortal(portal);
    } catch (error) {
      failures++;
      console.error(`  ❌ ${portal.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("💥 Test interrompu:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});