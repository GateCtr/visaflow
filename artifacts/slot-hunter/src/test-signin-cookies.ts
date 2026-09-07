/**
 * test-signin-cookies.ts — Inspecte les Set-Cookie et corps bruts de getsigninfields/ et signin/
 *
 * OBJECTIF
 *   Comprendre pourquoi signin/ renvoie 0B sur Kinshasa mais 180B (rejet clair) sur
 *   Saopola, alors que c'est le MÊME serveur Bookitit. Hypothèse : getsigninfields/
 *   pose un cookie/nonce de formulaire que signin/ doit renvoyer. On dumpe donc les
 *   headers Set-Cookie et le corps brut de chaque appel, sans passer par callDirect
 *   (qui masque les headers).
 *
 *   Une seule session, un seul créneau bookable. Credentials FAUX (aucun booking réel).
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   npx tsx src/test-signin-cookies.ts
 *   SIGNIN_PORTAL=<url widget>   # défaut Saopola (a des créneaux). Kinshasa = 25028fcd...
 */

import "dotenv/config";

import { initWorkerSession } from "./spain-soax-solver.js";
import {
  initPhpState,
  scanDatetimeDirect,
  type SpainDossierConfig,
} from "./spain-dossier-worker.js";
import {
  buildDynamicSession,
  makeDirectUrl,
  makeDirectHeaders,
  parseDirectJsonp,
  type DynamicSession,
} from "./spain-bookitit-direct.js";
import { getDecodoPoolSize, getDecodoProxyForIndex } from "./spain-decodo-pool.js";

const SAOPOLA = "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const PORTAL_URL = process.env.SIGNIN_PORTAL ?? SAOPOLA;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";

function sep(l: string): void {
  console.log("\n" + "═".repeat(72) + `\n  ${l}\n` + "═".repeat(72));
}

/** Appel brut d'un endpoint Bookitit — expose status, Set-Cookie et corps. */
async function rawCall(
  ds: DynamicSession,
  endpoint: string,
  extra: Record<string, string>,
): Promise<{ status: number; setCookie: string; body: string; parsed: unknown }> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const headers = makeDirectHeaders(ds);
  const res = await (ds.impit.fetch(url, { headers } as any) as unknown as Promise<Response>);
  const setCookie = (res.headers as any).get("set-cookie") ?? "";
  const body = await res.text();
  return { status: res.status, setCookie, body, parsed: parseDirectJsonp(body) };
}

function proxy0(): string {
  const size = getDecodoPoolSize();
  if (size > 0) return getDecodoProxyForIndex(0) ?? "";
  return process.env.DECODO_PROXY_URL ?? "";
}

async function main(): Promise<void> {
  sep("TEST SIGN-IN COOKIES — inspection Set-Cookie getsigninfields/ + signin/");
  console.log(`  Portail  : ${PORTAL_URL}`);
  console.log(`  Proxy    : ${getDecodoPoolSize() > 0 ? `pool CSV (${getDecodoPoolSize()} IP)` : "DECODO_PROXY_URL"}`);
  console.log(`  CapSolver: ${CAPSOLVER_KEY ? "✅" : "❌"}`);

  const config: SpainDossierConfig = {
    id: "signin-cookie-test",
    applicantName: "SIGNIN_COOKIE_TEST",
    visaType: "visa",
    login: "00000001",
    password: "FakePass_Test",
    applicationId: "signin-cookie",
    otpChannel: "manual",
    portalUrl: PORTAL_URL,
  };
  const tag = "[SIGNIN-TEST]";

  // 1. Session CF + PHP init
  const res = await initWorkerSession(proxy0(), PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res) { console.error("❌ initWorkerSession échoué"); process.exit(1); }
  const phpState = await initPhpState(res.session, config, tag);
  if (!phpState) { console.error("❌ initPhpState échoué"); process.exit(1); }

  // 2. Scan → trouver un créneau bookable
  sep("SCAN → sélection d'un créneau bookable");
  const scan = await scanDatetimeDirect(phpState, config, tag);
  if (scan.status !== "found" || !scan.slots?.length) {
    console.log(`  ℹ️  Aucun créneau (status=${scan.status}). Réessaie quand des créneaux existent.`);
    process.exit(0);
  }
  const target = scan.slots.find((s) => s.freeslots > 0);
  if (!target) { console.log("  ℹ️  Aucune place libre."); process.exit(0); }
  console.log(`  🎯 Créneau : ${target.date} ${target.time} (${target.freeslots} place) agenda=${target.agendaId ?? "?"}`);

  const ds = scan.ds ?? phpState.ds;
  const serviceId = phpState.bestServiceId;
  const base: Record<string, string> = {
    "services[]": serviceId,
    date: target.date,
    time: target.time,
    selectedPeople: "1",
  };
  if (target.agendaId) base["agendas[]"] = target.agendaId;

  // 3. État du jar AVANT booking
  sep("JAR AVANT getsigninfields/");
  console.log("  cookies:", Object.keys(ds.jar).map((k) => `${k}=${String(ds.jar[k]).slice(0, 12)}…`).join("  "));

  // 4. getsigninfields/ — appel brut
  sep("getsigninfields/ (brut)");
  const gsf = await rawCall(ds, "getsigninfields/", {
    "services[]": base["services[]"],
    "agendas[]": base["agendas[]"] ?? "",
    date: base.date,
    time: base.time,
    selectedPeople: base.selectedPeople,
  });
  console.log(`  HTTP ${gsf.status} | corps ${gsf.body.length}B`);
  console.log(`  Set-Cookie: ${gsf.setCookie || "(aucun)"}`);
  console.log(`  Corps (300 premiers car.): ${gsf.body.slice(0, 300)}`);
  // Extraire les noms de champs déclarés par le formulaire (indices : name="...", logintype, captcha)
  const fieldNames = [...gsf.body.matchAll(/name=\\?["']([^"'\\]+)\\?["']/g)].map((m) => m[1]);
  if (fieldNames.length) console.log(`  Champs détectés: ${[...new Set(fieldNames)].join(", ")}`);
  if (/captcha/i.test(gsf.body)) console.log("  ⚠️  'captcha' présent dans getsigninfields/ !");
  if (/logintype/i.test(gsf.body)) {
    const lt = [...gsf.body.matchAll(/logintype["'\s:=]+([a-z]+)/gi)].map((m) => m[1]);
    console.log(`  logintype mentionné: ${[...new Set(lt)].join(", ") || "(oui, valeur non extraite)"}`);
  }

  // 5. JAR APRÈS getsigninfields/ (le worker de prod ne merge PAS ces cookies)
  sep("JAR APRÈS getsigninfields/ (inchangé par le code prod)");
  console.log("  cookies:", Object.keys(ds.jar).map((k) => `${k}=${String(ds.jar[k]).slice(0, 12)}…`).join("  "));
  console.log("  → Si Set-Cookie ci-dessus contient un nouveau cookie/nonce, il N'EST PAS renvoyé à signin/.");

  // 6. signin/ — appel brut (exactement le payload prod)
  sep("signin/ (brut)");
  const signin = await rawCall(ds, "signin/", {
    ...base,
    logintype: "document",
    login: config.login,
    password: config.password,
    comments: "",
  });
  console.log(`  HTTP ${signin.status} | corps ${signin.body.length}B`);
  console.log(`  Set-Cookie: ${signin.setCookie || "(aucun)"}`);
  console.log(`  Corps (500 premiers car.): ${signin.body.slice(0, 500)}`);

  // 7. Verdict
  sep("VERDICT");
  if (signin.body.length === 0) {
    console.log("  ❌ signin/ → 0B (vide). Le serveur rejette AVANT de traiter.");
    if (gsf.setCookie) {
      console.log("  🔎 getsigninfields/ a posé un Set-Cookie NON renvoyé à signin/ → piste nonce/cookie de formulaire.");
    }
  } else {
    console.log(`  ✅ signin/ a répondu ${signin.body.length}B — le serveur traite la requête (rejet credentials attendu).`);
    console.log("  → Sur ce portail, le flux getsigninfields/→signin/ fonctionne SANS merge de cookie.");
  }
  console.log();
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
