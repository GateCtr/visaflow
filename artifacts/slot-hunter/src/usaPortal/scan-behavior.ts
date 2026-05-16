/**
 * scan-behavior.ts — Module anti-détection avancé
 * 
 * Corrige les patterns comportementaux détectables identifiés dans l'analyse
 * de la séquence de scan capturée (usa-fixe/ et captured/usa/).
 * 
 * PROBLÈMES CORRIGÉS :
 * 1. Polling excessif de getUserHistoryApplicantPaymentStatus (cache TTL 5 min)
 * 2. Distribution uniforme des pauses → distribution gamma/burst
 * 3. Events GA SUPPRIMÉS (16/05/2026) — signal de bot depuis serveur
 * 4. Round-robin OFC parfait → rotation imprévisible
 * 5. Timing régulier entre scans → pattern burst humain (F5 rapides puis pause longue)
 * 6. Requêtes API séquentielles → burst parallèle comme Angular
 * 
 * Créé le 16/05/2026 suite à l'analyse des captures réseau.
 */

import { usaFetch, getBrowserHeaders } from "./usa-http.js";
import { USA_BASE, REFERER_DASHBOARD } from "./config.js";
import { botLog } from "../convexClient.js";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. CACHE getUserHistoryApplicantPaymentStatus (TTL 5 min)
// ═══════════════════════════════════════════════════════════════════════════════
// Le bot appelait cette API ~40 fois en 126s. Un humain la déclenche 1-2 fois
// (chargement de page). Le portail peut détecter ce polling excessif.

interface PaymentStatusCacheEntry {
  data: unknown;
  cachedAt: number;
  applicationId: string | null;
}

const paymentStatusCache = new Map<string, PaymentStatusCacheEntry>();
const PAYMENT_STATUS_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Vérifie si le cache du payment status est encore valide pour un compte donné.
 * Retourne les données cachées ou null si le cache est expiré.
 */
export function getPaymentStatusFromCache(username: string): PaymentStatusCacheEntry | null {
  const key = username.toLowerCase();
  const entry = paymentStatusCache.get(key);
  if (!entry) return null;
  
  const age = Date.now() - entry.cachedAt;
  if (age > PAYMENT_STATUS_TTL_MS) {
    paymentStatusCache.delete(key);
    console.log(`[anti-detect] 💨 Cache paymentStatus expiré pour ${key.slice(0, 12)}… (${Math.round(age / 1000)}s > ${PAYMENT_STATUS_TTL_MS / 1000}s)`);
    return null;
  }
  
  const remainingSec = Math.round((PAYMENT_STATUS_TTL_MS - age) / 1000);
  console.log(`[anti-detect] ✅ Cache paymentStatus HIT pour ${key.slice(0, 12)}… (expire dans ${remainingSec}s)`);
  return entry;
}

/**
 * Met en cache le résultat de getUserHistoryApplicantPaymentStatus.
 */
export function setPaymentStatusCache(username: string, data: unknown, applicationId: string | null): void {
  const key = username.toLowerCase();
  paymentStatusCache.set(key, {
    data,
    cachedAt: Date.now(),
    applicationId,
  });
  console.log(`[anti-detect] 📦 Cache paymentStatus SET pour ${key.slice(0, 12)}… (TTL ${PAYMENT_STATUS_TTL_MS / 1000}s)`);
}

/**
 * Invalide le cache (ex: après un booking réussi ou un changement d'état).
 */
export function invalidatePaymentStatusCache(username: string): void {
  const key = username.toLowerCase();
  if (paymentStatusCache.has(key)) {
    paymentStatusCache.delete(key);
    console.log(`[anti-detect] 🗑️ Cache paymentStatus invalidé pour ${key.slice(0, 12)}…`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// 2. DISTRIBUTION GAMMA/BURST (remplace uniforme 300-3000ms)
// ═══════════════════════════════════════════════════════════════════════════════
// Un humain a des pauses avec distribution bimodale :
//   - Beaucoup de pauses très courtes (< 500ms) — transitions rapides
//   - Quelques pauses longues (5-15s) — réflexion, lecture
// La distribution uniforme [300, 3000] est un signal de bot (trop "moyen" en permanence).

/**
 * Distribution gamma approximée — produit des pauses plus réalistes.
 * shape=2, scale variable selon le contexte.
 */
function gammaRandom(shape: number = 2, scale: number = 1): number {
  // Méthode de Marsaglia-Tsang pour shape >= 1
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x: number, v: number;
    do {
      x = normalRandom();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

function normalRandom(): number {
  // Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Pause inter-étape avec distribution gamma (remplace randomInterStepPause uniforme).
 * 
 * Produit un pattern bimodal réaliste :
 * - 60% des pauses : 200-800ms (transitions rapides du navigateur Angular)
 * - 30% des pauses : 1-3s (humain qui lit/clique)
 * - 10% des pauses : 4-12s (humain distrait, regarde son téléphone)
 */
export async function burstInterStepPause(context: string = "", jobId?: string): Promise<void> {
  const r = Math.random();
  let delayMs: number;
  
  if (r < 0.60) {
    // Transitions rapides (Angular SPA — les requêtes partent vite)
    delayMs = 150 + gammaRandom(2, 150); // 150-600ms typiquement
  } else if (r < 0.90) {
    // Pauses moyennes (humain qui interagit)
    delayMs = 800 + gammaRandom(2, 600); // 800-3000ms typiquement
  } else {
    // Longues pauses rares (distraction)
    delayMs = 4000 + gammaRandom(1.5, 3000); // 4-12s
  }
  
  // Plafonner à 15s pour ne pas bloquer trop longtemps
  delayMs = Math.min(delayMs, 15000);
  
  if (delayMs > 2000) {
    console.log(`[burst] ${context}Pause ${Math.round(delayMs / 1000)}s (gamma)`);
  }
  
  await new Promise(resolve => setTimeout(resolve, delayMs));
}


// ═══════════════════════════════════════════════════════════════════════════════
// 3. SIMULATION ÉVÉNEMENTS GA/DAP
// ═══════════════════════════════════════════════════════════════════════════════
// Le vrai navigateur envoie des page_view et user_engagement vers Google Analytics.
// L'absence de ces événements dans une session longue (126s+) est détectable
// car le portail charge DAP (dap.digitalgov.gov) + GTM (G-CSLL4ZEK4L).

/**
 * SUPPRIMÉ le 16/05/2026 — Les events GA envoyés depuis le SERVEUR sont CONTRE-PRODUCTIFS.
 * 
 * Raison : Un vrai navigateur émet les hits GA depuis l'IP CLIENT (côté browser JS).
 * Le bot les envoyait depuis l'IP SERVEUR (Railway ou proxy résidentiel) — la même IP
 * qui fait les requêtes API. Cela crée une anomalie : un "navigateur" qui fait des XHR
 * API ET des hits GA depuis la même IP datacenter/résidentielle = signal de bot.
 * 
 * De plus, le portail ne vérifie PAS côté backend que les hits GA sont envoyés.
 * Le tracking GA est purement côté navigateur (gtag.js + DAP). L'absence de hits
 * n'est pas détectable par le serveur AVITS.
 * 
 * Fonction conservée comme no-op pour ne pas casser les imports existants.
 */
export async function sendGaPageView(
  _pageTitle: string = "AVITS Sign In",
  _pagePath: string = "/visaapplicantui/login",
  _sessionId?: string,
  _jobId?: string,
): Promise<void> {
  // No-op — supprimé volontairement (voir commentaire ci-dessus)
}

/**
 * SUPPRIMÉ le 16/05/2026 — Même raison que sendGaPageView (voir ci-dessus).
 * Les events GA depuis le serveur = anomalie réseau détectable.
 */
export async function sendGaEngagement(_engagementTimeMs: number = 10000, _jobId?: string): Promise<void> {
  // No-op — supprimé volontairement
}


// ═══════════════════════════════════════════════════════════════════════════════
// 4. ROUND-ROBIN OFC IMPRÉVISIBLE
// ═══════════════════════════════════════════════════════════════════════════════
// L'ancien code faisait : cursor = (cursor + 1) % N → pattern parfaitement prédictible.
// Un humain qui scanne plusieurs bureaux peut :
// - Revenir au même bureau 2 fois de suite (il a vu un créneau disparaître)
// - Sauter un bureau (il sait que Kinshasa n'a jamais rien)
// - Scanner tous les bureaux d'un coup (premier scan de la session)

interface OfcScanHistory {
  lastScannedIndex: number;
  scanCounts: Map<number, number>; // postUserId → nombre de scans
  lastScanTime: Map<number, number>; // postUserId → timestamp dernier scan
  consecutiveSameOfc: number;
}

const ofcScanHistories = new Map<string, OfcScanHistory>();

/**
 * Sélectionne le(s) OFC(s) à scanner ce cycle avec un comportement humain imprévisible.
 * 
 * Stratégie :
 * - Premier scan de session → scanner TOUS les OFCs (un humain fait ça)
 * - Scans suivants :
 *   - 60% du temps : OFC le moins récemment scanné (humain qui fait le tour)
 *   - 20% du temps : même OFC qu'au dernier scan (F5 frénétique)
 *   - 15% du temps : OFC aléatoire (humain qui change d'avis)
 *   - 5% du temps : scanner 2 OFCs d'un coup (humain qui compare)
 */
export function selectOfcsToScan<T extends { postUserId: number; postName?: string }>(
  applicationId: string,
  ofcList: T[],
  isFirstScanOfSession: boolean = false,
): T[] {
  if (ofcList.length <= 1) return ofcList;
  
  // Premier scan de la session → tous les OFCs
  if (isFirstScanOfSession) {
    console.log(`[anti-detect] 🔍 Premier scan session — scanning ${ofcList.length} OFC(s)`);
    return ofcList;
  }
  
  // Récupérer l'historique
  let history = ofcScanHistories.get(applicationId);
  if (!history) {
    history = {
      lastScannedIndex: -1,
      scanCounts: new Map(),
      lastScanTime: new Map(),
      consecutiveSameOfc: 0,
    };
    ofcScanHistories.set(applicationId, history);
  }
  
  const r = Math.random();
  let selected: T[];
  
  if (r < 0.60) {
    // Stratégie "tour" — OFC le moins récemment scanné (mais pas round-robin parfait)
    const sorted = [...ofcList].sort((a, b) => {
      const timeA = history!.lastScanTime.get(a.postUserId) ?? 0;
      const timeB = history!.lastScanTime.get(b.postUserId) ?? 0;
      return timeA - timeB; // Le plus ancien en premier
    });
    selected = [sorted[0]];
    history.consecutiveSameOfc = (sorted[0].postUserId === ofcList[history.lastScannedIndex]?.postUserId) ? history.consecutiveSameOfc + 1 : 0;
    console.log(`[anti-detect] 🔄 Stratégie "tour" — ${(selected[0] as any).postName ?? selected[0].postUserId}`);
  } else if (r < 0.80) {
    // Stratégie "F5" — même OFC (max 3 fois de suite)
    const lastIdx = history.lastScannedIndex;
    if (lastIdx >= 0 && lastIdx < ofcList.length && history.consecutiveSameOfc < 3) {
      selected = [ofcList[lastIdx]];
      history.consecutiveSameOfc++;
      console.log(`[anti-detect] 🔁 Stratégie "F5" — re-scan ${(selected[0] as any).postName ?? selected[0].postUserId} (${history.consecutiveSameOfc}x)`);
    } else {
      // Trop de répétitions → changer
      const idx = Math.floor(Math.random() * ofcList.length);
      selected = [ofcList[idx]];
      history.consecutiveSameOfc = 0;
      console.log(`[anti-detect] 🎲 F5 saturé → random ${(selected[0] as any).postName ?? selected[0].postUserId}`);
    }
  } else if (r < 0.95) {
    // Stratégie "random"
    const idx = Math.floor(Math.random() * ofcList.length);
    selected = [ofcList[idx]];
    history.consecutiveSameOfc = 0;
    console.log(`[anti-detect] 🎲 Stratégie "random" — ${(selected[0] as any).postName ?? selected[0].postUserId}`);
  } else {
    // Stratégie "comparaison" — 2 OFCs (rare)
    const shuffled = [...ofcList].sort(() => Math.random() - 0.5);
    selected = shuffled.slice(0, Math.min(2, ofcList.length));
    history.consecutiveSameOfc = 0;
    console.log(`[anti-detect] 👀 Stratégie "comparaison" — ${selected.map(o => (o as any).postName ?? o.postUserId).join(" + ")}`);
  }
  
  // Mettre à jour l'historique
  for (const ofc of selected) {
    history.lastScanTime.set(ofc.postUserId, Date.now());
    history.scanCounts.set(ofc.postUserId, (history.scanCounts.get(ofc.postUserId) ?? 0) + 1);
  }
  history.lastScannedIndex = ofcList.indexOf(selected[0]);
  
  return selected;
}


// ═══════════════════════════════════════════════════════════════════════════════
// 5. PATTERN BURST HUMAIN (F5 rapides puis pause longue)
// ═══════════════════════════════════════════════════════════════════════════════
// Un humain qui cherche un créneau a un comportement en "burst" :
// - Phase active : 3-6 F5 rapides espacés de 5-15 secondes
// - Phase repos : pause de 1-4 minutes (regarde son téléphone, fait autre chose)
// - Puis retour en phase active
// Le bot faisait des scans à intervalle régulier → signal de bot.

interface BurstState {
  currentPhase: "active" | "resting";
  activeScansRemaining: number;
  lastScanTime: number;
}

const burstStates = new Map<string, BurstState>();

/**
 * Calcule le délai avant le prochain scan basé sur le pattern burst humain.
 * 
 * Pattern observé chez un humain cherchant un créneau :
 * - Phase ACTIVE (3-6 checks) : intervalle 5-15s entre les checks
 * - Phase REPOS : pause de 60-240s (1-4 min)
 * 
 * @returns délai en ms avant le prochain scan
 */
export function getNextScanDelay(applicationId: string, jobId?: string): number {
  let state = burstStates.get(applicationId);
  
  if (!state) {
    // Nouveau burst
    state = {
      currentPhase: "active",
      activeScansRemaining: 3 + Math.floor(Math.random() * 4), // 3-6 scans
      lastScanTime: Date.now(),
    };
    burstStates.set(applicationId, state);
  }
  
  let delayMs: number;
  
  if (state.currentPhase === "active") {
    if (state.activeScansRemaining <= 0) {
      // Transition vers phase repos
      state.currentPhase = "resting";
      delayMs = 60000 + Math.random() * 180000; // 1-4 min de repos
      // Prochaine phase active aura un nouveau nombre de scans
      state.activeScansRemaining = 3 + Math.floor(Math.random() * 4);
      
      const restSec = Math.round(delayMs / 1000);
      console.log(`[burst] 😴 Phase repos: ${restSec}s (prochain burst: ${state.activeScansRemaining} scans)`);
      
      if (jobId) {
        botLog({
          applicationId: jobId,
          step: "human_behavior",
          status: "ok",
          data: { type: "burst_rest_phase", restDurationMs: delayMs, nextBurstScans: state.activeScansRemaining },
        });
      }
    } else {
      // En phase active — délai court avec variance gamma
      delayMs = 5000 + gammaRandom(2, 3000); // 5-15s typiquement
      state.activeScansRemaining--;
      
      console.log(`[burst] ⚡ Phase active: délai ${Math.round(delayMs / 1000)}s (${state.activeScansRemaining} restants)`);
    }
  } else {
    // Phase repos terminée → retour en phase active
    state.currentPhase = "active";
    delayMs = 2000 + Math.random() * 5000; // 2-7s (humain qui revient)
    
    console.log(`[burst] 🔄 Retour phase active: délai ${Math.round(delayMs / 1000)}s`);
  }
  
  state.lastScanTime = Date.now();
  return delayMs;
}

/**
 * Reset le burst state (ex: après un changement de session ou un booking).
 */
export function resetBurstState(applicationId: string): void {
  burstStates.delete(applicationId);
}


// ═══════════════════════════════════════════════════════════════════════════════
// 6. BURST PARALLÈLE (comme Angular SPA)
// ═══════════════════════════════════════════════════════════════════════════════
// Le navigateur Angular charge plusieurs APIs en parallèle lors d'une navigation :
// - Au chargement du dashboard : 5-6 requêtes en parallèle
// - Au clic sur "Reschedule" : getFirstAvailableMonth + getSlotDates ensemble
// Le bot faisait tout en séquence → timing séquentiel détectable.

/**
 * Exécute un groupe de requêtes API en parallèle avec un petit décalage (stagger).
 * Simule le comportement d'un navigateur qui lance plusieurs requêtes quasi-simultanément.
 * 
 * @param tasks - Tableau de fonctions à exécuter en parallèle
 * @param staggerMs - Décalage entre chaque lancement (50-200ms comme un vrai navigateur)
 * @returns Résultats des tâches (dans le même ordre)
 */
export async function parallelBurst<T>(
  tasks: Array<() => Promise<T>>,
  staggerMs: number = 80,
): Promise<Array<T | null>> {
  if (tasks.length === 0) return [];
  if (tasks.length === 1) return [await tasks[0]()];
  
  // Décalage stagger réaliste (le navigateur ne lance pas TOUT à la ms exacte)
  // Il y a un petit délai dû au parsing HTML/JS → 30-150ms entre les requêtes
  const results: Array<Promise<T | null>> = [];
  
  for (let i = 0; i < tasks.length; i++) {
    if (i > 0) {
      // Petit délai stagger (30-150ms) — simule le temps de parsing entre les requêtes
      const stagger = 30 + Math.random() * (staggerMs - 30);
      await new Promise(r => setTimeout(r, stagger));
    }
    
    // Lancer la tâche (ne pas await — parallèle)
    results.push(
      tasks[i]().catch((err) => {
        console.warn(`[burst-parallel] Tâche ${i} échouée: ${err}`);
        return null;
      })
    );
  }
  
  // Attendre toutes les tâches
  return Promise.all(results);
}

/**
 * Exécute les requêtes "dashboard" en parallèle comme Angular le ferait au chargement.
 * Le portail charge simultanément :
 * - getUserHistoryApplicantPaymentStatus
 * - getLandingPageDetails  
 * - count_dashboard
 * - componentAccess
 * 
 * Au lieu de les appeler séquentiellement, on les groupe en burst.
 */
export async function dashboardBurst(
  accessToken: string,
  referer: string = REFERER_DASHBOARD,
): Promise<void> {
  // Simuler le chargement parallèle du dashboard (uniquement les endpoints légers)
  // NOTE: On n'appelle PAS réellement tous ces endpoints car :
  // 1. getUserHistoryApplicantPaymentStatus est déjà appelé ailleurs avec cache
  // 2. Les autres sont optionnels pour le scan
  // 
  // Ce burst est un SIGNAL que le "navigateur" charge la page normalement.
  // On l'appelle une fois au début de la session pour simuler le landing page load.
  
  const headers: Record<string, string> = {
    ...getBrowserHeaders(),
    "Authorization": `Bearer ${accessToken}`,
    "Referer": referer,
    "LanguageId": "1", // L'intercepteur Angular l'envoie pour getLandingPageDeatils
  };
  
  try {
    // Seul getLandingPageDeatils est vraiment utile (keep-alive + simulation)
    const landingPromise = usaFetch(`${USA_BASE}/visaappointmentapi/appointments/getLandingPageDeatils`, {
      method: "GET",
      headers,
    }).catch(() => null);
    
    // Attendre avec un timeout raisonnable
    await Promise.race([
      landingPromise,
      new Promise(r => setTimeout(r, 8000)), // Timeout 8s
    ]);
  } catch {
    // Non-bloquant
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Détermine si c'est le premier scan d'une session (pour activer le burst initial).
 */
const sessionFirstScan = new Map<string, boolean>();

export function isFirstScanOfSession(applicationId: string): boolean {
  if (!sessionFirstScan.has(applicationId)) {
    sessionFirstScan.set(applicationId, true);
    return true;
  }
  return false;
}

export function markSessionStarted(applicationId: string): void {
  sessionFirstScan.set(applicationId, true);
}

export function markFirstScanDone(applicationId: string): void {
  sessionFirstScan.set(applicationId, false);
}

/**
 * Nettoyage des états en mémoire pour un compte/application.
 */
export function cleanupScanBehaviorState(applicationId: string): void {
  burstStates.delete(applicationId);
  ofcScanHistories.delete(applicationId);
  sessionFirstScan.delete(applicationId);
}
