/**
 * Ligne de document avec upload/verify/preview.
 */
import { useState, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Clock, Upload, Eye, XCircle, Loader2 } from "lucide-react";
import { PaymentReceiptModal } from "./PaymentReceiptModal";

interface Props {
  appId: Id<"applications">;
  docKey: string;
  label: string;
  existingDoc?: { _id: Id<"documents">; url: string | null; verifiedByAdmin: boolean; isAdminUpload?: boolean };
  required: boolean;
}

export function DocUploadRow({ appId, docKey, label, existingDoc, required }: Props) {
  const { toast } = useToast();
  const generateUrl = useMutation(api.documents.generateUploadUrl);
  const uploadDocument = useMutation(api.documents.uploadDocument);
  const verifyDocument = useMutation(api.documents.verifyDocument);
  const removeDocument = useMutation(api.documents.remove);

  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const uploadedByAdmin = existingDoc?.isAdminUpload === true;
  const uploadedByClient = existingDoc && !uploadedByAdmin;
  const hasDoc = !!existingDoc;
  const isVerified = existingDoc?.verifiedByAdmin ?? false;

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const uploadUrl = await generateUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const { storageId } = await res.json();
      await uploadDocument({ applicationId: appId, docKey, label, storageId });
      toast({ title: "Document ajouté", description: label });
    } catch {
      toast({ variant: "destructive", title: "Erreur upload", description: "Veuillez réessayer." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex items-center gap-3 py-3 border-b border-slate-100/80 last:border-0 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-700 truncate">{label}</span>
          {!required && (
            <span className="text-[9px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded font-medium">optionnel</span>
          )}
        </div>
        {hasDoc && (
          <div className="flex items-center gap-2 mt-0.5">
            {isVerified || uploadedByAdmin ? (
              <span className="text-[11px] text-emerald-600 flex items-center gap-1 font-medium">
                <CheckCircle2 className="w-3 h-3" /> Vérifié
              </span>
            ) : (
              <span className="text-[11px] text-amber-600 flex items-center gap-1">
                <Clock className="w-3 h-3" /> En attente
              </span>
            )}
            {uploadedByAdmin && <span className="text-[9px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded font-medium">admin</span>}
            {uploadedByClient && <span className="text-[9px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">client</span>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5 opacity-80 group-hover:opacity-100 transition-opacity">
        {hasDoc && existingDoc.url && (
          <button onClick={() => setPreviewUrl(existingDoc.url!)} className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center gap-1 font-medium">
            <Eye className="w-3.5 h-3.5" />
          </button>
        )}
        {hasDoc && !isVerified && !uploadedByAdmin && (
          <Button size="sm" variant="ghost" className="h-7 text-[11px] text-emerald-600 hover:bg-emerald-50 px-2"
            onClick={async () => { try { await verifyDocument({ documentId: existingDoc!._id }); toast({ title: "Vérifié" }); } catch { toast({ variant: "destructive", title: "Erreur" }); } }}>
            <CheckCircle2 className="w-3 h-3" />
          </Button>
        )}
        <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        <Button size="sm" variant="ghost" disabled={uploading} className="h-7 text-[11px] px-2 text-slate-500 hover:text-blue-600"
          onClick={() => fileRef.current?.click()}>
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
        </Button>
        {hasDoc && (
          <button className="text-slate-300 hover:text-red-500 transition-colors"
            onClick={async () => { try { await removeDocument({ documentId: existingDoc!._id }); toast({ title: "Supprimé" }); } catch { toast({ variant: "destructive", title: "Erreur" }); } }}>
            <XCircle className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {previewUrl && <PaymentReceiptModal url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </div>
  );
}
