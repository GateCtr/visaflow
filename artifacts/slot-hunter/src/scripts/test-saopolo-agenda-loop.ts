/**
 * test-saopolo-agenda-loop.ts — Teste si getagendas/ retourne toujours une
 * réponse valide quand on le boucle N fois sur le même PHPSESSID (Sao Paulo).
 *
 * Sao Paulo a des créneaux → agenda non-vide → on peut vérifier si la réponse
 * reste stable ou passe à 0B après le premier appel.
 *
 * USAGE :
 *   npx tsx src/scripts/test-saopolo-agenda-loop.ts [PROXY_URL]
 */

import "dotenv/config";
import { Impit } from "impit";
import { initWorkerSession } from "../spain-soax-solver.js";
import {
  buildDynamicSession,
  callDirect,
  CALL_DIRECT_NETWORK_ERROR,
} from "../spain-bookitit-direct.js";
import {
  getDecodoPoolSize,
  getDecodoProxyForIndex,
} from "../spain-decodo-pool.js";

const SAOPOLO_URL = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const CAPSOLVER_API_KEY = process.env.CAPSOLVER_API_KEY ?? "";
const PROXY_URL = process.argv[2] || (process.env.SPAIN_ISP_PROXY_URL ?? process.env.SPAIN_RESIDENTIAL_PROXY_URL ?? "");
const LOOP_COUNT = 5;
// Nombre max de proxies à essayer sur un échec portail (403 / token absent).
// Si un argv proxy est fourni, on ne rotate pas (une seule IP imposée).
const MAX_PROXY_ROTATIONS = Number(process.env.SAOPOLO_MAX_ROTATIONS ?? 6);

function log(msg: string): void {
  console.log(`[test-saopolo-loop] ${msg}`);
}

async function main(): Promise<void> {
  log(`Portal  : Sao Paulo`);
  log(`Proxy   : ${PROXY_URL ? PROXY_URL.replace(/:([^:@]+)@/, ":***@").slice(0, 60) : "(direct)"}`);
  log(`CapSolver: ${CAPSOLVER_API_KEY ? "✅" : "❌"}`);
  log(`Loops   : ${LOOP_COUNT}`);

  if (!CAPSOLVER_API_KEY) { console.error("❌ CAPSOLVER_API_KEY requis"); process.exit(1); }

  const addStickyId = (url: string): string => {
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
  };

  // ── 1. Init session CF (avec rotation de proxy sur 403 / token absent) ───────
  log("\n═══ INIT SESSION CF ═══");

  // Mode A : un proxy est imposé en argument → une seule IP, pas de rotation.
  // Mode B : aucun argv → on puise dans le pool thordata (decodo-proxies.csv) et on
  //          rotate sur chaque échec "portal" (403/token absent), en flaggant l'IP morte.
  const useArgvProxy = Boolean(PROXY_URL);
  const poolSize = getDecodoPoolSize();
  const maxAttempts = useArgvProxy ? 1 : Math.min(MAX_PROXY_ROTATIONS, poolSize || 1);

  if (!useArgvProxy && poolSize === 0) {
    console.error("❌ Aucun proxy : passe une URL en argument ou configure decodo-proxies.csv");
    process.exit(1);
  }
  log(useArgvProxy
    ? `Mode    : proxy imposé (argv) — pas de rotation`
    : `Mode    : rotation pool thordata — ${poolSize} IP(s), max ${maxAttempts} tentative(s)`);

  let initResult: Awaited<ReturnType<typeof initWorkerSession>> = null;
  // Index de départ : aléatoire par défaut (évite de re-taper toujours les mêmes
  // premières IP, qui ont pu être grillées lors de runs précédents). Override via
  // SAOPOLO_START_INDEX pour un départ déterministe.
  let poolIdx = process.env.SAOPOLO_START_INDEX
    ? Number(process.env.SAOPOLO_START_INDEX)
    : (poolSize > 0 ? Math.floor(Math.random() * poolSize) : 0);
  if (!useArgvProxy) log(`StartIdx: ${poolIdx} (pool ${poolSize})`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Sélection du proxy pour cette tentative.
    // NB thordata : toutes les entrées partagent le même host:port — l'identité
    // d'exit IP tient au `sessid` dans le username, PAS au host:port. On ne peut donc
    // PAS utiliser la blacklist du pool (clé host:port) : flagger une entrée les
    // blacklisterait toutes. On parcourt les entrées brutes par index (chaque index =
    // sessid distinct = exit IP distincte) et on y ajoute un -session-{sid} aléatoire.
    let proxyForAttempt: string;
    if (useArgvProxy) {
      proxyForAttempt = addStickyId(PROXY_URL);
    } else {
      const raw = getDecodoProxyForIndex(poolIdx);
      if (!raw) {
        console.error(`[test-saopolo-loop] ❌ Plus d'entrée dans le pool à l'index ${poolIdx}`);
        break;
      }
      poolIdx++; // avancer pour la prochaine rotation (sessid suivant)
      proxyForAttempt = addStickyId(raw);
    }

    const maskedP = proxyForAttempt.replace(/:([^:@]+)@/, ":***@").slice(0, 70);
    log(`🔑 Tentative ${attempt}/${maxAttempts} — proxy: ${maskedP}…`);

    // onFailure nous indique la nature de l'échec pour décider de rotater ou non.
    // SAOPOLO_REDUCED=1 → flux RÉDUIT (solve → GET widget → datetime), on SAUTE POST token + /main/.
    const reduced = process.env.SAOPOLO_REDUCED === "1";
    let failureKind: string | undefined;
    initResult = await initWorkerSession(
      proxyForAttempt,
      SAOPOLO_URL.split("#")[0],
      CAPSOLVER_API_KEY,
      undefined,
      (kind) => { failureKind = kind; },
      reduced,
    );

    if (initResult) break; // ✅ succès

    // Échec : décider si on rotate.
    //  - "portal"  → 403 / token absent : CF a rejeté le clearance sur cette IP → rotate + flag
    //  - "proxy"   → tunnel/CONNECT KO : IP morte → rotate + flag
    //  - "captcha" → CapSolver KO : ne vient pas de l'IP, inutile de rotater
    log(`⚠️ Échec init (kind=${failureKind ?? "?"})`);
    if (useArgvProxy) break; // proxy imposé : pas de rotation
    if (failureKind === "captcha") {
      log(`   → échec CapSolver (non lié au proxy) — arrêt`);
      break;
    }
    if (failureKind === "portal" || failureKind === "proxy") {
      // Pas de flagDecodoIp ici (clé host:port → blacklisterait tout le pool thordata).
      // On avance simplement sur l'entrée suivante = nouveau sessid = nouvelle exit IP.
      log(`   → rotation vers la session (sessid) suivante`);
      await sleep(500);
      continue;
    }
    // kind inconnu : on tente quand même la suivante
    continue;
  }

  if (!initResult) { console.error("❌ initWorkerSession échoué (toutes rotations épuisées)"); process.exit(1); }
  const { session } = initResult;
  log(`✅ Session établie — /main/ ${session.prefetchedMainHtml?.length ?? 0}B`);

  // ── 2. Premier cycle complet ────────────────────────────────────────────────
  log("\n═══ CYCLE COMPLET INITIAL (cfg → svc → ag → dt) ═══");
  const ds = buildDynamicSession(session);
  if (!ds) { console.error("❌ buildDynamicSession échoué"); process.exit(1); }

  const cfgPayload = await callDirect(ds, "getwidgetconfigurations/");
  log(`cfg/ → ${JSON.stringify(cfgPayload ?? "").length}B`);

  const svcPayload = await callDirect(ds, "getservices/") as any;
  const services: Array<{ id: string; name: string }> = svcPayload?.Services ?? svcPayload?.services ?? [];
  log(`svc/ → ${services.length} services | AllowAppointment=${svcPayload?.AllowAppointment}`);

  const bestSvc = services.find(s => (s.name ?? "").replace(/<[^>]*>/g, "").trim().length > 0) ?? services[0];
  if (!bestSvc) { console.error("❌ Aucun service trouvé"); process.exit(1); }
  log(`Service cible: ${bestSvc.id} "${(bestSvc.name ?? "").replace(/<[^>]*>/g, "").trim().slice(0, 40)}"`);

  const agPayload = await callDirect(ds, "getagendas/", {
    "services[]": bestSvc.id,
    selectedPeople: "1",
  }) as any;
  const agendas = agPayload?.Agendas ?? agPayload?.agendas ?? [];
  const agendaId = agendas.find((a: any) => a?.id)?.id ?? "";
  log(`ag/ initial → ${JSON.stringify(agPayload ?? "").length}B | agendaId="${agendaId}" | agendas=${agendas.length}`);

  if (!agendaId) {
    log("⚠️ Pas d'agenda — Sao Paulo n'a peut-être pas de créneaux en ce moment");
    log("   Test non concluant — réessayer quand des créneaux sont disponibles");
    process.exit(0);
  }

  // ── 3. Boucle : rappeler getagendas/ N fois ────────────────────────────────
  log(`\n═══ BOUCLE getagendas/ × ${LOOP_COUNT} (même PHPSESSID) ═══`);
  for (let i = 1; i <= LOOP_COUNT; i++) {
    await sleep(2000); // pause 2s entre appels

    const agResult = await callDirect(ds, "getagendas/", {
      "services[]": bestSvc.id,
      selectedPeople: "1",
    }) as any;

    const isNetErr = agResult === CALL_DIRECT_NETWORK_ERROR;
    const bytes = isNetErr ? -1 : JSON.stringify(agResult ?? "").length;
    const ags = isNetErr ? [] : (agResult?.Agendas ?? agResult?.agendas ?? []);
    const aid = ags.find((a: any) => a?.id)?.id ?? "";

    const status = isNetErr ? "❌ NET_ERR" : bytes <= 2 ? "❌ 0B" : aid ? "✅ OK" : "⚠️ vide";
    log(`  Loop ${i}/${LOOP_COUNT}: ${status} | ${bytes}B | agendaId="${aid}"`);
  }

  // ── 4. Boucle : rappeler datetime/ N fois ──────────────────────────────────
  log(`\n═══ BOUCLE datetime/ × ${LOOP_COUNT} (même PHPSESSID, agenda=${agendaId}) ═══`);
  const now = new Date();
  const startStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const endStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  for (let i = 1; i <= LOOP_COUNT; i++) {
    await sleep(2000);

    const dtResult = await callDirect(ds, "datetime/", {
      "services[]": bestSvc.id,
      "agendas[]": agendaId,
      start: startStr,
      end: endStr,
      selectedPeople: "1",
    });

    const isNetErr = dtResult === CALL_DIRECT_NETWORK_ERROR;
    const bytes = isNetErr ? -1 : JSON.stringify(dtResult ?? "").length;
    const status = isNetErr ? "❌ NET_ERR" : bytes <= 2 ? "❌ 0B" : "✅ OK";
    log(`  Loop ${i}/${LOOP_COUNT}: ${status} | ${bytes}B`);
  }

  log("\n═══ RÉSULTAT ═══");
  log("Si getagendas/ retourne 0B après le 1er appel → règle §9 confirmée (one-shot)");
  log("Si getagendas/ continue de répondre → on peut boucler librement");
  log("Si datetime/ continue de répondre → boucle datetime seule est safe");
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("❌ Erreur fatale:", err);
  process.exit(1);
});
