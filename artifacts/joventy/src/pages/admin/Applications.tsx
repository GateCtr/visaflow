import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { StatusBadge, statusOptions } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Search, ChevronRight } from "lucide-react";

export default function AdminApplications() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const allApps = useQuery(api.applications.list, {}) ?? [];
  const isLoading = allApps === undefined;

  const applications = allApps
    .filter((a) => statusFilter === "all" || a.status === statusFilter)
    .filter((a) => !search || a.applicantName.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Gestion des Dossiers</h1>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 bg-white p-4 rounded-xl border border-border shadow-sm">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Rechercher un demandeur..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-10 bg-slate-50 border-transparent focus:bg-white"
          />
        </div>
        <div className="w-full sm:w-64">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-10 bg-slate-50 border-transparent focus:bg-white">
              <SelectValue placeholder="Filtrer par statut" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous les statuts</SelectItem>
              {statusOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground">Chargement...</div>
        ) : applications.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Aucun dossier trouvé.</div>
        ) : (
          <Table>
            <TableHeader className="bg-slate-50">
              <TableRow>
                <TableHead>Demandeur</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Statut</TableHead>
                <TableHead>Mise à jour</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {applications.map((app) => (
                <TableRow key={app._id} className="hover:bg-slate-50 transition-colors">
                  <TableCell className="font-medium text-primary py-4">{app.applicantName}</TableCell>
                  <TableCell>
                    <span className="font-semibold">{app.destination.toUpperCase()}</span>
                    <span className="text-muted-foreground text-xs block">{app.visaType}</span>
                  </TableCell>
                  <TableCell><StatusBadge status={app.status} /></TableCell>
                  <TableCell className="text-sm text-slate-500">{formatDate(app.updatedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Link href={`/admin/applications/${app._id}`}>
                      <button className="inline-flex items-center justify-center w-8 h-8 rounded-full hover:bg-slate-200 transition-colors">
                        <ChevronRight className="w-5 h-5 text-slate-500" />
                      </button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
