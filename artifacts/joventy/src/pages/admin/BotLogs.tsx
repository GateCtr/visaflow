import { useState, useEffect } from "react";
import { useQuery, useMutation, usePaginatedQuery } from "convex/react";
import { Link } from "wouter";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  getStepLabel,
  getStepCategory,
  CATEGORY_META as CATEGORY_META_SHARED,
  getNarrativePreview,
  formatDataValue,
  getGenericPreview,
} from "@/lib/bot-log-labels";
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
  ShieldCheck,
  Zap,
} from "lucide-react";
import {
  SCAN_META,
  formatTsFull,
  relativeTime,
  SpainCycleGroupedList,
} from "./spainScanTrace";
import type { SpainScanRow } from "./spainScanGrouping";

const DEST_FLAGS: Record<string, string> = {
  usa: "\u{1F1FA}\u{1F1F8}", canada: "\u{1F1E8}\u{1F1E6}", uk: "\u{1F1EC}\u{1F1E7}", switzerland: "\u{1F1E8}\u{1F1ED}",
  dubai: "\u{1F1E6}\u{1F1EA}", turkey: "\u{1F1F9}\u{1F1F7}", india: "\u{1F1EE}\u{1F1F3}", schengen: "\u{1F1EA}\u{1F1FA}", spain: "\u{1F1EA}\u{1F1F8}",
  germany: "\u{1F1E9}\u{1F1EA}", france: "\u{1F1EB}\u{1F1F7}",
};

const STATUS_META = {
  ok:   { label: "OK",      dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200",  icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> },
  warn: { label: "Warn",    dot: "bg-amber-400", badge: "bg-amber-50 text-amber-700 border-amber-200",  icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> },
  fail: { label: "Erreur",  dot: "bg-red-500",   badge: "bg-red-50 text-red-700 border-red-200",        icon: <XCircle className="w-3.5 h-3.5 text-red-500" /> },
};

// Step name → human-readable label — now centralized in @/lib/bot-log-labels
// (imported as getStepLabel)

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

const PAGE_SIZE = 20;

// ─── Catégorisation des steps — centralisée dans @/lib/bot-log-labels ─────────
// (imported as getStepCategory, CATEGORY_META_SHARED)

const CATEGORY_META = CATEGORY_META_SHARED;

// Determine if a log is USA, CEV, Germany based on step name
function getLogFlow(log: { step: string; data?: string | null }): "usa" | "cev" | "germany" | "france" | "other" {
  if (log.step.startsWith("cev_") || log.step.startsWith("cev ")) return "cev";
  if (log.step.startsWith("germany_")) return "germany";
  if (log.step.startsWith("france_")) return "france";
  // Check data.flow field
  if (log.data) {
    try {
      const d = JSON.parse(log.data);
      if (d.flow === "usa") return "usa";
      if (d.flow === "cev" || d.flow === "schengen") return "cev";
      if (d.flow === "germany") return "germany";
      if (d.flow === "france") return "france";
    } catch { /* ignore */ }
  }
  // Default USA steps
  const usaSteps = new Set(["login", "session_start", "session_end", "appointment_status", "payment_check", "ofc_list", "scan", "scan_cutoff", "cooldown", "slots_found", "booking_attempt", "booking_success", "booking_fail", "confirmation_letter", "not_found", "error", "human_behavior", "anti_detection", "execution_time", "rate_limit", "blocked", "restricted", "token_expired", "restriction_skip", "keep_alive", "proxy_preflight_abort", "proxy_health_check", "409_retry_start", "409_retry_exhausted", "409_retry_success", "usa_login", "usa_check_slots", "usa_slot_found", "usa_no_slots", "usa_error", "ofc_watcher_started", "ofc_watcher_summary", "ofc_watcher_session_end", "ofc_watcher_slot_detected", "ofc_watcher_scan", "accounts_status", "booking_race_complete", "booking_race_success", "proxy_failover"]);
  if (usaSteps.has(log.step)) return "usa";
  return "other";
}

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

  // JSON objects/arrays — pretty print or use formatDataValue for compact view
  if ((typeof val === "object" && val !== null) || (typeof val === "string" && (val.startsWith("{") || val.startsWith("[")))) {
    try {
      const obj = typeof val === "string" ? JSON.parse(val) : val;
      if (!isExpanded) {
        // Compact human-readable display (prevents [object Object])
        return <span className="text-slate-600 font-mono text-[10px]">{formatDataValue(k, obj)}</span>;
      }
      const pretty = JSON.stringify(obj, null, 2);
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

type FlowTab = "usa" | "cev" | "germany" | "france" | "spain" | "all";

function BotLogsTab() {
  const [flowTab, setFlowTab]           = useState<FlowTab>("all");
  const [stepFilter, setStepFilter]     = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ok" | "warn" | "fail">("");
  const [page, setPage]                 = useState(0);
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());
  const [copied, setCopied]             = useState<string | null>(null);
  const [clearing, setClearing]         = useState(false);
  const [clearProgress, setClearProgress] = useState("");
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearTarget, setClearTarget]   = useState<"usa" | "cev" | "germany" | "france" | "other" | "all">("all");
  const [timeUpdate, setTimeUpdate]    = useState(0);

  // Auto-update relative time every 10 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeUpdate(Date.now());
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  const clearAllLogs = useMutation(api.botLogs.clearAll);
  const clearByFlow = useMutation(api.botLogs.clearByFlow);

  const confirmClear = async () => {
    setClearing(true);
    setClearProgress("Suppression en cours...");
    let totalDeleted = 0;
    try {
      let hasMore = true;
      while (hasMore) {
        let result: { deleted: number; remaining: boolean };
        if (clearTarget === "all") {
          result = await clearAllLogs();
        } else {
          result = await clearByFlow({ flow: clearTarget });
        }
        totalDeleted += result.deleted;
        hasMore = result.remaining;
        if (hasMore) {
          setClearProgress(`${totalDeleted} supprimés...`);
        }
      }
      setClearProgress(`${totalDeleted} logs supprimés`);
      setTimeout(() => setClearProgress(""), 3000);
    } catch (err) {
      console.error("[admin] Erreur suppression logs:", err);
      setClearProgress("Erreur ! Réessayez.");
      setTimeout(() => setClearProgress(""), 3000);
    } finally {
      setClearing(false);
      setShowClearDialog(false);
    }
  };

  const { results: paginatedLogs, status: paginationStatus, loadMore } = usePaginatedQuery(
    api.botLogs.listPaginated,
    {
      statusFilter: statusFilter || undefined,
      stepFilter:   stepFilter   || undefined,
    },
    { initialNumItems: 500 }
  );

  const canLoadMore = paginationStatus === "CanLoadMore";
  const isLoadingMore = paginationStatus === "LoadingMore";

  // Spain count — minimal query pour le badge dans l'onglet
  const spainStats = useQuery(api.spainWatcher.getWatcherPaginated, { page: 0, pageSize: 1 });
  const spainCount: number | null = spainStats?.stats?.total ?? null;

  // Filter by flow tab
  const flowFiltered = (paginatedLogs ?? []).filter(log => {
    if (flowTab === "all") return true;
    const flow = getLogFlow(log);
    if (flowTab === "usa") return flow === "usa";
    if (flowTab === "cev") return flow === "cev";
    if (flowTab === "germany") return flow === "germany";
    if (flowTab === "france") return flow === "france";
    return true;
  });

  const filtered = flowFiltered;
  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const safePage   = Math.min(page, Math.max(0, totalPages - 1));
  const slice      = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Auto-load quand on arrive sur la dernière page chargée et qu'il en reste côté serveur
  useEffect(() => {
    if (canLoadMore && !isLoadingMore && safePage >= totalPages - 1 && totalPages > 0) {
      loadMore(500);
    }
  }, [safePage, totalPages, canLoadMore, isLoadingMore]);

  // Counts per flow
  const usaCount     = paginatedLogs.filter(l => getLogFlow(l) === "usa").length;
  const cevCount     = paginatedLogs.filter(l => getLogFlow(l) === "cev").length;
  const germanyCount = paginatedLogs.filter(l => getLogFlow(l) === "germany").length;
  const franceCount  = paginatedLogs.filter(l => getLogFlow(l) === "france").length;

  const allSteps: string[] = paginatedLogs.length > 0
    ? ([...new Set(paginatedLogs.map((l) => l.step))] as string[]).sort()
    : [];

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const copyData = (id: string, text: string) => {
    let copyText = text;
    try { copyText = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
    void navigator.clipboard.writeText(copyText);
    setCopied(id);
    setTimeout(() => setCopied(p => (p === id ? null : p)), 1500);
  };

  const clearFilters = () => {
    setStepFilter("");
    setStatusFilter("");
    setPage(0);
  };

  // Generate page numbers to show
  const getPageNumbers = () => {
    const pages: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0);
      if (safePage > 2) pages.push("...");
      for (let i = Math.max(1, safePage - 1); i <= Math.min(totalPages - 2, safePage + 1); i++) {
        pages.push(i);
      }
      if (safePage < totalPages - 3) pages.push("...");
      pages.push(totalPages - 1);
    }
    return pages;
  };

  return (
    <div className="space-y-4">
      {/* Flow tabs + Filters bar */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-4 space-y-3">
        {/* Flow tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          {/* Tab bar — scrollable horizontalement sur mobile, pills sur desktop */}
          <div className="overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
            <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5 min-w-max">
              {([
                { id: "all" as FlowTab, label: "Tous", count: paginatedLogs.length },
                { id: "usa" as FlowTab, label: "🇺🇸 USA", count: usaCount },
                { id: "cev" as FlowTab, label: "🇪🇺 CEV", count: cevCount },
                { id: "germany" as FlowTab, label: "🇩🇪 Germany", count: germanyCount },
                { id: "france" as FlowTab, label: "🇫🇷 France", count: franceCount },
                { id: "spain" as FlowTab, label: "🇪🇸 Espagne", count: spainCount },
              ]).map(tab => (
                <button
                  key={tab.id}
                  onClick={() => { setFlowTab(tab.id); setPage(0); }}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    flowTab === tab.id
                      ? "bg-white text-slate-800 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {tab.label}
                  {tab.count !== null && (
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                    flowTab === tab.id ? "bg-slate-100 text-slate-600" : "bg-slate-200/50 text-slate-400"
                  }`}>{tab.count}</span>
                )}
                </button>
              ))}
            </div>
          </div>

          <span className="hidden sm:block flex-1" />

          {/* Delete selector — masqué quand l'onglet Espagne est actif */}
          {flowTab !== "spain" && <div className="flex items-center gap-1.5">
            <select
              value={clearTarget}
              onChange={(e) => setClearTarget(e.target.value as typeof clearTarget)}
              className="text-[10px] h-7 rounded-md border border-slate-200 px-2 bg-white text-slate-600"
            >
              <option value="all">Supprimer : Tous</option>
              <option value="usa">Supprimer : USA seulement</option>
              <option value="cev">Supprimer : CEV seulement</option>
              <option value="germany">Supprimer : Germany seulement</option>
              <option value="france">Supprimer : France seulement</option>
              <option value="other">Supprimer : Autres</option>
            </select>

            <AlertDialog open={showClearDialog} onOpenChange={setShowClearDialog}>
              <AlertDialogTrigger asChild>
                <button
                  disabled={clearing || paginatedLogs.length === 0}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-medium transition-colors disabled:opacity-40"
                >
                  <Trash2 className="w-3 h-3" />
                  {clearing ? clearProgress || "..." : "Vider"}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Supprimer les logs</AlertDialogTitle>
                  <AlertDialogDescription>
                    {clearTarget === "all"
                      ? "Supprimer TOUS les logs bot ? Cette action est irréversible."
                      : clearTarget === "usa"
                      ? "Supprimer uniquement les logs USA ? Les autres logs seront conservés."
                      : clearTarget === "cev"
                      ? "Supprimer uniquement les logs CEV (Schengen) ? Les autres logs seront conservés."
                      : clearTarget === "germany"
                      ? "Supprimer uniquement les logs Germany (RK-Termin) ? Les autres logs seront conservés."
                      : clearTarget === "france"
                      ? "Supprimer uniquement les logs France (consulat.gouv.fr) ? Les autres logs seront conservés."
                      : "Supprimer les logs qui ne sont ni USA, ni CEV, ni Germany, ni France ?"}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={confirmClear} className="bg-red-600 hover:bg-red-700">
                    Supprimer
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>}
        </div>

        {/* Step + status filters — masqué quand l'onglet Espagne est actif */}
        {flowTab !== "spain" && (
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

          <span className="text-[10px] text-muted-foreground ml-auto">
            {paginationStatus === "LoadingFirstPage" ? "..." : `${filtered.length} log${filtered.length !== 1 ? "s" : ""}${canLoadMore ? "+" : ""}`}
          </span>
        </div>
        )}
      </div>

      {/* Espagne — rendu inline quand l'onglet Espagne est actif */}
      {flowTab === "spain" && <SpainWatcherTab />}

      {/* Logs list — masqué quand l'onglet Espagne est actif */}
      {flowTab !== "spain" && <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        {paginationStatus === "LoadingFirstPage" ? (
          <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span className="text-sm">Chargement des logs...</span>
          </div>
        ) : slice.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-12">
            {paginatedLogs.length === 0 ? "Aucun log." : "Aucun log correspondant."}
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
                const stepLabel = getStepLabel(log.step);
                const category = getStepCategory(log.step);
                const catMeta = CATEGORY_META[category];

                return (
                  <div key={log._id} className={`px-4 py-3 hover:bg-slate-50/50 transition-colors border-l-3 ${catMeta.border} ${catMeta.bg} ${status === "fail" ? "bg-red-50/30" : ""}`}>
                    {/* Header row */}
                    <div className="flex items-center gap-2 min-w-0">
                      {hasData ? (
                        <button onClick={() => toggleExpand(log._id)} className="shrink-0 text-slate-400 hover:text-slate-700 transition-colors">
                          {isExp ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      ) : (
                        <span className="w-3.5 shrink-0" />
                      )}

                      <div className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />

                      <span className="text-xs font-semibold text-slate-800 truncate" title={log.step}>
                        {stepLabel}
                      </span>

                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border shrink-0 ${meta.badge}`}>
                        {meta.label}
                      </span>

                      <span className="flex-1" />

                      <Link
                        href={`/admin/applications/${log.applicationId}`}
                        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-purple-600 shrink-0 transition-colors"
                      >
                        {flag} <span className="hidden sm:inline">{name}</span>
                      </Link>

                      <span className="text-[10px] text-slate-400 shrink-0 tabular-nums" title={formatTsFull(log.ts)}>
                        {relativeTime(log.ts)}
                      </span>

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

                    {hasData && isExp && (
                      <div className="ml-6">
                        <LogDataBlock data={raw} isExpanded={isExp} />
                      </div>
                    )}

                    {hasData && !isExp && (
                      <div className="ml-6 mt-1">
                        <InlinePreview data={raw} step={log.step} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pagination with page numbers */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-1 px-4 py-3 border-t border-slate-100 bg-slate-50/50">
                <button
                  onClick={() => setPage(0)}
                  disabled={safePage === 0}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  «
                </button>
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  ‹
                </button>

                {getPageNumbers().map((p, idx) =>
                  p === "..." ? (
                    <span key={`dots-${idx}`} className="text-[10px] px-1 text-slate-400">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setPage(p)}
                      className={`text-[10px] px-2.5 py-1 rounded border font-medium transition-colors ${
                        safePage === p
                          ? "bg-purple-600 text-white border-purple-600"
                          : "border-slate-200 text-slate-600 hover:border-purple-300 hover:text-purple-700"
                      }`}
                    >
                      {p + 1}
                    </button>
                  )
                )}

                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  ›
                </button>
                <button
                  onClick={() => setPage(totalPages - 1)}
                  disabled={safePage >= totalPages - 1}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  »
                </button>

                <span className="text-[9px] text-slate-400 ml-2">
                  {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} sur {filtered.length}
                </span>
              </div>
            )}

            {/* Load more from server */}
            {(canLoadMore || isLoadingMore) && (
              <div className="flex items-center justify-center px-4 py-3 border-t border-slate-100 bg-slate-50/30">
                <button
                  onClick={() => loadMore(100)}
                  disabled={isLoadingMore}
                  className="flex items-center gap-2 px-4 py-2 text-xs font-medium rounded-lg border border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100 transition-colors disabled:opacity-50"
                >
                  {isLoadingMore ? (
                    <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Chargement...</>
                  ) : (
                    <>Charger plus de logs</>
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </div>}

      {/* Espagne — historique scans uniquement dans l'onglet "Tous" */}
      {flowTab === "all" && <SpainWatcherTab compact />}
    </div>
  );
}
/** Show a compact inline preview — narrative first, fallback to generic */
function InlinePreview({ data, step }: { data: string; step: string }) {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(data) as Record<string, unknown>; } catch { return null; }
  if (!parsed) return null;

  // Try narrative preview first
  const narrative = getNarrativePreview(step, parsed);
  if (narrative) {
    return (
      <div className="text-[11px] text-slate-600 font-medium truncate">
        {narrative}
      </div>
    );
  }

  // Fallback to generic key=value preview
  const preview = getGenericPreview(parsed);
  if (!preview) return null;

  return (
    <div className="text-[10px] text-slate-500 font-mono truncate">
      {preview}
    </div>
  );
}



// ─── Spain Watcher Tab ────────────────────────────────────────────────────────

// Les composants/types de trace Spain (SpainPageCapture, SpainCaptureItem,
// SpainScanTraceData, boolBadge, parseSpainScanTrace, SpainCycleSteps,
// SpainScanTraceBlock, SpainPageCapturesBlock) sont lifés dans ./spainScanTrace
// et partagés avec SpainDossierCycles.tsx (pas de duplication divergente).

/** Affiche le statut de la dernière commande rush-prep pour un type donné. */
function RushPrepStatus({ watcher, command }: {
  watcher: { rushPrepCommand?: string; rushPrepAt?: number; rushPrepResult?: string; rushPrepAckedAt?: number } | null;
  command: "cf_resolve" | "session_prep";
}) {
  if (!watcher) return null;
  const isPending = watcher.rushPrepCommand === command;
  const isThisCommand =
    !watcher.rushPrepCommand && // already acked
    watcher.rushPrepResult !== undefined &&
    watcher.rushPrepAt !== undefined &&
    // no way to know which command was last acked without storing it — show if recently acked (< 60s)
    watcher.rushPrepAckedAt !== undefined &&
    Date.now() - (watcher.rushPrepAckedAt ?? 0) < 60_000;

  if (isPending) {
    return (
      <span className="flex items-center gap-1 text-[10px] text-amber-700 font-medium">
        <RefreshCw className="w-3 h-3 animate-spin" /> En attente du bot…
      </span>
    );
  }
  if (isThisCommand && watcher.rushPrepResult) {
    const ok = watcher.rushPrepResult === "ok";
    return (
      <span className={`flex items-center gap-1 text-[10px] font-medium ${ok ? "text-green-700" : "text-red-700"}`}>
        {ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
        {ok ? "Succès" : watcher.rushPrepResult.replace(/^error:\s*/, "")}
      </span>
    );
  }
  return null;
}

function SpainWatcherTab({ compact = false }: { compact?: boolean } = {}) {
  const [scanPage, setScanPage] = useState(0);
  const [scanFilter, setScanFilter] = useState<"" | "found" | "not_found" | "error">("");
  const [selectedApplicationId, setSelectedApplicationId] = useState<string>("");

  const dossierList = useQuery(api.spainWatcher.getDossierList, {});

  const data = useQuery(api.spainWatcher.getWatcherPaginated, {
    page: scanPage,
    pageSize: 20,
    statusFilter: scanFilter || undefined,
    applicationId: selectedApplicationId || undefined,
  });
  const setWatcher = useMutation(api.spainWatcher.setWatcher);
  const clearSpainScans = useMutation(api.spainWatcher.clearScans);
  const requestRushPrep = useMutation(api.spainWatcher.requestRushPrep);

  const watcher = data?.watcher ?? null;
  const scans   = data?.scans  ?? [];
  const stats   = data?.stats ?? { total: 0, found: 0, notFound: 0, errors: 0 };
  const totalPages = data?.totalPages ?? 0;
  const totalCount = data?.totalCount ?? 0;

  const [portalUrl,    setPortalUrl]    = useState("https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5");
  const [adminEmail,   setAdminEmail]   = useState("");
  const [intervalSec,  setIntervalSec]  = useState(60);
  const [isActive,     setIsActive]     = useState(false);
  const [saving,       setSaving]       = useState(false);
  const [saved,        setSaved]        = useState(false);
  const [rushCfLoading, setRushCfLoading] = useState(false);
  const [rushSessionLoading, setRushSessionLoading] = useState(false);

  useEffect(() => {
    if (!watcher) return;
    setPortalUrl(watcher.portalUrl);
    setAdminEmail(watcher.adminEmail);
    setIntervalSec(watcher.intervalSec ?? (watcher.intervalMin ? watcher.intervalMin * 60 : 60));
    setIsActive(watcher.isActive);
  }, [watcher?._id]);

  const handleSave = async () => {
    if (!portalUrl.trim() || !adminEmail.trim()) return;
    setSaving(true);
    try {
      await setWatcher({ isActive, portalUrl: portalUrl.trim(), adminEmail: adminEmail.trim(), intervalSec });
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
        intervalSec: watcher?.intervalSec ?? intervalSec,
      });
    }
  };

  const lastResultMeta = watcher?.lastResult
    ? SCAN_META[watcher.lastResult as keyof typeof SCAN_META] ?? SCAN_META.error
    : null;

  // Pagination helpers
  const safePage = Math.min(scanPage, Math.max(0, totalPages - 1));
  const getScanPageNumbers = () => {
    const pages: (number | "...")[] = [];
    if (totalPages <= 7) {
      for (let i = 0; i < totalPages; i++) pages.push(i);
    } else {
      pages.push(0);
      if (safePage > 2) pages.push("...");
      for (let i = Math.max(1, safePage - 1); i <= Math.min(totalPages - 2, safePage + 1); i++) {
        pages.push(i);
      }
      if (safePage < totalPages - 3) pages.push("...");
      pages.push(totalPages - 1);
    }
    return pages;
  };

  return (
    <div className="space-y-6">
      {/* Scan history */}
      <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Flag className="w-4 h-4 text-red-500" />
            Historique scans
            {stats.total > 0 && <span className="ml-1 text-[10px] text-muted-foreground bg-slate-100 px-1.5 py-0.5 rounded-full">{stats.total}</span>}
          </h3>

          {/* Dossier selector — filtrage par applicationId */}
          {dossierList && dossierList.length > 0 && (
            <select
              value={selectedApplicationId}
              onChange={e => { setSelectedApplicationId(e.target.value); setScanPage(0); }}
              className="text-[11px] h-7 rounded-md border border-slate-200 px-2 bg-white text-slate-700 max-w-[200px] truncate"
            >
              <option value="">Tous les dossiers</option>
              {dossierList.map(d => (
                <option key={d.applicationId} value={d.applicationId}>
                  {d.dossierName}
                </option>
              ))}
            </select>
          )}

          <span className="flex-1" />
          {stats.total > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="flex items-center gap-1 px-2.5 py-1.5 text-[10px] rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-medium transition-colors">
                  <Trash2 className="w-3 h-3" /> Vider l'historique
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Supprimer l'historique Espagne</AlertDialogTitle>
                  <AlertDialogDescription>
                    Supprimer tous les scans Espagne ({stats.total} entrées) ? Les screenshots seront aussi supprimés. Cette action est irréversible.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Annuler</AlertDialogCancel>
                  <AlertDialogAction onClick={async () => { let guard = 0; while (guard++ < 200) { const r = await clearSpainScans(); if (!r?.remaining) break; } setScanPage(0); }} className="bg-red-600 hover:bg-red-700">
                    Supprimer tout
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {/* Stats bar */}
        {stats.total > 0 && (
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full bg-green-50 text-green-700 border border-green-200">
              <CheckCircle2 className="w-3 h-3" /> {stats.found} créneaux
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full bg-slate-50 text-slate-600 border border-slate-200">
              <XCircle className="w-3 h-3" /> {stats.notFound} vides
            </span>
            <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-full bg-red-50 text-red-700 border border-red-200">
              <AlertTriangle className="w-3 h-3" /> {stats.errors} erreurs
            </span>
          </div>
        )}

        {/* Filter buttons */}
        <div className="flex gap-1 mb-4">
          {([
            { id: "" as const, label: "Tous", count: stats.total },
            { id: "found" as const, label: "Créneaux", count: stats.found },
            { id: "not_found" as const, label: "Vide", count: stats.notFound },
            { id: "error" as const, label: "Erreurs", count: stats.errors },
          ]).map(f => (
            <button
              key={f.id}
              onClick={() => { setScanFilter(f.id); setScanPage(0); }}
              className={`px-3 py-1.5 text-[11px] rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                scanFilter === f.id
                  ? "bg-red-600 text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {f.label}
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                scanFilter === f.id ? "bg-red-500 text-white" : "bg-slate-200/70 text-slate-400"
              }`}>{f.count}</span>
            </button>
          ))}
        </div>

        {data === undefined ? (
          <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
            <RefreshCw className="w-4 h-4 animate-spin" /><span className="text-sm">...</span>
          </div>
        ) : scans.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">Aucun scan.</p>
        ) : (
          <>
            <SpainCycleGroupedList scans={scans as unknown as SpainScanRow[]} />

            {/* Pagination controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-1 px-4 py-3 border-t border-slate-100 bg-slate-50/50 mt-3 rounded-lg">
                <button
                  onClick={() => setScanPage(0)}
                  disabled={safePage === 0}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  «
                </button>
                <button
                  onClick={() => setScanPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  ‹
                </button>

                {getScanPageNumbers().map((p, idx) =>
                  p === "..." ? (
                    <span key={`dots-${idx}`} className="text-[10px] px-1 text-slate-400">…</span>
                  ) : (
                    <button
                      key={p}
                      onClick={() => setScanPage(p)}
                      className={`text-[10px] px-2.5 py-1 rounded border font-medium transition-colors ${
                        safePage === p
                          ? "bg-red-600 text-white border-red-600"
                          : "border-slate-200 text-slate-600 hover:border-red-300 hover:text-red-700"
                      }`}
                    >
                      {p + 1}
                    </button>
                  )
                )}

                <button
                  onClick={() => setScanPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  ›
                </button>
                <button
                  onClick={() => setScanPage(totalPages - 1)}
                  disabled={safePage >= totalPages - 1}
                  className="text-[10px] px-2 py-1 rounded border border-slate-200 text-slate-500 hover:border-slate-400 disabled:opacity-30"
                >
                  »
                </button>

                <span className="text-[9px] text-slate-400 ml-2">
                  {safePage * 20 + 1}–{Math.min((safePage + 1) * 20, totalCount)} sur {totalCount}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AdminBotLogs() {
  useEffect(() => {
    const ts = String(Date.now());
    localStorage.setItem("botLogsLastSeen", ts);
    window.dispatchEvent(new StorageEvent("storage", { key: "botLogsLastSeen", newValue: ts }));
  }, []);

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
      </div>

      {/* Tous les flux dans un seul tab bar : USA / CEV / Germany / 🇪🇸 Espagne / Tous */}
      <BotLogsTab />
    </div>
  );
}
