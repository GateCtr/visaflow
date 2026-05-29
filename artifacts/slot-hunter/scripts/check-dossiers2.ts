import "dotenv/config";
import { Impit } from "impit";

const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SOAX = process.env.SOAX_PROXY_URL || "";
const p = new URL(SOAX);
p.password = encodeURIComponent(decodeURIComponent(p.password) + "_country-cd_city-kinshasa_sessionid-chk2" + Date.now() + "_sessiontime-600");
const impit = new Impit({ proxy: p.toString() });
const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;

// Better cookie handling (same as test-cev-presolved.ts that worked)
let allSetCookies: string[] = [];

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

const DOSSIERS = [
  { ref: "VOWINT5903406", id: "e978b2fd-472f-f111-a3ae-00505691de06" },
  { ref: "VOWINT6085888", id: "57f49a76-05b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088178", id: "d501376b-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088189", id: "3c7f4dae-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088201", id: "d58e7ca9-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088211", id: "4084ce04-14b8-f011-a3ae-00505691de06" },
];

async function main() {
  allSetCookies = [];
  
  const lp = await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  const lhtml = await lp.text();
  accumulateCookies(lp);
  const csrf = lhtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] || "";
  
  const lr = await f(VOWINT_BASE + "/en/Account/Login", {
    method: "POST", redirect: "manual",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": buildCookieHeader(allSetCookies), "Origin": VOWINT_BASE, "Referer": VOWINT_BASE + "/" },
    body: new URLSearchParams({ __RequestVerificationToken: csrf, UserName: "screentapinc@gmail.com", Password: "Akollad@2026" }).toString(),
  });
  accumulateCookies(lr);
  
  if (lr.status !== 302) { console.log("Login FAILED:", lr.status); process.exit(1); }
  
  let loc = lr.headers.get("location");
  for (let i = 0; i < 5 && loc; i++) {
    const url = loc.startsWith("http") ? loc : VOWINT_BASE + loc;
    const r = await f(url, { method: "GET", headers: { "User-Agent": UA, "Cookie": buildCookieHeader(allSetCookies) }, redirect: "manual" });
    accumulateCookies(r);
    loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
  }
  
  console.log("Login OK");
  console.log("Cookies:", buildCookieHeader(allSetCookies).slice(0, 100) + "...");
  console.log("");
  console.log("Test des 6 dossiers:");
  
  const cookies = buildCookieHeader(allSetCookies);
  
  for (const d of DOSSIERS) {
    const r = await f(VOWINT_BASE + "/Common/GetEAppointmentUrl?id=" + d.id, {
      method: "GET", redirect: "manual",
      headers: { "User-Agent": UA, "Cookie": cookies, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/html, */*", "Referer": VOWINT_BASE + "/en/VisaApplication/IndexByUserId" },
    });
    const t = await r.text();
    const hasUrl = t.includes("/Integration/");
    const isEmpty = t.trim() === "";
    console.log(`  ${d.ref}: ${hasUrl ? "✅ DISPO → " + t.slice(0, 80) : isEmpty ? "⚠️ VIDE" : "❓ " + t.slice(0, 100)}`);
  }
  
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
