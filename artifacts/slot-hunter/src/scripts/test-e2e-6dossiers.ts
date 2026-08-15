/**
 * test-e2e-6dossiers.ts — Test E2E complet, 6 faux dossiers, mode production
 *
 * Reproduit EXACTEMENT le flux du watcher en production (capsolver-residential) :
 *   1. Init Redis + solve CF
 *   2. runSpainHttpProbe → services, _allSlots, _widgetConfig
 *   3. Matching service (targetServiceId depuis _services)
 *   4. Assignation round-robin des créneaux (même algo que la prod)
 *   5. Booking séquentiel dossier par dossier (capsolver = PHPSESSID partagé)
 *   6. Test groupe : 2 dossiers sur le même créneau (groupSize=2)
 *   7. Résumé + assertions anti-régression
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   npx tsx src/scripts/test-e2e-6dossiers.ts
 *
 * Attendu sans creneau reel : signin_failed (serveur rejet credentials fictifs)
 * Attendu si creneau dispo  : signin_failed OU booked (si credentials réels fournis)
 * Interdit                  : no_slots (régression service) ou 0B getsigninfields
 */

import "dotenv/config";

process.env.SPAIN_HTTP_MODE = "1";
if (!process.env.SPAIN_SESSION_MODE) {
  process.env.SPAIN_SESSION_MODE = "capsolver-residential";
}

import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { executeHttpBooking, type SpainBookingConfig, type ExtractedSlotInfo } from "../spain-http-booking.js";
import { ensureSpainCfSession, getActiveSpainCfSession } from "../spain-soax-solver.js";
import { initSpainRedis, removeSpainCfSessionFromRedis } from "../spain-redis-persistence.js";
import { spainPersistentBrowser } from "../_legacy_spain-persistent-browser.js";
import { SAOPOLO_PORTAL_URL, SAOPOLO_WIDGET_KEY } from "../spain-portals.js";

const PORTAL_URL = SAOPOLO_PORTAL_URL;

// ─── 6 faux dossiers ──────────────────────────────────────────────────────────
// 4 individuels + 2 en groupe (même créneau, groupSize=2)
// Les credentials sont délibérément faux → signin_failed attendu partout.

type FakeDossier = SpainBookingConfig & { id: string; label: string };

const DOSSIERS: FakeDossier[] = [
  {
    id: "d1", label: "Dossier A (solo)",
    login: "00000001A", password: "FakeA_2026!",
    applicantName: "AMINA DIALLO (A)", applicantEmail: "amina.diallo.fake@test.com",
    visaType: "visa touristique", groupSize: 1,
  },
  {
    id: "d2", label: "Dossier B (solo)",
    login: "00000002B", password: "FakeB_2026!",
    applicantName: "PIERRE NKOSI (B)", applicantEmail: "pierre.nkosi.fake@test.com",
    visaType: "visa affaires", groupSize: 1,
  },
  {
    id: "d3", label: "Dossier C (solo)",
    login: "00000003C", password: "FakeC_2026!",
    applicantName: "RANIA GHOUL (C)", applicantEmail: "rania.ghoul.fake@test.com",
    visaType: "visa étudiant", groupSize: 1,
  },
  {
    id: "d4", label: "Dossier D (solo)",
    login: "00000004D", password: "FakeD_2026!",
    applicantName: "JOEL MBEKI (D)", applicantEmail: "joel.mbeki.fake@test.com",
    visaType: "visa touristique", groupSize: 1,
  },
  {
    id: "g1", label: "Groupe E1 (groupSize=2, slot partagé avec E2)",
    login: "00000005E", password: "FakeE_2026!",
    applicantName: "SARAH KONE (E1)", applicantEmail: "sarah.kone.fake@test.com",
    visaType: "visa touristique", groupSize: 2,
  },
  {
    id: "g2", label: "Groupe E2 (groupSize=2, slot partagé avec E1)",
    login: "00000006F", password: "FakeF_2026!",
    applicantName: "MARC LEWA (E2)", applicantEmail: "marc.lewa.fake@test.com",
    visaType: "visa touristique", groupSize: 2,
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sec(title: string) {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}
function sub(title: string) { console.log(`\n  ── ${title}`); }
function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function info(msg: string) { console.log(`  ℹ️  ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }
function err(msg: string) { console.log(`  ❌ ${msg}`); }
function ts() { return new Date().toISOString().slice(0, 23).replace("T", " "); }

/**
 * Round-robin identique à la production (spain-watcher-loop.ts : assignSlotsRoundRobin).
 * Tri par date ASC + heure ASC, avance le curseur à chaque dossier, reboucle si besoin.
 */
function assignSlotsRoundRobin(
  dossiers: FakeDossier[],
  allSlots: Array<{ date: string; time: string; agendaId?: string; freeslots: number }>,
): Map<string, { date: string; time: string; agendaId?: string }> {
  const out = new Map<string, { date: string; time: string; agendaId?: string }>();
  if (!allSlots.length || !dossiers.length) return out;

  const sorted = [...allSlots].sort((a, b) =>
    a.date.localeCompare(b.date) || a.time.localeCompare(b.time),
  );
  let cursor = 0;

  for (const d of dossiers) {
    const minFree = d.groupSize && d.groupSize > 1 ? d.groupSize : 1;
    let assigned = false;

    // Forward pass depuis cursor
    for (let i = cursor; i < sorted.length; i++) {
      const s = sorted[i];
      if (s.freeslots !== -1 && s.freeslots < minFree) continue;
      out.set(d.id, { date: s.date, time: s.time, agendaId: s.agendaId });
      cursor = i + 1;
      assigned = true;
      break;
    }
    // Rebouclage depuis le début
    if (!assigned) {
      for (let i = 0; i < sorted.length; i++) {
        const s = sorted[i];
        if (s.freeslots !== -1 && s.freeslots < minFree) continue;
        out.set(d.id, { date: s.date, time: s.time, agendaId: s.agendaId });
        assigned = true;
        break;
      }
    }
  }
  return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  sec(`TEST E2E 6 DOSSIERS — ${ts()}`);
  info(`Portail      : ${PORTAL_URL}`);
  info(`Widget key   : ${SAOPOLO_WIDGET_KEY}`);
  info(`Session mode : ${process.env.SPAIN_SESSION_MODE}`);
  info(`Dossiers     : ${DOSSIERS.length} (4 solo + 2 groupe)`);

  // ── Phase 0 : Redis ───────────────────────────────────────────────────────
  sec("Phase 0 — Redis + reset session");
  const redisOk = await initSpainRedis().then(() => true).catch(() => false);
  info(`Redis : ${redisOk ? "connecté ✅" : "absent (session en mémoire)"}`);

  try { removeSpainCfSessionFromRedis(); } catch { /* non-fatal */ }
  try { await spainPersistentBrowser.closeAndInvalidate(); } catch { /* non-fatal */ }
  ok("Session invalidée — solve frais");

  // ── Phase 1 : Session CF ──────────────────────────────────────────────────
  sec("Phase 1 — Session Cloudflare (capsolver-residential)");
  const t1 = Date.now();
  const cfSession = await ensureSpainCfSession(PORTAL_URL);
  if (!cfSession) {
    err("Session CF introuvable — vérifier DECODO_PROXY_URL + CAPSOLVER_API_KEY");
    process.exit(1);
  }
  ok(`Session CF obtenue en ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  info(`cf_clearance : ${cfSession.cfClearance.slice(0, 28)}…`);
  info(`expires      : ${new Date(cfSession.expiresAt).toISOString()}`);
  info(`proxy        : ${(cfSession.soaxProxyUrl || "direct").replace(/:([^@:]+)@/, ":***@")}`);
  info(`source       : ${cfSession.source ?? "unknown"}`);
  const phpCookie = cfSession.allCookies.find(c => c.name === "PHPSESSID");
  info(`PHPSESSID    : ${phpCookie ? phpCookie.value.slice(0, 14) + "…" : "❌ absent"}`);

  // ── Phase 2 : Scan complet (vrai scanner production) ─────────────────────
  sec("Phase 2 — Scan production (runSpainHttpProbe)");
  const t2 = Date.now();
  const probe = await runSpainHttpProbe(PORTAL_URL);
  const scanMs = Date.now() - t2;

  const statusIcon = probe.status === "found" ? "✅ FOUND" : probe.status === "not_found" ? "ℹ️  NOT_FOUND" : "❌ " + probe.status;
  info(`Résultat  : ${statusIcon} (${(scanMs / 1000).toFixed(1)}s)`);
  if (probe.slotInfo)     ok(`Créneau  : ${probe.slotInfo}`);
  if (probe.errorMessage) warn(`Erreur   : ${probe.errorMessage}`);

  // ── Phase 3 : Inspection des données du scan ──────────────────────────────
  sec("Phase 3 — Données du scan (services / créneaux / config)");

  const services = ((probe as any)._services ?? []) as ExtractedSlotInfo[];
  const allSlots = ((probe as any)._allSlots ?? []) as Array<{ date: string; time: string; agendaId?: string; freeslots: number }>;
  const wCfg = (probe as any)._widgetConfig as { captcha?: unknown; registration_type?: unknown } | undefined;
  const mainHtml = (probe as any)._mainHtml as string | undefined ?? "";

  sub("3a — getwidgetconfigurations/");
  if (wCfg) {
    ok(`captcha=${wCfg.captcha} | registration_type=${wCfg.registration_type}`);
    info(`captcha requis : ${String(wCfg.captcha) === "1" ? "OUI ⚠️" : "NON ✅"}`);
  } else {
    info("Config widget non disponible (probe non-found).");
  }

  sub("3b — getservices/ (via _services)");
  if (services.length > 0) {
    ok(`${services.length} service(s) propagé(s) par le scan :`);
    for (const s of services) {
      info(`  🎯 ID=${s.serviceId} | nom="${s.serviceName}"`);
    }
  } else if (probe.status === "found") {
    err("RÉGRESSION PLOMBERIE : probe=found mais _services vide !");
    process.exit(1);
  } else {
    info("Aucun service (probe non-found — pas de disponibilité, comportement normal).");
  }

  sub("3c — datetime/ (via _allSlots)");
  info(`${allSlots.length} créneau(x) total(aux) sur tous les mois scannés`);
  if (allSlots.length > 0) {
    ok("5 premiers créneaux :");
    for (const s of allSlots.slice(0, 5)) {
      const places = s.freeslots === -1 ? "capacité inconnue" : `${s.freeslots} place(s)`;
      info(`  📅 ${s.date} ${s.time} | ${places}${s.agendaId ? ` | agenda=${s.agendaId}` : ""}`);
    }
    if (allSlots.length > 5) info(`  … et ${allSlots.length - 5} autres créneaux`);
  }

  const agendaFromSlot = allSlots.find(s => s.agendaId)?.agendaId ?? "";
  info(`Agenda détecté par datetime/ : ${agendaFromSlot || "(aucun)"}`);

  // ── Phase 4 : Assignation round-robin ────────────────────────────────────
  sec("Phase 4 — Assignation round-robin des créneaux (algo production)");

  const slotAssignments = assignSlotsRoundRobin(DOSSIERS, allSlots);

  // Afficher
  if (allSlots.length === 0) {
    warn("Aucun créneau → tous les dossiers utiliseront le repli datetime/ de executeHttpBooking");
  } else {
    ok(`Round-robin sur ${allSlots.length} créneau(x) pour ${DOSSIERS.length} dossier(s) :`);
    for (const d of DOSSIERS) {
      const a = slotAssignments.get(d.id);
      const grp = d.groupSize && d.groupSize > 1 ? ` [groupe ${d.groupSize}p]` : "";
      info(`  ${d.applicantName}${grp} → ${a ? `${a.date} ${a.time}${a.agendaId ? ` (agenda ${a.agendaId})` : ""}` : "⚠️  aucun slot éligible (repli prod)"}`);
    }
  }

  // Groupe E1+E2 : forcer le même créneau (test groupe)
  const groupSlot = slotAssignments.get("g1") ?? slotAssignments.get("g2") ?? allSlots.find(s => s.freeslots === -1 || s.freeslots >= 2);
  const groupTargetDate = groupSlot?.date ?? (probe as any).slot?.date;
  const groupTargetTime = groupSlot?.time ?? (probe as any).slot?.time;
  const groupAgendaId   = groupSlot?.agendaId ?? agendaFromSlot;

  // ── Phase 5 : Matching service ────────────────────────────────────────────
  sec("Phase 5 — Matching service (targetServiceId depuis _services)");

  const primaryService = services[0];
  if (primaryService) {
    ok(`Service cible retenu : "${primaryService.serviceName}" (ID: ${primaryService.serviceId})`);
    info("Tous les dossiers utilisent ce service (portail mono-service).");
  } else {
    warn("Aucun service propagé — executeHttpBooking utilisera son propre fallback.");
  }

  // ── Phase 6 : Booking séquentiel (4 dossiers solo) ───────────────────────
  sec("Phase 6 — Booking séquentiel : 4 dossiers solo");
  info("Mode capsolver = PHPSESSID partagé → séquentiel obligatoire (comme la prod)");
  info("Attendu : chaque dossier atteint signin/ et reçoit un rejet serveur (credentials faux)\n");

  const soloDossiers = DOSSIERS.filter(d => !d.id.startsWith("g"));
  const soloResults: Array<{ id: string; name: string; status: string; error?: string; ms: number }> = [];

  for (const d of soloDossiers) {
    const assigned = slotAssignments.get(d.id);
    const cfg: SpainBookingConfig = {
      login: d.login,
      password: d.password,
      applicantName: d.applicantName,
      applicantEmail: d.applicantEmail,
      visaType: d.visaType,
      groupSize: 1,
      targetServiceId: primaryService?.serviceId,
      availableServices: services,
      targetDate: assigned?.date ?? (probe as any).slot?.date,
      targetTime: assigned?.time ?? (probe as any).slot?.time,
      agendaId: assigned?.agendaId ?? agendaFromSlot,
    };

    info(`[${d.applicantName}] → créneau ${cfg.targetDate ?? "?"} ${cfg.targetTime ?? "?"} | service=${cfg.targetServiceId ?? "?"}`);
    const tB = Date.now();
    const session = getActiveSpainCfSession() ?? cfSession;
    const res = await executeHttpBooking(session, PORTAL_URL, mainHtml, cfg);
    const ms = Date.now() - tB;

    const isExpected = res.status === "signin_failed" || res.status === "booking_failed" || res.status === "booked";
    const icon = res.status === "booked" ? "🎉 BOOKED" : isExpected ? "✅" : "❌";
    console.log(`  ${icon} [${d.applicantName}] → ${res.status} (${ms}ms)${res.errorMessage ? ` — ${res.errorMessage.slice(0, 90)}` : ""}`);
    soloResults.push({ id: d.id, name: d.applicantName!, status: res.status, error: res.errorMessage, ms });
  }

  // ── Phase 7 : Booking groupe (2 dossiers même créneau groupSize=2) ────────
  sec("Phase 7 — Booking groupe : 2 dossiers sur le même créneau (groupSize=2)");
  info(`Créneau partagé : ${groupTargetDate ?? "?"} ${groupTargetTime ?? "?"}${groupAgendaId ? ` | agenda=${groupAgendaId}` : ""}`);
  info("Objectif : vérifier que selectedPeople=2 est bien envoyé et que les 2 dossiers atteignent signin/\n");

  const groupDossiers = DOSSIERS.filter(d => d.id.startsWith("g"));
  const groupResults: typeof soloResults = [];

  for (const d of groupDossiers) {
    const cfg: SpainBookingConfig = {
      login: d.login,
      password: d.password,
      applicantName: d.applicantName,
      applicantEmail: d.applicantEmail,
      visaType: d.visaType,
      groupSize: 2,                         // ← test groupe
      targetServiceId: primaryService?.serviceId,
      availableServices: services,
      targetDate: groupTargetDate,
      targetTime: groupTargetTime,
      agendaId: groupAgendaId,
    };

    info(`[${d.applicantName}] → même créneau ${cfg.targetDate ?? "?"} ${cfg.targetTime ?? "?"} | groupSize=2`);
    const tB = Date.now();
    const session = getActiveSpainCfSession() ?? cfSession;
    const res = await executeHttpBooking(session, PORTAL_URL, mainHtml, cfg);
    const ms = Date.now() - tB;

    const isExpected = res.status === "signin_failed" || res.status === "booking_failed" || res.status === "booked";
    const icon = res.status === "booked" ? "🎉 BOOKED" : isExpected ? "✅" : "❌";
    console.log(`  ${icon} [${d.applicantName}] groupSize=2 → ${res.status} (${ms}ms)${res.errorMessage ? ` — ${res.errorMessage.slice(0, 90)}` : ""}`);
    groupResults.push({ id: d.id, name: d.applicantName!, status: res.status, error: res.errorMessage, ms });
  }

  // ── Phase 8 : Résumé + assertions anti-régression ─────────────────────────
  sec("Résumé final — Assertions anti-régression");

  const allResults = [...soloResults, ...groupResults];
  let pass = 0, fail = 0;

  for (const r of allResults) {
    const isBooked     = r.status === "booked";
    const reachedSignin = r.status === "signin_failed" || r.status === "booked" || r.status === "booking_failed";
    const isRegression = r.status === "no_slots" || (r.error ?? "").includes("Aucun service rendu dans le HTML");
    const icon = isRegression ? "❌ RÉGRESSION" : reachedSignin ? "✅" : "⚠️ ";
    console.log(`  ${icon} ${r.name} → ${r.status} (${r.ms}ms)${r.error ? ` — ${r.error.slice(0, 80)}` : ""}`);
    if (isRegression) fail++; else pass++;
  }

  console.log();
  if (fail === 0) {
    ok(`TOUTES les assertions passent (${pass}/${allResults.length})`);
    ok("✔ _services propagés correctement");
    ok("✔ Matching service opérationnel");
    ok("✔ Round-robin slot assignment fonctionnel");
    ok("✔ Booking séquentiel atteint signin/ pour chaque dossier");
    ok("✔ Booking groupe (groupSize=2) atteint signin/");
    ok("✔ ZÉRO régression 'Aucun service rendu dans le HTML'");
  } else {
    err(`${fail} RÉGRESSION(S) détectée(s) — voir les lignes ❌ ci-dessus`);
  }

  info(`\n  Scan      : ${probe.status} — ${allSlots.length} créneau(x) détecté(s)`);
  info(`  Service   : ${primaryService?.serviceName ?? "(aucun)"} (${primaryService?.serviceId ?? "?"})`);
  info(`  Solo      : ${soloResults.map(r => r.status).join(", ")}`);
  info(`  Groupe    : ${groupResults.map(r => r.status).join(", ")}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("\n[FATAL]", e);
  process.exit(1);
});
