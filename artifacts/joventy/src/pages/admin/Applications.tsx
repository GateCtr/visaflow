import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { StatusBadge, statusOptions } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import {
  Search,
  ChevronRight,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  Filter,
  LayoutGrid,
  LayoutList,
  Globe,
  User,
  CalendarDays,
  Loader2,
} from "lucide-react";

export default function AdminApplications() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");

  const allApps = useQuery(api.applications.list, {});
  const isLoading = allApps === undefined;

  const applications = useMemo(() => {
    if (!allApps) return [];
    return allApps
      .filter((a) => statusFilter === "all" || a.status === statusFilter)
      .filter(
        (a) =>
          !search ||
          a.applicantName.toLowerCase().includes(search.toLowerCase()) ||
          a.destination.toLowerCase().includes(search.toLowerCase()) ||
          a.visaType?.toLowerCase().includes(search.toLowerCase())
      );
  }, [allApps, statusFilter, search]);

  // Stats computation
  const stats = useMemo(() => {
    if (!allApps) return { total: 0, pending: 0, inProgress: 0, completed: 0 };
    const total = allApps.length;
    const pending = allApps.filter(
      (a) => a.status === "submitted" || a.status === "awaiting_engagement_payment" || a.status === "documents_pending"
    ).length;
    const inProgress = allApps.filter(
      (a) => a.status === "in_review" || a.status === "slot_hunting" || a.status === "slot_found_awaiting_success_fee"
    ).length;
    const completed = allApps.filter(
      (a) => a.status === "completed" || a.status === "approved" || a.status === "appointment_scheduled"
    ).length;
    return { total, pending, inProgress, completed };
  }, [allApps]);

  const statCards = [
    {
      label: "Total dossiers",
      value: stats.total,
      icon: FileText,
      color: "text-blue-600",
      bg: "bg-blue-50",
      border: "border-blue-100",
    },
    {
      label: "En attente",
      value: stats.pending,
      icon: Clock,
      color: "text-amber-600",
      bg: "bg-amber-50",
      border: "border-amber-100",
    },
    {
      label: "En cours",
      value: stats.inProgress,
      icon: Loader2,
      color: "text-violet-600",
      bg: "bg-violet-50",
      border: "border-violet-100",
    },
    {
      label: "Terminés",
      value: stats.completed,
      icon: CheckCircle2,
      color: "text-emerald-600",
      bg: "bg-emerald-50",
      border: "border-emerald-100",
    },
  ];

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl sm:text-3xl font-serif font-bold text-primary">
          Gestion des Dossiers
        </h1>
        <p className="text-sm text-muted-foreground">
          Vue d'ensemble et gestion de toutes les demandes de visa
        </p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {isLoading
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="border shadow-sm">
                <CardContent className="p-4 sm:p-5">
                  <Skeleton className="h-4 w-20 mb-3" />
                  <Skeleton className="h-8 w-12" />
                </CardContent>
              </Card>
            ))
          : statCards.map((stat) => {
              const Icon = stat.icon;
              return (
                <Card
                  key={stat.label}
                  className={`border ${stat.border} shadow-sm hover:shadow-md transition-shadow`}
                >
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs sm:text-sm font-medium text-muted-foreground">
                        {stat.label}
                      </span>
                      <div className={`${stat.bg} ${stat.color} p-1.5 sm:p-2 rounded-lg`}>
                        <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      </div>
                    </div>
                    <div className="text-2xl sm:text-3xl font-bold text-primary">
                      {stat.value}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* Filters & Controls */}
      <Card className="border shadow-sm">
        <CardContent className="p-3 sm:p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Search & Status Filter */}
            <div className="flex flex-col sm:flex-row gap-3 flex-1">
              <div className="relative flex-1 min-w-0 sm:max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <Input
                  placeholder="Rechercher un demandeur..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9 sm:h-10 bg-slate-50/80 border-slate-200 focus:bg-white text-sm"
                />
              </div>
              <div className="w-full sm:w-52">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 sm:h-10 bg-slate-50/80 border-slate-200 focus:bg-white text-sm">
                    <div className="flex items-center gap-2">
                      <Filter className="w-3.5 h-3.5 text-slate-400" />
                      <SelectValue placeholder="Filtrer par statut" />
                    </div>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Tous les statuts</SelectItem>
                    {statusOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* View Toggle */}
            <div className="hidden sm:flex items-center">
              <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as "table" | "cards")}>
                <TabsList className="h-9">
                  <TabsTrigger value="table" className="px-3 gap-1.5">
                    <LayoutList className="w-3.5 h-3.5" />
                    <span className="hidden lg:inline text-xs">Tableau</span>
                  </TabsTrigger>
                  <TabsTrigger value="cards" className="px-3 gap-1.5">
                    <LayoutGrid className="w-3.5 h-3.5" />
                    <span className="hidden lg:inline text-xs">Cartes</span>
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </div>

          {/* Active filter indicator */}
          {statusFilter !== "all" && (
            <div className="mt-3 flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filtre actif :</span>
              <Badge
                variant="secondary"
                className="text-xs cursor-pointer hover:bg-slate-200"
                onClick={() => setStatusFilter("all")}
              >
                {statusOptions.find((o) => o.value === statusFilter)?.label}
                <span className="ml-1 text-slate-400">&times;</span>
              </Badge>
              <span className="text-xs text-muted-foreground">
                ({applications.length} résultat{applications.length > 1 ? "s" : ""})
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content */}
      {isLoading ? (
        <Card className="border shadow-sm">
          <CardContent className="p-6">
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                  <Skeleton className="h-6 w-24 rounded-full" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : applications.length === 0 ? (
        <Card className="border shadow-sm">
          <CardContent className="p-8">
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <AlertCircle className="w-5 h-5" />
                </EmptyMedia>
                <EmptyTitle>Aucun dossier trouvé</EmptyTitle>
                <EmptyDescription>
                  {search || statusFilter !== "all"
                    ? "Essayez de modifier vos critères de recherche ou de filtre."
                    : "Il n'y a aucun dossier enregistré pour le moment."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop Table View */}
          <div className={`${viewMode === "cards" ? "hidden" : "hidden sm:block"}`}>
            <Card className="border shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-slate-50/80 hover:bg-slate-50/80">
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500 pl-5">
                        Demandeur
                      </TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500">
                        Destination
                      </TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500">
                        Type de visa
                      </TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500">
                        Statut
                      </TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500">
                        Dernière mise à jour
                      </TableHead>
                      <TableHead className="font-semibold text-xs uppercase tracking-wider text-slate-500 text-right pr-5">
                        Action
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {applications.map((app, index) => (
                      <TableRow
                        key={app._id}
                        className="hover:bg-slate-50/50 transition-colors group"
                        style={{ animationDelay: `${index * 30}ms` }}
                      >
                        <TableCell className="pl-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/10 flex items-center justify-center flex-shrink-0">
                              <span className="text-xs font-bold text-primary">
                                {app.applicantName
                                  .split(" ")
                                  .map((n) => n[0])
                                  .slice(0, 2)
                                  .join("")
                                  .toUpperCase()}
                              </span>
                            </div>
                            <span className="font-medium text-sm text-primary truncate max-w-[180px]">
                              {app.applicantName}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Globe className="w-3.5 h-3.5 text-slate-400" />
                            <span className="font-semibold text-sm">
                              {app.destination.toUpperCase()}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-slate-600">{app.visaType || "—"}</span>
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={app.status} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 text-sm text-slate-500">
                            <CalendarDays className="w-3.5 h-3.5" />
                            {formatDate(app.updatedAt)}
                          </div>
                        </TableCell>
                        <TableCell className="text-right pr-5">
                          <Link href={`/admin/applications/${app._id}`}>
                            <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-primary bg-primary/5 hover:bg-primary/10 border border-primary/10 transition-all group-hover:border-primary/20 group-hover:shadow-sm">
                              Voir
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Card>
          </div>

          {/* Mobile Card View (always shown on mobile, toggled on desktop) */}
          <div className={`${viewMode === "table" ? "sm:hidden" : ""} grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4`}>
            {applications.map((app, index) => (
              <Link key={app._id} href={`/admin/applications/${app._id}`}>
                <Card
                  className="border shadow-sm hover:shadow-md hover:border-primary/20 transition-all cursor-pointer group"
                  style={{ animationDelay: `${index * 30}ms` }}
                >
                  <CardContent className="p-4 sm:p-5">
                    {/* Card Header */}
                    <div className="flex items-start justify-between gap-3 mb-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/10 flex items-center justify-center flex-shrink-0">
                          <span className="text-xs font-bold text-primary">
                            {app.applicantName
                              .split(" ")
                              .map((n) => n[0])
                              .slice(0, 2)
                              .join("")
                              .toUpperCase()}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <h3 className="font-semibold text-sm text-primary truncate">
                            {app.applicantName}
                          </h3>
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Globe className="w-3 h-3" />
                            <span className="font-medium">{app.destination.toUpperCase()}</span>
                            {app.visaType && (
                              <>
                                <span className="mx-1">·</span>
                                <span>{app.visaType}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-primary transition-colors flex-shrink-0 mt-1" />
                    </div>

                    {/* Card Footer */}
                    <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                      <StatusBadge status={app.status} />
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(app.updatedAt)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>

          {/* Results count footer */}
          <div className="flex items-center justify-between px-1">
            <p className="text-xs sm:text-sm text-muted-foreground">
              Affichage de <span className="font-semibold text-primary">{applications.length}</span>{" "}
              dossier{applications.length > 1 ? "s" : ""}
              {statusFilter !== "all" && (
                <span> sur {allApps?.length ?? 0} au total</span>
              )}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
