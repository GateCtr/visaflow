/**
 * PaymentPanel — Validation des paiements (engagement + prime de succès).
 * Inclut ajuster la prime et changer le tier d'urgence.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { SLOT_URGENCY_TIERS, type SlotUrgencyTier } from "@convex/constants";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CreditCard, CheckCircle2, Clock, Star, Image, Loader2, Pencil } from "lucide-react";
import { PaymentReceiptModal } from "./components/PaymentReceiptModal";

interface PriceDetails {
  engagementFee: number;
  successFee: number;
  paidAmount: number;
  isEngagementPaid?: boolean;
  isSuccessFeePaid?: boolean;
}

interface Props {
  appId: Id<"applications">;
  priceDetails: PriceDetails | null;
  isEngagementPaid: boolean;
  isSuccessFeePaid: boolean;
  hasEngagementProof: boolean;
  hasSuccessProof: boolean;
  engagementProofUrl?: string | null;
  successFeeProofUrl?: string | null;
  isDossierOnly: boolean;
  isSlotOnly: boolean;
  urgencyTierKey?: SlotUrgencyTier;
}

export function PaymentPanel({
  appId, priceDetails, isEngagementPaid, isSuccessFeePaid,
  hasEngagementProof, hasSuccessProof, engagementProofUrl, successFeeProofUrl,
  isDossierOnly, isSlotOnly, urgencyTierKey,
}: Props) {
  const { toast } = useToast();
  const validateEngagement = useMutation(api.admin.validateEngagementPayment);
  const validateSuccess = useMutation(api.admin.validateSuccessFee);
  const adjustSlotSuccessFee = useMutation(api.admin.adjustSlotSuccessFee);
  const updateSlotUrgencyTier = useMutation(api.admin.updateSlotUrgencyTier);

  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);
  const [showAdjustFee, setShowAdjustFee] = useState(false);
  const [adjustFeeInput, setAdjustFeeInput] = useState("");
  const [adjustFeeReason, setAdjustFeeReason] = useState("");
  const [adjustFeeSaving, setAdjustFeeSaving] = useState(false);
  const [showChangeTier, setShowChangeTier] = useState(false);
  const [newTierValue, setNewTierValue] = useState<SlotUrgencyTier | "">("");
  const [changeTierReason, setChangeTierReason] = useState("");
  const [changeTierSaving, setChangeTierSaving] = useState(false);

  const urgencyTier = urgencyTierKey ? SLOT_URGENCY_TIERS[urgencyTierKey] : null;
  const canAdjustFee = isSlotOnly && !isSuccessFeePaid;

  const handleAction = async (action: () => Promise<unknown>, successMsg: string) => {
    try { await action(); toast({ title: "Succès", description: successMsg }); }
    catch (err: unknown) { toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Action échouée" }); }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center">
          <CreditCard className="w-4 h-4 text-white" />
        </div>
        <div>
          <h2 className="font-semibold text-slate-800 text-sm">Paiements</h2>
          <p className="text-[11px] text-slate-400">Engagement + Prime de succès</p>
        </div>
      </div>

      <div className="p-6 space-y-4">
        {/* Engagement */}
        <PaymentRow
          label="Frais d'engagement"
          amount={priceDetails?.engagementFee ?? 0}
          isPaid={isEngagementPaid}
          hasProof={hasEngagementProof}
          proofUrl={engagementProofUrl}
          onViewProof={(url) => setReceiptPreview(url)}
          onValidate={() => handleAction(() => validateEngagement({ applicationId: appId }), "Paiement validé.")}
        />

        {/* Success fee */}
        <PaymentRow
          label={isDossierOnly ? "Prime de succès (N/A)" : "Prime de succès"}
          amount={isDossierOnly ? 0 : (priceDetails?.successFee ?? 0)}
          isPaid={isSuccessFeePaid}
          hasProof={hasSuccessProof}
          proofUrl={successFeeProofUrl}
          disabled={isDossierOnly}
          onViewProof={(url) => setReceiptPreview(url)}
          onValidate={() => handleAction(() => validateSuccess({ applicationId: appId }), "Prime validée.")}
        />

        {/* Revenue summary */}
        {priceDetails && (
          <div className="flex items-center gap-2 text-xs bg-slate-50/80 rounded-xl p-3 border border-slate-100">
            <div className="flex-1 text-center">
              <p className="text-slate-400 mb-0.5">Total</p>
              <p className="font-bold text-slate-700">{priceDetails.engagementFee + priceDetails.successFee} $</p>
            </div>
            <div className="w-px h-6 bg-slate-200" />
            <div className="flex-1 text-center">
              <p className="text-slate-400 mb-0.5">Encaissé</p>
              <p className="font-bold text-emerald-600">{priceDetails.paidAmount} $</p>
            </div>
            <div className="w-px h-6 bg-slate-200" />
            <div className="flex-1 text-center">
              <p className="text-slate-400 mb-0.5">Restant</p>
              <p className="font-bold text-amber-600">{Math.max(0, priceDetails.engagementFee + priceDetails.successFee - priceDetails.paidAmount)} $</p>
            </div>
          </div>
        )}

        {/* Adjust fee */}
        {canAdjustFee && (
          <div className="pt-2 border-t border-slate-100">
            <button onClick={() => { setShowAdjustFee(v => !v); if (!showAdjustFee) setAdjustFeeInput(String(priceDetails?.successFee ?? "")); }}
              className="text-xs text-amber-700 font-medium flex items-center gap-1.5 hover:text-amber-800">
              <Pencil className="w-3 h-3" /> Ajuster la prime
            </button>
            {showAdjustFee && (
              <div className="mt-3 flex gap-2">
                <Input type="number" min={0} placeholder="USD" className="h-8 text-sm w-28" value={adjustFeeInput} onChange={(e) => setAdjustFeeInput(e.target.value)} />
                <Input type="text" placeholder="Motif" className="h-8 text-sm flex-1" value={adjustFeeReason} onChange={(e) => setAdjustFeeReason(e.target.value)} />
                <Button size="sm" className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white" disabled={adjustFeeSaving}
                  onClick={async () => {
                    const val = parseFloat(adjustFeeInput);
                    if (isNaN(val)) { toast({ variant: "destructive", title: "Montant invalide" }); return; }
                    setAdjustFeeSaving(true);
                    try { await adjustSlotSuccessFee({ applicationId: appId, newSuccessFee: val, reason: adjustFeeReason.trim() || undefined }); toast({ title: "Prime mise à jour" }); setShowAdjustFee(false); }
                    catch (err: unknown) { toast({ variant: "destructive", title: err instanceof Error ? err.message : "Erreur" }); }
                    finally { setAdjustFeeSaving(false); }
                  }}>
                  {adjustFeeSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "OK"}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Change tier */}
        {canAdjustFee && urgencyTierKey && (
          <div className="pt-2 border-t border-slate-100">
            <button onClick={() => setShowChangeTier(v => !v)}
              className="text-xs text-blue-700 font-medium flex items-center gap-1.5 hover:text-blue-800">
              <Pencil className="w-3 h-3" /> Changer tier ({urgencyTier?.label ?? urgencyTierKey})
            </button>
            {showChangeTier && (
              <div className="mt-3 flex gap-2 flex-wrap">
                <select className="h-8 text-xs rounded-md border px-2 bg-white" value={newTierValue} onChange={(e) => setNewTierValue(e.target.value as SlotUrgencyTier)}>
                  <option value="">Choisir</option>
                  {(Object.keys(SLOT_URGENCY_TIERS) as SlotUrgencyTier[]).filter(k => k !== urgencyTierKey).map(k => (
                    <option key={k} value={k}>{SLOT_URGENCY_TIERS[k].label}</option>
                  ))}
                </select>
                <Input type="text" placeholder="Motif" className="h-8 text-xs flex-1 min-w-[120px]" value={changeTierReason} onChange={(e) => setChangeTierReason(e.target.value)} />
                <Button size="sm" className="h-8 text-xs bg-blue-600 hover:bg-blue-700 text-white" disabled={changeTierSaving || !newTierValue}
                  onClick={async () => {
                    if (!newTierValue) return;
                    setChangeTierSaving(true);
                    try { await updateSlotUrgencyTier({ applicationId: appId, newTier: newTierValue, reason: changeTierReason.trim() || undefined }); toast({ title: "Tier mis à jour" }); setShowChangeTier(false); }
                    catch (err: unknown) { toast({ variant: "destructive", title: err instanceof Error ? err.message : "Erreur" }); }
                    finally { setChangeTierSaving(false); }
                  }}>
                  {changeTierSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "OK"}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {receiptPreview && <PaymentReceiptModal url={receiptPreview} onClose={() => setReceiptPreview(null)} />}
    </div>
  );
}

// ─── Sub-component ──────────────────────────────────────────────────────────

function PaymentRow({ label, amount, isPaid, hasProof, proofUrl, disabled, onViewProof, onValidate }: {
  label: string; amount: number; isPaid: boolean; hasProof: boolean; proofUrl?: string | null; disabled?: boolean;
  onViewProof: (url: string) => void; onValidate: () => void;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border ${
      disabled ? "bg-slate-50 border-slate-100 opacity-60" :
      isPaid ? "bg-emerald-50/60 border-emerald-200/60" :
      hasProof ? "bg-amber-50/60 border-amber-200/60" :
      "bg-slate-50/60 border-slate-200/60"
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        {isPaid ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" /> :
         hasProof ? <Clock className="w-4 h-4 text-amber-500 shrink-0" /> :
         <Star className="w-4 h-4 text-slate-300 shrink-0" />}
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-700 truncate">{label}</p>
          <p className="text-[11px] text-slate-400">{amount > 0 ? `${amount} USD` : "—"}</p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {hasProof && proofUrl && !isPaid && (
          <button onClick={() => onViewProof(proofUrl)} className="text-[11px] text-blue-600 font-medium flex items-center gap-1">
            <Image className="w-3.5 h-3.5" />
          </button>
        )}
        {hasProof && !isPaid && !disabled && (
          <Button size="sm" className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white px-3" onClick={onValidate}>
            <CheckCircle2 className="w-3 h-3 mr-1" /> Valider
          </Button>
        )}
        {isPaid && <span className="text-[11px] font-semibold text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full">Payé</span>}
      </div>
    </div>
  );
}
