/**
 * canadaPortal.ts
 * VFS Global — IRCC (Immigration, Refugees and Citizenship Canada)
 * Portail ASP.NET MVC : IRCC-AppointmentWave1
 *
 * Flux principal (Kinshasa, DRC → Canada, Biometric Enrolment) :
 *   1. Login VFS → extraction du cookie ASP.NET_SessionId + token CSRF
 *   2. GET /Home/SelectVAC  → page "Select Centre"
 *   3. POST /Account/GetEarliestVisaSlotDate → JSON { StandardDateDisplay, IsPrimeEnabled, … }
 *   4. Si créneau disponible → soumission du formulaire → page calendrier
 *   5. Sélection date + heure → confirmation → capture screenshot + PDF
 *   6. reportSlotFound vers Convex
 *
 * Endpoints IRCC découverts par reverse-engineering du bundle HTML :
 *   POST /Account/CheckSeatAllotment           → vérifie les quotas
 *   POST /Account/GetEarliestVisaSlotDate      → date la plus proche disponible (JSON)
 *   POST /Home/SelectVAC                       → soumet le choix de centre → calendrier
 *   POST /Home/AppointmentDate                 → liste des dates vertes sur le calendrier
 *   POST /Home/AppointmentTime                 → créneaux horaires d'une date
 *   POST /Home/ConfirmAppointment              → confirmation finale
 *   POST /Account/LogOff                       → déconnexion
 *
 * Paramètres Kinshasa hardcodés (issus du JSON MissionCountryLocationJSON) :
 *   missionId   = 2   (Canada)
 *   countryId   = 82  (Democratic Republic of the Congo)
 *   locationId  = 225 (Canada Visa Application Center - Kinshasa)
 *   visaCategoryId = 437 (Biometric Enrolment)
 */

import type { Page } from "playwright";
import { launchBrowser, randomDelay, humanScroll } from "./browser.js";
import {
  botLog,
  sendHeartbeat,
  reportSlotFound,
  uploadScreenshot,
  uploadFile,
  attachConfirmationDoc,
  type HunterJob,
} from "./convexClient.js";

type SessionResult =
  | "slot_found"
  | "not_found"
  | "captcha"
  | "error"
  | "login_failed"
  | "payment_required";

// ─── Constantes portail ───────────────────────────────────────────────────────
const MISSION_ID = 2;
const COUNTRY_ID = 82;
const LOCATION_ID = 225;
const VISA_CATEGORY_ID = 437; // Biometric Enrolment
const DEFAULT_NO_APPLICANTS = 1;

// Textes indiquant l'absence de créneau dans la réponse JSON
const NO_SLOT_PATTERNS = [
  "no slot",
  "no slots",
  "not available",
  "unavailable",
  "no availability",
  "n/a",
  "na",
  "--",
  "",
];

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Canada portal session timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Extrait le base URL du portail depuis l'URL fournie.
 * Ex: "https://www.vfsglobal.ca/IRCC-AppointmentWave1/Account/Login"
 *   → "https://www.vfsglobal.ca/IRCC-AppointmentWave1"
 */
function extractBaseUrl(portalUrl: string): string {
  const m = portalUrl.match(/^(https?:\/\/[^/]+\/IRCC-AppointmentWave1)/i);
  if (m) return m[1];
  // Fallback : tout jusqu'au dernier segment /Account/ ou /Home/
  const fallback = portalUrl.replace(/\/(Account|Home)\/.*/i, "");
  return fallback;
}

/**
 * Extrait le token CSRF ASP.NET depuis le DOM de la page courante.
 * Le jeton __RequestVerificationToken est présent dans tous les formulaires.
 */
async function extractCsrfToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>(
      "input[name='__RequestVerificationToken']",
    );
    return el?.value ?? "";
  });
}

/**
 * Vérifie si le texte de date renvoyé par l'API indique un créneau disponible.
 */
function isSlotDate(dateDisplay: unknown): boolean {
  if (!dateDisplay || typeof dateDisplay !== "string") return false;
  const clean = dateDisplay.trim().toLowerCase();
  if (!clean) return false;
  for (const pattern of NO_SLOT_PATTERNS) {
    if (clean === pattern) return false;
  }
  // "No Slots Available", "Slot Not Available", etc.
  if (
    clean.includes("no slot") ||
    clean.includes("not available") ||
    clean.includes("unavailable") ||
    clean.includes("no availability")
  ) {
    return false;
  }
  return true;
}

/**
 * Capture une screenshot et l'upload vers Convex Storage.
 */
async function captureAndUpload(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    const storageId = await uploadScreenshot(buf.toString("base64"));
    return storageId ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture la page de confirmation en PDF et l'attache au dossier.
 */
async function captureConfirmationPdf(page: Page): Promise<string | null> {
  try {
    const ctx = page.context();
    const printPage = await ctx.newPage();
    const html = await page.content();
    await printPage.setContent(html, { waitUntil: "domcontentloaded" });
    const pdfBytes = Buffer.from(
      await printPage.pdf({ format: "A4", printBackground: true }),
    );
    await printPage.close();
    return await uploadFile(pdfBytes.toString("base64"), "application/pdf");
  } catch (e) {
    console.warn("[canada] captureConfirmationPdf failed:", e);
    return null;
  }
}

/**
 * Extrait le numéro de référence de confirmation depuis le DOM.
 * VFS IRCC affiche le ref sous différentes formes selon la version du portail.
 */
async function extractConfirmationRef(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const body = document.body?.innerText ?? "";
      // Pattern "Reference Number: XXXXX" ou "Ref: XXXXX"
      const m =
        body.match(/reference\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\-]{4,20})/i) ??
        body.match(/\b([A-Z]{2,4}\d{6,12})\b/);
      return m ? m[1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Login au portail VFS IRCC.
 * Navigue vers la page de login (fournie dans portalUrl du job),
 * remplit le formulaire email/password et soumet.
 * Retourne "ok" | "failed" | "captcha".
 */
async function loginVfsIrcc(
  page: Page,
  job: HunterJob,
): Promise<"ok" | "failed" | "captcha"> {
  const loginUrl =
    job.portalUrl ??
    job.hunterConfig.scheduleUrl ??
    "";
  if (!loginUrl) {
    botLog({
      applicationId: job.id,
      step: "login",
      status: "fail",
      data: { reason: "missing_portal_url", flow: "canada" },
    });
    return "failed";
  }

  console.log(`[canada] Navigation vers login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await randomDelay(1500, 2500);

  // Attendre le formulaire de login
  try {
    await page.waitForSelector(
      "input[name='UserName'], input[type='email'], #UserName, #Email",
      { timeout: 15_000 },
    );
  } catch {
    // Peut-être déjà connecté — vérifier la présence du menu Actions
    const hasMenu = await page
      .$("a[href*='SelectVAC'], .leftNav-ul, #sidebar")
      .then((el) => el !== null)
      .catch(() => false);
    if (hasMenu) {
      console.log("[canada] Déjà connecté (session active)");
      botLog({ applicationId: job.id, step: "login", status: "ok", data: { reason: "session_active", flow: "canada" } });
      return "ok";
    }
    console.error("[canada] Formulaire de login introuvable");
    return "failed";
  }

  // Remplir identifiants
  const usernameSelector = [
    "#UserName",
    "input[name='UserName']",
    "input[type='email']",
    "#Email",
  ].join(", ");

  const passwordSelector = [
    "#Password",
    "input[name='Password']",
    "input[type='password']",
  ].join(", ");

  await page.fill(usernameSelector, job.hunterConfig.embassyUsername);
  await randomDelay(400, 900);
  await page.fill(passwordSelector, job.hunterConfig.embassyPassword);
  await randomDelay(600, 1200);

  // Soumettre le formulaire
  const submitSelector = [
    "input[type='submit']",
    "button[type='submit']",
    ".login-btn",
    "#btnLogin",
    "input[value='Login']",
    "input[value='Sign In']",
    "input[value='SIGN IN']",
  ].join(", ");

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
    page.click(submitSelector).catch(async () => {
      await page.keyboard.press("Enter");
    }),
  ]);
  await randomDelay(2000, 3500);

  const currentUrl = page.url().toLowerCase();

  // Détection d'erreur login
  const hasLoginError = await page.evaluate(() => {
    const errs = document.querySelectorAll(
      ".validation-summary-errors, .field-validation-error, .alert-danger, [class*='error']",
    );
    return errs.length > 0;
  });

  if (hasLoginError && currentUrl.includes("login")) {
    console.warn("[canada] Erreur login — mauvais identifiants ?");
    botLog({
      applicationId: job.id,
      step: "login",
      status: "fail",
      data: { reason: "login_error_visible", url: currentUrl, flow: "canada" },
    });
    return "failed";
  }

  // Vérifier présence du menu post-login
  const isLoggedIn = await page.evaluate(() => {
    return !!(
      document.querySelector(".leftNav-ul") ??
      document.querySelector("#sidebar") ??
      document.querySelector("a[href*='LogOff']") ??
      document.querySelector("form[action*='LogOff']")
    );
  });

  if (!isLoggedIn) {
    console.warn(`[canada] Login incertain — URL: ${currentUrl}`);
    // Donner une seconde chance : peut-être redirection encore en cours
    await randomDelay(2000, 3000);
    const retryCheck = await page
      .$("form[action*='LogOff'], .leftNav-ul")
      .then((el) => el !== null)
      .catch(() => false);
    if (!retryCheck) {
      botLog({
        applicationId: job.id,
        step: "login",
        status: "fail",
        data: { reason: "not_logged_in_after_submit", url: currentUrl, flow: "canada" },
      });
      return "failed";
    }
  }

  console.log("[canada] ✅ Login VFS IRCC réussi");
  botLog({ applicationId: job.id, step: "login", status: "ok", data: { flow: "canada" } });
  return "ok";
}

/**
 * Appelle l'API GetEarliestVisaSlotDate via fetch depuis le contexte page (cookies inclus).
 * Retourne la réponse JSON ou null.
 */
async function getEarliestSlotDate(
  page: Page,
  baseUrl: string,
  csrfToken: string,
  noOfApplicants: number = DEFAULT_NO_APPLICANTS,
): Promise<{
  StandardDateDisplay?: string;
  PrimeDateDisplay?: string;
  IsPrimeEnabled?: boolean;
  CanshowAdditionalFields?: boolean;
} | null> {
  const endpoint = `${baseUrl}/Account/GetEarliestVisaSlotDate`;
  const params = new URLSearchParams({
    countryId: String(COUNTRY_ID),
    missionId: String(MISSION_ID),
    LocationId: String(LOCATION_ID),
    VisaCategoryId: String(VISA_CATEGORY_ID),
    NoOfApplicantId: String(noOfApplicants),
    NationalityId: "0",
  });

  try {
    const result = await page.evaluate(
      async ({ url, body, token }: { url: string; body: string; token: string }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "__RequestVerificationToken": token,
          },
          body,
          credentials: "include",
        });
        if (!res.ok) return null;
        return res.json();
      },
      { url: endpoint, body: params.toString(), token: csrfToken },
    );
    return result as ReturnType<typeof getEarliestSlotDate> extends Promise<infer R> ? R : never;
  } catch (e) {
    console.warn("[canada] getEarliestSlotDate error:", e);
    return null;
  }
}

/**
 * Appelle CheckSeatAllotment pour vérifier les quotas disponibles.
 */
async function checkSeatAllotment(
  page: Page,
  baseUrl: string,
  csrfToken: string,
  noOfApplicants: number = DEFAULT_NO_APPLICANTS,
): Promise<string> {
  const endpoint = `${baseUrl}/Account/CheckSeatAllotment`;
  const params = new URLSearchParams({
    countryId: String(COUNTRY_ID),
    missionId: String(MISSION_ID),
    LocationId: String(LOCATION_ID),
    Location: "Canada Visa Application Center - Kinshasa",
    NoOfApplicantId: String(noOfApplicants),
  });

  try {
    const result = await page.evaluate(
      async ({ url, body, token }: { url: string; body: string; token: string }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            "__RequestVerificationToken": token,
          },
          body,
          credentials: "include",
        });
        if (!res.ok) return "";
        const ct = res.headers.get("Content-Type") ?? "";
        if (ct.includes("json")) {
          const d = await res.json() as { message?: string; result?: string } | string;
          return typeof d === "string" ? d : JSON.stringify(d);
        }
        return res.text();
      },
      { url: endpoint, body: params.toString(), token: csrfToken },
    );
    return typeof result === "string" ? result : "";
  } catch {
    return "";
  }
}

/**
 * Navigue vers la page de calendrier en soumettant le formulaire SelectVAC.
 * Retourne true si la navigation a réussi (page calendrier chargée).
 */
async function navigateToCalendar(
  page: Page,
  baseUrl: string,
): Promise<boolean> {
  const scheduleUrl = `${baseUrl}/Home/SelectVAC?q=dePiaPfL2MJ7yDPEmQRU6fRZbx3aIpSal6PdG3Bxqq7rSNU6HabciCVot9dEwkhd`;
  try {
    await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await randomDelay(1500, 2500);
  } catch {
    return false;
  }

  // S'assurer que le formulaire est chargé et les selects pré-remplis
  await page.waitForFunction(
    () => {
      const loc = document.querySelector<HTMLSelectElement>("#LocationId");
      return loc !== null;
    },
    { timeout: 10_000 },
  ).catch(() => {});

  // Cocher la case "I Acknowledge terms and conditions"
  await page.evaluate(() => {
    const cb = document.querySelector<HTMLInputElement>("#IAgree");
    if (cb && !cb.checked) cb.click();
  });
  await randomDelay(500, 900);

  // Soumettre le formulaire pour aller sur le calendrier
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
      page.click("#btnContinue"),
    ]);
    await randomDelay(2000, 3500);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sur la page de liste des candidats, ajoute un candidat si nécessaire
 * et clique sur Continue pour accéder au calendrier des dates.
 */
async function handleApplicantListPage(
  page: Page,
  job: HunterJob,
): Promise<boolean> {
  const isApplicantPage = await page.evaluate(() => {
    return !!(
      document.querySelector("#btnAddApplicant") ??
      document.querySelector(".applicant-list") ??
      document.querySelector("h1")?.textContent?.toLowerCase().includes("applicant")
    );
  });

  if (!isApplicantPage) return true; // pas besoin de gérer cette page

  botLog({ applicationId: job.id, step: "applicant_list", status: "ok", data: { flow: "canada" } });

  // Vérifier s'il y a déjà des candidats dans la liste
  const hasApplicants = await page.evaluate(() => {
    const rows = document.querySelectorAll("table tbody tr, .applicant-row");
    return rows.length > 0;
  });

  if (!hasApplicants) {
    // Cliquer sur "Add Applicant" si disponible
    const addBtn = await page.$("a[href*='AddApplicant'], #btnAddApplicant, input[value*='Add']");
    if (addBtn) {
      await addBtn.click();
      await randomDelay(1500, 2500);
    }
  }

  // Sélectionner tous les candidats via checkbox
  await page.evaluate(() => {
    const checkboxes = document.querySelectorAll<HTMLInputElement>("input[type='checkbox'][name*='applicant' i], input[type='checkbox'][id*='applicant' i], table input[type='checkbox']");
    checkboxes.forEach((cb) => { if (!cb.checked) cb.click(); });
  });
  await randomDelay(500, 1000);

  // Continuer vers le calendrier
  const continueBtn = await page.$(
    "#btnContinue, input[type='submit'][value*='Continue'], button:has-text('Continue')",
  );
  if (continueBtn) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
      continueBtn.click(),
    ]);
    await randomDelay(2000, 3500);
  }

  return true;
}

/**
 * Sur la page calendrier, tente de sélectionner la première date disponible (en vert).
 * Retourne les infos du créneau ou null.
 */
async function selectFirstAvailableSlot(
  page: Page,
): Promise<{ date: string; time: string } | null> {
  // Attendre le calendrier
  await page
    .waitForSelector(
      "table.ui-datepicker-calendar, .calendar-table, #calendar, td.available, td[class*='Avail']",
      { timeout: 20_000 },
    )
    .catch(() => {});

  await randomDelay(1000, 2000);

  // Chercher la première date disponible (classe "available", "Avail", fond vert, etc.)
  const firstAvailDate = await page.evaluate(() => {
    const selectors = [
      "td.available:not(.ui-datepicker-unselectable)",
      "td[class*='Avail']:not([class*='Un'])",
      "td[style*='green']",
      "td.ui-state-default:not(.ui-state-disabled)",
      "a[class*='available']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        const dateAttr =
          el.getAttribute("data-date") ??
          el.getAttribute("data-value") ??
          el.closest("td")?.getAttribute("data-date") ??
          el.textContent?.trim() ??
          "";
        return { el: el.tagName, text: el.textContent?.trim() ?? "", dateAttr };
      }
    }
    return null;
  });

  if (!firstAvailDate) return null;

  // Cliquer sur la date disponible
  try {
    const clicked = await page.evaluate(() => {
      const selectors = [
        "td.available:not(.ui-datepicker-unselectable)",
        "td[class*='Avail']:not([class*='Un'])",
        "td[style*='green']",
        "td.ui-state-default:not(.ui-state-disabled)",
      ];
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el) { el.click(); return true; }
      }
      return false;
    });
    if (!clicked) return null;
  } catch {
    return null;
  }

  await randomDelay(1500, 2500);

  // Récupérer les créneaux horaires disponibles
  const timeSlot = await page.evaluate(() => {
    const timeSelectors = [
      "select#TimeId option:not([value='0'])",
      ".time-slot:not(.disabled)",
      "input[name*='time'][type='radio']",
      "a[class*='time']:not(.disabled)",
      "td[class*='time']:not(.disabled)",
    ];
    for (const sel of timeSelectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) {
        return (
          el.getAttribute("value") ??
          el.getAttribute("data-time") ??
          el.textContent?.trim() ??
          "09:00"
        );
      }
    }
    // Fallback: lire la date depuis l'URL ou un champ hidden
    const dateInput = document.querySelector<HTMLInputElement>("input[name*='Date'], input[name*='date']");
    return dateInput?.value ?? null;
  });

  const dateText = firstAvailDate.dateAttr || firstAvailDate.text;
  return { date: dateText, time: timeSlot ?? "09:00" };
}

/**
 * Confirme le rendez-vous après sélection de la date et de l'heure.
 * Retourne le code de confirmation ou null.
 */
async function confirmAppointment(page: Page): Promise<string | null> {
  // Chercher le bouton de confirmation
  const confirmBtn = await page.$(
    "#btnConfirm, input[value*='Confirm'], button:has-text('Confirm'), input[value*='Submit'], #btnSubmit",
  );
  if (!confirmBtn) return null;

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {}),
    confirmBtn.click(),
  ]);
  await randomDelay(2000, 3500);

  return extractConfirmationRef(page);
}

/**
 * Logout du portail VFS IRCC.
 */
async function logoutVfsIrcc(page: Page, baseUrl: string): Promise<void> {
  try {
    const csrf = await extractCsrfToken(page);
    await page.evaluate(
      ({ url, token }: { url: string; token: string }) => {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = url;
        if (token) {
          const inp = document.createElement("input");
          inp.type = "hidden";
          inp.name = "__RequestVerificationToken";
          inp.value = token;
          form.appendChild(inp);
        }
        document.body.appendChild(form);
        form.submit();
      },
      { url: `${baseUrl}/Account/LogOff`, token: csrf },
    );
    await randomDelay(1000, 2000);
    console.log("[canada] Déconnexion VFS IRCC OK");
  } catch (e) {
    console.warn("[canada] Logout non critique:", e);
  }
}

/**
 * Point d'entrée principal de la session Canada.
 * Appelé depuis navigator.ts pour chaque job avec destination === "canada".
 */
export async function runCanadaSession(job: HunterJob): Promise<SessionResult> {
  const sessionPromise = (async (): Promise<SessionResult> => {
    const portalUrl = job.portalUrl ?? job.hunterConfig.scheduleUrl ?? "";
    if (!portalUrl) {
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "URL portail Canada manquante dans la configuration",
      });
      return "error";
    }

    const baseUrl = extractBaseUrl(portalUrl);

    const { browser, page } = await launchBrowser({
      locale: "en-CA",
      timezoneId: "America/Toronto",
      acceptLanguage: "en-CA,en;q=0.9,fr;q=0.8",
    });

    try {
      // ── 1. Login ────────────────────────────────────────────────────────────
      const loginResult = await loginVfsIrcc(page, job);
      if (loginResult !== "ok") {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: loginResult === "captcha" ? "CAPTCHA VFS IRCC — retry" : "Échec login VFS IRCC (identifiants ?) ",
        });
        return loginResult === "captcha" ? "captcha" : "login_failed";
      }

      await humanScroll(page);
      await randomDelay(1500, 2500);

      // ── 2. Naviguer vers la page SelectVAC ─────────────────────────────────
      const scheduleUrl = `${baseUrl}/Home/SelectVAC?q=dePiaPfL2MJ7yDPEmQRU6fRZbx3aIpSal6PdG3Bxqq7rSNU6HabciCVot9dEwkhd`;
      console.log(`[canada] Navigation SelectVAC: ${scheduleUrl}`);
      await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await randomDelay(1500, 2500);

      const csrfToken = await extractCsrfToken(page);
      if (!csrfToken) {
        console.warn("[canada] Token CSRF introuvable — page inattendue ?");
        botLog({
          applicationId: job.id,
          step: "select_vac",
          status: "warn",
          data: { url: page.url(), flow: "canada" },
        });
      }

      // ── 3. Vérification quotas (CheckSeatAllotment) ─────────────────────────
      const seatMsg = await checkSeatAllotment(page, baseUrl, csrfToken);
      if (seatMsg) {
        botLog({
          applicationId: job.id,
          step: "seat_allotment",
          status: "ok",
          data: { message: seatMsg, flow: "canada" },
        });
      }

      // ── 4. Requête GetEarliestVisaSlotDate ──────────────────────────────────
      const noApplicants =
        typeof job.hunterConfig.portalApplicationId === "string" &&
        !isNaN(parseInt(job.hunterConfig.portalApplicationId))
          ? parseInt(job.hunterConfig.portalApplicationId)
          : DEFAULT_NO_APPLICANTS;

      const slotData = await getEarliestSlotDate(page, baseUrl, csrfToken, noApplicants);

      botLog({
        applicationId: job.id,
        step: "earliest_slot_check",
        status: "ok",
        data: { slotData: slotData ?? null, flow: "canada" },
      });

      console.log(
        `[canada] GetEarliestVisaSlotDate → Standard: "${slotData?.StandardDateDisplay}" | Prime: "${slotData?.PrimeDateDisplay}"`,
      );

      // Détecter si un créneau standard ou prime est disponible
      const standardAvailable = isSlotDate(slotData?.StandardDateDisplay);
      const primeAvailable = isSlotDate(slotData?.PrimeDateDisplay);

      if (!standardAvailable && !primeAvailable) {
        console.log("[canada] Aucun créneau disponible (standard + prime)");
        await sendHeartbeat({ applicationId: job.id, result: "not_found" });
        await logoutVfsIrcc(page, baseUrl);
        return "not_found";
      }

      const availableDate = standardAvailable
        ? (slotData?.StandardDateDisplay as string)
        : (slotData?.PrimeDateDisplay as string);

      console.log(`[canada] 🚨 CRÉNEAU DÉTECTÉ : ${availableDate}`);
      botLog({
        applicationId: job.id,
        step: "slot_detected",
        status: "ok",
        data: { date: availableDate, isPrime: !standardAvailable, flow: "canada" },
      });

      // ── 5. Capture screenshot de preuve ────────────────────────────────────
      const screenshotStorageId = await captureAndUpload(page);

      // ── 6. Tentative de réservation automatique ─────────────────────────────
      let confirmationCode: string | null = null;
      let finalDate = availableDate;
      let finalTime = "09:00";
      let location = "Canada VAC — Kinshasa";

      try {
        // Naviguer vers le calendrier
        const calOk = await navigateToCalendar(page, baseUrl);
        if (calOk) {
          // Gérer la page de liste des candidats si elle apparaît
          await handleApplicantListPage(page, job);

          // Sélectionner le premier créneau disponible
          const slot = await selectFirstAvailableSlot(page);
          if (slot) {
            finalDate = slot.date || availableDate;
            finalTime = slot.time;

            // Capturer screenshot calendrier
            const calScreenshot = await captureAndUpload(page);
            if (calScreenshot) {
              botLog({
                applicationId: job.id,
                step: "calendar_slot_selected",
                status: "ok",
                data: { date: finalDate, time: finalTime, flow: "canada" },
              });
            }

            // Confirmer
            confirmationCode = await confirmAppointment(page);
            if (confirmationCode) {
              console.log(`[canada] ✅ RDV confirmé — ref: ${confirmationCode}`);
              botLog({
                applicationId: job.id,
                step: "appointment_confirmed",
                status: "ok",
                data: { ref: confirmationCode, flow: "canada" },
              });

              // Capturer screenshot + PDF de confirmation
              const confirmScreenshot = await captureAndUpload(page);
              const pdfStorageId = await captureConfirmationPdf(page);
              if (pdfStorageId) {
                await attachConfirmationDoc({
                  applicationId: job.id,
                  storageId: pdfStorageId,
                  docKey: "booking_confirmation_pdf",
                  label: "Confirmation de rendez-vous Canada (PDF)",
                });
              }

              await reportSlotFound({
                applicationId: job.id,
                date: finalDate,
                time: finalTime,
                location,
                confirmationCode,
                screenshotStorageId: confirmScreenshot ?? screenshotStorageId,
              });

              await logoutVfsIrcc(page, baseUrl);
              return "slot_found";
            }
          }
        }
      } catch (bookingErr) {
        console.warn("[canada] Erreur tentative réservation (non bloquant):", bookingErr);
        botLog({
          applicationId: job.id,
          step: "booking_attempt",
          status: "warn",
          data: {
            error: bookingErr instanceof Error ? bookingErr.message : String(bookingErr),
            flow: "canada",
          },
        });
      }

      // ── 7. Reporter le slot même si booking auto échoué ────────────────────
      // Le créneau a été détecté via GetEarliestVisaSlotDate → on le signale
      await reportSlotFound({
        applicationId: job.id,
        date: finalDate,
        time: finalTime,
        location,
        confirmationCode: confirmationCode ?? undefined,
        screenshotStorageId,
      });

      await logoutVfsIrcc(page, baseUrl);
      return "slot_found";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[canada] Erreur session ${job.applicantName}:`, msg);
      botLog({
        applicationId: job.id,
        step: "session_error",
        status: "fail",
        data: { error: msg.slice(0, 300), flow: "canada" },
      });
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: msg.slice(0, 200),
        });
      } catch { /* ignore */ }
      return "error";
    } finally {
      try { await browser.close(); } catch { /* ignore */ }
    }
  })();

  return withTimeout(sessionPromise, 8 * 60_000);
}
