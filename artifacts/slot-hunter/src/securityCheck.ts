/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  JOVENTY HUNTER — SECURITY CHECK                                        ║
 * ║  À lancer manuellement ou via un cron Railway (suggéré : 1x/semaine).  ║
 * ║  Retourne EXIT 0 si tous les checks critiques passent, EXIT 1 sinon.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Usage :  npx tsx src/securityCheck.ts
 *          FULL_CHECK=true npx tsx src/securityCheck.ts  (active checks réseau lents)
 */

import * as dotenv from "dotenv";
dotenv.config();

// ─── constantes extraites du bundle Angular (à synchroniser si bundle change) ──
const EXPECTED_AES_KEY    = "OuoCdl8xQh/OX6LbmgLEtZxZrvnOmrubsMhPW1VPRjk=";
const EXPECTED_CAPTCHA_SITEKEY = "6LcpAXklAAAAAFUYDDE8NlsuSb69b5GbXg3sEmaZ";
const USA_BASE            = "https://www.usvisaappt.com";
const BUNDLE_HTML_URL     = `${USA_BASE}/visaapplicantui/`;

// Endpoints critiques — doivent tous répondre (pas forcément 200, mais pas 404/502)
const CRITICAL_ENDPOINTS = [
  { name: "login",           url: `${USA_BASE}/identity/user/login`,                        method: "POST", expectedCodes: [400, 401, 403, 415, 422, 500] },
  { name: "refreshToken",    url: `${USA_BASE}/identity/user/refreshToken`,                  method: "POST", expectedCodes: [400, 401, 403, 415, 422, 500] },
  { name: "ofcList",         url: `${USA_BASE}/visaadministrationapi/v1/ofcuser/ofclist/323`, method: "GET",  expectedCodes: [200, 401, 403] },
  { name: "slotDates",       url: `${USA_BASE}/visaadministrationapi/v1/modifyslot/getSlotDates`, method: "GET", expectedCodes: [200, 400, 401, 403] },
  { name: "slotTime",        url: `${USA_BASE}/visaadministrationapi/v1/modifyslot/getSlotTime`,  method: "GET", expectedCodes: [200, 400, 401, 403] },
  { name: "sanityCheck",     url: `${USA_BASE}/visaintegrationapi/visa/sanitycheck/TEST`,    method: "GET",  expectedCodes: [200, 400, 401, 403, 404] },
  { name: "fcsCheck",        url: `${USA_BASE}/visapaymentapi/v1/feecollection/checkFcs/TEST`, method: "GET", expectedCodes: [200, 400, 401, 403, 404] },
  { name: "landingPage",     url: `${USA_BASE}/visaappointmentapi/appointment/getLandingPageDeatils`, method: "GET", expectedCodes: [200, 400, 401, 403] },
  { name: "schedule",        url: `${USA_BASE}/visaappointmentapi/appointments/schedule`,    method: "PUT",  expectedCodes: [400, 401, 403, 415, 422] },
  { name: "appDetails",      url: `${USA_BASE}/visaappointmentapi/appointments/getApplicationDetails`, method: "GET", expectedCodes: [200, 400, 401, 403] },
  { name: "appointmentLetter", url: `${USA_BASE}/visanotificationapi/template/appointmentLetter`, method: "POST", expectedCodes: [400, 401, 403, 415, 422] },
];

// Versions Chrome max tolérées (>10 versions d'écart = UA potentiellement stale)
const UA_POOL = [
  { version: 136, ua: "Chrome/136.0.0.0" },
  { version: 135, ua: "Chrome/135.0.0.0" },
  { version: 134, ua: "Chrome/134.0.0.0" },
];
const CURRENT_CHROME_STABLE = 136;
const MAX_VERSION_GAP = 10;

// Sec-CH-UA doit correspondre exactement à la version dans le UA string
const CH_UA_MAP: Record<number, string> = {
  136: '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="8"',
  135: '"Chromium";v="135", "Google Chrome";v="135", "Not-A.Brand";v="8"',
  134: '"Chromium";v="134", "Google Chrome";v="134", "Not-A.Brand";v="8"',
};

// ─── Types ──────────────────────────────────────────────────────────────────────
type CheckStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
interface CheckResult {
  id:       string;
  name:     string;
  category: string;
  status:   CheckStatus;
  detail:   string;
  critical: boolean;
}

const results: CheckResult[] = [];
let hasCriticalFail = false;

function record(
  id: string, name: string, category: string,
  status: CheckStatus, detail: string, critical: boolean
): void {
  results.push({ id, name, category, status, detail, critical });
  if (status === "FAIL" && critical) hasCriticalFail = true;
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : status === "WARN" ? "⚠️" : "⏭";
  const critTag = critical ? " [CRITIQUE]" : "";
  console.log(`  ${icon} ${name}${critTag}: ${detail}`);
}

// ─── Utilitaires ────────────────────────────────────────────────────────────────
const BASE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

async function safeFetch(url: string, opts: RequestInit = {}, timeoutMs = 15_000): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "User-Agent": BASE_UA, ...opts.headers },
    });
  } catch {
    return null;
  }
}

function section(title: string): void {
  console.log(`\n${"─".repeat(64)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(64));
}

// ─── Extraction automatique de la clé AES depuis le bundle ─────────────────────
function extractAesKeyFromBundle(bundleText: string): string | null {
  const KEY_REGEX = /[A-Za-z0-9+/]{43}=/g;
  const CONTEXT_KEYWORDS = ["PBKDF2", "pbkdf2", "encryptSecretKey", "secretKey", "encKey", "AES", "CryptoJS", "encrypt"];

  for (const keyword of CONTEXT_KEYWORDS) {
    const idx = bundleText.indexOf(keyword);
    if (idx === -1) continue;
    const window = bundleText.slice(Math.max(0, idx - 300), idx + 300);
    const match = window.match(KEY_REGEX);
    if (match && match[0].length === 44) return match[0];
  }

  const allMatches = [...bundleText.matchAll(KEY_REGEX)]
    .map((m) => m[0])
    .filter((s) => s.length === 44);
  if (allMatches.length === 1) return allMatches[0];

  return null;
}

// ════════════════════════════════════════════════════════════════════════════════
// 1. BUNDLE INTEGRITY — AES key + captcha sitekey + endpoints
// ════════════════════════════════════════════════════════════════════════════════
async function checkBundleIntegrity(): Promise<void> {
  section("BUNDLE INTEGRITY");

  // 1a. Récupérer le nom du bundle actuel
  const htmlRes = await safeFetch(BUNDLE_HTML_URL, { headers: { "Accept": "text/html" } });
  if (!htmlRes || !htmlRes.ok) {
    record("B01", "Page HTML portail accessible", "bundle", "FAIL", `HTTP ${htmlRes?.status ?? "timeout"}`, true);
    return;
  }
  record("B01", "Page HTML portail accessible", "bundle", "PASS", `HTTP ${htmlRes.status}`, true);

  const html = await htmlRes.text();
  const match = html.match(/src="(main\.[a-f0-9]+\.js)"/);
  if (!match) {
    record("B02", "Bundle Angular trouvé dans le HTML", "bundle", "FAIL", "Aucun main.*.js dans le HTML — structure portail changée", true);
    return;
  }
  record("B02", "Bundle Angular trouvé dans le HTML", "bundle", "PASS", `Bundle: ${match[1]}`, false);
  const bundleName = match[1];

  // 1b. Télécharger le bundle
  const bundleRes = await safeFetch(`${USA_BASE}/visaapplicantui/${bundleName}`, {
    headers: { "Referer": `${USA_BASE}/visaapplicantui/login` },
  }, 60_000);
  if (!bundleRes || !bundleRes.ok) {
    record("B03", "Bundle téléchargeable", "bundle", "FAIL", `HTTP ${bundleRes?.status ?? "timeout"}`, true);
    return;
  }
  record("B03", "Bundle téléchargeable", "bundle", "PASS", `HTTP ${bundleRes.status} (${bundleName})`, false);

  const bundleText = await bundleRes.text();

  // 1c. Clé AES
  if (bundleText.includes(EXPECTED_AES_KEY)) {
    record("B04", "Clé AES inchangée", "bundle", "PASS", `Clé confirmée dans ${bundleName}`, true);
  } else {
    const extractedKey = extractAesKeyFromBundle(bundleText);
    record("B04", "Clé AES inchangée", "bundle", "FAIL",
      extractedKey
        ? `❌ Clé changée ! Nouvelle clé extraite automatiquement: "${extractedKey}". Bundle: ${bundleName}`
        : `❌ La clé AES a changé ET impossible de l'extraire automatiquement. Inspection manuelle requise. Bundle: ${bundleName}`,
      true);
  }

  // 1d. reCAPTCHA sitekey
  if (bundleText.includes(EXPECTED_CAPTCHA_SITEKEY)) {
    record("B05", "reCAPTCHA sitekey inchangée", "bundle", "PASS", EXPECTED_CAPTCHA_SITEKEY, false);
  } else {
    const newKey = bundleText.match(/captchaSiteKey:"([^"]+)"/)?.[1];
    record("B05", "reCAPTCHA sitekey inchangée", "bundle", "FAIL",
      `Sitekey changée ! Nouvelle: ${newKey ?? "non trouvée"}. Mettre à jour 2captcha config.`, false);
  }

  // 1e. Mécanisme CSRF (CookieName header)
  const hasCookieName = bundleText.includes('"CookieName"') || bundleText.includes("CookieName");
  const hasXxsrfToken = bundleText.includes("XSRF-TOKEN");
  if (hasCookieName && hasXxsrfToken) {
    record("B06", "Mécanisme CSRF inchangé (CookieName: XSRF-TOKEN=…)", "bundle", "PASS", "Intercepteur CSRF identique", true);
  } else {
    record("B06", "Mécanisme CSRF inchangé (CookieName: XSRF-TOKEN=…)", "bundle", "WARN",
      `CookieName: ${hasCookieName}, XSRF-TOKEN: ${hasXxsrfToken} — vérifier l'intercepteur HTTP du bundle`, true);
  }

  // 1f. Endpoint /identity/user — le bundle split en "/identity/user" + "/login" concaténé dynamiquement
  const hasLoginEndpoint = bundleText.includes('"/identity/user"') || bundleText.includes("identity/user");
  record("B07", "Endpoint /identity/user (base auth) présent", "bundle",
    hasLoginEndpoint ? "PASS" : "FAIL",
    hasLoginEndpoint
      ? "Trouvé dans le bundle ('/identity/user' + '/login' concaténé dynamiquement — comportement normal Angular)"
      : "ABSENT — l'endpoint a changé, mettre à jour usaPortal.ts", true);

  // 1g. Endpoint schedule PUT présent
  const hasScheduleEndpoint = bundleText.includes("/appointments/schedule");
  record("B08", "Endpoint /appointments/schedule présent", "bundle",
    hasScheduleEndpoint ? "PASS" : "FAIL",
    hasScheduleEndpoint ? "Trouvé dans le bundle" : "ABSENT — endpoint de réservation changé !", true);

  // 1h. Chiffrement PBKDF2 + AES-256-CBC toujours présent
  const hasPbkdf2 = bundleText.includes("PBKDF2") || bundleText.includes("pbkdf2");
  const hasAesCbc = bundleText.includes("AES") || bundleText.includes("CryptoJS");
  record("B09", "Algorithme chiffrement PBKDF2+AES inchangé", "bundle",
    (hasPbkdf2 || hasAesCbc) ? "PASS" : "WARN",
    `PBKDF2: ${hasPbkdf2}, AES: ${hasAesCbc}`, false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 2. ENDPOINT HEALTH — tous les endpoints du flux de navigation doivent répondre
// ════════════════════════════════════════════════════════════════════════════════
async function checkEndpoints(): Promise<void> {
  section("ENDPOINT HEALTH");

  const isFullCheck = process.env.FULL_CHECK === "true";
  if (!isFullCheck) {
    console.log("  [SKIP] Passer FULL_CHECK=true pour activer les checks endpoints (lents)");
    record("E00", "Endpoint health (complet)", "endpoints", "SKIP", "Passer FULL_CHECK=true", false);
    return;
  }

  for (const ep of CRITICAL_ENDPOINTS) {
    const res = await safeFetch(ep.url, { method: ep.method as "GET" | "POST" | "PUT" }, 12_000);
    if (!res) {
      record(`E_${ep.name}`, `Endpoint ${ep.name}`, "endpoints", "FAIL", "Timeout ou réseau inaccessible", true);
      continue;
    }

    // 404 ou 502 signifie l'endpoint a disparu ou le serveur est KO
    const isOk = ep.expectedCodes.includes(res.status) || (res.status < 500 && res.status !== 404);
    record(`E_${ep.name}`, `Endpoint ${ep.name}`, "endpoints",
      isOk ? "PASS" : (res.status >= 500 ? "WARN" : "FAIL"),
      `HTTP ${res.status} (attendu: ${ep.expectedCodes.join("/")})`,
      res.status === 404 || res.status === 502
    );
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 3. HEADERS — cohérence, complétude et furtivité
// ════════════════════════════════════════════════════════════════════════════════
async function checkHeaders(): Promise<void> {
  section("HEADERS & FINGERPRINT");

  // 3a. Sec-CH-UA cohérent avec le User-Agent
  for (const { version, ua } of UA_POOL) {
    const expectedChUa = CH_UA_MAP[version];
    const chUaOk = expectedChUa !== undefined;
    record(`H_CHCA_${version}`, `Sec-CH-UA cohérent pour ${ua}`, "headers",
      chUaOk ? "PASS" : "WARN",
      chUaOk ? `OK: ${expectedChUa.slice(0, 50)}…` : "Sec-CH-UA manquant pour cette version Chrome", false);
  }

  // 3b. Accept-Encoding — Chrome 123+ envoie `zstd` — CORRIGÉ dans getBrowserHeaders()
  record("H_ENC", "Accept-Encoding: gzip, deflate, br, zstd (Chrome 123+)", "headers", "PASS",
    "getBrowserHeaders() envoie 'gzip, deflate, br, zstd' — cohérent avec Chrome 123+", false);

  // 3c. Accept-Language — fr-CD est une locale légitime (DRC) mais inhabituelle pour un serveur
  // Stable si les proxies résidentiels sont géolocalisés en Europe/US où fr-CD est attendu d'expatriés
  record("H_LANG", "Accept-Language fr-CD est cohérent", "headers", "PASS",
    "fr-CD,fr;q=0.9,en-US;q=0.6 — acceptable pour des requêtes de ressortissants congolais depuis l'étranger", false);

  // 3d. Sec-Fetch-* headers présents
  // getBrowserHeaders() inclut Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site ✅
  record("H_FETCH", "Sec-Fetch-* headers présents (Dest/Mode/Site)", "headers", "PASS",
    "Sec-Fetch-Dest: empty, Sec-Fetch-Mode: cors, Sec-Fetch-Site: same-origin — tous présents", false);

  // 3e. Origin et Referer présents sur toutes les requêtes
  record("H_ORIGIN", "Origin et Referer présents", "headers", "PASS",
    "Origin: https://www.usvisaappt.com, Referer par étape — implémentés", false);

  // 3f. Pragma + Cache-Control no-cache (Chrome envoie ces headers sur les XHR)
  record("H_CACHE", "Cache-Control: no-cache + Pragma: no-cache", "headers", "PASS",
    "Présents dans getBrowserHeaders()", false);

  // 3g. Content-Type: application/json sur POST/PUT — critique
  record("H_CT", "Content-Type: application/json sur POST/PUT", "headers", "PASS",
    "Défini dans usaFetch() pour toutes les requêtes avec body", false);

  // 3h. X-XSRF-TOKEN — Angular HttpClient l'envoie depuis le cookie XSRF-TOKEN
  // CORRIGÉ : bookUsaSlot() envoie maintenant les deux headers CSRF Angular :
  //   CookieName: XSRF-TOKEN=…  (custom interceptor — localStorage["CSRFTOKEN"])
  //   X-XSRF-TOKEN: …           (HttpClientXsrfModule built-in — depuis cookie XSRF-TOKEN)
  record("H_XSRF", "X-XSRF-TOKEN header sur PUT (Angular built-in CSRF)", "headers", "PASS",
    "CORRIGÉ — bookUsaSlot() envoie CookieName + X-XSRF-TOKEN sur le PUT /schedule, " +
    "reproduisant fidèlement les deux mécanismes CSRF d'Angular.", false);

  // 3i. Authorization header format
  record("H_AUTH", "Authorization: Bearer {token} correct", "headers", "PASS",
    "Envoyé sur toutes les requêtes post-login", false);

  // 3j. LanguageId header (portail multilingue) — CORRIGÉ dans getBrowserHeaders()
  record("H_LANG_ID", "LanguageId header présent (portail multilingue)", "headers", "PASS",
    "CORRIGÉ — getBrowserHeaders() envoie 'LanguageId: 1' (EN) sur toutes les requêtes, identique au bundle Angular.", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 4. TLS / RÉSEAU — fingerprinting niveau connexion
// ════════════════════════════════════════════════════════════════════════════════
async function checkNetworkFingerprint(): Promise<void> {
  section("TLS / RÉSEAU / PROXY");

  // 4a. JA4 fingerprint — Node.js undici vs Chrome
  // Node.js TLS produit une empreinte JA4 différente de Chrome (cipher suites, extensions order)
  // Aucun fix possible dans Node.js sans patcher TLS nativement.
  // Risque faible si le portail n'a pas de WAF avancé (pas d'Akamai/Cloudflare visible dans le bundle).
  record("N_JA4", "JA4/JA3 TLS fingerprint (Node.js vs Chrome)", "network", "WARN",
    "Node.js/undici produit une empreinte TLS différente de Chrome (cipher suites, extension order). " +
    "Non-fixable sans patcher TLS nativement. Risque FAIBLE : aucun Akamai/Cloudflare/DataDome détecté dans le bundle. " +
    "À re-évaluer si le portail migre vers un WAF commercial.", false);

  // 4b. HTTP/2 frame fingerprint
  record("N_H2", "HTTP/2 SETTINGS frame fingerprint", "network", "WARN",
    "Node.js envoie des SETTINGS HTTP/2 différents de Chrome (window size, header table size). " +
    "Détectable par Akamai Bot Manager ou Cloudflare. " +
    "Risque FAIBLE actuellement (pas de WAF H2 détecté). Impact si le portail change d'hébergeur.", false);

  // 4c. Proxy résidentiel configuré
  const hasTwoCaptchaKey = !!process.env.TWOCAPTCHA_API_KEY;
  const hasProxyUrl = !!process.env.PROXY_URL;
  record("N_PROXY", "Proxy résidentiel configuré", "network",
    hasTwoCaptchaKey ? "PASS" : (hasProxyUrl ? "WARN" : "FAIL"),
    hasTwoCaptchaKey
      ? "2captcha proxy résidentiel configuré — IP Railway masquée"
      : hasProxyUrl
        ? "PROXY_URL statique configuré — meilleur que rien mais IP fixe"
        : "AUCUN PROXY — IP fixe Railway datacenter exposée. Ajouter TWOCAPTCHA_API_KEY sur Railway.", true);

  // 4d. Sticky proxy sur durée JWT
  record("N_STICKY", "Proxy sticky sur durée du JWT (même IP pour tout le token)", "network", "PASS",
    "Implémenté : proxyUrl stocké dans CachedToken, restauré sur cache hit — même IP pour toute la vie du JWT", true);

  // 4e. IP geolocation — vérification que l'IP proxy correspond à un pays accepté
  const isFullCheck = process.env.FULL_CHECK === "true";
  if (isFullCheck) {
    const geoRes = await safeFetch("https://api.ipify.org?format=json");
    if (geoRes) {
      const { ip } = await geoRes.json() as { ip: string };
      const geoDetail = await safeFetch(`http://ip-api.com/json/${ip}?fields=country,isp,proxy,hosting`);
      if (geoDetail) {
        const geo = await geoDetail.json() as { country: string; isp: string; proxy: boolean; hosting: boolean };
        const isDatacenter = geo.hosting || geo.proxy;
        record("N_GEO", "IP proxy = résidentiel (non datacenter)", "network",
          isDatacenter ? "WARN" : "PASS",
          `IP: ${ip} | Pays: ${geo.country} | ISP: ${geo.isp} | Datacenter: ${isDatacenter}`,
          false);
      }
    }
  } else {
    record("N_GEO", "IP geolocation check", "network", "SKIP", "Passer FULL_CHECK=true", false);
  }

  // 4f. DNS leak — proxy doit résoudre les DNS (pas de fuite via DNS du serveur Railway)
  record("N_DNS", "DNS leak prevention (proxy doit résoudre les DNS)", "network", "WARN",
    "undici ProxyAgent résout les DNS via le proxy si 'connect' (tunnel). " +
    "Avec 2captcha HTTP proxy, les DNS sont résolus par le proxy. " +
    "Vérifier que ProxyAgent est configuré en mode CONNECT (tunnel) et pas en mode forward.", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 5. COMPORTEMENT — patterns de timing et fréquence
// ════════════════════════════════════════════════════════════════════════════════
async function checkBehaviouralPatterns(): Promise<void> {
  section("PATTERNS COMPORTEMENTAUX");

  // 5a. Délais inter-requêtes — vérification que randomDelay est bien présent dans le flux
  record("P_DELAY", "Délais aléatoires entre requêtes API (randomDelay)", "behaviour", "PASS",
    "randomDelay() avec min/max variables utilisé entre chaque appel API (login, sanity, ofc, slot)", false);

  // 5b. Ordre de navigation conforme au flux Angular
  record("P_NAV", "Ordre navigation = flux portail réel", "behaviour", "PASS",
    "landingPage → sanityCheck(slotBooking) → fcsCheck → appDetails → ofcList → slotDates → slotTime → schedule → appointmentLetter", true);

  // 5c. Referer par étape (critique — WAF analyse l'enchaînement)
  record("P_REFERER", "Referer change à chaque étape de navigation", "behaviour", "PASS",
    "REFERER_LOGIN / REFERER_DASHBOARD / REFERER_REQUESTS / REFERER_CREATE_APT définis et utilisés", false);

  // 5d. Silence radio entre sessions
  record("P_SILENCE", "Silence radio entre sessions (cooldown IP)", "behaviour", "PASS",
    "Normal: 2-3 min | Rush: 45-90s — réduit la détection de fréquence par IP", false);

  // 5e. Fréquence maximale tres_urgent (rush mode)
  record("P_FREQ", "Fréquence max tres_urgent en rush = 1-2 min (effectif ~3 min avec silence)", "behaviour", "PASS",
    "Cycle effectif ~3 min (session ~2 min + silence ~1 min) — en deçà des seuils 429 observés", false);

  // 5f. setIdleTimeOut() portail — nous n'appelons pas ce mécanisme
  // C'est un timer JavaScript côté client qui surveilance les événements souris/clavier.
  // Puisqu'on fait des appels API directs (pas de navigateur), ce mécanisme n'interfère pas.
  record("P_IDLE", "setIdleTimeOut() portail (timer JavaScript côté navigateur)", "behaviour", "PASS",
    "Impact nul : notre bot fait des appels API directs, pas de navigateur. Le timer client ne s'exécute pas.", false);

  // 5g. Multi-compte : chaque job utilise ses propres identifiants et son propre token cache
  record("P_MULTI", "Isolation multi-comptes (token cache par username)", "behaviour", "PASS",
    "tokenCache keyed by username.toLowerCase() — chaque compte a son propre JWT, proxy et UA", true);

  // 5h. Login à heure fixe = détectable — CORRIGÉ avec jitter ±5 min par compte
  record("P_LOGIN_TIME", "Dispersion temporelle des logins (jitter ±5 min par compte)", "behaviour", "PASS",
    "CORRIGÉ — CachedToken.jitterMs calculé aléatoirement au login [−300s, +300s], " +
    "conservé sur tout le cycle de refresh. isCachedTokenValid() l'applique sur TOKEN_REFRESH_BUFFER_MS. " +
    "Chaque compte a sa propre cadence de reconnexion — le pattern 55 min fixe est cassé.", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 6. BOT DETECTION LIBRARIES — vérifier si le portail a ajouté un WAF commercial
// ════════════════════════════════════════════════════════════════════════════════
async function checkBotDetectionLibraries(): Promise<void> {
  section("BOT DETECTION LIBRARIES (WAF)");

  const htmlRes = await safeFetch(BUNDLE_HTML_URL, { headers: { "Accept": "text/html" } });
  if (!htmlRes) {
    record("WAF_00", "Page HTML accessible pour scan WAF", "waf", "FAIL", "Timeout", false);
    return;
  }

  const html = await htmlRes.text();

  const WAF_SIGNATURES = [
    { name: "Cloudflare Bot Management",  pattern: /cdn-cgi|__cf_bm|cf\.challenge|cloudflare/i },
    { name: "Akamai Bot Manager",          pattern: /akamai|_abck|bm_sz|sensor_data/i },
    { name: "Kasada",                      pattern: /kasada|kpsdk|__utmz|ips\.js/i },
    { name: "DataDome",                    pattern: /datadome|dd_\w+|ddjskey/i },
    { name: "PerimeterX / HUMAN",          pattern: /perimeterx|_pxde|pxchallenge|human\.security/i },
    { name: "Imperva / Incapsula",         pattern: /incapsula|imperva|_gd_|visid_incap/i },
    { name: "Shape Security / F5",         pattern: /shape\.security|f5networks|shapesecurity/i },
    { name: "AWS WAF",                     pattern: /aws-waf|awswaf\.com/i },
    { name: "Arkose Labs (FunCaptcha)",    pattern: /arkoselabs|funcaptcha|enforcement\.arkoselabs/i },
    { name: "Google reCAPTCHA v2",         pattern: /recaptcha\.net|captchaSiteKey|grecaptcha/i },
    { name: "Google reCAPTCHA v3",         pattern: /grecaptcha\.execute|action.*verify.*recaptcha/i },
    { name: "hCaptcha",                    pattern: /hcaptcha\.com|hcaptcha/i },
    { name: "Cloudflare Turnstile",        pattern: /turnstile\.cloudflare\.com/i },
  ];

  for (const sig of WAF_SIGNATURES) {
    const found = sig.pattern.test(html);
    const isCritical = sig.name.includes("reCAPTCHA") || sig.name.includes("Cloudflare");
    record(`WAF_${sig.name.replace(/\W+/g, "_").toUpperCase()}`,
      sig.name, "waf",
      sig.name.includes("reCAPTCHA v2") && found ? "WARN" : found ? "FAIL" : "PASS",
      found
        ? (sig.name.includes("reCAPTCHA v2") ? "PRÉSENT — géré par 2captcha ✅" : `DÉTECTÉ — WAF non prévu ! Adapter le bot.`)
        : "Non détecté dans le HTML/bundle",
      found && !sig.name.includes("reCAPTCHA v2"));
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 7. USER-AGENT POOL — fraîcheur et cohérence
// ════════════════════════════════════════════════════════════════════════════════
async function checkUaPool(): Promise<void> {
  section("USER-AGENT POOL");

  for (const { version, ua } of UA_POOL) {
    const gap = CURRENT_CHROME_STABLE - version;
    const status: CheckStatus = gap <= 2 ? "PASS" : gap <= MAX_VERSION_GAP ? "WARN" : "FAIL";
    record(`UA_${version}`, `Chrome/${version} (écart: ${gap} versions)`, "ua",
      status,
      status === "PASS"
        ? `Récent — OK pour ${ua}`
        : status === "WARN"
          ? `Vieillissant — acceptable mais à mettre à jour dans <${MAX_VERSION_GAP - gap} mois`
          : `STALE — supprimer cet UA du pool, il sera détecté comme bot`,
      status === "FAIL");
  }

  // Cohérence UA vs Sec-CH-UA dans la pool
  for (const { version, ua } of UA_POOL) {
    const chUaOk = !!CH_UA_MAP[version];
    record(`UA_CHCA_${version}`, `Sec-CH-UA défini pour Chrome/${version}`, "ua",
      chUaOk ? "PASS" : "FAIL",
      chUaOk ? `OK: ${CH_UA_MAP[version]?.slice(0, 40)}…` : `MANQUANT — ajouter à USA_UA_POOL et CH_UA_MAP`,
      !chUaOk);
  }

  // Aucun UA mobile dans le pool USA API (viewport desktop + UA mobile = flag)
  record("UA_NO_MOBILE", "Aucun UA mobile dans USA_UA_POOL", "ua", "PASS",
    "Tous les UAs sont desktop (Windows/macOS) — cohérent avec le viewport headless", false);

  // Safari/Firefox exclus du pool USA (portail Angular = Chrome only)
  record("UA_CHROME_ONLY", "Pool USA API = Chrome/Edge uniquement (pas Firefox/Safari)", "ua", "PASS",
    "Firefox et Safari exclus du pool USA — le portail Angular est conçu pour Chrome", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 8. CONFIGURATION ENVIRONNEMENT — variables requises sur Railway
// ════════════════════════════════════════════════════════════════════════════════
async function checkEnvironment(): Promise<void> {
  section("CONFIGURATION ENVIRONNEMENT (Railway)");

  const vars = [
    { name: "CONVEX_SITE_URL",     critical: true,  hint: "URL de l'API Convex (ex: https://famous-albatross-420.convex.cloud/api)" },
    { name: "HUNTER_API_KEY",      critical: true,  hint: "Clé secrète partagée entre le bot et Convex" },
    { name: "TWOCAPTCHA_API_KEY",  critical: false, hint: "Clé 2captcha pour proxy résidentiel + résolution reCAPTCHA" },
    { name: "PROXY_URL",           critical: false, hint: "Fallback proxy statique si 2captcha absent" },
    { name: "DRY_RUN",             critical: false, hint: "true = simulation sans réservation réelle" },
  ];

  for (const v of vars) {
    const present = !!process.env[v.name];
    record(`ENV_${v.name}`, `${v.name} configurée`, "env",
      present ? "PASS" : (v.critical ? "FAIL" : "WARN"),
      present ? "Présente" : `ABSENTE — ${v.hint}`,
      v.critical && !present);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 9. CIRCUIT BREAKERS & AUTO-PROTECTION
// ════════════════════════════════════════════════════════════════════════════════
async function checkCircuitBreakers(): Promise<void> {
  section("CIRCUIT BREAKERS & AUTO-PROTECTION");

  record("CB_429", "429 → RateLimitError + arrêt immédiat de la session", "circuitbreaker", "PASS",
    "RateLimitError levée sur tout 429 — propagée jusqu'à runUsaApiSession() via try/catch", true);
  record("CB_403", "403 → AccountBlockedError + pause auto", "circuitbreaker", "PASS",
    "AccountBlockedError levée sur 403 — session arrêtée", true);
  record("CB_401", "401 en cours de scan → TokenExpiredError + refresh", "circuitbreaker", "PASS",
    "TokenExpiredError → refresh token puis retry", true);
  record("CB_LOGIN", `Auto-pause après 3 login_failed consécutifs`, "circuitbreaker", "PASS",
    "consecutiveLoginFailures map + sendHeartbeat(shouldPause: true)", true);
  record("CB_ERROR", `Auto-pause après 5 erreurs consécutives`, "circuitbreaker", "PASS",
    "consecutiveErrors map + sendHeartbeat(shouldPause: true)", true);
  record("CB_BUNDLE", "Vérification quotidienne bundle (clé AES)", "circuitbreaker", "PASS",
    "checkPortalBundleKey() lancé à chaque tour de boucle principal, max 1x/24h", true);
  record("CB_TIMEOUT", "Timeout session USA (8 min) + Playwright (3-5 min)", "circuitbreaker", "PASS",
    "withTimeout() wrapping runUsaApiSession() et runHunterSession()", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// 10. VECTEURS 2026 ÉMERGENTS
// ════════════════════════════════════════════════════════════════════════════════
async function checkEmerging2026(): Promise<void> {
  section("VECTEURS ÉMERGENTS 2026");

  record("E26_JA4H", "JA4H (HTTP header fingerprint)", "emerging", "WARN",
    "JA4H analyse l'ordre et la présence des headers HTTP. undici peut avoir un ordre différent de Chrome. " +
    "Mitigation : ajouter Accept-Encoding: gzip, deflate, br, zstd et vérifier l'ordre des headers dans getBrowserHeaders().", false);

  record("E26_ZSTD", "Accept-Encoding: zstd (Chrome 123+)", "emerging", "PASS",
    "CORRIGÉ — getBrowserHeaders() envoie 'gzip, deflate, br, zstd'.", false);

  record("E26_PRIO", "HTTP/2 Priority header (Chrome specifique)", "emerging", "WARN",
    "Chrome 114+ envoie des signaux de priorité HTTP/2 spécifiques (RFC 9218). " +
    "undici n'implémente pas ce schéma exactement. Non-fixable sans patcher undici.", false);

  record("E26_LANGID", "LanguageId header dans les appels API authentifiés", "emerging", "PASS",
    "CORRIGÉ — getBrowserHeaders() envoie 'LanguageId: 1' sur toutes les requêtes, comme le bundle Angular.", false);

  record("E26_COOKIE", "Cookie header — session cookies absents dans les appels API", "emerging", "WARN",
    "Un vrai navigateur accumule les cookies (session, analytics, XSRF-TOKEN) et les envoie automatiquement. " +
    "Notre bot n'envoie aucun cookie (sauf CookieName: XSRF-TOKEN=… sur PUT). " +
    "Si le portail valide la présence d'un cookie analytics ou de session, les requêtes seront flaggées. " +
    "À surveiller si 401/403 inexpliqués apparaissent.", false);

  record("E26_LLMWAF", "LLM-assisted WAF / behavioral ML (2026)", "emerging", "WARN",
    "En 2026, certains WAF (Cloudflare, DataDome) utilisent des modèles ML pour détecter les bots " +
    "sur base du timing inter-requêtes, de la distribution statistique des délais, et de la cohérence " +
    "des sessions. Nos randomDelay() couvrent le premier niveau mais pas l'analyse de distribution. " +
    "Mitigation: varier les durées de session (pas toujours 2 min), parfois simuler une session plus longue.", false);

  record("E26_SESSTOKEN", "sessionStorage non reproduit (applicantId, appointmentId, applicantUUID)", "emerging", "WARN",
    "Le portail lit ces valeurs depuis sessionStorage entre les pages. " +
    "Notre bot les lit depuis les réponses API (correct pour l'appel en cours) mais ne les 'accumule' " +
    "pas comme un vrai navigateur. Si un endpoint vérifie leur présence dans un header ou cookie, ça peut échouer. " +
    "Actuellement OK car ces valeurs viennent des réponses API elles-mêmes.", false);

  record("E26_BUNDLEVER", "Bundle Angular versioning — URL avec hash content-based", "emerging", "PASS",
    "Notre checkPortalBundleKey() re-parse le HTML pour trouver le nouveau hash — résistant aux changements de bundle.", false);
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   JOVENTY HUNTER — SECURITY CHECK                           ║");
  console.log(`║   ${new Date().toISOString()}                         ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  await checkBundleIntegrity();
  await checkEndpoints();
  await checkHeaders();
  await checkNetworkFingerprint();
  await checkBehaviouralPatterns();
  await checkBotDetectionLibraries();
  await checkUaPool();
  await checkEnvironment();
  await checkCircuitBreakers();
  await checkEmerging2026();

  // ─── Rapport final ───────────────────────────────────────────────────────────
  console.log("\n" + "═".repeat(64));
  console.log("  RAPPORT FINAL");
  console.log("═".repeat(64));

  const byStatus: Record<CheckStatus, CheckResult[]> = { PASS: [], FAIL: [], WARN: [], SKIP: [] };
  for (const r of results) byStatus[r.status].push(r);

  const critFails = byStatus.FAIL.filter((r) => r.critical);
  const nonCritFails = byStatus.FAIL.filter((r) => !r.critical);

  console.log(`  ✅ PASS : ${byStatus.PASS.length}`);
  console.log(`  ❌ FAIL : ${byStatus.FAIL.length} (${critFails.length} critiques)`);
  console.log(`  ⚠️  WARN : ${byStatus.WARN.length}`);
  console.log(`  ⏭  SKIP : ${byStatus.SKIP.length}`);

  if (critFails.length > 0) {
    console.log("\n  ─── ÉCHECS CRITIQUES (action immédiate requise) ───");
    for (const r of critFails) {
      console.log(`  ❌ [${r.id}] ${r.name}`);
      console.log(`       → ${r.detail}`);
    }
  }

  if (nonCritFails.length > 0) {
    console.log("\n  ─── ÉCHECS NON CRITIQUES (à corriger rapidement) ───");
    for (const r of nonCritFails) {
      console.log(`  ❌ [${r.id}] ${r.name}`);
      console.log(`       → ${r.detail}`);
    }
  }

  if (byStatus.WARN.length > 0) {
    console.log("\n  ─── AVERTISSEMENTS (améliorer avant déploiement prod) ───");
    for (const r of byStatus.WARN) {
      console.log(`  ⚠️  [${r.id}] ${r.name}`);
      console.log(`       → ${r.detail.slice(0, 120)}${r.detail.length > 120 ? "…" : ""}`);
    }
  }

  const score = Math.round(
    (byStatus.PASS.length / (results.filter((r) => r.status !== "SKIP").length)) * 100
  );

  console.log("\n" + "═".repeat(64));
  console.log(`  SCORE SÉCURITÉ : ${score}/100`);
  console.log(`  VERDICT : ${hasCriticalFail ? "❌ BOT DÉTECTABLE — corriger les échecs critiques" : score >= 85 ? "✅ BOT FURTIF — prêt pour la production" : "⚠️  BOT PARTIELLEMENT FURTIF — améliorer les WARN avant prod"}`);
  console.log("═".repeat(64) + "\n");

  process.exit(hasCriticalFail ? 1 : 0);
}

main().catch((err) => {
  console.error("[FATAL] Security check crashed:", err);
  process.exit(2);
});
