import type { APIRequestContext, Page, Response } from "playwright";
import { ProxyAgent } from "undici";
import { detectAndSolveCaptcha, detectAndSolveTurnstile } from "./captcha.js";
import { launchBrowser, randomDelay, humanScroll } from "./browser.js";
import { botLog, sendHeartbeat, reportSlotFound, requestOtpChallenge, consumeOtpCode, uploadScreenshot, uploadFile, attachConfirmationDoc, type HunterJob } from "./convexClient.js";

// ─── Session Cache ────────────────────────────────────────────────────────────
// Après un passage Playwright réussi, on met en cache la session Bookitit
// (bookititBase + cookies + initParams + services + agendas).
// Les probes suivantes utilisent undici directement (0 browser) jusqu'à expiry.
// TTL : 25 min (PHPSESSID PHP standard = 30 min).

interface SpainSessionCache {
  bookititBase: string;
  initParams: Record<string, string>;
  services: string[];
  agendas: string[];
  cookieHeader: string;  // "name=value; name2=value2"
  referer: string;       // URL de la page pour le header Referer
  cachedAt: number;      // Date.now() au moment de la mise en cache
}

const SESSION_TTL_MS = 25 * 60 * 1_000; // 25 minutes

// Clé = portalUrl, valeur = dernière session valide
const spainSessionCache = new Map<string, SpainSessionCache>();

function getCachedSession(portalUrl: string): SpainSessionCache | null {
  const entry = spainSessionCache.get(portalUrl);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > SESSION_TTL_MS) {
    spainSessionCache.delete(portalUrl);
    return null;
  }
  return entry;
}

function invalidateSession(portalUrl: string): void {
  spainSessionCache.delete(portalUrl);
}

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

/** Suffixes d'API Bookitit connus — utilisés pour extraire la base depuis une URL complète */
const BOOKITIT_KNOWN_SUFFIXES = [
  "getwidgetconfigurations/",
  "getservices/",
  "getagendas/",
  "datetime/",
  "signup/",
  "signupfirstappointment/",
  "signin/",
  "signedin/",
  "confirmclient/",
  "summary/",
  "freetempevent/",
];

function getBookititBaseFromUrl(u: string): string | null {
  // Priorité 1 : pattern classique avec "onlinebookings"
  const m = u.match(/^(https?:\/\/[^/]+\/.*?onlinebookings\/)/i);
  if (m) return m[1];

  // Priorité 2 : extraire la base en strippant tout suffix d'API connu
  for (const suffix of BOOKITIT_KNOWN_SUFFIXES) {
    const idx = u.indexOf(suffix);
    if (idx > 0) return u.slice(0, idx);
  }

  // Priorité 3 : host Bookitit connu (app.bookitit.com, widget.bookitit.com, etc.)
  if (/bookitit\.com/i.test(u)) {
    try {
      const parsed = new URL(u);
      // Garder le path jusqu'au dernier segment avant le ?
      const parts = parsed.pathname.split("/").filter(Boolean);
      // Retirer le dernier segment si c'est un endpoint connu
      const last = parts[parts.length - 1] ?? "";
      if (BOOKITIT_KNOWN_SUFFIXES.some((s) => s.replace("/", "") === last)) {
        parts.pop();
      }
      return `${parsed.origin}/${parts.join("/")}/`;
    } catch {
      return null;
    }
  }

  return null;
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

/**
 * Variante undici de callJsonp — n'a pas besoin d'un browser Playwright.
 * Utilise les cookies de session mis en cache + iProyal si disponible.
 * Retourne null si la réponse n'est pas du JSONP (HTML → session expirée).
 */
async function callJsonpUndici(
  endpointBase: string,
  endpoint: string,
  params: Record<string, string>,
  cookieHeader: string,
  referer: string,
): Promise<unknown | null> {
  const proxyUrl = process.env.IPROYAL_PROXY_URL;
  const agent = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  const q = new URLSearchParams(params);
  q.set("callback", `cb${Date.now()}${Math.floor(Math.random() * 10_000)}`);
  q.set("_", String(Date.now()));
  const url = `${endpointBase}${endpoint}?${q.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Referer": referer,
      "Origin": new URL(referer).origin,
      "Cookie": cookieHeader,
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(15_000),
    dispatcher: agent,
  } as RequestInit & { dispatcher?: ProxyAgent });

  if (!res.ok) return null;
  const body = await res.text();

  // Détecter session expirée : Bookitit renvoie son HTML de bienvenue
  const trimmed = body.trim();
  const looksLikeJsonp = trimmed.startsWith("{") || trimmed.startsWith("[") || /^[\w$.]+\(/.test(trimmed);
  if (!looksLikeJsonp) return null;

  return parseJsonpPayload(body);
}

async function getRuntimeContext(page: Page): Promise<SpainRuntimeContext> {
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const init = (w.bkt_init_widget && typeof w.bkt_init_widget === "object")
      ? (w.bkt_init_widget as Record<string, unknown>)
      : {};

    // Trouver oClientValues_XXXXX dynamiquement (le suffixe numérique dépend du widget)
    let ocv: Record<string, unknown> = {};
    const ocvKey = Object.keys(w).find(
      (k) => k.startsWith("oClientValues_") && typeof w[k] === "object" && w[k] !== null
    );
    if (ocvKey) ocv = w[ocvKey] as Record<string, unknown>;

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
      if (!date) continue;

      // agenda est l'ID dans la réponse API (ex: "bkt12345" ou un entier)
      const agendaId =
        typeof dayObj.agenda === "string" ? dayObj.agenda
        : typeof dayObj.agenda === "number" ? String(dayObj.agenda)
        : typeof dayObj.agenda_id === "string" ? dayObj.agenda_id
        : typeof dayObj.agenda_id === "number" ? String(dayObj.agenda_id)
        : undefined;

      const location = agendaId ?? "citaconsular";

      const times = dayObj.times;
      // times doit être un objet non-vide non-tableau (conforme à dayAvailable() du bundle)
      if (!times || typeof times !== "object" || Array.isArray(times)) continue;
      const timesObj = times as Record<string, unknown>;
      if (Object.keys(timesObj).length === 0) continue;

      // Chercher le premier créneau disponible dans times
      // L'API retourne freeSlots/totalSlots (camelCase) — le bundle les renomme en lowercase pour display
      // On supporte les deux formes pour robustesse
      for (const v of Object.values(timesObj)) {
        if (!v || typeof v !== "object") continue;
        const t = v as Record<string, unknown>;

        // Extraire le nombre de créneaux libres (camelCase prioritaire, lowercase fallback)
        const freeRaw = t.freeSlots ?? t.freeslots ?? t.free_slots;
        const totalRaw = t.totalSlots ?? t.totalslots ?? t.total_slots;
        const free = typeof freeRaw === "number" ? freeRaw : typeof freeRaw === "string" ? parseInt(freeRaw, 10) : -1;
        const total = typeof totalRaw === "number" ? totalRaw : typeof totalRaw === "string" ? parseInt(totalRaw, 10) : -1;

        // Un créneau est disponible si free > 0, OU si total > 0, OU si freeSlots/totalSlots absents
        // (présence dans times = disponible selon dayAvailable() du bundle)
        const hasAvailability = (free > 0) || (total > 0) || (free === -1 && total === -1);
        if (!hasAvailability) continue;

        // Extraire l'heure — peut être la clé (ex: "09:30") ou la propriété .time
        const time =
          typeof t.time === "string" ? t.time
          : typeof t.hour === "string" ? t.hour
          : "09:00";

        return { date, time, location, agendaId };
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

/**
 * Attend que le hash de la page corresponde à un des patterns attendus.
 * Retourne le hash final ou "" si timeout.
 */
async function pollForHash(
  page: Page,
  matchFn: (hash: string) => boolean,
  timeoutMs: number,
  intervalMs = 800,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await page.evaluate(() => window.location.hash || "").catch(() => "");
    if (matchFn(h)) return h;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return await page.evaluate(() => window.location.hash || "").catch(() => "");
}

/**
 * Attend que le bouton de confirmation signin/signup soit visible (CF Turnstile peut le cacher).
 * Retourne true si le bouton est cliquable dans le délai imparti.
 */
async function waitForSubmitButtonVisible(page: Page, selector: string, timeoutMs = 12_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const el = await page.$(selector);
      if (el) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) return true;
      }
    } catch { /* continue */ }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

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
    await page.goto(target, { waitUntil: "commit", timeout: 30_000 });
    await randomDelay(1000, 1800);
  } catch {
    return { status: "failed", note: "selecttime_navigation_failed" };
  }

  // Le router Bookitit redirige immédiatement depuis #selecttime vers #signin, #signup,
  // ou #signupfirstappointment selon registration_type. On attend la stabilisation du hash.
  const postSelectHash = await pollForHash(
    page,
    (h) => h.includes("signin") || h.includes("signup") || h.includes("signedin") || h.includes("summary"),
    5_000,
  );

  // ── Cas 1 : signin (compte existant) ──────────────────────────────────────
  // Si le hash contient "signin" (mais pas "signup"), c'est le flow compte existant.
  // Si hash non-résolu → on tente signin par défaut (les champs seront absents → section skip).
  if (postSelectHash.includes("signin") && !postSelectHash.includes("signup")) {
    // Formulaire signin : #idIptBktSignInlogin + #idIptBktSignInpassword
    const signInInput = page.locator("#idIptBktSignInlogin");
    const signInPass = page.locator("#idIptBktSignInpassword");
    const signInBtn = "#idBktDefaultSignInConfirmButton";

    if ((await signInInput.count()) > 0 && (await signInPass.count()) > 0) {
      await signInInput.first().fill(login);
      await signInPass.first().fill(password);
      await randomDelay(400, 800);

      // Attendre que le bouton devienne visible (CF Turnstile peut le masquer jusqu'à 10-12s)
      const btnVisible = await waitForSubmitButtonVisible(page, signInBtn, 14_000);
      if (btnVisible) {
        await page.click(signInBtn).catch(() => undefined);
      } else {
        // CF Turnstile non résolu — clic force quand même (peut échouer côté serveur)
        await page.click(signInBtn).catch(() => undefined);
        botLog({
          applicationId: job.id,
          step: "booking_signin",
          status: "warn",
          data: { reason: "submit_btn_not_visible_after_14s", flow: "spain" },
        });
      }
      await randomDelay(1500, 2500);
    }
  }

  // ── Cas 2 : signup / signupfirstappointment (nouveau compte) ─────────────
  // Le formulaire signup demande name, email, éventuellement passport number.
  // On remplit avec les données du job (applicantName, userEmail, passportNumber).
  if (postSelectHash.includes("signup") || postSelectHash.includes("signupfirstappointment")) {
    const nameInput = page.locator("#idIptBktname");
    const emailInput = page.locator("#idIptBktemail");
    const acceptCheck = page.locator("#idIptBktAcceptCondtions");
    const signUpBtn = "#idBktDefaultSignUpConfirmButton";

    // applicantName sur job ; email = embassyUsername (typiquement une adresse email Bookitit)
    const applicantName = (job.applicantName ?? login).trim();
    const applicantEmail = login; // embassyUsername = email de connexion Bookitit

    if ((await nameInput.count()) > 0) await nameInput.first().fill(applicantName).catch(() => undefined);
    if ((await emailInput.count()) > 0) await emailInput.first().fill(applicantEmail).catch(() => undefined);

    // Champs passport / document si présents (non disponible dans HunterJob — laisser vide)
    // Le formulaire citaconsular peut demander des champs event (numéro de dossier, etc.)
    // ils sont pré-remplis depuis bkt_init_widget.fields si configuré côté Bookitit
    const docInputs = [
      page.locator("#idIptBktpassport"),
      page.locator("#idIptBktdocument"),
      page.locator("#idIptBktdni"),
    ];
    for (const inp of docInputs) {
      if ((await inp.count()) > 0) {
        // Laisser vide — Bookitit peut avoir des custom fields pré-remplis via bkt_init_widget.fields
        break;
      }
    }

    // Phone si présent (non disponible dans HunterJob — skip)
    // const phoneInput = page.locator("#idIptBktcellphone, #idIptBktphone");

    // Accept conditions checkbox
    if ((await acceptCheck.count()) > 0) {
      const isChecked = await acceptCheck.first().isChecked().catch(() => false);
      if (!isChecked) await acceptCheck.first().check().catch(() => undefined);
    }

    await randomDelay(400, 800);

    // Attendre CF Turnstile si présent
    const btnVisible = await waitForSubmitButtonVisible(page, signUpBtn, 14_000);
    if (btnVisible) {
      await page.click(signUpBtn).catch(() => undefined);
    } else {
      await page.click(signUpBtn).catch(() => undefined);
      botLog({
        applicationId: job.id,
        step: "booking_signup",
        status: "warn",
        data: { reason: "submit_btn_not_visible_after_14s", flow: "spain" },
      });
    }
    await randomDelay(1500, 2500);
  }

  // ── Après signin/signup : attendre confirmclient, creditcardcapture, ou summary ──
  // Flow complet pour RDV gratuits : signin/signup → confirmclient → selectpaymentgateway
  // → creditcardcapture → arePaymentServices()==false → navigate("summary")
  // Timeout 20s pour traverser toute la chaîne automatique.
  const postLoginHash = await pollForHash(
    page,
    (h) => h.includes("confirmclient") || h.includes("creditcardcapture") || h.includes("summary") || h.includes("selectpaymentgateway"),
    20_000,
  );

  // ── Cas OTP (confirmclient avec validate défini) ───────────────────────────
  if (postLoginHash.includes("confirmclient")) {
    // Vérifier si le formulaire OTP est visible (si validate absent → auto-redirect)
    const otpInput = page.locator("#idIptBktValidateCode");
    await randomDelay(800, 1200);
    if ((await otpInput.count()) > 0 && (await otpInput.first().isVisible().catch(() => false))) {
      // OTP requis
      const directOtp = process.env.SPAIN_OTP_CODE?.trim();
      let otp = directOtp || "";
      if (!otp) {
        const channel = (job.spainOtpConfig?.channel ?? process.env.SPAIN_OTP_CHANNEL ?? "manual") as "email" | "sms" | "manual";
        await requestOtpChallenge({ applicationId: job.id, flow: "spain", channel, ttlMs: 90_000 });
        botLog({
          applicationId: job.id,
          step: "otp_waiting",
          status: "ok",
          data: {
            channel,
            ingestUrl: `${process.env.CONVEX_SITE_URL ?? ""}/hunter/otp/ingest`,
            note: "OTP attendu via forward automatique",
            flow: "spain",
          },
        });
        otp = (await waitForOtpFromConvex(job.id, 90_000)) ?? "";
      }
      if (!otp) {
        return { status: "otp_required", note: "otp_code_missing" };
      }
      const otpBtn = page.locator("#idDivBktConfirmClientValidateButton .clsDivContinueButton");
      await otpInput.first().fill(otp);
      await randomDelay(400, 700);
      if ((await otpBtn.count()) > 0) await otpBtn.first().click().catch(() => undefined);
      await randomDelay(1000, 1800);
    }
    // Après OTP (ou skip), attendre la chaîne creditcardcapture → summary
    await pollForHash(
      page,
      (h) => h.includes("creditcardcapture") || h.includes("summary") || h.includes("selectpaymentgateway"),
      12_000,
    );
  }

  // ── creditcardcapture : pour RDV gratuits, auto-redirige vers summary ────
  // Pour les RDV payants, on reste bloqué ici → payment_required
  if ((await page.evaluate(() => window.location.hash || "").catch(() => "")).includes("creditcardcapture")) {
    // Attendre l'auto-redirect vers summary (arePaymentServices() == false → navigate("summary"))
    await pollForHash(page, (h) => h.includes("summary"), 6_000);
  }

  const finalHash = await page.evaluate(() => window.location.hash || "").catch(() => "");
  if (finalHash.includes("summary")) {
    return { status: "booked", note: "summary_reached" };
  }
  if (finalHash.includes("creditcardcapture") || finalHash.includes("selectpaymentgateway")) {
    return { status: "payment_required", note: "payment_gateway_required" };
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

  // 4) Datetime scan (mois courant + 8 suivants — conforme au bundle datetimelist.js)
  const baseDate = new Date();
  for (let i = 0; i < 9; i++) {
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
 * Scan créneaux via undici pur, en réutilisant la session Bookitit mise en cache.
 * Retourne null si la session est expirée (réponse HTML au lieu de JSONP).
 * Retourne false si la session est valide mais aucun créneau disponible.
 * Retourne SpainSlot si un créneau est trouvé.
 */
async function tryApiFirstWithCachedSession(
  cache: SpainSessionCache,
  portalUrl: string,
): Promise<SpainSlot | false | null> {
  const { bookititBase, initParams, services: cachedServices, agendas: cachedAgendas, cookieHeader, referer } = cache;

  // Bootstrap config — vérifie que la session est toujours valide
  const cfgPayload = await callJsonpUndici(bookititBase, "getwidgetconfigurations/", initParams, cookieHeader, referer)
    .catch(() => null);
  if (cfgPayload === null) {
    // null = HTML response = session expirée
    console.log("[spain-cache] Session expirée (getwidgetconfigurations réponse HTML) → invalidation");
    invalidateSession(portalUrl);
    return null;
  }

  // Tenter de récupérer services/agendas frais, sinon réutiliser le cache
  let services = cachedServices;
  let agendas = cachedAgendas;

  if (services.length === 0) {
    const svcPayload = await callJsonpUndici(bookititBase, "getservices/", {
      ...initParams,
      selectedPeople: "1",
    }, cookieHeader, referer).catch(() => null);
    if (svcPayload !== null) {
      services = collectIds(svcPayload, /(service.*id|services.*id|^id$)/i).slice(0, 3);
    }
  }

  if (agendas.length === 0) {
    const agPayload = await callJsonpUndici(bookititBase, "getagendas/", {
      ...initParams,
      services: services.join(","),
      selectedPeople: "1",
    }, cookieHeader, referer).catch(() => null);
    if (agPayload !== null) {
      agendas = collectIds(agPayload, /(agenda.*id|agendas.*id|^id$)/i).slice(0, 5);
    }
  }

  if (services.length === 0 || agendas.length === 0) {
    return false; // pas de services/agendas → impossible de scanner, mais session valide
  }

  // Scan datetime (9 mois)
  const baseDate = new Date();
  for (let i = 0; i < 9; i++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1);
    const payload = await callJsonpUndici(bookititBase, "datetime/", {
      ...initParams,
      services: services.join(","),
      agendas: agendas.join(","),
      start: firstMonthDayYmd(d),
      end: lastMonthDayYmd(d),
      selectedPeople: "1",
    }, cookieHeader, referer).catch(() => null);

    if (payload === null) {
      // Session a expiré en cours de scan
      console.log("[spain-cache] Session expirée (datetime réponse HTML) → invalidation");
      invalidateSession(portalUrl);
      return null;
    }

    const slot = extractSlotFromBookititPayload(payload);
    if (slot) return slot;
  }

  return false; // session valide, 0 créneau
}

/**
 * Après un passage Playwright réussi, extrait les cookies Bookitit + init params
 * et les sauvegarde dans spainSessionCache pour les prochaines probes undici.
 */
async function extractAndSaveSession(
  page: Page,
  bookititBases: Set<string>,
  runtime: SpainRuntimeContext,
  portalUrl: string,
): Promise<SpainSessionCache | null> {
  const base = [...bookititBases][0];
  if (!base) return null;

  try {
    const allCookies = await page.context().cookies();
    // Garder les cookies Bookitit + session PHP
    const relevantCookies = allCookies.filter(c =>
      c.domain.includes("bookitit") ||
      c.domain.includes("citaconsular") ||
      /phpsess|ci_sess|bkt|sess/i.test(c.name)
    );

    // Fallback : si aucun cookie spécifique, garder tous les cookies
    const cookiesToUse = relevantCookies.length > 0 ? relevantCookies : allCookies;
    const cookieHeader = cookiesToUse.map(c => `${c.name}=${c.value}`).join("; ");

    if (!cookieHeader) return null;

    // Récupérer services + agendas frais depuis le contexte Playwright
    // pour les avoir disponibles dans le cache
    const req = page.context().request;
    const initParams = toStringMap(runtime.init);

    let services = runtime.selectedServices;
    let agendas = runtime.selectedAgendas;

    if (services.length === 0) {
      const svcPayload = await callJsonp(req, base, "getservices/", {
        ...initParams,
        selectedPeople: "1",
      }).catch(() => null);
      if (svcPayload) services = collectIds(svcPayload, /(service.*id|services.*id|^id$)/i).slice(0, 3);
    }

    if (agendas.length === 0) {
      const agPayload = await callJsonp(req, base, "getagendas/", {
        ...initParams,
        services: services.join(","),
        selectedPeople: "1",
      }).catch(() => null);
      if (agPayload) agendas = collectIds(agPayload, /(agenda.*id|agendas.*id|^id$)/i).slice(0, 5);
    }

    const cache: SpainSessionCache = {
      bookititBase: base,
      initParams,
      services,
      agendas,
      cookieHeader,
      referer: page.url() || portalUrl,
      cachedAt: Date.now(),
    };

    spainSessionCache.set(portalUrl, cache);
    const ageMin = 0;
    console.log(`[spain-cache] Session sauvegardée — base: ${base} | services: ${services.join(",") || "auto"} | agendas: ${agendas.join(",") || "auto"} | cookies: ${cookiesToUse.length} | TTL: ${Math.round((SESSION_TTL_MS - ageMin) / 60_000)}min`);
    return cache;
  } catch (e) {
    console.warn("[spain-cache] Impossible de sauvegarder la session:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Attend que Cloudflare se résout automatiquement (stealth + proxy résidentiel passent souvent).
 * Phase 1 : attente passive 120s (vérification toutes les 3s) — IP DRC via iProyal nécessite ~90-120s.
 * Phase 2 : tentative résolution active via CapSolver AntiCloudflareTask → 2captcha Turnstile.
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

  // Phase 1 : attente passive jusqu'à 120s (IP DRC via iProyal nécessite ~90-120s pour CF)
  const AUTO_WAIT_MS = 120_000;
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

  // Phase 2 : résolution active via CapSolver (priorité) → 2captcha (fallback)
  console.log("[spain] 30s écoulées — tentative résolution CF (CapSolver → 2captcha)…");
  const turnstileResult = await detectAndSolveTurnstile(
    page,
    job.hunterConfig.twoCaptchaApiKey,
    job.hunterConfig.capsolverApiKey,
    process.env.IPROYAL_PROXY_URL,
  );

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

/**
 * Clique sur le bouton "Continue / Continuar" affiché par citaconsular.es
 * avant le calendrier Bookitit. Sans ce clic le widget ne se charge pas
 * et aucun appel JSONP datetime/ n'est déclenché.
 *
 * Stratégie multi-sélecteur : IDs Bookitit connus → classe CSS → texte DOM.
 */
async function clickContinuarIfPresent(page: Page, job: HunterJob): Promise<void> {
  // IDs et classes connus du widget Bookitit citaconsular
  const SELECTORS = [
    "#idBktDefaultContinueButton",
    "#idDivBktContinueButton",
    ".clsDivContinueButton",
    ".clsBktContinueButton",
    "[id*='Continue'][id*='Button']",
    "[class*='ContinueButton']",
  ];

  for (const sel of SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;
      console.log(`[spain] Bouton "Continuar" trouvé (${sel}) → clic`);
      await el.click();
      await randomDelay(2000, 3500);
      botLog({
        applicationId: job.id,
        step: "continuar",
        status: "ok",
        data: { selector: sel, flow: "spain" },
      });
      return;
    } catch {
      // essayer le sélecteur suivant
    }
  }

  // Fallback : scan texte DOM ("Continuar" ou "Continue")
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>("button, a, div[onclick], [role='button'], input[type='button'], input[type='submit']")
    );
    for (const el of candidates) {
      if (/continuar|continue/i.test(el.textContent?.trim() ?? "") && el.offsetParent !== null) {
        el.click();
        return (el.textContent?.trim() ?? "").slice(0, 40);
      }
    }
    return null;
  });

  if (clicked) {
    console.log(`[spain] Bouton "Continuar" cliqué via fallback texte: "${clicked}"`);
    await randomDelay(2000, 3500);
    botLog({
      applicationId: job.id,
      step: "continuar",
      status: "ok",
      data: { selector: "text_fallback", text: clicked, flow: "spain" },
    });
  } else {
    console.log("[spain] Aucun bouton 'Continuar' détecté — widget peut-être déjà chargé");
    botLog({
      applicationId: job.id,
      step: "continuar",
      status: "warn",
      data: { reason: "not_found", flow: "spain" },
    });
  }
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

    // ── Cache check : session Bookitit encore valide ? ─────────────────────
    // Si oui, on fait le scan via undici (0 Playwright overhead).
    // Si le scan cache retourne un créneau → on lance Playwright uniquement pour booker.
    // Si aucun créneau (false) → heartbeat not_found immédiat, pas de browser.
    // Si null → session expirée, on continue avec le flow Playwright complet.
    const cachedSession = getCachedSession(url);
    if (cachedSession) {
      const ageMin = Math.round((Date.now() - cachedSession.cachedAt) / 60_000);
      botLog({
        applicationId: job.id,
        step: "scan",
        status: "ok",
        data: { strategy: "cached_session", ageMin, base: cachedSession.bookititBase, flow: "spain" },
      });
      console.log(`[spain] Cache hit (${ageMin}min) — scan undici sans Playwright`);

      try {
        const cacheResult = await tryApiFirstWithCachedSession(cachedSession, url);

        if (cacheResult === null) {
          // Session expirée — passe au flow Playwright complet
          console.log("[spain] Cache expiré → flow Playwright complet");
        } else if (cacheResult === false) {
          // Session valide, pas de créneau
          botLog({
            applicationId: job.id,
            step: "not_found",
            status: "warn",
            data: { strategy: "cached_session", flow: "spain" },
          });
          await sendHeartbeat({ applicationId: job.id, result: "not_found" });
          return "not_found";
        } else {
          // Créneau trouvé via cache — lancer Playwright uniquement pour le booking
          const slot = cacheResult;
          botLog({
            applicationId: job.id,
            step: "slots_found",
            status: "ok",
            data: { date: slot.date, time: slot.time, location: slot.location, strategy: "cached_session", flow: "spain" },
          });
          console.log(`[spain] ✅ Créneau trouvé via cache (${slot.date} ${slot.time}) — lancement Playwright pour booking`);

          const { browser: bkBrowser, page: bkPage } = await launchBrowser({
            locale: "es-ES",
            timezoneId: "Europe/Madrid",
            acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
          });
          try {
            await bkPage.goto(url, { waitUntil: "commit", timeout: 45_000 });
            await randomDelay(1500, 2500);
            const booking = await tryAutoBookSpainSlot(bkPage, job, slot);
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
                data: { note: booking.note, date: slot.date, strategy: "cached_session", flow: "spain" },
              });
              const errMsg = booking.note === "credentials_missing"
                ? "⚠️ Créneau DISPONIBLE mais identifiants Bookitit manquants"
                : `Réservation impossible (cache) : ${booking.note}`;
              await sendHeartbeat({ applicationId: job.id, result: "error", errorMessage: errMsg });
              return "error";
            }
            await postBookingCapture(bkPage, job, slot, booking);
            return "slot_found";
          } finally {
            await bkBrowser.close().catch(() => undefined);
          }
        }
      } catch (e) {
        console.warn("[spain] Erreur scan cache:", e instanceof Error ? e.message : e);
        // Continuer avec le flow Playwright complet
      }
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
    let sessionInitParams: Record<string, string> = {};

    const releaseTempBooking = async (): Promise<void> => {
      const base = [...bookititBases][0];
      if (!base || Object.keys(sessionInitParams).length === 0) return;
      try {
        const req = page.context().request;
        await callJsonp(req, base, "freetempevent/", sessionInitParams);
        botLog({ applicationId: job.id, step: "freetempevent", status: "ok", data: { base, flow: "spain" } });
      } catch {
        // fire-and-forget — ne pas bloquer le retour d'erreur
      }
    };

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
      // ── Dialog natif (alert/confirm) — apparaît sur certaines URLs citaconsular.es
      // Doit être enregistré AVANT goto() pour capturer le dialog au chargement.
      page.on("dialog", async (dialog) => {
        console.log(`[spain] Dialog natif détecté (${dialog.type()}): "${dialog.message().slice(0, 80)}" → accept`);
        await dialog.accept().catch(() => undefined);
      });

      // ── Warm-up : visite la racine du domaine avant le widget URL ────────────
      // CF donne plus confiance aux sessions qui naviguent naturellement sur le site
      // avant d'atteindre le widget (vs. arrivée directe sur le widget URL depuis rien).
      try {
        const widgetBaseUrl = new URL(url);
        const domainRoot = `${widgetBaseUrl.protocol}//${widgetBaseUrl.hostname}/`;
        if (url !== domainRoot) {
          console.log(`[spain] Warm-up: ${domainRoot}`);
          await page.goto(domainRoot, { waitUntil: "commit", timeout: 20_000 }).catch(() => { /* timeout ok */ });
          await randomDelay(1500, 3000);

          // Si CF bloque déjà la racine, attente courte
          const warmTitle = await page.title().catch(() => "");
          if (CF_TITLE_RE.test(warmTitle)) {
            console.log("[spain] CF sur racine domaine — pause 8s...");
            await new Promise(r => setTimeout(r, 8_000));
          }
        }
      } catch {
        /* warm-up non critique — on continue */
      }

      console.log(`[spain] Navigation: ${url}`);
      // "commit" : robuste face aux challenges Cloudflare et portails lents.
      // On attend ensuite les sélecteurs spécifiques plutôt que le parsing HTML global.
      try {
        await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
      } catch {
        console.warn("[spain] goto timeout 30s — retry 45s");
        await page.goto(url, { waitUntil: "commit", timeout: 45_000 });
      }
      await randomDelay(1500, 3000);

      // ── Détection & résolution Cloudflare Turnstile ──────────────────────
      const cfCleared = await waitAndResolveCloudflareTurnstile(page, job);
      if (!cfCleared) return "captcha"; // heartbeat déjà envoyé dans la fonction

      // ── Bouton "Continue / Continuar" ─────────────────────────────────────
      // citaconsular.es/widgetdefault/... affiche un écran intermédiaire
      // "Para solicitar cita pulse en el botón continuar" avant le calendrier.
      // Ce clic déclenche le chargement du widget Bookitit et les appels JSONP
      // datetime/ — sans lui le bot n'intercepte aucun créneau.
      await clickContinuarIfPresent(page, job);

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
        sessionInitParams = toStringMap(runtime.init);

        // ── Sauvegarder la session pour les prochaines probes (undici sans Playwright) ──
        await extractAndSaveSession(page, bookititBases, runtime, url).catch(() => undefined);

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
            await releaseTempBooking();
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
          await releaseTempBooking();
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
          await releaseTempBooking();
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

// ─── Spain Watcher Probe ─────────────────────────────────────────────────────
// Scan indépendant : pas de HunterJob, pas d'applicationId.
// Lance un navigateur stealth, navigue vers portalUrl, détecte les créneaux
// via JSONP Bookitit, prend un screenshot et retourne le résultat.
// Appelé par startSpainWatcherLoop() dans index.ts.

export interface SpainWatcherProbeResult {
  status: "found" | "not_found" | "error";
  slotInfo?: string;
  screenshotBase64?: string;
  errorMessage?: string;
}

export async function runSpainWatcherProbe(portalUrl: string): Promise<SpainWatcherProbeResult> {
  const probe = (async (): Promise<SpainWatcherProbeResult> => {

    // ── Cache check : session Bookitit valide → scan undici sans Playwright ──
    const cachedSession = getCachedSession(portalUrl);
    if (cachedSession) {
      const ageMin = Math.round((Date.now() - cachedSession.cachedAt) / 60_000);
      console.log(`[spain-watcher] Cache hit (${ageMin}min) — probe undici sans browser`);
      try {
        const cacheResult = await tryApiFirstWithCachedSession(cachedSession, portalUrl);
        if (cacheResult === null) {
          console.log("[spain-watcher] Cache expiré → probe Playwright complète");
          // Continuer avec le flow Playwright ci-dessous
        } else if (cacheResult === false) {
          console.log("[spain-watcher] Aucun créneau (cache)");
          return { status: "not_found" };
        } else {
          const slot = cacheResult;
          const slotInfo = `${slot.date} à ${slot.time} — ${slot.location}`;
          console.log(`[spain-watcher] ✅ Créneau trouvé via cache: ${slotInfo}`);
          return { status: "found", slotInfo };
        }
      } catch (e) {
        console.warn("[spain-watcher] Erreur probe cache:", e instanceof Error ? e.message : e);
      }
    }

    // ── Flow Playwright complet (premier passage ou session expirée) ──────
    const { browser, page } = await launchBrowser({
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      acceptLanguage: "es-ES,es;q=0.9,en;q=0.8",
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
      // Dismiss dialogs natifs
      page.on("dialog", async (dialog) => {
        await dialog.accept().catch(() => undefined);
      });

      console.log(`[spain-watcher] Probe → ${portalUrl}`);
      // "commit" = déclenche dès les premiers octets reçus (headers HTTP).
      // Plus robuste que "domcontentloaded" si le portail est lent ou si
      // Cloudflare injecte un challenge qui retarde le parsing HTML.
      // Retry avec 45s si le premier essai expire en 25s.
      try {
        await page.goto(portalUrl, { waitUntil: "commit", timeout: 25_000 });
      } catch {
        console.warn("[spain-watcher] goto timeout 25s — retry 45s");
        await page.goto(portalUrl, { waitUntil: "commit", timeout: 45_000 });
      }
      await randomDelay(1500, 2500);

      // Cloudflare check — attente 120s + CapSolver AntiCloudflareTask si nécessaire
      {
        let cfTitle = "";
        try { cfTitle = await page.title(); } catch { /* ignore */ }
        if (CF_TITLE_RE.test(cfTitle)) {
          console.log(`[spain-watcher] Cloudflare détecté (titre: "${cfTitle}") — attente 120s…`);
          const t0 = Date.now();
          while (Date.now() - t0 < 120_000) {
            await new Promise((r) => setTimeout(r, 3_000));
            try { cfTitle = await page.title(); } catch { cfTitle = ""; }
            if (!CF_TITLE_RE.test(cfTitle)) break;
          }
          if (CF_TITLE_RE.test(cfTitle)) {
            // Tentative CapSolver AntiCloudflareTask
            const capsolverKey = process.env.CAPSOLVER_API_KEY;
            if (capsolverKey) {
              const capRes = await detectAndSolveTurnstile(
                page,
                process.env.TWOCAPTCHA_API_KEY,
                capsolverKey,
                process.env.IPROYAL_PROXY_URL,
              ).catch(() => "failed" as const);
              if (capRes !== "solved") {
                console.log("[spain-watcher] Cloudflare non résolu — probe abandonnée");
                return { status: "error", errorMessage: "cloudflare_blocked" };
              }
            } else {
              console.log("[spain-watcher] Cloudflare non résolu (CAPSOLVER_API_KEY absent) — probe abandonnée");
              return { status: "error", errorMessage: "cloudflare_blocked" };
            }
          }
        }
      }

      // ── Navigation multi-étapes Bookitit ──────────────────────────────────────
      // Flux : #services → (sélection service) → #agendas → (sélection agenda) → #datetime → datetime/ API
      //
      // Logique d'auto-navigation du bundle :
      //   • 1 seul service  → checkOneService() auto-sélectionne → navigate('agendas')
      //   • 1 seul agenda   → checkOneAgenda()  auto-sélectionne → navigate('datetime')
      // → Dans ce cas le widget navigue tout seul ; on attend juste que le hash change.
      //
      // Sélecteurs réels extraits du bundle :
      //   Services  : #idListServices .clsBktServiceDataContainer  (checkbox: input[name='services[]'])
      //   Agendas   : #idListAgendas  .clsBktAgendaDataContainer
      //   Continue  : #idDivBktButtonContinueContainer (affiché seulement si multiselect > 0)

      // Sélecteurs de cartes cliquables par hash
      const SERVICE_CARD_SELS = [
        "#idListServices .clsBktServiceDataContainer",
        "#idListServices input[name='services[]']",
        "#idListServices a",
        ".clsBktServiceDataContainer",
      ];
      const AGENDA_CARD_SELS = [
        "#idListAgendas .clsBktAgendaDataContainer",
        "#idListAgendas a",
        ".clsBktAgendaDataContainer",
        ".clsDivBktAgendaFirstAvailable",
      ];
      // Continue button (multiselect services uniquement)
      const CONTINUE_SELS = [
        "#idDivBktButtonContinueContainer button",
        "#idDivBktButtonContinueContainer a",
        "#idBktDefaultContinueButton",
        "#idDivBktContinueButton",
        ".clsDivContinueButton",
        "[id*='ContinueContainer'] button",
        "[id*='Continue'][id*='Button']",
      ];

      for (let step = 0; step < 8; step++) {
        const currentHash: string = await page.evaluate(() => window.location.hash).catch(() => "");
        console.log(`[spain-watcher] step=${step} hash="${currentHash}"`);

        // Étape datetime → les appels API datetime/ vont se déclencher → sortir
        if (/datetime|selecttime|calendar|noavailability|slot/i.test(currentHash)) {
          console.log(`[spain-watcher] Étape datetime atteinte → attente API`);
          break;
        }

        // Attendre d'abord l'auto-navigation Bookitit (jusqu'à 4s)
        // Le bundle auto-navigue si 1 seul service ou 1 seul agenda
        let autoNavigated = false;
        for (let w = 0; w < 4; w++) {
          await new Promise((r) => setTimeout(r, 1000));
          const newHash: string = await page.evaluate(() => window.location.hash).catch(() => "");
          if (newHash !== currentHash) {
            console.log(`[spain-watcher] Auto-navigation: "${currentHash}" → "${newHash}"`);
            autoNavigated = true;
            break;
          }
        }
        if (autoNavigated) continue; // Re-boucler avec le nouveau hash

        // Pas d'auto-navigation → sélectionner manuellement la première carte visible
        const isAtAgendas = /agendas/i.test(currentHash);
        const cardSels = isAtAgendas ? AGENDA_CARD_SELS : SERVICE_CARD_SELS;

        const cardClicked = await page.evaluate((sels: string[]) => {
          for (const sel of sels) {
            const cards = Array.from(document.querySelectorAll<HTMLElement>(sel));
            for (const card of cards) {
              if (card.offsetParent === null) continue; // invisible
              const disabled = card.hasAttribute("disabled") || card.classList.contains("clsBktServiceDisabled");
              if (disabled) continue;
              card.click();
              return `${sel} [text="${(card.textContent?.trim() ?? "").slice(0, 30)}"]`;
            }
          }
          return null;
        }, cardSels);

        if (cardClicked) {
          console.log(`[spain-watcher] Carte cliquée: ${cardClicked}`);
          await randomDelay(600, 1200);
        }

        // Cliquer "Continuar" (affiché uniquement pour multiselect > 0)
        let continuarClicked = false;
        for (const sel of CONTINUE_SELS) {
          try {
            const el = await page.$(sel);
            if (!el) continue;
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            const disabled = await el.isDisabled().catch(() => false);
            if (disabled) continue;
            console.log(`[spain-watcher] Continuar (${sel}) step=${step}`);
            await el.click();
            await randomDelay(1500, 2500);
            continuarClicked = true;
            break;
          } catch { /* try next */ }
        }

        // Fallback texte
        if (!continuarClicked) {
          const textClicked = await page.evaluate(() => {
            const candidates = Array.from(
              document.querySelectorAll<HTMLElement>("button, a, [role='button']")
            );
            for (const el of candidates) {
              if (el.offsetParent === null) continue;
              if (/continuar|continue/i.test(el.textContent?.trim() ?? "")) {
                el.click();
                return (el.textContent?.trim() ?? "").slice(0, 40);
              }
            }
            return null;
          });
          if (textClicked) {
            console.log(`[spain-watcher] Continuar text: "${textClicked}" step=${step}`);
            await randomDelay(1500, 2500);
            continuarClicked = true;
          }
        }

        // Si ni carte ni Continuar trouvés → attendre auto-navigation ou abandonner
        if (!cardClicked && !continuarClicked) {
          console.log(`[spain-watcher] Rien à cliquer step=${step}, hash="${currentHash}" — attente 3s`);
          await randomDelay(2500, 4000);
          const newHash: string = await page.evaluate(() => window.location.hash).catch(() => "");
          if (newHash === currentHash) {
            console.log(`[spain-watcher] Hash inchangé — navigation bloquée à step=${step}`);
            break;
          }
        }
      }

      // Attendre les JSONP datetime (délai après dernière navigation)
      await randomDelay(3500, 6000);

      // API-first via bases Bookitit détectées
      if (bookititBases.size > 0) {
        const runtime = await getRuntimeContext(page);

        // ── Sauvegarder la session pour les prochaines probes (undici sans Playwright) ──
        await extractAndSaveSession(page, bookititBases, runtime, portalUrl).catch(() => undefined);

        for (const base of bookititBases) {
          const slot = await tryApiFirstSlot(page, base, runtime).catch(() => null);
          if (slot) {
            const screenshotBuf = await page.screenshot({ fullPage: false, type: "png" }).catch(() => null);
            const screenshotBase64 = screenshotBuf ? screenshotBuf.toString("base64") : undefined;
            const slotInfo = `${slot.date} à ${slot.time} — ${slot.location}`;
            console.log(`[spain-watcher] ✅ Créneau trouvé (api_first): ${slotInfo}`);
            return { status: "found", slotInfo, screenshotBase64 };
          }
        }
      }

      // Fallback : payloads interceptés en navigation
      for (const p of payloadHits) {
        const slot = extractSlotFromBookititPayload(p);
        if (slot) {
          const screenshotBuf = await page.screenshot({ fullPage: false, type: "png" }).catch(() => null);
          const screenshotBase64 = screenshotBuf ? screenshotBuf.toString("base64") : undefined;
          const slotInfo = `${slot.date} à ${slot.time} — ${slot.location}`;
          console.log(`[spain-watcher] ✅ Créneau trouvé (network_fallback): ${slotInfo}`);
          return { status: "found", slotInfo, screenshotBase64 };
        }
      }

      // Fallback DOM
      const domSlot = await detectSlotInDom(page);
      if (domSlot) {
        const screenshotBuf = await page.screenshot({ fullPage: false, type: "png" }).catch(() => null);
        const screenshotBase64 = screenshotBuf ? screenshotBuf.toString("base64") : undefined;
        const slotInfo = `${domSlot.date} à ${domSlot.time} — ${domSlot.location}`;
        console.log(`[spain-watcher] ✅ Créneau trouvé (dom): ${slotInfo}`);
        return { status: "found", slotInfo, screenshotBase64 };
      }

      console.log("[spain-watcher] Aucun créneau disponible");
      return { status: "not_found" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[spain-watcher] Erreur probe:", msg.slice(0, 200));
      return { status: "error", errorMessage: msg.slice(0, 200) };
    } finally {
      try { await browser.close(); } catch { /* ignore */ }
    }
  })();

  // Timeout 4 min pour la probe
  return new Promise<SpainWatcherProbeResult>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ status: "error", errorMessage: "probe_timeout_4min" }), 4 * 60_000);
    probe.then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
