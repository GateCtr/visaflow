import { useState, useRef } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { MOBILE_MONEY_INFO } from "@convex/constants";
import { formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle2, Upload, Copy, AlertCircle, ArrowRight, Clock } from "lucide-react";

const MPESA_NUMBER = "+243 97 000 0000";
const AIRTEL_NUMBER = "+243 99 000 0000";

export default function PaymentGate() {
  const [, params] = useRoute("/dashboard/applications/:id/payment");
  const appId = params?.id as Id<"applications"> | undefined;
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const generateUploadUrl = useMutation(api.applications.generateReceiptUploadUrl);
  const uploadPaymentProof = useMutation(api.applications.uploadPaymentProof);

  const [selectedMethod, setSelectedMethod] = useState<"mpesa" | "airtel">("mpesa");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const paymentType: "engagement" | "success_fee" =
    app?.status === "slot_found_awaiting_success_fee" ? "success_fee" : "engagement";

  const amount =
    paymentType === "engagement"
      ? app?.priceDetails?.engagementFee ?? 0
      : app?.priceDetails?.successFee ?? 0;

  const alreadySent =
    paymentType === "engagement"
      ? !!app?.paymentProofUrl
      : !!app?.successFeeProofUrl;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copié !", description: text });
  };

  const handleSubmit = async () => {
    if (!file || !appId) return;
    setIsUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await res.json();
      await uploadPaymentProof({ id: appId, proofUrl: storageId as string, paymentType });
      setDone(true);
      toast({ title: "Reçu envoyé !", description: "Notre équipe validera votre paiement sous 24h." });
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible d'uploader le reçu. Réessayez." });
    } finally {
      setIsUploading(false);
    }
  };

  if (app === undefined) return <div className="p-12 text-center text-muted-foreground">Chargement...</div>;
  if (!app) return <div className="p-12 text-center text-red-500">Dossier introuvable</div>;

  const number = selectedMethod === "mpesa" ? MPESA_NUMBER : AIRTEL_NUMBER;

  if (done || alreadySent) {
    return (
      <div className="max-w-lg mx-auto animate-in fade-in duration-500">
        <div className="bg-white rounded-2xl border border-border shadow-sm p-10 text-center">
          <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-green-600" />
          </div>
          <h2 className="text-2xl font-bold text-primary mb-2">Reçu envoyé avec succès</h2>
          <p className="text-muted-foreground mb-2">
            Notre équipe va valider votre paiement de{" "}
            <strong className="text-primary">{formatCurrency(amount)}</strong> dans les prochaines 24 heures.
          </p>
          <div className="flex items-center justify-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3 mb-6 mt-4">
            <Clock className="w-4 h-4 flex-shrink-0" />
            Vous recevrez une notification dès la validation.
          </div>
          <Button onClick={() => setLocation(`/dashboard/applications/${appId}`)} className="w-full h-12">
            Suivre mon dossier <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Paiement Mobile Money</h1>
        <p className="text-muted-foreground mt-1">
          {paymentType === "engagement"
            ? "Réglez les frais d'engagement pour activer votre dossier."
            : "Réglez la prime de succès pour confirmer votre rendez-vous consulaire."}
        </p>
      </div>

      <div className="bg-primary text-white rounded-2xl p-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <p className="text-slate-300 text-sm font-medium uppercase tracking-wide mb-1">
            {paymentType === "engagement" ? "Frais d'engagement" : "Prime de succès"}
          </p>
          <p className="text-4xl font-bold text-secondary">{formatCurrency(amount)}</p>
          <p className="text-slate-300 text-xs mt-1">
            Dossier : {app.destination.toUpperCase()} — {app.visaType}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-400 mb-1">Total du programme</p>
          <p className="text-lg font-semibold text-white">{formatCurrency(app.price)}</p>
        </div>
      </div>

      {paymentType === "engagement" && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex items-start gap-3">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <p>
            Les frais d'engagement (<strong>{formatCurrency(amount)}</strong>) permettent à Joventy de démarrer
            l'analyse de votre dossier. La prime de succès de{" "}
            <strong>{formatCurrency(app.priceDetails?.successFee ?? 0)}</strong> ne sera due
            qu'une fois votre créneau de rendez-vous consulaire obtenu.
          </p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-border shadow-sm p-6 sm:p-8 space-y-6">
        <div>
          <h2 className="text-lg font-bold text-primary mb-4">1. Choisissez votre opérateur</h2>
          <div className="grid grid-cols-2 gap-3">
            {(["mpesa", "airtel"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setSelectedMethod(m)}
                className={`p-4 rounded-xl border-2 font-bold transition-all text-center ${
                  selectedMethod === m
                    ? "border-secondary bg-orange-50 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/30"
                }`}
              >
                {m === "mpesa" ? "M-Pesa" : "Airtel Money"}
              </button>
            ))}
          </div>
        </div>

        <div>
          <h2 className="text-lg font-bold text-primary mb-4">2. Effectuez le virement</h2>
          <div className="bg-slate-50 border border-border rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Envoyez exactement</span>
              <span className="text-2xl font-bold text-primary">{formatCurrency(amount)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Au numéro {selectedMethod === "mpesa" ? "M-Pesa" : "Airtel Money"}</span>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold text-primary">{number}</span>
                <button onClick={() => handleCopy(number)} className="text-slate-400 hover:text-secondary transition-colors">
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <span className="text-sm text-muted-foreground">Bénéficiaire</span>
              <span className="font-semibold text-primary">Joventy SARL</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            ⚠️ Envoyez le montant <strong>exact</strong>. Conservez la capture d'écran du reçu de transaction.
          </p>
        </div>

        <div>
          <h2 className="text-lg font-bold text-primary mb-4">3. Uploadez votre reçu</h2>
          <div
            className="border-2 border-dashed border-border rounded-xl p-8 text-center cursor-pointer hover:border-secondary transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            {preview ? (
              <div className="space-y-2">
                <img src={preview} alt="Reçu" className="max-h-40 mx-auto rounded-lg object-contain" />
                <p className="text-sm text-green-700 font-semibold">{file?.name}</p>
                <p className="text-xs text-muted-foreground">Cliquez pour changer l'image</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm font-medium text-primary">Cliquez pour uploader votre reçu</p>
                <p className="text-xs text-muted-foreground">PNG, JPG ou PDF — Max 5 MB</p>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <Button
          onClick={handleSubmit}
          disabled={!file || isUploading}
          className="w-full h-12 bg-secondary text-primary hover:bg-orange-500 font-bold text-base"
        >
          {isUploading ? "Envoi en cours..." : "Confirmer le paiement"}
        </Button>
      </div>
    </div>
  );
}
