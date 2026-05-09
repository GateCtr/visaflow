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

async function main() {
  console.log("=".repeat(60));
  console.log(" TEST LOGIN USA PORTAL");
  console.log("=".repeat(60));
  console.log(`Email    : ${EMAIL}`);
  console.log(`AppId    : ${PORTAL_APP_ID ?? "(auto-sélection)"}`);
  console.log(`2captcha : ${process.env.TWOCAPTCHA_API_KEY ? "✅ clé présente" : "❌ absente"}`);

  // ── 0. Initialisation proxy résidentiel ────────────────────
  const serverIp = await getPublicIp();
  console.log(`IP serveur: ${serverIp}`);
  proxyPool.setServerIp(serverIp);

  let proxyUrl: string | undefined;
  if (proxyPool.isConfigured) {
    console.log("[proxy] Chargement des IPs résidentielles 2captcha...");
    proxyUrl = await proxyPool.getProxy();
    if (proxyUrl) {
      const masked = proxyUrl.replace(/:([^:@]+)@/, ":***@");
      console.log(`[proxy] ✅ Proxy actif: ${masked}`);
      setUsaSessionProxy(proxyUrl);
    } else {
      console.warn("[proxy] ⚠️  Aucun proxy disponible (IP non whitelistée ?) — connexion directe");
    }
  } else {
    console.warn("[proxy] ⚠️  Proxy non configuré — connexion directe (risque 401)");
  }

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
    setUsaSessionProxy(undefined); // reset proxy
  }

  if (!session) {
    console.error("❌ Login échoué — session null retournée");
    process.exit(1);
  }

  setUsaSessionProxy(proxyUrl); // réactiver pour les appels suivants

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
