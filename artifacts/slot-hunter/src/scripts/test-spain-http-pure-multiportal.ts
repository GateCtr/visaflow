/**
 * test-spain-http-pure-multiportal.ts
 *
 * Smoke test du flow HTTP-pur (capsolver-residential) sur tous les portails Spain.
 * Lance une session complète pour chaque portail et logge les résultats.
 *
 * Usage :
 *   SPAIN_SESSION_MODE=capsolver-residential \
 *   SPAIN_RESIDENTIAL_PROXY_URL=http://user:pass@gate.decodo.com:10001 \
 *   CAPSOLVER_API_KEY=... \
 *   node_modules/.bin/tsx src/scripts/test-spain-http-pure-multiportal.ts
 *
 * Portails testés :
 *   - Kinshasa       (proxy ISP Decodo — DECODO_PROXY_URL)
 *   - São Paulo      (proxy résidentiel — SPAIN_RESIDENTIAL_PROXY_URL)
 *   - Cuba / LMD     (proxy résidentiel — SPAIN_RESIDENTIAL_PROXY_URL)
 *
 * Résultats attendus (validés 2026-08-11) :
 *   Saopolo  : ~331 créneaux septembre
 *   Cuba LMD : ~4193 créneaux
 *   Kinshasa : fermé ou 0 créneau
 */

import { ensureSpainCfSession, makeBookititUrl, type SpainCfSession } from "../spain-soax-solver.js";
import { spainCfFetch } from "../spain-soax-solver.js";
import {
  KINSHASA_PORTAL_URL,
  SAOPOLO_PORTAL_URL,
  CUBA_LMD_PORTAL_URL,
} from "../spain-portals.js";

/** Parse un payload JSONP Bookitit → objet JSON */
function parseJsonpPayload(raw: string): unknown | null {
  if (!raw || raw.length < 2) return null;
  const trimmed = raw.trim();
  // Payload brut JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  // JSONP : jQuery21109...(...)
  const jsonMatch = trimmed.match(/^[^\(]+\(([\s\S]*)\)\s*;?\s*$/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[1]); } catch { return null; }
}

/** Extrait tous les créneaux disponibles d'une réponse datetime/ */
function countSlots(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const p = payload as Record<string, unknown>;
  // Format objet par date : { "2026-09-01": { ... Slots: [...] }, ... }
  let total = 0;
  for (const [, dayData] of Object.entries(p)) {
    if (!dayData || typeof dayData !== "object") continue;
    const d = dayData as Record<string, unknown>;
    const slots = d.Slots ?? d.slots ?? d.FreeSlots ?? d.freeslots;
    if (Array.isArray(slots)) total += slots.length;
    else if (typeof slots === "number" && slots > 0) total += slots;
  }
  return total;
}

interface PortalTestResult {
  portalName: string;
  portalUrl: string;
  success: boolean;
  sessionEstablished: boolean;
  mainBodyBytes: number;
  services: number;
  agendas: number;
  totalSlots: number;
  maxDays: string;
  monthsScanned: number;
  error?: string;
  durationMs: number;
}

async function testPortal(
  portalName: string,
  portalUrl: string,
): Promise<PortalTestResult> {
  const t0 = Date.now();
  const result: PortalTestResult = {
    portalName,
    portalUrl,
    success: false,
    sessionEstablished: false,
    mainBodyBytes: 0,
    services: 0,
    agendas: 0,
    totalSlots: 0,
    maxDays: "",
    monthsScanned: 0,
    durationMs: 0,
  };

  console.log(`\n${"─".repeat(70)}`);
  console.log(`▶ ${portalName} — ${portalUrl}`);

  try {
    // 1. Établir session CF
    const session = await ensureSpainCfSession(portalUrl);
    if (!session) {
      result.error = "ensureSpainCfSession → null";
      result.durationMs = Date.now() - t0;
      console.error(`  ❌ Session échouée: ${result.error}`);
      return result;
    }
    result.sessionEstablished = true;
    result.mainBodyBytes = session.prefetchedMainHtml?.length ?? 0;
    console.log(
      `  ✅ Session: ${result.mainBodyBytes}B /main/ | ` +
      `PHPSESSID: ${session.allCookies.find(c => c.name === "PHPSESSID") ? "✅" : "❌"} | ` +
      `bookititState: ${session.bookititState ? "✅" : "❌"}`,
    );

    // 2. Headers communs pour les appels JSONP
    const headers = {
      "Accept": "text/javascript, application/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "Referer": portalUrl,
    };

    // 3. getwidgetconfigurations/
    const cfgUrl = session.bookititState
      ? makeBookititUrl(session, "getwidgetconfigurations/")
      : null;
    let cfgRaw = "";
    if (cfgUrl) {
      const cfgRes = await spainCfFetch(cfgUrl, session, { headers });
      cfgRaw = cfgRes?.ok ? await cfgRes.text() : "";
    }
    console.log(`  📦 getwidgetconfigurations/ → ${cfgRaw.length}B`);

    // 4. getservices/
    const svcUrl = session.bookititState
      ? makeBookititUrl(session, "getservices/", { selectedPeople: "1" })
      : null;
    let svcRaw = "";
    let serviceIds: string[] = [];
    if (svcUrl) {
      const svcRes = await spainCfFetch(svcUrl, session, { headers });
      svcRaw = svcRes?.ok ? await svcRes.text() : "";
      const svcData = parseJsonpPayload(svcRaw);
      // Extraire IDs de services
      function collectIds(obj: unknown, pattern: RegExp): string[] {
        const out = new Set<string>();
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) { for (const item of node) walk(item); return; }
          if (!node || typeof node !== "object") return;
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (v && typeof v === "object") { walk(v); continue; }
            if ((typeof v === "string" || typeof v === "number") && pattern.test(k)) {
              const s = String(v).trim();
              if (s.length > 0) out.add(s);
            }
          }
        };
        walk(obj);
        return [...out];
      }
      serviceIds = collectIds(svcData, /(service.*id|services.*id|^id$)/i);
      result.services = serviceIds.length;
    }
    console.log(`  🔧 getservices/ → ${svcRaw.length}B | ${result.services} services: ${serviceIds.slice(0, 5).join(", ")}`);

    if (serviceIds.length === 0) {
      result.error = "Aucun service trouvé";
      result.durationMs = Date.now() - t0;
      result.success = true; // session OK, pas de services (portail peut-être fermé)
      return result;
    }

    // 5. getagendas/ — premier service seulement (1 appel par PHPSESSID)
    const targetService = serviceIds[0];
    const agUrl = session.bookititState
      ? makeBookititUrl(session, "getagendas/", { "services[]": targetService, selectedPeople: "1" })
      : null;
    let agRaw = "";
    let agendaIds: string[] = [];
    if (agUrl) {
      const agRes = await spainCfFetch(agUrl, session, { headers });
      agRaw = agRes?.ok ? await agRes.text() : "";
      const agData = parseJsonpPayload(agRaw);
      function collectAgendaIds(obj: unknown): string[] {
        const out = new Set<string>();
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) { for (const item of node) walk(item); return; }
          if (!node || typeof node !== "object") return;
          for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            if (v && typeof v === "object") { walk(v); continue; }
            if ((typeof v === "string" || typeof v === "number") && /(agenda.*id|agendas.*id|^id$)/i.test(k)) {
              const s = String(v).trim();
              if (s.length > 0) out.add(s);
            }
          }
        };
        walk(obj);
        return [...out];
      }
      agendaIds = collectAgendaIds(agData);
      result.agendas = agendaIds.length;
    }
    console.log(`  🗓  getagendas/ → ${agRaw.length}B | ${result.agendas} agendas: ${agendaIds.slice(0, 5).join(", ")}`);

    // 6. Scan datetime/ multi-mois avec maxDays dynamique
    const now = new Date();
    let globalMaxDays: Date | null = null;
    let totalSlots = 0;
    let monthsScanned = 0;
    const MAX_MONTHS = 8;
    let consecutiveEmpty = 0;

    for (let mo = 0; mo < MAX_MONTHS; mo++) {
      const tgt = new Date(now.getFullYear(), now.getMonth() + mo, 1);
      const start = tgt.toISOString().slice(0, 10);
      const end = new Date(tgt.getFullYear(), tgt.getMonth() + 1, 0).toISOString().slice(0, 10);

      const extra: Record<string, string> = {
        "services[]": targetService,
        start, end,
        selectedPeople: "1",
      };
      if (agendaIds[0]) extra["agendas[]"] = agendaIds[0];

      const dtUrl = session.bookititState
        ? makeBookititUrl(session, "datetime/", extra)
        : null;

      if (!dtUrl) break;

      const dtRes = await spainCfFetch(dtUrl, session, { headers });
      const dtRaw = dtRes?.ok ? await dtRes.text() : "";
      const dtData = parseJsonpPayload(dtRaw);
      const slots = countSlots(dtData);
      totalSlots += slots;
      monthsScanned++;

      const mDaysRaw: string = (dtData as any)?.maxDays ?? "";
      if (mDaysRaw && /^\d{4}-\d{2}-\d{2}$/.test(mDaysRaw)) {
        const mDate = new Date(mDaysRaw + "T23:59:59");
        if (!globalMaxDays || mDate > globalMaxDays) {
          globalMaxDays = mDate;
          result.maxDays = mDaysRaw;
        }
      }

      console.log(
        `  📅 datetime/ ${start}→${end} → ${dtRaw.length}B | ` +
        `${slots} créneaux${mDaysRaw ? ` | maxDays=${mDaysRaw}` : ""}`,
      );

      if (slots === 0) consecutiveEmpty++;
      else consecutiveEmpty = 0;

      if (mo >= 1 && globalMaxDays) {
        const next = new Date(now.getFullYear(), now.getMonth() + mo + 1, 1);
        if (next > globalMaxDays) {
          console.log(`  ⏹ maxDays atteint (${globalMaxDays.toISOString().slice(0, 10)}) — arrêt`);
          break;
        }
      }
      if (!globalMaxDays && consecutiveEmpty >= 3) {
        console.log(`  ⏹ 3 mois vides sans maxDays — arrêt sécurité`);
        break;
      }
    }

    result.totalSlots = totalSlots;
    result.monthsScanned = monthsScanned;
    result.success = true;

    console.log(
      `  ✅ Scan terminé: ${totalSlots} créneaux sur ${monthsScanned} mois | ` +
      `maxDays=${result.maxDays || "N/A"}`,
    );
  } catch (err) {
    result.error = String(err);
    console.error(`  ❌ Erreur: ${err}`);
  }

  result.durationMs = Date.now() - t0;
  return result;
}

async function main() {
  console.log("═".repeat(70));
  console.log("🇪🇸 SPAIN HTTP-PUR MULTIPORTAL SMOKE TEST");
  console.log(`   Mode: ${process.env.SPAIN_SESSION_MODE ?? "(défaut)"}`);
  console.log(`   Proxy résidentiel: ${process.env.SPAIN_RESIDENTIAL_PROXY_URL ? "✅ défini" : "❌ manquant"}`);
  console.log(`   CapSolver: ${process.env.CAPSOLVER_API_KEY ? "✅ défini" : "❌ manquant"}`);
  console.log("═".repeat(70));

  const portals = [
    { name: "São Paulo (Saopolo)", url: SAOPOLO_PORTAL_URL },
    { name: "Cuba / LMD",         url: CUBA_LMD_PORTAL_URL },
    { name: "Kinshasa (RDC)",     url: KINSHASA_PORTAL_URL },
  ];

  const results: PortalTestResult[] = [];
  for (const { name, url } of portals) {
    // Invalider la session entre portails pour forcer un nouveau PHPSESSID
    const { invalidateSpainCfSession } = await import("../spain-soax-solver.js");
    invalidateSpainCfSession();
    const r = await testPortal(name, url);
    results.push(r);
  }

  // Résumé final
  console.log(`\n${"═".repeat(70)}`);
  console.log("📊 RÉSUMÉ");
  console.log("═".repeat(70));
  for (const r of results) {
    const status = r.success ? "✅" : "❌";
    console.log(
      `${status} ${r.portalName.padEnd(25)} ` +
      `Session=${r.sessionEstablished ? "✅" : "❌"} ` +
      `Svc=${r.services} Ag=${r.agendas} ` +
      `Slots=${r.totalSlots} ` +
      `Mois=${r.monthsScanned} ` +
      `maxDays=${r.maxDays || "N/A"} ` +
      `(${Math.round(r.durationMs / 1000)}s)` +
      (r.error ? ` ⚠️ ${r.error}` : ""),
    );
  }
  console.log("═".repeat(70));
}

main().catch(console.error);
