import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { 
  ArrowLeft, 
  CheckCircle2, 
  Clock, 
  FileText, 
  Calendar, 
  User, 
  Mail, 
  Phone,
  ShieldCheck,
  Activity,
  Download
} from "lucide-react";

export default function ClientDetail() {
  const [, setLocation] = useLocation();
  const [match, params] = useRoute("/admin/clients/:clerkId");
  const clerkId = params?.clerkId;
  
  const client = useQuery(api.admin.getClientDetail, { clerkId: clerkId ?? "" });
  const applications = useQuery(api.admin.getClientApplications, { clerkId: clerkId ?? "" });
  const contracts = useQuery(api.admin.getClientContracts, { clerkId: clerkId ?? "" });

  if (!clerkId) {
    return <div className="p-12 text-center text-muted-foreground">ID client manquant</div>;
  }

  if (!client) {
    return <div className="p-12 text-center text-muted-foreground">Chargement...</div>;
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/admin/clients")} className="gap-2">
          <ArrowLeft className="w-4 h-4" />
          Retour
        </Button>
        <div>
          <h1 className="text-3xl font-serif font-bold text-primary">
            {client.firstName} {client.lastName}
          </h1>
          <p className="text-muted-foreground mt-1">
            {client.email || "Email non renseigné"}
          </p>
        </div>
      </div>

      {/* Client Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
            <Calendar className="w-4 h-4" />
            Inscription
          </div>
          <div className="font-semibold text-slate-900">
            {formatDate(client.firstSeen)}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
            <Activity className="w-4 h-4" />
            Dernière connexion
          </div>
          <div className="font-semibold text-slate-900">
            {client.lastSeen ? formatDate(client.lastSeen) : "Jamais connecté"}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
            <FileText className="w-4 h-4" />
            Dossiers
          </div>
          <div className="font-semibold text-slate-900">
            {client.applicationCount} dossier{client.applicationCount > 1 ? "s" : ""}
          </div>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <div className="flex items-center gap-2 text-slate-500 text-sm mb-2">
            <ShieldCheck className="w-4 h-4" />
            Contrat
          </div>
          <div className="font-semibold text-slate-900">
            {client.contractSignedAt ? (
              <span className="text-emerald-600">Signé</span>
            ) : (
              <span className="text-amber-600">En attente</span>
            )}
          </div>
        </div>
      </div>

      {/* Contracts Section */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Contrats signés
          </h2>
        </div>
        <div className="p-6">
          {!contracts || contracts.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              Aucun contrat signé
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nom signataire</TableHead>
                  <TableHead>Version</TableHead>
                  <TableHead>Date signature</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contracts.map((contract) => (
                  <TableRow key={contract._id}>
                    <TableCell className="font-medium">{contract.signedName}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{contract.contractVersion}</Badge>
                    </TableCell>
                    <TableCell>
                      {new Date(contract.signedAt).toLocaleDateString("fr-FR", {
                        day: "numeric",
                        month: "long",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="gap-1">
                        <Download className="w-4 h-4" />
                        PDF
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Applications Section */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <FileText className="w-5 h-5" />
            Dossiers du client
          </h2>
        </div>
        <div className="p-6">
          {!applications || applications.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              Aucun dossier trouvé
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Demandeur</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Type visa</TableHead>
                  <TableHead>Statut</TableHead>
                  <TableHead className="text-right">Créé le</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applications.map((app) => (
                  <TableRow 
                    key={app._id}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setLocation(`/admin/applications/${app._id}`)}
                  >
                    <TableCell className="font-medium">{app.applicantName}</TableCell>
                    <TableCell>{app.destination.toUpperCase()}</TableCell>
                    <TableCell>{app.visaType}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{app.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {formatDate(app._creationTime).split(" ")[0]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
    </div>
  );
}
