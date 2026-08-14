/**
 * test-nonecap.ts — Test NoneCap hCaptcha solver pour le sitekey CEV Belgique
 *
 * Usage: cd artifacts/slot-hunter && npx tsx scripts/test-nonecap.ts
 */

import "dotenv/config";

const NONECAP_KEY = process.env.NONECAP_API_KEY;
const HCAPTCHA_SITEKEY = "5f64399c-14a8-415e-ad1a-7ebccdc4943a";
const PAGE_URL = "https://appointment.cloud.diplomatie.be/Captcha";

if (!NONECAP_KEY) {
  console.error("❌ NONECAP_API_KEY manquante dans .env");
  process.exit(1);
}

async function main() {
  console.log("═══ Test NoneCap hCaptcha ═══");
  console.log(`  Sitekey: ${HCAPTCHA_SITEKEY}`);
  console.log(`  URL: ${PAGE_URL}`);
  console.log(`  API Key: ${NONECAP_KEY!.slice(0, 15)}…`);
  console.log("");

  const t0 = Date.now();

  // POST /v1/solves?wait=60
  console.log("⏳ Envoi solve à NoneCap (wait=60s)…");
  const createRes = await fetch("https://api.nonecap.com/v1/solves?wait=60", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${NONECAP_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "hcaptcha",
      sitekey: HCAPTCHA_SITEKEY,
      url: PAGE_URL,
    }),
    signal: AbortSignal.timeout(70_000),
  });

  const status = createRes.status;
  const data = await createRes.json() as {
    id?: string;
    status?: string;
    token?: string | null;
    error?: { code?: string; message?: string } | null;
    queue_ms?: number | null;
    resolve_ms?: number | null;
    credits_charged?: number | null;
  };

  console.log(`\n📡 Réponse HTTP ${status}:`);
  console.log(`  ID: ${data.id ?? "n/a"}`);
  console.log(`  Status: ${data.status ?? "n/a"}`);
  console.log(`  Token: ${data.token ? `${data.token.slice(0, 40)}… (${data.token.length} chars)` : "null"}`);
  console.log(`  Error: ${data.error ? `${data.error.code}: ${data.error.message}` : "none"}`);
  console.log(`  Queue: ${data.queue_ms ?? "n/a"}ms`);
  console.log(`  Resolve: ${data.resolve_ms ?? "n/a"}ms`);
  console.log(`  Credits: ${data.credits_charged ?? "n/a"}`);

  // Si encore pending/solving, poll
  if (data.id && (data.status === "pending" || data.status === "solving") && !data.token) {
    console.log("\n⏳ Encore en cours — polling…");
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5_000));
      const pollRes = await fetch(`https://api.nonecap.com/v1/solves/${data.id}?wait=10`, {
        headers: { "Authorization": `Bearer ${NONECAP_KEY}` },
        signal: AbortSignal.timeout(15_000),
      });
      const pollData = await pollRes.json() as typeof data;
      console.log(`  Poll #${i + 1}: status=${pollData.status} token=${pollData.token ? "yes" : "no"}`);

      if (pollData.token) {
        console.log(`\n✅ TOKEN OBTENU! (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        console.log(`  ${pollData.token.slice(0, 60)}…`);
        console.log(`  Longueur: ${pollData.token.length} chars`);
        console.log(`  Commence par P1_: ${pollData.token.startsWith("P1_") ? "OUI ✅" : "NON ⚠️"}`);
        return;
      }
      if (pollData.status === "failed" || pollData.status === "expired" || pollData.status === "cancelled") {
        console.log(`\n❌ ÉCHEC: ${pollData.status} — ${pollData.error?.code ?? "unknown"}`);
        return;
      }
    }
    console.log("\n❌ TIMEOUT: 120s sans résultat");
    return;
  }

  // Résultat immédiat
  if (data.token) {
    console.log(`\n✅ TOKEN OBTENU! (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(`  Commence par P1_: ${data.token.startsWith("P1_") ? "OUI ✅" : "NON ⚠️"}`);
  } else if (data.error) {
    console.log(`\n❌ ERREUR: ${data.error.code} — ${data.error.message}`);
  } else {
    console.log(`\n⚠️ Réponse inattendue:`, JSON.stringify(data, null, 2));
  }
}

main().catch(console.error);
