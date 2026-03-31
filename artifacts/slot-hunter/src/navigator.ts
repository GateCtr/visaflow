import type { Browser, Page } from "playwright";
import { launchBrowser, humanType, humanClick, humanScroll, randomDelay, isDryRun } from "./browser.js";
import { detectAndSolveCaptcha } from "./captcha.js";
import { reportSlotFound, sendHeartbeat, uploadScreenshot, type HunterJob } from "./convexClient.js";

const SESSION_TIMEOUT_MS = 5 * 60 * 1000;

export type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed";

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

async function scanForAvailableSlots(
  page: Page,
  job: HunterJob
): Promise<SlotInfo | null> {
  const scheduleUrl =
    job.hunterConfig.scheduleUrl ??
    job.portalScheduleUrl ??
    job.portalAppointmentUrl ??
    "";

  if (scheduleUrl) {
    console.log(`[navigator] Navigating to schedule page: ${scheduleUrl}`);
    await page.goto(scheduleUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randomDelay(2000, 4000);
  }

  await humanScroll(page);
  await randomDelay(1000, 2000);

  const responseCapture: { url: string; body: unknown }[] = [];
  page.on("response", async (response) => {
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
  });

  await randomDelay(2000, 3000);

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

export async function runHunterSession(job: HunterJob): Promise<SessionResult> {
  if (isDryRun()) {
    console.log(`[navigator] DRY_RUN mode — simulating session for ${job.applicantName}`);
    await randomDelay(2000, 4000);
    return "not_found";
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

      const slot = await scanForAvailableSlots(page, job);

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
    return await withTimeout(sessionPromise, SESSION_TIMEOUT_MS);
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
