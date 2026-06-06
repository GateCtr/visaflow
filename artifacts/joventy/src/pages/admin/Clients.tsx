import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { formatDate } from "@/lib/format";
import { useLocation } from "wouter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock } from "lucide-react";

export default function AdminClients() {
  const clients = useQuery(api.admin.listClients) ?? [];
  const isLoading = clients === undefined;
  const [, setLocation] = useLocation();

  const signedCount = clients.filter((c) => c.contractSignedAt !== null).length;
  const unsignedCount = clients.filter((c) => c.contractSignedAt === null).length;

  const getClerkId = (userId: string) => {
    if (userId.includes("|")) {
      return userId.split("|").pop()!;
    }
    return userId;
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Clients Inscrits</h1>
        <p className="text-muted-foreground mt-1">
          Base de données complète des utilisateurs de la plateforme.
        </p>
      </div>

      {/* Résumé contrats */}
      {!isLoading && clients.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-50 border border-emerald-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span className="text-sm font-semibold text-emerald-800">
              {signedCount} contrat{signedCount > 1 ? "s" : ""} signé{signedCount > 1 ? "s" : ""}
            </span>
          </div>
          {unsignedCount > 0 && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 border border-amber-200">
              <Clock className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">
                {unsignedCount} en attente de signature
              </span>
            </div>
          )}
        </div>
      )}

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-12 text-center text-muted-foreground">Chargement...</div>
        ) : clients.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">Aucun client trouvé.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-slate-50">
                <TableRow>
                  <TableHead>Nom Complet</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Dossiers</TableHead>
                  <TableHead>Contrat</TableHead>
                  <TableHead className="text-right">Inscription</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow 
                    key={client.userId}
                    className="cursor-pointer hover:bg-slate-50"
                    onClick={() => setLocation(`/admin/clients/${getClerkId(client.userId)}`)}
                  >
                    <TableCell className="font-medium text-primary py-4">
                      {client.firstName} {client.lastName}
                      {(!client.firstName && !client.lastName) && (
                        <span className="text-slate-400 italic">Nom non renseigné</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="block text-sm">{client.email || "Non renseigné"}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-slate-600">
                        {client.applicationCount} dossier{client.applicationCount > 1 ? "s" : ""}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {client.contractSignedAt ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Signé
                          </span>
                          <span className="text-[10px] text-slate-400 pl-5">
                            {new Date(client.contractSignedAt).toLocaleDateString("fr-FR", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                          {client.contractSignedName && (
                            <span className="text-[10px] text-slate-400 pl-5 italic truncate max-w-[140px]">
                              « {client.contractSignedName} »
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600">
                          <Clock className="w-3.5 h-3.5" />
                          En attente
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm text-slate-500">
                      {formatDate(client.firstSeen).split(" ")[0]}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
