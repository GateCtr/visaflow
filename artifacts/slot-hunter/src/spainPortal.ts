import type { APIRequestContext, Page, Response } from "playwright";
import { detectAndSolveCaptcha } from "./captcha.js";
import { launchBrowser, randomDelay, humanScroll } from "./browser.js";
import { botLog, sendHeartbeat, reportSlotFound, requestOtpChallenge, consumeOtpCode, uploadScreenshot, type HunterJob } from "./convexClient.js";

type SessionResult = "slot_found" | "not_found" | "captcha" | "error" | "login_failed" | "payment_required";

interface SpainSlot {
  date: string;
  time: string;
  location: string;
  agendaId?: string;
}

interface SpainRuntimeContext {
  init: Record<string, unknown>;
  selectedServices: string[];
  selectedAgendas: string[];
  selectedPeople: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Spain session timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function parseJsonpPayload(text: string): unknown | null {
  const src = text.trim();
  if (!src) return null;

  // JSONP standard: callback({...}) ou callback([...]);
  const m = src.match(/^[\w$.]+\(([\s\S]*)\);?$/);
  if (!m) {
    try {
      return JSON.parse(src);
    } catch {
      return null;
    }
  }
  const payload = m[1].trim();
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function getBookititBaseFromUrl(u: string): string | null {
  const m = u.match(/^(https?:\/\/[^/]+\/.*?onlinebookings\/)/i);
  return m ? m[1] : null;
}

function firstMonthDayYmd(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function lastMonthDayYmd(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}

function toStringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
  }
  return out;
}

function collectIds(value: unknown, keyHint: RegExp): string[] {
  const out = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        walk(v);
        continue;
      }
      if ((typeof v === "string" || typeof v === "number") && keyHint.test(k)) {
        const s = String(v).trim();
        if (s.length > 0) out.add(s);
      }
    }
  };
  walk(value);
  return [...out];
}

async function callJsonp(
  req: APIRequestContext,
  endpointBase: string,
  endpoint: string,
  params: Record<string, string>,
): Promise<unknown | null> {
  const q = new URLSearchParams(params);
  q.set("callback", `cb${Date.now()}${Math.floor(Math.random() * 10_000)}`);
  q.set("_", String(Date.now()));
  const url = `${endpointBase}${endpoint}?${q.toString()}`;

  const res = await req.get(url, { timeout: 20_000 });
  if (!res.ok()) return null;
  const body = await res.text();
  return parseJsonpPayload(body);
}

async function getRuntimeContext(page: Page): Promise<SpainRuntimeContext> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const init = (w.bkt_init_widget && typeof w.bkt_init_widget === "object")
      ? (w.bkt_init_widget as Record<string, unknown>)
      : {};
    const ocv = (w.oClientValues_248295 && typeof w.oClientValues_248295 === "object")
      ? (w.oClientValues_248295 as Record<string, unknown>)
      : {};

    const extract = (arr: unknown): string[] => {
      if (!Array.isArray(arr)) return [];
      const out: string[] = [];
      for (const item of arr) {
        if (!item || typeof item !== "object") continue;
        const obj = item as Record<string, unknown>;
        const attrs = (obj.attributes && typeof obj.attributes === "object")
          ? (obj.attributes as Record<string, unknown>)
          : {};
        const candidates = [
          obj.id, obj.service_id, obj.services_id, obj.agenda_id, obj.agendas_id, obj.value,
          attrs.id, attrs.service_id, attrs.services_id, attrs.agenda_id, attrs.agendas_id, attrs.value,
        ];
        for (const c of candidates) {
          if (typeof c === "string" || typeof c === "number") {
            out.push(String(c));
            break;
          }
        }
      }
      return [...new Set(out)];
    };

    const selectedServices = extract(ocv.selectedServices);
    const selectedAgendas = extract(ocv.selectedAgendas);
    const selectedPeopleRaw = ocv.selectedPeople;
    const selectedPeople = typeof selectedPeopleRaw === "number" && selectedPeopleRaw > 0 ? selectedPeopleRaw : 1;

    return { init, selectedServices, selectedAgendas, selectedPeople };
  });
}

function extractSlotFromBookititPayload(payload: unknown): SpainSlot | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  if (Array.isArray(obj.Slots)) {
    for (const day of obj.Slots) {
      if (!day || typeof day !== "object") continue;
      const dayObj = day as Record<string, unknown>;
      const date = typeof dayObj.date === "string" ? dayObj.date : "";
      const agenda = typeof dayObj.agenda === "string" ? dayObj.agenda : "citaconsular";
      const agendaId =
        typeof dayObj.agenda === "string"
          ? dayObj.agenda
          : typeof dayObj.agenda_id === "string" || typeof dayObj.agenda_id === "number"
            ? String(dayObj.agenda_id)
            : undefined;
      const times = dayObj.times;
      if (!times || typeof times !== "object") continue;

      for (const v of Object.values(times as Record<string, unknown>)) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;
        const free = typeof t.freeslots === "number" ? t.freeslots : undefined;
        const totals = typeof t.totalslots === "number" ? t.totalslots : undefined;
        const hasAvailability = (free !== undefined && free > 0) || (totals !== undefined && totals > 0);
        if (!hasAvailability) continue;

        const time = typeof t.time === "string" ? t.time : "09:00";
        if (date) return { date, time, location: agenda, agendaId };
      }
    }
  }

  return null;
}

async function detectSlotInDom(page: Page): Promise<SpainSlot | null> {
  return page.evaluate(() => {
    const slot = document.querySelector(".clsDivDatetimeSlot, [data-datetime], [class*='slot'][class*='available']");
    if (!slot) return null;
    const text = (slot.textContent ?? "").trim();
    if (!text) return { date: "unknown", time: "unknown", location: "citaconsular" };
    return { date: "unknown", time: text.slice(0, 40), location: "citaconsular" };
  });
}

async function captureAndUpload(page: Page): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    const storageId = await uploadScreenshot(buf.toString("base64"));
    return storageId ?? undefined;
  } catch {
    return undefined;
  }
}

async function waitForOtpFromConvex(applicationId: string, timeoutMs = 90_000): Promise<string | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await consumeOtpCode({ applicationId, flow: "spain" });
    if (r.status === "ok") return r.code;
    if (r.status === "expired") return null;
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  return null;
}

type BookingAttempt =
  | { status: "booked"; note: string }
  | { status: "otp_required"; note: string }
  | { status: "payment_required"; note: string }
  | { status: "failed"; note: string };

async function tryAutoBookSpainSlot(page: Page, job: HunterJob, slot: SpainSlot): Promise<BookingAttempt> {
  const login = job.hunterConfig.embassyUsername?.trim();
  const password = job.hunterConfig.embassyPassword?.trim();
  if (!login || !password) {
    return { status: "failed", note: "credentials_missing" };
  }

  const current = page.url();
  const base = current.includes("#") ? current.slice(0, current.indexOf("#")) : current;
  const agendaPart = slot.agendaId ? `/${encodeURIComponent(slot.agendaId)}` : "";
  const target = `${base}#selecttime/${encodeURIComponent(slot.date)}/${encodeURIComponent(slot.time)}${agendaPart}`;

  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await randomDelay(1200, 2200);
  } catch {
    return { status: "failed", note: "selecttime_navigation_failed" };
  }

  // Écran signin typique du bundle Bookitit.
  const signInInput = page.locator("#idIptBktSignInlogin");
  const signInPass = page.locator("#idIptBktSignInpassword");
  const signInBtn = page.locator("#idBktDefaultSignInConfirmButton");
  if ((await signInInput.count()) > 0 && (await signInPass.count()) > 0) {
    await signInInput.first().fill(login);
    await signInPass.first().fill(password);
    if ((await signInBtn.count()) > 0) {
      await signInBtn.first().click().catch(() => undefined);
    }
    await randomDelay(1800, 3200);
  }

  const hash = await page.evaluate(() => window.location.hash || "");
  if (hash.includes("confirmclient")) {
    const directOtp = process.env.SPAIN_OTP_CODE?.trim();
    let otp = directOtp || "";
    if (!otp) {
      await requestOtpChallenge({
        applicationId: job.id,
        flow: "spain",
        channel: "telegram",
        ttlMs: 120_000,
      });
      otp = (await waitForOtpFromConvex(job.id, 120_000)) ?? "";
    }
    if (!otp) {
      return { status: "otp_required", note: "otp_code_missing" };
    }
    const otpInput = page.locator("#idIptBktValidateCode");
    const otpBtn = page.locator("#idDivBktConfirmClientValidateButton .clsDivContinueButton");
    if ((await otpInput.count()) > 0) {
      await otpInput.first().fill(otp);
      if ((await otpBtn.count()) > 0) {
        await otpBtn.first().click().catch(() => undefined);
      }
      await randomDelay(1200, 2500);
    }
  }

  const finalHash = await page.evaluate(() => window.location.hash || "");
  if (finalHash.includes("summary")) {
    return { status: "booked", note: "summary_reached" };
  }
  if (finalHash.includes("creditcardcapture") || finalHash.includes("selectpaymentgateway")) {
    return { status: "payment_required", note: "payment_step_reached" };
  }
  if (finalHash.includes("confirmclient")) {
    return { status: "otp_required", note: "otp_confirmation_pending" };
  }
  return { status: "failed", note: `unexpected_hash:${finalHash || "none"}` };
}

async function tryApiFirstSlot(
  page: Page,
  endpointBase: string,
  runtime: SpainRuntimeContext,
): Promise<SpainSlot | null> {
  const req = page.context().request;
  const initParams = toStringMap(runtime.init);

  // 1) Bootstrap config (souvent nécessaire côté serveur pour initialiser bktToken/session)
  await callJsonp(req, endpointBase, "getwidgetconfigurations/", initParams).catch(() => null);

  // 2) Services
  const servicesPayload = await callJsonp(req, endpointBase, "getservices/", {
    ...initParams,
    services: runtime.selectedServices.join(","),
    selectedPeople: String(runtime.selectedPeople),
  });

  let services = runtime.selectedServices;
  if (services.length === 0) {
    services = collectIds(servicesPayload, /(service.*id|services.*id|^id$)/i).slice(0, 3);
  }

  // 3) Agendas
  const agendasPayload = await callJsonp(req, endpointBase, "getagendas/", {
    ...initParams,
    services: services.join(","),
    selectedPeople: String(runtime.selectedPeople),
  });

  let agendas = runtime.selectedAgendas;
  if (agendas.length === 0) {
    agendas = collectIds(agendasPayload, /(agenda.*id|agendas.*id|^id$)/i).slice(0, 5);
  }

  if (services.length === 0 || agendas.length === 0) {
    return null;
  }

  // 4) Datetime scan rapide (mois courant + 2 suivants)
  const baseDate = new Date();
  for (let i = 0; i < 3; i++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1);
    const payload = await callJsonp(req, endpointBase, "datetime/", {
      ...initParams,
      services: services.join(","),
      agendas: agendas.join(","),
      start: firstMonthDayYmd(d),
      end: lastMonthDayYmd(d),
      selectedPeople: String(runtime.selectedPeople),
    });
    const slot = extractSlotFromBookititPayload(payload);
    if (slot) return slot;
  }

  return null;
}

export async function runSpainSession(job: HunterJob): Promise<SessionResult> {
  const sessionPromise = (async (): Promise<SessionResult> => {
    const url = job.portalUrl ?? job.hunterConfig.scheduleUrl ?? "";
    if (!url) {
      botLog({
        applicationId: job.id,
        step: "login",
        status: "fail",
        data: { reason: "missing_portal_url", flow: "spain" },
      });
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: "URL portail Espagne manquante",
      });
      return "error";
    }

    const { browser, page } = await launchBrowser();
    botLog({
      applicationId: job.id,
      step: "login",
      status: "ok",
      data: { url, flow: "spain" },
    });
    const payloadHits: unknown[] = [];
    const bookititBases = new Set<string>();
    const responseHandler = async (res: Response): Promise<void> => {
      const u = res.url();
      const base = getBookititBaseFromUrl(u);
      if (base) bookititBases.add(base);
      if (!u.includes("datetime/")) return;
      try {
        const body = await res.text();
        const parsed = parseJsonpPayload(body);
        if (parsed) payloadHits.push(parsed);
      } catch {
        // ignore
      }
    };
    page.on("response", responseHandler);

    try {
      console.log(`[spain] Navigation: ${url}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await randomDelay(1500, 3000);
      botLog({
        applicationId: job.id,
        step: "login",
        status: "ok",
        data: { currentUrl: page.url(), flow: "spain" },
      });

      const captcha = await detectAndSolveCaptcha(page, job.hunterConfig.twoCaptchaApiKey);
      if (captcha === "no_key" || captcha === "failed") {
        botLog({
          applicationId: job.id,
          step: "captcha",
          status: "warn",
          data: { result: captcha, flow: "spain" },
        });
        await sendHeartbeat({ applicationId: job.id, result: "captcha" });
        return "captcha";
      }
      botLog({
        applicationId: job.id,
        step: "captcha",
        status: "ok",
        data: { result: captcha, flow: "spain" },
      });

      await humanScroll(page);
      await randomDelay(2500, 4500);

      // API-first (rapide) : utiliser directement les endpoints Bookitit si base détectée.
      if (bookititBases.size > 0) {
        botLog({
          applicationId: job.id,
          step: "scan",
          status: "ok",
          data: { bases: [...bookititBases], strategy: "api_first", flow: "spain" },
        });
        const runtime = await getRuntimeContext(page);
        for (const base of bookititBases) {
          const apiSlot = await tryApiFirstSlot(page, base, runtime).catch(() => null);
          if (!apiSlot) continue;
          botLog({
            applicationId: job.id,
            step: "slots_found",
            status: "ok",
            data: { base, date: apiSlot.date, time: apiSlot.time, location: apiSlot.location, strategy: "api_first", flow: "spain" },
          });
          const booking = await tryAutoBookSpainSlot(page, job, apiSlot);
          if (booking.status === "otp_required") {
            await sendHeartbeat({
              applicationId: job.id,
              result: "payment_required",
              errorMessage: "OTP requis (email/SMS) pour finaliser le booking Espagne",
            });
            return "payment_required";
          }
          if (booking.status === "payment_required") {
            await sendHeartbeat({
              applicationId: job.id,
              result: "payment_required",
              errorMessage: "Étape paiement requise pour finaliser le booking Espagne",
            });
            return "payment_required";
          }
          const screenshotStorageId = await captureAndUpload(page);
          await reportSlotFound({
            applicationId: job.id,
            date: apiSlot.date,
            time: apiSlot.time,
            location: `Espagne / ${apiSlot.location} (${booking.note})`,
            screenshotStorageId,
          });
          return "slot_found";
        }
      }

      // Fallback 1 : payloads datetime interceptés en navigation.
      botLog({
        applicationId: job.id,
        step: "scan",
        status: "ok",
        data: { payloadCount: payloadHits.length, strategy: "fallback_network", flow: "spain" },
      });
      for (const p of payloadHits) {
        const slot = extractSlotFromBookititPayload(p);
        if (!slot) continue;
        botLog({
          applicationId: job.id,
          step: "slots_found",
          status: "ok",
          data: { date: slot.date, time: slot.time, location: slot.location, strategy: "fallback_network", flow: "spain" },
        });
        const booking = await tryAutoBookSpainSlot(page, job, slot);
        if (booking.status === "otp_required") {
          await sendHeartbeat({
            applicationId: job.id,
            result: "payment_required",
            errorMessage: "OTP requis (email/SMS) pour finaliser le booking Espagne",
          });
          return "payment_required";
        }
        if (booking.status === "payment_required") {
          await sendHeartbeat({
            applicationId: job.id,
            result: "payment_required",
            errorMessage: "Étape paiement requise pour finaliser le booking Espagne",
          });
          return "payment_required";
        }
        const screenshotStorageId = await captureAndUpload(page);
        await reportSlotFound({
          applicationId: job.id,
          date: slot.date,
          time: slot.time,
          location: `Espagne / ${slot.location} (${booking.note})`,
          screenshotStorageId,
        });
        return "slot_found";
      }

      // Fallback 2 : DOM.
      botLog({
        applicationId: job.id,
        step: "scan",
        status: "ok",
        data: { strategy: "fallback_dom", flow: "spain" },
      });
      const domSlot = await detectSlotInDom(page);
      if (domSlot) {
        botLog({
          applicationId: job.id,
          step: "slots_found",
          status: "ok",
          data: { date: domSlot.date, time: domSlot.time, location: domSlot.location, strategy: "fallback_dom", flow: "spain" },
        });
        const booking = await tryAutoBookSpainSlot(page, job, domSlot);
        if (booking.status === "otp_required") {
          await sendHeartbeat({
            applicationId: job.id,
            result: "payment_required",
            errorMessage: "OTP requis (email/SMS) pour finaliser le booking Espagne",
          });
          return "payment_required";
        }
        if (booking.status === "payment_required") {
          await sendHeartbeat({
            applicationId: job.id,
            result: "payment_required",
            errorMessage: "Étape paiement requise pour finaliser le booking Espagne",
          });
          return "payment_required";
        }
        const screenshotStorageId = await captureAndUpload(page);
        await reportSlotFound({
          applicationId: job.id,
          date: domSlot.date,
          time: domSlot.time,
          location: `Espagne / ${domSlot.location} (${booking.note})`,
          screenshotStorageId,
        });
        return "slot_found";
      }

      botLog({
        applicationId: job.id,
        step: "not_found",
        status: "warn",
        data: { flow: "spain" },
      });
      await sendHeartbeat({ applicationId: job.id, result: "not_found" });
      return "not_found";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      botLog({
        applicationId: job.id,
        step: "error",
        status: "fail",
        data: { error: msg.slice(0, 300), flow: "spain" },
      });
      await sendHeartbeat({
        applicationId: job.id,
        result: "error",
        errorMessage: msg.slice(0, 200),
      });
      return "error";
    } finally {
      try {
        await browser.close();
      } catch {
        // ignore
      }
    }
  })();

  return withTimeout(sessionPromise, 5 * 60_000);
}
