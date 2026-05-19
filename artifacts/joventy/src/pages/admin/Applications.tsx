/**
 * Admin Applications — Liste des dossiers.
 *
 * Layout moderne pro inspiré Linear/Notion :
 * - Stats inline compacts (pill bar)
 * - Filtres intégrés dans la toolbar
 * - Table dense avec hover actions
 * - Vue cartes responsive sur mobile
 * - Pagination légère
 */
import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { StatusBadge, statusOptions } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Search,
  ChevronRight,
  FileText,
  Clock,
  CheckCircle2,
  Loader2,
  Globe,
  CalendarDays,
  LayoutGrid,
  LayoutList,
  X,
  Filter,
  Inbox,
} from "lucide-react";

const PAGE_SIZE = 25;

export default function AdminApplications() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");
  const [page, setPage] = useState(0);

  const allApps = useQuery(api.applications.list, {});
  const isLoading = allApps === undefined;

  const applications = useMemo(() => {
    if (!allApps) return [];
    return allApps
      .filter((a: any) => statusFilter === "all" || a.status === statusFilter)
      .filter(
        (a: any) =>
          !search ||
          a.applicantName.toLowerCase().includes(search.toLowerCase()) ||
          a.destination.toLowerCase().includes(search.toLowerCase()) ||
          a.visaType?.toLowerCase().includes(search.toLowerCase())
      );
  }, [allApps, statusFilter, search]);

  // Pagination
  const totalPages = Math.ceil(applications.length / PAGE_SIZE);
  const safePage = Math.min(page, Math.max(0, totalPages - 1));
  const pageSlice = applications.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  // Stats
  const stats = useMemo(() => {
    if (!allApps) return { total: 0, pending: 0, inProgress: 0, completed: 0 };
    const total = allApps.length;
    const pending = allApps.filter(
      (a: any) => a.status === "submitted" || a.status === "awaiting_engagement_payment" || a.status === "documents_pending"
    ).length;
    const inProgress = allApps.filter(
      (a: any) => a.status === "in_review" || a.status === "slot_hunting" || a.status === "slot_found_awaiting_success_fee"
    ).length;
    const completed = allApps.filter(
      (a: any) => a.status === "completed" || a.status === "approved" || a.status === "appointment_scheduled"
    ).length;
    return { total, pending, inProgress, completed };
  }, [allApps]);

  // Quick filter pills (clicking filters by status group)
  const quickFilters = [
    { key: "all", label: "Tous", count: stats.total, color: "text-slate-700 bg-slate-100 border-slate-200" },
    { key: "pending", label: "En attente", count: stats.pending, color: "text-amber-700 bg-amber-50 border-amber-200" },
    { key: "in_progress", label: "En cours", count: stats.inProgress, color: "text-violet-700 bg-violet-50 border-violet-200" },
    { key: "completed", label: "Terminés", count: stats.completed, color: "text-emerald-700 bg-emerald-50 border-emerald-200" },
  ];

  const handleQuickFilter = (key: string) => {
    setPage(0);
    if (key === "all") { setStatusFilter("all"); return; }
    if (key === "pending") {
      // Cycle through pending statuses or just show all pending
      setStatusFilter(statusFilter === "submitted" ? "awaiting_engagement_payment" :
        statusFilter === "awaiting_engagement_payment" ? "documents_pending" :
        "submitted");
      return;
    }
    if (key === "in_progress") {
      setStatusFilter(statusFilter === "in_review" ? "slot_hunting" :
        statusFilter === "slot_hunting" ? "slot_found_awaiting_success_fee" :
        "in_review");
      return;
    }
    if (key === "completed") {
      setStatusFilter("completed");
    }
  };

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* ═══ TOOLBAR: Title + Stats Pills + Search + Filters ═══ */}
      <div className="flex flex-col gap-3">
        {/* Row 1: Title + View toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg lg:text-xl font-bold text-slate-900 tracking-tight">
              Dossiers
            </h1>
            <p className="text-xs text-slate-500 hidden sm:block">
              {stats.total} demande{stats.total > 1 ? "s" : ""} de visa
            </p>
          </div>
          {/* View toggle */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-100 border border-slate-200">
            <button
              onClick={() => setViewMode("table")}
              className={`p-1.5 rounded-md transition-all ${viewMode === "table" ? "bg-white shadow-sm text-slate-700" : "text-slate-400 hover:text-slate-600"}`}
            >
              <LayoutList className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setViewMode("cards")}
              className={`p-1.5 rounded-md transition-all ${viewMode === "cards" ? "bg-white shadow-sm text-slate-700" : "text-slate-400 hover:text-slate-600"}`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Row 2: Stats pills (inline) */}
        {!isLoading && (
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-0.5">
            {quickFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => handleQuickFilter(f.key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border whitespace-nowrap transition-all ${f.color} ${
                  (f.key === "all" && statusFilter === "all") ||
                  (f.key === "pending" && ["submitted", "awaiting_engagement_payment", "documents_pending"].includes(statusFilter)) ||
                  (f.key === "in_progress" && ["in_review", "slot_hunting", "slot_found_awaiting_success_fee"].includes(statusFilter)) ||
                  (f.key === "completed" && statusFilter === "completed")
                    ? "ring-2 ring-offset-1 ring-slate-300"
                    : "opacity-80 hover:opacity-100"
                }`}
              >
                {f.label}
                <span className="font-bold">{f.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* Row 3: Search + Status dropdown */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <Input
              placeholder="Rechercher..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-8 h-8 text-xs bg-slate-50/80 border-slate-200 focus:bg-white"
            />
            {search && (
              <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="relative">
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(0); }}
              className="h-8 pl-7 pr-8 text-xs rounded-md border border-slate-200 bg-slate-50/80 text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-200 appearance-none cursor-pointer"
            >
              <option value="all">Tous</option>
              {statusOptions.map((opt: any) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
            <Filter className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
          </div>

          {/* Active filter badge */}
          {statusFilter !== "all" && (
            <button
              onClick={() => setStatusFilter("all")}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 border border-blue-200/60 hover:bg-blue-100 transition-colors"
            >
              {statusOptions.find((o: any) => o.value === statusFilter)?.label ?? statusFilter}
              <X className="w-2.5 h-2.5" />
            </button>
          )}

          {/* Result count */}
          <span className="text-[11px] text-slate-400 hidden sm:inline ml-auto">
            {applications.length} résultat{applications.length > 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* ═══ CONTENT ═══ */}
      {isLoading ? (
        <LoadingSkeleton />
      ) : applications.length === 0 ? (
        <EmptyState hasFilters={!!search || statusFilter !== "all"} onReset={() => { setSearch(""); setStatusFilter("all"); }} />
      ) : (
        <>
          {/* TABLE VIEW */}
          {viewMode === "table" && (
            <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/60">
                      <th className="text-left text-[10px] uppercase tracking-wider font-semibold text-slate-400 px-4 py-2.5">Demandeur</th>
                      <th className="text-left text-[10px] uppercase tracking-wider font-semibold text-slate-400 px-3 py-2.5 hidden md:table-cell">Destination</th>
                      <th className="text-left text-[10px] uppercase tracking-wider font-semibold text-slate-400 px-3 py-2.5 hidden lg:table-cell">Visa</th>
                      <th className="text-left text-[10px] uppercase tracking-wider font-semibold text-slate-400 px-3 py-2.5">Statut</th>
                      <th className="text-left text-[10px] uppercase tracking-wider font-semibold text-slate-400 px-3 py-2.5 hidden sm:table-cell">Mis à jour</th>
                      <th className="px-3 py-2.5 w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {pageSlice.map((app: any) => (
                      <tr key={app._id} className="group hover:bg-slate-50/60 transition-colors">
                        <td className="px-4 py-2.5">
                          <Link href={`/admin/applications/${app._id}`} className="flex items-center gap-2.5 min-w-0">
                            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-200/80 flex items-center justify-center shrink-0">
                              <span className="text-[10px] font-bold text-slate-600">
                                {app.applicantName.split(" ").map((n: string) => n[0]).slice(0, 2).join("").toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{app.applicantName}</p>
                              <p className="text-[10px] text-slate-400 md:hidden">{app.destination.toUpperCase()}</p>
                            </div>
                          </Link>
                        </td>
                        <td className="px-3 py-2.5 hidden md:table-cell">
                          <div className="flex items-center gap-1.5">
                            <Globe className="w-3 h-3 text-slate-400" />
                            <span className="text-xs font-semibold text-slate-700">{app.destination.toUpperCase()}</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 hidden lg:table-cell">
                          <span className="text-xs text-slate-500">{app.visaType || "—"}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge status={app.status} />
                        </td>
                        <td className="px-3 py-2.5 hidden sm:table-cell">
                          <span className="text-[11px] text-slate-400">{formatDate(app.updatedAt)}</span>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <Link href={`/admin/applications/${app._id}`}>
                            <button className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all">
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 bg-slate-50/40">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ← Précédent
                  </button>
                  <span className="text-[11px] text-slate-400">
                    {safePage + 1} / {totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Suivant →
                  </button>
                </div>
              )}
            </div>
          )}

          {/* CARDS VIEW */}
          {viewMode === "cards" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {pageSlice.map((app: any) => (
                <Link key={app._id} href={`/admin/applications/${app._id}`}>
                  <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-4 hover:shadow-md hover:border-blue-200/60 transition-all cursor-pointer group">
                    {/* Top: Avatar + Name + Arrow */}
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-200/80 flex items-center justify-center shrink-0">
                        <span className="text-[10px] font-bold text-slate-600">
                          {app.applicantName.split(" ").map((n: string) => n[0]).slice(0, 2).join("").toUpperCase()}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-slate-800 truncate">{app.applicantName}</p>
                        <div className="flex items-center gap-1 text-[11px] text-slate-500">
                          <Globe className="w-3 h-3" />
                          <span className="font-medium">{app.destination.toUpperCase()}</span>
                          {app.visaType && <><span className="mx-0.5">·</span><span>{app.visaType}</span></>}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 transition-colors shrink-0" />
                    </div>

                    {/* Bottom: Status + Date */}
                    <div className="flex items-center justify-between pt-2.5 border-t border-slate-100">
                      <StatusBadge status={app.status} />
                      <span className="text-[10px] text-slate-400 flex items-center gap-1">
                        <Clock className="w-2.5 h-2.5" />
                        {formatDate(app.updatedAt)}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}

              {/* Pagination for cards */}
              {totalPages > 1 && (
                <div className="col-span-full flex items-center justify-center gap-4 pt-2">
                  <button
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-white disabled:opacity-40 transition-colors"
                  >
                    ← Précédent
                  </button>
                  <span className="text-xs text-slate-400">{safePage + 1} / {totalPages}</span>
                  <button
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="text-xs px-3 py-1.5 rounded-md border border-slate-200 text-slate-600 hover:bg-white disabled:opacity-40 transition-colors"
                  >
                    Suivant →
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ═══ Loading skeleton ═══ */
function LoadingSkeleton() {
  return (
    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="p-1">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="w-7 h-7 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-2.5 w-20" />
            </div>
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-3 w-24 hidden sm:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══ Empty state ═══ */
function EmptyState({ hasFilters, onReset }: { hasFilters: boolean; onReset: () => void }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm p-12 text-center">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-slate-100 flex items-center justify-center">
        <Inbox className="w-5 h-5 text-slate-400" />
      </div>
      <h3 className="text-sm font-semibold text-slate-700 mb-1">Aucun dossier trouvé</h3>
      <p className="text-xs text-slate-400 mb-4">
        {hasFilters
          ? "Essayez de modifier vos critères de recherche."
          : "Aucune demande de visa enregistrée."}
      </p>
      {hasFilters && (
        <button
          onClick={onReset}
          className="text-xs font-medium text-blue-600 hover:text-blue-700 px-3 py-1.5 rounded-md bg-blue-50 hover:bg-blue-100 transition-colors"
        >
          Réinitialiser les filtres
        </button>
      )}
    </div>
  );
}
