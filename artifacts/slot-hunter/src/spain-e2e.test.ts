/**
 * spain-e2e.test.ts — Tests end-to-end du flux Spain Watcher
 *
 * Simule le trafic serveur réel (challenge CF, /main/ Bookitit, APIs JSONP)
 * pour valider le comportement attendu du scanner + booking — sans infra réelle.
 *
 * Scénarios couverts :
 *   1. Fonctions de parsing HTML (pures — zéro réseau)
 *   2. Parsing JSONP
 *   3. Détection CF interactive
 *   4. Scanner probe — no hay horas VISIBLE → not_found
 *   5. Scanner probe — HTML court → error
 *   6. Scanner probe — landmark absent → error
 *   7. Scanner probe — session CF indisponible → cf_blocked
 *   8. Scanner probe — no hay horas CACHÉ + services + datetime positif → found
 *   9. Scanner probe — no hay horas CACHÉ + services + datetime vide → not_found
 *  10. Booking — happy path complet (getagendas → datetime → signin → summary)
 *  11. Booking — createIsolatedBookingSession 5xx×3 → booking_failed
 *  12. Booking — createIsolatedBookingSession 5xx puis succès au 3e retry
 *  13. Booking — aucun service dans le HTML → no_slots
 *  14. Booking — targetServiceId introuvable → no_slots
 *  15. Booking — mauvais credentials → signin_failed
 *  16. Booking — OTP requis + pas d'applicationId → otp_timeout
 *  17. Booking — captcha=1 + CAPSOLVER_API_KEY absent → turnstile_failed
 *  18. Booking — summary avec erreurs serveur → booking_failed
 *  19. Booking — datetime vide sur tous les mois → no_slots
 *  20. Watcher loop — comportement face à 5xx répétés sur /main/ (session CF conservée)
 *
 * Usage : cd artifacts/slot-hunter && npx tsx src/spain-e2e.test.ts
 */

import {
  _setTestFetch,
  type SpainCfSession,
} from "./spain-soax-solver.js";
import {
  _setTestSessionProvider,
  scanSpainHttp,
  isCloudflareInteractiveChallenge,
} from "./spain-http-scanner.js";
import {
  extractServicesFromHtml,
  executeHttpBooking,
  createIsolatedBookingSession,
  type SpainBookingConfig,
} from "./spain-http-booking.js";

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ❌ FAIL: ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(
    actual === expected,
    `${label} — attendu: ${JSON.stringify(expected)}, reçu: ${JSON.stringify(actual)}`,
  );
}

function section(title: string): void {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(70)}`);
}

function subsection(title: string): void {
  console.log(`\n  ── ${title}`);
}

// ─── HTML Fixtures ────────────────────────────────────────────────────────────

const PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";

/** Padding to pass the length > 1 000 char guard in the scanner. */
const PAD = `<!-- ${"x".repeat(1_200)} -->`;

/** Landmark IDs expected by the scanner. */
const LANDMARKS = `<div id="idBktWidgetDefaultBodyContainer"><div id="idDivBktServicesContainer">`;
const CLOSE = `</div></div>`;

// ① "No hay horas" VISIBLE — direct not_found, aucun appel API
const HTML_NO_SLOTS_VISIBLE = [
  `<html><body>`,
  LANDMARKS,
  `  <div style='text-align: center; padding: 20px;'>No hay horas disponibles</div>`,
  CLOSE,
  `</body></html>`,
  PAD,
].join("\n");

// ② "No hay horas" HIDDEN + services rendus — nécessite appel datetime/ pour confirmer
const HTML_SLOTS_HIDDEN_WITH_SERVICES = [
  `<html><body>`,
  LANDMARKS,
  `  <div style='display: none; text-align: center;'>No hay horas disponibles</div>`,
  `  <a href='#selectservice/bkt1181774'>`,
  `    <div class="clsBktServiceDataContainer">`,
  `      <div class="clsBktServiceDataName">Tramitación de visas (Kinshasa)</div>`,
  `    </div>`,
  `  </a>`,
  `  <a href='#selectservice/bkt9876543'>`,
  `    <div class="clsBktServiceDataContainer">`,
  `      <div class="clsBktServiceDataName">Legalización de documentos</div>`,
  `    </div>`,
  `  </a>`,
  CLOSE,
  `</body></html>`,
  PAD,
].join("\n");

// ③ HTML court — déclenche l'erreur "réponse courte"
const HTML_SHORT = `<div id="idBktWidgetDefaultBodyContainer"><p>Erreur</p></div>`;

// ④ HTML long sans landmark Bookitit — déclenche l'erreur "structure inattendue"
const HTML_NO_LANDMARK = `<html><body><div id="someOtherDiv">${"<!-- " + "y".repeat(1_300) + " -->"}</div></body></html>`;

// ⑤ CF challenge (corps d'interstitiel CF)
const HTML_CF_CHALLENGE =
  `<html><head><title>Just a moment...</title></head><body>` +
  `verifying you are human` +
  `${"<!-- " + "z".repeat(1_200) + " -->"}` +
  `</body></html>`;

// ⑥ HTML avec services — utilisé pour les tests booking
const HTML_MAIN_WITH_SERVICE = [
  `<html><body>`,
  LANDMARKS,
  `  <div style='display: none;'>No hay horas disponibles</div>`,
  `  <a href='#selectservice/bkt1181774'>`,
  `    <div class="clsBktServiceDataContainer">`,
  `      <div class="clsBktServiceDataName">Tramitación de visas (Kinshasa)</div>`,
  `    </div>`,
  `  </a>`,
  CLOSE,
  `</body></html>`,
  PAD,
].join("\n");

// ─── Mock Session factory ────────────────────────────────────────────────────

function makeMockSession(overrides: Partial<SpainCfSession> = {}): SpainCfSession {
  return {
    cfClearance: "mock_cf_clearance_abc123def456",
    cfDomain: ".citaconsular.es",
    soaxProxyUrl: "",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
      " (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    createdAt: Date.now(),
    expiresAt: Date.now() + 2 * 60 * 60 * 1_000,
    allCookies: [
      { name: "PHPSESSID", value: "testsession12345" },
      { name: "_ga", value: "GA1.1.123456789.1700000000" },
      { name: "_ga_F3TYSDL945", value: "GS2.1.s1700000000$o1$g0$t1700000000$j60$l0$h0" },
    ],
    extraHeaders: {},
    source: "playwright",
    ...overrides,
  };
}

// ─── Mock Response helpers ───────────────────────────────────────────────────

/** Build a JSONP Response (Status 200). */
function jsonpResp(payload: unknown): Response {
  // The scanner/booking code extracts the callback name dynamically (cbXXX...),
  // but parseJsonpPayload falls back to JSON.parse when the wrapper doesn't match.
  // Using a fixed prefix is safe.
  return new Response(`cb_test(${JSON.stringify(payload)});`, {
    status: 200,
    headers: { "Content-Type": "application/javascript" },
  });
}

/** Build the /main/ response with a Set-Cookie PHPSESSID header. */
function mainResp(phpSessionId: string, body?: string): Response {
  // The scanner JSONP body is: cb_xxx("HTML...") — the booking code accepts plain HTML too.
  const respBody = body ?? JSON.stringify(HTML_MAIN_WITH_SERVICE);
  const h = new Headers({ "Content-Type": "application/javascript" });
  h.append("Set-Cookie", `PHPSESSID=${phpSessionId}; Path=/; HttpOnly`);
  return new Response(respBody, { status: 200, headers: h });
}

/** Plain error response. */
function errResp(status: number): Response {
  return new Response("Service Unavailable", { status });
}

// ─── JSONP Payload fixtures ──────────────────────────────────────────────────

const AGENDA_OK = { agendas: [{ idAgenda: "bkt456agenda" }] };
const AGENDA_EMPTY = { agendas: [] };

const DATETIME_WITH_SLOT = {
  Slots: [
    {
      date: "2026-09-15",
      agenda: "bkt456agenda",
      times: {
        "09:00": { freeSlots: 3, totalSlots: 5, time: "09:00" },
        "10:00": { freeSlots: 1, totalSlots: 5, time: "10:00" },
      },
    },
  ],
};
const DATETIME_EMPTY = { Slots: [] };

const WIDGET_CFG_NO_CAPTCHA = {
  WidgetConfiguration: { captcha: "0", registration_type: "2" },
};
const WIDGET_CFG_CAPTCHA_REQUIRED = {
  WidgetConfiguration: { captcha: "1", registration_type: "2" },
};

const SIGNIN_OK = {
  Client: { bktToken: "BKT_MOCK_TOKEN_HAPPY_PATH", email: "test@example.com" },
};
const SIGNIN_WITH_OTP = {
  Client: { bktToken: "BKT_OTP_TOKEN_XYZ", email: "test@example.com", validate: 1 },
  validate: 1,
};
const SIGNIN_BAD_CREDS = {
  Client: { errors: [{ message: "Contraseña incorrecta — credenciales inválidas" }] },
};

const SUMMARY_OK = [
  { Event: { locator: "JOVENTY2026ABC", state: 1, date: "2026-09-15", hour: "09:00" } },
];
const SUMMARY_WITH_ERRORS = {
  errors: [{ message: "Appointment slot no longer available" }],
};

// ─── Mock fetch router ───────────────────────────────────────────────────────

type UrlHandler = (url: string) => Response | null;

/**
 * Builds a mock fetch function from a list of URL pattern handlers.
 * Falls through to returning null (treated as network error) for unmatched URLs.
 * RUM beacons and JSD Oneshot are always silently ignored.
 */
function makeMockFetch(handlers: Array<[string | RegExp, () => Response | null]>): typeof _setTestFetch extends (fn: infer F) => void ? F : never {
  return async (url: string) => {
    // Always silently absorb fire-and-forget signals (RUM, JSD) — not under test
    if (url.includes("/cdn-cgi/rum") || url.includes("jsd/oneshot") || url.includes("/cdn-cgi/challenge")) {
      return new Response("", { status: 200 });
    }
    for (const [pattern, handler] of handlers) {
      const matches =
        typeof pattern === "string" ? url.includes(pattern) : pattern.test(url);
      if (matches) return handler();
    }
    // Unmatched URL — log and return null (simulates network failure)
    console.warn(`  [mock-fetch] Unmatched URL: ${url.replace("https://www.citaconsular.es", "")}`);
    return null;
  };
}

// ─── Cleanup helper ───────────────────────────────────────────────────────────

function resetMocks(): void {
  _setTestFetch(null);
  _setTestSessionProvider(null);
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Pure HTML parsing (zero network)
// ══════════════════════════════════════════════════════════════════════════════

section("1. Extraction de services HTML (pure, zéro réseau)");

subsection("1a. HTML avec services rendus");
{
  const services = extractServicesFromHtml(HTML_MAIN_WITH_SERVICE);
  assert(services.length === 1, "1 service extrait du HTML");
  assertEq(services[0]?.serviceId, "bkt1181774", "serviceId correct");
  assert(
    (services[0]?.serviceName ?? "").includes("Tramitación"),
    `serviceName contient "Tramitación" (got: "${services[0]?.serviceName}")`,
  );
}

subsection("1b. HTML avec 2 services");
{
  const services = extractServicesFromHtml(HTML_SLOTS_HIDDEN_WITH_SERVICES);
  assertEq(services.length, 2, "2 services extraits");
  assert(
    services.some((s) => s.serviceId === "bkt1181774"),
    "serviceId bkt1181774 présent",
  );
  assert(
    services.some((s) => s.serviceId === "bkt9876543"),
    "serviceId bkt9876543 présent",
  );
}

subsection("1c. HTML sans services");
{
  const services = extractServicesFromHtml(HTML_NO_SLOTS_VISIBLE);
  assertEq(services.length, 0, "0 services pour HTML sans créneaux");
}

subsection("1d. Templates Underscore.js exclus du parsing");
{
  // Template blocks should be stripped before service extraction
  const htmlWithTemplate = `
    ${LANDMARKS}
    <script type="text/template">
      <a href='#selectservice/<%= attributes.id %>'><div class="clsBktServiceDataName">TEMPLATE</div></a>
    </script>
    <a href='#selectservice/bkt_real_123'>
      <div class="clsBktServiceDataContainer">
        <div class="clsBktServiceDataName">Service Réel</div>
      </div>
    </a>
    ${CLOSE}${PAD}`;
  const services = extractServicesFromHtml(htmlWithTemplate);
  assert(
    services.every((s) => !s.serviceId.includes("<%")),
    "Aucun ID de template (<%) dans les services extraits",
  );
  assert(
    services.some((s) => s.serviceId === "bkt_real_123"),
    "Service réel bkt_real_123 présent",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — Détection CF interactive (pure)
// ══════════════════════════════════════════════════════════════════════════════

section("2. Détection CF interactive (pure)");

subsection("2a. Page CF challenge (HTTP 403 + texte CF)");
{
  assert(
    isCloudflareInteractiveChallenge(403, "Just a moment... verifying you are human"),
    "403 + texte CF → challenge détecté",
  );
}

subsection("2b. Page normale (HTTP 200)");
{
  assert(
    !isCloudflareInteractiveChallenge(200, HTML_MAIN_WITH_SERVICE),
    "HTTP 200 + HTML normal → pas de challenge",
  );
}

subsection("2c. HTTP 403 sans texte CF");
{
  assert(
    !isCloudflareInteractiveChallenge(403, "<html><body>Accès refusé</body></html>"),
    "403 sans texte CF → pas de challenge CF interactif",
  );
}

subsection("2d. Variantes du texte CF");
{
  assert(
    isCloudflareInteractiveChallenge(403, "un instant, vérification en cours…"),
    "Variante fr 'un instant' → challenge détecté",
  );
  assert(
    isCloudflareInteractiveChallenge(403, "challenge-platform cdn-cgi"),
    "challenge-platform dans le corps → challenge détecté",
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Scanner probe (réseau simulé via _setTestFetch + _setTestSessionProvider)
// ══════════════════════════════════════════════════════════════════════════════

section("3. Scanner probe — scénarios de détection");

subsection("3a. Session CF indisponible → cf_blocked");
{
  resetMocks();
  _setTestSessionProvider(async () => null);

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "cf_blocked", "status = cf_blocked quand session nulle");
  assert(
    (result.errorMessage ?? "").length > 0,
    "errorMessage non vide pour cf_blocked",
  );
  resetMocks();
}

subsection("3b. No hay horas VISIBLE → not_found (aucun appel API)");
{
  resetMocks();
  const session = makeMockSession({ prefetchedMainHtml: HTML_NO_SLOTS_VISIBLE });
  _setTestSessionProvider(async () => session);

  // No API calls expected — mock returns null for everything
  let apiCallCount = 0;
  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/rum") || url.includes("jsd/oneshot")) {
      return new Response("", { status: 200 });
    }
    if (url.includes("/onlinebookings/")) apiCallCount++;
    return null;
  });

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "not_found", "No hay horas visible → not_found");
  assertEq(apiCallCount, 0, "Zéro appel API Bookitit effectué (court-circuit direct)");
  resetMocks();
}

subsection("3c. HTML court (< 1 000 chars) → error");
{
  resetMocks();
  const session = makeMockSession({ prefetchedMainHtml: HTML_SHORT });
  _setTestSessionProvider(async () => session);
  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/rum")) return new Response("", { status: 200 });
    return null;
  });

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "error", "HTML court → error");
  assert(
    (result.errorMessage ?? "").includes("chars"),
    `Message d'erreur mentionne la longueur (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("3d. HTML sans landmark Bookitit → error");
{
  resetMocks();
  const session = makeMockSession({ prefetchedMainHtml: HTML_NO_LANDMARK });
  _setTestSessionProvider(async () => session);
  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/rum")) return new Response("", { status: 200 });
    return null;
  });

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "error", "HTML sans landmark → error");
  assert(
    (result.errorMessage ?? "").toLowerCase().includes("structure"),
    `Message d'erreur mentionne la structure (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("3e. No hay horas CACHÉ + services + datetime positif → found");
{
  resetMocks();
  const session = makeMockSession({ prefetchedMainHtml: HTML_SLOTS_HIDDEN_WITH_SERVICES });
  _setTestSessionProvider(async () => session);

  _setTestFetch(makeMockFetch([
    ["getagendas/", () => jsonpResp(AGENDA_OK)],
    ["datetime/",   () => jsonpResp(DATETIME_WITH_SLOT)],
    // getwidgetconfigurations and getservices may also be called — handle gracefully
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["getservices/", () => jsonpResp([{ id: "bkt1181774", name: "Tramitación de visas" }])],
  ]));

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "found", "No hay horas caché + services + datetime → found");
  assert(
    (result.slotInfo ?? "").length > 0 || result.status === "found",
    "slotInfo présent ou status=found",
  );
  resetMocks();
}

subsection("3f. No hay horas CACHÉ + services + datetime vide → not_found");
{
  resetMocks();
  const session = makeMockSession({ prefetchedMainHtml: HTML_SLOTS_HIDDEN_WITH_SERVICES });
  _setTestSessionProvider(async () => session);

  _setTestFetch(makeMockFetch([
    ["getagendas/",  () => jsonpResp(AGENDA_OK)],
    ["datetime/",    () => jsonpResp(DATETIME_EMPTY)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["getservices/", () => jsonpResp([{ id: "bkt1181774", name: "Tramitación de visas" }])],
  ]));

  const result = await scanSpainHttp(PORTAL_URL);
  assertEq(result.status, "not_found", "datetime vide → not_found");
  resetMocks();
}

subsection("3g. CF challenge dans le HTML de /main/ → error (corps non conforme)");
{
  resetMocks();
  // CF challenge body from prefetchedMainHtml — will fail the length/landmark check
  const session = makeMockSession({ prefetchedMainHtml: HTML_CF_CHALLENGE });
  _setTestSessionProvider(async () => session);
  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/")) return new Response("", { status: 200 });
    return null;
  });

  const result = await scanSpainHttp(PORTAL_URL);
  // CF challenge body has no widget landmarks → triggers "structure inattendue" error
  assert(
    result.status === "error" || result.status === "cf_blocked",
    `CF body dans /main/ → error ou cf_blocked (got: ${result.status})`,
  );
  resetMocks();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 — Booking flow (réseau simulé via _setTestFetch)
// ══════════════════════════════════════════════════════════════════════════════

section("4. Booking flow — flux HTTP complet simulé");

const BASE_BOOKING_CONFIG: SpainBookingConfig = {
  login: "AB123456",
  password: "PassTest2026",
  applicantName: "Jean Dupont",
  visaType: "Visa C — Tourisme",
  targetServiceId: "bkt1181774",
};

subsection("4a. Happy path complet (getagendas → datetime → signin → summary)");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    // createIsolatedBookingSession calls /main/
    ["/onlinebookings/main/",          () => mainResp("isolated_phpsessid_ok")],
    ["getagendas/",                    () => jsonpResp(AGENDA_OK)],
    ["datetime/",                      () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/",       () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["signin/",                        () => jsonpResp(SIGNIN_OK)],
    ["summary/",                       () => jsonpResp(SUMMARY_OK)],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "booked", "Happy path → status=booked");
  assertEq(result.locator, "JOVENTY2026ABC", "Locator extrait correctement");
  assert(result.durationMs > 0, "durationMs > 0");
  resetMocks();
}

subsection("4b. Aucun service dans le mainHtml → no_slots");
{
  resetMocks();
  const session = makeMockSession();
  _setTestFetch(async () => null);

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_NO_SLOTS_VISIBLE, {
    ...BASE_BOOKING_CONFIG,
    targetServiceId: undefined, // let it auto-detect
    visaType: undefined,
  });
  assertEq(result.status, "no_slots", "Pas de services dans HTML → no_slots");
  resetMocks();
}

subsection("4c. targetServiceId introuvable dans le HTML → no_slots");
{
  resetMocks();
  const session = makeMockSession();
  _setTestFetch(async () => null);

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, {
    ...BASE_BOOKING_CONFIG,
    targetServiceId: "bkt_DOES_NOT_EXIST",
  });
  assertEq(result.status, "no_slots", "targetServiceId inexistant → no_slots");
  assert(
    (result.errorMessage ?? "").includes("non trouvé"),
    `Message d'erreur mentionne "non trouvé" (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("4d. createIsolatedBookingSession — 5xx×3 retries, toutes échouent → booking_failed");
{
  resetMocks();
  const session = makeMockSession();
  let mainCallCount = 0;

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => {
      mainCallCount++;
      return errResp(503);
    }],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "booking_failed", "Tous les retries 503 → booking_failed");
  assert(mainCallCount >= 3, `Au moins 3 appels /main/ tentés (got: ${mainCallCount})`);
  assert(
    (result.errorMessage ?? "").toLowerCase().includes("session") ||
    (result.errorMessage ?? "").toLowerCase().includes("phpsessid") ||
    (result.errorMessage ?? "").toLowerCase().includes("isolée"),
    `Message mentionne l'échec de session (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("4e. createIsolatedBookingSession — 5xx×2 puis succès au 3e retry → booking continue");
{
  resetMocks();
  const session = makeMockSession();
  let mainCallCount = 0;

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => {
      mainCallCount++;
      if (mainCallCount <= 2) return errResp(503);   // First 2 attempts fail
      return mainResp("recovered_phpsessid_ok");       // 3rd attempt succeeds
    }],
    ["getagendas/",            () => jsonpResp(AGENDA_OK)],
    ["datetime/",              () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["signin/",                () => jsonpResp(SIGNIN_OK)],
    ["summary/",               () => jsonpResp(SUMMARY_OK)],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "booked", "Booking réussi après retry 5xx sur /main/");
  assert(mainCallCount >= 3, `3+ appels /main/ effectués (got: ${mainCallCount})`);
  resetMocks();
}

subsection("4f. Mauvais credentials (errors[] dans signin) → signin_failed");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/",    () => mainResp("phpsessid_bad_creds")],
    ["getagendas/",              () => jsonpResp(AGENDA_OK)],
    ["datetime/",                () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["signin/",                  () => jsonpResp(SIGNIN_BAD_CREDS)],
    ["signupfirstappointment/",  () => jsonpResp(SIGNIN_BAD_CREDS)],
    ["signup/",                  () => jsonpResp(SIGNIN_BAD_CREDS)],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "signin_failed", "Mauvais credentials → signin_failed");
  assert(
    (result.errorMessage ?? "").toLowerCase().includes("incorrecta") ||
    (result.errorMessage ?? "").toLowerCase().includes("auth"),
    `Message d'erreur contient l'erreur Bookitit (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("4g. OTP requis + pas d'applicationId → otp_timeout");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/",    () => mainResp("phpsessid_otp")],
    ["getagendas/",              () => jsonpResp(AGENDA_OK)],
    ["datetime/",                () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["signin/",                  () => jsonpResp(SIGNIN_WITH_OTP)],
  ]));

  // applicationId absent → le bot ne peut pas poller Convex → OTP timeout
  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, {
    ...BASE_BOOKING_CONFIG,
    applicationId: undefined,
  });
  assertEq(result.status, "otp_timeout", "OTP requis sans applicationId → otp_timeout");
  resetMocks();
}

subsection("4h. Captcha=1 sans CAPSOLVER_API_KEY → turnstile_failed");
{
  resetMocks();
  const origKey = process.env.CAPSOLVER_API_KEY;
  delete process.env.CAPSOLVER_API_KEY;

  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/",    () => mainResp("phpsessid_captcha")],
    ["getagendas/",              () => jsonpResp(AGENDA_OK)],
    ["datetime/",                () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_CAPTCHA_REQUIRED)],
    // hCaptcha solve would call CapSolver — with no API key it returns null → turnstile_failed
    [/api\.capsolver\.com/, () => new Response(
      JSON.stringify({ errorId: 0, taskId: "task_mock_123" }), { status: 200 }
    )],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "turnstile_failed", "captcha=1 sans clé CapSolver → turnstile_failed");

  // Restore env
  if (origKey !== undefined) process.env.CAPSOLVER_API_KEY = origKey;
  resetMocks();
}

subsection("4i. summary/ avec errors → booking_failed");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/",    () => mainResp("phpsessid_summary_err")],
    ["getagendas/",              () => jsonpResp(AGENDA_OK)],
    ["datetime/",                () => jsonpResp(DATETIME_WITH_SLOT)],
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
    ["signin/",                  () => jsonpResp(SIGNIN_OK)],
    ["summary/",                 () => jsonpResp(SUMMARY_WITH_ERRORS)],
  ]));

  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, BASE_BOOKING_CONFIG);
  assertEq(result.status, "booking_failed", "summary avec errors → booking_failed");
  assert(
    (result.errorMessage ?? "").toLowerCase().includes("summary"),
    `Message mentionne summary (got: "${result.errorMessage}")`,
  );
  resetMocks();
}

subsection("4j. datetime/ vide sur tous les mois → no_slots");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/",    () => mainResp("phpsessid_nodatetime")],
    ["getagendas/",              () => jsonpResp(AGENDA_OK)],
    ["datetime/",                () => jsonpResp(DATETIME_EMPTY)],  // All months empty
    ["getwidgetconfigurations/", () => jsonpResp(WIDGET_CFG_NO_CAPTCHA)],
  ]));

  // Use visaType matching to let the scanner pick the service from HTML
  const result = await executeHttpBooking(session, PORTAL_URL, HTML_MAIN_WITH_SERVICE, {
    login: "AB123456",
    password: "PassTest2026",
    visaType: "Tramitación de visas",
    targetServiceId: "bkt1181774",
  });
  assertEq(result.status, "no_slots", "datetime vide sur tous les mois → no_slots");
  resetMocks();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 5 — createIsolatedBookingSession (session isolée Bookitit)
// ══════════════════════════════════════════════════════════════════════════════

section("5. createIsolatedBookingSession — session PHP isolée par dossier");

subsection("5a. Succès — PHPSESSID fourni dans Set-Cookie");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => mainResp("new_isolated_phpsessid_777")],
  ]));

  const isolated = await createIsolatedBookingSession(session, PORTAL_URL);
  assert(isolated !== null, "createIsolatedBookingSession retourne un résultat non-null");
  if (isolated) {
    const newPhpSessId = isolated.session.allCookies.find((c) => c.name === "PHPSESSID")?.value;
    assertEq(newPhpSessId, "new_isolated_phpsessid_777", "PHPSESSID mis à jour dans la session isolée");
    // Original session's PHPSESSID must NOT be the new one (isolation)
    const origPhpSessId = session.allCookies.find((c) => c.name === "PHPSESSID")?.value;
    assert(origPhpSessId !== "new_isolated_phpsessid_777", "Session originale non modifiée (isolation)");
  }
  resetMocks();
}

subsection("5b. Réponse sans Set-Cookie PHPSESSID → null");
{
  resetMocks();
  const session = makeMockSession();

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => new Response("cb_main({})", {
      status: 200,
      headers: { "Content-Type": "application/javascript" },
      // No Set-Cookie header
    })],
  ]));

  const isolated = await createIsolatedBookingSession(session, PORTAL_URL);
  assert(isolated === null, "Sans PHPSESSID dans Set-Cookie → null (booking ne peut pas commencer)");
  resetMocks();
}

subsection("5c. /main/ retourne 5xx×3 → null");
{
  resetMocks();
  const session = makeMockSession();
  let callCount = 0;

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => {
      callCount++;
      return errResp(504);  // Gateway timeout à chaque appel
    }],
  ]));

  const isolated = await createIsolatedBookingSession(session, PORTAL_URL);
  assert(isolated === null, "5xx×3 retries → null");
  assert(callCount >= 3, `Au moins 3 tentatives /main/ (got: ${callCount})`);
  resetMocks();
}

subsection("5d. /main/ retourne 5xx puis 200 — session CF préservée");
{
  resetMocks();
  const session = makeMockSession();
  let callCount = 0;

  _setTestFetch(makeMockFetch([
    ["/onlinebookings/main/", () => {
      callCount++;
      if (callCount === 1) return errResp(503);
      if (callCount === 2) return errResp(502);
      return mainResp("phpsessid_after_retry");
    }],
  ]));

  const isolated = await createIsolatedBookingSession(session, PORTAL_URL);
  assert(isolated !== null, "Succès après 5xx transients → session créée");
  if (isolated) {
    const newId = isolated.session.allCookies.find((c) => c.name === "PHPSESSID")?.value;
    assertEq(newId, "phpsessid_after_retry", "PHPSESSID correct après retries");
  }
  assert(callCount === 3, `Exactement 3 appels /main/ (2 failures + 1 succès, got: ${callCount})`);
  resetMocks();
}

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Comportement boucle watcher face aux erreurs répétées
// ══════════════════════════════════════════════════════════════════════════════

section("6. Comportement boucle watcher — résilience aux erreurs serveur");

subsection("6a. Scanner — session CF null retournée par le provider → cf_blocked (pas de crash)");
{
  resetMocks();
  _setTestSessionProvider(async () => null);

  let threw = false;
  let status = "";
  try {
    const r = await scanSpainHttp(PORTAL_URL);
    status = r.status;
  } catch {
    threw = true;
  }

  assert(!threw, "scanSpainHttp ne lève pas d'exception quand session est null");
  assertEq(status as "cf_blocked", "cf_blocked", "status=cf_blocked, pas de crash");
  resetMocks();
}

subsection("6b. Scanner — erreur réseau sur /main/ (fetch retourne null) → error");
{
  resetMocks();
  const session = makeMockSession({
    prefetchedMainHtml: undefined,
    source: "capsolver", // No skipPortalFlow
    allCookies: [{ name: "_ga", value: "GA1.1.123.456" }],
  });
  _setTestSessionProvider(async () => session);

  // Mock returns null for all calls except RUM → simulates network timeout
  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/")) return new Response("", { status: 200 });
    return null;  // Network failure on portal + /main/
  });

  let threw = false;
  let status = "";
  try {
    const r = await scanSpainHttp(PORTAL_URL);
    status = r.status;
  } catch {
    threw = true;
  }

  assert(!threw, "scanSpainHttp ne lève pas d'exception sur erreur réseau");
  assert(
    status === "error" || status === "cf_blocked",
    `Status error ou cf_blocked quand réseau timeout (got: ${status})`,
  );
  resetMocks();
}

subsection("6c. Scanner — cf_clearance expirée (CF 403 sur portal) → cf_blocked retourné proprement");
{
  resetMocks();
  const session = makeMockSession({
    prefetchedMainHtml: undefined,
    source: "capsolver",
    allCookies: [{ name: "_ga", value: "GA1.1.123.456" }],
  });
  _setTestSessionProvider(async () => session);

  _setTestFetch(async (url) => {
    if (url.includes("/cdn-cgi/")) return new Response("", { status: 200 });
    // Portal returns 403 with CF challenge
    if (url === PORTAL_URL || url === PORTAL_URL.replace(/\/$/, "")) {
      return new Response(
        "Just a moment... verifying you are human",
        { status: 403 },
      );
    }
    return null;
  });

  let threw = false;
  let result_status = "";
  try {
    const r = await scanSpainHttp(PORTAL_URL);
    result_status = r.status;
  } catch {
    threw = true;
  }

  assert(!threw, "Pas d'exception sur CF 403");
  assert(
    result_status === "cf_blocked" || result_status === "error",
    `Status cf_blocked ou error quand portal renvoie 403+CF (got: ${result_status})`,
  );
  resetMocks();
}

// ══════════════════════════════════════════════════════════════════════════════
// RÉSUMÉ
// ══════════════════════════════════════════════════════════════════════════════

resetMocks();

const total = passed + failed;
console.log(`\n${"═".repeat(70)}`);
console.log(`  RÉSULTATS : ${passed}/${total} tests passés`);
if (failures.length > 0) {
  console.log(`\n  Échecs :`);
  for (const f of failures) {
    console.log(`    ❌ ${f}`);
  }
}
console.log(`${"═".repeat(70)}\n`);

process.exit(failed > 0 ? 1 : 0);
