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
  session_skip: "⏭️ Session ignorée",
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

  // ── OFC Watcher — Parallèle ──
  ofc_watcher_started: "→ Watcher démarré",
  ofc_watcher_summary: "▪ Watcher actif",
  ofc_watcher_session_end: "🏁 Watcher arrêté",
  ofc_watcher_slot_detected: "! SLOT détecté !",
  ofc_watcher_scan: "🔄 Scan watcher",
  accounts_status: "👥 Status comptes",
  booking_race_complete: "🏁 Booking race terminée",
  booking_race_success: "🏆 Booking réussi !",
  proxy_failover: "🔄 Failover proxy",

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
  // OFC Watcher
  ofc_watcher_started: "work", ofc_watcher_summary: "refresh",
  ofc_watcher_session_end: "work", ofc_watcher_slot_detected: "work",
  ofc_watcher_scan: "refresh", accounts_status: "network",
  booking_race_complete: "work", booking_race_success: "work",
  proxy_failover: "network",
  // Réseau / Proxy
  keep_alive: "network", proxy_preflight_abort: "network", proxy_health_check: "network",
  cev_http_vowint_cache_hit: "network", cev_http_integration_url: "network",
  cev_http_cev_cookie_ok: "network", cev_http_redirect_discovery: "network",
  cev_redirect_probe: "network", cev_http_selectslot_fetched: "network",
  // Erreurs
  error: "error", rate_limit: "error", blocked: "error", restricted: "error",
  token_expired: "error", restriction_skip: "error", scan_cutoff: "error",
  session_skip: "error",
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
      let durationStr: string;
      if (typeof duration === "number") {
        const mins = Math.floor(duration / 60);
        const secs = Math.round(duration % 60);
        durationStr = mins > 0 ? `${mins}min${secs > 0 ? ` ${secs}s` : ""}` : `${secs}s`;
      } else if (typeof duration === "string") {
        durationStr = duration;
      } else {
        durationStr = "?";
      }
      const landing = data.landingPageCount ?? 0;
      const firstAvail = data.firstAvailableMonthCount ?? 0;
      const health = typeof data.serverHealth === "number" ? (data.serverHealth >= 0.8 ? "sain" : "dégradé") : "?";
      return `Fenêtre #${num} — ${refreshes} refreshes en ${durationStr} (landing: ${landing}, firstAvail: ${firstAvail}) | serveur: ${health}`;
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
      const mark = healthy ? "✓ oui" : "✗ non";
      const threshold = data.thresholdMs;
      const latencyStr = typeof latency === "number"
        ? (latency >= 1000 ? `${(latency / 1000).toFixed(1)}s` : `${latency}ms`)
        : `${latency}`;
      const thresholdStr = threshold && typeof threshold === "number"
        ? ` (seuil: ${threshold >= 1000 ? `${(threshold / 1000).toFixed(1)}s` : `${threshold}ms`})`
        : "";
      return `IP ${ip} — ${latencyStr} ${mark}${thresholdStr}`;
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

    case "login": {
      const user = data.username ?? data.fullName ?? data.email ?? "";
      const appId = data.applicationId ?? "";
      const userId = data.userID ?? "";
      const missionId = data.missionId ?? "";
      const csrf = data.csrfToken;
      if (user) {
        let details = `Connecté en tant que ${user}`;
        if (userId) details += ` (userID: ${userId})`;
        else if (appId) details += ` (ID: ${appId})`;
        if (missionId) details += ` — mission ${missionId}`;
        if (csrf === "ABSENT") details += " — CSRF absent";
        return details;
      }
      return null;
    }

    case "session_start": {
      const portal = data.portal ?? "";
      const email = data.username ?? data.email ?? "";
      if (portal) return `${portal}`;
      if (email) return `Session démarrée — ${email}`;
      return null;
    }

    case "session_end": {
      const portal = data.portal ?? "";
      const duration = data.duration ?? data.durationMin ?? data.totalDurationMin ?? "";
      const hunterPause = data.hunterPaused ?? data.hunterStatus;
      let text = "";
      if (portal) text = `${portal}`;
      if (duration) {
        const durStr = typeof duration === "number" ? `${duration}min` : String(duration);
        text += text ? ` — durée: ${durStr}` : `Session terminée (${durStr})`;
      }
      if (hunterPause) text += " · Hunter en pause";
      return text || null;
    }

    case "ofc_list": {
      const offices = formatOfficesList(data.offices);
      const visaClass = data.visaClass ?? "";
      const visaType = data.visaType ?? "";
      const count = data.count;
      let text = "";
      if (offices) text = offices;
      else if (typeof count === "number") text = `${count} bureau${count > 1 ? "x" : ""}`;
      if (visaClass || visaType) {
        const visa = [visaClass, visaType].filter(Boolean).join("/");
        text += text ? ` (${visa})` : visa;
      }
      return text || null;
    }

    case "scan": {
      const ofc = data.ofc ?? data.officeName ?? "";
      const phase = data.phase ?? "";
      const hasSlots = data.slotsAvailable === true || data.hasSlots === true;
      const result = hasSlots ? "créneau trouvé !" : "aucun créneau";
      if (ofc && phase) return `${ofc} — ${phase} — ${result}`;
      if (ofc) return `${ofc} — ${result}`;
      if (phase) return `${phase} — ${result}`;
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
      const via = data.via ?? "";
      let text = `${ofc} ${date} ${time}`.trim();
      if (appointmentId) text += ` (ID: ${appointmentId})`;
      if (via) text += ` — via ${via}`;
      return text || null;
    }

    case "booking_fail": {
      const msg = data.responseMsg ?? data.errorMessage ?? data.error ?? "raison inconnue";
      return `Échec — ${msg}`;
    }

    case "booking_attempt": {
      const ofc = data.ofc ?? "?";
      const date = data.date ?? "?";
      const time = data.time ?? "";
      const slotId = data.slotId ?? "";
      let text = `${ofc} — ${date}`;
      if (time) text += ` à ${time}`;
      if (slotId) text += ` (slot: ${String(slotId).slice(0, 12)}…)`;
      return text;
    }

    case "confirmation_letter": {
      const size = data.pdfSizeBytes;
      const storageId = data.storageId ?? "";
      const appointmentId = data.appointmentId ?? "";
      let text = "PDF généré";
      if (typeof size === "number") text += ` (${(size / 1024).toFixed(1)} Ko)`;
      if (appointmentId) text += ` — RDV: ${appointmentId}`;
      else if (storageId) text += ` — stocké`;
      return text;
    }

    case "not_found": {
      const offices = formatOfficesList(data.offices) || (data.ofc as string) || "";
      const flow = data.flow ?? "";
      if (offices) return `${offices} — aucun créneau disponible`;
      if (flow) return `Aucun créneau disponible (${flow})`;
      return "Aucun créneau disponible";
    }

    case "human_behavior": {
      const type = data.type ?? "";
      const typeLabelMap: Record<string, string> = {
        page_refresh_simulated: "Simulation de rafraîchissement page",
        random_delay: "Délai aléatoire humain",
        mouse_movement: "Mouvement souris simulé",
        scroll_simulation: "Simulation de scroll",
        tab_switch: "Changement d'onglet simulé",
        burst_rest_phase: "Phase de repos entre rafales",
        typing_simulation: "Simulation de frappe",
        idle_behavior: "Comportement d'inactivité",
      };
      const label = typeLabelMap[type as string] ?? (type ? String(type).replace(/_/g, " ") : "Comportement simulé");
      const restMs = data.restDurationMs;
      if (restMs && typeof restMs === "number") {
        return `${label} — repos ${restMs >= 1000 ? `${(restMs / 1000).toFixed(1)}s` : `${restMs}ms`}`;
      }
      return label;
    }

    case "session_skip": {
      const reason = data.reason ?? "";
      const label = data.label ?? "";
      const username = data.username ?? "";
      if (label) return `${label}${username ? ` — ${username}` : ""}`;
      if (reason) return `Skip — ${reason}${username ? ` (${username})` : ""}`;
      return "Session ignorée";
    }

    case "anti_detection": {
      const type = data.type ?? data.action ?? "";
      if (type) return `Anti-détection: ${String(type).replace(/_/g, " ")}`;
      return "Mesure anti-détection appliquée";
    }

    case "execution_time": {
      const durationMs = data.durationMs ?? data.elapsed;
      if (typeof durationMs === "number") {
        return `Temps d'exécution: ${durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs}ms`}`;
      }
      return null;
    }

    case "rate_limit": {
      const waitSec = data.waitSec ?? data.retryAfterMs;
      const endpoint = data.endpoint ?? "";
      let text = "Rate limit détecté";
      if (endpoint) text += ` sur ${endpoint}`;
      if (typeof waitSec === "number") text += ` — attente ${waitSec}s`;
      return text;
    }

    case "blocked": {
      const username = data.username ?? "";
      return `Compte bloqué${username ? ` — ${username}` : ""}`;
    }

    case "restricted": {
      const username = data.username ?? "";
      return `Compte restreint${username ? ` — ${username}` : ""}`;
    }

    case "token_expired": {
      return "Token expiré — renouvellement nécessaire";
    }

    case "keep_alive": {
      const status = data.status ?? data.httpStatus ?? "";
      return `Ping keep-alive${status ? ` (${status})` : " envoyé"}`;
    }

    case "proxy_preflight_abort": {
      const reason = data.reason ?? data.error ?? "proxy mort";
      return `Session avortée — ${reason}`;
    }

    case "409_retry_start": {
      const ofc = data.ofc ?? data.ofcName ?? "?";
      const maxRetries = data.maxRetries ?? "";
      return `Conflit 409 sur ${ofc} — retry${maxRetries ? ` (max ${maxRetries})` : ""}`;
    }

    case "409_retry_exhausted": {
      const ofc = data.ofc ?? data.ofcName ?? "?";
      const retriesDone = data.retriesDone ?? "?";
      return `${ofc} — ${retriesDone} tentatives épuisées, abandon`;
    }

    case "409_retry_success": {
      const ofc = data.ofc ?? data.ofcName ?? "?";
      const date = data.date ?? "";
      const time = data.time ?? "";
      return `${ofc} — retry réussi${date ? ` le ${date}` : ""}${time ? ` à ${time}` : ""} !`;
    }

    case "appointment_status": {
      const status = data.status ?? data.appointmentStatus ?? "";
      const appointmentId = data.appointmentId ?? "";
      if (status) return `Statut: ${status}${appointmentId ? ` (ID: ${appointmentId})` : ""}`;
      return null;
    }

    case "scan_cap_reached": {
      const count = data.scanCount ?? "?";
      const cap = data.scanCap ?? "?";
      const pause = data.pauseMinutes ?? "?";
      return `${count}/${cap} scans — pause ${pause}min`;
    }

    // ── CEV events ──

    case "cev_http_setup_start": {
      return "Initialisation de la session HTTP CEV";
    }

    case "cev_http_login_ok": {
      return "Login VOWINT réussi";
    }

    case "cev_http_login_failed": {
      const status = data.status ?? "";
      return `Login VOWINT échoué${status ? ` (HTTP ${status})` : ""}`;
    }

    case "cev_http_vowint_cache_hit": {
      const appId = data.appId ?? "";
      return `Session VOWINT en cache${appId ? ` (appId: ${appId})` : ""}`;
    }

    case "cev_http_app_id_found": {
      const appId = data.appId ?? "?";
      const source = data.source ?? "";
      return `AppID: ${appId}${source ? ` (source: ${source})` : ""}`;
    }

    case "cev_http_integration_url": {
      const url = data.url ?? data.integrationUrl ?? "";
      if (url && typeof url === "string") return `URL: ${url.slice(0, 60)}${String(url).length > 60 ? "…" : ""}`;
      return "URL d'intégration récupérée";
    }

    case "cev_http_cev_cookie_ok": {
      return "Cookie CEV obtenu";
    }

    case "cev_http_hcaptcha_start": {
      return "Résolution hCaptcha en cours…";
    }

    case "cev_http_hcaptcha_solved": {
      return "hCaptcha résolu avec succès";
    }

    case "cev_http_hcaptcha_failed": {
      const error = data.error ?? "";
      return `hCaptcha échoué${error ? ` — ${error}` : ""}`;
    }

    case "cev_http_setup_complete": {
      return "Setup HTTP CEV terminé avec succès";
    }

    case "cev_http_setup_error": {
      const error = data.error ?? "";
      return `Erreur setup CEV${error ? ` — ${String(error).slice(0, 80)}` : ""}`;
    }

    case "cev_http_no_integration_url": {
      return "URL d'intégration introuvable";
    }

    case "cev_http_no_cev_cookie": {
      return "Cookie CEV introuvable";
    }

    case "cev_http_no_app_id": {
      return "AppID introuvable";
    }

    case "cev_no_availability": {
      return "Aucun créneau CEV disponible";
    }

    case "cev_slots_available": {
      const count = data.slotCount ?? data.count ?? "";
      return `Créneaux CEV disponibles${typeof count === "number" ? ` (${count})` : ""} !`;
    }

    case "cev_session_expired": {
      return "Session CEV expirée";
    }

    case "cev_http_booking_start": {
      return "Début du booking CEV";
    }

    case "cev_http_booking_confirmed": {
      const date = data.date ?? data.bookedDate ?? "";
      const time = data.time ?? data.bookedTime ?? "";
      let text = "Booking CEV confirmé";
      if (date) text += ` — ${date}`;
      if (time) text += ` à ${time}`;
      return text + " !";
    }

    case "cev_http_slot_selected": {
      const date = data.date ?? "";
      const time = data.time ?? "";
      let text = "Slot sélectionné";
      if (date) text += ` — ${date}`;
      if (time) text += ` ${time}`;
      return text;
    }

    case "cev_http_submit_attempt": {
      const endpoint = data.endpoint ?? "";
      return `Soumission${endpoint ? ` vers ${endpoint}` : " en cours"}`;
    }

    case "cev_http_submit_response": {
      const ok = data.ok ?? data.httpStatus;
      const status = data.httpStatus ?? "";
      if (ok === true || (typeof status === "number" && status < 300)) return `Réponse OK (${status || "success"})`;
      return `Réponse: ${status || "erreur"}`;
    }

    case "cev_http_booking_crash": {
      const error = data.error ?? "";
      return `Crash booking${error ? ` — ${String(error).slice(0, 80)}` : ""}`;
    }

    case "cev_poll_result": {
      const hasSlots = data.hasSlots ?? data.slotsAvailable;
      if (hasSlots) return "Poll: créneaux détectés !";
      return "Poll: en attente";
    }

    case "cev_poll_no_slots": {
      return "Poll: aucun créneau";
    }

    case "error": {
      const msg = data.errorMessage ?? data.error ?? data.message ?? "erreur inconnue";
      return typeof msg === "string" ? msg.slice(0, 120) : String(msg).slice(0, 120);
    }

    case "payment_check": {
      const status = data.paymentStatus ?? data.status ?? "?";
      const username = data.username ?? "";
      let text = `Statut MRV: ${status}`;
      if (username) text += ` — ${username}`;
      return text;
    }

    case "ofc_watcher_summary": {
      const city = data.city ?? data.ofc ?? "?";
      const checks = data.checksCount ?? data.totalChecks ?? "?";
      const tokenExpiry = data.tokenExpiryMin ?? data.tokenExpireMin ?? "?";
      const nextIn = data.nextCheckSec ?? data.nextInSec ?? "?";
      return `${city} — ${checks} checks, token expire dans ${tokenExpiry}min, prochain dans ${nextIn}s`;
    }

    case "accounts_status": {
      const accounts = data.accounts as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(accounts)) {
        const ready = accounts.filter(a => a.status === "ready" || a.ready === true).length;
        const dormant = accounts.filter(a => a.status === "dormant" || a.dormant === true);
        const dormantStr = dormant.map(a => {
          const email = (a.email ?? a.username ?? "?") as string;
          const short = email.includes("@") ? email.split("@")[0] + "@" : email;
          const cooldown = a.cooldownMin ?? a.remainingMin ?? "?";
          return `${short} 🔒 ${cooldown}min`;
        }).join(", ");
        return `${ready}/${accounts.length} prêts${dormant.length > 0 ? `, ${dormant.length} dormants (${dormantStr})` : ""}`;
      }
      const ready = data.readyCount ?? "?";
      const total = data.totalCount ?? "?";
      return `${ready}/${total} prêts`;
    }

    case "ofc_watcher_started": {
      const city = data.city ?? data.ofc ?? "?";
      const username = data.username ?? data.email ?? "?";
      const tokenExpiry = data.tokenExpiryMin ?? data.tokenExpireMin ?? "?";
      return `${city} — ${username} — token expire dans ${tokenExpiry}min`;
    }

    case "ofc_watcher_session_end": {
      const city = data.city ?? data.ofc ?? "?";
      const checks = data.checksCount ?? data.totalChecks ?? "?";
      const reason = data.reason ?? "stopped";
      return `${city} — ${checks} checks — raison: ${reason}`;
    }

    case "ofc_watcher_slot_detected": {
      const ofc = data.ofc ?? data.city ?? "?";
      const date = data.date ?? "?";
      const time = data.time ?? "";
      return `SLOT à ${ofc} le ${date}${time ? ` à ${time}` : ""} !`;
    }

    case "ofc_watcher_scan": {
      const ofc = data.ofc ?? data.city ?? "?";
      const result = data.slotsAvailable === true || data.hasSlots === true ? "créneau trouvé !" : "aucun créneau";
      const scanNum = data.scanNumber ?? data.checkNumber ?? "";
      return `${ofc} — scan${scanNum ? ` #${scanNum}` : ""} — ${result}`;
    }

    case "booking_race_complete": {
      const city = data.city ?? data.ofc ?? "?";
      const participants = data.participantCount ?? data.participants ?? "?";
      const winner = data.winnerId ?? data.winner ?? "?";
      return `${city} — ${participants} participants — winner: ${winner}`;
    }

    case "booking_race_success": {
      const ofc = data.ofc ?? data.city ?? "?";
      const date = data.date ?? "?";
      const time = data.time ?? "";
      const by = data.bookedBy ?? data.winner ?? "";
      let text = `${ofc} — ${date}${time ? ` à ${time}` : ""}`;
      if (by) text += ` — par ${by}`;
      return text;
    }

    case "proxy_failover": {
      const from = data.fromProxy ?? data.oldProxy ?? "?";
      const to = data.toProxy ?? data.newProxy ?? "?";
      const reason = data.reason ?? "";
      let text = `${from} → ${to}`;
      if (reason) text += ` (${reason})`;
      return text;
    }

    default: {
      // Fallback intelligent : tenter de construire un narratif à partir des champs communs
      const ofc = data.ofc ?? data.ofcName ?? data.officeName ?? "";
      const date = data.date ?? "";
      const time = data.time ?? "";
      const username = data.username ?? data.email ?? "";
      const reason = data.reason ?? data.error ?? data.message ?? "";
      const flow = data.flow ?? "";
      
      // Si on a au moins un champ connu, construire un texte
      const parts: string[] = [];
      if (ofc) parts.push(String(ofc));
      if (date) parts.push(String(date));
      if (time) parts.push(`à ${time}`);
      if (username && !ofc && !date) parts.push(String(username));
      if (reason && parts.length === 0) parts.push(String(reason).slice(0, 100));
      if (flow && parts.length === 0) parts.push(String(flow));
      
      return parts.length > 0 ? parts.join(" — ") : null;
    }
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
