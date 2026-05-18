/**
 * SlotPanel — Enregistrer ou afficher un créneau (modèle appointment: USA, Turquie).
 */
import { useState, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Calendar, CheckCircle2, Star, Upload, Loader2, AlertTriangle, Eye, FileText } from "lucide-react";
import { formatDate, formatDateOnly } from "@/lib/format";

interface AppointmentDetails {
  date: string;
  time: string;
  location: string;
  confirmationCode?: string;
}

interface Props {
  appId: Id<"applications">;
  isSlotHunting: boolean;
  isSlotFound: boolean;
  isCompleted: boolean;
  appointmentDetails?: AppointmentDetails | null;
  slotExpiresAt?: number | null;
  confirmationLetterUrl?: string | null;
  defaultLocation?: string;
}

export function SlotPanel({ appId, isSlotHunting, isSlotFound, isCompleted, appointmentDetails, slotExpiresAt, confirmationLetterUrl, defaultLocation }: Props) {
  const { toast } = useToast();
  const markSlotFound = useMutation(api.admin.markSlotFound);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);

  const [slotDate, setSlotDate] = useState("");
  const [slotTime, setSlotTime] = useState("");
  const [slotLocation, setSlotLocation] = useState(defaultLocation ?? "");
  const [slotCode, setSlotCode] = useState("");
  const [slotFile, setSlotFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSubmit = async () => {
    if (!slotDate || !slotTime || !slotLocation) {
      toast({ variant: "destructive", title: "Champs requis", description: "Date, heure et lieu obligatoires." });
      return;
    }
    setSaving(true);
    try {
      let screenshotStorageId: string | undefined;
      if (slotFile) {
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": slotFile.type }, body: slotFile });
        if (!res.ok) throw new Error("Upload échoué");
        const { storageId } = await res.json() as { storageId: string };
        screenshotStorageId = storageId;
      }
      await markSlotFound({ applicationId: appId, date: slotDate, time: slotTime, location: slotLocation, confirmationCode: slotCode || undefined, screenshotStorageId });
      toast({ title: "Créneau enregistré", description: "Le client sera notifié." });
      setSlotDate(""); setSlotTime(""); setSlotCode(""); setSlotFile(null);
    } catch (err: unknown) {
      toast({ variant: "destructive", title: "Erreur", description: err instanceof Error ? err.message : "Échec" });
    } finally { setSaving(false); }
  };

  // Créneau déjà trouvé/complété
  if ((isSlotFound || isCompleted) && appointmentDetails) {
    return (
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-emerald-100 bg-gradient-to-r from-emerald-50 to-teal-50/50 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-400 to-green-500 flex items-center justify-center">
            <CheckCircle2 className="w-4 h-4 text-white" />
          </div>
          <h2 className="font-semibold text-emerald-800 text-sm">
            {isCompleted ? "Rendez-vous confirmé" : "Créneau capturé"}
          </h2>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <InfoPill label="Date" value={formatDateOnly(appointmentDetails.date)} />
            <InfoPill label="Heure" value={appointmentDetails.time} />
            <InfoPill label="Lieu" value={appointmentDetails.location} />
            {appointmentDetails.confirmationCode && <InfoPill label="Code" value={appointmentDetails.confirmationCode} mono />}
          </div>
          {slotExpiresAt && (
            <p className="text-xs text-amber-600 mt-3 flex items-center gap-1.5">
              <AlertTriangle className="w-3 h-3" /> Expire le {formatDate(slotExpiresAt)}
            </p>
          )}
          {confirmationLetterUrl && (
            <a href={confirmationLetterUrl} target="_blank" rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-2 text-xs text-blue-600 font-medium bg-blue-50 border border-blue-200/60 rounded-lg px-3 py-2 hover:bg-blue-100 transition-colors">
              <Eye className="w-3.5 h-3.5" /> Lettre de confirmation
            </a>
          )}
        </div>
      </div>
    );
  }

  // Formulaire enregistrer créneau
  if (!isSlotHunting && !isSlotFound) return null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center">
          <Calendar className="w-4 h-4 text-white" />
        </div>
        <h2 className="font-semibold text-slate-800 text-sm">Enregistrer un créneau</h2>
      </div>
      <div className="p-6 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 uppercase font-semibold">Date *</label>
            <Input type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} className="h-9 bg-slate-50/80 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 uppercase font-semibold">Heure *</label>
            <Input type="time" value={slotTime} onChange={(e) => setSlotTime(e.target.value)} className="h-9 bg-slate-50/80 text-sm" />
          </div>
          <div className="sm:col-span-2 space-y-1">
            <label className="text-[11px] text-slate-500 uppercase font-semibold">Lieu *</label>
            <Input value={slotLocation} onChange={(e) => setSlotLocation(e.target.value)} placeholder="Adresse consulaire" className="h-9 bg-slate-50/80 text-sm" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 uppercase font-semibold">Code confirmation</label>
            <Input value={slotCode} onChange={(e) => setSlotCode(e.target.value)} placeholder="Ex: CGO-2025-ABCDE" className="h-9 bg-slate-50/80 text-sm font-mono" />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-slate-500 uppercase font-semibold">Document (PDF/Image)</label>
            <div className="flex items-center gap-2">
              <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setSlotFile(f); }} />
              <Button type="button" variant="outline" size="sm" className="h-9 text-xs gap-1.5" onClick={() => fileRef.current?.click()}>
                <Upload className="w-3.5 h-3.5" /> {slotFile ? slotFile.name.slice(0, 20) : "Choisir"}
              </Button>
            </div>
          </div>
        </div>
        <Button onClick={handleSubmit} disabled={saving} className="w-full sm:w-auto h-10 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700 text-white font-semibold gap-2 shadow-sm">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className="w-4 h-4" />}
          {saving ? "Enregistrement..." : "Confirmer le créneau"}
        </Button>
      </div>
    </div>
  );
}

function InfoPill({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="px-3 py-2 bg-emerald-50/60 rounded-lg border border-emerald-100/80">
      <p className="text-[10px] text-emerald-600 uppercase font-semibold tracking-wide">{label}</p>
      <p className={`text-sm font-semibold text-emerald-900 mt-0.5 ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
