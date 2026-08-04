/**
 * test-saopola-live.ts — Test de bout en bout LIVE du portail São Paulo (Saopolo)
 *
 * Ce fichier exécute le flux complet du scanner sur le vrai portail citaconsular.es
 * São Paulo, sans aucun mock. Il permet de diagnostiquer chaque étape :
 *   1. Session CF (Cloudflare cookie via CapSolver + proxy Decodo)
 *   2. Scan /main/ → parsing HTML + détection "No hay horas"
 *   3. getservices/ → liste des services disponibles
 *   4. getagendas/ → liste des agendas pour le service visa
 *   5. datetime/ → créneaux disponibles par mois
 *   6. Résultat final : found / not_found / error / cf_blocked
 *
 * Usage :
 *   SPAIN_HTTP_MODE=1 tsx src/scripts/test-saopola-live.ts
 *
 * Prérequis env vars :
 *   DECODO_PROXY_URL    — URL proxy Decodo ISP (ex: http://user:pass@dc.decodo.com:10000)
 *   CAPSOLVER_API_KEY   — Clé CapSolver pour résoudre le Turnstile CF
 *   REDIS_URL           — (optionnel) Persistance session CF entre runs
 */

import "dotenv/config";
import { SAOPOLO_PORTAL_URL, SAOPOLO_WIDGET_KEY } from "../spain-portals.js";
import { runSpainHttpProbe, scanSpainHttp } from "../spain-http-scanner.js";
import { ensureSpainCfSession, spainCfFetch, getActiveSpainCfSession } from "../spain-soax-solver.js";
import { initSpainRedis, removeSpainCfSessionFromRedis } from "../spain-redis-persistence.js";
import { spainPersistentBrowser } from "../spain-persistent-browser.js";

// ─── Forcer le mode HTTP ──────────────────────────────────────────────────────
// Nécessaire pour que ensureSpainCfSession / spainCfFetch soient actifs.
process.env.SPAIN_HTTP_MODE = "1";

const PORTAL_URL = process.env.SAOPOLO_PORTAL_URL ?? SAOPOLO_PORTAL_URL;
const WIDGET_KEY  = SAOPOLO_WIDGET_KEY;
const BASE_BOOKITIT = `https://www.citaconsular.es/onlinebookings/`;

// ─── Helpers de log ───────────────────────────────────────────────────────────
const now = () => new Date().toISOString().replace("T", " ").slice(0, 23);
function log(level: "INFO" | "WARN" | "ERROR" | "OK" | "STEP", msg: string) {
  const icon = { INFO: "ℹ️ ", WARN: "⚠️ ", ERROR: "❌", OK: "✅", STEP: "▶️ " }[level];
  console.log(`[${now()}] ${icon}  ${msg}`);
}
function section(title: string) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(72)}`);
}
function subsection(title: string) {
  console.log(`\n  ── ${title}`);
}

// ─── Vérification des prérequis ───────────────────────────────────────────────
function checkPrerequisites(): boolean {
  const missing: string[] = [];
  if (!process.env.DECODO_PROXY_URL)  missing.push("DECODO_PROXY_URL");
  if (!process.env.CAPSOLVER_API_KEY) missing.push("CAPSOLVER_API_KEY");
  if (missing.length > 0) {
    log("ERROR", `Variables d'environnement manquantes : ${missing.join(", ")}`);
    log("INFO",  "Lancer avec : DECODO_PROXY_URL=... CAPSOLVER_API_KEY=... tsx src/scripts/test-saopola-live.ts");
    return false;
  }
  return true;
}

// ─── Parsing JSON/JSONP simplifié ─────────────────────────────────────────────
function parseJsonp(raw: string): unknown {
  if (!raw || raw.length === 0) return null;
  // Essai JSON direct
  try { return JSON.parse(raw); } catch { /* continue */ }
  // Essai JSONP : callback(payload);
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* continue */ } }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  section("TEST LIVE SAOPOLO — " + now());
  log("INFO", `Portail ciblé  : ${PORTAL_URL}`);
  log("INFO", `Widget key      : ${WIDGET_KEY}`);
  log("INFO", `Mode            : SPAIN_HTTP_MODE=1 (HTTP-only + proxy Decodo)`);
  log("INFO", `Proxy           : ${(process.env.DECODO_PROXY_URL ?? "").replace(/:([^@:]+)@/, ":***@")}`);

  if (!checkPrerequisites()) process.exit(1);

  // ─── Étape 0 : Redis (optionnel — persistance session CF) ─────────────────
  section("Étape 0 — Initialisation Redis");
  const redisOk = await initSpainRedis().catch((e) => {
    log("WARN", `Redis non disponible (non-fatal) : ${e}`);
    return false;
  });
  log(redisOk ? "OK" : "WARN", redisOk ? "Redis connecté — session CF persistée" : "Redis absent — session CF en mémoire uniquement");

  // ─── Étape 0b : Reset session (force solve frais pour Saopolo) ───────────
  // Le slot-hunter peut avoir sauvegardé une session Kinshasa dans Redis.
  // On invalide tout (mémoire + Redis + browser) pour obtenir un PHPSESSID
  // lié au portail Saopolo et non à un autre portail.
  section("Étape 0b — Reset session (solve frais Saopolo)");
  await removeSpainCfSessionFromRedis();
  await spainPersistentBrowser.closeAndInvalidate();
  log("OK", "Session Redis + browser invalidés — solve frais en cours…");

  // ─── Étape 1 : Session Cloudflare ─────────────────────────────────────────
  section("Étape 1 — Obtention session Cloudflare pour Saopolo");
  const t1 = Date.now();
  const session = await ensureSpainCfSession(PORTAL_URL);
  const t1Elapsed = ((Date.now() - t1) / 1_000).toFixed(1);

  if (!session) {
    log("ERROR", `Session CF introuvable pour ${PORTAL_URL} (${t1Elapsed}s)`);
    log("INFO",  "Vérifier : DECODO_PROXY_URL valide, CAPSOLVER_API_KEY valide, quota CapSolver non épuisé");
    process.exit(1);
  }

  log("OK", `Session CF obtenue en ${t1Elapsed}s`);
  log("INFO", `cf_clearance    : ${session.cfClearance.slice(0, 30)}…`);
  log("INFO", `expires         : ${new Date(session.expiresAt).toISOString()}`);
  log("INFO", `proxy           : ${(session.soaxProxyUrl || "direct").replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `source          : ${session.source ?? "unknown"}`);
  log("INFO", `cookies         : ${session.allCookies.map(c => c.name).join(", ")}`);

  // ─── Étape 2 : Probe complet via runSpainHttpProbe ─────────────────────────
  section("Étape 2 — Probe HTTP complet (runSpainHttpProbe)");
  log("STEP", `scanSpainHttp(${PORTAL_URL}) …`);
  const t2 = Date.now();
  const probe = await runSpainHttpProbe(PORTAL_URL);
  const t2Elapsed = ((Date.now() - t2) / 1_000).toFixed(1);

  const statusIcon = probe.status === "found" ? "✅ FOUND" :
    probe.status === "not_found" ? "ℹ️  NOT_FOUND" : "❌ ERROR";

  log("INFO", `Résultat        : ${statusIcon} (${t2Elapsed}s)`);
  if (probe.slotInfo)     log("OK",   `Créneau détecté : ${probe.slotInfo}`);
  if (probe.errorMessage) log("WARN", `Message d'erreur : ${probe.errorMessage}`);

  // ─── Étape 3 : Appels API individuels ──────────────────────────────────────
  // On utilise la session CF active pour tester chaque endpoint Bookitit.
  section("Étape 3 — Appels API Bookitit individuels");

  const activeSession = getActiveSpainCfSession() ?? session;
  const now_ms = Date.now();

  const commonParams = new URLSearchParams({
    type:         "default",
    publickey:    WIDGET_KEY,
    lang:         "es",
    version:      "4",
    src:          `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/#services`,
    srvsrc:       "https://www.citaconsular.es",
    selectedPeople: "1",
    _:            String(now_ms),
  });

  const jsonpHeaders = {
    "Accept":          "*/*",
    "Referer":         `https://www.citaconsular.es/es/hosteds/widgetdefault/${WIDGET_KEY}/#services`,
    "X-Requested-With": "XMLHttpRequest",
  };

  // ── 3a. getwidgetconfigurations/ ─────────────────────────────────────────
  subsection("3a. getwidgetconfigurations/");
  {
    const cb = `jQuery_cfg_${now_ms}`;
    const url = `${BASE_BOOKITIT}getwidgetconfigurations/?callback=${cb}&${commonParams}`;
    const t = Date.now();
    const res = await spainCfFetch(url, activeSession, { headers: jsonpHeaders });
    const body = res ? await res.text() : "";
    const elapsed = ((Date.now() - t) / 1_000).toFixed(1);
    const parsed = parseJsonp(body);
    log("INFO", `getwidgetconfigurations/ → ${body.length}B en ${elapsed}s`);
    if (parsed) {
      const cfg = (parsed as any)?.WidgetConfiguration;
      if (cfg) {
        log("OK",   `captcha         : ${cfg.captcha ?? "?"} | registration_type: ${cfg.registration_type ?? "?"}`);
        log("INFO", `captcha requis  : ${cfg.captcha === "1" ? "OUI ⚠️" : "NON ✅"}`);
      }
    } else {
      log("WARN", `Parse JSONP échoué — extrait: ${body.slice(0, 120)}`);
    }
  }

  // ── 3b. getservices/ ──────────────────────────────────────────────────────
  subsection("3b. getservices/");
  let visaServiceId = "";
  {
    const cb = `jQuery_svc_${now_ms}`;
    const url = `${BASE_BOOKITIT}getservices/?callback=${cb}&${commonParams}`;
    const t = Date.now();
    const res = await spainCfFetch(url, activeSession, { headers: jsonpHeaders });
    const body = res ? await res.text() : "";
    const elapsed = ((Date.now() - t) / 1_000).toFixed(1);
    const parsed = parseJsonp(body);
    log("INFO", `getservices/ → ${body.length}B en ${elapsed}s`);
    if (Array.isArray(parsed)) {
      log("OK",  `${parsed.length} service(s) trouvé(s) :`);
      for (const svc of parsed as Array<{ id: string; name?: string }>) {
        const isVisa = /tramita|visados?|visa/i.test(svc.name ?? "");
        log("INFO", `  ${isVisa ? "🎯" : "  "} ID=${svc.id} | nom=${svc.name ?? "(masqué)"}`);
        if (isVisa && !visaServiceId) visaServiceId = svc.id;
      }
      if (visaServiceId) log("OK", `Service visa retenu pour les étapes suivantes : ${visaServiceId}`);
    } else {
      log("WARN", `Parse JSONP échoué — extrait: ${body.slice(0, 120)}`);
    }
  }

  // ── 3c. getagendas/ ───────────────────────────────────────────────────────
  subsection("3c. getagendas/");
  let agendaId = "";
  {
    const cb = `jQuery_ag_${now_ms}`;
    const params = new URLSearchParams(commonParams);
    if (visaServiceId) params.set("services[]", visaServiceId);
    const url = `${BASE_BOOKITIT}getagendas/?callback=${cb}&${params}`;
    const t = Date.now();
    const res = await spainCfFetch(url, activeSession, { headers: jsonpHeaders });
    const body = res ? await res.text() : "";
    const elapsed = ((Date.now() - t) / 1_000).toFixed(1);
    const parsed = parseJsonp(body);
    log("INFO", `getagendas/ → ${body.length}B en ${elapsed}s${body.length === 0 ? " ⚠️  VIDE" : ""}`);
    if (parsed && (parsed as any)?.agendas) {
      const agendas: Array<{ idAgenda: string; agendaName?: string }> = (parsed as any).agendas;
      log("OK", `${agendas.length} agenda(s) :`);
      for (const ag of agendas) {
        log("INFO", `  ID=${ag.idAgenda} | nom=${ag.agendaName ?? "(sans nom)"}`);
        if (!agendaId) agendaId = ag.idAgenda;
      }
    } else if (body.length > 0) {
      log("WARN", `Parse JSONP échoué — extrait: ${body.slice(0, 120)}`);
    } else {
      log("WARN", "getagendas/ → corps vide (0B) — session CF liée à une IP différente ou PHPSESSID manquant");
    }
  }

  // ── 3d. datetime/ (mois courant et suivant) ───────────────────────────────
  subsection("3d. datetime/ — créneaux disponibles");
  {
    const months = [
      new Date(),
      new Date(Date.now() + 31 * 24 * 3600 * 1_000),
      new Date(Date.now() + 62 * 24 * 3600 * 1_000),
    ];
    let totalSlots = 0;

    for (const monthDate of months) {
      const start = monthDate.toISOString().slice(0, 7) + "-01";
      const end = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0)
        .toISOString().slice(0, 10);
      const cb = `jQuery_dt_${now_ms}_${monthDate.getMonth()}`;
      const params = new URLSearchParams(commonParams);
      if (visaServiceId) params.set("services[]", visaServiceId);
      if (agendaId)       params.set("agendas[]", agendaId);
      params.set("start", start);
      params.set("end", end);
      const url = `${BASE_BOOKITIT}datetime/?callback=${cb}&${params}`;
      const t = Date.now();
      const res = await spainCfFetch(url, activeSession, { headers: jsonpHeaders });
      const body = res ? await res.text() : "";
      const elapsed = ((Date.now() - t) / 1_000).toFixed(1);
      const parsed = parseJsonp(body);
      const slots = parsed && Array.isArray((parsed as any)?.Slots) ? (parsed as any).Slots : [];
      const slotCount = slots.length;
      totalSlots += slotCount;

      if (body.length === 0) {
        log("WARN", `datetime/ ${start}→${end} → 0B (session IP mismatch probable)`);
      } else if (slotCount > 0) {
        log("OK", `datetime/ ${start}→${end} → ${slotCount} créneau(x) disponible(s) :`);
        for (const slot of slots.slice(0, 5)) {
          const times = Object.keys(slot.times ?? {}).join(", ");
          log("INFO", `  📅 ${slot.date} | ${times || "(pas d'heures)"} | freeSlots: ${
            Object.values(slot.times ?? {}).map((t: any) => t.freeSlots).join("/")
          }`);
        }
        if (slotCount > 5) log("INFO", `  … et ${slotCount - 5} autres créneaux`);
      } else {
        log("INFO", `datetime/ ${start}→${end} → ${body.length}B, 0 créneau (${elapsed}s)`);
      }
    }

    if (totalSlots > 0) {
      log("OK", `🎉 Total créneaux détectés sur 3 mois : ${totalSlots}`);
    } else {
      log("INFO", "Aucun créneau disponible sur les 3 prochains mois.");
    }
  }

  // ─── Résumé ────────────────────────────────────────────────────────────────
  section("Résumé final");
  log("INFO", `Portal testé    : ${PORTAL_URL}`);
  log("INFO", `Widget key      : ${WIDGET_KEY}`);
  log("INFO", `Service visa    : ${visaServiceId || "(non détecté)"}`);
  log("INFO", `Agenda ID       : ${agendaId || "(non détecté)"}`);
  log(probe.status === "found" ? "OK" : "INFO",
    `Résultat probe  : ${probe.status}${probe.slotInfo ? " — " + probe.slotInfo : ""}${probe.errorMessage ? " — " + probe.errorMessage : ""}`);

  if (probe.status === "error" && (probe.errorMessage ?? "").toLowerCase().includes("cf")) {
    log("WARN", "→ Erreur CF probable. Vérifier DECODO_PROXY_URL et CAPSOLVER_API_KEY.");
  } else if (probe.status === "error") {
    log("WARN", `→ Erreur scanner : ${probe.errorMessage}`);
  } else if (probe.status === "not_found") {
    log("INFO", "→ Pas de créneau disponible en ce moment. Le scanner est fonctionnel.");
  } else if (probe.status === "found") {
    log("OK", "→ Créneau disponible ! Le système fonctionne correctement bout-en-bout.");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
