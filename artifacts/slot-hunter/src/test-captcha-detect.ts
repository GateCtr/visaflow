/**
 * test-captcha-detect.ts — Valide l'extraction dynamique du sitekey hCaptcha.
 *
 * Cible Cuba (hCaptcha visible sur le formulaire, confirmé par capture 2026-09) :
 * l'outil doit RETROUVER le sitekey depuis le contenu réel du portail (HTML /main/,
 * getsigninfields/, config widget) — sans le coder en dur.
 *
 * USAGE
 *   cd artifacts/slot-hunter
 *   npx tsx src/test-captcha-detect.ts
 *   SIGNIN_PORTAL=<url> pour un autre portail (défaut Cuba).
 */

import "dotenv/config";

import { initWorkerSession } from "./spain-soax-solver.js";
import { initPhpState, type SpainDossierConfig } from "./spain-dossier-worker.js";
import { buildDynamicSession, makeDirectUrl, makeDirectHeaders, type DynamicSession } from "./spain-bookitit-direct.js";
import { getDecodoPoolSize, getDecodoProxyForIndex } from "./spain-decodo-pool.js";
import { detectHcaptcha, extractHcaptchaSitekey } from "./spain-captcha-detect.js";

const CUBA = "https://www.citaconsular.es/es/hosteds/widgetdefault/28330379fc95acafd31ee9e8938c278ff/";
const PORTAL_URL = process.env.SIGNIN_PORTAL ?? CUBA;
const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY ?? process.env.NONECAP_API_KEY ?? "";

function sep(l: string): void { console.log("\n" + "═".repeat(72) + `\n  ${l}\n` + "═".repeat(72)); }
function proxy0(): string {
  const s = getDecodoPoolSize();
  if (s > 0) return getDecodoProxyForIndex(0) ?? "";
  return process.env.DECODO_PROXY_URL ?? "";
}

async function rawText(ds: DynamicSession, endpoint: string, extra: Record<string, string>): Promise<string> {
  const url = makeDirectUrl(ds, endpoint, extra);
  const res = await (ds.impit.fetch(url, { headers: makeDirectHeaders(ds) } as any) as unknown as Promise<Response>);
  return res.text();
}

async function main(): Promise<void> {
  sep("TEST DÉTECTION DYNAMIQUE hCaptcha");
  console.log(`  Portail : ${PORTAL_URL}`);

  const config: SpainDossierConfig = {
    id: "captcha-detect", applicantName: "CAPTCHA_DETECT", visaType: "visa",
    login: "00000001", password: "x", applicationId: "cd", otpChannel: "manual", portalUrl: PORTAL_URL,
  };
  const tag = "[CAPTCHA-DETECT]";

  const res = await initWorkerSession(proxy0(), PORTAL_URL.split("#")[0], CAPSOLVER_KEY);
  if (!res) { console.error("❌ initWorkerSession"); process.exit(1); }
  const php = await initPhpState(res.session, config, tag);
  if (!php) { console.error("❌ initPhpState"); process.exit(1); }

  const ds = buildDynamicSession(res.session);
  if (!ds) { console.error("❌ buildDynamicSession"); process.exit(1); }

  // Source 1 : HTML /main/ (le widget rendu — le hCaptcha visible y est référencé)
  const mainHtml = res.session.prefetchedMainHtml ?? "";
  console.log(`  main HTML: ${mainHtml.length}B`);

  // Source 2 : getwidgetconfigurations/
  const cfgRaw = await rawText(ds, "getwidgetconfigurations/", {});
  console.log(`  getwidgetconfigurations/: ${cfgRaw.length}B`);

  // Source 3 : getsigninfields/ (config du formulaire de login — hCaptcha probablement ici)
  const gsfRaw = await rawText(ds, "getsigninfields/", {
    "services[]": php.bestServiceId,
    "agendas[]": php.agendaId ?? "",
    selectedPeople: "1",
  });
  console.log(`  getsigninfields/: ${gsfRaw.length}B`);

  // ── Détection par source ──
  sep("DÉTECTION PAR SOURCE");
  for (const [label, text] of [["main", mainHtml], ["getwidgetconfigurations", cfgRaw], ["getsigninfields", gsfRaw]] as const) {
    const d = extractHcaptchaSitekey(text, label);
    console.log(`  ${label}: present=${d.present} sitekey=${d.sitekey ?? "-"} matchedBy=${d.matchedBy}`);
  }

  // ── Détection combinée (ordre de fiabilité) ──
  sep("VERDICT — détection combinée");
  const combined = detectHcaptcha([
    { label: "getsigninfields", text: gsfRaw },
    { label: "main", text: mainHtml },
    { label: "getwidgetconfigurations", text: cfgRaw },
  ]);
  console.log(`  present : ${combined.present}`);
  console.log(`  sitekey : ${combined.sitekey ?? "(introuvable)"}`);
  console.log(`  source  : ${combined.source}`);
  console.log(`  matchedBy: ${combined.matchedBy}`);
  console.log();
  if (combined.sitekey) {
    console.log(`  ✅ Sitekey extrait dynamiquement : ${combined.sitekey}`);
    console.log(`     (comparer au sitekey hardcodé Cuba 38663b6a-85dc-4346-965e-f066cd8e7d26)`);
  } else if (combined.present) {
    console.log("  🟠 hCaptcha détecté (marqueur) mais sitekey non extrait — affiner les patterns.");
  } else {
    console.log("  ⚠️ Aucun hCaptcha détecté dans ces sources — le sitekey est ailleurs (JS externe ?).");
  }
  console.log();
}

main().catch((e) => { console.error("💥", e); process.exit(1); });
