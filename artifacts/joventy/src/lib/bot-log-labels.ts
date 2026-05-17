/**
 * Centralized bot log labels, narrative previews, and formatting utilities.
 * Shared between ApplicationDetail.tsx and BotLogs.tsx for consistency.
 */

// ─── Step Labels (narratifs avec emojis) ──────────────────────────────────────

export const STEP_LABELS: Record<string, string> = {
  // ── USA Portal — Cycle complet ──
  login: "🔑 Connexion portail",
  session_start: "🚀 Session démarrée",
  session_end: "🏁 Session terminée",
  appointment_status: "📋 Statut dossier",
  payment_check: "💳 Vérification paiement MRV",
  ofc_list: "🏛️ Bureaux consulaires",
  scan: "🔄 Scan créneaux",
  scan_cutoff: "⏰ Cutoff — token expire bientôt",
  cooldown: "⏳ Pause cooldown",
  slots_found: "🎉 CRÉNEAU DÉTECTÉ !",
  booking_attempt: "📝 Tentative réservation",
  booking_success: "✅ Réservation confirmée",
  booking_fail: "❌ Réservation échouée",
  confirmation_letter: "📄 Lettre de confirmation",
  not_found: "🔍 Aucun créneau disponible",
  error: "⚠️ Erreur",
  human_behavior: "🧠 Comportement humain",
  anti_detection: "🛡️ Anti-détection",
  execution_time: "⏱️ Temps d'exécution",

  // ── USA Portal — Refresh continu ──
  continuous_refresh_start: "🔄 Refresh continu démarré",
  continuous_refresh_window_done: "📺 Fenêtre terminée",
  continuous_refresh_end: "🏁 Refresh terminé",
  continuous_refresh_slot_detected: "🎉 CRÉNEAU DÉTECTÉ pendant le refresh !",

  // ── USA Portal — Erreurs spécifiques ──
  rate_limit: "⛔ Rate limit (429)",
  blocked: "🚫 Compte bloqué (403)",
  restricted: "🔒 Compte restreint (401)",
  token_expired: "🔄 Token expiré",
  restriction_skip: "🔒 Compte restreint — skip",
  scan_cap_reached: "🛑 Cap scans atteint",

  // ── USA Portal — Proxy & réseau ──
  keep_alive: "🏓 Keep-alive session",
  proxy_preflight_abort: "🛑 Proxy mort — session avortée",
  proxy_health_check: "🌐 Vérification santé proxy",

  // ── USA Portal — Retry 409 (conflit booking) ──
  "409_retry_start": "🔁 Retry 409 — conflit créneau",
  "409_retry_exhausted": "💨 Retry 409 épuisé",
  "409_retry_success": "✅ Retry 409 réussi !",

  // ── USA Portal — Anciens labels compatibles ──
  usa_login: "🔑 USA Login",
  usa_check_slots: "🔄 USA Scan créneaux",
  usa_slot_found: "📅 USA Créneau trouvé !",
  usa_no_slots: "🔍 USA Aucun créneau",
  usa_error: "⚠️ USA Erreur",

  // ── CEV Portal — Setup HTTP ──
  cev_http_setup_start: "🔧 Setup HTTP",
  cev_http_login_ok: "🔑 Login VOWINT",
  cev_http_login_failed: "❌ Login échoué",
  cev_http_vowint_cache_hit: "💨 Cache VOWINT",
  cev_http_app_id_found: "🆔 AppID trouvé",
  cev_http_integration_url: "🔗 URL Intégration",
  cev_http_cev_cookie_ok: "🍪 Cookie CEV",
  cev_http_hcaptcha_start: "🤖 hCaptcha",
  cev_http_hcaptcha_solved: "✅ hCaptcha résolu",
  cev_http_hcaptcha_failed: "❌ hCaptcha échoué",
  cev_http_captcha_response: "📨 Réponse captcha",
  cev_http_captcha_submit_failed: "❌ Captcha échoué",
  cev_http_validuntil_debug: "⏰ ValidUntil",
  cev_http_redirect_discovery: "🔀 Redirect discovery",
  cev_http_setup_complete: "✅ Setup terminé",
  cev_http_setup_error: "❌ Setup erreur",
  cev_http_no_integration_url: "⚠️ URL manquante",
  cev_http_no_cev_cookie: "⚠️ Cookie absent",
  cev_http_no_app_id: "⚠️ AppID absent",
  cev_captcha_submit: "📨 Captcha envoi",
  cev_redirect_probe: "🔀 Probe redirect",
  cev_no_availability: "🔍 Pas de créneaux",
  cev_slots_available: "📅 Créneaux dispo !",
  cev_session_expired: "⏰ Session expirée",
  cev_poll_result: "📊 Poll résultat",
  cev_poll_no_slots: "🔍 Poll: aucun slot",
  cev_slots_raw_response: "📦 Réponse brute",

  // ── CEV Portal — Booking ──
  cev_http_booking_start: "📝 Booking début",
  cev_http_booking_confirmed: "✅ Booking confirmé !",
  cev_http_selectslot_fetched: "📄 Page SelectSlot",
  cev_http_html_discovery: "🔎 Discovery HTML",
  cev_http_available_slots: "📅 Slots API",
  cev_http_slot_selected: "✅ Slot sélectionné",
  cev_http_submit_attempt: "📤 Soumission",
  cev_http_submit_response: "📥 Réponse soumission",
  cev_http_booking_crash: "💥 Booking crash",
};

// ─── Step Categories ──────────────────────────────────────────────────────────

export type LogCategory = "work" | "network" | "error" | "behavior" | "refresh";

export const STEP_CATEGORIES: Record<string, LogCategory> = {
  // Travail principal
  login: "work", session_start: "work", session_end: "work",
  appointment_status: "work", payment_check: "work", ofc_list: "work",
  scan: "work", slots_found: "work", booking_attempt: "work",
  booking_success: "work", booking_fail: "work", confirmation_letter: "work",
  not_found: "work", usa_login: "work", usa_check_slots: "work",
  usa_slot_found: "work", usa_no_slots: "work",
  // Refresh continu
  continuous_refresh_start: "refresh", continuous_refresh_window_done: "refresh",
  continuous_refresh_end: "refresh", continuous_refresh_slot_detected: "work",
  scan_cap_reached: "refresh",
  // CEV travail
  cev_http_setup_start: "work", cev_http_login_ok: "work", cev_http_app_id_found: "work",
  cev_http_setup_complete: "work", cev_slots_available: "work",
  cev_http_booking_start: "work", cev_http_booking_confirmed: "work",
  cev_http_slot_selected: "work", cev_http_submit_attempt: "work",
  cev_http_submit_response: "work", cev_no_availability: "work",
  cev_poll_result: "work", cev_poll_no_slots: "work",
  // Réseau / Proxy
  keep_alive: "network", proxy_preflight_abort: "network", proxy_health_check: "network",
  cev_http_vowint_cache_hit: "network", cev_http_integration_url: "network",
  cev_http_cev_cookie_ok: "network", cev_http_redirect_discovery: "network",
  cev_redirect_probe: "network", cev_http_selectslot_fetched: "network",
  // Erreurs
  error: "error", rate_limit: "error", blocked: "error", restricted: "error",
  token_expired: "error", restriction_skip: "error", scan_cutoff: "error",
  usa_error: "error",
  cev_http_login_failed: "error", cev_http_setup_error: "error",
  cev_http_hcaptcha_failed: "error", cev_http_captcha_submit_failed: "error",
  cev_http_no_integration_url: "error", cev_http_no_cev_cookie: "error",
  cev_http_no_app_id: "error", cev_session_expired: "error",
  cev_http_booking_crash: "error", "409_retry_exhausted": "error",
  // Comportement humain / anti-détection
  human_behavior: "behavior", anti_detection: "behavior", execution_time: "behavior",
  cooldown: "behavior", "409_retry_start": "behavior", "409_retry_success": "behavior",
  cev_http_hcaptcha_start: "behavior", cev_http_hcaptcha_solved: "behavior",
  cev_http_captcha_response: "behavior", cev_captcha_submit: "behavior",
};

export const CATEGORY_META: Record<LogCategory, { label: string; border: string; bg: string }> = {
  work:     { label: "Travail",       border: "border-l-blue-400",    bg: "" },
  refresh:  { label: "Refresh",       border: "border-l-indigo-400",  bg: "bg-indigo-50/20" },
  network:  { label: "Réseau",        border: "border-l-teal-400",    bg: "bg-teal-50/30" },
  error:    { label: "Erreur",        border: "border-l-red-400",     bg: "bg-red-50/20" },
  behavior: { label: "Comportement",  border: "border-l-purple-300",  bg: "bg-purple-50/20" },
};

export function getStepCategory(step: string): LogCategory {
  return STEP_CATEGORIES[step] ?? "work";
}

export function getStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step.replace(/_/g, " ");
}

// ─── Narrative Inline Preview (enrichi) ───────────────────────────────────────

/**
 * Generate a human-readable narrative string for a log entry based on its step and data.
 * Returns null if no narrative can be generated (falls back to generic preview).
 */
export function getNarrativePreview(step: string, data: Record<string, unknown> | null): string | null {
  if (!data) return null;

  switch (step) {
    case "continuous_refresh_start": {
      const budget = data.budgetMin ?? "?";
      const windows = data.maxWindows ?? "?";
      const offices = formatOfficesList(data.offices);
      const prediction = data.predictionWindow ?? "inconnue";
      return `Budget ${budget}min, ${windows} fenêtres max | ${offices} | prédiction: ${prediction}`;
    }

    case "continuous_refresh_window_done": {
      const num = data.windowNumber ?? "?";
      const refreshes = data.windowRefreshes ?? "?";
      const duration = data.windowDurationSec ?? "?";
      const durationMin = typeof duration === "number" ? Math.round(duration / 60) : duration;
      const landing = data.landingPageCount ?? 0;
      const firstAvail = data.firstAvailableMonthCount ?? 0;
      const health = typeof data.serverHealth === "number" ? (data.serverHealth >= 0.8 ? "sain" : "dégradé") : "?";
      return `Fenêtre #${num} — ${refreshes} refreshes en ${durationMin}min (landing: ${landing}, firstAvail: ${firstAvail}) | serveur: ${health}`;
    }

    case "continuous_refresh_end": {
      const total = data.totalRefreshes ?? "?";
      const windows = data.windowsCompleted ?? "?";
      const duration = data.totalDurationMin ?? "?";
      const slotFound = data.slotFound ?? data.reason === "slot_found";
      if (slotFound) return `${total} refreshes en ${duration}min, ${windows} fenêtres — CRÉNEAU TROUVÉ !`;
      return `${total} refreshes en ${duration}min, ${windows} fenêtres — aucun créneau`;
    }

    case "continuous_refresh_slot_detected": {
      const ofc = data.ofcName ?? data.ofc ?? "?";
      const date = data.date ?? "?";
      const time = data.time ?? "";
      return `CRÉNEAU à ${ofc} le ${date}${time ? ` à ${time}` : ""} !`;
    }

    case "proxy_health_check": {
      const ip = data.exitIp ?? "?";
      const latency = data.latencyMs ?? "?";
      const healthy = data.healthy;
      const mark = healthy ? "✓" : "✗";
      return `IP ${ip} — ${latency}ms ${mark}`;
    }

    case "scan_cutoff": {
      const reason = data.reason ?? "token expire bientôt";
      return `Arrêt scan — ${reason}`;
    }

    case "cooldown": {
      const remaining = data.remainingMs ?? data.pauseMinutes;
      if (typeof remaining === "number") {
        const min = remaining > 1000 ? Math.round(remaining / 60000) : remaining;
        return `Pause ${min} min restantes`;
      }
      return "Pause entre sessions";
    }

    case "restriction_skip": {
      const username = data.username ?? "?";
      return `Compte ${username} restreint — cycle ignoré`;
    }

    case "scan_cap_reached": {
      const count = data.scanCount ?? "?";
      const cap = data.scanCap ?? "?";
      const pause = data.pauseMinutes ?? "?";
      return `${count}/${cap} scans — pause ${pause}min`;
    }

    case "login": {
      const user = data.username ?? data.fullName ?? data.email ?? "";
      const appId = data.applicationId ?? "";
      if (user) return `Connecté en tant que ${user}${appId ? ` (ID: ${appId})` : ""}`;
      return null;
    }

    case "session_start": {
      const email = data.username ?? data.email ?? "";
      return email ? `Session démarrée — ${email}` : null;
    }

    case "session_end": {
      const duration = data.durationMin ?? data.totalDurationMin;
      if (typeof duration === "number") return `Session terminée (${duration}min)`;
      return null;
    }

    case "ofc_list": {
      const offices = formatOfficesList(data.offices);
      const visaClass = data.visaClass ?? "";
      if (offices) return `${offices}${visaClass ? ` (${visaClass})` : ""}`;
      return null;
    }

    case "scan": {
      const ofc = data.ofc ?? data.officeName ?? "";
      const result = data.slotsAvailable === true || data.hasSlots === true ? "créneau trouvé !" : "aucun créneau";
      if (ofc) return `${ofc} — ${result}`;
      return null;
    }

    case "slots_found": {
      const ofc = data.ofc ?? "?";
      const date = data.date ?? "?";
      const time = data.time ?? "";
      return `${ofc} — ${date}${time ? ` à ${time}` : ""}`;
    }

    case "booking_success": {
      const ofc = data.ofc ?? "";
      const date = data.date ?? "";
      const time = data.time ?? "";
      const appointmentId = data.appointmentId ?? "";
      return `${ofc} ${date} ${time}${appointmentId ? ` (ID: ${appointmentId})` : ""}`.trim();
    }

    case "booking_fail": {
      const msg = data.responseMsg ?? data.errorMessage ?? data.error ?? "raison inconnue";
      return `Échec — ${msg}`;
    }

    case "error": {
      const msg = data.errorMessage ?? data.error ?? data.message ?? "erreur inconnue";
      return typeof msg === "string" ? msg.slice(0, 120) : String(msg).slice(0, 120);
    }

    case "payment_check": {
      const status = data.paymentStatus ?? "?";
      return `Statut MRV: ${status}`;
    }

    default:
      return null;
  }
}

// ─── Object Formatting Utilities ──────────────────────────────────────────────

/**
 * Format an offices array/object into a readable string.
 * Handles: string[], {name, postName, postUserId}[], or raw objects.
 */
export function formatOfficesList(offices: unknown): string {
  if (!offices) return "";
  if (typeof offices === "string") return offices;
  if (Array.isArray(offices)) {
    const names = offices.map((item: unknown) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        const name = (obj.name ?? obj.postName ?? obj.label ?? "") as string;
        const postUserId = obj.postUserId;
        if (name && postUserId) return `${name} (postUserId: ${postUserId})`;
        return name || JSON.stringify(item);
      }
      return String(item);
    });
    return names.length <= 3 ? names.join(", ") : names.slice(0, 3).join(", ") + ` +${names.length - 3}`;
  }
  if (typeof offices === "object") {
    // Single object
    const obj = offices as Record<string, unknown>;
    const name = (obj.name ?? obj.postName ?? obj.label ?? "") as string;
    const postUserId = obj.postUserId;
    if (name && postUserId) return `${name} (postUserId: ${postUserId})`;
    if (name) return name;
  }
  return String(offices);
}

/**
 * Format a generic value for inline display (handles objects, arrays, primitives).
 * Prevents [object Object] from ever appearing.
 */
export function formatDataValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "boolean") return val ? "✓ oui" : "✗ non";
  if (typeof val === "number") {
    // Format durations
    if (key.toLowerCase().includes("ms") || key === "remainingMs" || key === "durationMs" || key === "restDurationMs" || key === "latencyMs") {
      return val >= 1000 ? `${(val / 1000).toFixed(1)}s` : `${val}ms`;
    }
    if (key.toLowerCase().includes("min") || key === "budgetMin" || key === "totalDurationMin" || key === "pauseMinutes") {
      return `${val}min`;
    }
    if (key.toLowerCase().includes("sec") || key === "windowDurationSec") {
      return val >= 60 ? `${Math.round(val / 60)}min ${Math.round(val % 60)}s` : `${val}s`;
    }
    return val.toLocaleString("fr-FR");
  }
  if (typeof val === "string") {
    if (val.length > 100) return val.slice(0, 100) + "…";
    return val;
  }
  if (Array.isArray(val)) {
    // Array of items — extract names
    const items = val.map((item: unknown) => {
      if (typeof item === "string" || typeof item === "number") return String(item);
      if (typeof item === "object" && item !== null) {
        const obj = item as Record<string, unknown>;
        return (obj.name ?? obj.postName ?? obj.label ?? JSON.stringify(item)) as string;
      }
      return String(item);
    });
    return items.length <= 4 ? items.join(", ") : items.slice(0, 4).join(", ") + ` +${items.length - 4}`;
  }
  if (typeof val === "object") {
    // Object — try to extract meaningful info
    const obj = val as Record<string, unknown>;
    // Known patterns
    if ("totalRefreshes" in obj && "windowsCompleted" in obj) {
      return `${obj.totalRefreshes} refreshes, ${obj.windowsCompleted} fenêtres`;
    }
    if ("name" in obj || "postName" in obj) {
      const name = (obj.name ?? obj.postName ?? "") as string;
      const id = obj.postUserId ?? obj.id ?? "";
      return id ? `${name} (ID: ${id})` : name;
    }
    // Generic fallback: list key=value pairs
    const entries = Object.entries(obj).slice(0, 4);
    const parts = entries.map(([k, v]) => `${k}: ${typeof v === "object" ? "…" : v}`);
    return parts.join(", ") + (Object.keys(obj).length > 4 ? " …" : "");
  }
  return String(val);
}

// ─── Deduplication (Login steps) ──────────────────────────────────────────────

/**
 * Detect and mark duplicate login entries.
 * Returns the list of log IDs to hide (less informative duplicates).
 */
export function findLoginDuplicates(logs: Array<{ _id: string; step: string; ts: number; data?: string | null }>): Set<string> {
  const duplicates = new Set<string>();
  const loginLogs = logs.filter(l => l.step === "login").sort((a, b) => a.ts - b.ts);

  // Group by proximity (within 5 seconds = same cycle)
  const groups: typeof loginLogs[] = [];
  let currentGroup: typeof loginLogs = [];

  for (const log of loginLogs) {
    if (currentGroup.length === 0) {
      currentGroup.push(log);
    } else {
      const lastTs = currentGroup[currentGroup.length - 1].ts;
      if (log.ts - lastTs < 5000) {
        currentGroup.push(log);
      } else {
        groups.push(currentGroup);
        currentGroup = [log];
      }
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  // For each group with >1 login, keep the one with most data, hide others
  for (const group of groups) {
    if (group.length <= 1) continue;
    // Score by data length
    const scored = group.map(log => ({
      log,
      score: (log.data ?? "").length,
    })).sort((a, b) => b.score - a.score);

    // Keep the first (most data), mark the rest as duplicates
    for (let i = 1; i < scored.length; i++) {
      duplicates.add(scored[i].log._id);
    }
  }

  return duplicates;
}

// ─── Session Duration Calculator ─────────────────────────────────────────────

export interface SessionInfo {
  startTs: number;
  endTs: number | null; // null = still active
  durationMs: number;
  durationDisplay: string;
  progress: number; // 0-1 for progress bar
  isActive: boolean;
}

/**
 * Calculate session info from log entries.
 * Looks for session_start and session_end to determine duration.
 */
export function calculateSessionInfo(
  logs: Array<{ step: string; ts: number; data?: string | null }>,
  targetDurationMin?: number
): SessionInfo | null {
  // Find the most recent session_start
  const sessionStarts = logs.filter(l => l.step === "session_start").sort((a, b) => b.ts - a.ts);
  if (sessionStarts.length === 0) return null;

  const start = sessionStarts[0];
  const startTs = start.ts;

  // Find the session_end AFTER this start
  const sessionEnd = logs.find(l => l.step === "session_end" && l.ts > startTs);
  const endTs = sessionEnd?.ts ?? null;
  const isActive = endTs === null;

  const now = Date.now();
  const effectiveEnd = endTs ?? now;
  const durationMs = effectiveEnd - startTs;

  // Target duration from data or default (45min)
  let target = (targetDurationMin ?? 45) * 60 * 1000;
  if (start.data) {
    try {
      const d = JSON.parse(start.data);
      if (d.targetDurationMin) target = d.targetDurationMin * 60 * 1000;
    } catch { /* ignore */ }
  }

  const progress = Math.min(1, durationMs / target);
  const mins = Math.floor(durationMs / 60000);
  const secs = Math.floor((durationMs % 60000) / 1000);
  const durationDisplay = isActive
    ? `Session active depuis ${mins}min ${secs.toString().padStart(2, "0")}s`
    : `Session terminée (${mins}min)`;

  return { startTs, endTs, durationMs, durationDisplay, progress, isActive };
}

// ─── Generic Preview (fallback when no narrative) ─────────────────────────────

/**
 * Generate a compact key=value preview for log data (fallback).
 */
export function getGenericPreview(data: Record<string, unknown>, maxFields: number = 4): string {
  const PRIORITY_KEYS = [
    "ofc", "date", "time", "slotId", "appointmentId", "username", "applicationId",
    "flow", "phase", "count", "offices", "paymentStatus", "visaClass",
    "message", "responseMsg", "errorMessage", "error",
    "finalDestinationUrl", "slotsAvailable", "isNoAvailability",
    "slotCount", "hasSlots", "httpStatus", "confirmationCode",
    "bookedDate", "bookedTime", "status", "remainingSeconds",
    "durationMs", "restDurationMs", "type", "latencyMs", "exitIp",
    "totalRefreshes", "windowsCompleted", "budgetMin", "windowNumber",
  ];

  const picks: string[] = [];

  for (const k of PRIORITY_KEYS) {
    if (k in data && data[k] !== null && data[k] !== undefined) {
      picks.push(`${k}=${formatDataValue(k, data[k])}`);
    }
    if (picks.length >= maxFields) break;
  }

  // If nothing from priority keys, take first N entries
  if (picks.length === 0) {
    const entries = Object.entries(data).slice(0, maxFields);
    for (const [k, v] of entries) {
      picks.push(`${k}=${formatDataValue(k, v)}`);
    }
  }

  return picks.join("  ·  ");
}
