/**
 * BotLogTimeline — Logs du bot + watcher status banner.
 * Version simplifiée et épurée avec pagination et filtres.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Doc, Id } from "@convex/_generated/dataModel";
import { formatDate } from "@/lib/format";
import { getStepLabel, getStepCategory, CATEGORY_META, getNarrativePreview, formatDataValue, findLoginDuplicates, getGenericPreview } from "@/lib/bot-log-labels";
import { Bot, Search, Copy, Check, ChevronDown, ChevronRight, RefreshCw, AlertTriangle } from "lucide-react";

interface Props {
  appId: Id<"applications">;
  botLogs: Doc<"botLogs">[];
}

const PAGE_SIZE = 15;

export function BotLogTimeline({ appId, botLogs }: Props) {
  const clearLogs = useMutation(api.botLogs.clearByApplication);
  const [stepFilter, setStepFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ok" | "warn" | "fail">("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  if (botLogs.length === 0) return null;

  const loginDuplicates = findLoginDuplicates(botLogs as Array<{ _id: string; step: string; ts: number; data?: string | null }>);

  const filtered = botLogs.filter(log => {
    if (loginDuplicates.has(log._id)) return false;
    if (stepFilter && !log.step.toLowerCase().includes(stepFilter.toLowerCase())) return false;
    if (statusFilter && log.status !== statusFilter) return false;
    return true;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const pageSlice = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Watcher banner
  const watcherSummary = botLogs.find(l => l.step === "ofc_watcher_summary");
  const watcherActive = watcherSummary && (Date.now() - watcherSummary.ts) < 6 * 60_000;

  const dotColors: Record<string, string> = { ok: "bg-emerald-500", warn: "bg-amber-400", fail: "bg-red-500" };
  const badgeStyles: Record<string, string> = { ok: "text-emerald-700 bg-emerald-50", warn: "text-amber-700 bg-amber-50", fail: "text-red-700 bg-red-50" };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3 flex-wrap">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-400 to-violet-500 flex items-center justify-center">
          <Bot className="w-4 h-4 text-white" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">Journal Bot</h2>
        <span className="text-[11px] text-slate-400 font-mono">{filtered.length}/{botLogs.length}</span>
        <div className="ml-auto flex gap-2">
          {(stepFilter || statusFilter) && (
            <button onClick={() => { setStepFilter(""); setStatusFilter(""); setPage(0); }} className="text-[11px] text-purple-600 hover:text-purple-800 underline">Reset</button>
          )}
          <button disabled={clearing} onClick={async () => { setClearing(true); try { await clearLogs({ applicationId: appId }); } catch {} finally { setClearing(false); } }}
            className="text-[11px] px-2 py-1 rounded border border-red-200 bg-red-50 text-red-600 hover:bg-red-100 font-medium disabled:opacity-50">
            {clearing ? "..." : "Vider"}
          </button>
        </div>
      </div>

      {/* Watcher banner */}
      {watcherSummary && (
        <div className={`px-6 py-2.5 flex items-center gap-2 text-xs font-medium border-b ${watcherActive ? "bg-emerald-50/60 border-emerald-100 text-emerald-700" : "bg-amber-50/60 border-amber-100 text-amber-700"}`}>
          {watcherActive ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          {watcherActive ? "Watcher actif" : `Watcher inactif (${Math.floor((Date.now() - watcherSummary.ts) / 60000)} min)`}
        </div>
      )}

      <div className="p-6">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 mb-4">
          <div className="relative flex-1 min-w-[160px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input type="text" placeholder="Filtrer step..." value={stepFilter} onChange={e => { setStepFilter(e.target.value); setPage(0); }}
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded-lg bg-slate-50/80 focus:outline-none focus:ring-1 focus:ring-purple-200" />
          </div>
          <div className="flex gap-1">
            {(["", "ok", "warn", "fail"] as const).map(s => (
              <button key={s} onClick={() => { setStatusFilter(s); setPage(0); }}
                className={`px-2 py-1 text-[11px] rounded-md font-medium transition-colors ${statusFilter === s ? (s === "" ? "bg-slate-700 text-white" : s === "ok" ? "bg-emerald-600 text-white" : s === "warn" ? "bg-amber-500 text-white" : "bg-red-600 text-white") : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                {s === "" ? "Tous" : s === "ok" ? "OK" : s === "warn" ? "Warn" : "Fail"}
              </button>
            ))}
          </div>
        </div>

        {/* Timeline */}
        {pageSlice.length === 0 ? (
          <p className="text-xs text-slate-400 text-center py-6">Aucun événement</p>
        ) : (
          <div className="space-y-2">
            {pageSlice.map(log => {
              let parsedData: Record<string, unknown> | null = null;
              try { if (log.data) parsedData = JSON.parse(log.data) as Record<string, unknown>; } catch {}
              const isExp = expanded.has(log._id);
              const narrative = getNarrativePreview(log.step, parsedData);
              const category = getStepCategory(log.step);
              const catMeta = CATEGORY_META[category];

              return (
                <div key={log._id} className={`rounded-lg px-3 py-2.5 border-l-3 ${catMeta.border} ${catMeta.bg} border border-slate-100/60`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className={`w-2 h-2 rounded-full ${dotColors[log.status] ?? "bg-slate-400"}`} />
                    <span className="text-xs font-medium text-slate-800">{getStepLabel(log.step)}</span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${badgeStyles[log.status] ?? ""}`}>{log.status.toUpperCase()}</span>
                    {log.data && (
                      <button onClick={() => { const n = new Set(expanded); isExp ? n.delete(log._id) : n.add(log._id); setExpanded(n); }} className="text-slate-400 hover:text-slate-700">
                        {isExp ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                      </button>
                    )}
                    {log.data && (
                      <button onClick={() => { navigator.clipboard.writeText(log.data ?? ""); setCopied(log._id); setTimeout(() => setCopied(null), 1500); }}
                        className="ml-auto text-[10px] text-slate-400 hover:text-slate-700">
                        {copied === log._id ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                      </button>
                    )}
                  </div>
                  {narrative && !isExp && <p className="mt-1 text-[11px] text-slate-600 leading-relaxed">{narrative}</p>}
                  {!narrative && parsedData && !isExp && <p className="mt-1 text-[10px] text-slate-500 font-mono truncate">{getGenericPreview(parsedData)}</p>}
                  {isExp && parsedData && (
                    <div className="mt-2 text-[11px] text-slate-600 bg-white rounded px-2.5 py-2 space-y-0.5 border border-slate-100">
                      {Object.entries(parsedData).map(([k, val]) => (
                        <div key={k} className="flex gap-1.5"><span className="text-slate-400 shrink-0">{k}:</span><span className="text-slate-700 break-all font-mono text-[10px]">{formatDataValue(k, val)}</span></div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-slate-400 mt-1">{formatDate(log.ts)}</p>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-slate-100">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0} className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 disabled:opacity-40">← Prev</button>
            <span className="text-[11px] text-slate-400">{safePage + 1}/{totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1} className="text-xs px-2.5 py-1 rounded border border-slate-200 text-slate-600 disabled:opacity-40">Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
