// ─── Germany RK-Termin Loop — Boucle de polling pour les dossiers Allemagne ─
// Filtre les jobs destination=germany, exécute le scan RK-Termin, rapporte au backend.

import { getActiveJobs, sendHeartbeat, reportSlotFound, botLog, type HunterJob } from "../convexClient.js";
import { runGermanyScan } from "../germanyPortal/rktermin-orchestrator.js";
import { RKTERMIN_TIMING, KINSHASA_CATEGORIES } from "../germanyPortal/config.js";
import type { RKTerminConfig, RKTerminDynamicField } from "../germanyPortal/types.js";

const log = (level: string, msg: string) => console.log(`[${new Date().toISOString()}] [germany-loop] [${level}] ${msg}`);

/** Jobs déjà complétés (évite de re-scanner). */
const completedJobs = new Set<string>();
/** Jobs en pause (erreur répétée). */
const pausedJobs = new Set<string>();
/** Dernier scan par job (pour respecter l'intervalle). */
const lastScanAt = new Map<string, number>();
/** Compteur d'erreurs consécutives par job (pour auto-pause). */
const consecutiveErrors = new Map<string, number>();

/**
 * Démarre la boucle Germany RK-Termin.
 * Tourne indéfiniment, scanne les dossiers allemagne actifs.
 */
export async function startGermanyLoop(): Promise<void> {
  log("INFO", "═══ GERMANY RK-TERMIN LOOP DÉMARRÉE ═══");
  log("INFO", "   → Scan périodique des créneaux ambassade allemande");
  log("INFO", "   → Portail: service2.diplo.de/rktermin");
  log("INFO", "   → Captcha: image JPEG base64 (2Captcha/CapSolver)");
  
  while (true) {
    try {
      await runGermanyCycle();
    } catch (err) {
      log("ERROR", `Cycle crash: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Attendre avant le prochain cycle
    const sleepMs = randomBetween(
      RKTERMIN_TIMING.pollingInterval.normal.min,
      RKTERMIN_TIMING.pollingInterval.normal.max,
    );
    log("DEBUG", `Prochain cycle dans ${Math.round(sleepMs / 60_000)} min`);
    await new Promise(r => setTimeout(r, sleepMs));
  }
}

/** Exécute un cycle de scan pour tous les dossiers Germany actifs. */
async function runGermanyCycle(): Promise<void> {
  let jobs: HunterJob[];
  try {
    jobs = await getActiveJobs();
  } catch (err) {
    log("ERROR", `Échec récupération jobs: ${err}`);
    return;
  }
  
  // Filtrer les jobs Allemagne actifs
  const germanyJobs = jobs.filter(j =>
    j.destination === "germany" &&
    j.hunterConfig?.isActive === true &&
    !completedJobs.has(j.id) &&
    !pausedJobs.has(j.id)
  );
  
  if (germanyJobs.length === 0) {
    log("DEBUG", "Aucun dossier Germany actif");
    return;
  }
  
  log("INFO", `${germanyJobs.length} dossier(s) Germany actif(s)`);
  
  for (const job of germanyJobs) {
    // Vérifier l'intervalle min entre scans
    const lastScan = lastScanAt.get(job.id) ?? 0;
    const elapsed = Date.now() - lastScan;
    const minInterval = RKTERMIN_TIMING.pollingInterval.normal.min;
    
    if (elapsed < minInterval) {
      const waitMin = Math.round((minInterval - elapsed) / 60_000);
      log("DEBUG", `${job.applicantName}: prochain scan dans ${waitMin} min`);
      continue;
    }
    
    await processGermanyJob(job);
    lastScanAt.set(job.id, Date.now());
    
    // Pause entre les jobs pour éviter de surcharger le portail
    await new Promise(r => setTimeout(r, randomBetween(5000, 15000)));
  }
}

/** Traite un dossier Germany individuel. */
async function processGermanyJob(job: HunterJob): Promise<void> {
  log("INFO", `─── Scan: ${job.applicantName} (${job.visaType}) ───`);
  // Log de début de scan (visible dans Admin > Logs du bot et sur la fiche dossier)
  botLog({
    applicationId: job.id,
    step: "germany_scan_start",
    status: "ok",
    data: { visaType: job.visaType }
  });
  
  const config = buildRKTerminConfig(job);
  if (!config) {
    log("ERROR", `Config invalide pour ${job.applicantName} — skip`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: "Configuration RK-Termin incomplète (scheduleUrl manquant ou mal formaté)",
      shouldPause: true,
    }).catch(() => {});
    pausedJobs.add(job.id);
    botLog({
      applicationId: job.id,
      step: "germany_config_invalid",
      status: "fail",
      data: { reason: "rktermin_config_invalid" }
    });
    return;
  }
  
  try {
    const result = await runGermanyScan(config, true);
    
    switch (result.status) {
      case "slot_found":
        if (result.booking?.status === "booked") {
          log("INFO", `🎉 SLOT CAPTURED pour ${job.applicantName}! N° ${result.booking.confirmationNumber}`);
          
          await reportSlotFound({
            applicationId: job.id,
            date: result.booking.bookedDate ?? "",
            time: result.booking.bookedTime ?? "",
            location: result.booking.bookedLocation ?? "Kinshasa",
            confirmationCode: result.booking.confirmationNumber,
          });
          
          await botLog({ applicationId: job.id, step: `🇩🇪 RDV Allemagne confirmé! N° ${result.booking.confirmationNumber} — ${result.booking.bookedDate} ${result.booking.bookedTime}`, status: "ok" });
          completedJobs.add(job.id);
          consecutiveErrors.delete(job.id);
        }
        break;
      
      case "not_found":
        log("INFO", `Pas de créneau pour ${job.applicantName} (${result.datesScanned} dates scannées, ${result.captchasSolved} captchas)`);
        await sendHeartbeat({
          applicationId: job.id,
          result: "not_found",
        }).catch(() => {});
        consecutiveErrors.delete(job.id);
        botLog({
          applicationId: job.id,
          step: "germany_not_found",
          status: "ok",
          data: { datesScanned: result.datesScanned, captchasSolved: result.captchasSolved }
        });
        break;
      
      case "captcha_failed":
        log("WARN", `Captcha échoué pour ${job.applicantName}`);
        await sendHeartbeat({
          applicationId: job.id,
          result: "captcha",
          errorMessage: "Captcha RK-Termin non résolu après retries",
        }).catch(() => {});
        // Ne compte pas comme erreur « métier » pour la pause automatique
        consecutiveErrors.delete(job.id);
        botLog({
          applicationId: job.id,
          step: "germany_captcha_failed",
          status: "warn",
        });
        break;
      
      case "error":
        log("ERROR", `Erreur scan ${job.applicantName}: ${result.errorMessage}`);
        const nb = (consecutiveErrors.get(job.id) ?? 0) + 1;
        consecutiveErrors.set(job.id, nb);
        const shouldPause = nb >= 3;
        await sendHeartbeat({
          applicationId: job.id,
          result: "error",
          errorMessage: result.errorMessage,
          shouldPause,
        }).catch(() => {});
        botLog({
          applicationId: job.id,
          step: "germany_error",
          status: "fail",
          data: { error: result.errorMessage, consecutiveErrors: nb, paused: shouldPause }
        });
        if (shouldPause) {
          pausedJobs.add(job.id);
          log("WARN", `${job.applicantName}: pause automatique après ${nb} erreurs consécutives`);
          botLog({
            applicationId: job.id,
            step: "germany_auto_pause",
            status: "warn",
            data: { consecutiveErrors: nb }
          });
        }
        break;
    }
    
    log("DEBUG", `Scan terminé en ${Math.round(result.durationMs / 1000)}s (${result.captchasSolved} captchas, ${result.datesScanned} dates)`);
    
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log("ERROR", `Exception non gérée pour ${job.applicantName}: ${errMsg}`);
    await sendHeartbeat({
      applicationId: job.id,
      result: "error",
      errorMessage: errMsg,
    }).catch(() => {});
    // Compter également pour la pause auto
    const nb = (consecutiveErrors.get(job.id) ?? 0) + 1;
    consecutiveErrors.set(job.id, nb);
    if (nb >= 3) {
      pausedJobs.add(job.id);
      log("WARN", `${job.applicantName}: pause automatique après ${nb} erreurs consécutives (exception)`);
    }
    botLog({
      applicationId: job.id,
      step: "germany_exception",
      status: "fail",
      data: { error: errMsg, consecutiveErrors: nb, paused: nb >= 3 }
    });
  }
}

// ─── Configuration Builder ──────────────────────────────────────────────────

/**
 * Construit la config RK-Termin depuis un HunterJob.
 * 
 * PRIORITÉ :
 * 1. scheduleUrl (si présent) — override manuel admin
 * 2. visaType du dossier → mapping automatique vers realmId/categoryId
 * 3. Défaut: Kinshasa Familienzusammenführung
 */
function buildRKTerminConfig(job: HunterJob): RKTerminConfig | null {
  const hc = job.hunterConfig;
  if (!hc) return null;
  
  // Mapping automatique visaType → locationCode/realmId/categoryId
  let locationCode = "kins";
  let realmId = 731;
  let categoryId = 3674;
  
  // Mapping basé sur le visaType du dossier
  const vt = (job.visaType ?? "").toLowerCase();
  
  if (vt.includes("regroupement") || vt.includes("familial") || vt.includes("familie") || vt.includes("zusammenführung")) {
    // Regroupement familial
    locationCode = "kins"; realmId = 731; categoryId = 3674;
  } else if (vt.includes("étud") || vt.includes("stud") || vt.includes("university") || vt.includes("université")) {
    // Études
    locationCode = "kins"; realmId = 731; categoryId = 3672;
  } else if (vt.includes("travail") || vt.includes("work") || vt.includes("erwerbst") || vt.includes("chancen") || vt.includes("fachkr") || vt.includes("formation") || vt.includes("ausbildung")) {
    // Travail / Chancenkarte / Formation
    locationCode = "kins"; realmId = 731; categoryId = 3675;
  } else if (vt.includes("au-pair") || vt.includes("au pair") || vt.includes("volontariat") || vt.includes("freiwillig")) {
    // Au-pair / Volontariat (même catégorie travail/formation à Kinshasa)
    locationCode = "kins"; realmId = 731; categoryId = 3675;
  } else if (vt.includes("langue") || vt.includes("sprach") || vt.includes("language")) {
    // Cours de langue (même catégorie travail/formation)
    locationCode = "kins"; realmId = 731; categoryId = 3675;
  } else if (vt.includes("tiers") || vt.includes("drittstaats") || vt.includes("third")) {
    // Ressortissant pays tiers
    locationCode = "kins"; realmId = 1505; categoryId = 3673;
  } else if (vt.includes("schengen") || vt.includes("court séjour") || vt.includes("tourisme") || vt.includes("affaires")) {
    // Schengen court séjour (tiers uniquement — pas congolais)
    locationCode = "kins"; realmId = 1276; categoryId = 3020;
  }
  // else: défaut = Familienzusammenführung (le plus demandé)
  
  // Override par scheduleUrl si présent (l'admin peut forcer une catégorie spécifique)
  if (hc.scheduleUrl) {
    try {
      const url = new URL(hc.scheduleUrl);
      locationCode = url.searchParams.get("locationCode") ?? locationCode;
      realmId = parseInt(url.searchParams.get("realmId") ?? String(realmId), 10);
      categoryId = parseInt(url.searchParams.get("categoryId") ?? String(categoryId), 10);
    } catch {
      // URL mal formée — garder le mapping automatique
      log("WARN", `scheduleUrl mal formée: ${hc.scheduleUrl} — utilisation du mapping visaType`);
    }
  }
  
  log("DEBUG", `Config: ${job.visaType} → ${locationCode}/realm=${realmId}/cat=${categoryId}`);
  
  // Données applicant : champs admin dédiés prioritaires, sinon parsing applicantName
  let firstname = hc.applicantFirstname?.trim() ?? "";
  let lastname = hc.applicantLastname?.trim() ?? "";

  if (!firstname || !lastname) {
    const nameParts = job.applicantName.includes(",")
      ? job.applicantName.split(",").map(s => s.trim()).reverse()
      : job.applicantName.split(" ");

    if (!firstname) firstname = nameParts[0] ?? "Inconnu";
    if (!lastname) lastname = nameParts.slice(1).join(" ") || nameParts[0] || "Inconnu";
  }
  
  // Email depuis embassyUsername (souvent l'email du client pour RK-Termin)
  const email = hc.embassyUsername || "";
  if (!email || !email.includes("@")) {
    log("WARN", `Email manquant ou invalide pour ${job.applicantName}: "${email}"`);
    return null;
  }
  
  // Champs dynamiques — extraits depuis portalApplicationId (format JSON)
  // Ex: {"nationality":"Kongolesisch","passportNumber":"OB1234567"}
  let dynamicFields: RKTerminDynamicField[] = [];
  
  if (hc.portalApplicationId) {
    try {
      const parsed = JSON.parse(hc.portalApplicationId) as {
        nationality?: string;
        passportNumber?: string;
        dateOfBirth?: string;
        fields?: RKTerminDynamicField[];
      };
      
      if (parsed.fields) {
        dynamicFields = parsed.fields;
      } else {
        // Format simplifié Kinshasa (realmId 731)
        if (parsed.nationality) {
          dynamicFields.push({ definitionId: 14389, index: 0, content: parsed.nationality });
        }
        if (parsed.passportNumber) {
          dynamicFields.push({ definitionId: 14390, index: 1, content: parsed.passportNumber });
        }
      }
    } catch {
      log("WARN", `portalApplicationId non parseable: ${hc.portalApplicationId}`);
    }
  }
  
  // Fallback: champs vides si pas configurés (le booking échouera mais le scan fonctionnera)
  if (dynamicFields.length === 0) {
    log("WARN", `Champs dynamiques non configurés pour ${job.applicantName} — scan seul (pas de booking)`);
  }
  
  return {
    locationCode,
    realmId,
    categoryId,
    locale: "en",
    applicantLastname: lastname,
    applicantFirstname: firstname,
    applicantEmail: email,
    dynamicFields,
    slotDateFrom: hc.slotDateFrom,
    slotDateDeadline: hc.slotDateDeadline,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
