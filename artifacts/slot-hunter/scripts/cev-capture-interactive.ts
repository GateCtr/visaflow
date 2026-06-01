/**
 * cev-capture-interactive.ts — Capture interactive CEV (diplomatie.be)
 *
 * Lance un vrai Chrome VISIBLE. Tu navigues toi-même sur VOWINT :
 *   1. Login avec ton compte
 *   2. Va sur "Mes demandes"
 *   3. Clique sur "Prendre rendez-vous" (ouvre un nouvel onglet CEV)
 *   4. Résous le hCaptcha manuellement
 *   5. Ferme le navigateur quand tu as fini
 *
 * Le script capture silencieusement TOUT et génère un rapport de comparaison
 * browser vs bot (cookies, headers, body du POST SetCaptchaToken).
 *
 * Usage :
 *   pnpm cev:capture
 *   ou : npx tsx scripts/cev-capture-interactive.ts
 *
 * Sortie :
 *   captured/cev/capture-<timestamp>.json     → données brutes complètes
 *   captured/cev/comparison-<timestamp>.txt   → rapport comparaison lisible
 */

import { chromium, type BrowserContext, type Page, type Request, type Response } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Domaines à surveiller ──────────────────────────────────────────────────

const CAPTURE_DOMAINS = [
  "visaonweb.diplomatie.be",
  "appointment.cloud.diplomatie.be",
  "hcaptcha.com",
  "newassets.hcaptcha.com",
  "api2.hcaptcha.com",
  "imgs.hcaptcha.com",
];

const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CapturedRequest {
  id: number;
  timestamp: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  postData: string | null;
  resourceType: string;
  tab: string;
}

interface CapturedResponse {
  id: number;
  requestId: number;
  timestamp: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string | null;
  durationMs: number;
}

interface CookieSnapshot {
  timestamp: string;
  trigger: string;
  tab: string;
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
    expires: number;
  }>;
}

interface SetCaptchaCapture {
  timestamp: string;
  tab: string;
  requestHeaders: Record<string, string>;
  requestCookies: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  redirectUrl: string | null;
  validUntil: string | null;
  finalVerdict: string | null;
  cookiesAtMoment: Array<{ name: string; value: string; domain: string }>;
}

interface CaptureData {
  startedAt: string;
  endedAt: string;
  requests: CapturedRequest[];
  responses: CapturedResponse[];
  cookieSnapshots: CookieSnapshot[];
  setCaptchaCaptures: SetCaptchaCapture[];
  navigationLog: Array<{ timestamp: string; tab: string; url: string; title: string }>;
}

// ─── État global ─────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.join(__dirname, "..", "captured", "cev");
const capture: CaptureData = {
  startedAt: new Date().toISOString(),
  endedAt: "",
  requests: [],
  responses: [],
  cookieSnapshots: [],
  setCaptchaCaptures: [],
  navigationLog: [],
};

let requestCounter = 0;
const requestIdMap = new WeakMap<Request, number>();
const requestTimings = new Map<number, number>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function shouldCapture(url: string): boolean {
  return CAPTURE_DOMAINS.some((d) => url.includes(d));
}

function parseCookieString(cookieHeader: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  cookieHeader.split(";").forEach((pair) => {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      result[key] = val;
    }
  });
  return result;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Rapport de comparaison ──────────────────────────────────────────────────

function buildComparisonReport(setCaptureList: SetCaptchaCapture[]): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════════════╗");
  lines.push("║      RAPPORT DE COMPARAISON — BROWSER vs BOT HTTP               ║");
  lines.push("║      CEV Portail : appointment.cloud.diplomatie.be               ║");
  lines.push("╚══════════════════════════════════════════════════════════════════╝");
  lines.push("");
  lines.push(`Capture effectuée le : ${new Date().toLocaleString("fr-FR")}`);
  lines.push(`Nombre de SetCaptchaToken capturés : ${setCaptureList.length}`);
  lines.push("");

  if (setCaptureList.length === 0) {
    lines.push("⚠️  Aucun POST SetCaptchaToken intercepté.");
    lines.push("   → As-tu résolu le captcha pendant la session ?");
    return lines.join("\n");
  }

  setCaptureList.forEach((cap, i) => {
    lines.push("═".repeat(68));
    lines.push(`CAPTURE #${i + 1} — ${cap.timestamp}  (onglet: ${cap.tab})`);
    lines.push("═".repeat(68));
    lines.push("");

    // ── Cookies browser ─────────────────────────────────────────────────────
    lines.push("── COOKIES envoyés par le BROWSER dans le POST SetCaptchaToken ──");
    const browserCookieNames = Object.keys(cap.requestCookies);
    if (browserCookieNames.length === 0) {
      lines.push("  (aucun cookie dans la requête)");
    } else {
      browserCookieNames.forEach((name) => {
        const val = cap.requestCookies[name];
        const preview = val.length > 60 ? val.slice(0, 60) + "…" : val;
        lines.push(`  • ${name} = ${preview}`);
      });
    }
    lines.push("");

    // ── Cookies bot ──────────────────────────────────────────────────────────
    lines.push("── COOKIES que notre BOT envoie dans le POST SetCaptchaToken ────");
    lines.push("  • ASP.NET_SessionId = <valeur>   (cookie de session CEV)");
    lines.push("  • PreferredCulture = en-US");
    lines.push("");

    // ── Analyse des différences ─────────────────────────────────────────────
    lines.push("── ANALYSE DES DIFFÉRENCES ──────────────────────────────────────");
    const botCookies = new Set(["asp.net_sessionid", "preferredculture"]);
    const browserOnlyCookies = browserCookieNames.filter(
      (n) => !botCookies.has(n.toLowerCase())
    );

    if (browserOnlyCookies.length === 0) {
      lines.push("  ✅ Aucun cookie supplémentaire détecté — browser = bot");
      lines.push("     → L'hypothèse des cookies hCaptcha manquants est INFIRMÉE");
    } else {
      lines.push(`  🚨 ${browserOnlyCookies.length} cookie(s) SUPPLÉMENTAIRE(S) envoyé(s) par le browser :`);
      browserOnlyCookies.forEach((name) => {
        const val = cap.requestCookies[name];
        const isHcaptcha = name.toLowerCase().includes("hc") ||
          name.toLowerCase().includes("captcha") ||
          name.toLowerCase().includes("hmt");
        const marker = isHcaptcha ? " ← 🔴 COOKIE HCAPTCHA WIDGET" : "";
        const preview = val.length > 80 ? val.slice(0, 80) + "…" : val;
        lines.push(`     • ${name} = ${preview}${marker}`);
      });
      lines.push("");
      lines.push("  → Ces cookies sont ABSENTS de notre bot → HYPOTHÈSE CONFIRMÉE");
      lines.push("  → Le serveur belge discrimine probablement les sessions sans ces cookies");
    }
    lines.push("");

    // ── Cookies contexte (tous les cookies à ce moment-là) ──────────────────
    lines.push("── TOUS les cookies présents dans le navigateur au moment du POST ─");
    const cevCookies = cap.cookiesAtMoment.filter((c) =>
      c.domain.includes("diplomatie.be") || c.domain.includes("hcaptcha.com")
    );
    if (cevCookies.length === 0) {
      lines.push("  (aucun cookie diplomatie.be ou hcaptcha.com)");
    } else {
      cevCookies.forEach((c) => {
        const preview = c.value.length > 60 ? c.value.slice(0, 60) + "…" : c.value;
        const marker = c.name.toLowerCase().includes("hc") ? " ← hCaptcha widget" : "";
        lines.push(`  [${c.domain}] ${c.name} = ${preview}${marker}`);
      });
    }
    lines.push("");

    // ── Headers browser ──────────────────────────────────────────────────────
    lines.push("── HEADERS envoyés par le BROWSER ───────────────────────────────");
    Object.entries(cap.requestHeaders).forEach(([k, v]) => {
      if (k.toLowerCase() === "cookie") return; // déjà affiché
      lines.push(`  ${k}: ${v}`);
    });
    lines.push("");

    // ── Body ─────────────────────────────────────────────────────────────────
    lines.push("── BODY du POST ─────────────────────────────────────────────────");
    lines.push(`  ${cap.requestBody || "(vide)"}`);
    lines.push("");

    // ── Réponse serveur ──────────────────────────────────────────────────────
    lines.push("── RÉPONSE SERVEUR ──────────────────────────────────────────────");
    lines.push(`  Status : ${cap.responseStatus}`);
    lines.push(`  validUntil : ${cap.validUntil ?? "(absent)"}`);
    lines.push(`  redirectUrl : ${cap.redirectUrl ?? "(absent)"}`);
    lines.push(`  Verdict final : ${cap.finalVerdict ?? "inconnu"}`);
    lines.push("");

    if (cap.finalVerdict?.includes("NoAvailability")) {
      lines.push("  🔴 VERDICT : NoAvailability — même avec le browser humain");
      lines.push("     → Soit pas de créneaux actuellement, soit le problème est ailleurs");
    } else if (cap.finalVerdict?.includes("SelectSlot")) {
      lines.push("  ✅ VERDICT : SelectSlot — créneaux disponibles (browser confirme)");
      lines.push("     → Si le bot obtient NoAvailability ici, les cookies sont la cause");
    }
    lines.push("");
  });

  lines.push("═".repeat(68));
  lines.push("CONCLUSION");
  lines.push("═".repeat(68));

  const extraCookiesFound = setCaptureList.some((cap) => {
    const botCookies = new Set(["asp.net_sessionid", "preferredculture"]);
    return Object.keys(cap.requestCookies).some(
      (n) => !botCookies.has(n.toLowerCase())
    );
  });

  if (extraCookiesFound) {
    lines.push("🔴 HYPOTHÈSE CONFIRMÉE : le browser envoie des cookies supplémentaires.");
    lines.push("   Solution : injecter ces cookies dans notre flow HTTP avant le POST SetCaptchaToken.");
  } else {
    lines.push("✅ HYPOTHÈSE INFIRMÉE : aucun cookie supplémentaire détecté.");
    lines.push("   Le problème vient d'ailleurs (fingerprinting TLS, headers, timing, etc.).");
  }
  lines.push("");

  return lines.join("\n");
}

// ─── Attachement des listeners sur une page ──────────────────────────────────

function attachListeners(page: Page, context: BrowserContext, label: string): void {
  page.on("request", (req: Request) => {
    const url = req.url();
    if (!shouldCapture(url)) return;

    requestCounter++;
    const id = requestCounter;
    requestIdMap.set(req, id);
    requestTimings.set(id, Date.now());

    const cookieHeader = req.headers()["cookie"] ?? "";
    const cookies = parseCookieString(cookieHeader);

    const captured: CapturedRequest = {
      id,
      timestamp: new Date().toISOString(),
      method: req.method(),
      url,
      headers: req.headers(),
      cookies,
      postData: req.postData() ?? null,
      resourceType: req.resourceType(),
      tab: label,
    };
    capture.requests.push(captured);

    const isPost = req.method() !== "GET";
    if (isPost || url.includes("SetCaptchaToken") || url.includes("GetEAppointmentUrl")) {
      console.log(`\n  🔵 [${ts()}] [${label}] ${req.method()} ${url}`);
      if (req.postData()) {
        const preview = req.postData()!.slice(0, 120);
        console.log(`     📤 Body: ${preview}`);
      }
      const cookieNames = Object.keys(cookies);
      if (cookieNames.length > 0) {
        console.log(`     🍪 Cookies (${cookieNames.length}): ${cookieNames.join(", ")}`);
      }
    }
  });

  page.on("response", async (res: Response) => {
    const url = res.url();
    if (!shouldCapture(url)) return;

    const req = res.request();
    const id = requestIdMap.get(req) ?? 0;
    const start = requestTimings.get(id) ?? Date.now();
    const duration = Date.now() - start;

    let body: string | null = null;
    try {
      const ct = res.headers()["content-type"] ?? "";
      if (
        ct.includes("json") ||
        ct.includes("text") ||
        ct.includes("html") ||
        ct.includes("javascript")
      ) {
        body = await res.text().catch(() => null);
      }
    } catch {
      // not readable
    }

    capture.responses.push({
      id: capture.responses.length + 1,
      requestId: id,
      timestamp: new Date().toISOString(),
      url,
      status: res.status(),
      headers: res.headers(),
      body,
      durationMs: duration,
    });

    // ── INTERCEPTION PRIORITAIRE : SetCaptchaToken ───────────────────────────
    if (url.includes("SetCaptchaToken") && req.method() === "POST") {
      console.log("\n");
      console.log("╔══════════════════════════════════════════════════════════════╗");
      console.log("║  🎯 POST SetCaptchaToken INTERCEPTÉ !                        ║");
      console.log("╚══════════════════════════════════════════════════════════════╝");

      const cookieHeader = req.headers()["cookie"] ?? "";
      const requestCookies = parseCookieString(cookieHeader);

      // Récupérer tous les cookies du contexte à ce moment
      let allCookies: Array<{ name: string; value: string; domain: string }> = [];
      try {
        const ctxCookies = await context.cookies();
        allCookies = ctxCookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
        }));
      } catch {
        // ignore
      }

      // Parser la réponse
      let redirectUrl: string | null = null;
      let validUntil: string | null = null;
      let finalVerdict: string | null = null;

      try {
        if (body) {
          const parsed = JSON.parse(body);
          redirectUrl = parsed.redirectUrl ?? parsed.RedirectUrl ?? null;
          validUntil = parsed.validUntil ?? parsed.ValidUntil ?? null;
        }
      } catch {
        // pas JSON
      }

      // Suivre le redirect pour le verdict final
      if (redirectUrl) {
        try {
          const fullRedirectUrl = redirectUrl.startsWith("http")
            ? redirectUrl
            : `${CEV_BASE}${redirectUrl}`;
          const verdictRes = await fetch(fullRedirectUrl, {
            method: "GET",
            redirect: "follow",
            headers: {
              "Cookie": cookieHeader,
              "User-Agent": req.headers()["user-agent"] ?? "",
            },
            signal: AbortSignal.timeout(15_000),
          });
          finalVerdict = verdictRes.url;
        } catch {
          finalVerdict = "erreur suivi redirect";
        }
      }

      const cap: SetCaptchaCapture = {
        timestamp: new Date().toISOString(),
        tab: label,
        requestHeaders: req.headers(),
        requestCookies,
        requestBody: req.postData() ?? "",
        responseStatus: res.status(),
        responseHeaders: res.headers(),
        responseBody: body ?? "",
        redirectUrl,
        validUntil,
        finalVerdict,
        cookiesAtMoment: allCookies,
      };

      capture.setCaptchaCaptures.push(cap);

      // Affichage terminal immédiat
      const botCookies = new Set(["asp.net_sessionid", "preferredculture"]);
      const browserOnlyCookies = Object.keys(requestCookies).filter(
        (n) => !botCookies.has(n.toLowerCase())
      );

      console.log(`  ⏱  ${cap.timestamp}`);
      console.log(`  🍪 Cookies dans le POST (${Object.keys(requestCookies).length}) :`);
      Object.entries(requestCookies).forEach(([k, v]) => {
        const iExtra = !botCookies.has(k.toLowerCase());
        const marker = iExtra ? " ← ABSENT DU BOT" : "";
        const preview = v.length > 60 ? v.slice(0, 60) + "…" : v;
        console.log(`     ${iExtra ? "🔴" : "⚪"} ${k} = ${preview}${marker}`);
      });
      console.log("");

      if (browserOnlyCookies.length > 0) {
        console.log(`  🚨 ${browserOnlyCookies.length} cookie(s) supplémentaire(s) vs bot !`);
        const hcCookies = browserOnlyCookies.filter((n) =>
          n.toLowerCase().includes("hc") || n.toLowerCase().includes("captcha")
        );
        if (hcCookies.length > 0) {
          console.log(`  🔴 Cookies hCaptcha widget détectés : ${hcCookies.join(", ")}`);
          console.log("  → HYPOTHÈSE CONFIRMÉE — ces cookies manquent à notre bot");
        }
      } else {
        console.log("  ✅ Aucun cookie supplémentaire — browser = bot en termes de cookies");
      }

      console.log(`  📍 redirectUrl : ${redirectUrl ?? "(absent)"}`);
      console.log(`  🕐 validUntil  : ${validUntil ?? "(absent)"}`);
      if (finalVerdict) {
        const verdictEmoji = finalVerdict.includes("NoAvailability") ? "🔴" : finalVerdict.includes("SelectSlot") ? "✅" : "❓";
        console.log(`  ${verdictEmoji} Verdict final : ${finalVerdict}`);
      }
      console.log("═".repeat(66));
    }

    // Log pour les requêtes importantes
    if (url.includes("GetEAppointmentUrl") || url.includes("NoAvailability") || url.includes("SelectSlot") || res.status() >= 400) {
      const emoji = res.status() >= 400 ? "🔴" : "🟢";
      console.log(`  ${emoji} [${ts()}] [${label}] ${res.status()} ${url.slice(0, 100)} (${duration}ms)`);
    }
  });

  // Navigation tracking
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!shouldCapture(url) && !url.includes("visaonweb") && !url.includes("diplomatie")) return;

    const title = await page.title().catch(() => "");
    capture.navigationLog.push({
      timestamp: new Date().toISOString(),
      tab: label,
      url,
      title,
    });
    console.log(`  🧭 [${ts()}] [${label}] NAV → ${url.slice(0, 90)}`);
    if (title) console.log(`         Titre: ${title}`);

    // Snapshot cookies à chaque navigation importante
    if (url.includes("diplomatie.be") || url.includes("hcaptcha")) {
      try {
        const cookies = await context.cookies();
        const relevant = cookies.filter(
          (c) =>
            c.domain.includes("diplomatie.be") ||
            c.domain.includes("hcaptcha.com")
        );
        capture.cookieSnapshots.push({
          timestamp: new Date().toISOString(),
          trigger: `nav:${url.slice(0, 80)}`,
          tab: label,
          cookies: relevant.map((c) => ({
            name: c.name,
            value: c.value.slice(0, 100),
            domain: c.domain,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite ?? "None",
            expires: c.expires,
          })),
        });
        if (relevant.length > 0) {
          const names = relevant.map((c) => c.name).join(", ");
          console.log(`  🍪 [${ts()}] Cookies snapshot (${relevant.length}): ${names}`);
        }
      } catch {
        // ignore
      }
    }
  });
}

// ─── Sauvegarde finale ───────────────────────────────────────────────────────

function saveResults(): void {
  ensureDir(OUTPUT_DIR);
  const stamp = Date.now();

  // JSON brut complet
  const rawFile = path.join(OUTPUT_DIR, `capture-${stamp}.json`);
  fs.writeFileSync(rawFile, JSON.stringify(capture, null, 2), "utf-8");

  // Rapport de comparaison lisible
  const report = buildComparisonReport(capture.setCaptchaCaptures);
  const reportFile = path.join(OUTPUT_DIR, `comparison-${stamp}.txt`);
  fs.writeFileSync(reportFile, report, "utf-8");

  // Résumé des SetCaptchaToken seulement
  const capturesSummary = path.join(OUTPUT_DIR, `set-captcha-tokens-${stamp}.json`);
  fs.writeFileSync(
    capturesSummary,
    JSON.stringify(capture.setCaptchaCaptures, null, 2),
    "utf-8"
  );

  console.log("\n\n" + "═".repeat(66));
  console.log("  💾 SAUVEGARDE TERMINÉE");
  console.log("═".repeat(66));
  console.log(`  📁 Données brutes     : ${rawFile}`);
  console.log(`  📋 Rapport comparaison: ${reportFile}`);
  console.log(`  🎯 SetCaptchaToken(s) : ${capturesSummary}`);
  console.log(`  📊 Stats :`);
  console.log(`     - ${capture.requests.length} requêtes capturées`);
  console.log(`     - ${capture.setCaptchaCaptures.length} POST SetCaptchaToken`);
  console.log(`     - ${capture.cookieSnapshots.length} snapshots cookies`);
  console.log(`     - ${capture.navigationLog.length} navigations`);
  console.log("═".repeat(66));

  // Afficher le rapport directement dans le terminal
  console.log("\n\n" + report);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  ensureDir(OUTPUT_DIR);

  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   🇧🇪 CEV CAPTURE INTERACTIVE — diplomatie.be                    ║");
  console.log("║   Comparaison cookies Browser vs Bot HTTP                        ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("  Le navigateur va s'ouvrir sur VOWINT.");
  console.log("");
  console.log("  📌 Ce que tu dois faire :");
  console.log("     1. Connecte-toi avec ton compte VOWINT");
  console.log("     2. Va sur 'Mes demandes' (IndexByUserId)");
  console.log("     3. Clique sur 'Prendre rendez-vous' pour un dossier");
  console.log("     4. Un nouvel onglet CEV s'ouvre → page Captcha");
  console.log("     5. Résous le hCaptcha manuellement");
  console.log("     6. Attends le verdict (NoAvailability ou SelectSlot)");
  console.log("     7. Ferme le navigateur quand tu as terminé");
  console.log("");
  console.log("  ✅ Le script intercepte automatiquement le POST SetCaptchaToken");
  console.log("  ✅ Analyse immédiate des cookies affichée dans le terminal");
  console.log("  ✅ Rapport complet sauvegardé dans captured/cev/");
  console.log("");
  console.log("  ⏳ Lancement du navigateur...");
  console.log("");

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--start-maximized",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
    ],
  });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    locale: "fr-BE",
    timezoneId: "Africa/Kinshasa",
    ignoreHTTPSErrors: true,
  });

  // ── Écouter les nouveaux onglets (popup CEV) ─────────────────────────────
  let tabCounter = 0;
  context.on("page", (newPage: Page) => {
    tabCounter++;
    const label = `tab_${tabCounter}`;
    console.log(`\n  🆕 [${ts()}] Nouvel onglet : ${label}`);
    attachListeners(newPage, context, label);
  });

  // ── Page principale ───────────────────────────────────────────────────────
  const page = await context.newPage();
  tabCounter++;
  attachListeners(page, context, `tab_${tabCounter}`);

  console.log(`  🌐 Navigation vers ${VOWINT_BASE}...`);
  await page.goto(VOWINT_BASE, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Snapshot initial cookies
  try {
    const cookies = await context.cookies();
    capture.cookieSnapshots.push({
      timestamp: new Date().toISOString(),
      trigger: "initial",
      tab: "tab_1",
      cookies: cookies
        .filter((c) => c.domain.includes("diplomatie.be"))
        .map((c) => ({
          name: c.name,
          value: c.value.slice(0, 100),
          domain: c.domain,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite ?? "None",
          expires: c.expires,
        })),
    });
  } catch {
    // ignore
  }

  console.log("  ✅ Navigateur ouvert — à toi de jouer !");
  console.log("  📡 Surveillance active sur :");
  CAPTURE_DOMAINS.forEach((d) => console.log(`     - ${d}`));
  console.log("");
  console.log("  ─────────────────────────────────────────────────────────────");
  console.log("  En attente du POST SetCaptchaToken...");
  console.log("  Ferme le navigateur quand tu as terminé.");
  console.log("  ─────────────────────────────────────────────────────────────");

  // Attendre fermeture navigateur
  await new Promise<void>((resolve) => {
    browser.on("disconnected", () => resolve());
  });

  capture.endedAt = new Date().toISOString();
  saveResults();
}

main().catch((err) => {
  console.error("\n❌ Erreur fatale :", err);
  capture.endedAt = new Date().toISOString();
  saveResults();
  process.exit(1);
});
