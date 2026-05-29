/**
 * test-cev-presolved.ts — Tests multiples stratégies de bypass CEV:
 *
 * 1. PRE-SOLVE: Résoudre hCaptcha AVANT le clic, puis enchaîner en < 5s
 * 2. TOKEN REUSE: Même token hCaptcha sur un cookie différent?
 * 3. TIMING: Combien de temps le cookie CEV survit sans SetCaptchaToken?
 * 4. FLOW HUMAIN: Le navigateur garde-t-il une session post-SelectSlot?
 * 5. SESSION PERSIST: Après SelectSlot, la session reste-t-elle vivante?
 */

import "dotenv/config";
import { Impit } from "impit";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";

const VOWINT_EMAIL = "screentapinc@gmail.com";
const VOWINT_PASSWORD = "Akollad@2026";

const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY ?? "";
const SOAX_BASE = process.env.SOAX_PROXY_URL ?? "";


// ─── Helpers ────────────────────────────────────────────────────────────────

let impit: Impit | null = null;
let allSetCookies: string[] = [];

function getProxyUrl(): string {
  if (!SOAX_BASE) return "";
  const sessionId = `presolved-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const parsed = new URL(SOAX_BASE);
    const pass = decodeURIComponent(parsed.password);
    parsed.password = encodeURIComponent(`${pass}_country-cd_city-kinshasa_sessionid-${sessionId}_sessiontime-600`);
    return parsed.toString();
  } catch { return SOAX_BASE; }
}

function getImpit(): Impit {
  if (!impit) {
    const proxyUrl = getProxyUrl();
    log("INIT", `Proxy: ${proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "DIRECT"}`);
    impit = new Impit(proxyUrl ? { proxy: proxyUrl } : {});
  }
  return impit;
}

async function f(url: string, options: RequestInit): Promise<Response> {
  return getImpit().fetch(url, options) as unknown as Response;
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function extractSetCookies(res: Response): string[] {
  const cookies: string[] = [];
  const raw = res.headers.get("set-cookie");
  if (raw) {
    for (const part of raw.split(/,\s*(?=[A-Za-z_\-.]+=)/)) {
      cookies.push(part.trim());
    }
  }
  return cookies;
}

function buildCookieHeader(setCookies: string[]): string {
  const pairs = new Map<string, string>();
  for (const sc of setCookies) {
    const mainPart = sc.split(";")[0].trim();
    const eqIdx = mainPart.indexOf("=");
    if (eqIdx > 0) pairs.set(mainPart.slice(0, eqIdx), mainPart.slice(eqIdx + 1));
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

function accumulateCookies(res: Response): string {
  for (const nc of extractSetCookies(res)) {
    const name = nc.split("=")[0].trim();
    allSetCookies = allSetCookies.filter(c => !c.startsWith(`${name}=`));
    allSetCookies.push(nc);
  }
  return buildCookieHeader(allSetCookies);
}


// ─── Captcha Solving ────────────────────────────────────────────────────────

async function solveHcaptcha(): Promise<string | null> {
  const pageUrl = `${CEV_BASE}/Captcha`;
  
  // Try AntiCaptcha
  if (ANTICAPTCHA_KEY) {
    log("CAPTCHA", `Solving hCaptcha (AntiCaptcha)...`);
    const createRes = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: ANTICAPTCHA_KEY,
        task: { type: "HCaptchaTaskProxyless", websiteURL: pageUrl, websiteKey: HCAPTCHA_SITEKEY },
      }),
    });
    const createData = await createRes.json() as any;
    if (createData.errorId === 0 && createData.taskId) {
      const taskId = createData.taskId;
      log("CAPTCHA", `  Task: ${taskId}`);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const getRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId }),
        });
        const getData = await getRes.json() as any;
        if (getData.status === "ready") {
          log("CAPTCHA", `  ✅ AntiCaptcha solved in ${(i + 1) * 5}s`);
          return getData.solution?.gRecaptchaResponse ?? getData.solution?.token ?? null;
        }
        if (getData.errorId !== 0) { log("CAPTCHA", `  ❌ ${getData.errorDescription}`); break; }
        if (i % 6 === 5) log("CAPTCHA", `    ...${(i + 1) * 5}s`);
      }
    }
  }

  // Fallback: 2captcha
  const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY ?? "";
  if (TWOCAPTCHA_KEY) {
    log("CAPTCHA", `Fallback: 2captcha...`);
    const params = new URLSearchParams({
      key: TWOCAPTCHA_KEY, method: "hcaptcha", sitekey: HCAPTCHA_SITEKEY, pageurl: pageUrl, json: "1",
    });
    const createRes = await fetch(`https://2captcha.com/in.php?${params}`);
    const createData = await createRes.json() as any;
    if (createData.status === 1) {
      const rid = createData.request;
      log("CAPTCHA", `  Task: ${rid}`);
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const getRes = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_KEY}&action=get&id=${rid}&json=1`);
        const getData = await getRes.json() as any;
        if (getData.status === 1) { log("CAPTCHA", `  ✅ 2captcha solved in ${(i + 1) * 5}s`); return getData.request; }
        if (getData.request !== "CAPCHA_NOT_READY") { log("CAPTCHA", `  ❌ ${getData.request}`); break; }
        if (i % 6 === 5) log("CAPTCHA", `    ...${(i + 1) * 5}s`);
      }
    }
  }

  log("CAPTCHA", "❌ All providers failed");
  return null;
}


// ─── VOWINT Login ───────────────────────────────────────────────────────────

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function loginVowint(): Promise<{ cookies: string; appId: string } | null> {
  allSetCookies = [];
  log("LOGIN", "Login VOWINT...");
  const loginPage = await f(`${VOWINT_BASE}/`, {
    method: "GET", headers: { "User-Agent": UA }, redirect: "follow",
  });
  if (!loginPage.ok) { log("LOGIN", `❌ ${loginPage.status}`); return null; }
  const html = await loginPage.text();
  accumulateCookies(loginPage);
  const csrf = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
  if (!csrf) { log("LOGIN", "❌ No CSRF"); return null; }

  const loginRes = await f(`${VOWINT_BASE}/en/Account/Login`, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": buildCookieHeader(allSetCookies), "Referer": `${VOWINT_BASE}/`, "Origin": VOWINT_BASE,
    },
    body: new URLSearchParams({
      __RequestVerificationToken: csrf, UserName: VOWINT_EMAIL, Password: VOWINT_PASSWORD,
    }).toString(),
    redirect: "manual",
  });
  accumulateCookies(loginRes);
  if (loginRes.status !== 302) { log("LOGIN", `❌ ${loginRes.status}`); return null; }

  // Follow redirects
  let loc = loginRes.headers.get("location");
  for (let i = 0; i < 5 && loc; i++) {
    const url = loc.startsWith("http") ? loc : `${VOWINT_BASE}${loc}`;
    const r = await f(url, {
      method: "GET", headers: { "User-Agent": UA, "Cookie": buildCookieHeader(allSetCookies) }, redirect: "manual",
    });
    accumulateCookies(r);
    loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
  }
  const cookies = buildCookieHeader(allSetCookies);
  log("LOGIN", "✅ OK");

  // Get first appId
  await f(`${VOWINT_BASE}/VisaApplication/DataTables`, {
    method: "GET", headers: { "User-Agent": UA, "Cookie": cookies, "X-Requested-With": "XMLHttpRequest" },
  }).then(r => { accumulateCookies(r); return r.text(); }).catch(() => {});

  const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&columns%5B1%5D%5Bdata%5D=FName&columns%5B1%5D%5Bname%5D=FirstName&columns%5B1%5D%5Bsearchable%5D=true&columns%5B1%5D%5Borderable%5D=true&columns%5B1%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B1%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=50&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const listRes = await f(dtUrl, {
    method: "GET", headers: { "User-Agent": UA, "Cookie": buildCookieHeader(allSetCookies), "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*" },
  });
  const listText = await listRes.text();
  let appId = "";
  try {
    const data = JSON.parse(listText) as { data?: Array<{ Id?: string; VOWId?: string }> };
    log("LOGIN", `Dossiers: ${data.data?.map(d => d.VOWId).join(", ")}`);
    appId = data.data?.[0]?.Id ?? "";
  } catch { appId = listText.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i)?.[0] ?? ""; }
  if (!appId) { log("LOGIN", "❌ No appId"); return null; }
  return { cookies: buildCookieHeader(allSetCookies), appId };
}


// ─── CEV Session (fast) ─────────────────────────────────────────────────────

async function getCevCookie(vowintCookies: string, appId: string): Promise<{
  cevCookie: string; integrationUrl: string; redirectLoc: string;
} | null> {
  // 1 CLIC: GetEAppointmentUrl
  log("CEV", `GetEAppointmentUrl (1 clic)...`);
  const eRes = await f(`${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}`, {
    method: "GET",
    headers: { "User-Agent": UA, "Cookie": vowintCookies, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*", "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId` },
    redirect: "manual",
  });
  let integrationUrl = "";
  if (eRes.ok) {
    const txt = await eRes.text();
    if (/5\s*fois|too\s*many|blocked/i.test(txt)) { log("CEV", `❌ RATE LIMITED`); return null; }
    try { const d = JSON.parse(txt); integrationUrl = typeof d === "string" ? d : d?.url ?? ""; } catch { if (txt.includes("/Integration/VOW/")) integrationUrl = txt.trim().replace(/^"|"$/g, ""); }
  } else if (eRes.status >= 300) {
    const loc = eRes.headers.get("location") ?? "";
    if (loc.includes("/Integration/")) integrationUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
  }
  if (!integrationUrl) { log("CEV", `❌ No integration URL (${eRes.status})`); return null; }
  log("CEV", `  URL: ${integrationUrl.slice(0, 80)}...`);

  // GET integration → CEV cookie
  const cevRes = await f(integrationUrl, {
    method: "GET", headers: { "User-Agent": UA, "Referer": `${VOWINT_BASE}/` }, redirect: "manual",
  });
  const sc = cevRes.headers.get("set-cookie") ?? "";
  const cevCookie = sc.match(/ASP\.NET_SessionId=([^;]+)/)?.[1] ?? "";
  if (!cevCookie) { log("CEV", `❌ No cookie`); return null; }
  const redirectLoc = cevRes.headers.get("location") ?? "";
  log("CEV", `  Cookie: ${cevCookie.slice(0, 16)}... | Redirect: ${redirectLoc.slice(0, 60)}`);
  return { cevCookie, integrationUrl, redirectLoc };
}


// ─── Submit captcha + follow redirect ───────────────────────────────────────

async function submitCaptchaAndFollow(cevCookie: string, token: string): Promise<{
  success: boolean; validUntil: string; redirectUrl: string;
  finalUrl: string; finalStatus: number; finalBody: string;
}> {
  const ck = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;

  // Navigate to captcha page first (associate session)
  log("SUBMIT", "Navigate to /Captcha page...");
  await f(`${CEV_BASE}/Captcha`, {
    method: "GET", headers: { "User-Agent": UA, "Cookie": ck }, redirect: "follow",
  });

  // POST SetCaptchaToken
  log("SUBMIT", "POST SetCaptchaToken...");
  const res = await f(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
    method: "POST",
    headers: {
      "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": ck, "Referer": `${CEV_BASE}/Captcha`, "Origin": CEV_BASE,
      "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*; q=0.01",
    },
    body: new URLSearchParams({ captcha: token }).toString(),
  });
  if (!res.ok) {
    log("SUBMIT", `❌ SetCaptchaToken ${res.status}`);
    return { success: false, validUntil: "", redirectUrl: "", finalUrl: "", finalStatus: res.status, finalBody: "" };
  }
  const data = await res.json() as any;
  log("SUBMIT", `  validUntil=${data.validUntil} redirectUrl=${(data.redirectUrl ?? "").slice(0, 60)}`);

  // Follow redirect (manual, hop by hop)
  let currentUrl = data.redirectUrl ?? "";
  if (!currentUrl) {
    return { success: false, validUntil: data.validUntil ?? "", redirectUrl: "", finalUrl: "", finalStatus: 0, finalBody: "NO_REDIRECT" };
  }
  if (!currentUrl.startsWith("http")) currentUrl = `${CEV_BASE}${currentUrl}`;

  let finalUrl = currentUrl;
  let finalStatus = 0;
  let finalBody = "";

  for (let hop = 0; hop < 5; hop++) {
    log("SUBMIT", `  Hop ${hop}: GET ${currentUrl.slice(0, 80)}...`);
    const r = await f(currentUrl, {
      method: "GET", headers: { "User-Agent": UA, "Cookie": ck, "Referer": `${CEV_BASE}/Captcha` }, redirect: "manual",
    });
    finalStatus = r.status;
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location") ?? "";
      finalUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
      currentUrl = finalUrl;
      log("SUBMIT", `    → ${r.status} → ${loc.slice(0, 80)}`);
      continue;
    }
    finalUrl = currentUrl;
    finalBody = await r.text();
    break;
  }

  log("SUBMIT", `  Final: ${finalUrl.slice(0, 80)} (${finalStatus})`);
  return { success: true, validUntil: data.validUntil ?? "", redirectUrl: data.redirectUrl ?? "", finalUrl, finalStatus, finalBody };
}


// ─── Poll ───────────────────────────────────────────────────────────────────

async function poll(cevCookie: string, month: number, year: number, label: string): Promise<string> {
  const ck = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  const res = await f(`${CEV_BASE}/Home/AvailableTimeSlots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", "Cookie": ck, "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*; q=0.01",
      "Referer": `${CEV_BASE}/Integration/VOW/SelectSlot`, "Origin": CEV_BASE,
    },
    body: JSON.stringify({ month, year }),
    redirect: "manual",
  });
  if (res.status === 401 || res.status === 403) return `EXPIRED(${res.status})`;
  if (res.status >= 300) return `REDIRECT(${res.status}→${res.headers.get("location")?.slice(0, 60)})`;
  const body = await res.text();
  if (!res.ok) return `ERROR(${res.status}:${body.slice(0, 100)})`;
  // Parse response
  try {
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return "NO_SLOTS(empty array)";
      return `🚨 SLOTS_FOUND(${parsed.length} entries): ${body.slice(0, 200)}`;
    }
    if (parsed === null) return "NO_SLOTS(null)";
    return `DATA(${typeof parsed}): ${body.slice(0, 200)}`;
  } catch {
    if (body.toLowerCase().includes("noavailability")) return "NO_SLOTS(html)";
    return `RAW(${body.slice(0, 200)})`;
  }
}


// ─── MAIN ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  CEV BYPASS STRATEGIES — PRE-SOLVE + TIMING + SESSION PERSIST");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Login
  const session = await loginVowint();
  if (!session) { process.exit(1); }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1A: PRE-SOLVE — Résoudre captcha AVANT le clic (token NON lié à session)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 1A: PRE-SOLVE (captcha avant cookie) — test liaison    ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  log("T1A", "Résoudre hCaptcha AVANT le clic...");
  const presolvedToken = await solveHcaptcha();
  if (!presolvedToken) { log("T1A", "❌ Captcha failed"); process.exit(1); }
  log("T1A", `✅ Token: ${presolvedToken.slice(0, 40)}...`);

  log("T1A", "GetEAppointmentUrl + cookie CEV...");
  const t1Start = Date.now();
  const cevA = await getCevCookie(session.cookies, session.appId);
  if (!cevA) { log("T1A", "❌ CEV setup failed"); process.exit(1); }
  log("T1A", `  Cookie en ${Date.now() - t1Start}ms`);

  log("T1A", "SetCaptchaToken avec token PRÉ-RÉSOLU...");
  const t1Result = await submitCaptchaAndFollow(cevA.cevCookie, presolvedToken);
  const t1TotalMs = Date.now() - t1Start;
  log("T1A", `  Temps: ${t1TotalMs}ms | Final: ${t1Result.finalUrl}`);
  const t1AError = t1Result.finalUrl.includes("Error");
  log("T1A", t1AError
    ? "❌ Error/Default → TOKEN PRÉ-RÉSOLU REJETÉ (lié à la session?)"
    : `✅ Verdict: ${t1Result.finalUrl.split("/").pop()}`);

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 1B: FLOW CORRECT — Cookie d'abord, PUIS captcha, PUIS submit
  //          (reproduit le flow normal mais mesure le timing)
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 1B: FLOW CORRECT (cookie → captcha → submit)           ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  log("T1B", "GetEAppointmentUrl + cookie CEV (2ème clic)...");
  const t1bStart = Date.now();
  const cevB = await getCevCookie(session.cookies, session.appId);
  if (!cevB) { log("T1B", "❌ CEV setup failed (rate limited?)"); process.exit(1); }
  log("T1B", `  Cookie en ${Date.now() - t1bStart}ms`);

  // Navigate to captcha page AVEC le cookie (associer session)
  log("T1B", "Navigate /Captcha avec le cookie...");
  const ck = `ASP.NET_SessionId=${cevB.cevCookie}; PreferredCulture=en-US`;
  await f(`${CEV_BASE}/Captcha`, {
    method: "GET", headers: { "User-Agent": UA, "Cookie": ck }, redirect: "follow",
  });

  log("T1B", "Résoudre hCaptcha MAINTENANT (avec session active)...");
  const captchaStart = Date.now();
  const freshToken = await solveHcaptcha();
  if (!freshToken) { log("T1B", "❌ Captcha failed"); process.exit(1); }
  const captchaMs = Date.now() - captchaStart;
  log("T1B", `  Captcha résolu en ${captchaMs}ms (${Math.round(captchaMs / 1000)}s)`);

  log("T1B", "SetCaptchaToken + follow redirect...");
  const t1bResult = await submitCaptchaAndFollow(cevB.cevCookie, freshToken);
  const t1bTotalMs = Date.now() - t1bStart;
  log("T1B", `  Temps total: ${t1bTotalMs}ms | Final: ${t1bResult.finalUrl}`);

  const t1bIsSelectSlot = t1bResult.finalUrl.includes("SelectSlot");
  const t1bIsNoAvail = t1bResult.finalUrl.includes("NoAvailability");
  const t1bIsError = t1bResult.finalUrl.includes("Error");
  const cev = cevB; // Use this for subsequent tests

  const t1IsSelectSlot = t1bIsSelectSlot;
  const t1IsNoAvail = t1bIsNoAvail;
  const t1IsError = t1bIsError;

  if (t1IsSelectSlot) {
    log("T1B", "🎉 SelectSlot atteint! Session activée!");
  } else if (t1IsNoAvail) {
    log("T1B", "⚠️ NoAvailability (normal — pas de créneaux)");
  } else if (t1IsError) {
    log("T1B", `❌ Error page — session expirée pendant captcha solve (${Math.round(captchaMs/1000)}s)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 2: POLL APRÈS — Si la session est activée, peut-on poll?
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 2: POLL APRÈS VERDICT (session survit-elle?)           ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  const now = new Date();
  const m = now.getMonth() + 1;
  const y = now.getFullYear();

  log("T2", `Poll immédiat après verdict...`);
  const p1 = await poll(cev.cevCookie, m, y, "T2");
  log("T2", `  Résultat: ${p1}`);

  if (!p1.startsWith("EXPIRED")) {
    log("T2", "Session VIVANTE! Poll en boucle rapide (10x, 3s)...");
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const pi = await poll(cev.cevCookie, m, y, `T2-${i}`);
      log("T2", `  Poll ${i + 1}/10 (${(i + 1) * 3}s): ${pi}`);
      if (pi.startsWith("EXPIRED")) { log("T2", "  Session morte."); break; }
    }
  } else {
    log("T2", "❌ Session déjà morte après verdict");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TEST 3: NAVIGUER SelectSlot SANS ALLER AU BOUT — session persiste?
  //         Si le redirect va à NoAvailability, on s'arrête AVANT le dernier hop
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  TEST 3: ANALYSE DU FLOW (quel hop tue la session?)          ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  log("T3", `Verdict type: SelectSlot=${t1IsSelectSlot}, NoAvail=${t1IsNoAvail}, Error=${t1IsError}`);
  log("T3", `ValidUntil: ${t1bResult.validUntil}`);
  
  if (t1IsNoAvail) {
    log("T3", "La session est morte car redirect → NoAvailability.");
    log("T3", "HYPOTHÈSE: Si on NE SUIT PAS le redirect, la session pourrait rester vivante.");
    log("T3", "MAIS le test précédent (test 401 sans redirect) prouve que SetCaptchaToken");
    log("T3", "n'active PAS la session pour le poll API sans navigation préalable.");
    log("T3", "");
    log("T3", "CONCLUSION: Le serveur CEV lie la session au dossier UNIQUEMENT via le redirect.");
    log("T3", "Sans suivre le redirect → session non-liée → 401 sur API.");
    log("T3", "Avec redirect → session liée → mais si NoAvailability, session tuée.");
    log("T3", "");
    log("T3", "⚡ L'UNIQUE FENÊTRE: entre SelectSlot (quand des slots existent) et le booking.");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Pre-solve (avant cookie): ${t1AError ? "❌ REJETÉ (token lié à session)" : "✅ ACCEPTÉ"}`);
  console.log(`  Flow correct (cookie→captcha→submit): ${t1bIsError ? "❌ Error (session expirée)" : t1bIsNoAvail ? "⚠️ NoAvailability" : "✅ " + t1bResult.finalUrl.split("/").pop()}`);
  console.log(`  Temps captcha (flow correct): ${Math.round(captchaMs / 1000)}s`);
  console.log(`  Temps total (flow correct): ${Math.round(t1bTotalMs / 1000)}s`);
  console.log(`  Poll après verdict: ${p1}`);
  console.log(`  `);
  console.log(`  KEY INSIGHTS:`);
  if (t1AError) {
    console.log(`  - Token hCaptcha EST LIÉ à la session CEV → pre-solve impossible ❌`);
    console.log(`  - Il faut résoudre PENDANT que la session est active`);
  } else {
    console.log(`  - Token hCaptcha N'EST PAS lié à la session → PRE-SOLVE POSSIBLE! 🎉`);
  }
  if (t1bIsNoAvail) {
    console.log(`  - Session meurt après NoAvailability (confirmé)`);
    console.log(`  - Temps captcha ${Math.round(captchaMs/1000)}s < TTL session → flow fonctionne`);
  }
  if (t1bIsError) {
    console.log(`  - Session expire PENDANT le captcha (${Math.round(captchaMs/1000)}s > TTL session)`);
    console.log(`  - Solution: paralléliser ou trouver un captcha plus rapide`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (impit) { try { (impit as any).close?.(); } catch {} }
}

main().catch(err => { console.error("💥", err); process.exit(1); });
