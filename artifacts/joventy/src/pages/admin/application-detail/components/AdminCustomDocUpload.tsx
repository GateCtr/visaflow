/**
 * Upload libre d'un document admin (label custom).
 */
import { useState, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Upload, Loader2 } from "lucide-react";

interface Props {
  appId: Id<"applications">;
}

export function AdminCustomDocUpload({ appId }: Props) {
  const { toast } = useToast();
  const generateUrl = useMutation(api.documents.generateUploadUrl);
  const uploadDocument = useMutation(api.documents.uploadDocument);
  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (!label.trim()) { toast({ variant: "destructive", title: "Intitulé requis" }); return; }
    setUploading(true);
    try {
      const uploadUrl = await generateUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      const { storageId } = await res.json();
      const docKey = `admin_${Date.now()}_${label.trim().toLowerCase().replace(/\s+/g, "_")}`;
      await uploadDocument({ applicationId: appId, docKey, label: label.trim(), storageId });
      toast({ title: "Document ajouté", description: label.trim() });
      setLabel("");
    } catch (err: unknown) {
      toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Upload échoué" });
    } finally { setUploading(false); if (fileRef.current) fileRef.current.value = ""; }
  };

  return (
    <div className="mt-4 p-4 bg-slate-50/80 rounded-xl border border-slate-100">
      <p className="text-[11px] text-slate-500 uppercase font-semibold tracking-wide mb-2">Ajouter un document</p>
      <div className="flex gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Intitulé (ex: Attestation, Confirmation...)" className="h-9 text-sm bg-white flex-1" />
        <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
        <Button size="sm" disabled={uploading || !label.trim()} className="h-9 text-xs gap-1.5 bg-blue-600 hover:bg-blue-700 text-white" onClick={() => fileRef.current?.click()}>
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          {uploading ? "..." : "Upload"}
        </Button>
      </div>
    </div>
  );
}
