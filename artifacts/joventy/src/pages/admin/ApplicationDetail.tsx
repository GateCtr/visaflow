import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING, SERVICE_PACKAGES, SLOT_URGENCY_TIERS, type SlotUrgencyTier } from "@convex/constants";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Send,
  User,
  Calendar,
  CreditCard,
  ShieldCheck,
  CheckCircle2,
  Clock,
  Upload,
  FileText,
  Search,
  XCircle,
  Star,
  Image,
  Eye,
  Loader2,
  RefreshCw,
  AlertTriangle,
  Package,
  Pencil,
} from "lucide-react";

function PaymentReceiptModal({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-2xl w-full bg-white rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b flex justify-between items-center">
          <span className="text-sm font-semibold text-primary">Reçu de paiement</span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-primary transition-colors text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <img
          src={url}
          alt="Reçu de paiement"
          className="w-full max-h-[70vh] object-contain"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
            (e.currentTarget.nextElementSibling as HTMLElement).style.display = "block";
          }}
        />
        <p className="hidden p-6 text-center text-sm text-muted-foreground">
          Le fichier ne peut pas être prévisualisé.{" "}
          <a href={url} target="_blank" rel="noreferrer" className="text-primary underline">
            Ouvrir dans un nouvel onglet
          </a>
        </p>
        <div className="p-3 border-t flex justify-end">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-primary underline"
          >
            Ouvrir dans un nouvel onglet
          </a>
        </div>
      </div>
    </div>
  );
}

function AdminCustomDocUpload({ appId }: { appId: Id<"applications"> }) {
  const { toast } = useToast();
  const generateUrl = useMutation(api.documents.generateUploadUrl);
  const uploadDocument = useMutation(api.documents.uploadDocument);

  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    if (!label.trim()) {
      toast({ variant: "destructive", title: "Intitulé requis", description: "Donnez un nom à ce document avant d'uploader." });
      return;
    }
    setUploading(true);
    try {
      const uploadUrl = await generateUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      const { storageId } = await res.json();
      const docKey = `admin_${Date.now()}_${label.trim().toLowerCase().replace(/\s+/g, "_")}`;
      await uploadDocument({ applicationId: appId, docKey, label: label.trim(), storageId });
      toast({ title: "Document admin ajouté", description: label.trim() });
      setLabel("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lors de l'upload";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="mt-4 p-4 bg-blue-50 rounded-xl border border-blue-100">
      <p className="text-xs font-semibold text-primary mb-3 uppercase">Ajouter un document admin</p>
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Intitulé du document (ex: Attestation VISA, AIS Confirmation...)"
          className="h-9 text-sm bg-white flex-1"
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
        <Button
          size="sm"
          disabled={uploading || !label.trim()}
          className="h-9 text-xs bg-primary text-white hover:bg-primary/90 gap-1 flex-shrink-0"
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          {uploading ? "Upload..." : "Choisir fichier"}
        </Button>
      </div>
    </div>
  );
}

function DocUploadRow({
  appId,
  docKey,
  label,
  existingDoc,
  required,
  isAdminContext,
}: {
  appId: Id<"applications">;
  docKey: string;
  label: string;
  existingDoc?: { _id: Id<"documents">; url: string | null; verifiedByAdmin: boolean; isAdminUpload?: boolean };
  required: boolean;
  isAdminContext: boolean;
}) {
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

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const uploadUrl = await generateUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
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

  const hasDoc = !!existingDoc;
  const isVerified = existingDoc?.verifiedByAdmin ?? false;

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-slate-100 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-700 truncate">{label}</span>
          {!required && (
            <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">optionnel</span>
          )}
        </div>
        {hasDoc && (
          <div className="flex items-center gap-2 mt-0.5">
            {isVerified ? (
              <span className="text-[11px] text-green-700 flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Vérifié ✓
              </span>
            ) : (
              <span className="text-[11px] text-amber-600 flex items-center gap-1">
                <Clock className="w-3 h-3" /> En attente de vérification
              </span>
            )}
            {uploadedByAdmin && (
              <span className="text-[10px] text-primary bg-blue-50 px-1.5 py-0.5 rounded">admin</span>
            )}
            {uploadedByClient && (
              <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">client</span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {hasDoc && existingDoc.url && (
          <button
            onClick={() => setPreviewUrl(existingDoc.url!)}
            className="text-[11px] text-primary underline flex items-center gap-1"
          >
            <Eye className="w-3.5 h-3.5" /> Voir
          </button>
        )}

        {isAdminContext && hasDoc && !isVerified && !uploadedByAdmin && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] border-green-300 text-green-700 hover:bg-green-50"
            onClick={async () => {
              try {
                await verifyDocument({ documentId: existingDoc!._id });
                toast({ title: "Vérifié", description: label });
              } catch {
                toast({ variant: "destructive", title: "Erreur" });
              }
            }}
          >
            <CheckCircle2 className="w-3 h-3 mr-1" /> Valider
          </Button>
        )}

        {isAdminContext && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={uploading}
              className="h-7 text-[11px]"
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />}
              {hasDoc ? "Remplacer" : "Ajouter"}
            </Button>
          </>
        )}

        {hasDoc && (
          <button
            className="text-red-400 hover:text-red-600 transition-colors"
            onClick={async () => {
              try {
                await removeDocument({ documentId: existingDoc!._id });
                toast({ title: "Document supprimé" });
              } catch {
                toast({ variant: "destructive", title: "Erreur suppression" });
              }
            }}
          >
            <XCircle className="w-4 h-4" />
          </button>
        )}
      </div>

      {previewUrl && (
        <PaymentReceiptModal url={previewUrl} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
  );
}

export default function AdminApplicationDetail() {
  const [, params] = useRoute("/admin/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [msgText, setMsgText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { toast } = useToast();

  const [rejectReason, setRejectReason] = useState("");
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [adminNoteInput, setAdminNoteInput] = useState("");

  const [slotDate, setSlotDate] = useState("");
  const [slotTime, setSlotTime] = useState("");
  const [slotLocation, setSlotLocation] = useState("");
  const [slotCode, setSlotCode] = useState("");
  const [slotSaving, setSlotSaving] = useState(false);

  const [receiptPreview, setReceiptPreview] = useState<string | null>(null);

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const proofUrls = useQuery(api.documents.getPaymentProofUrls, appId ? { applicationId: appId } : "skip");
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];

  const sendMessage = useMutation(api.messages.send);
  const markAsRead = useMutation(api.messages.markAsRead);
  const validateEngagement = useMutation(api.admin.validateEngagementPayment);
  const validateSuccess = useMutation(api.admin.validateSuccessFee);
  const markSlotFound = useMutation(api.admin.markSlotFound);
  const markVisaObtained = useMutation(api.admin.markVisaObtained);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const rejectApplication = useMutation(api.admin.rejectApplication);
  const setSlotHunting = useMutation(api.admin.setSlotHunting);
  const setInReview = useMutation(api.admin.setInReview);
  const saveAdminNotes = useMutation(api.admin.saveAdminNotes);
  const completeDossierOnly = useMutation(api.admin.completeDossierOnly);
  const adjustSlotSuccessFee = useMutation(api.admin.adjustSlotSuccessFee);
  const [noteSaving, setNoteSaving] = useState(false);
  const [visaUploading, setVisaUploading] = useState(false);
  const [showAdjustFee, setShowAdjustFee] = useState(false);
  const [adjustFeeInput, setAdjustFeeInput] = useState("");
  const [adjustFeeReason, setAdjustFeeReason] = useState("");
  const [adjustFeeSaving, setAdjustFeeSaving] = useState(false);
  const [visaNotes, setVisaNotes] = useState("");
  const visaFileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (appId && messages.length > 0) {
      markAsRead({ applicationId: appId });
    }
  }, [appId, messages.length]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    if (app) {
      setAdminNoteInput(app.adminNotes ?? "");
      const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
      if (pricing) setSlotLocation(pricing.embassyAddress ?? "");
    }
  }, [app?._id]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgText.trim() || !appId) return;
    setIsSending(true);
    try {
      await sendMessage({ applicationId: appId, content: msgText });
      setMsgText("");
    } finally {
      setIsSending(false);
    }
  };

  const handleAction = async (action: () => Promise<unknown>, successMsg: string) => {
    try {
      await action();
      toast({ title: "✅ Succès", description: successMsg });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Action échouée";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    }
  };

  const handleMarkSlot = async () => {
    if (!appId || !slotDate || !slotTime || !slotLocation) {
      toast({ variant: "destructive", title: "Champs requis", description: "Date, heure et lieu sont obligatoires." });
      return;
    }
    setSlotSaving(true);
    try {
      await markSlotFound({ applicationId: appId, date: slotDate, time: slotTime, location: slotLocation, confirmationCode: slotCode || undefined });
      toast({ title: "Créneau enregistré", description: "Le client sera notifié." });
      setSlotDate(""); setSlotTime(""); setSlotCode("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lors de l'enregistrement";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    } finally {
      setSlotSaving(false);
    }
  };

  const handleMarkVisaObtained = async (file: File) => {
    if (!appId) return;
    setVisaUploading(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error("Échec de l'upload");
      const { storageId } = await res.json() as { storageId: string };
      await markVisaObtained({ applicationId: appId, storageId, notes: visaNotes || undefined });
      toast({ title: "Visa enregistré", description: "Le client recevra son visa après paiement de la prime." });
      setVisaNotes("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lors de l'enregistrement";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    } finally {
      setVisaUploading(false);
    }
  };

  const handleAdjustFee = async () => {
    if (!appId) return;
    const val = parseFloat(adjustFeeInput);
    if (isNaN(val) || val < 0) {
      toast({ variant: "destructive", title: "Montant invalide", description: "Entrez un montant en USD valide." });
      return;
    }
    setAdjustFeeSaving(true);
    try {
      await adjustSlotSuccessFee({
        applicationId: appId,
        newSuccessFee: val,
        reason: adjustFeeReason.trim() || undefined,
      });
      toast({ title: "Prime mise à jour", description: `Nouvelle prime : ${val} USD. Le client verra le montant actualisé.` });
      setShowAdjustFee(false);
      setAdjustFeeInput("");
      setAdjustFeeReason("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lors de la mise à jour";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    } finally {
      setAdjustFeeSaving(false);
    }
  };

  if (app === undefined)
    return <div className="p-12 text-center text-muted-foreground">Chargement...</div>;
  if (!app)
    return <div className="p-12 text-center text-red-500">Dossier introuvable</div>;

  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
  const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
  const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;
  const hasEngagementProof = !!app.paymentProofUrl;
  const hasSuccessProof = !!app.successFeeProofUrl;
  const isSlotHunting = app.status === "slot_hunting";
  const isSlotFound = app.status === "slot_found_awaiting_success_fee";
  const isCompleted = app.status === "completed";
  const isRejected = app.status === "rejected";
  const successModel = (app as { successModel?: string }).successModel ?? pricing?.successModel ?? "appointment";
  const isEvisaModel = successModel === "evisa";
  const servicePackage = (app as { servicePackage?: string }).servicePackage ?? "full_service";
  const isDossierOnly = servicePackage === "dossier_only";
  const isSlotOnly = servicePackage === "slot_only";
  const urgencyTierKey = (app as { slotUrgencyTier?: string }).slotUrgencyTier as SlotUrgencyTier | undefined;
  const urgencyTier = urgencyTierKey ? SLOT_URGENCY_TIERS[urgencyTierKey] : null;
  const canAdjustFee = isSlotOnly && !isSuccessFeePaid;

  const docsByKey = Object.fromEntries(docs.filter((d) => !d.isAdminUpload).map((d) => [d.docKey, d]));

  return (
    <div className="h-full flex flex-col xl:flex-row gap-6">
      {/* ===== LEFT COLUMN ===== */}
      <div className="w-full xl:w-2/3 space-y-6">

        {/* Header card */}
        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
          <div className="flex items-start justify-between mb-5 gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-serif font-bold text-primary">
                {app.destination.toUpperCase()} — {app.visaType}
              </h1>
              <p className="text-muted-foreground text-sm mt-0.5">
                Ref : JOV-{app._id.slice(-5).toUpperCase()} · {app.applicantName}
              </p>
            </div>
            <div className="flex flex-col items-end gap-2">
              <StatusBadge status={app.status} />
              <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
                isDossierOnly
                  ? "bg-blue-100 text-blue-700"
                  : servicePackage === "slot_only"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-orange-100 text-orange-700"
              }`}>
                <Package className="w-3 h-3" />
                {SERVICE_PACKAGES[servicePackage as keyof typeof SERVICE_PACKAGES]?.label ?? "Service Complet"}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
            <div className="flex items-start gap-2">
              <User className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-primary">{app.userFirstName} {app.userLastName}</p>
                {app.userEmail && <p className="text-xs text-muted-foreground">{app.userEmail}</p>}
                {app.userPhone && <p className="text-xs text-muted-foreground">{app.userPhone}</p>}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-medium mb-0.5">Passeport</p>
              <p className="font-medium">{app.passportNumber || "Non renseigné"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-medium mb-0.5">Voyage</p>
              <p className="font-medium">{formatDateOnly(app.travelDate)}</p>
              {app.returnDate && <p className="text-xs text-slate-500">Retour : {formatDateOnly(app.returnDate)}</p>}
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-medium mb-0.5">Motif</p>
              <p>{app.purpose}</p>
            </div>
            {app.notes && (
              <div className="sm:col-span-2">
                <p className="text-xs text-muted-foreground uppercase font-medium mb-0.5">Notes client</p>
                <p className="text-sm text-slate-600 italic">{app.notes}</p>
              </div>
            )}
          </div>

          {/* Slot booking references — slot_only only */}
          {isSlotOnly && (app as { slotBookingRefs?: Record<string, string | undefined> }).slotBookingRefs && (() => {
            const refs = (app as { slotBookingRefs?: Record<string, string | undefined> }).slotBookingRefs!;
            const rows: { label: string; value: string | undefined; hint?: string }[] = [
              { label: "DS-160 Barcode / Confirmation", value: refs.ds160Confirmation, hint: "ceac.state.gov" },
              { label: "Reçu MRV (frais visa)", value: refs.mrvReceiptNumber },
              { label: "SEVIS ID", value: refs.sevisId, hint: "F-1 / J-1 / M-1" },
              { label: "Reçu USCIS I-797 (pétition)", value: refs.petitionReceiptNumber },
              { label: "Nom du pétitionnaire", value: refs.petitionerName },
              { label: "Référence VFS", value: refs.vfsRefNumber },
            ].filter((r) => r.value);
            if (rows.length === 0) return null;
            return (
              <div className="mt-4 border border-blue-200 bg-blue-50/50 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-bold text-primary">Références de réservation</span>
                  <span className="text-xs text-blue-600 bg-blue-100 px-2 py-0.5 rounded-full font-medium">
                    {app.destination.toUpperCase()}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {rows.map((r) => (
                    <div key={r.label} className="bg-white rounded-lg px-3 py-2 border border-blue-100">
                      <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide mb-0.5">
                        {r.label}{r.hint && <span className="ml-1 normal-case text-blue-500">({r.hint})</span>}
                      </p>
                      <p className="font-mono text-sm font-semibold text-primary break-all">{r.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>

        {/* ===== PAYMENT PANEL ===== */}
        <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
          <div className="p-5 border-b border-border bg-slate-50 flex items-center gap-2">
            <CreditCard className="w-4 h-4 text-secondary" />
            <h2 className="font-bold text-primary text-base">Validation des Paiements</h2>
          </div>

          <div className="p-6 space-y-6">
            {/* Engagement fee row */}
            <div className={`rounded-xl border p-5 ${isEngagementPaid ? "border-green-200 bg-green-50" : hasEngagementProof ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {hasEngagementProof && proofUrls?.engagementUrl && (
                    <button
                      className="flex-shrink-0 rounded-lg overflow-hidden border border-border w-14 h-14 bg-white hover:opacity-80 transition-opacity"
                      onClick={() => setReceiptPreview(proofUrls.engagementUrl!)}
                      title="Voir le reçu"
                    >
                      <img
                        src={proofUrls.engagementUrl}
                        alt="Reçu engagement"
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </button>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-primary flex items-center gap-2">
                      {isEngagementPaid
                        ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                        : hasEngagementProof
                        ? <Clock className="w-4 h-4 text-amber-500" />
                        : <Clock className="w-4 h-4 text-slate-400" />}
                      Frais d'engagement — {app.priceDetails?.engagementFee ?? 0} USD
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {isEngagementPaid ? "Validé ✓" : hasEngagementProof ? "Reçu soumis — en attente de validation" : "Aucun reçu soumis"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {hasEngagementProof && proofUrls?.engagementUrl && !isEngagementPaid && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs gap-1"
                      onClick={() => setReceiptPreview(proofUrls.engagementUrl!)}
                    >
                      <Image className="w-3.5 h-3.5" /> Voir reçu
                    </Button>
                  )}
                  {hasEngagementProof && !isEngagementPaid && appId && (
                    <Button
                      size="sm"
                      className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white gap-1"
                      onClick={() =>
                        handleAction(
                          () => validateEngagement({ applicationId: appId }),
                          "Paiement d'engagement validé. Dossier activé."
                        )
                      }
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Valider paiement
                    </Button>
                  )}
                  {isEngagementPaid && (
                    <span className="text-xs font-semibold text-green-700 bg-green-100 px-2.5 py-1 rounded-full">Validé</span>
                  )}
                  {!hasEngagementProof && (
                    <span className="text-xs text-slate-400">En attente du reçu</span>
                  )}
                </div>
              </div>
            </div>

            {/* Success fee row */}
            <div className={`rounded-xl border p-5 ${isDossierOnly ? "border-slate-200 bg-slate-50 opacity-60" : isSuccessFeePaid ? "border-green-200 bg-green-50" : hasSuccessProof ? "border-amber-200 bg-amber-50" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {hasSuccessProof && proofUrls?.successFeeUrl && (
                    <button
                      className="flex-shrink-0 rounded-lg overflow-hidden border border-border w-14 h-14 bg-white hover:opacity-80 transition-opacity"
                      onClick={() => setReceiptPreview(proofUrls.successFeeUrl!)}
                      title="Voir le reçu"
                    >
                      <img
                        src={proofUrls.successFeeUrl}
                        alt="Reçu prime de succès"
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </button>
                  )}
                  <div>
                    <p className="text-sm font-semibold text-primary flex items-center gap-2">
                      {isDossierOnly
                        ? <span className="w-4 h-4 text-slate-400 inline-flex items-center justify-center text-xs">—</span>
                        : isSuccessFeePaid
                          ? <CheckCircle2 className="w-4 h-4 text-green-600" />
                          : hasSuccessProof
                            ? <Clock className="w-4 h-4 text-amber-500" />
                            : <Star className="w-4 h-4 text-slate-400" />}
                      Prime de succès — {isDossierOnly ? "Non applicable" : `${app.priceDetails?.successFee ?? 0} USD`}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {isDossierOnly
                        ? "Package Formulaires & Vérification — tarif fixe, pas de prime de succès"
                        : isSuccessFeePaid
                          ? "Validée ✓"
                          : hasSuccessProof
                            ? "Reçu soumis — en attente de validation"
                            : "En attente du créneau"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {hasSuccessProof && proofUrls?.successFeeUrl && !isSuccessFeePaid && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs gap-1"
                      onClick={() => setReceiptPreview(proofUrls.successFeeUrl!)}
                    >
                      <Image className="w-3.5 h-3.5" /> Voir reçu
                    </Button>
                  )}
                  {hasSuccessProof && !isSuccessFeePaid && appId && (
                    <Button
                      size="sm"
                      className="h-8 text-xs bg-green-600 hover:bg-green-700 text-white gap-1"
                      onClick={() =>
                        handleAction(
                          () => validateSuccess({ applicationId: appId }),
                          "Prime de succès validée. Dossier marqué complété."
                        )
                      }
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Valider prime
                    </Button>
                  )}
                  {isSuccessFeePaid && (
                    <span className="text-xs font-semibold text-green-700 bg-green-100 px-2.5 py-1 rounded-full">Validée</span>
                  )}
                  {!hasSuccessProof && (
                    <span className="text-xs text-slate-400">En attente du reçu</span>
                  )}
                </div>
              </div>
            </div>

            {/* Adjust slot success fee — slot_only only, before success fee is paid */}
            {canAdjustFee && (
              <div className="border border-amber-200 bg-amber-50 rounded-xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <Pencil className="w-4 h-4" />
                    Ajuster la prime de succès
                    {urgencyTier?.variableNote && (
                      <span className="text-xs font-normal text-amber-600 ml-1">— prime indicative</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-amber-300 text-amber-800 hover:bg-amber-100"
                    onClick={() => {
                      setShowAdjustFee((v) => !v);
                      if (!showAdjustFee) setAdjustFeeInput(String(app.priceDetails?.successFee ?? ""));
                    }}
                  >
                    {showAdjustFee ? "Annuler" : "Modifier"}
                  </Button>
                </div>
                {showAdjustFee && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-amber-700">
                      Prime actuelle : <strong>{app.priceDetails?.successFee ?? 0} USD</strong>.
                      Le client verra le nouveau montant en temps réel avant de payer le solde.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        type="number"
                        min={0}
                        placeholder="Nouvelle prime (USD)"
                        className="h-8 text-sm w-44"
                        value={adjustFeeInput}
                        onChange={(e) => setAdjustFeeInput(e.target.value)}
                      />
                      <Input
                        type="text"
                        placeholder="Motif (optionnel)"
                        className="h-8 text-sm flex-1"
                        value={adjustFeeReason}
                        onChange={(e) => setAdjustFeeReason(e.target.value)}
                      />
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-amber-600 hover:bg-amber-700 text-white px-4"
                        onClick={handleAdjustFee}
                        disabled={adjustFeeSaving}
                      >
                        {adjustFeeSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Confirmer"}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Revenue summary */}
            {app.priceDetails && (
              <div className="flex items-center gap-4 text-sm bg-slate-50 rounded-xl p-4 border border-slate-100">
                <div className="flex-1 text-center">
                  <p className="text-xs text-muted-foreground mb-0.5">Total attendu</p>
                  <p className="font-bold text-primary">{(app.priceDetails.engagementFee + app.priceDetails.successFee)} USD</p>
                </div>
                <div className="w-px h-8 bg-slate-200" />
                <div className="flex-1 text-center">
                  <p className="text-xs text-muted-foreground mb-0.5">Encaissé</p>
                  <p className="font-bold text-green-700">{app.priceDetails.paidAmount} USD</p>
                </div>
                <div className="w-px h-8 bg-slate-200" />
                <div className="flex-1 text-center">
                  <p className="text-xs text-muted-foreground mb-0.5">Restant</p>
                  <p className="font-bold text-amber-600">
                    {Math.max(0, (app.priceDetails.engagementFee + app.priceDetails.successFee) - app.priceDetails.paidAmount)} USD
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== QUICK ACTIONS ===== */}
        {!isCompleted && !isRejected && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-5 border-b border-border bg-slate-50 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-secondary" />
              <h2 className="font-bold text-primary text-base">Actions rapides</h2>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex flex-wrap gap-3">
                {app.status !== "in_review" && isEngagementPaid && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-primary/30 text-primary hover:bg-primary/5"
                    onClick={() =>
                      handleAction(
                        () => setInReview({ applicationId: appId!, adminNotes: adminNoteInput || undefined }),
                        "Dossier mis en révision."
                      )
                    }
                  >
                    <Search className="w-3.5 h-3.5" /> Mettre en révision
                  </Button>
                )}
                {!isDossierOnly && app.status !== "slot_hunting" && isEngagementPaid && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-purple-300 text-purple-700 hover:bg-purple-50"
                    onClick={() =>
                      handleAction(
                        () => setSlotHunting({ applicationId: appId! }),
                        "Recherche de créneau activée."
                      )
                    }
                  >
                    <Star className="w-3.5 h-3.5" /> Activer recherche créneau
                  </Button>
                )}

                {isDossierOnly && isEngagementPaid && !isCompleted && (
                  <Button
                    size="sm"
                    className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={() =>
                      handleAction(
                        () => completeDossierOnly({ applicationId: appId! }),
                        "Dossier marqué complété."
                      )
                    }
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" /> Marquer dossier complété
                  </Button>
                )}

                {!showRejectForm ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 border-red-300 text-red-600 hover:bg-red-50"
                    onClick={() => setShowRejectForm(true)}
                  >
                    <XCircle className="w-3.5 h-3.5" /> Rejeter le dossier
                  </Button>
                ) : (
                  <div className="w-full space-y-2">
                    <Textarea
                      placeholder="Raison du rejet (visible par le client)..."
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      rows={2}
                      className="bg-red-50 border-red-200 text-sm"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="bg-red-600 hover:bg-red-700 text-white"
                        onClick={() => {
                          if (!rejectReason.trim()) {
                            toast({ variant: "destructive", title: "Raison requise" });
                            return;
                          }
                          handleAction(
                            () => rejectApplication({ applicationId: appId!, reason: rejectReason }),
                            "Dossier rejeté."
                          );
                          setShowRejectForm(false);
                          setRejectReason("");
                        }}
                      >
                        Confirmer le rejet
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setShowRejectForm(false)}>
                        Annuler
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground uppercase">Notes internes admin</label>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={noteSaving || !appId}
                    onClick={async () => {
                      if (!appId) return;
                      setNoteSaving(true);
                      try {
                        await saveAdminNotes({ applicationId: appId, adminNotes: adminNoteInput });
                        toast({ title: "Notes sauvegardées" });
                      } catch (err: unknown) {
                        toast({ variant: "destructive", title: err instanceof Error ? err.message : "Erreur sauvegarde" });
                      } finally {
                        setNoteSaving(false);
                      }
                    }}
                  >
                    {noteSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Sauvegarder"}
                  </Button>
                </div>
                <Textarea
                  value={adminNoteInput}
                  onChange={(e) => setAdminNoteInput(e.target.value)}
                  placeholder="Notes internes (non visibles par le client)..."
                  rows={2}
                  className="bg-slate-50 text-sm"
                />
              </div>
            </div>
          </div>
        )}

        {/* ===== RESULT PANEL — Appointment model (USA, Turquie) ===== */}
        {!isEvisaModel && (isSlotHunting || isSlotFound) && !isCompleted && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-5 border-b border-border bg-slate-50 flex items-center gap-2">
              <Calendar className="w-4 h-4 text-secondary" />
              <h2 className="font-bold text-primary text-base">
                {isSlotFound ? "Créneau Enregistré" : "Enregistrer un Créneau"}
              </h2>
              <span className="ml-auto text-[11px] text-muted-foreground bg-slate-100 px-2 py-0.5 rounded-full">
                {pricing?.successCopy?.triggerLabel ?? "Rendez-vous"}
              </span>
            </div>
            <div className="p-6">
              {isSlotFound && app.appointmentDetails ? (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-1">
                  <p className="text-sm text-green-800 font-semibold flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> Créneau capturé — client en attente de paiement
                  </p>
                  <p className="text-sm text-slate-700">Date : <strong>{formatDateOnly(app.appointmentDetails.date)}</strong></p>
                  <p className="text-sm text-slate-700">Heure : <strong>{app.appointmentDetails.time}</strong></p>
                  <p className="text-sm text-slate-700">Lieu : <strong>{app.appointmentDetails.location}</strong></p>
                  {app.appointmentDetails.confirmationCode && (
                    <p className="text-sm text-slate-700">Code : <strong className="font-mono">{app.appointmentDetails.confirmationCode}</strong></p>
                  )}
                  {app.slotExpiresAt && (
                    <p className="text-xs text-amber-700 mt-2">
                      <AlertTriangle className="w-3 h-3 inline mr-1" />
                      Expire le : {formatDate(app.slotExpiresAt)}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Date RDV *</label>
                      <Input type="date" value={slotDate} onChange={(e) => setSlotDate(e.target.value)} className="h-10 bg-slate-50" />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Heure *</label>
                      <Input type="time" value={slotTime} onChange={(e) => setSlotTime(e.target.value)} className="h-10 bg-slate-50" />
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Lieu / Ambassade *</label>
                      <Input value={slotLocation} onChange={(e) => setSlotLocation(e.target.value)} placeholder="Adresse consulaire..." className="h-10 bg-slate-50" />
                    </div>
                    <div className="sm:col-span-2 space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground uppercase">Code de confirmation (optionnel)</label>
                      <Input value={slotCode} onChange={(e) => setSlotCode(e.target.value)} placeholder="Ex: CGO-2025-ABCDE" className="h-10 bg-slate-50 font-mono" />
                    </div>
                  </div>
                  <Button
                    onClick={handleMarkSlot}
                    disabled={slotSaving}
                    className="bg-green-600 hover:bg-green-700 text-white font-bold gap-2 h-11 w-full sm:w-auto"
                  >
                    {slotSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Star className="w-4 h-4" />}
                    {slotSaving ? "Enregistrement..." : "Confirmer le créneau (48h hold)"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== RESULT PANEL — E-Visa model (Dubaï, Inde) ===== */}
        {isEvisaModel && (isSlotHunting || isSlotFound) && !isCompleted && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-5 border-b border-border bg-slate-50 flex items-center gap-2">
              <FileText className="w-4 h-4 text-secondary" />
              <h2 className="font-bold text-primary text-base">
                {isSlotFound ? "Visa Enregistré" : "Enregistrer le Visa Obtenu"}
              </h2>
              <span className="ml-auto text-[11px] text-muted-foreground bg-slate-100 px-2 py-0.5 rounded-full">
                {pricing?.successCopy?.triggerLabel ?? "E-Visa"}
              </span>
            </div>
            <div className="p-6">
              {isSlotFound ? (
                <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-2">
                  <p className="text-sm text-green-800 font-semibold flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" /> Visa uploadé — client en attente de paiement
                  </p>
                  <p className="text-xs text-slate-600">
                    Le client recevra son document PDF dès validation de la prime de succès.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-slate-600">
                    Uploadez le PDF ou l'image du visa accordé par les autorités. Le client ne pourra télécharger
                    ce document qu'après avoir réglé la prime de succès.
                  </p>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase">Notes pour le client (optionnel)</label>
                    <Input
                      value={visaNotes}
                      onChange={(e) => setVisaNotes(e.target.value)}
                      placeholder="Ex: Visa valable 30j à partir de la date d'entrée..."
                      className="h-10 bg-slate-50"
                    />
                  </div>
                  <input
                    ref={visaFileRef}
                    type="file"
                    accept="application/pdf,image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleMarkVisaObtained(file);
                    }}
                  />
                  <Button
                    onClick={() => visaFileRef.current?.click()}
                    disabled={visaUploading}
                    className="bg-green-600 hover:bg-green-700 text-white font-bold gap-2 h-11 w-full sm:w-auto"
                  >
                    {visaUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {visaUploading ? "Upload en cours..." : "Uploader le visa PDF et déclencher la prime"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ===== DOCUMENT VAULT ===== */}
        {pricing && isEngagementPaid && (
          <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
            <div className="p-5 border-b border-border bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-secondary" />
                <h2 className="font-bold text-primary text-base">Coffre-fort Documents</h2>
              </div>
              <span className="text-xs text-muted-foreground">
                {docs.filter((d) => !d.isAdminUpload).length}/{pricing.requiredDocuments.length} fourni(s)
              </span>
            </div>

            <div className="p-6 space-y-6">
              {/* slot_only notice */}
              {servicePackage === "slot_only" && (
                <div className="flex items-start gap-3 bg-purple-50 border border-purple-200 rounded-xl p-4 text-sm text-purple-800">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-purple-500" />
                  <p>
                    <strong>Package Créneau Uniquement :</strong> Le client a déclaré que son dossier est déjà constitué.
                    Les documents ci-dessous sont <strong>optionnels</strong> sur la plateforme — ils peuvent être soumis directement au consulat par le client.
                  </p>
                </div>
              )}

              {/* Client documents */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-3">Documents du client</p>
                <div>
                  {pricing.requiredDocuments.map((doc) => (
                    <DocUploadRow
                      key={doc.key}
                      appId={appId!}
                      docKey={doc.key}
                      label={doc.label}
                      required={doc.required}
                      existingDoc={docsByKey[doc.key]}
                      isAdminContext={true}
                    />
                  ))}
                </div>
              </div>

              {/* Admin-uploaded documents */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase mb-3">Documents admin (versions officielles, attestations, etc.)</p>
                {/* Existing admin docs */}
                <div>
                  {docs.filter((d) => d.isAdminUpload).map((doc) => (
                    <DocUploadRow
                      key={`admin-${doc._id}`}
                      appId={appId!}
                      docKey={doc.docKey}
                      label={doc.label}
                      required={false}
                      existingDoc={doc}
                      isAdminContext={true}
                    />
                  ))}
                  {docs.filter((d) => d.isAdminUpload).length === 0 && (
                    <p className="text-sm text-slate-400 italic py-2">Aucun document admin ajouté.</p>
                  )}
                </div>
                {/* Add new arbitrary admin doc */}
                <AdminCustomDocUpload appId={appId!} />
              </div>
            </div>
          </div>
        )}

        {/* ===== ACTIVITY LOG ===== */}
        {app.logs && app.logs.length > 0 && (
          <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
            <h2 className="font-bold text-primary mb-4 text-base">Journal d'activité</h2>
            <div className="relative border-l-2 border-slate-100 ml-3 space-y-5 pb-2">
              {[...app.logs].reverse().map((log, idx) => {
                const m = log.msg.toLowerCase();
                let dotColor = "bg-primary";
                if (m.includes("créé") || m.includes("nouveau")) dotColor = "bg-blue-500";
                else if (m.includes("validé") || m.includes("paiement")) dotColor = "bg-green-500";
                else if (m.includes("créneau") || m.includes("rendez-vous")) dotColor = "bg-secondary";
                else if (m.includes("refusé") || m.includes("rejeté")) dotColor = "bg-red-500";
                else if (m.includes("reçu") || m.includes("uploadé")) dotColor = "bg-violet-500";
                else if (m.includes("révision") || m.includes("traitement")) dotColor = "bg-indigo-500";

                return (
                  <div key={idx} className="relative pl-6">
                    <div className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ${dotColor} border-2 border-white`} />
                    <p className="text-sm text-slate-700">{log.msg}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(log.time)} · {log.author ?? "système"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* ===== RIGHT PANEL — Chat ===== */}
      <div className="w-full xl:w-1/3 bg-white rounded-2xl border border-border shadow-sm flex flex-col h-[600px] xl:h-[calc(100vh-120px)] xl:sticky xl:top-24">
        <div className="p-4 border-b border-border bg-slate-50 rounded-t-2xl flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-secondary" />
          <div>
            <h3 className="font-bold text-primary">Messagerie Client</h3>
            <p className="text-xs text-muted-foreground">
              {app.userFirstName} {app.userLastName}
            </p>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-center text-xs text-muted-foreground mb-6">
            Début de la conversation
          </div>
          {messages.map((msg) => {
            const isAdmin = msg.isFromAdmin;
            return (
              <div key={msg._id} className={`flex flex-col ${isAdmin ? "items-end" : "items-start"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-500">{msg.senderName}</span>
                  <span className="text-[10px] text-slate-400">{formatDate(msg._creationTime)}</span>
                </div>
                <div
                  className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm ${
                    isAdmin
                      ? "bg-primary text-white rounded-br-none"
                      : "bg-slate-100 text-slate-800 rounded-bl-none border border-slate-200"
                  }`}
                >
                  {msg.content}
                </div>
              </div>
            );
          })}
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground text-sm py-8">
              Aucun message. Initiez la conversation.
            </div>
          )}
        </div>

        <form onSubmit={handleSend} className="p-4 border-t border-border bg-white rounded-b-2xl">
          <div className="relative">
            <Input
              value={msgText}
              onChange={(e) => setMsgText(e.target.value)}
              placeholder="Répondre au client..."
              className="pr-12 h-12 rounded-xl bg-slate-50"
            />
            <Button
              type="submit"
              size="icon"
              disabled={isSending || !msgText.trim()}
              className="absolute right-1.5 top-1.5 h-9 w-9 bg-secondary hover:bg-orange-500 text-primary"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </form>
      </div>

      {receiptPreview && (
        <PaymentReceiptModal url={receiptPreview} onClose={() => setReceiptPreview(null)} />
      )}
    </div>
  );
}
