/**
 * test-spain-post-booking-history.ts
 *
 * Diagnostic provisoire du flux POST-BOOKING Espagne en HTTP pur.
 *
 * Le booking (signin/ → summary/) est volontairement absent de ce script.
 * Il part du principe qu'un rendez-vous existe déjà, crée une nouvelle session
 * HTTP/impit, recharge /main/, puis appelle directement :
 *
 *   getsigninaccountfields/ → signinaccount/ → gethistory/
 *   → geteventhistory/ (uniquement avec --print)
 *
 * Il n'utilise ni Chromium, ni Puppeteer, ni les sélecteurs DOM.
 *
 * Sécurité :
 *   - aucune valeur de credential n'est affichée ;
 *   - aucune requête summary/ n'est envoyée ;
 *   - deleteeventhistory/ n'est jamais appelé ;
 *   - --print ne fait qu'un GET geteventhistory/ non destructif.
 *
 * Usage :
 *   SPAIN_POST_BOOKING_LOGIN="..." \
 *   SPAIN_POST_BOOKING_PASSWORD="..." \
 *   pnpm exec tsx src/scripts/test-spain-post-booking-history.ts
 *
 * Optionnel :
 *   SPAIN_POST_BOOKING_PORTAL_URL="https://www.citaconsular.es/es/hosteds/widgetdefault/<key>/"
 *   SPAIN_POST_BOOKING_LOGIN_TYPE="document"
 *   SPAIN_POST_BOOKING_PROXY_INDEX="0"
 *   SPAIN_POST_BOOKING_LOCATOR="ABC123"
 *   ... test-spain-post-booking-history.ts --print
 */

import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import puppeteer from "puppeteer";
import { initDecodoPool, getDecodoProxyForIndex } from "../spain-decodo-pool.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import {
  buildConfirmationHtml,
  extractConfirmationData,
} from "../_legacy_spain-confirmation-pdf.js";
import {
  CALL_DIRECT_HTTP_OVERLOAD,
  CALL_DIRECT_NETWORK_ERROR,
  CALL_DIRECT_RETRY_REFRESH_FAILED,
  buildDynamicSession,
  callDirect,
  type DynamicSession,
} from "../spain-bookitit-direct.js";
import { initWorkerSession, spainCfFetch } from "../spain-soax-solver.js";

const DEFAULT_PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const PORTAL_URL = (
  process.env.SPAIN_POST_BOOKING_PORTAL_URL ?? DEFAULT_PORTAL_URL
).split("#")[0].replace(/\/?$/, "/");
const LOGIN = process.env.SPAIN_POST_BOOKING_LOGIN?.trim() ?? "";
const PASSWORD = process.env.SPAIN_POST_BOOKING_PASSWORD ?? "";
const LOGIN_TYPE = process.env.SPAIN_POST_BOOKING_LOGIN_TYPE?.trim() || "document";
const LOCATOR = process.env.SPAIN_POST_BOOKING_LOCATOR?.trim() || "";
const PROXY_INDEX = Math.max(
  0,
  Number.parseInt(process.env.SPAIN_POST_BOOKING_PROXY_INDEX ?? "0", 10) || 0,
);
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
const PRINT_MODE = process.argv.includes("--print");

function addStickySession(url: string, sid: string): string {
  try {
    const parsed = new URL(url);
    const user = decodeURIComponent(parsed.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    parsed.username = encodeURIComponent(stickyUser);
    return parsed.toString();
  } catch {
    return url;
  }
}

function assertConfig(): void {
  if (!LOGIN || !PASSWORD) {
    throw new Error(
      "Variables manquantes: SPAIN_POST_BOOKING_LOGIN et SPAIN_POST_BOOKING_PASSWORD",
    );
  }
  if (!CAPSOLVER_KEY) {
    throw new Error("Variable manquante: CAPSOLVER_API_KEY");
  }
}

function isCallFailure(
  value: unknown,
): value is null | typeof CALL_DIRECT_HTTP_OVERLOAD | typeof CALL_DIRECT_NETWORK_ERROR | typeof CALL_DIRECT_RETRY_REFRESH_FAILED {
  return (
    value === null ||
    value === CALL_DIRECT_HTTP_OVERLOAD ||
    value === CALL_DIRECT_NETWORK_ERROR ||
    value === CALL_DIRECT_RETRY_REFRESH_FAILED
  );
}

async function callPure(
  session: DynamicSession,
  endpoint: string,
  params: Record<string, string> = {},
): Promise<unknown> {
  const value = await callDirect(
    session,
    endpoint,
    params,
    "[post-booking-http-pure]",
    { maxRetries: 0 },
  );
  if (isCallFailure(value)) {
    const reason =
      value === CALL_DIRECT_HTTP_OVERLOAD
        ? "HTTP overload"
        : value === CALL_DIRECT_NETWORK_ERROR
          ? "network/proxy error"
          : value === CALL_DIRECT_RETRY_REFRESH_FAILED
            ? "retry parameter refresh failed"
            : "empty or invalid response";
    throw new Error(`${endpoint} échoué: ${reason}`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function objectKeys(value: unknown): string {
  return Object.keys(asRecord(value)).sort().join(",") || "-";
}

function getAccountClient(value: unknown): Record<string, any> {
  const root = asRecord(value);
  return asRecord(root.Client ?? root.Customer ?? root);
}

function getHistoryEvents(value: unknown): any[] {
  const root = asRecord(value);
  if (Array.isArray(root.Events)) return root.Events;
  if (Array.isArray(root.Event)) return root.Event;
  return Array.isArray(value) ? value : [];
}

function getFirstTicketEvent(value: unknown, fallback: Record<string, any>): Record<string, any> {
  const root = asRecord(value);
  const eventsObject = asRecord(root.Events);
  const appointment = asRecord(eventsObject.Appointment);
  if (Object.keys(appointment).length > 0) {
    const services = Array.isArray(appointment.serviceList) ? appointment.serviceList : [];
    return {
      ...appointment,
      title: services[0]?.title ?? "",
      name: appointment.agenda ?? "",
      people: appointment.people ?? 1,
    };
  }
  const event = getHistoryEvents(value)[0];
  return Object.keys(asRecord(event)).length > 0 ? asRecord(event) : fallback;
}

function getTicketCustomer(value: unknown): Record<string, any> {
  const root = asRecord(value);
  const eventsObject = asRecord(root.Events);
  return asRecord(eventsObject.Customer);
}

async function renderConfirmationPdf(data: Parameters<typeof buildConfirmationHtml>[0]): Promise<Buffer> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(buildConfirmationHtml(data), { waitUntil: "domcontentloaded" });
    return Buffer.from(await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    }));
  } finally {
    await browser.close().catch(() => {});
  }
}

function getFieldOptions(value: unknown): string[] {
  const root = asRecord(value);
  const customFields = asRecord(root.CustomFields);
  const clients = Array.isArray(customFields.Clients) ? customFields.Clients : [];
  return clients
    .filter((field) => Number(field?.show_widget) === 1 && Number(field?.validate) === 1)
    .map((field) => String(field.input_text ?? ""))
    .filter(Boolean);
}

async function downloadLiveBundle(session: Parameters<typeof spainCfFetch>[1]): Promise<void> {
  const version = session.bookititState?.version ?? "4";
  const modulePaths = [
    "mainv1.js",
    "default/views/accountlogin.js",
    "default/collections/signinaccountfields.js",
    "default/collections/events.js",
    "default/views/historyappointmentslist.js",
    "default/views/ticket.js",
  ];

  console.log("2 — Téléchargement des modules live du bundle Bookitit…");
  for (const modulePath of modulePaths) {
    const url = `https://www.citaconsular.es/js/widgets/${modulePath}?v=${encodeURIComponent(version)}`;
    try {
      const response = await spainCfFetch(url, session, {
        headers: {
          Accept: "application/javascript, text/javascript, */*;q=0.01",
          Referer: session.bookititState?.widgetUrl ?? PORTAL_URL,
        },
      });
      if (!response) {
        console.warn(`   ${modulePath} → aucune réponse`);
        continue;
      }
      const body = await response.text();
      if (modulePath.endsWith("/ticket.js")) {
        await mkdir("dump", { recursive: true });
        await writeFile("dump/live-ticket.js", body, "utf8");
      }
      const endpoints = [...new Set(
        [...body.matchAll(/(?:get_server_url\(\)\s*\+\s*["']|url\s*\+=\s*["'])([^"']+\/)/g)]
          .map((match) => match[1]),
      )];
      console.log(
        `   ${modulePath} → HTTP ${response.status}, ${body.length}B` +
        (endpoints.length ? `, endpoints=${endpoints.join(",")}` : ""),
      );
    } catch (error) {
      // Le test continue avec les routes déjà confirmées localement si un module
      // statique est temporairement refusé par le portail.
      console.warn(`   ${modulePath} → téléchargement impossible: ${String(error).slice(0, 120)}`);
    }
  }
}

async function main(): Promise<void> {
  assertConfig();

  console.log("═".repeat(76));
  console.log("  TEST PROVISOIRE — SESSION POST-BOOKING ESPAGNE / HTTP PUR");
  console.log("═".repeat(76));
  console.log(`Portail : ${PORTAL_URL}`);
  console.log(`Proxy   : pool index ${PROXY_INDEX} (sticky session neuve)`);
  console.log(`Locator : ${LOCATOR || "(non fourni — contrôle structurel uniquement)"}`);
  console.log(`Mode    : ${PRINT_MODE ? "history + geteventhistory" : "history uniquement"}`);
  console.log("");

  await initSpainRedis();
  await initDecodoPool();

  const proxyBase = getDecodoProxyForIndex(PROXY_INDEX);
  if (!proxyBase) {
    throw new Error(`Aucun proxy Decodo disponible à l'index ${PROXY_INDEX}`);
  }
  const stickyId = Math.random().toString(36).slice(2, 10);
  const stickyProxy = addStickySession(proxyBase, stickyId);

  // Cette init crée une nouvelle instance impit, un nouveau jar et un nouveau
  // PHPSESSID. Elle ne réutilise pas la session HTTP du booking précédent.
  console.log("1 — Création de la session HTTP/impit post-booking…");
  const initialized = await initWorkerSession(
    stickyProxy,
    PORTAL_URL,
    CAPSOLVER_KEY,
  );
  if (!initialized) {
    throw new Error("Impossible d'établir la nouvelle session HTTP post-booking");
  }

  const { session } = initialized;
  const mainBytes = session.prefetchedMainHtml?.length ?? 0;
  const phpSession = session.allCookies.find((cookie) => cookie.name === "PHPSESSID");
  console.log(`   /main/ : ${mainBytes}B`);
  console.log(`   PHPSESSID neuf : ${phpSession ? "oui" : "non"}`);
  if (!phpSession || mainBytes <= 0) {
    throw new Error("Session HTTP initialisée sans PHPSESSID ou sans réponse /main/");
  }

  const dynamicSession = buildDynamicSession(session);
  if (!dynamicSession) {
    throw new Error("Impossible de construire la DynamicSession HTTP pure");
  }

  await downloadLiveBundle(session);

  console.log("3 — Lecture des types de login via getsigninaccountfields/…");
  const fieldsPayload = await callPure(dynamicSession, "getsigninaccountfields/");
  const availableTypes = getFieldOptions(fieldsPayload);
  console.log(`   logintype disponibles : ${availableTypes.join(", ") || "(réponse sans Clients)"}`);
  if (availableTypes.length > 0 && !availableTypes.includes(LOGIN_TYPE)) {
    throw new Error(
      `SPAIN_POST_BOOKING_LOGIN_TYPE=${LOGIN_TYPE} absent des types retournés`,
    );
  }

  console.log("4 — Connexion via signinaccount/ (HTTP pur)…");
  const accountPayload = await callPure(dynamicSession, "signinaccount/", {
    logintype: LOGIN_TYPE,
    login: LOGIN,
    // accountlogin.js encode le password avant que jQuery encode la query.
    password: encodeURIComponent(PASSWORD),
  });
  const account = getAccountClient(accountPayload);
  const signedIn = account.signedin ?? account.signedIn ?? asRecord(accountPayload).signedin;
  const bktToken = account.bktToken ?? asRecord(accountPayload).bktToken;
  if (!signedIn || !bktToken) {
    const root = asRecord(accountPayload);
    const error = root.Exception?.errors ?? root.errors ?? root.Exception ?? "réponse sans signedin/bktToken";
    throw new Error(`signinaccount/ refusé: ${JSON.stringify(error).slice(0, 240)}`);
  }
  console.log(`   signinaccount/ accepté : signedin oui, bktToken oui`);

  console.log("5 — Lecture de l'historique via gethistory/ (HTTP pur)…");
  const historyPayload = await callPure(dynamicSession, "gethistory/", {
    signedin: String(signedIn),
    bktToken: String(bktToken),
  });
  const historyRoot = asRecord(historyPayload);
  if (historyRoot.Exception || historyRoot.errors) {
    throw new Error(
      `gethistory/ refusé: ${JSON.stringify(historyRoot.Exception?.errors ?? historyRoot.errors ?? historyRoot.Exception).slice(0, 240)}`,
    );
  }

  const events = getHistoryEvents(historyPayload);
  const futureEvents = events.filter((event) => event?.block !== "past");
  const pastEvents = events.filter((event) => event?.block === "past");
  const printableEvents = events.filter((event) => event?.print === true);
  const cancellableEvents = events.filter((event) => event?.cancel === true);

  console.log(`   gethistory/ accepté : ${events.length} événement(s)`);
  console.log(`   futurs : ${futureEvents.length} | passés : ${pastEvents.length}`);
  console.log(`   imprimables : ${printableEvents.length}`);
  console.log(`   annulables : ${cancellableEvents.length}`);
  console.log(`   clés réponse : ${objectKeys(historyPayload)}`);

  if (LOCATOR) {
    const locatorMatch = events.filter((event) =>
      String(event?.locator ?? event?.id ?? "").includes(LOCATOR),
    ).length;
    console.log(`   correspondances locator : ${locatorMatch}`);
  }

  if (PRINT_MODE && printableEvents.length > 0) {
    const event = printableEvents[0];
    const eventId = String(event.id ?? event.event ?? "");
    if (!eventId) {
      throw new Error("Événement imprimable sans id");
    }
    console.log("6 — Lecture du ticket via geteventhistory/ (GET non destructif)…");
    const ticketPayload = await callPure(dynamicSession, "geteventhistory/", {
      event: eventId,
      signedin: String(signedIn),
      bktToken: String(bktToken),
    });
    const ticketRoot = asRecord(ticketPayload);
    if (ticketRoot.Exception || ticketRoot.errors) {
      throw new Error(
        `geteventhistory/ refusé: ${JSON.stringify(ticketRoot.Exception?.errors ?? ticketRoot.errors ?? ticketRoot.Exception).slice(0, 240)}`,
      );
    }
    console.log(`   geteventhistory/ accepté : clés=${objectKeys(ticketPayload)}`);
    await mkdir("dump", { recursive: true });
    await writeFile(
      "dump/spain-confirmation-latest-payload.json",
      JSON.stringify(ticketPayload, null, 2),
      "utf8",
    );

    const ticketEvent = getFirstTicketEvent(ticketPayload, event);
    const ticketCustomer = getTicketCustomer(ticketPayload);
    const ticketLocator = String(
      ticketEvent.locator ??
      ticketEvent.confirmationCode ??
      event.locator ??
      event.confirmationCode ??
      eventId,
    );
    const ticketDate = String(ticketEvent.date ?? event.date ?? "");
    const ticketTime = String(ticketEvent.time ?? event.time ?? "");
    const ticketService = String(
      ticketEvent.service ??
      ticketEvent.title ??
      event.service ??
      event.title ??
      "Cita consular",
    );
    const ticketAgenda = String(
      ticketEvent.agenda_name ??
      ticketEvent.agenda ??
      event.agenda_name ??
      event.agenda ??
      "",
    );
    const ticketPeople = Number(ticketEvent.people ?? event.people ?? 1) || 1;
    const applicantName = String(
      ticketCustomer.name ??
      account.name ??
      account.document ??
      "Titular de la reserva",
    );
    // geteventhistory/ retourne { Events: [...] }, alors que le helper PDF
    // accepte le format ticket { Event: ... } : on normalise sans modifier
    // les données reçues du portail.
    const confirmationData = extractConfirmationData([{ Event: ticketEvent }], {
      applicantName,
      serviceName: ticketService,
      slotDate: ticketDate,
      slotTime: ticketTime,
    });

    if (!confirmationData) {
      console.warn(
        `   format ticket plat détecté (eventKeys=${objectKeys(ticketEvent)}) — rendu avec l'id événement`,
      );
    }

    const enrichedConfirmationData = {
      ...(confirmationData ?? {
        locator: ticketLocator,
        applicantName,
        date: ticketDate,
        time: ticketTime,
        serviceName: ticketService,
      }),
      locator: ticketLocator || confirmationData?.locator || "Non communiqué",
      date: ticketDate || confirmationData?.date || "Non communiquée",
      time: ticketTime || confirmationData?.time || "Non communiquée",
      serviceName: ticketService,
      agendaName: ticketAgenda || undefined,
      people: ticketPeople > 1 ? ticketPeople : undefined,
      document: account.document ? String(account.document) : undefined,
    };

    const pdf = await renderConfirmationPdf(enrichedConfirmationData);
    await writeFile("dump/spain-confirmation-latest.pdf", pdf);
    console.log("   confirmation officielle sauvegardée : dump/spain-confirmation-latest.pdf");
    console.log("   payload source sauvegardé : dump/spain-confirmation-latest-payload.json");
    console.log("   aucune requête d'annulation n'a été déclenchée");
  }

  console.log("✅ Test HTTP pur terminé : bundle, signinaccount/ et gethistory/ vérifiés.");
  console.log("   deleteeventhistory/ n'a pas été appelé.");
}

main().catch((error) => {
  console.error(`❌ Test HTTP pur échoué: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});