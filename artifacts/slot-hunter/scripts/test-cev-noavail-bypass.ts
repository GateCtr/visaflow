/**
 * test-cev-noavail-bypass.ts — Test si POST /Home/AvailableTimeSlots
 * fonctionne SANS suivre le redirectUrl de SetCaptchaToken.
 *
 * Hypothèse : La session CEV (ASP.NET_SessionId) est activée par SetCaptchaToken
 * indépendamment du redirect. Si on ne suit PAS le redirect (qui mène à NoAvailability
 * et tue la session), on pourrait poll en boucle rapide.
 *
 * SCENARIOS TESTÉS :
 *   A) Setup complet → NE PAS suivre redirect → poll AvailableTimeSlots
 *   B) Setup complet → suivre redirect → poll AvailableTimeSlots (contrôle)
 *   C) Setup complet → poll AVANT SetCaptchaToken (cookie brut)
 *   D) Setup complet → SetCaptchaToken → poll multi-mois en boucle rapide
 */

import "dotenv/config";
import { Impit } from "impit";

// ─── Config ─────────────────────────────────────────────────────────────────

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";

const VOWINT_EMAIL = "screentapinc@gmail.com";
const VOWINT_PASSWORD = "Akollad@2026";

const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY ?? "";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? "";

// Proxy SOAX
const SOAX_BASE = process.env.SOAX_PROXY_URL ?? "";


// ─── Helpers ────────────────────────────────────────────────────────────────

let impit: Impit | null = null;

function getProxyUrl(): string {
  if (!SOAX_BASE) return "";
  // SOAX sticky session with random session ID
  const sessionId = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const parsed = new URL(SOAX_BASE);
    const pass = decodeURIComponent(parsed.password);
    const newPass = `${pass}_country-cd_city-kinshasa_sessionid-${sessionId}_sessiontime-600`;
    parsed.password = encodeURIComponent(newPass);
    return parsed.toString();
  } catch {
    return SOAX_BASE;
  }
}

function getImpit(): Impit {
  if (!impit) {
    const proxyUrl = getProxyUrl();
    log("INIT", `Proxy: ${proxyUrl ? proxyUrl.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "DIRECT (no proxy)"}`);
    impit = new Impit(proxyUrl ? { proxy: proxyUrl } : {});
  }
  return impit;
}

async function fetchViaTls(url: string, options: RequestInit): Promise<Response> {
  const imp = getImpit();
  return imp.fetch(url, options) as unknown as Response;
}

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function extractSetCookies(res: Response): string[] {
  // impit may return set-cookie as comma-separated or via getSetCookie
  const cookies: string[] = [];
  const raw = res.headers.get("set-cookie");
  if (raw) {
    // Split on commas that are NOT inside expires dates
    // Simple approach: split by ", " followed by a cookie name pattern
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
    if (eqIdx > 0) {
      const name = mainPart.slice(0, eqIdx);
      const value = mainPart.slice(eqIdx + 1);
      pairs.set(name, value);
    }
  }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

// Accumulate all set-cookie headers across requests
let allSetCookies: string[] = [];

function accumulateCookies(res: Response): string {
  const newCookies = extractSetCookies(res);
  for (const nc of newCookies) {
    const name = nc.split("=")[0].split(";")[0].trim();
    // Replace existing cookie with same name
    allSetCookies = allSetCookies.filter(c => !c.startsWith(`${name}=`));
    allSetCookies.push(nc);
  }
  return buildCookieHeader(allSetCookies);
}


// ─── VOWINT Login ───────────────────────────────────────────────────────────

async function loginVowint(): Promise<{ cookies: string; appId: string; ua: string } | null> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

  // Reset cookie jar
  allSetCookies = [];

  log("LOGIN", "GET page login...");
  const loginPage = await fetchViaTls(`${VOWINT_BASE}/`, {
    method: "GET",
    headers: { "User-Agent": ua, "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    redirect: "follow",
  });
  if (!loginPage.ok) {
    log("LOGIN", `❌ GET login page failed: ${loginPage.status}`);
    return null;
  }
  const loginHtml = await loginPage.text();
  accumulateCookies(loginPage);
  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) { log("LOGIN", "❌ CSRF token not found"); return null; }
  const csrfToken = tokenMatch[1];
  let cookies = buildCookieHeader(allSetCookies);
  log("LOGIN", `CSRF token: ${csrfToken.slice(0, 20)}... | Cookies: ${cookies.slice(0, 60)}...`);

  log("LOGIN", "POST login...");
  const loginRes = await fetchViaTls(`${VOWINT_BASE}/en/Account/Login`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookies,
      "Referer": `${VOWINT_BASE}/`,
      "Origin": VOWINT_BASE,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    body: new URLSearchParams({
      __RequestVerificationToken: csrfToken,
      UserName: VOWINT_EMAIL,
      Password: VOWINT_PASSWORD,
    }).toString(),
    redirect: "manual",
  });

  log("LOGIN", `POST status: ${loginRes.status}`);
  accumulateCookies(loginRes);
  cookies = buildCookieHeader(allSetCookies);
  if (loginRes.status !== 302) {
    const body = await loginRes.text();
    log("LOGIN", `❌ Login failed (expected 302, got ${loginRes.status}). Body: ${body.slice(0, 300)}`);
    return null;
  }


  // Follow redirects
  let redirectUrl = loginRes.headers.get("location");
  for (let i = 0; i < 5 && redirectUrl; i++) {
    const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${VOWINT_BASE}${redirectUrl}`;
    const r = await fetchViaTls(fullUrl, {
      method: "GET",
      headers: { "User-Agent": ua, "Cookie": buildCookieHeader(allSetCookies), "Referer": `${VOWINT_BASE}/` },
      redirect: "manual",
    });
    accumulateCookies(r);
    if (r.status >= 300 && r.status < 400) { redirectUrl = r.headers.get("location"); }
    else break;
  }
  cookies = buildCookieHeader(allSetCookies);
  log("LOGIN", `✅ Login OK. Cookies: ${cookies.slice(0, 80)}...`);

  // Get dossier list via MyList
  log("LOGIN", "GET MyList...");
  await fetchViaTls(`${VOWINT_BASE}/VisaApplication/DataTables`, {
    method: "GET",
    headers: { "User-Agent": ua, "Cookie": cookies, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*" },
  }).then(r => { accumulateCookies(r); return r.text(); }).catch(() => {});
  cookies = buildCookieHeader(allSetCookies);

  const dtUrl = `${VOWINT_BASE}/VisaApplication/MyList?draw=1&columns%5B0%5D%5Bdata%5D=VOWId&columns%5B0%5D%5Bname%5D=VOWUniqueId&columns%5B0%5D%5Bsearchable%5D=true&columns%5B0%5D%5Borderable%5D=true&columns%5B0%5D%5Bsearch%5D%5Bvalue%5D=&columns%5B0%5D%5Bsearch%5D%5Bregex%5D=false&order%5B0%5D%5Bcolumn%5D=0&order%5B0%5D%5Bdir%5D=asc&start=0&length=50&search%5Bvalue%5D=&search%5Bregex%5D=false`;
  const listRes = await fetchViaTls(dtUrl, {
    method: "GET",
    headers: { "User-Agent": ua, "Cookie": cookies, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*" },
  });
  const listText = await listRes.text();
  let appId = "";
  try {
    const data = JSON.parse(listText) as { data?: Array<{ Id?: string; VOWId?: string }> };
    log("LOGIN", `Dossiers trouvés: ${data.data?.length ?? 0}`);
    data.data?.forEach((d, i) => log("LOGIN", `  #${i}: ${d.VOWId} → ${d.Id?.slice(0, 8)}…`));
    appId = data.data?.[0]?.Id ?? "";
  } catch {
    log("LOGIN", `⚠️ MyList parse error: ${listText.slice(0, 200)}`);
    const m = listText.match(/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/i);
    if (m) appId = m[0];
  }
  if (!appId) { log("LOGIN", "❌ No appId found"); return null; }
  log("LOGIN", `✅ AppId: ${appId}`);

  return { cookies, appId, ua };
}


// ─── Captcha Solving (AntiCaptcha) ──────────────────────────────────────────

async function solveHcaptcha(pageUrl: string): Promise<string | null> {
  log("CAPTCHA", `Solving hCaptcha for ${pageUrl.slice(0, 60)}...`);

  // Try AntiCaptcha first
  if (ANTICAPTCHA_KEY) {
    const result = await solveViaAntiCaptcha(pageUrl);
    if (result) return result;
  }
  // Fallback to 2captcha
  const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY ?? "";
  if (TWOCAPTCHA_KEY) {
    const result = await solveVia2Captcha(pageUrl, TWOCAPTCHA_KEY);
    if (result) return result;
  }
  // Fallback to Capsolver
  if (CAPSOLVER_KEY) {
    const result = await solveViaCapsolver(pageUrl);
    if (result) return result;
  }
  log("CAPTCHA", "❌ All captcha providers failed");
  return null;
}

async function solveVia2Captcha(pageUrl: string, apiKey: string): Promise<string | null> {
  log("CAPTCHA", "Using 2captcha...");
  const params = new URLSearchParams({
    key: apiKey,
    method: "hcaptcha",
    sitekey: HCAPTCHA_SITEKEY,
    pageurl: pageUrl,
    json: "1",
  });
  const createRes = await fetch(`https://2captcha.com/in.php?${params}`);
  const createData = await createRes.json() as any;
  if (createData.status !== 1) {
    log("CAPTCHA", `❌ 2captcha create error: ${createData.request}`);
    return null;
  }
  const requestId = createData.request;
  log("CAPTCHA", `Task created: ${requestId}`);

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const getRes = await fetch(`https://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
    const getData = await getRes.json() as any;
    if (getData.status === 1) {
      log("CAPTCHA", `✅ Solved in ${(i + 1) * 5}s`);
      return getData.request;
    }
    if (getData.request !== "CAPCHA_NOT_READY") {
      log("CAPTCHA", `❌ 2captcha error: ${getData.request}`);
      return null;
    }
    if (i % 6 === 5) log("CAPTCHA", `  ...waiting (${(i + 1) * 5}s)`);
  }
  log("CAPTCHA", "❌ 2captcha timeout");
  return null;
}

async function solveViaAntiCaptcha(pageUrl: string): Promise<string | null> {
  log("CAPTCHA", "Using AntiCaptcha...");
  const createRes = await fetch("https://api.anti-captcha.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: ANTICAPTCHA_KEY,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: HCAPTCHA_SITEKEY,
      },
    }),
  });
  const createData = await createRes.json() as any;
  if (createData.errorId !== 0) {
    log("CAPTCHA", `❌ AntiCaptcha create error: ${createData.errorDescription}`);
    return null;
  }
  const taskId = createData.taskId;
  log("CAPTCHA", `Task created: ${taskId}`);

  // Poll for result (max 300s — hCaptcha can take a while)
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const getRes = await fetch("https://api.anti-captcha.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId }),
    });
    const getData = await getRes.json() as any;
    if (getData.status === "ready") {
      const token = getData.solution?.gRecaptchaResponse ?? getData.solution?.token ?? null;
      log("CAPTCHA", `✅ Solved in ${(i + 1) * 5}s`);
      return token;
    }
    if (getData.errorId !== 0) {
      log("CAPTCHA", `❌ AntiCaptcha error: ${getData.errorDescription}`);
      return null;
    }
    if (i % 6 === 5) log("CAPTCHA", `  ...waiting (${(i + 1) * 5}s)`);
  }
  log("CAPTCHA", "❌ AntiCaptcha timeout (300s)");
  return null;
}


async function solveViaCapsolver(pageUrl: string): Promise<string | null> {
  log("CAPTCHA", "Using Capsolver...");
  const createRes = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_KEY,
      task: {
        type: "HCaptchaTaskProxyless",
        websiteURL: pageUrl,
        websiteKey: HCAPTCHA_SITEKEY,
      },
    }),
  });
  const createData = await createRes.json() as any;
  if (createData.errorId !== 0) {
    log("CAPTCHA", `❌ Capsolver create error: ${createData.errorDescription}`);
    return null;
  }
  const taskId = createData.taskId;
  log("CAPTCHA", `Task created: ${taskId}`);

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const getRes = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId }),
    });
    const getData = await getRes.json() as any;
    if (getData.status === "ready") {
      const token = getData.solution?.gRecaptchaResponse ?? getData.solution?.token ?? null;
      log("CAPTCHA", `✅ Solved in ${(i + 1) * 3}s`);
      return token;
    }
    if (getData.errorId !== 0) {
      log("CAPTCHA", `❌ Capsolver error: ${getData.errorDescription}`);
      return null;
    }
  }
  log("CAPTCHA", "❌ Capsolver timeout");
  return null;
}


// ─── CEV Session Setup ──────────────────────────────────────────────────────

interface CevSession {
  integrationUrl: string;
  cevCookie: string;   // ASP.NET_SessionId value
  validUntil: string;
  redirectUrl: string;
  ua: string;
}

async function setupCevSession(
  vowintCookies: string,
  appId: string,
  ua: string,
): Promise<CevSession | null> {
  // Step 1: GetEAppointmentUrl (= 1 clic VOWINT)
  log("CEV", `GET GetEAppointmentUrl?id=${appId.slice(0, 8)}...`);
  const eUrl = `${VOWINT_BASE}/Common/GetEAppointmentUrl?id=${appId}`;
  const eRes = await fetchViaTls(eUrl, {
    method: "GET",
    headers: {
      "User-Agent": ua,
      "Cookie": vowintCookies,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/html, */*",
      "Referer": `${VOWINT_BASE}/en/VisaApplication/IndexByUserId`,
    },
    redirect: "manual",
  });

  let integrationUrl = "";
  if (eRes.ok) {
    const eText = await eRes.text();
    // Check rate limit
    if (/5\s*fois|too\s*many|blocked/i.test(eText)) {
      log("CEV", `❌ RATE LIMITED: ${eText.slice(0, 200)}`);
      return null;
    }
    try {
      const eData = JSON.parse(eText);
      if (typeof eData === "string") integrationUrl = eData;
      else if (eData?.url) integrationUrl = eData.url;
    } catch {
      if (eText.includes("/Integration/VOW/")) integrationUrl = eText.trim().replace(/^"|"$/g, "");
    }
  } else if (eRes.status >= 300 && eRes.status < 400) {
    const loc = eRes.headers.get("location") ?? "";
    if (loc.includes("/Integration/VOW/")) {
      integrationUrl = loc.startsWith("http") ? loc : `${CEV_BASE}${loc}`;
    }
  }

  if (!integrationUrl) {
    log("CEV", `❌ No integration URL (status ${eRes.status})`);
    return null;
  }
  log("CEV", `✅ Integration URL: ${integrationUrl.slice(0, 80)}...`);


  // Step 2: GET integrationUrl → get CEV ASP.NET_SessionId cookie
  log("CEV", "GET integration URL for CEV cookie...");
  const cevRes = await fetchViaTls(integrationUrl, {
    method: "GET",
    headers: { "User-Agent": ua, "Referer": `${VOWINT_BASE}/` },
    redirect: "manual",
  });
  log("CEV", `  Status: ${cevRes.status}, Location: ${cevRes.headers.get("location")?.slice(0, 80) ?? "none"}`);
  const setCookieHeader = cevRes.headers.get("set-cookie") ?? "";
  const cevCookieMatch = setCookieHeader.match(/ASP\.NET_SessionId=([^;]+)/);
  if (!cevCookieMatch) {
    log("CEV", `❌ No CEV session cookie. Headers: ${setCookieHeader.slice(0, 200)}`);
    return null;
  }
  const cevCookie = cevCookieMatch[1];
  log("CEV", `✅ CEV cookie: ${cevCookie.slice(0, 20)}...`);

  // Step 2b: Follow the redirect to /Captcha page (needed to associate session with dossier)
  const cevRedirectLoc = cevRes.headers.get("location");
  if (cevRedirectLoc) {
    const captchaNavUrl = cevRedirectLoc.startsWith("http") ? cevRedirectLoc : `${CEV_BASE}${cevRedirectLoc}`;
    log("CEV", `  Following initial redirect to: ${captchaNavUrl.slice(0, 80)}`);
    const navRes = await fetchViaTls(captchaNavUrl, {
      method: "GET",
      headers: {
        "User-Agent": ua,
        "Cookie": `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`,
        "Referer": integrationUrl,
      },
      redirect: "follow",
    });
    log("CEV", `  Captcha page status: ${navRes.status}, url: ${(navRes as any).url ?? "?"}`);
    const navBody = await navRes.text();
    const hasHcaptcha = navBody.toLowerCase().includes("hcaptcha") || navBody.toLowerCase().includes("h-captcha");
    log("CEV", `  Has hCaptcha on page: ${hasHcaptcha}, body len: ${navBody.length}`);
  }

  // Step 3: Solve hCaptcha
  const captchaPageUrl = `${CEV_BASE}/Captcha`;
  const hcaptchaToken = await solveHcaptcha(captchaPageUrl);
  if (!hcaptchaToken) {
    log("CEV", "❌ Captcha solving failed");
    return null;
  }

  // Step 4: POST SetCaptchaToken
  log("CEV", "POST SetCaptchaToken...");
  const fullCookie = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  const captchaRes = await fetchViaTls(`${CEV_BASE}/Captcha/SetCaptchaToken`, {
    method: "POST",
    headers: {
      "User-Agent": ua,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": fullCookie,
      "Referer": `${CEV_BASE}/Captcha`,
      "Origin": CEV_BASE,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
    },
    body: new URLSearchParams({ captcha: hcaptchaToken }).toString(),
  });

  if (!captchaRes.ok) {
    log("CEV", `❌ SetCaptchaToken failed: ${captchaRes.status}`);
    return null;
  }
  const captchaData = await captchaRes.json() as any;
  log("CEV", `✅ SetCaptchaToken response: validUntil=${captchaData.validUntil}, redirectUrl=${captchaData.redirectUrl?.slice(0, 80)}`);

  return {
    integrationUrl,
    cevCookie,
    validUntil: captchaData.validUntil ?? "",
    redirectUrl: captchaData.redirectUrl ?? "",
    ua,
  };
}


// ─── Poll: POST /Home/AvailableTimeSlots ────────────────────────────────────

async function pollAvailableSlots(
  cevCookie: string,
  ua: string,
  month: number,
  year: number,
  label: string,
): Promise<{ status: string; body: string; httpStatus: number }> {
  const cookieHeader = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  const res = await fetchViaTls(`${CEV_BASE}/Home/AvailableTimeSlots`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cookie": cookieHeader,
      "User-Agent": ua,
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Accept-Language": "fr-BE,fr;q=0.9,en-US;q=0.8,en;q=0.7",
      "Referer": `${CEV_BASE}/Integration/VOW/SelectSlot`,
      "Origin": CEV_BASE,
      "Cache-Control": "no-cache",
    },
    body: JSON.stringify({ month, year }),
    redirect: "manual",
  });

  const httpStatus = res.status;
  if (httpStatus >= 300 && httpStatus < 400) {
    const loc = res.headers.get("location") ?? "";
    log(label, `  → Redirect ${httpStatus} → ${loc}`);
    return { status: "redirect", body: loc, httpStatus };
  }
  if (httpStatus === 403 || httpStatus === 401) {
    log(label, `  → ${httpStatus} (session expired)`);
    return { status: "expired", body: "", httpStatus };
  }
  const body = await res.text();
  if (!res.ok) {
    log(label, `  → HTTP ${httpStatus}: ${body.slice(0, 200)}`);
    return { status: "error", body, httpStatus };
  }
  return { status: "ok", body, httpStatus };
}


// ─── Follow redirect (for control test) ─────────────────────────────────────

async function followRedirect(
  redirectUrl: string,
  cevCookie: string,
  ua: string,
): Promise<{ finalUrl: string; body: string }> {
  const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${CEV_BASE}${redirectUrl}`;
  const cookieHeader = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  log("REDIRECT", `Following: ${fullUrl.slice(0, 80)}...`);
  const res = await fetchViaTls(fullUrl, {
    method: "GET",
    headers: {
      "User-Agent": ua,
      "Cookie": cookieHeader,
      "Referer": `${CEV_BASE}/Captcha`,
    },
    redirect: "follow",
  });
  const body = await res.text();
  const finalUrl = (res as any).url ?? fullUrl;
  log("REDIRECT", `  Final URL: ${finalUrl}`);
  log("REDIRECT", `  Status: ${res.status}, Body len: ${body.length}`);
  const hasNoAvail = body.toLowerCase().includes("noavailability") || finalUrl.includes("NoAvailability");
  log("REDIRECT", `  NoAvailability: ${hasNoAvail}`);
  return { finalUrl, body };
}


// ─── Main Test Scenarios ────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  TEST: CEV NoAvailability Bypass");
  console.log("  Can we poll /Home/AvailableTimeSlots WITHOUT following redirect?");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Step 1: Login VOWINT
  const session = await loginVowint();
  if (!session) { console.log("\n❌ ABORT: Login failed"); process.exit(1); }

  // Step 2: Setup CEV session (consumes 1 click)
  const cev = await setupCevSession(session.cookies, session.appId, session.ua);
  if (!cev) { console.log("\n❌ ABORT: CEV setup failed"); process.exit(1); }

  const now = new Date();
  const curMonth = now.getMonth() + 1;
  const curYear = now.getFullYear();
  const nextMonth = curMonth === 12 ? 1 : curMonth + 1;
  const nextYear = curMonth === 12 ? curYear + 1 : curYear;

  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO A: Poll SANS suivre le redirect
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  SCENARIO A: Poll SANS suivre redirectUrl                    ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");
  log("A", `RedirectUrl (non suivi): ${cev.redirectUrl}`);

  log("A", `Poll mois courant (${curMonth}/${curYear})...`);
  const a1 = await pollAvailableSlots(cev.cevCookie, cev.ua, curMonth, curYear, "A");
  log("A", `  Résultat: status=${a1.status}, http=${a1.httpStatus}, body=${a1.body.slice(0, 300)}`);

  log("A", `Poll mois suivant (${nextMonth}/${nextYear})...`);
  const a2 = await pollAvailableSlots(cev.cevCookie, cev.ua, nextMonth, nextYear, "A");
  log("A", `  Résultat: status=${a2.status}, http=${a2.httpStatus}, body=${a2.body.slice(0, 300)}`);

  // Poll en boucle rapide (5 polls toutes les 2s)
  log("A", "Poll rapide (5x, 2s interval)...");
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const p = await pollAvailableSlots(cev.cevCookie, cev.ua, curMonth, curYear, `A-rapid-${i}`);
    log("A", `  Poll ${i + 1}/5: status=${p.status}, http=${p.httpStatus}, body=${p.body.slice(0, 100)}`);
    if (p.status === "expired" || p.status === "redirect") {
      log("A", "  ⚠️ Session morte — arrêt boucle rapide");
      break;
    }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // SCENARIO B: Suivre le redirect PUIS poll (contrôle — session probablement morte)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  SCENARIO B: Suivre redirect PUIS poll (contrôle)            ║");
  console.log("╚═══════════════════════════════════════════════════════════════╝\n");

  if (cev.redirectUrl) {
    const redirectResult = await followRedirect(cev.redirectUrl, cev.cevCookie, cev.ua);
    log("B", `Final URL après redirect: ${redirectResult.finalUrl}`);

    log("B", `Poll après redirect (${curMonth}/${curYear})...`);
    const b1 = await pollAvailableSlots(cev.cevCookie, cev.ua, curMonth, curYear, "B");
    log("B", `  Résultat: status=${b1.status}, http=${b1.httpStatus}, body=${b1.body.slice(0, 300)}`);
  } else {
    log("B", "⚠️ Pas de redirectUrl — skip");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  RÉSUMÉ DES RÉSULTATS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Scenario A (sans redirect): ${a1.status === "ok" ? "✅ SESSION VIVANTE" : "❌ Session morte"}`);
  console.log(`  → Si A fonctionne, on peut poll en boucle rapide sans consommer de clics!`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // Cleanup
  if (impit) { (impit as any).close?.(); }
}

main().catch(err => {
  console.error("💥 Crash:", err);
  process.exit(1);
});
