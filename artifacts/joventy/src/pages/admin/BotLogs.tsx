import { useState, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { Link } from "wouter";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Terminal,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Search,
  Copy,
  Check,
  ExternalLink,
  RefreshCw,
  Flag,
  Power,
  PowerOff,
  Clock,
  Mail,
  Link2,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

const DEST_FLAGS: Record<string, string> = {
  usa: "\u{1F1FA}\u{1F1F8}", canada: "\u{1F1E8}\u{1F1E6}", uk: "\u{1F1EC}\u{1F1E7}", switzerland: "\u{1F1E8}\u{1F1ED}",
  dubai: "\u{1F1E6}\u{1F1EA}", turkey: "\u{1F1F9}\u{1F1F7}", india: "\u{1F1EE}\u{1F1F3}", schengen: "\u{1F1EA}\u{1F1FA}", spain: "\u{1F1EA}\u{1F1F8}",
};

const STATUS_META = {
  ok:   { label: "OK",      dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200",  icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> },
  warn: { label: "Warn",    dot: "bg-amber-400", badge: "bg-amber-50 text-amber-700 border-amber-200",  icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> },
  fail: { label: "Erreur",  dot: "bg-red-500",   badge: "bg-red-50 text-red-700 border-red-200",        icon: <XCircle className="w-3.5 h-3.5 text-red-500" /> },
};

const SCAN_META = {
  found:     { label: "Creneau trouve", dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200",  icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> },
  not_found: { label: "Aucun creneau", dot: "bg-slate-300",  badge: "bg-slate-50 text-slate-600 border-slate-200",  icon: <XCircle className="w-3.5 h-3.5 text-slate-400" /> },
  error:     { label: "Erreur",         dot: "bg-red-500",   badge: "bg-red-50 text-red-700 border-red-200",         icon: <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> },
};

// Step name → human-readable label (couvre tout le cycle bot USA + CEV)
const STEP_LABELS: Record<string, string> = {
  // ── USA Portal — Cycle complet ──
  login: "🔑 Connexion portail",
  session_start: "🚀 Début session",
  session_end: "🏁 Fin session",
  appointment_status: "📋 Statut dossier",
  payment_check: "💳 Vérification paiement MRV",
  ofc_list: "🏛️ Liste bureaux consulaires",
  scan: "🔄 Scan créneaux",
  scan_cutoff: "⏰ Arrêt scan (cutoff token)",
  cooldown: "⏳ Cooldown entre sessions",
  slots_found: "📅 Créneau détecté !",
  booking_attempt: "📝 Tentative réservation",
  booking_success: "✅ Réservation confirmée",
  booking_fail: "❌ Réservation échouée",
  confirmation_letter: "📄 Lettre de confirmation",
  not_found: "🔍 Aucun créneau disponible",
  error: "⚠️ Erreur",
  human_behavior: "🧠 Comportement humain",
  anti_detection: "🛡️ Anti-détection",
  execution_time: "⏱️ Temps d'exécution",
  // ── USA Portal — Erreurs spécifiques ──
  rate_limit: "⛔ Rate limit (429)",
  blocked: "🚫 Compte bloqué (403)",
  restricted: "🔒 Compte restreint (401)",
  token_expired: "🔄 Token expiré",
  restriction_skip: "🔒 Cycle ignoré (compte restreint)",
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

// Keys that contain sensitive or long data (show truncated by default)
const LONG_KEYS = new Set(["htmlRaw", "htmlPreview", "bodyPreview", "rawJsonPreview", "responsePreview", "visibleText"]);
// Keys to highlight as important
const IMPORTANT_KEYS = new Set([
  "finalDestinationUrl", "slotsAvailable", "isNoAvailability", "isSelectSlot",
  "error", "confirmationCode", "bookedDate", "bookedTime", "slotCount", "hasSlots",
  // USA bot fields
  "ofc", "date", "time", "slotId", "appointmentId", "responseMsg",
  "paymentStatus", "errorMessage", "phase", "count",
]);
// Keys to hide by default (too technical for quick reading)
const HIDDEN_KEYS = new Set(["ua", "cookieLen", "antiForgeryTokenPreview", "flow", "randomValue", "modifications"]);

function formatTs(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function formatTsFull(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "il y a " + Math.floor(diff / 1000) + "s";
  if (diff < 3_600_000) return "il y a " + Math.floor(diff / 60_000) + " min";
  if (diff < 86_400_000) return "il y a " + Math.floor(diff / 3_600_000) + "h";
  return formatTsFull(ts);
}

const PAGE_SIZE = 50;



// ─── Formatted Data Display ───────────────────────────────────────────────────

function LogDataValue({ k, val, isExpanded }: { k: string; val: unknown; isExpanded: boolean }) {
  if (val === null || val === undefined) return <span className="text-slate-400 italic">null</span>;
  if (typeof val === "boolean") {
    return val
      ? <span className="text-green-600 font-semibold">true</span>
      : <span className="text-red-500 font-semibold">false</span>;
  }
  if (typeof val === "number") {
    // Format special numbers
    if (k.toLowerCase().includes("ms") || k === "remainingMs") {
      const sec = (val / 1000).toFixed(1);
      return <span className="text-blue-600 font-mono">{sec}s <span className="text-slate-400">({val.toLocaleString()}ms)</span></span>;
    }
    if (k.toLowerCase().includes("seconds")) {
      return <span className="text-blue-600 font-mono">{val}s</span>;
    }
    return <span className="text-blue-600 font-mono">{val.toLocaleString()}</span>;
  }

  const str = typeof val === "string" ? val
    : Array.isArray(val) ? JSON.stringify(val, null, 2)
    : JSON.stringify(val, null, 2);

  const isLong = LONG_KEYS.has(k) || str.length > 300;
  const isUrl = typeof val === "string" && (val.startsWith("http://") || val.startsWith("https://"));
  const isHtml = typeof val === "string" && (val.includes("<html") || val.includes("<!DOCTYPE") || val.includes("<div"));

  // URL display
  if (isUrl && str.length < 200) {
    return (
      <a href={str} target="_blank" rel="noopener noreferrer"
        className="text-purple-600 hover:text-purple-800 underline underline-offset-2 font-mono text-[10px] break-all">
        {str}
      </a>
    );
  }

  // Long content — truncate unless expanded
  if (isLong && !isExpanded) {
    const preview = str.slice(0, 120);
    return (
      <span className="text-slate-600 font-mono text-[10px] break-all">
        {preview}<span className="text-slate-400">... ({str.length} chars)</span>
      </span>
    );
  }

  // HTML content — show in a code block
  if (isHtml && isExpanded) {
    return (
      <pre className="text-[10px] font-mono text-slate-600 bg-slate-100 rounded p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all border border-slate-200">
        {str}
      </pre>
    );
  }

  // JSON objects/arrays — pretty print
  if ((typeof val === "object" && val !== null) || (typeof val === "string" && (val.startsWith("{") || val.startsWith("[")))) {
    try {
      const obj = typeof val === "string" ? JSON.parse(val) : val;
      const pretty = JSON.stringify(obj, null, 2);
      if (pretty.length > 200 && !isExpanded) {
        return <span className="text-slate-600 font-mono text-[10px]">{pretty.slice(0, 120)}...</span>;
      }
      return (
        <pre className="text-[10px] font-mono text-slate-600 bg-slate-100 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-all">
          {pretty}
        </pre>
      );
    } catch { /* not JSON, fall through */ }
  }

  return <span className="text-slate-700 font-mono text-[10px] break-all leading-relaxed">{isLong && isExpanded ? str : str.slice(0, 500)}</span>;
}

function LogDataBlock({ data, isExpanded }: { data: string; isExpanded: boolean }) {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { /* noop */ }

  if (!parsed) {
    // Not JSON — show as raw text
    const display = isExpanded ? data : data.slice(0, 300);
    return (
      <div className="mt-2 text-[10px] font-mono text-slate-600 bg-slate-900/5 rounded-lg px-3 py-2 border border-slate-200 break-all leading-relaxed">
        {display}{!isExpanded && data.length > 300 && <span className="text-slate-400">...</span>}
      </div>
    );
  }

  // Separate important, normal, and hidden keys
  const importantEntries: [string, unknown][] = [];
  const normalEntries: [string, unknown][] = [];
  const hiddenEntries: [string, unknown][] = [];

  for (const [k, v] of Object.entries(parsed)) {
    if (IMPORTANT_KEYS.has(k)) importantEntries.push([k, v]);
    else if (HIDDEN_KEYS.has(k) && !isExpanded) hiddenEntries.push([k, v]);
    else normalEntries.push([k, v]);
  }

  return (
    <div className="mt-2 rounded-lg border border-slate-200 overflow-hidden bg-white">
      {/* Important fields — highlighted */}
      {importantEntries.length > 0 && (
        <div className="px-3 py-2 bg-purple-50/50 border-b border-slate-100 space-y-1">
          {importantEntries.map(([k, val]) => (
            <div key={k} className="flex items-start gap-2">
              <span className="text-[10px] font-semibold text-purple-700 shrink-0 min-w-[100px]">{k}</span>
              <LogDataValue k={k} val={val} isExpanded={isExpanded} />
            </div>
          ))}
        </div>
      )}

      {/* Normal fields */}
      {normalEntries.length > 0 && (
        <div className="px-3 py-2 space-y-1">
          {normalEntries.map(([k, val]) => (
            <div key={k} className="flex items-start gap-2">
              <span className="text-[10px] font-medium text-slate-400 shrink-0 min-w-[100px]">{k}</span>
              <LogDataValue k={k} val={val} isExpanded={isExpanded} />
            </div>
          ))}
        </div>
      )}

      {/* Hidden fields (only shown when expanded) */}
      {isExpanded && hiddenEntries.length > 0 && (
        <div className="px-3 py-2 bg-slate-50 border-t border-slate-100 space-y-1">
          <span className="text-[9px] text-slate-400 uppercase tracking-wider font-semibold">Details techniques</span>
          {hiddenEntries.map(([k, val]) => (
            <div key={k} className="flex items-start gap-2">
              <span className="text-[10px] font-medium text-slate-300 shrink-0 min-w-[100px]">{k}</span>
              <LogDataValue k={k} val={val} isExpanded={isExpanded} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}



// ─── Bot Logs Tab ─────────────────────────────────────────────────────────────

function BotLogsTab() {
  const [stepFilter, setStepFilter]     = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ok" | "warn" | "fail">("");
  const [page, setPage]                 = useState(0);
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());
  const [copied, setCopied]             = useState<string | null>(null);
  const [clearing, setClearing]         = useState(false);
  const [clearProgress, setClearProgress] = useState("");
  const [showClearDialog, setShowClearDialog] = useState(false);

  const clearAllLogs = useMutation(api.botLogs.clearAll);

  const handleClearAll = async () => {
    setShowClearDialog(true);
  }

  const confirmClearAll = async () => {
    setClearing(true);
    setClearProgress("Suppression en cours...");
    let totalDeleted = 0;
    try {
      // Loop until all logs are deleted (batch delete of 500 at a time)
      let hasMore = true;
      while (hasMore) {
        const result = await clearAllLogs();
        totalDeleted += result.deleted;
        hasMore = result.remaining;
        if (hasMore) {
          setClearProgress(`${totalDeleted} supprimes, encore des logs...`);
        }
      }
      setClearProgress(`${totalDeleted} logs supprimes`);
      setTimeout(() => setClearProgress(""), 3000);
    } catch (err) {
      console.error("[admin] Erreur suppression logs:", err);
      setClearProgress("Erreur! Reessayez.");
      setTimeout(() => setClearProgress(""), 3000);
    } finally {
      setClearing(false);
    }
  };

  const logs = useQuery(api.botLogs.listRecent, {
    limit: 500,
    statusFilter: statusFilter || undefined,
    stepFilter:   stepFilter   || undefined,
  }) ?? undefined;

  const filtered = logs ?? [];
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const safePage   = Math.min(page, Math.max(0, totalPages - 1));
  const slice      = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const allSteps: string[] = logs
    ? ([...new Set(logs.map((l: Doc<"botLogs">) => l.step))] as string[]).sort()
    : [];

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const copyData = (id: string, text: string) => {
    // Pretty-print JSON before copying
    let copyText = text;
    try {
      const obj = JSON.parse(text);
      copyText = JSON.stringify(obj, null, 2);
    } catch { /* keep raw */ }
    void navigator.clipboard.writeText(copyText);
    setCopied(id);
    setTimeout(() => setCopied(p => (p === id ? null : p)), 1500);
  };

  const clearFilters = () => {
    setStepFilter("");
    setStatusFilter("");
    setPage(0);
  };

  return (
    <div className="space-y-4">
      {/* Filters bar */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-4">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Filtrer par step..."
              value={stepFilter}
              onChange={e => { setStepFilter(e.target.value); setPage(0); }}
              list="step-list"
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-purple-300"
            />
            <datalist id="step-list">
              {allSteps.map((s: string) => <option key={s} value={s} />)}
            </datalist>
          </div>

          <div className="flex gap-1">
            {(["", "ok", "warn", "fail"] as const).map(s => (
              <button
                key={s}
                onClick={() => { setStatusFilter(s); setPage(0); }}
                className={`px-2.5 py-1.5 text-xs rounded-lg border font-medium transition-colors ${
                  statusFilter === s
                    ? s === ""     ? "bg-slate-700 text-white border-slate-700"
                    : s === "ok"   ? "bg-green-600 text-white border-green-600"
                    : s === "warn" ? "bg-amber-500 text-white border-amber-500"
                    :                "bg-red-600 text-white border-red-600"
                    : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                }`}
              >
                {s === "" ? "Tous" : s === "ok" ? "OK" : s === "warn" ? "Warn" : "Fail"}
              </button>
            ))}
          </div>

          {(stepFilter || statusFilter) && (
            <button onClick={clearFilters} className="text-xs text-purple-600 hover:text-purple-800 underline underline-offset-2">
              Reset
            </button>
          )}

          <span className="text-xs text-muted-foreground ml-auto">
            {logs === undefined ? "..." : `${filtered.length} log${filtered.length !== 1 ? "s" : ""}`}
          </span>

          <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
            <AlertDialogTrigger asChild>
              <button
                disabled={clearing || !logs || logs.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-medium transition-colors disabled:opacity-40"
              >
                <Trash2 className="w-3 h-3" />
                {clearing ? clearProgress || "..." : "Vider"}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Supprimer TOUS les logs bot</AlertDialogTitle>
                <AlertDialogDescription>
                  Êtes-vous sûr de vouloir supprimer TOUS les logs bot ? Cette action est irréversible.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Annuler</AlertDialogCancel>
                <AlertDialogAction
                  onClick={confirmClearAll}
                  className="bg-red-600 hover:bg-red-700"
                >
                  Supprimer
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Logs list */}
      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        {logs === undefined ? (
          <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-sm">Chargement des logs...</span>
          </div>
        ) : slice.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            {logs.length === 0 ? "Aucun log." : "Aucun log correspondant."}
          </p>
        ) : (
          <>
            <div className="divide-y divide-slate-100">
              {slice.map((log: Doc<"botLogs"> & { appFirstName?: string; appLastName?: string; appDestination?: string }) => {
                const isExp  = expanded.has(log._id);
                const raw    = log.data ?? "";
                const hasData = raw.length > 0;
                const status = log.status as "ok" | "warn" | "fail";
                const meta   = STATUS_META[status] ?? STATUS_META.fail;
                const flag   = log.appDestination ? (DEST_FLAGS[log.appDestination] ?? "\u{1F30D}") : "";
                const name   = [log.appFirstName, log.appLastName].filter(Boolean).join(" ") || "—";
                const stepLabel = STEP_LABELS[log.step] || log.step.replace(/_/g, " ");

                return (
                  <div key={log._id} className={`px-4 py-3 hover:bg-slate-50/50 transition-colors ${status === "fail" ? "bg-red-50/30" : ""}`}>
                    {/* Header row */}
                    <div className="flex items-center gap-2 min-w-0">
                      {/* Expand toggle */}
                      {hasData ? (
                        <button onClick={() => toggleExpand(log._id)} className="shrink-0 text-slate-400 hover:text-slate-700 transition-colors">
                          {isExp ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}

                      {/* Status dot */}
                      <div className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />

                      {/* Step name */}
                      <span className="text-xs font-semibold text-slate-800 truncate" title={log.step}>
                        {stepLabel}
                      </span>

                      {/* Status badge */}
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${meta.badge}`}>
                        {meta.label}
                      </span>

                      {/* Spacer */}
                      <span className="flex-1" />

                      {/* App link */}
                      <Link
                        href={`/admin/applications/${log.applicationId}`}
                        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-purple-600 shrink-0 transition-colors"
                      >
                        {flag} <span className="hidden sm:inline">{name}</span>
                      </Link>

                      {/* Time */}
                      <span className="text-[10px] text-slate-400 shrink-0 tabular-nums" title={formatTsFull(log.ts)}>
                        {relativeTime(log.ts)}
                      </span>

                      {/* Copy button */}
                      {hasData && (
                        <button
                          onClick={() => copyData(log._id, raw)}
                          className="text-slate-300 hover:text-slate-600 shrink-0 transition-colors"
                          title="Copier JSON"
                        >
                          {copied === log._id
                            ? <Check className="w-3 h-3 text-green-500" />
                            : <Copy className="w-3 h-3" />}
                        </button>
                      )}
                    </div>

                    {/* Data block — shown when expanded OR when it's a short important log */}
                    {hasData && (isExp || (!hasData)) && (
                      <div className="ml-6">
                        <LogDataBlock data={raw} isExpanded={isExp} />
                      </div>
                    )}

                    {/* Inline preview when collapsed (show key info) */}
                    {hasData && !isExp && (
                      <div className="ml-6 mt-1">
                        <InlinePreview data={raw} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="text-xs px-3 py-1 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40"
                >
                  Precedent
                </button>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {safePage + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="text-xs px-3 py-1 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40"
                >
                  Suivant
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Show a compact inline preview of the most relevant data fields */
function InlinePreview({ data }: { data: string }) {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { return null; }
  if (!parsed) return null;

  // Pick the most interesting fields to show inline
  const picks: string[] = [];
  const priorityKeys = [
    // USA bot cycle fields
    "ofc", "date", "time", "slotId", "appointmentId", "username", "applicationId",
    "flow", "phase", "count", "offices", "paymentStatus", "visaClass",
    "message", "responseMsg", "errorMessage",
    // CEV fields
    "error", "finalDestinationUrl", "slotsAvailable", "isNoAvailability",
    "slotCount", "hasSlots", "httpStatus", "confirmationCode",
    "bookedDate", "bookedTime", "redirectUrl", "status", "remainingSeconds",
    // Timing fields
    "durationMs", "restDurationMs", "nextBurstScans", "type",
  ];

  for (const k of priorityKeys) {
    if (k in parsed && parsed[k] !== null && parsed[k] !== undefined) {
      const v = parsed[k];
      let display: string;
      if (typeof v === "boolean") display = v ? "✓" : "✗";
      else if (typeof v === "number") {
        // Format durations nicely
        if (k.toLowerCase().includes("ms") || k === "durationMs" || k === "restDurationMs") {
          display = (v / 1000).toFixed(1) + "s";
        } else {
          display = String(v);
        }
      }
      else if (typeof v === "string") display = v.length > 50 ? v.slice(0, 50) + "…" : v;
      else if (Array.isArray(v)) {
        // Show array items compactly (e.g. offices list)
        const items = v.map((item: unknown) => {
          if (typeof item === "object" && item !== null && "name" in item) return (item as { name: string }).name;
          if (typeof item === "string") return item;
          return JSON.stringify(item);
        });
        display = items.length <= 3 ? items.join(", ") : items.slice(0, 3).join(", ") + ` +${items.length - 3}`;
      }
      else display = JSON.stringify(v).slice(0, 50);
      picks.push(`${k}=${display}`);
    }
    if (picks.length >= 4) break;
  }

  if (picks.length === 0) return null;

  return (
    <div className="text-[10px] text-slate-500 font-mono truncate">
      {picks.join("  \u00B7  ")}
    </div>
  );
}



// ─── Spain Watcher Tab ────────────────────────────────────────────────────────

function SpainWatcherTab() {
  const data = useQuery(api.spainWatcher.getWatcher);
  const setWatcher = useMutation(api.spainWatcher.setWatcher);

  const watcher = data?.watcher ?? null;
  const scans   = data?.scans  ?? [];

  const [portalUrl,    setPortalUrl]    = useState("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5");
  const [adminEmail,   setAdminEmail]   = useState("");
  const [intervalMin,  setIntervalMin]  = useState(15);
  const [isActive,     setIsActive]     = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);

  useEffect(() => {
    if (!watcher) return;
    setPortalUrl(watcher.portalUrl);
    setAdminEmail(watcher.adminEmail);
    setIntervalMin(watcher.intervalMin ?? 15);
    setIsActive(watcher.isActive);
  }, [watcher?._id]);

  const handleSave = async () => {
    if (!portalUrl.trim() || !adminEmail.trim()) return;
    setSaving(true);
    try {
      await setWatcher({ isActive, portalUrl: portalUrl.trim(), adminEmail: adminEmail.trim(), intervalMin });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async () => {
    if (!watcher && !portalUrl.trim()) return;
    const newActive = !isActive;
    setIsActive(newActive);
    if (watcher || (portalUrl.trim() && adminEmail.trim())) {
      await setWatcher({
        isActive: newActive,
        portalUrl: (watcher?.portalUrl ?? portalUrl).trim(),
        adminEmail: (watcher?.adminEmail ?? adminEmail).trim(),
        intervalMin: watcher?.intervalMin ?? intervalMin,
      });
    }
  };

  const lastResultMeta = watcher?.lastResult
    ? SCAN_META[watcher.lastResult as keyof typeof SCAN_META] ?? SCAN_META.error
    : null;

  return (
    <div className="space-y-6">
      {/* Status card */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-9 h-9 rounded-xl bg-red-50 flex items-center justify-center text-lg">{"\u{1F1EA}\u{1F1F8}"}</div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-slate-800">Veilleur Espagne</h2>
            <p className="text-xs text-muted-foreground">Scan automatique citaconsular.es</p>
          </div>
          <button
            onClick={handleToggle}
            disabled={data === undefined}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all ${
              isActive ? "bg-green-600 hover:bg-green-700 text-white shadow-sm" : "bg-slate-100 hover:bg-slate-200 text-slate-600"
            } disabled:opacity-50`}
          >
            {isActive ? <><Power className="w-4 h-4" /> Actif</> : <><PowerOff className="w-4 h-4" /> Inactif</>}
          </button>
        </div>

        {watcher && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1">Dernier scan</p>
              <p className="text-xs text-slate-700 font-medium">{watcher.lastScanAt ? formatTsFull(watcher.lastScanAt) : "\u2014"}</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1">Resultat</p>
              {lastResultMeta ? (
                <span className={`inline-flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded border ${lastResultMeta.badge}`}>
                  {lastResultMeta.icon} {lastResultMeta.label}
                </span>
              ) : <p className="text-xs text-slate-400">{"\u2014"}</p>}
            </div>
            <div className="bg-slate-50 rounded-xl p-3 border border-slate-100">
              <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide mb-1">Erreurs</p>
              <p className={`text-xs font-semibold ${(watcher.consecutiveErrors ?? 0) > 3 ? "text-red-600" : "text-slate-700"}`}>
                {watcher.consecutiveErrors ?? 0}
              </p>
            </div>
          </div>
        )}

        {watcher?.lastSlotInfo && watcher.lastResult === "found" && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 mb-5 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-xs font-semibold text-green-800">Dernier creneau trouve</p>
              <p className="text-xs text-green-700 mt-0.5">{watcher.lastSlotInfo}</p>
            </div>
          </div>
        )}

        {/* Config form */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" /> URL Bookitit
            </label>
            <input type="url" value={portalUrl} onChange={e => setPortalUrl(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-red-300" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center gap-1.5">
                <Mail className="w-3.5 h-3.5" /> Email alerte
              </label>
              <input type="email" value={adminEmail} onChange={e => setAdminEmail(e.target.value)}
                className="w-full px-3 py-2 text-xs border border-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-red-300" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> Intervalle (min)
              </label>
              <input type="number" min={5} max={120} value={intervalMin} onChange={e => setIntervalMin(Number(e.target.value))}
                className="w-full px-3 py-2 text-xs border border-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-red-300" />
            </div>
          </div>
          <div className="flex items-center justify-end pt-1">
            <button onClick={handleSave} disabled={saving || !portalUrl.trim() || !adminEmail.trim()}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50">
              {saving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : null}
              {saved ? "OK!" : saving ? "..." : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>

      {/* Scan history */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
        <h3 className="text-sm font-semibold text-slate-800 mb-4 flex items-center gap-2">
          <Flag className="w-4 h-4 text-red-500" />
          Historique scans
          {scans.length > 0 && <span className="ml-auto text-[10px] text-muted-foreground">{scans.length}</span>}
        </h3>

        {data === undefined ? (
          <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" /><span className="text-sm">...</span>
          </div>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">Aucun scan.</p>
        ) : (
          <div className="divide-y divide-slate-100">
            {scans.map((scan: { _id: string; ts: number; status: string; slotInfo?: string; screenshotStorageId?: string; screenshotUrl?: string | null; errorMessage?: string }) => {
              const meta = SCAN_META[scan.status as keyof typeof SCAN_META] ?? SCAN_META.error;
              return (
                <div key={scan._id} className="py-3 flex items-start gap-3">
                  <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${meta.dot}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-slate-800">{meta.label}</span>
                      <span className="text-[10px] text-slate-400 tabular-nums">{relativeTime(scan.ts)}</span>
                      {scan.screenshotUrl && (
                        <a href={scan.screenshotUrl} target="_blank" rel="noopener noreferrer"
                          className="ml-auto text-[10px] text-red-600 hover:text-red-800 flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> Screenshot
                        </a>
                      )}
                    </div>
                    {scan.slotInfo && <p className="text-xs text-green-700 mt-1 font-medium">{scan.slotInfo}</p>}
                    {scan.errorMessage && <p className="text-[10px] font-mono text-red-500 mt-1">{scan.errorMessage}</p>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "logs" | "watcher";

export default function AdminBotLogs() {
  const [activeTab, setActiveTab] = useState<Tab>("logs");

  useEffect(() => {
    const ts = String(Date.now());
    localStorage.setItem("botLogsLastSeen", ts);
    window.dispatchEvent(new StorageEvent("storage", { key: "botLogsLastSeen", newValue: ts }));
  }, []);

  const logsCount = useQuery(api.botLogs.listRecent, { limit: 1 });

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
          <Terminal className="w-5 h-5 text-purple-600" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-primary">Bot & Veilleurs</h1>
          <p className="text-sm text-muted-foreground">Logs du slot-hunter et surveillance automatique</p>
        </div>
        {logsCount === undefined && <RefreshCw className="w-4 h-4 text-purple-400 animate-spin ml-auto" />}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-100 rounded-xl p-1 w-fit">
        <button onClick={() => setActiveTab("logs")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === "logs" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}>
          <Terminal className="w-4 h-4" /> Logs Bot
        </button>
        <button onClick={() => setActiveTab("watcher")}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === "watcher" ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}>
          <span className="text-base leading-none">{"\u{1F1EA}\u{1F1F8}"}</span> Espagne
        </button>
      </div>

      {activeTab === "logs"    && <BotLogsTab />}
      {activeTab === "watcher" && <SpainWatcherTab />}
    </div>
  );
}
