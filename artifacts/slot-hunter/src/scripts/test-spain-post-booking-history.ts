/**
 * test-spain-post-booking-history.ts
 *
 * Diagnostic provisoire du flux POST-BOOKING Espagne.
 *
 * Le booking (signin/ → summary/) est volontairement absent de ce script.
 * Il part du principe qu'un rendez-vous existe déjà, puis crée une session
 * PHP distincte, recharge /main/, ouvre #signinaccount et vérifie #history.
 *
 * Sécurité :
 *   - aucune valeur de credential n'est affichée ;
 *   - aucune requête summary/ n'est envoyée ;
 *   - l'action d'annulation n'est jamais confirmée ;
 *   - --print est optionnel et génère uniquement un PDF local de diagnostic.
 *
 * Usage :
 *   SPAIN_POST_BOOKING_LOGIN="..." \
 *   SPAIN_POST_BOOKING_PASSWORD="..." \
 *   SPAIN_CF_PROFILE_DIR=/tmp/spain-post-booking-test \
 *   pnpm exec tsx src/scripts/test-spain-post-booking-history.ts
 *
 * Optionnel :
 *   SPAIN_POST_BOOKING_PORTAL_URL="https://www.citaconsular.es/es/hosteds/widgetdefault/<key>/"
 *   SPAIN_POST_BOOKING_LOCATOR="ABC123"
 *   ... test-spain-post-booking-history.ts --print
 */

import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ensureSpainPersistentBrowserSession,
  getActiveSpainPersistentBrowserSession,
  spainPersistentBrowser,
} from "../_legacy_spain-persistent-browser.js";
import { initDecodoPool } from "../spain-decodo-pool.js";
import { initSpainRedis } from "../spain-redis-persistence.js";

const DEFAULT_PORTAL_URL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5/";
const PORTAL_URL = (
  process.env.SPAIN_POST_BOOKING_PORTAL_URL ?? DEFAULT_PORTAL_URL
).split("#")[0].replace(/\/?$/, "/");
const LOGIN = process.env.SPAIN_POST_BOOKING_LOGIN?.trim() ?? "";
const PASSWORD = process.env.SPAIN_POST_BOOKING_PASSWORD ?? "";
const LOGIN_TYPE = process.env.SPAIN_POST_BOOKING_LOGIN_TYPE?.trim() || "document";
const LOCATOR = process.env.SPAIN_POST_BOOKING_LOCATOR?.trim() || "";
const DUMP_DIR = join(process.cwd(), "dump");
const PRINT_MODE = process.argv.includes("--print");

type NetworkObservation = {
  method: string;
  endpoint: string;
  status?: number;
};

function endpointOf(url: string): string {
  try {
    const parsed = new URL(url);
    const marker = "/onlinebookings/";
    const index = parsed.pathname.indexOf(marker);
    return index >= 0 ? parsed.pathname.slice(index + marker.length) : parsed.pathname;
  } catch {
    return url.slice(0, 100);
  }
}

function assertConfig(): void {
  if (!LOGIN || !PASSWORD) {
    throw new Error(
      "Variables manquantes: SPAIN_POST_BOOKING_LOGIN et SPAIN_POST_BOOKING_PASSWORD",
    );
  }
}

async function main(): Promise<void> {
  assertConfig();

  console.log("═".repeat(76));
  console.log("  TEST PROVISOIRE — SESSION POST-BOOKING / HISTORY ESPAGNE");
  console.log("═".repeat(76));
  console.log(`Portail : ${PORTAL_URL}`);
  console.log(`Locator : ${LOCATOR || "(non fourni — contrôle structurel uniquement)"}`);
  console.log(`Mode    : ${PRINT_MODE ? "inspection + PDF local" : "inspection sans impression"}`);
  console.log("");

  await initSpainRedis();
  await initDecodoPool();

  // Ce script est prévu pour être lancé avec un profil dédié
  // (SPAIN_CF_PROFILE_DIR=/tmp/spain-post-booking-test). On ferme uniquement
  // l'instance appartenant à ce processus avant d'ouvrir la nouvelle session.
  await spainPersistentBrowser.close();

  console.log("1 — Création d'une session CF/browser indépendante…");
  const initialSession = await ensureSpainPersistentBrowserSession(PORTAL_URL);
  if (!initialSession) {
    throw new Error("Impossible d'établir la nouvelle session CF/browser");
  }

  const initialMainBytes = initialSession.prefetchedMainHtml?.length ?? 0;
  console.log(`   /main/ initial : ${initialMainBytes}B`);

  // Frontière explicite après summary/ : on supprime le PHPSESSID existant
  // et le manager relance /main/ avec un identifiant de session applicative neuf.
  console.log("2 — Rotation PHPSESSID après summary/ réussi (sans réutiliser le booking)…");
  const refreshed = await spainPersistentBrowser.refreshPhpSession();
  if (!refreshed) {
    throw new Error("La création de la session PHP post-booking a échoué");
  }

  const postBookingSession = getActiveSpainPersistentBrowserSession();
  const postBookingMainBytes = postBookingSession?.prefetchedMainHtml?.length ?? 0;
  console.log(`   /main/ post-booking : ${postBookingMainBytes}B`);

  const page = spainPersistentBrowser.getActivePage();
  if (!page) throw new Error("Page Chromium absente après la création de session");

  const observations: NetworkObservation[] = [];
  const onRequest = (request: any) => {
    const url = String(request.url());
    if (url.includes("/onlinebookings/")) {
      observations.push({ method: request.method(), endpoint: endpointOf(url) });
    }
  };
  const onResponse = (response: any) => {
    const url = String(response.url());
    if (url.includes("/onlinebookings/")) {
      const endpoint = endpointOf(url);
      const item = [...observations].reverse().find(
        (entry) => entry.endpoint === endpoint && entry.status === undefined,
      );
      if (item) item.status = response.status();
    }
  };
  page.on("request", onRequest);
  page.on("response", onResponse);

  console.log("3 — Ouverture de #signinaccount…");
  await page.waitForSelector('a[href="#signinaccount"]', { timeout: 30_000 });
  await page.click('a[href="#signinaccount"]');
  await page.waitForSelector("#idIptBktAccountLoginlogin", { timeout: 30_000 });
  await page.waitForSelector("#idIptBktAccountLoginpassword", { timeout: 30_000 });

  // Le bundle charge les valeurs réelles de logintype dans ce select.
  await page.evaluate((loginType: string) => {
    const select = document.querySelector<HTMLSelectElement>("#idSelBktAccountLoginType");
    if (!select) return;
    const option = Array.from(select.options).find((item) => item.value === loginType);
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, LOGIN_TYPE);

  await page.$eval(
    "#idIptBktAccountLoginlogin",
    (element: Element, value: string) => {
      const input = element as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    LOGIN,
  );
  await page.$eval(
    "#idIptBktAccountLoginpassword",
    (element: Element, value: string) => {
      const input = element as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    PASSWORD,
  );

  console.log("4 — Envoi du login de compte (aucun credential dans les logs)…");
  await page.click("#idBktDefaultAccountLoginConfirmButton");

  await page.waitForFunction(
    () => {
      const hash = window.location.hash;
      const history = document.querySelector("#idBktDefaultAccountHistoryContainer");
      const error = document.querySelector("#idBktDefaultAccountLoginErrorContainer");
      const visible = (element: Element | null) =>
        !!element && getComputedStyle(element).display !== "none";
      return hash === "#history" || visible(history) || visible(error);
    },
    { timeout: 45_000 },
  );

  const loginState = await page.evaluate(() => ({
    hash: window.location.hash,
    historyVisible: (() => {
      const element = document.querySelector("#idBktDefaultAccountHistoryContainer");
      return !!element && getComputedStyle(element).display !== "none";
    })(),
    loginErrorVisible: (() => {
      const element = document.querySelector("#idBktDefaultAccountLoginErrorContainer");
      return !!element && getComputedStyle(element).display !== "none";
    })(),
    loginErrorText: document.querySelector("#idBktDefaultAccountLoginErrorContainer")?.textContent?.trim().slice(0, 180) ?? "",
  }));

  console.log(`   état login : hash=${loginState.hash || "(vide)"}`);
  if (loginState.loginErrorVisible) {
    throw new Error(`Login compte refusé: ${loginState.loginErrorText || "erreur non détaillée"}`);
  }
  if (!loginState.historyVisible && loginState.hash !== "#history") {
    throw new Error("Le portail n'a pas ouvert #history après le login");
  }

  console.log("5 — Inspection de l'historique…");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const historyState = await page.evaluate(() => {
    const appointmentRows = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).filter(
        (row) => !row.querySelector(".clsDivBktAccountHistoryContentHeader"),
      ).length;
    const printActions = document.querySelectorAll(
      ".clsDivBktAccountHistoryContentDataPrintContainer .clsDivBktAccountHistoryContentDataPrintIcon",
    ).length;
    const cancelActions = document.querySelectorAll(
      ".clsDivBktAccountHistoryContentDataDeleteContainer .clsDivBktAccountHistoryContentDataDeleteIcon",
    ).length;
    const activeRows = appointmentRows(
      "#idDivBktAccountHistoryContent > .clsDivBktAccountHistoryContentRow",
    );
    const pastRows = appointmentRows(
      "#idDivBktAccountHistoryContentPast .clsDivBktAccountHistoryContentRow",
    );
    return { printActions, cancelActions, activeRows, pastRows };
  });

  console.log(`   rendez-vous actifs : ${historyState.activeRows}`);
  console.log(`   actions imprimer   : ${historyState.printActions}`);
  console.log(`   actions annuler    : ${historyState.cancelActions}`);
  console.log(`   rendez-vous passés: ${historyState.pastRows}`);

  if (historyState.printActions === 0 && historyState.cancelActions === 0) {
    console.warn("⚠️ #history est ouvert mais aucune action n'est encore rendue");
  }

  if (PRINT_MODE && historyState.printActions > 0) {
    console.log("6 — Activation de l'action imprimer (jamais l'annulation)…");
    await page.click(".clsDivBktAccountHistoryContentDataPrintIcon");
    await page.waitForFunction(() => {
      const ticket = document.querySelector("#idBktDefaultTicketContainer");
      return !!ticket && getComputedStyle(ticket).display !== "none";
    }, { timeout: 15_000 });

    const pdfPath = join(
      DUMP_DIR,
      `spain-post-booking-ticket-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`,
    );
    await mkdir(DUMP_DIR, { recursive: true });
    await page.pdf({ path: pdfPath, format: "A4", printBackground: true });
    console.log(`   PDF local généré : ${pdfPath}`);
  }

  const uniqueEndpoints = [...new Set(observations.map((entry) => entry.endpoint))];
  console.log(`6 — Endpoints observés : ${uniqueEndpoints.join(", ") || "(aucun)"}`);
  console.log("✅ Test post-booking terminé : session booking non réutilisée, history vérifié.");

  page.off("request", onRequest);
  page.off("response", onResponse);
  await spainPersistentBrowser.close();
}

main().catch(async (error) => {
  console.error(`❌ Test post-booking échoué: ${error instanceof Error ? error.message : String(error)}`);
  await spainPersistentBrowser.close().catch(() => {});
  process.exit(1);
});