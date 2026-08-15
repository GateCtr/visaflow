/**
 * Test unitaire de initWorkerSession (la fonction standalone du worker).
 * Prouve que le worker path établit une session complète sans globals.
 */
import "dotenv/config";
import { initDecodoPool, getDecodoProxyForIndex } from "../spain-decodo-pool.js";

// Identique à addStickySession dans spain-dossier-worker.ts
function addStickySession(url: string, sid: string): string {
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
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initWorkerSession } from "../spain-soax-solver.js";

const SAOPOLO = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";

async function main() {
  console.log("=== TEST initWorkerSession (path worker per-dossier) ===");

  await initSpainRedis();
  await initDecodoPool();

  // Simuler exactement ce que runDossierWorker fait :
  // 1. Prendre port 0 (10001) + sticky session
  const proxyBase = getDecodoProxyForIndex(0) ?? "";
  const stickyId  = Math.random().toString(36).slice(2, 10);
  const stickyProxy = addStickySession(proxyBase, stickyId);
  console.log(`\n→ Proxy : ${stickyProxy.replace(/:([^:@/]+)@/, ":***@").slice(0, 70)}…`);
  console.log(`→ URL   : ${SAOPOLO}`);
  console.log(`→ Clé   : ${CAPSOLVER_KEY ? "✅" : "❌ MANQUANTE"}\n`);

  if (!CAPSOLVER_KEY) { console.error("CAPSOLVER_API_KEY manquante"); process.exit(1); }

  const t0 = Date.now();
  const result = await initWorkerSession(stickyProxy, SAOPOLO, CAPSOLVER_KEY);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  if (!result) {
    console.error(`\n❌ initWorkerSession retourne null (${elapsed}s)`);
    process.exit(1);
  }

  const { session, impit } = result;
  const php = session.allCookies.find(c => c.name === "PHPSESSID");
  const cf  = session.allCookies.find(c => c.name === "cf_clearance");

  console.log(`\n=== RÉSULTAT (${elapsed}s) ===`);
  console.log(`cf_clearance     : ${cf  ? cf.value.slice(0, 40) + "…" : "❌ ABSENT"}`);
  console.log(`PHPSESSID        : ${php ? "✅ " + php.value.slice(0, 20) + "…" : "❌ ABSENT"}`);
  console.log(`soaxProxyUrl     : ${session.soaxProxyUrl?.replace(/:([^:@/]+)@/, ":***@")}`);
  console.log(`userAgent        : ${session.userAgent?.slice(0, 60)}`);
  console.log(`_ownImpit        : ${session._ownImpit === impit ? "✅ même instance" : "❌ instances différentes!"}`);
  console.log(`bookititState    : ${session.bookititState ? JSON.stringify({
    srvsrc:    session.bookititState.srvsrc,
    version:   session.bookititState.version,
    publickey: session.bookititState.publickey?.slice(0, 12) + "…",
    jqCallback: session.bookititState.jqCallback?.slice(0, 25) + "…",
  }, null, 2) : "❌ ABSENT"}`);
  console.log(`/main/ prefetch  : ${session.prefetchedMainHtml ? session.prefetchedMainHtml.length + "B ✅" : "❌ ABSENT"}`);

  const ok = !!php && !!cf && !!session.bookititState && !!session.prefetchedMainHtml;
  console.log(`\n${ok ? "🎉 SUCCÈS — worker path 100% fonctionnel" : "⚠️ PARTIEL — vérifier les ❌"}`);
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
