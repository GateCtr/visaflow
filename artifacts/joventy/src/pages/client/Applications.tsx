import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Plane, ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ClientApplications() {
  const applications = useQuery(api.applications.list, {}) ?? [];
  const isLoading = applications === undefined;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-3xl font-serif font-bold text-primary">Mes Dossiers</h1>
        <div className="flex gap-2">
          <Link href="/dashboard/applications/new/creneau">
            <Button className="gap-2">
              <Plus className="w-4 h-4" /> Créneau
            </Button>
          </Link>
          <Link href="/dashboard/applications/new">
            <Button variant="outline" className="gap-2">
              <Plus className="w-4 h-4" /> Visa
            </Button>
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground">Chargement...</div>
      ) : applications.length === 0 ? (
        <div className="bg-card border border-border rounded-2xl p-12 text-center shadow-premium">
          <p className="text-lg text-muted-foreground mb-4">Aucun dossier trouvé.</p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <Link href="/dashboard/applications/new/creneau">
              <Button>Demande de créneau</Button>
            </Link>
            <Link href="/dashboard/applications/new">
              <Button variant="outline">Demande de visa</Button>
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4">
          {applications.map((app) => (
            <Link key={app._id} href={`/dashboard/applications/${app._id}`}>
              <div className="bg-card rounded-2xl border border-border p-6 shadow-premium hover-lift cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-primary/5 flex items-center justify-center border border-primary/10">
                    <Plane className="w-6 h-6 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-primary flex items-center gap-2">
                      Destination : {app.destination.toUpperCase()}
                    </h3>
                    <p className="text-muted-foreground text-sm">
                      {app.visaType} • Demandeur : {app.applicantName}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
                  <div className="text-right sm:pr-4 sm:border-r border-border">
                    <p className="text-xs text-muted-foreground mb-1">Mise à jour</p>
                    <p className="text-sm font-medium">{formatDate(app.updatedAt)}</p>
                  </div>
                  <StatusBadge status={app.status} />
                  <ChevronRight className="w-5 h-5 text-slate-300 hidden sm:block" />
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
