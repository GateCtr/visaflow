/**
 * test-saopolo-browser-e2e.ts — Test E2E complet booking Saopolo via browser ISP
 *
 * ─── Objectif ────────────────────────────────────────────────────────────────
 * Valide le parcours booking de bout-en-bout sur le portail São Paulo :
 *
 *   1. Lance Chromium via SPAIN_ISP_PROXY_URL (Madrid/BCN CF PoP → nonce fraîche)
 *   2. Résout le challenge Cloudflare (JSD passif ou Turnstile)
 *   3. Clique Bienvenido OK → Continuar → widget charge /main/
 *   4. Si des créneaux existent → clique Aceptar → service → date → heure
 *   5. Remplit les credentials (passport/email + password) → soumet
 *   6. Capture la réponse summary/ et vérifie la confirmation de réservation
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   cd artifacts/slot-hunter
 *   TEST_SPAIN_LOGIN=AB123456 TEST_SPAIN_PASSWORD=monpassword \
 *   npx tsx src/scripts/test-saopolo-browser-e2e.ts
 *
 *   # Mode headed (navigateur visible) :
 *   SPAIN_HEADED=1 TEST_SPAIN_LOGIN=... TEST_SPAIN_PASSWORD=... \
 *   npx tsx src/scripts/test-saopolo-browser-e2e.ts
 *
 * ─── Variables d'environnement ───────────────────────────────────────────────
 *   SPAIN_ISP_PROXY_URL   — REQUIS : proxy ISP espagnol (http://user:pass@host:port)
 *   TEST_SPAIN_LOGIN      — REQUIS : numéro passeport ou email du dossier test
 *   TEST_SPAIN_PASSWORD   — REQUIS : mot de passe du dossier test
 *                           (fallback : CEV_TEST_PASSWORD)
 *   SPAIN_HEADED=1        — Ouvre le navigateur visible (optionnel)
 *   SPAIN_SLOW_MO=120     — Ralentit les interactions en mode headed (ms)
 *   SPAIN_DEVTOOLS=1      — Ouvre les DevTools automatiquement
 *   TEST_TARGET_DATE      — Date cible YYYY-MM-DD (défaut: premier créneau trouvé)
 *   TEST_TARGET_TIME      — Heure cible HH:MM  (défaut: premier créneau trouvé)
 *
 * ─── Sécurité ─────────────────────────────────────────────────────────────────
 *   Ce script RÉSERVE réellement un créneau si credentials valides + slots dispo.
 *   Utiliser uniquement des credentials de test ou annuler manuellement après.
 */

import "dotenv/config";

// ── Flags CLI ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes("--headed"))   process.env.SPAIN_HEADED   = "1";
if (argv.includes("--devtools")) process.env.SPAIN_DEVTOOLS = "1";
const slowMoArg = argv.find((a) => a.startsWith("--slow-mo="));
if (slowMoArg)                   process.env.SPAIN_SLOW_MO  = slowMoArg.split("=")[1];

// ── Profil Chrome isolé (ne pas perturber le scanner principal) ─────────────
process.env.SPAIN_CF_PROFILE_DIR   = process.env.SPAIN_CF_PROFILE_DIR  ?? "/tmp/spain-isp-e2e-profile";
process.env.SPAIN_SESSION_MODE     = "persistent-browser";

import { SAOPOLO_PORTAL_URL, SAOPOLO_WIDGET_KEY } from "../spain-portals.js";
import {
  spainPersistentBrowser,
  ensureSpainPersistentBrowserSession,
  navigateToSelecttime,
  submitSigninFormViaDOM,
} from "../spain-persistent-browser.js";

// ── Constantes Saopolo ─────────────────────────────────────────────────────────
const PORTAL_URL   = SAOPOLO_PORTAL_URL;
const WIDGET_KEY   = SAOPOLO_WIDGET_KEY;
// Saopolo : service principal = pasaportes (bkt853215); on prend le premier disponible dynamiquement.
const PREFERRED_SERVICE_ID = process.env.TEST_SERVICE_ID ?? "bkt853215";

// ── Helpers log ────────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts(): string { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: "INFO" | "OK" | "WARN" | "ERR" | "STEP", msg: string): void {
  const icons: Record<string, string> = {
    INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ ",
  };
  console.log(`[${ts()}] ${icons[level] ?? "  "} ${msg}`);
}
function section(title: string): void {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Parse JSONP ────────────────────────────────────────────────────────────────
function parseJsonp(raw: string): unknown {
  if (!raw || raw.length === 0) return null;
  try { return JSON.parse(raw); } catch { /* continue */ }
  const m = raw.match(/^[\w$]+\((.+)\);?\s*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* continue */ } }
  return null;
}

// ── Cherche le premier créneau libre dans les réponses datetime/ capturées ────
interface Slot { date: string; time: string; agendaId: string }
function findFirstSlot(datetimeRaws: string[]): Slot | null {
  for (const raw of datetimeRaws) {
    const parsed = parseJsonp(raw) as any;
    if (!parsed?.Slots || !Array.isArray(parsed.Slots)) continue;
    for (const daySlot of parsed.Slots) {
      const date: string = daySlot.date ?? "";
      const agendaId: string = daySlot.agenda ?? "";
      const times: Record<string, any> = daySlot.times ?? {};
      for (const [time, info] of Object.entries(times)) {
        const free = Number((info as any).freeSlots ?? 0);
        if (free > 0) {
          return { date, time, agendaId };
        }
      }
    }
  }
  return null;
}

// ── Vérification des prérequis ─────────────────────────────────────────────────
function checkPrerequisites(): {
  ok: boolean;
  ispProxy: string;
  login: string;
  password: string;
} {
  const ispProxy = process.env.SPAIN_ISP_PROXY_URL ?? "";
  const login    = process.env.TEST_SPAIN_LOGIN ?? "";
  const password = process.env.TEST_SPAIN_PASSWORD ?? process.env.CEV_TEST_PASSWORD ?? "";

  const missing: string[] = [];
  if (!ispProxy) missing.push("SPAIN_ISP_PROXY_URL");
  if (!login)    missing.push("TEST_SPAIN_LOGIN");
  if (!password) missing.push("TEST_SPAIN_PASSWORD (ou CEV_TEST_PASSWORD)");

  if (missing.length > 0) {
    log("ERR", `Variables d'environnement manquantes : ${missing.join(", ")}`);
    log("INFO", "Exemple :");
    log("INFO", "  SPAIN_ISP_PROXY_URL=http://user:pass@isp.decodo.com:10001 \\");
    log("INFO", "  TEST_SPAIN_LOGIN=AB123456 \\");
    log("INFO", "  TEST_SPAIN_PASSWORD=monpassword \\");
    log("INFO", "  npx tsx src/scripts/test-saopolo-browser-e2e.ts");
    return { ok: false, ispProxy, login, password };
  }

  return { ok: true, ispProxy, login, password };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  section(`TEST E2E BROWSER SAOPOLO — ${new Date().toISOString()}`);

  // ── Bannière mode headed ───────────────────────────────────────────────────
  const isHeaded = process.env.SPAIN_HEADED === "1";
  if (isHeaded) {
    console.log("\n" + "█".repeat(72));
    console.log("█" + "  🟢  SAOPOLO E2E — MODE NAVIGATEUR VISIBLE".padEnd(70) + "█");
    console.log("█" + `  slowMo: ${process.env.SPAIN_SLOW_MO ?? "60"}ms | devtools: ${process.env.SPAIN_DEVTOOLS === "1" ? "ON" : "OFF"}`.padEnd(70) + "█");
    console.log("█".repeat(72) + "\n");
  }

  // ── Prérequis ──────────────────────────────────────────────────────────────
  const { ok, ispProxy, login, password } = checkPrerequisites();
  if (!ok) process.exit(1);

  log("INFO", `Portail     : ${PORTAL_URL}`);
  log("INFO", `Widget key  : ${WIDGET_KEY}`);
  log("INFO", `ISP proxy   : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `Login       : ${login.slice(0, 4)}${"*".repeat(Math.max(0, login.length - 4))}`);
  log("INFO", `Profil      : ${process.env.SPAIN_CF_PROFILE_DIR}`);
  log("INFO", `Mode        : ${isHeaded ? "👁️  headed" : "headless"}`);

  // ─── ÉTAPE 1 : Session CF + chargement widget ──────────────────────────────
  section("ÉTAPE 1 — Session CF via ISP proxy + chargement widget");
  log("STEP", `ensureSpainPersistentBrowserSession(${PORTAL_URL.slice(0, 60)}…)`);

  spainPersistentBrowser.setCurrentTargetUrl(PORTAL_URL);

  const t1 = Date.now();
  const session = await ensureSpainPersistentBrowserSession(PORTAL_URL);
  const t1s = ((Date.now() - t1) / 1_000).toFixed(1);

  if (!session) {
    log("ERR", `Session CF introuvable après ${t1s}s`);
    log("INFO", "Vérifier : SPAIN_ISP_PROXY_URL valide, accès réseau proxy OK");
    process.exit(1);
  }

  log("OK", `Session CF obtenue en ${t1s}s — source=${session.source}`);
  log("INFO", `cf_clearance : ${session.cfClearance.slice(0, 30)}…`);
  log("INFO", `proxy utilisé: ${(session.soaxProxyUrl || "direct").replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `cookies      : ${session.allCookies.map((c: any) => c.name).join(", ")}`);

  const page = spainPersistentBrowser.getActivePage();
  if (!page) {
    log("ERR", "Page Chromium non disponible après session CF");
    process.exit(1);
  }

  // ── Snapshot DOM après session ─────────────────────────────────────────────
  await domSnapshot(page, "après-session-CF");

  // ─── ÉTAPE 2 : prepareWidgetForBooking — Bienvenido OK + Continuar + Aceptar ──
  section("ÉTAPE 2 — prepareWidgetForBooking (Bienvenido OK / Continuar / Aceptar)");
  log("STEP", "prepareWidgetForBooking…");

  const t2 = Date.now();
  const prepared = await spainPersistentBrowser.prepareWidgetForBooking();
  const t2s = ((Date.now() - t2) / 1_000).toFixed(1);

  log(prepared ? "OK" : "WARN", `prepareWidgetForBooking → ${prepared} (${t2s}s)`);
  await domSnapshot(page, "après-prepare");

  if (!prepared) {
    log("WARN", "prepareWidgetForBooking a échoué — on tente quand même la suite");
    // Vérifier si on est bloqué sur une page CF ou Bookitit intacte
    const pageTitle = await page.title().catch(() => "?");
    const pageUrl   = page.url();
    log("INFO", `URL courante : ${pageUrl.slice(0, 80)}`);
    log("INFO", `Titre page   : ${pageTitle.slice(0, 80)}`);
  }

  // ─── ÉTAPE 3 : clickServiceAndCaptureSlots ────────────────────────────────
  section("ÉTAPE 3 — clickServiceAndCaptureSlots (service + calendrier)");
  log("STEP", `Clic service preferredServiceId=${PREFERRED_SERVICE_ID}…`);

  const t3 = Date.now();
  const capture = await spainPersistentBrowser.clickServiceAndCaptureSlots({
    preferredServiceId: PREFERRED_SERVICE_ID,
    agTimeoutMs: 12_000,
    dtTimeoutMs: 12_000,
  });
  const t3s = ((Date.now() - t3) / 1_000).toFixed(1);

  if (!capture) {
    log("ERR", `clickServiceAndCaptureSlots → null (${t3s}s) — aucun lien #selectservice dans le DOM`);
    await domSnapshot(page, "après-click-service-null");
    process.exit(1);
  }

  log("INFO", `getagendas/   → ${capture.getagendasRaw.length}B (${t3s}s)`);
  log("INFO", `datetime/ x${capture.datetimeRaws.length}  → ${capture.datetimeRaws.map((r) => r.length + "B").join(", ")}`);
  log("INFO", `href cliqué   → ${capture.clickedHref}`);

  if (capture.getagendasRaw.length === 0) {
    log("ERR", "getagendas/ vide — widget redirigé sur #services");
    log("WARN", "→ Cause probable : PHPSESSID invalide (nonce CDN stale) ou proxy ISP non actif");
    await domSnapshot(page, "getagendas-vide");
    process.exit(1);
  }

  // ── Analyser les créneaux disponibles ────────────────────────────────────
  const agendaParsed = parseJsonp(capture.getagendasRaw) as any;
  const agendas: Array<{ idAgenda: string; agendaName?: string }> = agendaParsed?.agendas ?? [];
  log("INFO", `Agendas détectés : ${agendas.length}`);
  for (const ag of agendas) {
    log("INFO", `  ID=${ag.idAgenda} | nom=${ag.agendaName ?? "(sans nom)"}`);
  }

  await domSnapshot(page, "après-click-service");

  // ─── ÉTAPE 4 : Trouver le premier créneau libre ───────────────────────────
  section("ÉTAPE 4 — Analyse des créneaux disponibles");

  const targetSlot = (() => {
    // Priorité : override CLI
    const envDate = process.env.TEST_TARGET_DATE;
    const envTime = process.env.TEST_TARGET_TIME;
    const agId    = process.env.TEST_AGENDA_ID ?? agendas[0]?.idAgenda ?? "";

    if (envDate && envTime) {
      log("INFO", `Créneau forcé par env : ${envDate} ${envTime} (agenda=${agId})`);
      return { date: envDate, time: envTime, agendaId: agId };
    }

    // Sinon chercher dans les réponses datetime/ capturées
    return findFirstSlot(capture.datetimeRaws);
  })();

  if (!targetSlot) {
    log("WARN", "Aucun créneau libre trouvé dans les datetime/ capturés");
    log("INFO", "→ Saopolo n'a peut-être plus de créneaux disponibles en ce moment.");
    log("INFO", "→ Tu peux forcer un créneau avec TEST_TARGET_DATE / TEST_TARGET_TIME / TEST_AGENDA_ID");
    log("INFO", "→ (ex: TEST_TARGET_DATE=2026-09-15 TEST_TARGET_TIME=09:00 TEST_AGENDA_ID=bkt301070)");

    // Dumper tous les datetime/ reçus pour diagnostic
    for (let i = 0; i < capture.datetimeRaws.length; i++) {
      const raw = capture.datetimeRaws[i];
      if (raw.length > 0) {
        const parsed = parseJsonp(raw) as any;
        const slots = parsed?.Slots ?? [];
        log("INFO", `datetime/[${i}] → ${raw.length}B, ${slots.length} jour(s) dans ce mois`);
        for (const s of slots.slice(0, 3)) {
          log("INFO", `  📅 ${s.date} → times: ${Object.keys(s.times ?? {}).join(", ")}`);
        }
      } else {
        log("WARN", `datetime/[${i}] → 0B (body vide — session IP mismatch ou pas de créneaux)`);
      }
    }

    process.exit(0); // pas d'erreur — juste pas de créneau
  }

  log("OK", `Créneau cible : ${targetSlot.date} ${targetSlot.time} (agenda=${targetSlot.agendaId})`);

  // ─── ÉTAPE 5 : Navigation vers le créneau (hash-based router Backbone) ────
  section("ÉTAPE 5 — navigateToSelecttime (hash Backbone)");
  log("STEP", `navigateToSelecttime(date=${targetSlot.date}, time=${targetSlot.time}, agenda=${targetSlot.agendaId})`);

  const t5 = Date.now();
  const hash = await navigateToSelecttime(
    targetSlot.date,
    targetSlot.time,
    targetSlot.agendaId,
    PORTAL_URL,
  );
  const t5s = ((Date.now() - t5) / 1_000).toFixed(1);

  log(hash ? "OK" : "ERR", `navigateToSelecttime → hash="${hash || "null"}" (${t5s}s)`);

  if (!hash) {
    log("ERR", "navigateToSelecttime a échoué — formulaire non accessible");
    await domSnapshot(page, "selecttime-échec");

    const availableLinks = await page.evaluate(`
      Array.from(document.querySelectorAll('a[href*="selecttime"]'))
        .map(function(a) { return (a.getAttribute('href') || ''); })
        .slice(0, 10).join('\\n');
    `).catch(() => "(erreur evaluate)");
    log("INFO", `Liens selecttime disponibles :\n${availableLinks}`);
    process.exit(1);
  }

  await domSnapshot(page, "formulaire-signin");

  // ─── ÉTAPE 6 : Vérification formulaire visible ────────────────────────────
  section("ÉTAPE 6 — Vérification formulaire signin visible");
  const loginSelector = '#idBktSigninLogin, #idBktLogin, [name="login"], input[type="text"], input[type="email"]';
  let formVisible = false;
  try {
    await page.waitForSelector(loginSelector, { visible: true, timeout: 14_000 });
    formVisible = true;
    log("OK", "Formulaire signin visible dans le DOM ✓");
  } catch {
    log("WARN", "Formulaire signin non visible après 14s — tentative soumission quand même");
  }

  if (!formVisible) {
    await domSnapshot(page, "formulaire-signin-absent");
  }

  // ─── ÉTAPE 7 : Soumission du formulaire ───────────────────────────────────
  section("ÉTAPE 7 — submitSigninFormViaDOM (credentials réels)");
  log("STEP", `submitSigninFormViaDOM(login=${login.slice(0, 4)}…, password=***)`);
  log("WARN", "⚠️  Ce script va tenter une VRAIE réservation ! Annuler manuellement si nécessaire.");

  const t7 = Date.now();
  const { signinBody, summaryBody } = await submitSigninFormViaDOM(login, password);
  const t7s = ((Date.now() - t7) / 1_000).toFixed(1);

  log("INFO", `signin/  → ${signinBody.length}B (${t7s}s)`);
  log("INFO", `summary/ → ${summaryBody.length}B`);

  // ─── ÉTAPE 8 : Analyse des réponses ───────────────────────────────────────
  section("ÉTAPE 8 — Analyse des réponses signin/ et summary/");

  // ── Analyse signin/ ──────────────────────────────────────────────────────
  if (!signinBody) {
    log("ERR", "signin/ vide — le formulaire n'a pas été soumis ou aucune réponse reçue");
    log("INFO", "→ Vérifier : champs du formulaire trouvés ? Bouton submit cliqué ?");
    process.exit(1);
  }

  const signinParsed = parseJsonp(signinBody) as any;
  log("INFO", `signin/ extrait (200c) : ${signinBody.slice(0, 200)}`);

  const bktToken = signinParsed?.bktToken ?? signinParsed?.token ?? "";
  const signinError = signinParsed?.error ?? signinParsed?.Error ?? signinParsed?.message ?? "";

  if (bktToken) {
    log("OK", `signin/ → bktToken reçu (${String(bktToken).slice(0, 20)}…) — credentials acceptés ✓`);
  } else if (signinError) {
    log("WARN", `signin/ → erreur credentials : ${signinError}`);
    log("INFO", "→ Credentials invalides pour ce portail, ou dossier inexistant.");
    log("INFO", "→ Vérifier TEST_SPAIN_LOGIN / TEST_SPAIN_PASSWORD.");
    process.exit(1);
  } else {
    log("WARN", `signin/ → réponse inattendue (${signinBody.length}B) : ${signinBody.slice(0, 200)}`);
  }

  // ── Analyse summary/ ─────────────────────────────────────────────────────
  if (!summaryBody) {
    log("WARN", "summary/ non reçu — le widget Backbone n'a pas émis la requête automatiquement");
    log("INFO", "→ Vérifier si la réservation a quand même abouti en consultant la page.");

    // Snapshot DOM final pour diagnostic
    await domSnapshot(page, "après-submit-sans-summary");

    const pageText = await page.evaluate(() => document.body?.innerText.slice(0, 400) ?? "").catch(() => "");
    log("INFO", `Texte page (400c) : ${pageText.replace(/\s+/g, " ")}`);
  } else {
    const summaryParsed = parseJsonp(summaryBody) as any;
    log("INFO", `summary/ extrait (300c) : ${summaryBody.slice(0, 300)}`);

    // Champs de confirmation connus dans les réponses Bookitit
    const confirmationId = summaryParsed?.appointmentId
      ?? summaryParsed?.id
      ?? summaryParsed?.appointment_id
      ?? summaryParsed?.confirmationCode
      ?? "";

    const confirmedDate = summaryParsed?.date
      ?? summaryParsed?.appointmentDate
      ?? summaryParsed?.selectedDate
      ?? "";

    const confirmedTime = summaryParsed?.time
      ?? summaryParsed?.appointmentTime
      ?? summaryParsed?.selectedTime
      ?? "";

    if (confirmationId || confirmedDate) {
      log("OK", "🎉🎉🎉 RÉSERVATION CONFIRMÉE !");
      if (confirmationId) log("OK", `ID confirmation : ${confirmationId}`);
      if (confirmedDate)  log("OK", `Date            : ${confirmedDate} ${confirmedTime}`);
    } else {
      log("INFO", "summary/ reçu mais pas de confirmationId détecté");
      log("INFO", "→ La réservation a peut-être abouti. Vérifier manuellement sur citaconsular.es.");
    }
  }

  // ─── ÉTAPE 9 : Snapshot DOM final ────────────────────────────────────────
  section("ÉTAPE 9 — Snapshot DOM final");
  await domSnapshot(page, "final");

  const finalHash = await page.evaluate(() => window.location.hash).catch(() => "?");
  const finalText = await page.evaluate(() => document.body?.innerText.slice(0, 600) ?? "").catch(() => "");
  log("INFO", `Hash final : ${finalHash}`);
  log("INFO", `Texte DOM (600c) :\n${finalText.replace(/\s+/g, " ")}`);

  // ─── Résumé ────────────────────────────────────────────────────────────────
  section("RÉSUMÉ FINAL");
  log("INFO", `Portail        : ${PORTAL_URL}`);
  log("INFO", `Proxy ISP      : ${ispProxy.replace(/:([^@:]+)@/, ":***@")}`);
  log("INFO", `Créneau testé  : ${targetSlot.date} ${targetSlot.time} (agenda=${targetSlot.agendaId})`);
  log("INFO", `signin/ reçu   : ${signinBody.length}B`);
  log("INFO", `summary/ reçu  : ${summaryBody.length}B`);

  if (summaryBody.length > 0) {
    log("OK", "✅ Flow complet E2E terminé — signin + summary reçus");
  } else if (signinBody.length > 0) {
    log("OK", "✅ Flow signin terminé — summary non intercepté (vérifier DOM final)");
  } else {
    log("WARN", "Flow partiel — vérifier les étapes précédentes");
  }

  // Garder le navigateur ouvert 5s en mode headed pour inspection visuelle
  if (isHeaded) {
    log("INFO", "Mode headed — fermeture dans 5s…");
    await new Promise<void>((r) => setTimeout(r, 5_000));
  }

  process.exit(0);
}

// ── Utils DOM ─────────────────────────────────────────────────────────────────
async function domSnapshot(page: import("puppeteer").Page, label: string): Promise<void> {
  try {
    const snap = await page.evaluate(`(function() {
      var hash   = window.location.hash;
      var url    = window.location.href.slice(0, 120);
      var inputs = Array.from(document.querySelectorAll('input'))
        .filter(function(i) { return i.offsetParent !== null; })
        .map(function(i) { return i.type + ':' + (i.id || i.name || '?'); });
      var btns = Array.from(document.querySelectorAll('button, a[href], div[role="button"]'))
        .filter(function(el) { return el.offsetParent !== null; })
        .map(function(el) { return el.tagName + '[' + (el.id || '').slice(0,20) + '] "' + (el.textContent||'').trim().slice(0,30) + '"'; })
        .slice(0, 12);
      var svcLinks = Array.from(document.querySelectorAll('a[href*="selectservice"]'))
        .filter(function(a) { return a.offsetParent !== null; })
        .map(function(a) { return (a.getAttribute('href') || '').slice(0, 80); });
      var stLinks  = Array.from(document.querySelectorAll('a[href*="selecttime"]'))
        .filter(function(a) { return a.offsetParent !== null; })
        .map(function(a) { return (a.getAttribute('href') || '').slice(0, 80); });
      return JSON.stringify({ hash, url, inputs, btns, svcLinks, stLinks });
    })()`);
    const d = JSON.parse(snap as string);
    console.log(`\n[DOM:${label}] ${d.url} | hash=${d.hash}`);
    if (d.svcLinks.length) console.log(`  service links (${d.svcLinks.length}): ${d.svcLinks.slice(0, 3).join(" | ")}`);
    if (d.stLinks.length)  console.log(`  selecttime links (${d.stLinks.length}): ${d.stLinks.slice(0, 3).join(" | ")}`);
    if (d.inputs.length)   console.log(`  inputs: ${d.inputs.join(", ")}`);
    if (d.btns.length)     console.log(`  btns: ${d.btns.join(" | ")}`);
  } catch (e) {
    console.warn(`[DOM:${label}] snapshot error: ${e}`);
  }
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
