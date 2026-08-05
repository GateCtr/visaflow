/**
 * test-saopola-booking-flow.ts — Test isolé du flux de booking Saopolo
 *
 * Valide le parcours complet : Aceptar → service click → agenda → calendar →
 * navigation mois suivant → clic heure → signupsecondappointment rendu.
 *
 * N'envoie JAMAIS de credentials réels — s'arrête dès que le formulaire signin
 * est visible dans le DOM (avant toute soumission).
 *
 * Profil Chrome SÉPARÉ (SPAIN_CF_PROFILE_DIR) pour ne pas perturber le scanner.
 *
 * Usage :
 *   cd artifacts/slot-hunter
 *   SPAIN_CF_PROFILE_DIR=/tmp/spain-booking-test-profile \
 *   SPAIN_SESSION_MODE=persistent-browser \
 *   npx tsx src/scripts/test-saopola-booking-flow.ts
 */

import "dotenv/config";
import { spainPersistentBrowser } from "../spain-persistent-browser.js";

// ── Portail Saopolo ──────────────────────────────────────────────────────────
const SAOPOLO_PORTAL =
  "https://www.citaconsular.es/es/hosteds/widgetdefault/2d01502f12dc08400e22aea87fb00ae34/";
const SERVICE_ID   = "bkt853215"; // PASAPORTES
// Slot connu actif en septembre (from scan)
const TARGET_DATE  = process.env.TEST_DATE  ?? "2026-09-01";
const TARGET_TIME  = process.env.TEST_TIME  ?? "09:00";
const AGENDA_ID    = process.env.TEST_AGENDA ?? "bkt301070";

// ── Helpers log ──────────────────────────────────────────────────────────────
const T0 = Date.now();
function ts() { return `+${((Date.now() - T0) / 1000).toFixed(1)}s`; }
function log(level: string, msg: string) {
  const icon: Record<string, string> = { INFO: "ℹ️ ", OK: "✅", WARN: "⚠️ ", ERR: "❌", STEP: "▶️ " };
  console.log(`[${ts()}] ${icon[level] ?? "  "} ${msg}`);
}
function section(title: string) {
  console.log(`\n${"═".repeat(72)}\n  ${title}\n${"═".repeat(72)}`);
}

// ── Utils DOM ────────────────────────────────────────────────────────────────
async function domSnapshot(page: import("puppeteer").Page, label: string) {
  try {
    const snap = await page.evaluate(`(function() {
      var hash = window.location.hash;
      var links = Array.from(document.querySelectorAll('a[href]'))
        .filter(function(a) { return a.offsetParent !== null; })
        .slice(0, 20)
        .map(function(a) { return (a.getAttribute('href') || '').slice(0, 80); });
      var inputs = Array.from(document.querySelectorAll('input'))
        .filter(function(i) { return i.offsetParent !== null; })
        .map(function(i) { return i.type + ':' + (i.id || i.name || '?'); });
      var selecttimeLinks = Array.from(document.querySelectorAll('a[href*="selecttime"]'))
        .filter(function(a) { return a.offsetParent !== null; })
        .map(function(a) { return (a.getAttribute('href') || '').slice(0, 100); });
      var serviceLinks = Array.from(document.querySelectorAll('a[href*="selectservice"]'))
        .filter(function(a) { return a.offsetParent !== null; })
        .map(function(a) { return (a.getAttribute('href') || '').slice(0, 80); });
      var aceptarBtns = Array.from(document.querySelectorAll('button,a,[role="button"]'))
        .filter(function(el) {
          return el.offsetParent !== null &&
            /aceptar|accept|continuar|continue/i.test((el.textContent || '').trim());
        })
        .map(function(el) { return el.tagName + '#' + (el.id || '?') + ' "' + (el.textContent || '').trim().slice(0,30) + '"'; });
      return JSON.stringify({ hash, links, inputs, selecttimeLinks, serviceLinks, aceptarBtns });
    })()`);
    const data = JSON.parse(snap as string);
    console.log(`\n[DOM:${label}] hash=${data.hash}`);
    if (data.serviceLinks.length)    console.log(`  service links: ${data.serviceLinks.join(" | ")}`);
    if (data.selecttimeLinks.length) console.log(`  selecttime links (${data.selecttimeLinks.length}): ${data.selecttimeLinks.slice(0,5).join(" | ")}`);
    if (data.aceptarBtns.length)     console.log(`  aceptar btns: ${data.aceptarBtns.join(" | ")}`);
    if (data.inputs.length)          console.log(`  inputs: ${data.inputs.join(", ")}`);
    return data;
  } catch (e) {
    console.warn(`[DOM:${label}] snapshot error: ${e}`);
    return {};
  }
}

// ── Navigate to month in calendar ────────────────────────────────────────────
async function navigateCalendarToMonth(
  page: import("puppeteer").Page,
  targetYYYYMM: string,
  maxClicks = 4,
): Promise<boolean> {
  for (let i = 0; i < maxClicks; i++) {
    // Current calendar month from datepicker header or first selecttime href
    const currentMonth = await page.evaluate(`(function() {
      // Try to read from a selecttime href
      var link = document.querySelector('a[href*="selecttime"]');
      if (link) {
        var m = (link.getAttribute('href') || '').match(/selecttime\\/([0-9]{4}-[0-9]{2})/);
        if (m) return m[1];
      }
      // Try datepicker title
      var title = document.querySelector('.ui-datepicker-title');
      if (title) return 'PARSED:' + title.textContent;
      return null;
    })()`).catch(() => null) as string | null;

    if (currentMonth && currentMonth.startsWith(targetYYYYMM)) {
      log("OK", `Calendrier déjà sur mois cible ${targetYYYYMM}`);
      return true;
    }

    // Check if any selecttime link for the target month already visible
    const hasTarget = await page.evaluate((mo: string) => {
      return Array.from(document.querySelectorAll('a[href*="selecttime"]'))
        .some(function(a) { return (a.getAttribute('href') || '').includes('selecttime/' + mo); });
    }, targetYYYYMM).catch(() => false) as boolean;

    if (hasTarget) {
      log("OK", `Liens selecttime/${targetYYYYMM} déjà visibles`);
      return true;
    }

    log("INFO", `Tentative navigation → mois suivant (essai ${i+1}/${maxClicks})…`);

    // Wait for a datetime/ response after clicking next
    const dtCapture = new Promise<string>((resolve) => {
      const handler = async (resp: import("puppeteer").HTTPResponse) => {
        if (resp.url().includes("/datetime/")) {
          const body = await resp.text().catch(() => "");
          if (body.length > 20) { resolve(body); page.off("response", handler); }
        }
      };
      page.on("response", handler);
      setTimeout(() => { page.off("response", handler); resolve(""); }, 8_000);
    });

    const clicked = await page.evaluate(`(function() {
      var candidates = Array.from(document.querySelectorAll(
        ".ui-datepicker-next, .fc-next-button, " +
        "[class*='next'][class*='month'], [class*='month'][class*='next'], " +
        "[class*='calendar'] [class*='next'], [class*='cal'] [class*='next'], " +
        "a.next, button.next, span.next, i.next, " +
        "a[title*='siguiente'], a[title*='next'], button[title*='next'], " +
        "a[aria-label*='next'], button[aria-label*='next'], " +
        ".ui-icon-circle-triangle-e, [class*='datepicker-next']"
      ));
      for (var j = 0; j < candidates.length; j++) {
        if (candidates[j].offsetParent) {
          candidates[j].click();
          return 'clicked:' + candidates[j].className.slice(0, 60);
        }
      }
      return null;
    })()`).catch(() => null) as string | null;

    if (!clicked) {
      log("WARN", "Bouton mois suivant introuvable dans le DOM");
      break;
    }
    log("INFO", `Bouton cliqué (${clicked}) — attente datetime/…`);
    const dtRaw = await dtCapture;
    log("INFO", `datetime/ reçu: ${dtRaw.length}B`);
    if (dtRaw.length > 0) {
      const mo = dtRaw.match(/"date"\s*:\s*"(\d{4}-\d{2})/)?.[1]
              ?? dtRaw.match(/"maxDays"\s*:\s*"(\d{4}-\d{2})/)?.[1];
      if (mo) log("INFO", `Calendrier maintenant sur ${mo}`);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }

  // Final check
  const finalHas = await page.evaluate((mo: string) => {
    return Array.from(document.querySelectorAll('a[href*="selecttime"]'))
      .some(function(a) { return (a.getAttribute('href') || '').includes('selecttime/' + mo); });
  }, targetYYYYMM).catch(() => false) as boolean;
  return finalHas;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  section(`TEST BOOKING FLOW SAOPOLO — ${new Date().toISOString()}`);
  log("INFO", `Portail : ${SAOPOLO_PORTAL}`);
  log("INFO", `Cible   : ${TARGET_DATE} ${TARGET_TIME} (agenda=${AGENDA_ID})`);
  log("INFO", `Profil Chrome : ${process.env.SPAIN_CF_PROFILE_DIR ?? "/tmp/spain-cf-profile (défaut)"}`);

  // ── Étape 1 : session CF + widget ──────────────────────────────────────────
  section("ÉTAPE 1 — Obtention session CF + widget (profil séparé)");

  spainPersistentBrowser.setCurrentTargetUrl(SAOPOLO_PORTAL);
  const { ensureSpainPersistentBrowserSession } = await import("../spain-persistent-browser.js");
  const session = await ensureSpainPersistentBrowserSession(SAOPOLO_PORTAL);

  if (!session) {
    log("ERR", "Impossible d'obtenir une session CF — arrêt");
    process.exit(1);
  }
  log("OK", `Session CF obtenue — source=${session.source}`);

  const page = spainPersistentBrowser.getActivePage();
  if (!page) { log("ERR", "Page Chromium non disponible"); process.exit(1); }

  await domSnapshot(page, "après-session");

  // ── Étape 2 : prepareWidgetForBooking ─────────────────────────────────────
  section("ÉTAPE 2 — prepareWidgetForBooking (Aceptar + services)");

  const prepared = await spainPersistentBrowser.prepareWidgetForBooking();
  log(prepared ? "OK" : "WARN", `prepareWidgetForBooking → ${prepared}`);
  await domSnapshot(page, "après-prepare");

  if (!prepared) {
    log("WARN", "prepareWidgetForBooking échoué — tentative directe quand même");
  }

  // ── Étape 3 : clic service + capture getagendas/ + datetime/ ──────────────
  section("ÉTAPE 3 — clickServiceAndCaptureSlots");

  const nativeCapture = await spainPersistentBrowser.clickServiceAndCaptureSlots({
    preferredServiceId: SERVICE_ID,
    agTimeoutMs: 10_000,
    dtTimeoutMs: 10_000,
  });

  if (!nativeCapture) {
    log("ERR", "clickServiceAndCaptureSlots → null (aucun lien selectservice dans DOM)");
    await domSnapshot(page, "après-click-service-null");
    process.exit(1);
  }

  log("INFO", `getagendas/ → ${nativeCapture.getagendasRaw.length}B`);
  log("INFO", `datetime/ capturés → ${nativeCapture.datetimeRaws.length} mois`);
  log("INFO", `href cliqué → ${nativeCapture.clickedHref}`);

  if (nativeCapture.getagendasRaw.length === 0) {
    log("WARN", "getagendas/ redirect — widget revenu sur #services");
    log("WARN", "→ Problème d'état PHP : le clic service ne déclenche pas getagendas/ valide");
    log("WARN", "→ Cause probable : prepareWidgetForBooking clique le container div, pas le vrai bouton Aceptar HTTP");

    // Dump the idBktDefaultCustomContainer HTML to diagnose
    const containerHtml = await page.evaluate(`
      var el = document.getElementById('idBktDefaultCustomContainer');
      el ? el.outerHTML.slice(0, 1200) : 'absent';
    `).catch(() => "error");
    log("INFO", `HTML idBktDefaultCustomContainer:\n${containerHtml}`);
  }

  await domSnapshot(page, "après-click-service");

  // ── Étape 4 : navigation mois cible ───────────────────────────────────────
  section("ÉTAPE 4 — Navigation vers mois cible");

  const targetMonth = TARGET_DATE.slice(0, 7); // "YYYY-MM"
  log("INFO", `Mois cible : ${targetMonth}`);

  const monthOk = await navigateCalendarToMonth(page, targetMonth);
  log(monthOk ? "OK" : "WARN", `Navigation mois → ${monthOk ? "succès" : "échec"}`);

  await domSnapshot(page, "après-nav-mois");

  // ── Étape 5 : navigateToSelecttime ────────────────────────────────────────
  section("ÉTAPE 5 — navigateToSelecttime");

  const { navigateToSelecttime } = await import("../spain-persistent-browser.js");
  const navResult = await navigateToSelecttime(TARGET_DATE, TARGET_TIME, AGENDA_ID, SAOPOLO_PORTAL);

  log(navResult ? "OK" : "ERR", `navigateToSelecttime → hash=${navResult || "aucun"}`);

  if (!navResult) {
    await domSnapshot(page, "après-selecttime-échec");

    // Dump tous les liens selecttime disponibles
    const availableLinks = await page.evaluate(`
      Array.from(document.querySelectorAll('a[href*="selecttime"]'))
        .map(function(a) { return (a.getAttribute('href') || ''); })
        .slice(0, 20)
        .join('\\n');
    `).catch(() => "error");
    log("INFO", `Liens selecttime disponibles :\n${availableLinks}`);
    process.exit(1);
  }

  // ── Étape 6 : vérification formulaire signin ───────────────────────────────
  section("ÉTAPE 6 — Vérification formulaire signupsecondappointment");

  log("INFO", `Hash actuel : ${navResult}`);

  // Attendre que Backbone rende le formulaire
  try {
    await page.waitForSelector(
      '#idBktSigninLogin, #idBktLogin, [name="login"], input[type="text"], input[type="email"]',
      { visible: true, timeout: 12_000 },
    );
    log("OK", "✅✅✅ Formulaire signin visible — signupsecondappointment correctement rendu !");
    await domSnapshot(page, "formulaire-signin-visible");
  } catch {
    log("ERR", "Formulaire login non visible après 12s");
    await domSnapshot(page, "formulaire-signin-absent");

    const getsigninfields = await page.evaluate(`
      (function() {
        var hash = window.location.hash;
        var body = document.body ? document.body.innerText.slice(0, 400) : 'no body';
        return JSON.stringify({ hash, body });
      })()
    `).catch(() => "{}");
    log("INFO", `État DOM : ${getsigninfields}`);
  }

  log("OK", "Test terminé — aucune donnée réelle envoyée");
  await new Promise<void>((r) => setTimeout(r, 2_000));
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
