import type { APIRequestContext, Page, Response } from "playwright";
import { detectAndSolveCaptcha, detectAndSolveTurnstile } from "./captcha.js";
import { launchBrowser, randomDelay, humanScroll } from "./browser.js";
import { botLog, sendHeartbeat, reportSlotFound, requestOtpChallenge, consumeOtpCode, uploadScreenshot, uploadFile, attachConfirmationDoc, type HunterJob } from "./convexClient.js";

const CF_TITLE_RE =
  /un instant|just a moment|un momento|momento|attention required|verifying you are human|comprobando|una instant/i;

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

/** Attend que la page #summary ait fini son appel JSONP et rendu le contenu. */
async function waitForSummaryReady(page: Page): Promise<void> {
  await Promise.race([
    page.waitForSelector("#idDivBktSummaryContent", { state: "visible", timeout: 12_000 }),
    new Promise<void>((r) => setTimeout(r, 12_000)),
  ]).catch(() => {});
  await Promise.race([
    page.waitForFunction(
      () => (document.querySelector("#idDivBktSummaryAppointmentsContent")?.children.length ?? 0) > 0,
      { timeout: 8_000 },
    ),
    new Promise<void>((r) => setTimeout(r, 8_000)),
  ]).catch(() => {});
}

/** Extrait le numéro de localisateur (code de confirmation) depuis le DOM summary. */
async function extractLocatorFromSummary(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector("#idDivBktSummaryAppointmentsContent");
      if (!el) return null;
      const text = el.textContent ?? "";
      // Bookitit locators : code numérique 5-12 chiffres
      const m = text.match(/\b(\d{5,12})\b/);
      return m ? m[1] : null;
    });
  } catch {
    return null;
  }
}

/**
 * Génère un PDF de la confirmation en réutilisant exactement le même HTML
 * que le bouton "Print" du widget (contenu de #idBktDefaultTicketContainer).
 */
async function captureConfirmationPdf(page: Page): Promise<string | null> {
  try {
    // Le TicketView rend son contenu dans #idBktDefaultTicketContainer lors de fillData()
    await page.waitForSelector("#idBktDefaultTicketContainer", { timeout: 6_000 }).catch(() => {});

    const ticketHtml = await page
      .$eval("#idBktDefaultTicketContainer", (el) => (el as HTMLElement).innerHTML)
      .catch(() => "");

    let pdfBytes: Buffer;

    if (ticketHtml) {
      // Ouvre une page éphémère avec uniquement le HTML du ticket — propre et sans chrome
      const ctx = page.context();
      const ticketPage = await ctx.newPage();
      await ticketPage.setContent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Confirmation RDV</title></head><body style="margin:16px;font-family:sans-serif">${ticketHtml}</body></html>`,
        { waitUntil: "domcontentloaded" },
      );
      pdfBytes = Buffer.from(await ticketPage.pdf({ format: "A4", printBackground: true }));
      await ticketPage.close();
    } else {
      // Fallback : PDF de toute la page summary en mode print
      await page.emulateMedia({ media: "print" });
      pdfBytes = Buffer.from(await page.pdf({ format: "A4", printBackground: true }));
      await page.emulateMedia({ media: "screen" });
    }

    return await uploadFile(pdfBytes.toString("base64"), "application/pdf");
  } catch (e) {
    console.warn("[spain] captureConfirmationPdf failed:", e);
    return null;
  }
}

/**
 * Appelé après un booking réussi (status === "booked").
 * Attend le rendu du summary, extrait le locateur, capte screenshot + PDF,
 * uploade le PDF comme document, puis appelle reportSlotFound.
 */
async function postBookingCapture(
  page: Page,
  job: HunterJob,
  slot: SpainSlot,
  booking: BookingAttempt,
): Promise<void> {
  await waitForSummaryReady(page);

  const locator = await extractLocatorFromSummary(page);
  if (locator) {
    botLog({ applicationId: job.id, step: "confirmation_locator", status: "ok", data: { locator } });
  }

  const screenshotStorageId = await captureAndUpload(page);

  const pdfStorageId = await captureConfirmationPdf(page);
  if (pdfStorageId) {
    await attachConfirmationDoc({
      applicationId: job.id,
      storageId: pdfStorageId,
      docKey: "booking_confirmation_pdf",
      label: "Confirmation de rendez-vous (PDF)",
    });
    botLog({ applicationId: job.id, step: "confirmation_pdf", status: "ok", data: { pdfStorageId } });
  } else {
    botLog({ applicationId: job.id, step: "confirmation_pdf", status: "warn", data: { reason: "pdf_capture_failed" } });
  }

  await reportSlotFound({
    applicationId: job.id,
    date: slot.date,
    time: slot.time,
    location: `Espagne / ${slot.location} (${booking.note ?? "booked"})`,
    confirmationCode: locator ?? undefined,
    screenshotStorageId,
  });
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
    // OTP auto-ingéré : email forward ou SMS forwarder → webhook /hunter/otp/ingest → Convex
    // Fallback dev : variable d'environnement SPAIN_OTP_CODE
    const directOtp = process.env.SPAIN_OTP_CODE?.trim();
    let otp = directOtp || "";
    if (!otp) {
      const channel = (process.env.SPAIN_OTP_CHANNEL ?? "email") as "email" | "sms" | "telegram";
      await requestOtpChallenge({
        applicationId: job.id,
        flow: "spain",
        channel,
        ttlMs: 90_000,
      });
      botLog({
        applicationId: job.id,
        step: "otp_waiting",
        status: "ok",
        data: {
          channel,
          ingestUrl: `${process.env.CONVEX_SITE_URL ?? ""}/hunter/otp/ingest`,
          note: "OTP attendu via forward automatique — aucune action humaine requise",
          flow: "spain",
        },
      });
      otp = (await waitForOtpFromConvex(job.id, 90_000)) ?? "";
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

/**
 * Attend que Cloudflare se résout automatiquement (stealth + proxy résidentiel passent souvent).
 * Phase 1 : attente passive 30s (vérification toutes les 3s).
 * Phase 2 : tentative résolution active via 2captcha Turnstile.
 * Retourne true si la page est accessible, false si toujours bloquée.
 */
async function waitAndResolveCloudflareTurnstile(
  page: Page,
  job: HunterJob,
): Promise<boolean> {
  let title = "";
  try { title = await page.title(); } catch { /* ignore */ }

  if (!CF_TITLE_RE.test(title)) return true;

  botLog({
    applicationId: job.id,
    step: "cloudflare",
    status: "warn",
    data: { title, flow: "spain", phase: "detected" },
  });
  console.log(`[spain] ⚠️  Cloudflare challenge détecté (titre: "${title}") — attente auto-résolution…`);

  // Phase 1 : attente passive jusqu'à 30s
  const AUTO_WAIT_MS = 30_000;
  const CHECK_INTERVAL_MS = 3_000;
  const t0 = Date.now();

  while (Date.now() - t0 < AUTO_WAIT_MS) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    try { title = await page.title(); } catch { title = ""; }
    if (!CF_TITLE_RE.test(title)) {
      const elapsed = Math.round((Date.now() - t0) / 1000);
      console.log(`[spain] ✅ Cloudflare auto-résolu (${elapsed}s)`);
      botLog({
        applicationId: job.id,
        step: "cloudflare",
        status: "ok",
        data: { method: "auto", resolvedAfterSec: elapsed, flow: "spain" },
      });
      return true;
    }
  }

  // Phase 2 : résolution active via 2captcha Turnstile
  console.log("[spain] 30s écoulées — tentative résolution Turnstile via 2captcha…");
  const turnstileResult = await detectAndSolveTurnstile(page, job.hunterConfig.twoCaptchaApiKey);

  if (turnstileResult === "solved") {
    await new Promise((r) => setTimeout(r, 2500));
    try { title = await page.title(); } catch { title = ""; }
    if (!CF_TITLE_RE.test(title)) {
      console.log("[spain] ✅ Cloudflare résolu via 2captcha Turnstile");
      botLog({
        applicationId: job.id,
        step: "cloudflare",
        status: "ok",
        data: { method: "2captcha_turnstile", flow: "spain" },
      });
      return true;
    }
  }

  // Toujours bloqué
  const reason =
    turnstileResult === "no_key" ? "2captcha_key_absente"
    : turnstileResult === "failed" ? "turnstile_echec"
    : "turnstile_non_resolu_apres_injection";

  console.log(`[spain] ❌ CF Turnstile non résolu (${reason}) — heartbeat captcha`);
  botLog({
    applicationId: job.id,
    step: "cloudflare",
    status: "fail",
    data: { reason, flow: "spain" },
  });
  await sendHeartbeat({
    applicationId: job.id,
    result: "captcha",
    errorMessage: `Cloudflare Turnstile non résolu (${reason}) — retry au prochain cycle`,
  });
  return false;
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

    const { browser, page } = await launchBrowser({
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
    });
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

      // ── Détection & résolution Cloudflare Turnstile ──────────────────────
      const cfCleared = await waitAndResolveCloudflareTurnstile(page, job);
      if (!cfCleared) return "captcha"; // heartbeat déjà envoyé dans la fonction

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
          if (booking.status === "failed") {
            botLog({
              applicationId: job.id,
              step: "booking",
              status: "fail",
              data: { note: booking.note, date: apiSlot.date, strategy: "api_first", flow: "spain" },
            });
            const errMsg = booking.note === "credentials_missing"
              ? "⚠️ Créneau DISPONIBLE mais identifiants Bookitit manquants — saisissez embassyUsername/embassyPassword dans la config Hunter"
              : `Réservation Bookitit impossible (api_first) : ${booking.note}`;
            await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: errMsg });
            return "error";
          }
          await postBookingCapture(page, job, apiSlot, booking);
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
        if (booking.status === "failed") {
          botLog({
            applicationId: job.id,
            step: "booking",
            status: "fail",
            data: { note: booking.note, date: slot.date, strategy: "fallback_network", flow: "spain" },
          });
          const errMsg = booking.note === "credentials_missing"
            ? "⚠️ Créneau DISPONIBLE mais identifiants Bookitit manquants — saisissez embassyUsername/embassyPassword dans la config Hunter"
            : `Réservation Bookitit impossible (fallback_network) : ${booking.note}`;
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: errMsg });
          return "error";
        }
        await postBookingCapture(page, job, slot, booking);
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
        if (booking.status === "failed") {
          botLog({
            applicationId: job.id,
            step: "booking",
            status: "fail",
            data: { note: booking.note, date: domSlot.date, strategy: "fallback_dom", flow: "spain" },
          });
          const errMsg = booking.note === "credentials_missing"
            ? "⚠️ Créneau DISPONIBLE mais identifiants Bookitit manquants — saisissez embassyUsername/embassyPassword dans la config Hunter"
            : `Réservation Bookitit impossible (fallback_dom) : ${booking.note}`;
          await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: errMsg });
          return "error";
        }
        await postBookingCapture(page, job, domSlot, booking);
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
