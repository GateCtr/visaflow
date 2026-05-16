/**
 * Stratégie "Zero-Risk" - Multi-couche anti-détection
 * 
 * Combine plusieurs techniques pour réduire le risque de restriction à 0% :
 * 1. Session Duration Randomization
 * 2. Heatmap Avoidance  
 * 3. Anomaly Detection
 * 4. Graceful Degradation
 * 5. Behavioral Modeling
 * 6. Fingerprint Cycling
 */

import {
  SESSION_DURATION_PROFILES,
  ANOMALY_DETECTION_THRESHOLDS,
  SERVER_HEALTH_LEVELS,
  HUMAN_ACTION_MODEL,
  FINGERPRINT_CYCLES,
} from "./config.js";

// ── 1. Session Duration Randomization ────────────────────────────────────────

/**
 * Hash simple et déterministe pour la randomisation basée sur une seed
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convertir en 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Détermine une durée de session aléatoire mais déterministe pour un compte
 * Basé sur le username et le jour actuel pour la cohérence
 */
export function getRandomSessionDuration(username: string): number {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const seed = `${username}:${today}`;
  const hash = simpleHash(seed);
  const rand = (hash % 1000) / 1000; // 0.000 à 0.999
  
  let cumulative = 0;
  for (const profile of SESSION_DURATION_PROFILES) {
    cumulative += profile.weight;
    if (rand <= cumulative) {
      const durationMinutes = profile.min + Math.random() * (profile.max - profile.min);
      const durationMs = durationMinutes * 60 * 1000;
      console.log(`[zero-risk] 📊 Session profile: ${profile.min}-${profile.max}min → ${Math.round(durationMinutes)}min`);
      return durationMs;
    }
  }
  
  // Fallback: 50 minutes
  return 50 * 60 * 1000;
}

// ── 2. Heatmap Avoidance ─────────────────────────────────────────────────────

/**
 * SUPPRIMÉ le 16/05/2026 — Le Heatmap Avoidance contredit les Rush Hours.
 * 
 * Le système de Rush Hours dans index.ts accélère les scans pendant 7-9h et 12-14h
 * (heures où les créneaux apparaissent). Mais le Heatmap Avoidance bloquait 70-80%
 * des scans à 9h et 14h — exactement pendant les fenêtres les plus productives.
 * 
 * Un humain qui cherche frénétiquement un créneau ne "s'auto-évite" PAS pendant
 * les heures de pointe. Au contraire, c'est là qu'il est le PLUS actif.
 * 
 * La protection contre la surcharge serveur est déjà assurée par :
 * - L'anomaly detection (section 3) qui détecte les temps de réponse lents
 * - La graceful degradation (section 4) qui adapte l'intervalle à la santé serveur
 * 
 * Fonction conservée comme no-op pour ne pas casser les imports existants.
 */
export function shouldAvoidHeatmap(): { avoid: boolean; reason: string } {
  return { avoid: false, reason: "" };
}

// ── 3. Anomaly Detection ─────────────────────────────────────────────────────

export interface AnomalyMetrics {
  responseTimes: number[];
  errors: number[];
  captchas: number[];
  lastUpdate: number;
}

export class AnomalyDetector {
  private metrics: Map<string, AnomalyMetrics> = new Map();
  private errorCounts: Map<string, number> = new Map();
  private lastErrorTime: Map<string, number> = new Map();
  
  /**
   * Enregistre une métrique pour un compte
   */
  recordMetric(username: string, type: 'responseTime' | 'error' | 'captcha', value: number): void {
    const key = username.toLowerCase();
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, {
        responseTimes: [],
        errors: [],
        captchas: [],
        lastUpdate: Date.now(),
      });
    }
    
    const metrics = this.metrics.get(key)!;
    
    switch (type) {
      case 'responseTime':
        metrics.responseTimes.push(value);
        if (metrics.responseTimes.length > 50) metrics.responseTimes.shift();
        break;
      case 'error':
        metrics.errors.push(value);
        if (metrics.errors.length > 50) metrics.errors.shift();
        
        // Suivi des erreurs consécutives
        const now = Date.now();
        const lastError = this.lastErrorTime.get(key) || 0;
        if (now - lastError < ANOMALY_DETECTION_THRESHOLDS.errorWindowMs) {
          const currentCount = (this.errorCounts.get(key) || 0) + 1;
          this.errorCounts.set(key, currentCount);
        } else {
          this.errorCounts.set(key, 1);
        }
        this.lastErrorTime.set(key, now);
        break;
      case 'captcha':
        metrics.captchas.push(value);
        if (metrics.captchas.length > 50) metrics.captchas.shift();
        break;
    }
    
    metrics.lastUpdate = Date.now();
  }
  
  /**
   * Calcule un score de risque (0.0 à 1.0)
   */
  getRiskScore(username: string): number {
    const key = username.toLowerCase();
    const metrics = this.metrics.get(key);
    if (!metrics || metrics.responseTimes.length < 5) return 0.0;
    
    let riskScore = 0.0;
    let factorCount = 0;
    
    // 1. Temps de réponse anormal
    const recentResponses = metrics.responseTimes.slice(-10);
    const avgResponseTime = recentResponses.reduce((a, b) => a + b, 0) / recentResponses.length;
    if (avgResponseTime > ANOMALY_DETECTION_THRESHOLDS.responseTimeSpike) {
      const excess = (avgResponseTime - ANOMALY_DETECTION_THRESHOLDS.responseTimeSpike) / ANOMALY_DETECTION_THRESHOLDS.responseTimeSpike;
      riskScore += Math.min(excess, 1.0) * 0.3;
      factorCount++;
    }
    
    // 2. Taux d'erreur élevé
    if (metrics.errors.length > 0) {
      const errorRate = metrics.errors.filter(e => e >= 400).length / metrics.errors.length;
      if (errorRate > ANOMALY_DETECTION_THRESHOLDS.errorRateIncrease) {
        const excess = (errorRate - ANOMALY_DETECTION_THRESHOLDS.errorRateIncrease) / ANOMALY_DETECTION_THRESHOLDS.errorRateIncrease;
        riskScore += Math.min(excess, 1.0) * 0.4;
        factorCount++;
      }
    }
    
    // 3. Fréquence de captcha
    if (metrics.captchas.length > 0) {
      const captchaRate = metrics.captchas.filter(c => c === 1).length / metrics.captchas.length;
      if (captchaRate > ANOMALY_DETECTION_THRESHOLDS.captchaFrequency) {
        const excess = (captchaRate - ANOMALY_DETECTION_THRESHOLDS.captchaFrequency) / ANOMALY_DETECTION_THRESHOLDS.captchaFrequency;
        riskScore += Math.min(excess, 1.0) * 0.3;
        factorCount++;
      }
    }
    
    // 4. Erreurs consécutives
    const consecutiveErrors = this.errorCounts.get(key) || 0;
    if (consecutiveErrors >= ANOMALY_DETECTION_THRESHOLDS.consecutiveErrors) {
      riskScore += 0.5; // Bonus de risque pour erreurs consécutives
      console.warn(`[zero-risk] 🚨 ${username}: ${consecutiveErrors} erreurs consécutives!`);
    }
    
    return factorCount > 0 ? riskScore / factorCount : riskScore;
  }
  
  /**
   * Détermine si une pause est nécessaire et sa durée
   */
  shouldPause(username: string): { pause: boolean; durationMs: number; reason: string } {
    const riskScore = this.getRiskScore(username);
    
    if (riskScore < 0.3) {
      return { pause: false, durationMs: 0, reason: "" };
    }
    
    if (riskScore < 0.6) {
      return {
        pause: true,
        durationMs: 30 * 60 * 1000, // 30 minutes
        reason: `Risque modéré détecté (${Math.round(riskScore * 100)}%) - Pause 30min`
      };
    }
    
    if (riskScore < 0.8) {
      return {
        pause: true,
        durationMs: 60 * 60 * 1000, // 1 heure
        reason: `Risque élevé détecté (${Math.round(riskScore * 100)}%) - Pause 1h`
      };
    }
    
    // Risque critique
    this.errorCounts.delete(username.toLowerCase());
    this.lastErrorTime.delete(username.toLowerCase());
    
    return {
      pause: true,
      durationMs: 120 * 60 * 1000, // 2 heures
      reason: `🚨 RISQUE CRITIQUE (${Math.round(riskScore * 100)}%) - Pause 2h, reset counters`
    };
  }
  
  /**
   * Réinitialise les compteurs pour un compte
   */
  resetCounters(username: string): void {
    const key = username.toLowerCase();
    this.errorCounts.delete(key);
    this.lastErrorTime.delete(key);
    console.log(`[zero-risk] 🔄 Reset anomaly counters for ${username}`);
  }
}

// ── 4. Graceful Degradation ──────────────────────────────────────────────────

export class GracefulDegradation {
  private serverHealth: number = 1.0; // 1.0 = parfait, 0.0 = down
  private healthHistory: number[] = [];
  
  /**
   * Met à jour la santé du serveur basée sur les métriques récentes
   */
  updateHealth(responseTime: number, errorRate: number): void {
    // Métrique composite de santé serveur
    const responseScore = Math.max(0, 1 - responseTime / 10000); // 10s max = 0 score
    const errorScore = 1 - errorRate;
    
    const newHealth = (responseScore * 0.6 + errorScore * 0.4);
    
    // Lissage exponentiel
    this.serverHealth = this.serverHealth * 0.7 + newHealth * 0.3;
    
    // Garder l'historique
    this.healthHistory.push(this.serverHealth);
    if (this.healthHistory.length > 20) this.healthHistory.shift();
    
    const healthPercent = Math.round(this.serverHealth * 100);
    const trend = this.getHealthTrend();
    
    console.log(`[zero-risk] 🏥 Serveur: ${healthPercent}% ${trend}`);
  }
  
  /**
   * Calcule la tendance de santé
   */
  private getHealthTrend(): string {
    if (this.healthHistory.length < 5) return "";
    
    const recent = this.healthHistory.slice(-5);
    const older = this.healthHistory.slice(-10, -5);
    
    if (older.length === 0) return "";
    
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    
    const diff = recentAvg - olderAvg;
    
    if (diff > 0.1) return "📈";
    if (diff < -0.1) return "📉";
    return "➡️";
  }
  
  /**
   * Obtient les paramètres de scan adaptés à la santé du serveur
   */
  getScanParameters(): { intervalMs: number; timeoutMs: number; retries: number; level: string } {
    if (this.serverHealth >= SERVER_HEALTH_LEVELS.HEALTHY.threshold) {
      return { ...SERVER_HEALTH_LEVELS.HEALTHY, level: "HEALTHY" };
    } else if (this.serverHealth >= SERVER_HEALTH_LEVELS.DEGRADED.threshold) {
      return { ...SERVER_HEALTH_LEVELS.DEGRADED, level: "DEGRADED" };
    } else if (this.serverHealth >= SERVER_HEALTH_LEVELS.STRESSED.threshold) {
      return { ...SERVER_HEALTH_LEVELS.STRESSED, level: "STRESSED" };
    } else {
      return { ...SERVER_HEALTH_LEVELS.CRITICAL, level: "CRITICAL" };
    }
  }
  
  /**
   * Vérifie si le serveur est trop stressé pour scanner
   */
  shouldSkipScan(): boolean {
    return this.serverHealth < 0.2; // Skip si santé < 20%
  }
}

// ── 5. Behavioral Modeling ───────────────────────────────────────────────────

/**
 * Simule une action humaine avec timing réaliste
 */
export async function simulateHumanAction(action: keyof typeof HUMAN_ACTION_MODEL): Promise<void> {
  const config = HUMAN_ACTION_MODEL[action];
  const duration = config.min + Math.random() * (config.max - config.min);
  
  console.log(`[zero-risk] 👤 ${action} simulation: ${Math.round(duration / 1000)}s`);
  
  // Découper l'attente en chunks avec micro-pauses
  const chunkSize = 500 + Math.random() * 1000; // 0.5-1.5s
  let remaining = duration;
  
  while (remaining > 0) {
    const chunk = Math.min(chunkSize, remaining);
    await new Promise(r => setTimeout(r, chunk));
    remaining -= chunk;
    
    // 25% de chance de micro-action pendant l'attente
    if (Math.random() < 0.25 && remaining > 1000) {
      await simulateMicroAction();
    }
  }
}

/**
 * Simule une micro-action (déplacement souris, scroll, etc.)
 */
async function simulateMicroAction(): Promise<void> {
  const actions = [
    "🖱️ Micro-mouvement souris",
    "📜 Micro-scroll",
    "⌨️ Frappe clavier",
    "👀 Changement focus",
    "⏸️ Micro-pause"
  ];
  
  const action = actions[Math.floor(Math.random() * actions.length)];
  const delay = 50 + Math.random() * 150; // 50-200ms
  
  await new Promise(r => setTimeout(r, delay));
  
  if (Math.random() < 0.1) { // 10% de chance de log
    console.log(`[zero-risk] ${action} (+${Math.round(delay)}ms)`);
  }
}

/**
 * Choisit une action humaine aléatoire basée sur les probabilités
 */
export function getRandomHumanAction(): keyof typeof HUMAN_ACTION_MODEL {
  const rand = Math.random();
  let cumulative = 0;
  
  for (const [action, config] of Object.entries(HUMAN_ACTION_MODEL)) {
    cumulative += config.probability;
    if (rand <= cumulative) {
      return action as keyof typeof HUMAN_ACTION_MODEL;
    }
  }
  
  return 'thinking'; // fallback
}

// ── 6. Fingerprint Cycling ───────────────────────────────────────────────────

/**
 * Obtient l'empreinte digitale pour aujourd'hui basée sur le username
 */
export function getFingerprintForToday(username: string): typeof FINGERPRINT_CYCLES[0] {
  const today = new Date();
  const dayOfCycle = Math.floor(today.getTime() / (24 * 60 * 60 * 1000)) % FINGERPRINT_CYCLES.length;
  
  // Hash basé sur username pour varier légèrement le profil du jour
  const seed = `${username}:${dayOfCycle}`;
  const hash = simpleHash(seed);
  const variant = hash % 3; // 3 variantes possibles par profil
  
  const baseProfile = FINGERPRINT_CYCLES[dayOfCycle];
  
  // Créer une variante légère
  const variantProfile = { ...baseProfile };
  
  if (variant === 1) {
    // Variante 1: Changer légèrement la version Chrome
    variantProfile.ua = variantProfile.ua.replace(/Chrome\/\d+\.\d+\.\d+/, (match) => {
      const version = match.match(/\d+\.\d+\.\d+/)?.[0] || "136.0.0.0";
      const [major, minor] = version.split('.');
      const newMinor = Math.max(0, parseInt(minor) - 1);
      return `Chrome/${major}.${newMinor}.0.0`;
    });
  } else if (variant === 2) {
    // Variante 2: Changer légèrement la locale
    variantProfile.acceptLanguage = variantProfile.acceptLanguage.replace(/(\w+-\w+),/, (match, locale) => {
      const alternatives: Record<string, string[]> = {
        'fr-FR': ['fr-CD', 'fr-BE', 'fr-CH'],
        'en-US': ['en-CA', 'en-GB', 'en-AU'],
        'es-ES': ['es-MX', 'es-AR', 'es-CO'],
        'de-DE': ['de-AT', 'de-CH', 'de-LU'],
      };
      
      for (const [base, alts] of Object.entries(alternatives)) {
        if (locale.startsWith(base)) {
          const alt = alts[hash % alts.length];
          return `${alt},`;
        }
      }
      
      return match;
    });
  }
  
  console.log(`[zero-risk] 🆔 Fingerprint: jour ${dayOfCycle + 1}/7, variante ${variant + 1}`);
  return variantProfile;
}

// ── 7. Scan Orchestrator (Coordination multi-comptes) ────────────────────────

export class ScanOrchestrator {
  private scanWindows: Map<string, { start: number; end: number; accountIndex: number }> = new Map();
  private accountRegistry: Map<string, number> = new Map(); // username -> index
  
  /**
   * Enregistre un compte et lui assigne une fenêtre de scan
   */
  registerAccount(username: string, totalAccounts: number): void {
    const key = username.toLowerCase();
    
    if (this.accountRegistry.has(key)) {
      return; // Déjà enregistré
    }
    
    // Assigner un index basé sur le hash du username
    const hash = simpleHash(username);
    const accountIndex = hash % totalAccounts;
    this.accountRegistry.set(key, accountIndex);
    
    // Calculer la fenêtre de scan (répartie sur 24h)
    const windowDuration = (24 * 60 * 60 * 1000) / totalAccounts; // ms par compte
    const startOffset = accountIndex * windowDuration;
    
    // Ajouter du jitter (±15% de la fenêtre)
    const jitter = (Math.random() * 0.3 - 0.15) * windowDuration;
    
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const start = todayStart + startOffset + jitter;
    const end = start + windowDuration * 0.7; // Utiliser seulement 70% de la fenêtre
    
    this.scanWindows.set(key, { start, end, accountIndex });
    
    const startHour = new Date(start).getHours();
    const endHour = new Date(end).getHours();
    
    console.log(`[zero-risk] 🎯 ${username} → fenêtre ${startHour}h-${endHour}h (compte ${accountIndex + 1}/${totalAccounts})`);
  }
  
  /**
   * Vérifie si un compte peut scanner maintenant
   */
  canScanNow(username: string): { canScan: boolean; reason: string; waitMs?: number } {
    const key = username.toLowerCase();
    const window = this.scanWindows.get(key);
    
    if (!window) {
      return { canScan: true, reason: "No window assigned" };
    }
    
    const now = Date.now();
    
    if (now < window.start) {
      const waitMs = window.start - now;
      return {
        canScan: false,
        reason: `Fenêtre pas encore ouverte (dans ${Math.round(waitMs / 60000)}min)`,
        waitMs
      };
    }
    
    if (now > window.end) {
      // Prochaine fenêtre demain
      const nextStart = window.start + 24 * 60 * 60 * 1000;
      const waitMs = nextStart - now;
      return {
        canScan: false,
        reason: `Fenêtre fermée (prochaine dans ${Math.round(waitMs / 60000)}min)`,
        waitMs
      };
    }
    
    return { canScan: true, reason: "Dans la fenêtre assignée" };
  }
  
  /**
   * Obtient le temps d'attente avant la prochaine fenêtre
   */
  getTimeUntilNextWindow(username: string): number {
    const key = username.toLowerCase();
    const window = this.scanWindows.get(key);
    
    if (!window) return 0;
    
    const now = Date.now();
    
    if (now < window.start) {
      return window.start - now;
    }
    
    if (now > window.end) {
      const nextStart = window.start + 24 * 60 * 60 * 1000;
      return nextStart - now;
    }
    
    return 0; // Dans la fenêtre
  }
  
  /**
   * Réinitialise les fenêtres pour un nouveau jour
   */
  resetForNewDay(): void {
    this.scanWindows.clear();
    console.log("[zero-risk] 🔄 Fenêtres de scan réinitialisées pour nouveau jour");
  }
}

// ── Singleton global pour faciliter l'utilisation ────────────────────────────

export const anomalyDetector = new AnomalyDetector();
export const gracefulDegradation = new GracefulDegradation();
export const scanOrchestrator = new ScanOrchestrator();

/**
 * Initialise la stratégie Zero-Risk pour un compte
 */
export function initializeZeroRiskStrategy(username: string, totalAccounts: number = 1): void {
  // 1. Enregistrer dans l'orchestrateur
  scanOrchestrator.registerAccount(username, totalAccounts);
  
  // 2. Obtenir l'empreinte digitale du jour
  const fingerprint = getFingerprintForToday(username);
  console.log(`[zero-risk] 🆔 ${username}: ${fingerprint.platform}, ${fingerprint.timezone}, ${fingerprint.acceptLanguage.split(',')[0]}`);
  
  // 3. Déterminer la durée de session
  const sessionDuration = getRandomSessionDuration(username);
  console.log(`[zero-risk] ⏰ ${username}: session ${Math.round(sessionDuration / 60000)}min`);
}

/**
 * Vérifie toutes les conditions avant un scan
 */
export async function preScanCheck(
  username: string, 
  jobId: string
): Promise<{ proceed: boolean; reason: string; waitMs?: number }> {
  const checks: Array<{ name: string; result: boolean; reason: string; waitMs?: number }> = [];
  
  // 1. Heatmap avoidance
  const heatmapCheck = shouldAvoidHeatmap();
  checks.push({
    name: "Heatmap",
    result: !heatmapCheck.avoid,
    reason: heatmapCheck.reason || "OK"
  });
  
  // 2. Scan orchestrator
  const orchestratorCheck = scanOrchestrator.canScanNow(username);
  checks.push({
    name: "Orchestrator",
    result: orchestratorCheck.canScan,
    reason: orchestratorCheck.reason,
    waitMs: orchestratorCheck.waitMs
  });
  
  // 3. Anomaly detection
  const pauseCheck = anomalyDetector.shouldPause(username);
  checks.push({
    name: "Anomaly",
    result: !pauseCheck.pause,
    reason: pauseCheck.reason || "OK",
    waitMs: pauseCheck.durationMs
  });
  
  // 4. Server health
  const serverCheck = gracefulDegradation.shouldSkipScan();
  checks.push({
    name: "Server Health",
    result: !serverCheck,
    reason: serverCheck ? "Serveur en état critique" : "OK"
  });
  
  // Analyser les résultats
  const failedChecks = checks.filter(c => !c.result);
  
  if (failedChecks.length === 0) {
    return { proceed: true, reason: "Tous les checks passés" };
  }
  
  // Trouver la raison principale et le temps d'attente
  const mainFailure = failedChecks[0];
  const waitMs = mainFailure.waitMs || 0;
  
  // Log détaillé
  console.log(`[zero-risk] ⚠️ Pre-scan check FAILED for ${username}:`);
  checks.forEach(check => {
    const status = check.result ? "✅" : "❌";
    console.log(`  ${status} ${check.name}: ${check.reason}`);
  });
  
  return {
    proceed: false,
    reason: mainFailure.reason,
    waitMs
  };
}

/**
 * Post-scan: mettre à jour les métriques
 */
export function postScanUpdate(
  username: string,
  responseTime: number,
  hadError: boolean,
  hadCaptcha: boolean
): void {
  // Mettre à jour l'anomaly detector
  anomalyDetector.recordMetric(username, 'responseTime', responseTime);
  
  if (hadError) {
    anomalyDetector.recordMetric(username, 'error', 1);
  } else {
    anomalyDetector.recordMetric(username, 'error', 0);
  }
  
  if (hadCaptcha) {
    anomalyDetector.recordMetric(username, 'captcha', 1);
  } else {
    anomalyDetector.recordMetric(username, 'captcha', 0);
  }
  
  // Mettre à jour la santé serveur (simplifié)
  const errorRate = hadError ? 1.0 : 0.0;
  gracefulDegradation.updateHealth(responseTime, errorRate);
}

/**
 * Simule le comportement humain complet avant un scan
 */
export async function simulateFullHumanBehavior(): Promise<void> {
  console.log("[zero-risk] 👤 Simulation comportement humain...");
  
  // 1. Action aléatoire avant le scan
  const action = getRandomHumanAction();
  await simulateHumanAction(action);
  
  // 2. Petite pause entre les actions
  await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
  
  console.log("[zero-risk] 👤 Simulation terminée");
}