/**
 * EvisaPanel — Upload du visa obtenu (modèle e-visa: Dubaï, Inde).
 */
import { useState, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FileText, CheckCircle2, Upload, Loader2 } from "lucide-react";

interface Props {
  appId: Id<"applications">;
  isSlotFound: boolean;
  isSlotHunting: boolean;
}

export function EvisaPanel({ appId, isSlotFound, isSlotHunting }: Props) {
  const { toast } = useToast();
  const markVisaObtained = useMutation(api.admin.markVisaObtained);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);

  const [visaNotes, setVisaNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error("Upload échoué");
      const { storageId } = await res.json() as { storageId: string };
      await markVisaObtained({ applicationId: appId, storageId, notes: visaNotes || undefined });
      toast({ title: "Visa enregistré" });
      setVisaNotes("");
    } catch (err: unknown) {
      toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échec" });
    } finally { setUploading(false); }
  };

  if (isSlotFound) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-teal-50/50 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-green-500 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4 text-white" />
          </div>
          <h2 className="font-semibold text-emerald-800 text-sm">Visa uploadé — client en attente de paiement</h2>
        </div>
      </div>
    );
  }

  if (!isSlotHunting) return null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
          <FileText className="w-4 h-4 text-white" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">Enregistrer le visa obtenu</h2>
      </div>
      <div className="p-6 space-y-4">
        <p className="text-sm text-slate-600">Uploadez le PDF du visa. Le client ne pourra le télécharger qu'après paiement de la prime.</p>
        <Input value={visaNotes} onChange={(e) => setVisaNotes(e.target.value)} placeholder="Notes pour le client (optionnel)" className="h-9 bg-slate-50/80 text-sm" />
        <input ref={fileRef} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        <Button onClick={() => fileRef.current?.click()} disabled={uploading}
          className="h-10 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-semibold gap-2 shadow-sm">
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
          {uploading ? "Upload..." : "Uploader le visa PDF"}
        </Button>
      </div>
    </div>
  );
}
