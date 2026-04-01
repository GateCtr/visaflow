import type { Browser, Page } from "playwright";
import { launchBrowser, humanType, humanClick, humanScroll, randomDelay, isDryRun } from "./browser.js";
import { detectAndSolveCaptcha } from "./captcha.js";
import { reportSlotFound, sendHeartbeat, uploadScreenshot, reportBotTestResult, type HunterJob, type BotTest } from "./convexClient.js";
import { runUsaApiSession, getUsaSession } from "./usaPortal.js";

function getSessionTimeoutMs(): number {
  return Math.round((3 + Math.random() * 2) * 60 * 1000);
}

export type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

interface SlotInfo {
  date: string;
  time: string;
  location: string;
  confirmationCode?: string;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Session timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function loginToPortal(
  page: Page,
  job: HunterJob
): Promise<"ok" | "captcha" | "failed"> {
  const loginUrl = job.portalUrl ?? job.hunterConfig.scheduleUrl ?? "";
  if (!loginUrl) throw new Error("No portal URL configured for this job");

  console.log(`[navigator] Navigating to login: ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await randomDelay(1500, 3000);

  const captchaResult = await detectAndSolveCaptcha(page, job.hunterConfig.twoCaptchaApiKey);
  if (captchaResult === "no_key") return "captcha";
  if (captchaResult === "failed") return "captcha";

  const usernameSelector = [
    'input[name="username"]',
    'input[type="email"]',
    'input[placeholder*="Email"]',
    'input[placeholder*="Username"]',
    '#username',
    '#email',
  ].join(", ");

  const passwordSelector = [
    'input[name="password"]',
    'input[type="password"]',
    '#password',
  ].join(", ");

  try {
    await page.waitForSelector(usernameSelector, { timeout: 10000 });
  } catch {
    console.error("[navigator] Login form not found");
    return "failed";
  }

  await humanScroll(page);
  await randomDelay(500, 1200);

  await humanType(page, usernameSelector, job.hunterConfig.embassyUsername);
  await randomDelay(400, 900);
  await humanType(page, passwordSelector, job.hunterConfig.embassyPassword);
  await randomDelay(600, 1500);

  await page.mouse.move(
    200 + Math.random() * 100,
    300 + Math.random() * 100,
    { steps: 8 }
  );
  await randomDelay(300, 700);

  const submitSelector = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("SIGN IN")',
    'button:has-text("Login")',
    'button:has-text("Se connecter")',
    '.login-btn',
  ].join(", ");

  await humanClick(page, submitSelector);
  await randomDelay(2000, 4000);

  const postSubmitCaptcha = await detectAndSolveCaptcha(page, job.hunterConfig.twoCaptchaApiKey);
  if (postSubmitCaptcha === "no_key" || postSubmitCaptcha === "failed") {
    console.warn("[navigator] CAPTCHA appeared after submit — not login failure");
    return "captcha";
  }
  if (postSubmitCaptcha === "solved") {
    await randomDelay(1500, 3000);
  }

  const currentUrl = page.url();
  if (
    currentUrl.includes("login") &&
    !currentUrl.includes("dashboard") &&
    !currentUrl.includes("home")
  ) {
    const errorVisible = await page.evaluate(() => {
      const errs = document.querySelectorAll(".error, .alert-danger, [class*='error'], [class*='invalid']");
      return errs.length > 0;
    });
    if (errorVisible) {
      console.warn("[navigator] Login error message visible — wrong credentials?");
      return "failed";
    }
  }

  console.log(`[navigator] Login appears successful (URL: ${page.url()})`);
  return "ok";
}

async function detectPaymentBarrier(page: Page, destination: string): Promise<string | null> {
  const currentUrl = page.url().toLowerCase();

  const paymentUrls = ["payment", "/pay", "checkout", "billing", "fee-required", "outstanding"];
  if (paymentUrls.some((kw) => currentUrl.includes(kw))) {
    console.warn(`[navigator] URL de paiement détectée : ${page.url()}`);
    return "URL portail redirigée vers une page de paiement";
  }

  const barrier = await page.evaluate((dest: string) => {
    const text = (document.body?.innerText ?? "").toLowerCase();

    const genericKeywords = [
      "payment required",
      "pay the visa fee",
      "fee not paid",
      "outstanding fee",
      "outstanding balance",
      "make payment",
      "complete payment",
      "proceed to payment",
      "pay now to continue",
      "you must pay",
      "fee payment pending",
      "payer les frais",
      "paiement requis",
      "frais non payés",
      "frais consulaires",
      "règlement requis",
    ];

    const usaKeywords = [
      "mrv receipt not found",
      "mrv fee",
      "receipt not valid",
      "pay the mrv fee",
      "visa fee receipt",
      "fee receipt required",
    ];

    const vfsKeywords = [
      "service fee required",
      "vfs fee",
      "pay service charge",
      "service charge required",
    ];

    const keywords =
      dest === "usa"
        ? [...genericKeywords, ...usaKeywords]
        : dest === "turkey"
          ? [...genericKeywords, ...vfsKeywords]
          : genericKeywords;

    for (const kw of keywords) {
      if (text.includes(kw)) return kw;
    }
    return null;
  }, destination);

  if (barrier) {
    console.warn(`[navigator] Barrière de paiement portail détectée : "${barrier}"`);
    return `Frais de service requis par le portail (détection : "${barrier}")`;
  }

  return null;
}

async function scanForAvailableSlots(
  page: Page,
  job: HunterJob
): Promise<SlotInfo | null | "captcha"> {
  const scheduleUrl =
    job.hunterConfig.scheduleUrl ??
    job.portalScheduleUrl ??
    job.portalAppointmentUrl ??
    "";

  const responseCapture: { url: string; body: unknown }[] = [];
  const responseHandler = async (response: import("playwright").Response) => {
    const url = response.url();
    if (
      (url.includes("slot") ||
        url.includes("appointment") ||
        url.includes("available") ||
        url.includes("schedule") ||
        url.includes("date")) &&
      response.headers()["content-type"]?.includes("json")
    ) {
      try {
        const body = await response.json() as unknown;
        responseCapture.push({ url, body });
      } catch { /* ignore */ }
    }
  };

  page.on("response", responseHandler);

  if (scheduleUrl) {
    console.log(`[navigator] Navigating to schedule page: ${scheduleUrl}`);
    await page.goto(scheduleUrl, { waitUntil: "networkidle", timeout: 30000 });
    await randomDelay(2000, 4000);
  }

  const scheduleCaptcha = await detectAndSolveCaptcha(page, job.hunterConfig.twoCaptchaApiKey);
  if (scheduleCaptcha === "no_key" || scheduleCaptcha === "failed") {
    console.warn("[navigator] CAPTCHA on schedule page — signaling captcha result");
    return "captcha";
  }

  await humanScroll(page);
  await randomDelay(1000, 2000);

  await randomDelay(1500, 2500);

  for (const capture of responseCapture) {
    console.log(`[navigator] Intercepted API: ${capture.url}`);
    const slot = parseSlotFromApiResponse(capture.body);
    if (slot) {
      console.log(`[navigator] Slot found via API: ${slot.date} ${slot.time}`);
      return slot;
    }
  }

  const domSlot = await parseSlotsFromDom(page);
  return domSlot;
}

function parseSlotFromApiResponse(body: unknown): SlotInfo | null {
  if (!body || typeof body !== "object") return null;

  const candidates = Array.isArray(body) ? body : [body];

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;

    const date = obj.date ?? obj.appointmentDate ?? obj.slotDate ?? obj.availableDate;
    const time = obj.time ?? obj.appointmentTime ?? obj.slotTime ?? obj.startTime;
    const location = obj.location ?? obj.embassy ?? obj.office ?? obj.center ?? "Embassy";

    if (typeof date === "string" && date.length > 0) {
      return {
        date: String(date),
        time: typeof time === "string" ? time : "09:00",
        location: typeof location === "string" ? location : "Embassy",
        confirmationCode:
          typeof obj.confirmationCode === "string" ? obj.confirmationCode :
          typeof obj.referenceNumber === "string" ? obj.referenceNumber :
          typeof obj.bookingRef === "string" ? obj.bookingRef :
          undefined,
      };
    }

    if (Array.isArray(obj.slots) && obj.slots.length > 0) {
      return parseSlotFromApiResponse(obj.slots[0]);
    }
    if (Array.isArray(obj.availableDates) && obj.availableDates.length > 0) {
      return parseSlotFromApiResponse(obj.availableDates[0]);
    }
    if (Array.isArray(obj.data)) {
      const sub = parseSlotFromApiResponse(obj.data);
      if (sub) return sub;
    }
  }

  return null;
}

async function parseSlotsFromDom(page: Page): Promise<SlotInfo | null> {
  return await page.evaluate(() => {
    const dateSelectors = [
      "[data-date]",
      ".available-date",
      ".slot-available",
      ".calendar-day:not(.disabled):not(.past)",
      "td.available",
      "[class*='available'][class*='date']",
    ];

    for (const sel of dateSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const dateStr =
          el.getAttribute("data-date") ??
          el.getAttribute("data-value") ??
          el.textContent?.trim() ??
          "";
        if (dateStr) {
          return {
            date: dateStr,
            time: "09:00",
            location: "Embassy",
          };
        }
      }
    }

    return null;
  });
}

async function captureAndUploadScreenshot(page: Page): Promise<string | null> {
  try {
    const screenshotBuffer = await page.screenshot({ fullPage: false, type: "png" });
    const base64 = screenshotBuffer.toString("base64");
    console.log(`[navigator] Screenshot captured (${Math.round(base64.length / 1024)}kb) — uploading...`);
    const storageId = await uploadScreenshot(base64);
    if (storageId) {
      console.log(`[navigator] Screenshot uploaded → storageId: ${storageId}`);
    } else {
      console.warn("[navigator] Screenshot upload returned null storageId");
    }
    return storageId;
  } catch (e) {
    console.warn("[navigator] Screenshot capture/upload failed:", e);
    return null;
  }
}

async function logoutFromPortal(page: Page): Promise<void> {
  try {
    const logoutSelectors = [
      'a[href*="logout"]',
      'button:has-text("Logout")',
      'button:has-text("Sign Out")',
      'a:has-text("Logout")',
      'a:has-text("Sign Out")',
      '[data-action="logout"]',
    ];

    for (const sel of logoutSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await randomDelay(1000, 2000);
        console.log("[navigator] Logged out successfully");
        return;
      }
    }

    console.log("[navigator] No logout button found — closing session directly");
  } catch (e) {
    console.warn("[navigator] Logout failed (non-critical):", e);
  }
}

export async function runBotTestSession(test: BotTest): Promise<void> {
  console.log(`[navigator] Bot test démarré — ${test.destination} (${test.portalUrl})`);

  if (isDryRun()) {
    console.log(`[navigator] DRY_RUN — simulation test bot`);
    await randomDelay(1000, 2000);
    await reportBotTestResult({
      testId: test._id,
      result: "login_success",
      latencyMs: 1500,
      httpStatus: 200,
    });
    return;
  }

  const startMs = Date.now();

  if (!test.testUsername || !test.testPassword) {
    const browserRef: { current: Browser | null } = { current: null };
    try {
      const { browser: b, page } = await launchBrowser();
      browserRef.current = b;

      console.log(`[navigator] Test ping portail: ${test.portalUrl}`);
      let httpStatus: number | undefined;
      let ok = false;

      try {
        const res = await page.goto(test.portalUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
        httpStatus = res?.status() ?? undefined;
        ok = httpStatus !== undefined && httpStatus < 500;
      } catch (e) {
        console.warn(`[navigator] Impossible de charger le portail: ${e}`);
      }

      const latencyMs = Date.now() - startMs;
      const result = ok ? "portal_ok" : "portal_unreachable";

      console.log(`[navigator] Test ping terminé — ${result} (${latencyMs}ms, HTTP ${httpStatus ?? "N/A"})`);

      await reportBotTestResult({
        testId: test._id,
        result,
        latencyMs,
        httpStatus,
        errorMessage: ok ? undefined : "Portail inaccessible depuis le bot",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await reportBotTestResult({
        testId: test._id,
        result: "error",
        latencyMs: Date.now() - startMs,
        errorMessage: msg.slice(0, 200),
      });
    } finally {
      try { await browserRef.current?.close(); } catch { /* ignore */ }
    }
    return;
  }

  // ─── USA : login API directe (sans navigateur, sans 2captcha) ─────────────
  if (test.destination === "usa") {
    console.log(`[navigator] Test USA → login API directe`);
    try {
      const session = await getUsaSession(
        test.testUsername!,
        test.testPassword!,
        test.twoCaptchaApiKey
      );
      const latencyMs = Date.now() - startMs;

      if (session) {
        console.log(`[navigator] Test USA RÉUSSI — connecté en tant que ${session.fullName} (${latencyMs}ms)`);
        await reportBotTestResult({
          testId: test._id,
          result: "login_success",
          latencyMs,
          httpStatus: 200,
        });
      } else {
        console.warn(`[navigator] Test USA échoué — API login null`);
        await reportBotTestResult({
          testId: test._id,
          result: "login_failed",
          latencyMs,
          errorMessage: "Identifiants incorrects ou CAPTCHA requis (résolution 2captcha échouée)",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[navigator] Erreur test USA:`, msg);
      await reportBotTestResult({
        testId: test._id,
        result: "login_failed",
        latencyMs: Date.now() - startMs,
        errorMessage: msg.slice(0, 600),
      });
    }
    return;
  }

  // ─── Autres destinations : Playwright browser login ─────────────────────
  const jobLike: HunterJob = {
    id: `bot-test-${test._id}`,
    destination: test.destination,
    visaType: "test",
    applicantName: `[TEST] ${test.destination}`,
    travelDate: "",
    urgencyTier: "standard",
    slotBookingRefs: null,
    hunterConfig: {
      embassyUsername: test.testUsername!,
      embassyPassword: test.testPassword!,
      isActive: true,
      twoCaptchaApiKey: test.twoCaptchaApiKey,
    },
    portalUrl: test.portalUrl,
    portalName: test.portalName,
    portalDashboardUrl: null,
    portalAppointmentUrl: null,
    portalScheduleUrl: null,
    lastCheckAt: null,
  };

  const browserRef: { current: Browser | null } = { current: null };

  try {
    const { browser: b, page } = await launchBrowser();
    browserRef.current = b;

    const loginResult = await loginToPortal(page, jobLike);
    const latencyMs = Date.now() - startMs;

    let result: string;
    let errorMessage: string | undefined;

    if (loginResult === "ok") {
      result = "login_success";
      console.log(`[navigator] Test connexion RÉUSSI — ${test.destination} (${latencyMs}ms)`);
    } else if (loginResult === "captcha") {
      result = "captcha";
      errorMessage = "CAPTCHA détecté — vérification impossible";
      console.warn(`[navigator] CAPTCHA lors du test ${test.destination}`);
    } else {
      result = "login_failed";
      errorMessage = "Identifiants incorrects ou portail indisponible";
      console.warn(`[navigator] Échec login test ${test.destination}`);
    }

    await reportBotTestResult({
      testId: test._id,
      result,
      latencyMs,
      errorMessage,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[navigator] Erreur test bot ${test.destination}:`, msg);
    await reportBotTestResult({
      testId: test._id,
      result: "error",
      latencyMs: Date.now() - startMs,
      errorMessage: msg.slice(0, 200),
    });
  } finally {
    try { await browserRef.current?.close(); } catch { /* ignore */ }
  }
}

export async function runHunterSession(job: HunterJob): Promise<SessionResult> {
  if (isDryRun()) {
    console.log(`[navigator] DRY_RUN mode — simulating session for ${job.applicantName}`);
    await randomDelay(2000, 4000);
    return "not_found";
  }

  if (job.destination === "usa") {
    console.log(`[navigator] Destination USA → mode API directe (sans Playwright login)`);
    return runUsaApiSession(job);
  }

  const browserRef: { current: Browser | null } = { current: null };

  const sessionPromise = (async (): Promise<SessionResult> => {
    const { browser: b, page } = await launchBrowser();
    browserRef.current = b;

    try {
      console.log(`[navigator] Starting session for ${job.applicantName} (${job.destination})`);

      const loginResult = await loginToPortal(page, job);

      if (loginResult === "captcha") {
        await logoutFromPortal(page);
        await sendHeartbeat({ applicationId: job.id, result: "captcha" });
        return "captcha";
      }

      if (loginResult === "failed") {
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "error",
            errorMessage: "Login failed — credentials incorrect or portal unavailable",
          });
        } catch { /* ignore heartbeat errors */ }
        return "login_failed";
      }

      await humanScroll(page);
      await randomDelay(1500, 3000);

      const paymentBarrier = await detectPaymentBarrier(page, job.destination);
      if (paymentBarrier) {
        console.warn(`[navigator] 💳 Paiement portail requis pour ${job.applicantName} — arrêt session`);
        await logoutFromPortal(page);
        try {
          await sendHeartbeat({
            applicationId: job.id,
            result: "payment_required",
            errorMessage: paymentBarrier,
          });
        } catch { /* ignore heartbeat errors */ }
        return "payment_required";
      }

      const slot = await scanForAvailableSlots(page, job);

      if (slot === "captcha") {
        console.warn(`[navigator] CAPTCHA on schedule page for ${job.applicantName}`);
        await logoutFromPortal(page);
        await sendHeartbeat({ applicationId: job.id, result: "captcha" });
        return "captcha";
      }

      if (slot) {
        console.log(`[navigator] Slot FOUND for ${job.applicantName}: ${slot.date} ${slot.time}`);
        const screenshotId = await captureAndUploadScreenshot(page);

        await reportSlotFound({
          applicationId: job.id,
          date: slot.date,
          time: slot.time,
          location: slot.location,
          confirmationCode: slot.confirmationCode,
          screenshotStorageId: screenshotId ?? undefined,
        });

        await logoutFromPortal(page);
        return "slot_found";
      }

      console.log(`[navigator] No slot found for ${job.applicantName}`);
      await logoutFromPortal(page);
      await sendHeartbeat({ applicationId: job.id, result: "not_found" });
      return "not_found";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[navigator] Session error for ${job.applicantName}:`, msg);

      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: msg.slice(0, 200),
        });
      } catch { /* ignore */ }

      return "error";
    } finally {
      try {
        await browserRef.current?.close();
      } catch { /* ignore */ }
    }
  })();

  try {
    const sessionTimeoutMs = getSessionTimeoutMs();
    console.log(`[navigator] Session timeout set to ${Math.round(sessionTimeoutMs / 60000 * 10) / 10}min for ${job.applicantName}`);
    return await withTimeout(sessionPromise, sessionTimeoutMs);
  } catch (timeoutErr) {
    console.error(`[navigator] Session timed out for ${job.applicantName}`);
    try {
      await browserRef.current?.close();
    } catch { /* ignore */ }
    try {
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "Session timeout (>5min)",
      });
    } catch { /* ignore */ }
    return "error";
  }
}
