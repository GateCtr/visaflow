/**
 * test-saopolo-impit-mode.ts — Teste le flux "ancien" via injection Turnstile (impit).
 *
 * Contrairement à AntiCloudflareTask (CapSolver résout TOUT → cf_clearance lié à SON TLS
 * → 403 au GET suivant), ce flux utilise solveViaImpit() :
 *   probe impit → résout le challenge AVEC le même impit (token Turnstile proxyless injecté,
 *   ou JSD) → cf_clearance lié à NOTRE TLS impit → GET post-clearance accepté → PHPSESSID.
 *
 * On vérifie précisément : le GET post-clearance passe-t-il (PHPSESSID obtenu) ?
 * Si oui, on enchaîne datetime/ directement (flux réduit décrit par l'utilisateur).
 *
 * USAGE :
 *   npx tsx src/scripts/test-saopolo-impit-mode.ts [PROXY_URL]
 *   DECODO_PROXY_FILE=./cev-decodo-proxies.csv npx tsx src/scripts/test-saopolo-impit-mode.ts
 */

import "dotenv/config";
import { solveViaImpit, getSpainImpitInstance } from "../_legacy_spain-impit-session.js";
import {
  getDecodoPoolSize,
  getDecodoProxyForIndex,
} from "../spain-decodo-pool.js";
import {
  buildDynamicSession,
  callDirect,
  CALL_DIRECT_NETWORK_ERROR,
} from "../spain-bookitit-direct.js";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.argv[2] || "";
const MAX_ROTATIONS = Number(process.env.SAOPOLO_MAX_ROTATIONS ?? 4);

function log(msg: string): void {
  console.log(`[test-saopolo-impit] ${msg}`);
}

function addStickyId(url: string): string {
  const sid = Math.random().toString(36).slice(2, 10);
  if (!url || !url.includes("sessionduration")) return url;
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username);
    const stickyUser = user.includes("-session-")
      ? user.replace(/-session-[^-]+/, `-session-${sid}`)
      : user.replace(/(.*?)(-sessionduration-.*)$/, `$1-session-${sid}$2`);
    u.username = encodeURIComponent(stickyUser);
    return u.toString();
  } catch { return url; }
}

async function main(): Promise<void> {
  log(`Portal   : Sao Paulo`);
  log(`CapSolver: ${CAPSOLVER_API_KEY ? "✅" : "❌ (requis pour Turnstile token)"}`);
  if (!CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }

  const useArgvProxy = Boolean(PROXY_URL);
  const poolSize = getDecodoPoolSize();
  const maxAttempts = useArgvProxy ? 1 : Math.min(MAX_ROTATIONS, poolSize || 1);
  if (!useArgvProxy && poolSize === 0) {
    console.error("❌ Aucun proxy : passe une URL en argument ou configure DECODO_PROXY_FILE");
    process.exit(1);
  }
  log(useArgvProxy
    ? `Mode     : proxy imposé (argv) — pas de rotation`
    : `Mode     : rotation pool — ${poolSize} IP(s), max ${maxAttempts} tentative(s)`);

  let session = null;
  let poolIdx = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let proxyForAttempt: string;
    if (useArgvProxy) {
      proxyForAttempt = addStickyId(PROXY_URL);
    } else {
      const raw = getDecodoProxyForIndex(poolIdx);
      if (!raw) { log(`❌ Plus d'entrée pool à l'index ${poolIdx}`); break; }
      poolIdx++;
      proxyForAttempt = addStickyId(raw);
    }
    const maskedP = proxyForAttempt.replace(/:([^:@]+)@/, ":***@").slice(0, 70);
    log(`\n🔑 Tentative ${attempt}/${maxAttempts} — proxy: ${maskedP}…`);

    session = await solveViaImpit(SAOPOLO_URL.split("#")[0], proxyForAttempt);
    if (session) {
      const php = session.allCookies.find((c) => c.name === "PHPSESSID");
      log(`✅ solveViaImpit OK — cf_clearance=${session.cfClearance ? session.cfClearance.length + "B" : "∅"} | PHPSESSID=${php ? "✅" : "⚠️ absent"}`);
      if (php) break; // succès complet : clearance accepté + PHPSESSID
      log(`   ⚠️ PHPSESSID absent → rotation`);
      session = null;
    } else {
      log(`⚠️ solveViaImpit échoué → rotation`);
    }
    if (useArgvProxy) break;
  }

  if (!session) { console.error("\n❌ Aucune session impit valide obtenue (toutes rotations épuisées)"); process.exit(1); }

  // ── Flux réduit : enchaîner directement datetime/ ───────────────────────────
  log(`\n═══ FLUX RÉDUIT : datetime/ direct (sans POST token ni /main/) ═══`);
  const impit = getSpainImpitInstance();
  if (!impit) { console.error("❌ Instance impit introuvable"); process.exit(1); }

  const ds = buildDynamicSession(session);
  if (!ds) { console.error("❌ buildDynamicSession échoué"); process.exit(1); }

  // getservices → agendas → datetime
  const svcPayload = await callDirect(ds, "getservices/") as any;
  const services: Array<{ id: string; name: string }> = svcPayload?.Services ?? svcPayload?.services ?? [];
  log(`svc/ → ${services.length} services | AllowAppointment=${svcPayload?.AllowAppointment}`);
  if (!services.length) { log("⚠️ Pas de services — session peut-être incomplète"); process.exit(0); }

  const bestSvc = services.find(s => (s.name ?? "").replace(/<[^>]*>/g, "").trim().length > 0) ?? services[0];
  log(`Service  : ${bestSvc.id}`);

  const agPayload = await callDirect(ds, "getagendas/", { "services[]": bestSvc.id, selectedPeople: "1" }) as any;
  const agendas = agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = agendas.find((a: any) => a?.id)?.id ?? "";
  log(`ag/ → ${JSON.stringify(agPayload ?? "").length}B | agendaId="${agendaId}"`);
  if (!agendaId) { log("⚠️ Pas d'agenda (pas de créneaux en ce moment) — session OK quand même"); process.exit(0); }

  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  const dtResult = await callDirect(ds, "datetime/", {
    "services[]": bestSvc.id,
    "agendas[]": agendaId,
    start: startStr,
    end: endStr,
    selectedPeople: "1",
  });
  const isNetErr = dtResult === CALL_DIRECT_NETWORK_ERROR;
  const bytes = isNetErr ? -1 : JSON.stringify(dtResult ?? "").length;
  log(`datetime/ → ${isNetErr ? "❌ NET_ERR" : bytes <= 2 ? "❌ 0B" : "✅ OK"} | ${bytes}B`);

  log(`\n═══ RÉSULTAT ═══`);
  log(`Si datetime/ répond (>2B) → flux impit (injection Turnstile) FONCTIONNEL via ce proxy`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
