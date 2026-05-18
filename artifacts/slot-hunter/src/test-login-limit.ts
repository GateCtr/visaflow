/**
 * Test : combien de logins avant "temporarily restricted" ?
 * Compte frais (pas connecté aujourd'hui).
 * Login en boucle avec pause réaliste, compte le seuil exact.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { loginUsaPortal, setUsaSessionProxy } from "./usaPortal.js";
import { usaFetch, authHeaders } from "./usaPortal/usa-http.js";
import { USA_PAYMENT_STATUS_URL, REFERER_DASHBOARD } from "./usaPortal/config.js";
import { AccountRestrictedError } from "./usaPortal/errors.js";

const EMAIL = "encoraplus@gmail.com";
const PASSWORD = "Akollad@2026";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log("=".repeat(70));
  console.log(" TEST: Limite de logins journalière (compte frais)");
  console.log("=".repeat(70));
  console.log(`Email : ${EMAIL}`);
  console.log(`Date  : ${new Date().toISOString()}\n`);

  // Proxy 2captcha gateway sticky (même IP pour tous les logins)
  const proxyUser = process.env.TWOCAPTCHA_PROXY_USER ?? process.env.TWOCAPTCHA_API_KEY ?? "";
  const sessionId = `limit-${Date.now().toString(36)}`;
  const username = `${proxyUser}-zone-custom-region-cd_session-${sessionId}_lifetime-1h`;
  const proxyUrl = `http://${encodeURIComponent(username)}:${encodeURIComponent(proxyUser)}@eu.proxy.2captcha.com:2334`;
  setUsaSessionProxy(proxyUrl);

  // IP
  try {
    const ipRes = await usaFetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(10000) });
    const ipJ = await ipRes.json() as { ip: string };
    console.log(`IP proxy: ${ipJ.ip}\n`);
  } catch { console.log("IP: unknown\n"); }

  let loginCount = 0;
  let lastError = "";

  for (let i = 1; i <= 50; i++) {
    console.log(`── Login #${i} ──────────────────────────────────────────`);
    
    try {
      const session = await loginUsaPortal(EMAIL, PASSWORD);
      if (!session?.accessToken) {
        console.log(`  ❌ Login #${i} : pas de token (session null)`);
        lastError = "no_token";
        break;
      }

      loginCount = i;
      console.log(`  ✅ Login #${i} OK — ${session.fullName}`);

      // Vérifier que le token fonctionne
      const h = authHeaders(session.accessToken, REFERER_DASHBOARD, false);
      const apiRes = await usaFetch(USA_PAYMENT_STATUS_URL, { method: "GET", headers: h, signal: AbortSignal.timeout(15000) });
      console.log(`  📡 API paymentStatus → HTTP ${apiRes.status}`);
      
      if (apiRes.status !== 200) {
        const body = await apiRes.text().catch(() => "");
        console.log(`  ⚠️  API refusée (${apiRes.status}): ${body.slice(0, 100)}`);
      }

    } catch (err: any) {
      if (err instanceof AccountRestrictedError) {
        console.log(`\n  🔴 RESTRICTION DÉCLENCHÉE au login #${i}`);
        console.log(`     Message: AccountRestrictedError`);
        console.log(`     Retry-After: ${err.retryAfterHeader ?? "absent"}`);
        lastError = "restricted";
        break;
      }
      
      const msg = err.message ?? String(err);
      if (msg.toLowerCase().includes("restricted") || msg.toLowerCase().includes("temporarily")) {
        console.log(`\n  🔴 RESTRICTION DÉCLENCHÉE au login #${i}`);
        console.log(`     Message: ${msg.slice(0, 200)}`);
        lastError = "restricted";
        break;
      }

      console.log(`  ❌ Login #${i} erreur: ${msg.slice(0, 150)}`);
      lastError = msg.slice(0, 100);
      break;
    }

    // Pause entre logins (15-25s — simule un humain qui se déconnecte/reconnecte)
    const pause = 15000 + Math.random() * 10000;
    console.log(`  ⏱️  Pause ${Math.round(pause/1000)}s avant prochain login...\n`);
    await sleep(pause);
  }

  console.log("\n" + "═".repeat(70));
  console.log(" RÉSULTAT");
  console.log("═".repeat(70));
  console.log(`  Logins réussis  : ${loginCount}`);
  console.log(`  Arrêt cause     : ${lastError || "limite 50 atteinte"}`);
  if (lastError === "restricted") {
    console.log(`  SEUIL RESTRICTION: Login #${loginCount + 1} → rejeté`);
    console.log(`  LIMITE JOURNALIÈRE: ~${loginCount} logins/jour/compte`);
  }
  console.log("═".repeat(70));
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
