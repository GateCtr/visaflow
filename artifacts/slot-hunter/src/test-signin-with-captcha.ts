/**
 * test-signin-with-captcha.ts — Teste signin/ AVEC token hCaptcha (gct) résolu.
 *
 * OBJECTIF
 *   Valider que le serveur ACCEPTE le token gct. Sur Cuba (hCaptcha présent), avec de
 *   FAUX credentials mais un vrai gct :
 *     - Si le serveur renvoie « Usuario o contraseña incorrectos » (comme sans gct)
 *       → le gct est accepté, le rejet ne porte que sur les credentials. ✅ Le gct marche.
 *     - Si le serveur renvoie une erreur captcha (« captcha », « verification »…)
 *       → notre token/format gct est mauvais. ❌
 *   Test comparatif : signin/ SANS gct puis signin/ AVEC gct, même session.
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   npx tsx src/test-signin-with-captcha.ts
 *   SIGNIN_PORTAL=<url> (défaut Cuba). SIGNIN_LOGIN / SIGNIN_PASSWORD pour de vrais idents.
 */

import "dotenv/config";

import { initWorkerSession } from "./spain-soax-solver.js";
import { initPhpState, scanDatetimeDirect, type SpainDossierConfig } from "./spain-dossier-worker.js";
import { parseDirectJsonp, callDirect, CALL_DIRECT_NETWORK_ERROR, CALL_DIRECT_HTTP_OVERLOAD, type DynamicSession } from "./spain-bookitit-direct.js";
import { getDecodoPoolSize, getDecodoProxyForIndex } from "./spain-decodo-pool.js";
import { detectHcaptcha } from "./spain-captcha-detect.js";
import { HCAPTCHA_SITEKEY } from "./spain-http-booking.js";
import { solveHcaptchaViaNonecap } from "./nonecap.js";

const NONECAP_KEY = process.env.NONECAP_API_KEY ?? "";
const ANTICAPTCHA_KEY = process.env.ANTICAPTCHA_API_KEY ?? "";

/** Anti-Captcha hCaptcha (format createTask/getTaskResult, type Proxyless). */
async function solveViaAntiCaptcha(sitekey: string, pageUrl: string): Promise<string | null> {
  if (!ANTICAPTCHA_KEY) return null;
  try {
    const cr = await fetch("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: ANTICAPTCHA_KEY,
        task: { type: "HCaptchaTaskProxyless", websiteURL: pageUrl, websiteKey: sitekey },
      }),
    });
    const cd = (await cr.json()) as { errorId: number; taskId?: number; errorCode?: string; errorDescription?: string };
    if (cd.errorId !== 0 || !cd.taskId) {
      console.log(`  [anti-captcha] createTask erreur: ${cd.errorCode ?? cd.errorId} — ${cd.errorDescription ?? ""}`);
      return null;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3_000));
      const rr = await fetch("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientKey: ANTICAPTCHA_KEY, taskId: cd.taskId }),
      });
      const rd = (await rr.json()) as { status?: string; solution?: { gRecaptchaResponse?: string }; errorDescription?: string };
      if (rd.status === "ready" && rd.solution?.gRecaptchaResponse) return rd.solution.gRecaptchaResponse;
      if (rd.errorDescription) { console.log(`  [anti-captcha] ${rd.errorDescription}`); return null; }
    }
    return null;
  } catch (e) {
    console.log(`  [anti-captcha] exception: ${e}`);
    return null;
  }
}

/** Cascade de solveurs hCaptcha : NoneCap (prioritaire) → Anti-Captcha. */
async function solveHcaptchaCascade(sitekey: string, pageUrl: string): Promise<{ token: string | null; via: string }> {
  if (NONECAP_KEY) {
    console.log(`  → tentative NoneCap…`);
    const t = await solveHcaptchaViaNonecap(NONECAP_KEY, sitekey, pageUrl, "[test]");
    if (t) return { token: t, via: "nonecap" };
    console.log(`  NoneCap échoué → fallback Anti-Captcha`);
  }
  if (ANTICAPTCHA_KEY) {
    console.log(`  → tentative Anti-Captcha…`);
    const t = await solveViaAntiCaptcha(sitekey, pageUrl);
    if (t) return { token: t, via: "anti-captcha" };
  }
  return { token: null, via: "none" };
}

const CUBA = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PORTAL_URL = process.env.SIGNIN_PORTAL ?? CUBA;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";
const LOGIN = process.env.SIGNIN_LOGIN ?? "00000001";
const PASSWORD = process.env.SIGNIN_PASSWORD ?? "FakePass_Test";

function sep(l: string): void { console.log("\n" + "═".repeat(72) + `\n  ${l}\n` + "═".repeat(72)); }
function proxy0(): string {
  const s = getDecodoPoolSize();
  if (s > 0) return getDecodoProxyForIndex(0) ?? "";
  return process.env.DECODO_PROXY_URL ?? "";
}

function summarize(body: string): string {
  let p: any = null;
  try { p = JSON.parse(body); } catch { p = parseDirectJsonp(body); }
  const errs = p?.Client?.errors ?? p?.errors;
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e: any) => `[${e.type ?? "?"}/${e.field ?? "?"}] ${e.message ?? ""}`).join(" | ");
  }
  if (p?.Access?.bktToken || p?.Client?.bktToken || p?.bktToken) return "bktToken PRÉSENT (signin OK !)";
  return body.slice(0, 200).replace(/\s+/g, " ");
}

async function main(): Promise<void> {
  sep("TEST signin/ AVEC hCaptcha (gct)");
  console.log(`  Portail : ${PORTAL_URL}`);
  console.log(`  Login   : ${LOGIN === "00000001" ? "FAUX (test)" : "fourni"}`);

  const config: SpainDossierConfig = {
    id: "signin-captcha", applicantName: "SIGNIN_CAPTCHA", visaType: "visa",
    login: LOGIN, password: PASSWORD, applicationId: "sc", otpChannel: "manual", portalUrl: PORTAL_URL,
  };
  const tag = "[SIGNIN-CAPTCHA]";

  const res = await initWorkerSession(proxy0(), PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res) { console.error("❌ initWorkerSession"); process.exit(1); }
  const php = await initPhpState(res.session, config, tag);
  if (!php) { console.error("❌ initPhpState"); process.exit(1); }

  // Créneau (réel de préférence)
  const scan = await scanDatetimeDirect(php, config, tag);
  const slot = scan.status === "found" ? scan.slots?.find((s) => s.freeslots > 0) : undefined;
  if (!slot) { console.log(`  ℹ️ Aucun créneau (status=${scan.status}) — relance quand Cuba a des créneaux.`); process.exit(0); }
  console.log(`  🎯 Créneau : ${slot.date} ${slot.time} agenda=${slot.agendaId ?? "?"}`);

  const ds = scan.ds ?? php.ds;
  const base: Record<string, string> = { "services[]": php.bestServiceId, date: slot.date, time: slot.time, selectedPeople: "1" };
  if (slot.agendaId) base["agendas[]"] = slot.agendaId;

  // Détection hCaptcha
  const det = detectHcaptcha([{ label: "main", text: res.session.prefetchedMainHtml ?? "" }]);
  console.log(`  hCaptcha présent=${det.present} sitekey=${det.sitekey ?? "-"}`);

  if (!det.present) {
    console.log("\n  ℹ️ Pas de hCaptcha détecté — test sans objet ici.");
    process.exit(0);
  }

  // ── SÉQUENCE EXACTE DE LA PROD (callDirect) ──────────────────────────────────
  // Ordre prod : getsigninfields/ (armement) → signin/. On y intercale la résolution
  // du hCaptcha AVANT signin/, pour que le token gct parte avec un formulaire déjà armé.
  // Tout via callDirect (le vrai chemin), pas rawCall.

  // 1) Résoudre le hCaptcha (avant tout, comme un humain qui coche puis soumet)
  sep("1) Résolution hCaptcha (NoneCap → Anti-Captcha)");
  const sitekey = det.sitekey || HCAPTCHA_SITEKEY;
  console.log(`  sitekey=${sitekey} | NoneCap=${NONECAP_KEY ? "✅" : "❌"} Anti-Captcha=${ANTICAPTCHA_KEY ? "✅" : "❌"}`);
  const t0 = Date.now();
  const { token: gct, via } = await solveHcaptchaCascade(sitekey, PORTAL_URL.split("#")[0]);
  console.log(`  gct ${gct ? `résolu via ${via} (${gct.length} car., ${Math.round((Date.now() - t0) / 1000)}s)` : "NON résolu ❌"}`);
  if (!gct) { console.log("  ⚠️ Aucun solveur n'a résolu — arrêt."); process.exit(1); }

  // 2) getsigninfields/ (armement) — via callDirect, comme la prod
  sep("2) getsigninfields/ (armement, callDirect)");
  const gsf = await callDirect(ds, "getsigninfields/", {
    "services[]": base["services[]"],
    "agendas[]": base["agendas[]"] ?? "",
    date: base.date, time: base.time, selectedPeople: base.selectedPeople,
  }, tag);
  const gsfBytes = gsf && gsf !== CALL_DIRECT_NETWORK_ERROR && gsf !== CALL_DIRECT_HTTP_OVERLOAD ? JSON.stringify(gsf).length : 0;
  console.log(`  getsigninfields/ → ${gsfBytes}B`);

  // 3) signin/ AVEC gct — via callDirect, exactement comme la prod
  sep("3) signin/ AVEC gct (callDirect)");
  const signinRaw = await callDirect(ds, "signin/", {
    ...base,
    logintype: "document",
    login: LOGIN,
    password: PASSWORD,
    comments: "",
    gct,
  });
  const signinPayload = (signinRaw === null || signinRaw === CALL_DIRECT_NETWORK_ERROR || signinRaw === CALL_DIRECT_HTTP_OVERLOAD)
    ? null : signinRaw;
  const withGct = {
    bytes: signinPayload ? JSON.stringify(signinPayload).length : 0,
    body: signinPayload ? JSON.stringify(signinPayload) : "",
  };
  console.log(`  signin/ → ${withGct.bytes}B`);
  console.log(`  → ${withGct.bytes > 0 ? summarize(withGct.body) : "0B (vide)"}`);

  // Verdict
  sep("VERDICT");
  const incorrectMsg = /incorrect|contrase/i;
  const captchaMsg = /captcha|verif|robot|human/i;
  if (withGct.bytes === 0) {
    console.log("  🔴 signin/ AVEC gct → 0B. Le gct n'a pas suffi (ou autre blocage).");
  } else if (captchaMsg.test(withGct.body)) {
    console.log("  🟠 signin/ renvoie une erreur liée au captcha → token/format gct rejeté.");
  } else if (incorrectMsg.test(withGct.body)) {
    console.log("  🟢 signin/ renvoie 'credentials incorrects' AVEC gct → le gct est ACCEPTÉ.");
    console.log("     (le rejet ne porte que sur les faux identifiants — avec de vrais idents, signin passerait)");
  } else if (/bktToken/i.test(withGct.body)) {
    console.log("  🎉 bktToken présent → signin RÉUSSI (credentials valides + gct accepté) !");
  } else {
    console.log("  ℹ️ Réponse inattendue — voir le corps ci-dessus.");
  }
  console.log();
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
