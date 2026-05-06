import { useState } from "react";
import { useQuery } from "convex/react";
import { Link } from "wouter";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
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
} from "lucide-react";

const DEST_FLAGS: Record<string, string> = {
  usa: "🇺🇸", canada: "🇨🇦", uk: "🇬🇧", switzerland: "🇨🇭",
  dubai: "🇦🇪", turkey: "🇹🇷", india: "🇮🇳", schengen: "🇪🇺", spain: "🇪🇸",
};

const STATUS_META = {
  ok:   { label: "OK",      dot: "bg-green-500", badge: "bg-green-50 text-green-700 border-green-200",  icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" /> },
  warn: { label: "Warn",    dot: "bg-amber-400", badge: "bg-amber-50 text-amber-700 border-amber-200",  icon: <AlertTriangle className="w-3.5 h-3.5 text-amber-500" /> },
  fail: { label: "Erreur",  dot: "bg-red-500",   badge: "bg-red-50 text-red-700 border-red-200",        icon: <XCircle className="w-3.5 h-3.5 text-red-500" /> },
};

function formatTs(ts: number) {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

const PAGE_SIZE = 50;

export default function AdminBotLogs() {
  const [stepFilter, setStepFilter]     = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "ok" | "warn" | "fail">("");
  const [page, setPage]                 = useState(0);
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());
  const [copied, setCopied]             = useState<string | null>(null);

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
    void navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(p => (p === id ? null : p)), 1500);
  };

  const clearFilters = () => {
    setStepFilter("");
    setStatusFilter("");
    setPage(0);
  };

  return (
    <DashboardLayout isAdmin>
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
            <Terminal className="w-5 h-5 text-purple-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-primary">Logs du Bot</h1>
            <p className="text-sm text-muted-foreground">
              Événements envoyés par le slot-hunter vers Convex (temps réel)
            </p>
          </div>
          {logs === undefined && (
            <RefreshCw className="w-4 h-4 text-purple-400 animate-spin ml-auto" />
          )}
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-4">
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Filtrer par step (ex: cev_vowint_login, net_response…)"
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
                  {s === "" ? "Tous" : s === "ok" ? "✓ OK" : s === "warn" ? "⚠ Warn" : "✕ Fail"}
                </button>
              ))}
            </div>

            {(stepFilter || statusFilter) && (
              <button
                onClick={clearFilters}
                className="text-xs text-purple-600 hover:text-purple-800 underline underline-offset-2 self-center"
              >
                Effacer
              </button>
            )}

            <span className="text-xs text-muted-foreground self-center ml-auto">
              {logs === undefined ? "Chargement…" : `${filtered.length} événement${filtered.length !== 1 ? "s" : ""}`}
            </span>
          </div>
        </div>

        {/* Timeline */}
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          {logs === undefined ? (
            <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin" />
              <span className="text-sm">Chargement des logs…</span>
            </div>
          ) : slice.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">
              {logs.length === 0 ? "Aucun log bot enregistré pour l'instant." : "Aucun événement correspondant aux filtres."}
            </p>
          ) : (
            <>
              <div className="relative border-l-2 border-slate-100 ml-3 space-y-5 pb-2">
                {slice.map((log: Doc<"botLogs"> & { appFirstName?: string; appLastName?: string; appDestination?: string }) => {
                  let parsed: Record<string, unknown> | null = null;
                  try { if (log.data) parsed = JSON.parse(log.data) as Record<string, unknown>; } catch { /* noop */ }

                  const isExp  = expanded.has(log._id);
                  const raw    = log.data ?? "";
                  const isBig  = raw.length > 300;
                  const status = log.status as "ok" | "warn" | "fail";
                  const meta   = STATUS_META[status] ?? STATUS_META.fail;
                  const flag   = log.appDestination ? (DEST_FLAGS[log.appDestination] ?? "🌍") : "";
                  const name   = [log.appFirstName, log.appLastName].filter(Boolean).join(" ") || String(log.applicationId);

                  return (
                    <div key={log._id} className="relative pl-6">
                      <div className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ${meta.dot} border-2 border-white`} />

                      {/* Row 1: step + badge + app link */}
                      <div className="flex items-start gap-2 flex-wrap">
                        <span className="text-sm font-medium text-slate-800 flex items-center gap-1.5">
                          {meta.icon}
                          {log.step}
                        </span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${meta.badge}`}>
                          {meta.label}
                        </span>

                        <Link
                          href={`/admin/applications/${log.applicationId}`}
                          className="ml-auto flex items-center gap-1 text-[10px] text-purple-600 hover:text-purple-800"
                        >
                          {flag} {name}
                          <ExternalLink className="w-3 h-3" />
                        </Link>

                        {isBig && (
                          <button
                            onClick={() => toggleExpand(log._id)}
                            className="text-[10px] text-slate-400 hover:text-slate-700 underline underline-offset-2"
                          >
                            {isExp ? "Réduire" : `Voir tout (${raw.length} chars)`}
                          </button>
                        )}
                        {log.data && (
                          <button
                            onClick={() => copyData(log._id, raw)}
                            className="text-[10px] text-slate-400 hover:text-slate-700 flex items-center gap-1"
                            title="Copier les données"
                          >
                            {copied === log._id
                              ? <><Check className="w-3 h-3 text-green-500" /> Copié</>
                              : <><Copy className="w-3 h-3" /> Copier</>}
                          </button>
                        )}
                      </div>

                      {/* Data */}
                      {parsed && (
                        <div className="mt-1.5 text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2 space-y-0.5 border border-slate-100">
                          {Object.entries(parsed).map(([k, val]) => {
                            const str = Array.isArray(val) ? (val as unknown[]).join(", ")
                              : typeof val === "object" && val !== null ? JSON.stringify(val)
                              : String(val);
                            const long = str.length > 200;
                            const disp = long && !isExp ? str.slice(0, 200) + "…" : str;
                            return (
                              <div key={k} className="flex gap-1.5 flex-wrap">
                                <span className="text-slate-400 font-medium shrink-0">{k}:</span>
                                <span className="text-slate-700 break-all font-mono text-[10px] leading-relaxed">{disp}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {!parsed && log.data && (
                        <div className="mt-1.5 text-[10px] font-mono text-slate-600 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100 break-all leading-relaxed">
                          {isBig && !isExp ? raw.slice(0, 300) + "…" : raw}
                        </div>
                      )}

                      <p className="text-[10px] text-muted-foreground mt-1">{formatTs(log.ts)}</p>
                    </div>
                  );
                })}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-6 pt-4 border-t border-slate-100">
                  <button
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Précédent
                  </button>
                  <span className="text-xs text-muted-foreground">
                    Page {safePage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Suivant →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
