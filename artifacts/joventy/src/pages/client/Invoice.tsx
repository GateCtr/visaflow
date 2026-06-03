import { useRoute, useLocation } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { Loader2, ArrowLeft, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InvoiceDocument } from "@/components/InvoiceDocument";

export default function ClientInvoice() {
  const [, params] = useRoute("/dashboard/applications/:id/invoice");
  const appId = params?.id as Id<"applications"> | undefined;
  const [, setLocation] = useLocation();

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");

  if (app === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        <span className="ml-2 text-sm text-slate-500">Chargement…</span>
      </div>
    );
  }

  if (!app) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-sm text-red-500 font-medium">Dossier introuvable</p>
      </div>
    );
  }

  const isReceipt = app.priceDetails?.isEngagementPaid;

  return (
    <div className="max-w-3xl mx-auto py-6 px-4 space-y-4">
      <div className="flex items-center gap-3 print:hidden">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setLocation(`/dashboard/applications/${appId}`)}
          className="gap-1.5 text-sm text-slate-600"
        >
          <ArrowLeft className="w-4 h-4" />
          Retour au dossier
        </Button>
        <div className="flex items-center gap-2 ml-auto">
          <FileText className="w-4 h-4 text-slate-400" />
          <span className="text-sm text-slate-500">
            {isReceipt ? "Reçu & Facture" : "Facture Pro Forma"}
          </span>
        </div>
      </div>

      <InvoiceDocument app={app as any} type={isReceipt ? "recu" : "facture"} />
    </div>
  );
}
