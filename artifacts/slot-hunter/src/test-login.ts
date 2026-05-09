/**
 * Script de test rapide — login USA + vérification du dossier actif
 * Usage : npx tsx src/test-login.ts
 * NE scanner PAS les créneaux, NE booke PAS — diagnostic uniquement.
 */

import { loginUsaPortal, checkUsaAppointmentRequestStatus } from "./usaPortal.js";

const EMAIL    = "ilungadieuvie7@gmail.com";
const PASSWORD = "Bukel0204@KC";

// portalApplicationId facultatif — null = sélection automatique
const PORTAL_APP_ID: string | undefined = undefined;

async function main() {
  console.log("=".repeat(60));
  console.log(" TEST LOGIN USA PORTAL");
  console.log("=".repeat(60));
  console.log(`Email    : ${EMAIL}`);
  console.log(`AppId    : ${PORTAL_APP_ID ?? "(auto-sélection)"}`);
  console.log("-".repeat(60));

  // ── 1. Login ───────────────────────────────────────────────
  console.log("\n[1/2] Tentative de connexion...");
  let session;
  try {
    session = await loginUsaPortal(EMAIL, PASSWORD);
  } catch (err) {
    console.error("❌ Login exception:", err);
    process.exit(1);
  }

  if (!session) {
    console.error("❌ Login échoué — session null retournée");
    process.exit(1);
  }

  console.log("✅ Login réussi !");
  console.log(`   fullName     : ${session.fullName}`);
  console.log(`   userID       : ${session.userID}`);
  console.log(`   missionId    : ${session.missionId}`);
  console.log(`   allowedOfcs  : ${session.allowedOfcs?.length ?? 0} OFC(s)`);
  if (session.allowedOfcs?.length) {
    session.allowedOfcs.forEach((o: { ofcId?: unknown; postName?: unknown }) =>
      console.log(`     • ${o.postName ?? o.ofcId ?? JSON.stringify(o)}`)
    );
  }
  console.log(`   accessToken  : ${session.accessToken?.slice(0, 20)}...`);

  // ── 2. Statut du dossier ────────────────────────────────────
  console.log("\n[2/2] Vérification statut dossier...");
  const status = await checkUsaAppointmentRequestStatus(session, PORTAL_APP_ID);

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
      console.log("💳 Paiement non confirmé (pendingAppoStatus=0) — le compte n'est pas éligible");
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
