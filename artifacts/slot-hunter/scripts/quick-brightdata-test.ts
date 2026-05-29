import "dotenv/config";
import { Impit } from "impit";
import { writeFileSync } from "fs";

const BRIGHTDATA_URL = process.env.BRIGHTDATA_RESIDENTIAL_PROXY_URL || "";
const out: string[] = [];
function log(m: string) { const line = "[" + new Date().toISOString().slice(11, 19) + "] " + m; out.push(line); console.log(line); writeFileSync("scripts/bd-output.txt", out.join("\n")); }

async function main() {
  log("Proxy: " + BRIGHTDATA_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60));
  const impit = new Impit(BRIGHTDATA_URL ? { proxy: BRIGHTDATA_URL } : {});
  const f = (u: string, o: any) => impit.fetch(u, o) as unknown as Promise<Response>;
  
  log("Test connexion BrightData...");
  try {
    const r = await f("https://api.ipify.org?format=text", { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
    const ip = await r.text();
    log("IP sortante: " + ip);
  } catch (e: any) {
    log("❌ Connexion échouée: " + e.message);
    process.exit(1);
  }

  log("Test VOWINT login via BrightData...");
  const r = await f("https://visaonweb.diplomatie.be/", { method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  log("VOWINT status: " + r.status);
  
  log("Test CEV via BrightData...");
  const r2 = await f("https://appointment.cloud.diplomatie.be/Home/Welcome", { method: "GET", headers: { "User-Agent": "Mozilla/5.0" }, redirect: "follow" });
  log("CEV status: " + r2.status);
  
  log("DONE");
  process.exit(0);
}
main().catch(e => { log("CRASH: " + e.message); process.exit(1); });
