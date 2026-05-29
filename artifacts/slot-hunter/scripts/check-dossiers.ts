import "dotenv/config";
import { Impit } from "impit";
const VOWINT_BASE = "https://visaonweb.diplomatie.be";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const SOAX = process.env.SOAX_PROXY_URL || "";
const p = new URL(SOAX);
p.password = encodeURIComponent(decodeURIComponent(p.password) + "_country-cd_city-kinshasa_sessionid-chk" + Date.now() + "_sessiontime-600");
const impit = new Impit({ proxy: p.toString() });
const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;

const DOSSIERS = [
  { ref: "VOWINT5903406", id: "e978b2fd-472f-f111-a3ae-00505691de06" },
  { ref: "VOWINT6085888", id: "57f49a76-05b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088178", id: "d501376b-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088189", id: "3c7f4dae-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088201", id: "d58e7ca9-14b8-f011-a3ae-00505691de06" },
  { ref: "VOWINT6088211", id: "4084ce04-14b8-f011-a3ae-00505691de06" },
];

async function main() {
  const lp = await f(VOWINT_BASE + "/", { method: "GET", headers: { "User-Agent": UA }, redirect: "follow" });
  const lhtml = await lp.text();
  const csrf = lhtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1] || "";
  let ck = (lp.headers.get("set-cookie") || "").split(/,(?=[A-Z_])/).map(s => s.split(";")[0].trim()).filter(s => s.includes("=")).join("; ");
  const lr = await f(VOWINT_BASE + "/en/Account/Login", { method: "POST", redirect: "manual", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Cookie": ck, "Origin": VOWINT_BASE }, body: new URLSearchParams({ __RequestVerificationToken: csrf, UserName: "screentapinc@gmail.com", Password: "Akollad@2026" }).toString() });
  const sc = lr.headers.get("set-cookie") || "";
  if (sc) ck = sc.split(/,(?=[A-Z_])/).map(s => s.split(";")[0].trim()).filter(s => s.includes("=")).join("; ");
  let loc = lr.headers.get("location");
  for (let i = 0; i < 5 && loc; i++) { const r = await f((loc.startsWith("http") ? loc : VOWINT_BASE + loc), { method: "GET", headers: { "User-Agent": UA, "Cookie": ck }, redirect: "manual" }); const s = r.headers.get("set-cookie"); if (s) ck += "; " + s.split(";")[0]; loc = r.status >= 300 ? r.headers.get("location") : null; }
  console.log("Login OK");
  console.log("");
  console.log("Test des 6 dossiers:");
  for (const d of DOSSIERS) {
    const r = await f(VOWINT_BASE + "/Common/GetEAppointmentUrl?id=" + d.id, { method: "GET", redirect: "manual", headers: { "User-Agent": UA, "Cookie": ck, "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/html, */*", "Referer": VOWINT_BASE + "/en/VisaApplication/IndexByUserId" } });
    const t = await r.text();
    const hasUrl = t.includes("/Integration/");
    const isEmpty = t.trim() === "";
    console.log(d.ref + ": " + (hasUrl ? "✅ DISPO → " + t.slice(0, 80) : isEmpty ? "⚠️ VIDE" : "❓ " + t.slice(0, 100)));
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
