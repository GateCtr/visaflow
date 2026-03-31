import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function AdminClients() {
  const clients = useQuery(api.admin.listClients) ?? [];
  const isLoading = clients === undefined;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Clients Inscrits</h1>
        <p className="text-muted-foreground mt-1">
          Base de données complète des utilisateurs de la plateforme.
        </p>
      </div>

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
                <TableHead className="text-right">Inscription</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {clients.map((client) => (
                <TableRow key={client.userId}>
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
