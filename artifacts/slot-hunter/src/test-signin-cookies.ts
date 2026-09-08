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
  callDirect,
  CALL_DIRECT_NETWORK_ERROR,
  CALL_DIRECT_HTTP_OVERLOAD,
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
): Promise<{ status: number; setCookie: string; body: string; parsed: unknown; contentType: string }> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const headers = makeDirectHeaders(ds);
  const res = await (ds.impit.fetch(url, { headers } as any) as unknown as Promise<Response>);
  const setCookie = (res.headers as any).get("set-cookie") ?? "";
  const contentType = (res.headers as any).get("content-type") ?? "";
  const body = await res.text();
  return { status: res.status, setCookie, body, parsed: parseDirectJsonp(body), contentType };
}

function proxy0(): string {
  const size = getDecodoPoolSize();
  if (size > 0) return getDecodoProxyForIndex(0) ?? "";
  return process.env.DECODO_PROXY_URL ?? "";
}

/** 2e proxy du pool (index 1) — pour la session de comparaison callDirect, IP distincte. */
function proxy0b(): string {
  const size = getDecodoPoolSize();
  if (size > 1) return getDecodoProxyForIndex(1) ?? "";
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
  sep("SCAN → sélection d'un créneau (ou date forcée pour inspection sans créneau)");
  const scan = await scanDatetimeDirect(phpState, config, tag);
  const realTarget = scan.status === "found" ? scan.slots?.find((s) => s.freeslots > 0) : undefined;

  // Fallback : SIGNIN_DATE/SIGNIN_TIME permettent de tester getsigninfields/+signin/
  // même SANS créneau réel (ex. Kinshasa fermé), pour inspecter cookies/PHPSESSID/corps.
  const forcedDate = process.env.SIGNIN_DATE;
  const forcedTime = process.env.SIGNIN_TIME;

  let target: { date: string; time: string; freeslots: number; agendaId?: string };
  if (realTarget) {
    target = realTarget;
    console.log(`  🎯 Créneau RÉEL : ${target.date} ${target.time} (${target.freeslots} place) agenda=${target.agendaId ?? "?"}`);
  } else if (forcedDate && forcedTime) {
    // SIGNIN_AGENDA permet de forcer un agenda connu (ex. Kinshasa bkt391787) même si
    // getagendas/ renvoie vide (portail fermé) — pour tester signin/ avec un agenda valide.
    const forcedAgenda = process.env.SIGNIN_AGENDA || phpState.agendaId || undefined;
    target = { date: forcedDate, time: forcedTime, freeslots: 0, agendaId: forcedAgenda };
    console.log(`  🎯 Date FORCÉE (pas de créneau réel) : ${target.date} ${target.time} agenda=${target.agendaId ?? "(aucun)"} — mode inspection`);
    console.log(`  ⚠️  Le serveur rejettera probablement (créneau inexistant), mais on verra la forme de la réponse.`);
  } else {
    console.log(`  ℹ️  Aucun créneau (status=${scan.status}) et pas de SIGNIN_DATE/SIGNIN_TIME.`);
    console.log(`      Relance avec ex.: SIGNIN_DATE=2026-10-13 SIGNIN_TIME=08:30 pour inspecter sans créneau.`);
    process.exit(0);
  }

  const ds = scan.ds ?? phpState.ds;
  const serviceId = phpState.bestServiceId;
  const base: Record<string, string> = {
    "services[]": serviceId,
    date: target.date,
    time: target.time,
    selectedPeople: "1",
  };
  if (target.agendaId) base["agendas[]"] = target.agendaId;

  // 3. État du jar AVANT booking — VALEURS COMPLÈTES (pour voir virgule/format PHPSESSID)
  sep("JAR AVANT getsigninfields/ (valeurs complètes)");
  for (const [k, v] of Object.entries(ds.jar)) {
    const val = String(v);
    const hasComma = val.includes(",") || val.includes("%2C");
    console.log(`  ${k} = ${val}${hasComma ? "   ⚠️ CONTIENT UNE VIRGULE" : ""}`);
  }
  console.log(`  session.allCookies: ${res.session.allCookies.map((c) => c.name).join(", ")}`);
  console.log(`  PHPSESSID longueur: ${String(ds.jar.PHPSESSID ?? "").length}`);

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

  // 4b. STABILITÉ : rappeler getsigninfields/ 5× sur la MÊME session/IP.
  // But : distinguer "IP filtrée" (résultat stable) de "serveur non-déterministe"
  // (résultat qui alterne 0B / non-0B sur la même IP).
  sep("STABILITÉ — getsigninfields/ × 5 sur la MÊME session/IP");
  const stab: number[] = [gsf.body.length];
  for (let k = 0; k < 5; k++) {
    await new Promise((r) => setTimeout(r, 800));
    const g = await rawCall(ds, "getsigninfields/", {
      "services[]": base["services[]"],
      "agendas[]": base["agendas[]"] ?? "",
      date: base.date, time: base.time, selectedPeople: base.selectedPeople,
    });
    stab.push(g.body.length);
    console.log(`  essai ${k + 2}: HTTP ${g.status} | ${g.body.length}B | contentType=${(g as any).contentType ?? "?"}`);
  }
  const allZero = stab.every((b) => b === 0);
  const allNonZero = stab.every((b) => b > 0);
  console.log(`  → résultats: [${stab.join(", ")}]`);
  if (allZero) console.log("  🔴 STABLE 0B → cette IP est filtrée/bloquée par le serveur sur ce portail.");
  else if (allNonZero) console.log("  🟢 STABLE non-0B → cette IP passe ; le 0B vient d'ailleurs (concurrence/créneau).");
  else console.log("  🟠 ALTERNE 0B/non-0B sur la MÊME IP → serveur non-déterministe (rate-limit ou charge).");

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

  // 7. Verdict rawCall
  sep("VERDICT — chemin rawCall (SANS mergeResponseCookies, sans retry)");
  const rawSigninOk = signin.body.length > 0;
  if (!rawSigninOk) {
    console.log("  ❌ rawCall signin/ → 0B (vide).");
  } else {
    console.log(`  ✅ rawCall signin/ → ${signin.body.length}B — le serveur traite la requête.`);
  }

  // ── 8. COMPARAISON : chemin PROD callDirect (AVEC mergeResponseCookies + retry) ──
  // On refait getsigninfields/ + signin/ via callDirect exact de prod, sur une NOUVELLE
  // session isolée (pour ne pas réutiliser un ds déjà pollué par les rawCall ci-dessus).
  sep("COMPARAISON — chemin PROD callDirect (getsigninfields/ + signin/)");
  const res2 = await initWorkerSession(proxy0b(), PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res2) {
    console.log("  ⚠️  2e session (callDirect) non disponible — comparaison sautée.");
  } else {
    const php2 = await initPhpState(res2.session, config, "[CALLDIRECT]");
    if (!php2) {
      console.log("  ⚠️  initPhpState 2e session échoué — comparaison sautée.");
    } else {
      const ds2 = buildDynamicSession(res2.session);
      if (!ds2) {
        console.log("  ⚠️  buildDynamicSession 2e session échoué.");
      } else {
        const sid2 = String(ds2.jar.PHPSESSID ?? "");
        console.log(`  PHPSESSID (session 2) AVANT: ${sid2}`);
        const base2: Record<string, string> = {
          "services[]": php2.bestServiceId,
          date: target.date,
          time: target.time,
          selectedPeople: "1",
        };
        if (php2.agendaId || target.agendaId) base2["agendas[]"] = php2.agendaId || target.agendaId || "";

        const gsf2 = await callDirect(ds2, "getsigninfields/", {
          "services[]": base2["services[]"],
          "agendas[]": base2["agendas[]"] ?? "",
          date: base2.date, time: base2.time, selectedPeople: base2.selectedPeople,
        }, "[CALLDIRECT]");
        const gsf2Bytes = gsf2 && gsf2 !== CALL_DIRECT_NETWORK_ERROR && gsf2 !== CALL_DIRECT_HTTP_OVERLOAD
          ? JSON.stringify(gsf2).length : 0;
        const sidAfterGsf = String(ds2.jar.PHPSESSID ?? "");
        console.log(`  callDirect getsigninfields/ → ${gsf2Bytes}B | PHPSESSID APRÈS: ${sidAfterGsf}${sidAfterGsf !== sid2 ? "  ⚠️ PHPSESSID A CHANGÉ (merge)" : "  (inchangé)"}`);

        const signin2 = await callDirect(ds2, "signin/", {
          ...base2, logintype: "document", login: config.login, password: config.password, comments: "",
        }, "[CALLDIRECT]");
        const signin2Payload = (signin2 === null || signin2 === CALL_DIRECT_NETWORK_ERROR || signin2 === CALL_DIRECT_HTTP_OVERLOAD)
          ? null : signin2;
        const signin2Bytes = signin2Payload ? JSON.stringify(signin2Payload).length : 0;
        const sidAfterSignin = String(ds2.jar.PHPSESSID ?? "");
        console.log(`  callDirect signin/ → ${signin2Bytes}B | PHPSESSID APRÈS: ${sidAfterSignin}`);
        console.log(`  callDirect signin/ payload: ${JSON.stringify(signin2Payload)?.slice(0, 400) ?? "null (0B)"}`);

        // ── VERDICT COMPARATIF ──
        sep("VERDICT COMPARATIF");
        console.log(`  rawCall (sans merge)   signin/ = ${signin.body.length}B`);
        console.log(`  callDirect (prod+merge) signin/ = ${signin2Bytes}B`);
        if (rawSigninOk && signin2Bytes === 0) {
          console.log("  🔴 PREUVE : rawCall répond mais callDirect donne 0B → le chemin PROD (mergeResponseCookies/retry) CASSE le signin/.");
          if (sidAfterGsf !== sid2) {
            console.log("  🎯 CAUSE : mergeResponseCookies a changé le PHPSESSID après getsigninfields/ → signin/ part avec une session incohérente.");
          }
        } else if (rawSigninOk && signin2Bytes > 0) {
          console.log("  🟢 Les DEUX chemins répondent → callDirect/merge n'est PAS en cause. Le 0B prod vient du serveur (charge/concurrence).");
        } else if (!rawSigninOk && signin2Bytes === 0) {
          console.log("  🟠 Les deux donnent 0B → comportement serveur (créneau inexistant/date forcée), pas un bug de chemin.");
        }
      }
    }
  }
  console.log();
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
