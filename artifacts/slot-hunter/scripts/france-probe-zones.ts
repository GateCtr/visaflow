/**
 * france-probe-zones.ts — Sonde LECTURE SEULE : récupère les créneaux BRUTS
 * d'availability pour un jour donné, afin d'inspecter TOUS les champs qu'un
 * slot serveur porte (au-delà de time/rate/capacity). Le portail fait
 * `slots.map(e => ({ ...e, capacity, numberOfApplicants:0, date }))` : il
 * conserve TOUS les champs serveur (peut-être un _id de créneau). Si le family
 * doit référencer un champ que parseSlot ignore, on obtient
 * ERROR_ADD_GROUPPED_RESERVATION.
 *
 * AUCUNE réservation. Réutilise le code de prod.
 *
 * Usage : cd artifacts/slot-hunter ; npx tsx scripts/france-probe-zones.ts --no-proxy
 */

import "dotenv/config";

import { createFranceHttpClient } from "../src/france/france-http.js";
import { performHandshake, resolveTeam } from "../src/france/france-handshake.js";
import { buildFrancePageUrl, solveFranceTurnstile } from "../src/france/france-turnstile.js";
import { openSession } from "../src/france/france-session.js";
import { buildAvailabilityQuery } from "../src/france/france-scanner.js";
import type { FranceHttpClient } from "../src/france/france-http.js";

const TEST_CONSULATE_SLUG = "ambassade-de-france-a-kinshasa";
const TEST_SERVICE_NAME =
  "ADF - Demande d'inscription au Registre, de CNI/ passeport/déclaration de vol ou perte de documents";
const TEST_DAY = "2026-09-08";

async function main(): Promise<void> {
  const capsolverApiKey = process.env.CAPSOLVER_API_KEY ?? "";
  if (capsolverApiKey.length === 0) {
    console.error("[probe] CAPSOLVER_API_KEY absent (requis pour ouvrir la session).");
    process.exit(1);
    return;
  }

  console.log("[probe] Handshake…");
  const handshake = await performHandshake("");
  if (handshake === null) {
    console.error("[probe] Handshake échoué.");
    process.exit(1);
    return;
  }

  const http: FranceHttpClient = createFranceHttpClient(handshake, "", () =>
    performHandshake(""),
  );

  console.log("[probe] resolveTeam…");
  const team = await resolveTeam(http, TEST_CONSULATE_SLUG);
  if (team === null) {
    console.error("[probe] resolveTeam échoué.");
    process.exit(1);
    return;
  }
  const teamId = team.teamId;
  console.log(`[probe] teamId=${teamId}`);

  console.log("[probe] Turnstile (session)…");
  const token = await solveFranceTurnstile(
    "session",
    capsolverApiKey,
    buildFrancePageUrl(TEST_CONSULATE_SLUG, TEST_SERVICE_NAME),
  );
  if (token === null) {
    console.error("[probe] Turnstile échoué.");
    process.exit(1);
    return;
  }

  console.log("[probe] openSession…");
  const session = await openSession(http, teamId, TEST_SERVICE_NAME, token, Date.now());
  if (session === null) {
    console.error("[probe] openSession échoué.");
    process.exit(1);
    return;
  }
  const sessionId = session.sessionId;
  console.log(`[probe] sessionId=${sessionId}`);

  // GET availability BRUT pour le jour cible (mêmes params que le scanner).
  const query = buildAvailabilityQuery(TEST_SERVICE_NAME, TEST_DAY, sessionId);
  const path = `/team/${encodeURIComponent(teamId)}/reservations/availability?${query}`;
  console.log(`[probe] GET ${path}`);
  const res = await http.get<unknown>(path);
  console.log(`[probe] status=${res.status} ok=${res.ok}`);
  console.log("[probe] availability BRUTE (JSON complet) :");
  console.log(JSON.stringify(res.body, null, 2).slice(0, 4000));
}

main().catch((error: unknown) => {
  console.error("[probe] Erreur :", error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
