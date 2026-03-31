import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    draft: { label: "Brouillon", className: "bg-slate-100 text-slate-700 border-slate-200" },
    submitted: { label: "Soumis", className: "bg-blue-100 text-blue-800 border-blue-200" },
    awaiting_engagement_payment: { label: "Paiement requis", className: "bg-orange-100 text-orange-800 border-orange-200" },
    documents_pending: { label: "Documents requis", className: "bg-sky-100 text-sky-800 border-sky-200" },
    in_review: { label: "En traitement", className: "bg-blue-50 text-blue-700 border-blue-200" },
    slot_hunting: { label: "Recherche créneau", className: "bg-violet-100 text-violet-800 border-violet-200" },
    slot_found_awaiting_success_fee: { label: "Créneau trouvé !", className: "bg-green-100 text-green-800 border-green-200" },
    completed: { label: "Terminé", className: "bg-emerald-100 text-emerald-800 border-emerald-200" },
    appointment_scheduled: { label: "RDV Programmé", className: "bg-purple-100 text-purple-800 border-purple-200" },
    approved: { label: "Approuvé", className: "bg-green-100 text-green-800 border-green-200" },
    rejected: { label: "Refusé", className: "bg-red-100 text-red-800 border-red-200" },
  };

  const c = config[status] ?? { label: status, className: "bg-slate-100 text-slate-700 border-slate-200" };

  return (
    <Badge variant="outline" className={`font-medium px-3 py-1 ${c.className}`}>
      {c.label}
    </Badge>
  );
}

export const statusOptions = [
  { value: "awaiting_engagement_payment", label: "Paiement requis" },
  { value: "documents_pending", label: "Documents requis" },
  { value: "in_review", label: "En traitement" },
  { value: "slot_hunting", label: "Recherche créneau" },
  { value: "slot_found_awaiting_success_fee", label: "Créneau trouvé" },
  { value: "completed", label: "Terminé" },
  { value: "rejected", label: "Refusé" },
  { value: "submitted", label: "Soumis (legacy)" },
  { value: "approved", label: "Approuvé (legacy)" },
];
