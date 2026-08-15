/**
 * test-getsigninfields-minimal.ts
 *
 * Expérience diagnostique : appel getsigninfields/ dans différents états PHP.
 *
 * Séquence testée :
 *   A) CF solve uniquement (PHPSESSID frais, aucun appel Bookitit)
 *   B) CF solve + 1× datetime/ (mois courant)
 *   C) CF solve + probe réel (6 mois de datetime/ comme le watcher)
 *
 * Si A ou B réussit mais pas C → le probe épuise le PHPSESSID.
 * Si aucun des 3 ne réussit → problème structurel (pas lié au nombre de calls).
 *
 * USAGE :
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   CAPSOLVER_API_KEY=$KEY DECODO_PROXY_URL=$PROXY \
 *   node_modules/.bin/tsx src/scripts/test-getsigninfields-minimal.ts
 */

import "dotenv/config";
import {
  ensureSpainCfSession,
  getActiveSpainCfSession,
  makeBookititUrl,
  spainCfFetch,
} from "../spain-soax-solver.js";
import { runSpainHttpProbe } from "../spain-http-scanner.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initDecodoPool } from "../spain-decodo-pool.js";
import {
  SAOPOLO_PORTAL_URL,
  SAOPOLO_DEFAULT_SERVICE_ID,
  KINSHASA_PORTAL_URL,
  KINSHASA_DEFAULT_SERVICE_ID,
} from "../spain-portals.js";
import { callBookititEndpoint } from "../spain-http-booking.js";

// ─── Config ──────────────────────────────────────────────────────────────────
const PORTAL_URL = process.env.PORTAL_URL ?? SAOPOLO_PORTAL_URL;
const TARGET_SERVICE_ID = process.env.SERVICE_ID ?? SAOPOLO_DEFAULT_SERVICE_ID;

const t0global = Date.now();
const ts = () => `[+${((Date.now() - t0global) / 1000).toFixed(1)}s]`;
const ok   = (msg: string) => console.log(`${ts()} ✅ ${msg}`);
const warn = (msg: string) => console.log(`${ts()} ⚠️  ${msg}`);
const fail = (msg: string) => console.log(`${ts()} ❌ ${msg}`);
const sep  = (label: string) => console.log(`\n${"═".repeat(72)}\n  ${label}\n${"═".repeat(72)}`);

// Helper : appelle getsigninfields/ et retourne la taille de la réponse
async function testGetsigninfields(
  session: ReturnType<typeof getActiveSpainCfSession>,
  label: string,
  targetDate: string,
  targetTime: string,
  agendaId: string,
): Promise<{ sizeB: number; raw: string }> {
  if (!session) {
    fail(`${label}: session nulle — impossible de tester`);
    return { sizeB: 0, raw: "" };
  }
  const publickey = PORTAL_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const portalReferer = PORTAL_URL.replace(/\/?$/, "/");
  const params: Record<string, string | string[]> = {
    type:    "default",
    publickey,
    lang:    "es",
    version: "4",
    src:     portalReferer,
    srvsrc:  "https://www.citaconsular.es",
    "services[]": TARGET_SERVICE_ID,
    ...(agendaId ? { "agendas[]": agendaId } : {}),
    date:    targetDate,
    time:    targetTime,
    selectedPeople: "1",
  };
  const result = await callBookititEndpoint(session, "getsigninfields/", params, PORTAL_URL);
  const sizeB = result ? JSON.stringify(result).length : 0;
  return { sizeB, raw: result ? JSON.stringify(result).slice(0, 200) : "" };
}

// Helper : appelle getservices/ et retourne la taille
async function testGetservices(session: ReturnType<typeof getActiveSpainCfSession>): Promise<number> {
  if (!session) return 0;
  const publickey = PORTAL_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const portalReferer = PORTAL_URL.replace(/\/?$/, "/");
  const result = await callBookititEndpoint(session, "getservices/", {
    type:    "default",
    publickey,
    lang:    "es",
    version: "4",
    src:     portalReferer,
    srvsrc:  "https://www.citaconsular.es",
  }, PORTAL_URL);
  return result ? JSON.stringify(result).length : 0;
}

async function main(): Promise<void> {
  sep("DIAGNOSTIC — getsigninfields/ (3 états PHP)");
  console.log(`Portail : ${PORTAL_URL}`);
  console.log(`Service : ${TARGET_SERVICE_ID}`);

  // ── Init Redis + Decodo ──────────────────────────────────────────────────
  await initSpainRedis();
  await initDecodoPool();
  console.log(`\n${ts()} Redis + Decodo initialisés`);

  // ── CF solve ─────────────────────────────────────────────────────────────
  sep("1 — CF solve (capsolver-residential)");
  await ensureSpainCfSession(PORTAL_URL);
  const sessionFrais = getActiveSpainCfSession()!;
  const php0 = sessionFrais.allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";
  ok(`Session CF établie — PHPSESSID: ${php0.slice(0, 12)}…`);

  // Slot synthétique : 1 mois dans le futur
  const futur = new Date();
  futur.setMonth(futur.getMonth() + 1);
  const targetDate = futur.toISOString().slice(0, 10);
  const targetTime = "09:30";
  console.log(`Slot synthétique : ${targetDate} à ${targetTime}`);

  // ── TEST A : getsigninfields/ sans aucun appel préalable ─────────────────
  sep("TEST A — getsigninfields/ directement après CF solve (aucun appel Bookitit)");
  const gsA = await testGetsigninfields(sessionFrais, "A", targetDate, targetTime, "");
  if (gsA.sizeB > 100) {
    ok(`A — getsigninfields/ → ${gsA.sizeB}B ✅ — sans aucun appel préalable`);
  } else {
    warn(`A — getsigninfields/ → ${gsA.sizeB}B 0B — même sur PHPSESSID frais`);
  }

  // ── TEST B : getservices/ puis getsigninfields/ ───────────────────────────
  sep("TEST B — getservices/ puis getsigninfields/ (sans datetime/)");
  const gsvcB = await testGetservices(sessionFrais);
  console.log(`${ts()} getservices/ → ${gsvcB}B`);

  const gsB = await testGetsigninfields(sessionFrais, "B", targetDate, targetTime, "");
  if (gsB.sizeB > 100) {
    ok(`B — getsigninfields/ → ${gsB.sizeB}B ✅ — après getservices/ seulement`);
  } else {
    warn(`B — getsigninfields/ → ${gsB.sizeB}B 0B — getservices/ ne suffit pas`);
  }

  // ── TEST C : datetime/ (1 appel) puis getsigninfields/ ───────────────────
  sep("TEST C — datetime/ (1 appel, mois suivant) puis getsigninfields/");
  const slotMonth = targetDate.slice(0, 7);
  const lastDay = new Date(Number(slotMonth.slice(0, 4)), Number(slotMonth.slice(5, 7)), 0).getDate();
  const publickey = PORTAL_URL.match(/\/([a-f0-9]{30,})(?:\/|$)/)?.[1] ?? "";
  const portalReferer = PORTAL_URL.replace(/\/?$/, "/");
  const dtC = await callBookititEndpoint(sessionFrais, "datetime/", {
    type:    "default",
    publickey,
    lang:    "es",
    version: "4",
    src:     portalReferer,
    srvsrc:  "https://www.citaconsular.es",
    "services[]": TARGET_SERVICE_ID,
    start:   `${slotMonth}-01`,
    end:     `${slotMonth}-${String(lastDay).padStart(2, "0")}`,
    selectedPeople: "1",
  }, PORTAL_URL);
  console.log(`${ts()} datetime/ (1 appel, ${slotMonth}) → ${dtC ? JSON.stringify(dtC).length : 0}B`);

  const gsC = await testGetsigninfields(sessionFrais, "C", targetDate, targetTime, "");
  if (gsC.sizeB > 100) {
    ok(`C — getsigninfields/ → ${gsC.sizeB}B ✅ — après datetime/ (1 appel)`);
  } else {
    warn(`C — getsigninfields/ → ${gsC.sizeB}B 0B — datetime/ 1× ne suffit pas non plus`);
  }

  // ── TEST D : probe réel (N×datetime/) puis getsigninfields/ ──────────────
  sep("TEST D — probe réel (N mois de datetime/) puis getsigninfields/");
  const probeResult = await runSpainHttpProbe(PORTAL_URL);
  const allSlots = probeResult._allSlots ?? [];
  const agendaIdFromProbe = allSlots[0]?.agendaId ?? "";
  console.log(`${ts()} Probe: status=${probeResult.status} | slots=${allSlots.length} | agendaId=${agendaIdFromProbe || "(vide)"}`);

  const sessionPostProbe = getActiveSpainCfSession()!;
  const phpPost = sessionPostProbe.allCookies.find(c => c.name === "PHPSESSID")?.value ?? "";
  console.log(`${ts()} PHPSESSID post-probe : ${phpPost.slice(0, 12)}… (même=${phpPost === php0})`);

  const gsD = await testGetsigninfields(sessionPostProbe, "D", targetDate, targetTime, agendaIdFromProbe);
  if (gsD.sizeB > 100) {
    ok(`D — getsigninfields/ → ${gsD.sizeB}B ✅ — même après probe complet`);
    ok(`→ CONCLUSION : le probe n'épuise PAS le PHPSESSID`);
  } else {
    fail(`D — getsigninfields/ → ${gsD.sizeB}B 0B — probe épuise le PHPSESSID`);
    if (gsA.sizeB > 100 || gsB.sizeB > 100 || gsC.sizeB > 100) {
      fail(`→ CONCLUSION : datetime/ calls du probe corrompent l'état PHP`);
      fail(`→ FIX : réduire le scan à 1-2 mois, ou séparer PHPSESSID probe/booking`);
    } else {
      fail(`→ CONCLUSION : getsigninfields/ ne fonctionne JAMAIS en HTTP pur sur ce portail`);
      fail(`→ FIX : mode persistent-browser obligatoire pour ce portail`);
    }
  }

  // ── Résumé ────────────────────────────────────────────────────────────────
  sep("RÉSUMÉ DIAGNOSTIC");
  console.log(`  TEST A (frais, sans appel)      : ${gsA.sizeB > 100 ? "✅ " + gsA.sizeB + "B" : "❌ 0B"}`);
  console.log(`  TEST B (après getservices/)     : ${gsB.sizeB > 100 ? "✅ " + gsB.sizeB + "B" : "❌ 0B"}`);
  console.log(`  TEST C (après datetime/ 1×)     : ${gsC.sizeB > 100 ? "✅ " + gsC.sizeB + "B" : "❌ 0B"}`);
  console.log(`  TEST D (après probe N×datetime/): ${gsD.sizeB > 100 ? "✅ " + gsD.sizeB + "B" : "❌ 0B"}`);
  console.log("");

  if (gsA.sizeB <= 100 && gsB.sizeB <= 100 && gsC.sizeB <= 100) {
    console.log("  → HTTP pur non fonctionnel pour getsigninfields/ sur ce portail.");
    console.log("  → Tester sur Kinshasa (PORTAL_URL + SERVICE_ID) ou vérifier les params.");
    process.exitCode = 1;
  } else if (gsD.sizeB <= 100 && (gsA.sizeB > 100 || gsB.sizeB > 100 || gsC.sizeB > 100)) {
    console.log("  → Le probe épuise l'état PHP (trop de datetime/ calls).");
    console.log("  → FIX : limiter le scan ou isoler PHPSESSID booking/probe.");
    process.exitCode = 1;
  } else if (gsD.sizeB > 100) {
    console.log("  → Pipeline complet OK ! getsigninfields/ fonctionne même après probe.");
    process.exitCode = 0;
  }
}

main().catch((e: unknown) => {
  console.error("\nFATAL:", e);
  process.exitCode = 1;
});
