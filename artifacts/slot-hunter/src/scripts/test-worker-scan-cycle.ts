/**
 * test-worker-scan-cycle.ts
 *
 * Reproduit exactement workerScanCycle :
 *   1. initWorkerSession (probe CF + solve CapSolver + PHPSESSID + /main/)
 *   2. Build cookieStr (GA synthétiques + PHPSESSID + cf_clearance)
 *   3. confirmSlotsViaDatetime → getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/
 *
 * Usage: node_modules/.bin/tsx src/scripts/test-worker-scan-cycle.ts [PORTAL_URL]
 */
import "dotenv/config";
import { initDecodoPool, getDecodoProxyForIndex } from "../spain-decodo-pool.js";
import { initSpainRedis } from "../spain-redis-persistence.js";
import { initWorkerSession } from "../spain-soax-solver.js";
import { confirmSlotsViaDatetime } from "../spain-http-scanner.js";
import type { SpainCfSession } from "../spain-soax-solver.js";

const PORTAL_URL   = process.argv[2] ?? "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";

const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function L(level: string, msg: string) {
  const icon: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶ " };
  console.log(`[${ts()}] ${icon[level] ?? "  "} ${msg}`);
}

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

function buildCookieStr(session: SpainCfSession): string {
  const browserCookies = session.allCookies.filter((c) => c.name !== "cf_clearance");
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga")) {
    const seed = session.createdAt;
    browserCookies.push({
      name: "_ga",
      value: `GA1.1.${100_000_000 + (seed % 900_000_000)}.${Math.floor(seed / 1000) - 15 * 24 * 3600}`,
    });
  }
  if (session.source !== "playwright" && !browserCookies.some((c) => c.name === "_ga_F3TYSDL945")) {
    const ts2 = String(Math.floor(session.createdAt / 1000));
    browserCookies.push({ name: "_ga_F3TYSDL945", value: `GS2.1.s${ts2}$o1$g0$t${ts2}$j60$l0$h0` });
  }
  return [
    ...browserCookies.map((c) => `${c.name}=${c.value}`),
    ...(session.cfClearance ? [`cf_clearance=${session.cfClearance}`] : []),
  ].join("; ");
}

async function main() {
  console.log("=== test-worker-scan-cycle : flux complet workerScanCycle ===\n");

  if (!CAPSOLVER_KEY) { console.error("❌ CAPSOLVER_API_KEY manquante"); process.exit(1); }

  L("STEP", "initSpainRedis + initDecodoPool");
  await initSpainRedis();
  await initDecodoPool();

  const proxyBase  = getDecodoProxyForIndex(0) ?? "";
  const stickyProxy = addStickySession(proxyBase, Math.random().toString(36).slice(2, 10));
  L("INFO", `Proxy : ${stickyProxy.replace(/:([^:@/]+)@/, ":***@").slice(0, 70)}…`);
  L("INFO", `Portal: ${PORTAL_URL}`);

  // ── 1. initWorkerSession ──────────────────────────────────────────────────────
  L("STEP", "initWorkerSession…");
  const init = await initWorkerSession(stickyProxy, PORTAL_URL, CAPSOLVER_KEY);
  if (!init) { L("ERR", "initWorkerSession → null"); process.exit(1); }
  const { session } = init;

  const php = session.allCookies.find(c => c.name === "PHPSESSID");
  const cf  = session.allCookies.find(c => c.name === "cf_clearance");
  L("OK",   `PHPSESSID : ${php ? php.value.slice(0, 20) + "…" : "❌ ABSENT"}`);
  L("OK",   `cf_clearance : ${cf  ? cf.value.slice(0, 30) + "…" : "❌ ABSENT"}`);
  L("INFO", `bookititState.publickey : ${session.bookititState?.publickey?.slice(0, 16)}…`);
  L("INFO", `prefetchedMainHtml : ${session.prefetchedMainHtml?.length ?? 0}B`);

  // ── 2. Params — même logique que workerScanCycle ─────────────────────────────
  const bookititState = session.bookititState!;
  const publickey = bookititState.publickey;
  const referer   = bookititState.widgetUrl;
  const cookieStr = buildCookieStr(session);
  const mainHtml  = session.prefetchedMainHtml ?? "";
  session.prefetchedMainHtml = undefined;

  L("INFO", `cookieStr (64c) : ${cookieStr.slice(0, 64)}…`);
  L("INFO", `referer         : ${referer}`);

  // ── 3. confirmSlotsViaDatetime ───────────────────────────────────────────────
  L("STEP", "confirmSlotsViaDatetime → getwidgetconfigurations/ → getservices/ → getagendas/ → datetime/…");
  const result = await confirmSlotsViaDatetime(session, mainHtml, publickey, cookieStr, referer);

  console.log("\n" + "═".repeat(72));
  if (!result) {
    L("INFO", "→ null (pas de créneau disponible) ✅ flow complet OK");
    process.exit(0);
  }
  if (result === "ajax_unavailable") {
    L("WARN", "→ ajax_unavailable (session CF invalide ou 0B)");
    process.exit(1);
  }

  const slots = result.allSlots ?? [];
  L("OK", `→ ${slots.length} créneau(x) | service: "${result.serviceName}" (${result.serviceId})`);
  for (const s of slots.slice(0, 5)) {
    console.log(`   📅 ${s.date} ${s.time}  agendaId=${s.agendaId ?? "—"}  freeslots=${s.freeslots}`);
  }
  if (slots.length > 5) console.log(`   … +${slots.length - 5} autres`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
