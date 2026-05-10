/**
 * Script de test rapide — login USA + vérification du dossier actif
 * Usage : npx tsx src/test-login.ts
 * NE scanner PAS les créneaux, NE booke PAS — diagnostic uniquement.
 */

import { loginUsaPortal, checkUsaAppointmentRequestStatus, setUsaSessionProxy } from "./usaPortal.js";
import { proxyPool } from "./browser.js";

const EMAIL    = "ilungadieuvie7@gmail.com";
const PASSWORD = "Bukel0204@KC";

// portalApplicationId facultatif — undefined = sélection automatique
const PORTAL_APP_ID: string | undefined = undefined;

async function getPublicIp(): Promise<string> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(5000) });
    const j = await res.json() as { ip: string };
    return j.ip;
  } catch {
    return "unknown";
  }
}

async function resolveProxyUrl(): Promise<string | undefined> {
  // Priorité : iProyal > 2captcha pool > aucun
  const iproyal = process.env.IPROYAL_PROXY_URL;
  if (iproyal) {
    const masked = iproyal.replace(/:([^:@]+)@/, ":***@");
    console.log(`[proxy] ✅ iProyal résidentiel actif: ${masked}`);
    return iproyal;
  }
  if (proxyPool.isConfigured) {
    console.log("[proxy] Chargement des IPs résidentielles 2captcha...");
    const poolResult = await proxyPool.getProxy();
    if (poolResult?.proxy) {
      const masked = poolResult.proxy.replace(/:([^:@]+)@/, ":***@");
      console.log(`[proxy] ✅ 2captcha proxy actif: ${masked}`);
      return poolResult.proxy;
    }
    console.warn("[proxy] ⚠️  2captcha: aucun proxy disponible (IP non whitelistée ?)");
  }
  console.warn("[proxy] ⚠️  Aucun proxy résidentiel — connexion directe (risque 401)");
  return undefined;
}

async function main() {
  console.log("=".repeat(60));
  console.log(" TEST LOGIN USA PORTAL");
  console.log("=".repeat(60));
  console.log(`Email     : ${EMAIL}`);
  console.log(`AppId     : ${PORTAL_APP_ID ?? "(auto-sélection)"}`);
  console.log(`iProyal   : ${process.env.IPROYAL_PROXY_URL   ? "✅ configuré" : "❌ absent"}`);
  console.log(`BrightData: ${process.env.BRIGHTDATA_PROXY_URL ? "✅ configuré (réservé CEV)" : "❌ absent"}`);
  console.log(`2captcha  : ${process.env.TWOCAPTCHA_API_KEY   ? "✅ clé présente" : "❌ absente"}`);

  const serverIp = await getPublicIp();
  console.log(`IP serveur: ${serverIp}`);

  if (process.env.TWOCAPTCHA_API_KEY && !process.env.IPROYAL_PROXY_URL) {
    await proxyPool.initialize(serverIp);
  }

  const proxyUrl = await resolveProxyUrl();
  setUsaSessionProxy(proxyUrl);

  console.log("-".repeat(60));

  // ── 1. Login ───────────────────────────────────────────────
  console.log("\n[1/2] Tentative de connexion...");
  let session;
  try {
    session = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (err) {
    console.error("❌ Login exception:", err);
    process.exit(1);
  } finally {
    setUsaSessionProxy(undefined);
  }

  if (!session) {
    console.error("❌ Login échoué — session null retournée");
    process.exit(1);
  }

  setUsaSessionProxy(proxyUrl);

  console.log("✅ Login réussi !");
  console.log(`   fullName     : ${session.fullName}`);
  console.log(`   userID       : ${session.userID}`);
  console.log(`   missionId    : ${session.missionId}`);
  console.log(`   allowedOfcs  : ${session.allowedOfcs?.length ?? 0} OFC(s)`);
  if (session.allowedOfcs?.length) {
    (session.allowedOfcs as { ofcId?: unknown; postName?: unknown }[]).forEach((o) =>
      console.log(`     • ${o.postName ?? o.ofcId ?? JSON.stringify(o)}`)
    );
  }
  console.log(`   accessToken  : ${session.accessToken?.slice(0, 20)}...`);

  // ── 2. Statut du dossier ────────────────────────────────────
  console.log("\n[2/2] Vérification statut dossier...");
  const status = await checkUsaAppointmentRequestStatus(session, PORTAL_APP_ID);
  setUsaSessionProxy(undefined);

  console.log("\n── Résultat ─────────────────────────────────────────");
  console.log(`   status             : ${status.status}`);
  console.log(`   applicationId      : ${status.applicationId}`);
  console.log(`   pendingAppoStatus  : ${status.pendingAppoStatus}`);
  console.log(`   primaryApplicant   : ${status.primaryApplicant}`);
  console.log(`   missionId          : ${status.missionId}`);
  console.log(`   applicantId        : ${status.applicantId ?? "(absent)"}`);
  console.log(`   appointmentId      : ${status.appointmentId ?? "(absent)"}`);
  console.log(`   applicantUUID      : ${status.applicantUUID ?? "(absent)"}`);
  console.log(`   message            : ${status.message}`);

  console.log("\n── Interprétation ───────────────────────────────────");
  switch (status.status) {
    case "scheduled":
      console.log("📅 Compte avec RDV existant (pendingAppoStatus=1) — mode RESCHEDULE applicable");
      break;
    case "pending":
      console.log("⏳ En attente de créneau (pendingAppoStatus≥2) — mode NORMAL applicable");
      break;
    case "payment_required":
      console.log("💳 Paiement non confirmé (pendingAppoStatus=0) — compte non éligible");
      break;
    case "no_request":
      console.log("🔍 Aucune demande de RDV trouvée sur ce compte");
      break;
    case "error":
      console.error("❌ Erreur lors de la vérification du statut");
      break;
  }

  console.log("\n" + "=".repeat(60));
  console.log(" FIN DU TEST");
  console.log("=".repeat(60));
  process.exit(0);
}

main().catch((err) => {
  console.error("Erreur non catchée:", err);
  process.exit(1);
});
