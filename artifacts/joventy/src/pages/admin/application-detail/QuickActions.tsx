/**
 * QuickActions — Actions rapides + notes admin.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Search, Star, CheckCircle2, XCircle, Loader2, Zap } from "lucide-react";

interface Props {
  appId: Id<"applications">;
  status: string;
  isEngagementPaid: boolean;
  isDossierOnly: boolean;
  isSlotOnly: boolean;
  isCompleted: boolean;
  adminNotes: string;
}

export function QuickActions({ appId, status, isEngagementPaid, isDossierOnly, isSlotOnly, isCompleted, adminNotes }: Props) {
  const { toast } = useToast();
  const setSlotHunting = useMutation(api.admin.setSlotHunting);
  const setInReview = useMutation(api.admin.setInReview);
  const rejectApplication = useMutation(api.admin.rejectApplication);
  const completeDossierOnly = useMutation(api.admin.completeDossierOnly);
  const saveAdminNotes = useMutation(api.admin.saveAdminNotes);

  const [adminNoteInput, setAdminNoteInput] = useState(adminNotes);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);

  const handleAction = async (action: () => Promise<unknown>, msg: string) => {
    try { await action(); toast({ title: "Succès", description: msg }); }
    catch (err: unknown) { toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échoué" }); }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-400 to-purple-500 flex items-center justify-center">
          <Zap className="w-4 h-4 text-white" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">Actions rapides</h2>
      </div>

      <div className="p-6 space-y-4">
        <div className="flex flex-wrap gap-2">
          {status !== "in_review" && isEngagementPaid && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 border-slate-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700"
              onClick={() => handleAction(() => setInReview({ applicationId: appId }), "En révision.")}>
              <Search className="w-3.5 h-3.5" /> Révision
            </Button>
          )}
          {!isDossierOnly && status !== "slot_hunting" && isEngagementPaid && (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 border-slate-200 hover:border-purple-300 hover:bg-purple-50 hover:text-purple-700"
              onClick={() => handleAction(() => setSlotHunting({ applicationId: appId }), "Recherche activée.")}>
              <Star className="w-3.5 h-3.5" /> Recherche créneau
            </Button>
          )}
          {isDossierOnly && isEngagementPaid && !isCompleted && (
            <Button size="sm" className="h-8 text-xs gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => handleAction(() => completeDossierOnly({ applicationId: appId }), "Complété.")}>
              <CheckCircle2 className="w-3.5 h-3.5" /> Complété
            </Button>
          )}
          {!showRejectForm ? (
            <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 border-slate-200 hover:border-red-300 hover:bg-red-50 hover:text-red-600"
              onClick={() => setShowRejectForm(true)}>
              <XCircle className="w-3.5 h-3.5" /> Rejeter
            </Button>
          ) : (
            <div className="w-full space-y-2 mt-2">
              <Textarea placeholder="Raison du rejet..." value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={2} className="bg-red-50/50 border-red-200 text-sm" />
              <div className="flex gap-2">
                <Button size="sm" className="h-7 text-xs bg-red-600 hover:bg-red-700 text-white"
                  onClick={() => { if (!rejectReason.trim()) { toast({ variant: "destructive", title: "Raison requise" }); return; } handleAction(() => rejectApplication({ applicationId: appId, reason: rejectReason }), "Rejeté."); setShowRejectForm(false); }}>
                  Confirmer
                </Button>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setShowRejectForm(false)}>Annuler</Button>
              </div>
            </div>
          )}
        </div>

        {/* Notes admin */}
        <div className="pt-3 border-t border-slate-100">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wide">Notes internes</p>
            <Button size="sm" variant="ghost" className="h-6 text-[11px] text-blue-600 hover:bg-blue-50 px-2" disabled={noteSaving}
              onClick={async () => { setNoteSaving(true); try { await saveAdminNotes({ applicationId: appId, adminNotes: adminNoteInput }); toast({ title: "Sauvegardé" }); } catch { toast({ variant: "destructive", title: "Erreur" }); } finally { setNoteSaving(false); } }}>
              {noteSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Sauvegarder"}
            </Button>
          </div>
          <Textarea value={adminNoteInput} onChange={(e) => setAdminNoteInput(e.target.value)} placeholder="Notes privées..." rows={2} className="bg-slate-50/80 text-sm border-slate-200" />
        </div>
      </div>
    </div>
  );
}
