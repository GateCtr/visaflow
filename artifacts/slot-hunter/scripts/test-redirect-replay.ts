/**
 * TEST: Replay de la redirectUrl après NoAvailability
 * 
 * Hypothèse: Les GUIDs (sessionGuid/tokenGuid) dans la redirectUrl restent
 * valides pendant les 15 minutes de validUntil. Si oui, on peut re-GET
 * la même URL pour re-vérifier les slots sans nouveau captcha/clic.
 */
import "dotenv/config";
import { Impit } from "impit";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const CEV_BASE = "https://appointment.cloud.diplomatie.be";
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY || "";
// SOAX proxy (comme en prod)
const SOAX = process.env.SOAX_PROXY_URL || "";
const sp = new URL(SOAX);
sp.password = encodeURIComponent(decodeURIComponent(sp.password) + "_country-cd_city-kinshasa_sessionid-replay" + Date.now() + "_sessiontime-600");
const impit = new Impit({ proxy: sp.toString() });
const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;
function log(m: string) { console.log("[" + new Date().toISOString().slice(11, 19) + "] " + m); }

let allSetCookies: string[] = [];
function acc(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (raw) for (const part of raw.split(/,\s*(?=[A-Za-z_\-.]+=)/)) {
    const name = part.split("=")[0].trim();
    allSetCookies = allSetCookies.filter(c => !c.startsWith(`${name}=`));
    allSetCookies.push(part.trim());
  }
  return bck();
}
function bck(): string {
  const pairs = new Map<string, string>();
  for (const sc of allSetCookies) { const m = sc.split(";")[0].trim(); const i = m.indexOf("="); if (i > 0) pairs.set(m.slice(0, i), m.slice(i + 1)); }
  return [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
}

const APP_ID = "e978b2fd-472f-f111-a3ae-00505691de06"; // VOWINT5903406

async function main() {
  log("═══════════════════════════════════════════════════════");
  log("  TEST: REPLAY redirectUrl (re-GET après NoAvailability)");
  log("═══════════════════════════════════════════════════════");
  log("");

  // Login
  allSetCookies = [];
  const lp = await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  const lhtml = await lp.text(); acc(lp);
  const csrf = lhtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] || "";
  const lr = await f(VOWINT_BASE + "/en/Account/Login", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": bck(), "Origin": VOWINT_BASE, "Referer": VOWINT_BASE + "/" }, body: new URLSearchParams({ __RequestVerificationToken: csrf, UserName: "screentapinc@gmail.com", Password: "Akollad@2026" }).toString() });
  acc(lr);
  if (lr.status !== 302) { log("Login FAILED: " + lr.status); process.exit(1); }
  let loc = lr.headers.get("location");
  for (let i = 0; i < 5 && loc; i++) { const r = await f((loc.startsWith("http") ? loc : VOWINT_BASE + loc), { method: "GET", headers: { "User-Agent": UA, "Cookie": bck() }, redirect: "manual" }); acc(r); loc = r.status >= 300 ? r.headers.get("location") : null; }
  log("✅ Login OK");

  // GetEAppointmentUrl (1 clic)
  log("GetEAppointmentUrl (VOWINT5903406)...");
  const eRes = await f(VOWINT_BASE + "/Common/GetEAppointmentUrl?id=" + APP_ID, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": bck(), "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/html, */*", "Referer": VOWINT_BASE + "/en/VisaApplication/IndexByUserId" } });
  const eText = await eRes.text();
  let integUrl = "";
  try { const d = JSON.parse(eText); integUrl = typeof d === "string" ? d : d?.url || ""; } catch { if (eText.includes("/Integration/")) integUrl = eText.trim().replace(/^"|"$/g, ""); }
  if (!integUrl) { log("❌ Rate limited: [" + eText.slice(0, 100) + "]"); process.exit(1); }
  log("✅ IntegURL: " + integUrl.slice(0, 80));

  // Get CEV cookie
  const i1 = await f(integUrl, { method: "GET", redirect: "manual", headers: { "User-Agent": UA } });
  const cevCookie = (i1.headers.get("set-cookie") || "").match(/ASP\.NET_SessionId=([^;]+)/)?.[1] || "";
  if (!cevCookie) { log("❌ No CEV cookie"); process.exit(1); }
  const cevCk = `ASP.NET_SessionId=${cevCookie}; PreferredCulture=en-US`;
  log("✅ CEV cookie: " + cevCookie.slice(0, 16));

  // Navigate /Captcha
  const captchaLoc = i1.headers.get("location") || "/Captcha";
  await f((captchaLoc.startsWith("http") ? captchaLoc : CEV_BASE + captchaLoc), { method: "GET", redirect: "follow", headers: { "User-Agent": UA, "Cookie": cevCk } }).then(r => r.text());
  log("✅ Captcha page");

  // Solve captcha (AntiCaptcha + 2captcha en parallèle — premier qui répond gagne)
  log("Solving hCaptcha (AntiCaptcha + 2captcha en parallèle)...");
  const TWOCAPTCHA_KEY = process.env.TWOCAPTCHA_API_KEY || "";

  const solveAnti = async (): Promise<string | null> => {
    if (!ANTICAPTCHA_KEY) return null;
    const cr = await fetch("https://api.anti-captcha.com/createTask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, task: { type: "HCaptchaTaskProxyless", websiteURL: CEV_BASE + "/Captcha", websiteKey: HCAPTCHA_SITEKEY } }) });
    const cd = await cr.json() as any;
    if (cd.errorId !== 0) return null;
    log("  AntiCaptcha task: " + cd.taskId);
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 5000)); const gr = await fetch("https://api.anti-captcha.com/getTaskResult", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: cd.taskId }) }); const gd = await gr.json() as any; if (gd.status === "ready") { log("  ✅ AntiCaptcha solved in " + (i + 1) * 5 + "s"); return gd.solution?.gRecaptchaResponse || gd.solution?.token || null; } if (gd.errorId !== 0) { log("  ❌ AntiCaptcha: " + gd.errorDescription); return null; } }
    return null;
  };

  const solve2cap = async (): Promise<string | null> => {
    if (!TWOCAPTCHA_KEY) return null;
    const params = new URLSearchParams({ key: TWOCAPTCHA_KEY, method: "hcaptcha", sitekey: HCAPTCHA_SITEKEY, pageurl: CEV_BASE + "/Captcha", json: "1" });
    const cr = await fetch(`https://2captcha.com/in.php?${params}`);
    const cd = await cr.json() as any;
    if (cd.status !== 1) return null;
    log("  2captcha task: " + cd.request);
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 5000)); const gr = await fetch(`https://2captcha.com/res.php?key=${TWOCAPTCHA_KEY}&action=get&id=${cd.request}&json=1`); const gd = await gr.json() as any; if (gd.status === 1) { log("  ✅ 2captcha solved in " + (i + 1) * 5 + "s"); return gd.request; } if (gd.request !== "CAPCHA_NOT_READY") { log("  ❌ 2captcha: " + gd.request); return null; } }
    return null;
  };

  // Race les deux providers
  const token = await Promise.race([
    solveAnti(),
    solve2cap(),
    new Promise<null>(r => setTimeout(() => r(null), 200000)), // timeout 200s
  ]);
  if (!token) { log("❌ All captcha providers failed"); process.exit(1); }

  // SetCaptchaToken
  log("POST SetCaptchaToken...");
  const stRes = await f(CEV_BASE + "/Captcha/SetCaptchaToken", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": cevCk, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, */*", "Referer": CEV_BASE + "/Captcha", "Origin": CEV_BASE }, body: "captcha=" + encodeURIComponent(token) });
  const stBody = await stRes.text();
  let stData: any;
  try { stData = JSON.parse(stBody); } catch { log("❌ Non-JSON: " + stBody.slice(0, 200)); process.exit(1); }
  const redirectUrl = stData.redirectUrl || "";
  log("✅ validUntil: " + stData.validUntil);
  log("✅ redirectUrl: " + redirectUrl.slice(0, 100));
  log("");

  // ═══════════════════════════════════════════════════════════════
  // ÉTAPE CRITIQUE: Suivre le redirect (1er GET)
  // ═══════════════════════════════════════════════════════════════
  log("═══ ÉTAPE 1: Premier GET redirectUrl ═══");
  const fullRedirect = redirectUrl.startsWith("http") ? redirectUrl : CEV_BASE + redirectUrl;
  const r1 = await f(fullRedirect, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": cevCk, "Referer": CEV_BASE + "/Captcha" } });
  const r1Loc = r1.headers.get("location") || "";
  log("  Status: " + r1.status + " → " + r1Loc);

  if (r1Loc.includes("SelectSlot")) {
    log("  🎉 SELECTSLOT! Des slots existent!");
  } else if (r1Loc.includes("NoAvailability")) {
    log("  ⚠️ NoAvailability (normal — pas de slots en ce moment)");
  } else if (r1Loc.includes("Error")) {
    log("  ❌ Error/Default");
  }
  log("");

  // ═══════════════════════════════════════════════════════════════
  // ÉTAPE 2: REPLAY — Re-GET la MÊME redirectUrl après 10s
  // ═══════════════════════════════════════════════════════════════
  log("═══ ÉTAPE 2: REPLAY redirectUrl (5 tentatives, toutes les 10s) ═══");
  log("  Même URL, même cookie — le serveur réévalue-t-il les slots ?");
  log("");

  for (let i = 0; i < 5; i++) {
    log(`  Attente 10s...`);
    await new Promise(r => setTimeout(r, 10000));

    const rr = await f(fullRedirect, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": cevCk, "Referer": CEV_BASE + "/Captcha" } });
    const rrLoc = rr.headers.get("location") || "";
    const elapsed = (i + 1) * 10;

    if (rr.status >= 300 && rrLoc) {
      if (rrLoc.includes("SelectSlot")) {
        log(`  Replay #${i + 1} (+${elapsed}s): 🎉 SELECTSLOT! SLOTS APPARUS!`);
      } else if (rrLoc.includes("NoAvailability")) {
        log(`  Replay #${i + 1} (+${elapsed}s): ⚠️ NoAvailability (redirect toujours valide!)`);
      } else if (rrLoc.includes("Error")) {
        log(`  Replay #${i + 1} (+${elapsed}s): ❌ Error → session/token expiré`);
        log("  → Le replay NE FONCTIONNE PAS après Error");
        break;
      } else {
        log(`  Replay #${i + 1} (+${elapsed}s): ❓ ${rr.status} → ${rrLoc.slice(0, 80)}`);
      }
    } else if (rr.status === 200) {
      const body = await rr.text();
      log(`  Replay #${i + 1} (+${elapsed}s): ✅ 200 direct! Body: ${body.slice(0, 150)}`);
    } else {
      log(`  Replay #${i + 1} (+${elapsed}s): ❓ Status ${rr.status}`);
      break;
    }
  }

  log("");
  log("═══════════════════════════════════════════════════════");
  log("  RÉSUMÉ");
  log("═══════════════════════════════════════════════════════");
  log("  Si replay donne NoAvailability → URL reste valide, on peut re-checker!");
  log("  Si replay donne Error → token usage unique, pas de replay possible");
  log("═══════════════════════════════════════════════════════");

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
