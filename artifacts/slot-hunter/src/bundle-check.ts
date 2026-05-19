// ─── Bundle Check — Vérification quotidienne du bundle portail USA (clé AES) ─
// Extracted from index.ts

import { sendHeartbeat, type HunterJob } from "./convexClient.js";
import { USA_ENC_SEC_KEY, updateAesKey } from "./usaPortal.js";
import { proxyPool } from "./browser.js";
import { sendAdminBundleCheckReport, type BundleCheckReport } from "./adminReporting.js";
import { log } from "./scheduler-utils.js";
import {
  pausedJobs,
  completedJobs,
  consecutiveErrors,
  BUNDLE_CHECK_INTERVAL_MS,
  lastBundleCheckAt,
  setLastBundleCheckAt,
} from "./scheduler-state.js";

function extractAesKeyFromBundle(bundleText: string): string | null {
  const KEY_REGEX = /[A-Za-z0-9+/]{43}=/g;
  const CONTEXT_KEYWORDS = ["PBKDF2", "pbkdf2", "encryptSecretKey", "secretKey", "encKey", "AES", "CryptoJS", "encrypt"];

  for (const keyword of CONTEXT_KEYWORDS) {
    const idx = bundleText.indexOf(keyword);
    if (idx === -1) continue;
    const window = bundleText.slice(Math.max(0, idx - 300), idx + 300);
    const match = window.match(KEY_REGEX);
    if (match && match[0].length === 44) return match[0];
  }

  const allMatches = [...bundleText.matchAll(KEY_REGEX)]
    .map((m) => m[0])
    .filter((s) => s.length === 44);
  if (allMatches.length === 1) return allMatches[0];

  return null;
}

async function sendBundleReport(
  activeJobs: HunterJob[],
  bundleName: string,
  aesKeyValid: boolean,
  aesKeyAutoExtracted: boolean,
  currentAesKey: string,
  previousAesKey?: string,
): Promise<void> {
  try {
    const report: BundleCheckReport = {
      bundleName,
      aesKeyValid,
      aesKeyAutoExtracted,
      currentAesKey,
      previousAesKey,
      activeJobsCount: activeJobs.filter(j => j.hunterConfig?.isActive && !pausedJobs.has(j.id)).length,
      pausedJobsCount: pausedJobs.size,
      completedJobsCount: completedJobs.size,
      errorJobsCount: [...consecutiveErrors.values()].filter(v => v >= 3).length,
      jobDetails: activeJobs
        .filter(j => j.hunterConfig?.isActive)
        .slice(0, 20)
        .map(j => ({
          applicantName: j.applicantName,
          urgencyTier: j.urgencyTier,
          lastResult: j.hunterConfig.lastResult ?? "",
          lastCheckAt: j.hunterConfig.lastCheckAt ?? null,
        })),
      checkedAt: Date.now(),
      proxyPoolStatus: proxyPool.isConfigured ? `Gateway mode (eu.proxy.2captcha.com:2334)` : "Unconfigured (direct)",
      serverIp: proxyPool.getState().serverIp,
    };
    await sendAdminBundleCheckReport(report);
  } catch (err) {
    log("WARN", `[admin-report] Erreur envoi rapport: ${err}`);
  }
}

export async function checkPortalBundleKey(activeJobs: HunterJob[]): Promise<void> {
  const now = Date.now();
  if (now - lastBundleCheckAt < BUNDLE_CHECK_INTERVAL_MS) return;
  setLastBundleCheckAt(now);

  log("INFO", "🔍 Vérification bundle portail USA (quotidienne)...");

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
  const BUNDLE_CHECK_RETRY_MS = 30 * 60 * 1000;

  try {
    const htmlRes = await fetch("https://www.usvisaappt.com/visaapplicantui/", {
      headers: { "User-Agent": UA, "Accept": "text/html" },
    });
    const html = await htmlRes.text();
    const match = html.match(/src="(main\.[a-f0-9]+\.js)"/);
    if (!match) {
      log("WARN", "🔍 Bundle check : impossible de trouver le nom du bundle — retry dans 30 min");
      setLastBundleCheckAt(now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS);
      return;
    }
    const bundleName = match[1];

    const bundleRes = await fetch(`https://www.usvisaappt.com/visaapplicantui/${bundleName}`, {
      headers: {
        "User-Agent": UA,
        "Referer": "https://www.usvisaappt.com/visaapplicantui/login",
      },
    });
    if (!bundleRes.ok) {
      log("WARN", `🔍 Bundle check : téléchargement échoué (HTTP ${bundleRes.status}) — retry dans 30 min`);
      setLastBundleCheckAt(now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS);
      return;
    }
    const bundleText = await bundleRes.text();

    if (bundleText.includes(USA_ENC_SEC_KEY)) {
      log("INFO", `🔍 Bundle check ✅ — clé AES inchangée (bundle: ${bundleName})`);
      await sendBundleReport(activeJobs, bundleName, true, false, USA_ENC_SEC_KEY);
      return;
    }

    log("WARN", `🔍 Bundle check : clé AES introuvable dans ${bundleName} — extraction automatique en cours...`);
    const newKey = extractAesKeyFromBundle(bundleText);

    if (newKey) {
      const oldKey = USA_ENC_SEC_KEY;
      updateAesKey(newKey);
      log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      log("INFO", "🔑 CLÉ AES MISE À JOUR AUTOMATIQUEMENT — aucune action requise");
      log("INFO", `   Bundle         : ${bundleName}`);
      log("INFO", `   Ancienne clé   : ${oldKey}`);
      log("INFO", `   Nouvelle clé   : ${newKey}`);
      log("INFO", "   Les jobs USA reprennent avec la nouvelle clé immédiatement.");
      log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      await sendBundleReport(activeJobs, bundleName, true, true, newKey, oldKey);
      return;
    }

    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    log("ERROR", "🔴 ALERTE BUNDLE : clé AES changée ET extraction automatique impossible !");
    log("ERROR", `   Bundle actuel  : ${bundleName}`);
    log("ERROR", `   Clé en code    : ${USA_ENC_SEC_KEY}`);
    log("ERROR", "   ACTION REQUISE : inspecter le bundle manuellement,");
    log("ERROR", "   puis mettre à jour USA_ENC_SEC_KEY dans usaPortal.ts.");
    log("ERROR", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const usaJobs = activeJobs.filter((j) => j.destination === "usa");
    for (const job of usaJobs) {
      try {
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: `⚠️ Clé AES du portail USA changée (bundle: ${bundleName}) et extraction automatique impossible. Intervention requise.`,
          shouldPause: true,
        });
        log("WARN", `[${job.applicantName}] Mis en pause — clé AES périmée et non-extractible`);
      } catch (err) {
        log("WARN", `[${job.applicantName}] Erreur envoi pause heartbeat: ${err}`);
      }
    }
  } catch (err) {
    setLastBundleCheckAt(now - BUNDLE_CHECK_INTERVAL_MS + BUNDLE_CHECK_RETRY_MS);
    log("WARN", `🔍 Bundle check : erreur réseau — retry dans 30 min (${err})`);
  }
}
