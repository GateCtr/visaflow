import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@convex/_generated/api";
import { Doc, Id } from "@convex/_generated/dataModel";
import { VISA_PRICING, SERVICE_PACKAGES, SLOT_URGENCY_TIERS, type SlotUrgencyTier } from "@convex/constants";
import { getUploadDocs } from "@convex/visaDocuments";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  Bot,
  Play,
  Pause,
  Trash2,
  Link,
  Copy,
  Check,
} from "lucide-react";

function NextSessionCountdown({ endedAt, urgencyTier, isActive }: { endedAt: string; urgencyTier: string; isActive: boolean }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!isActive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isActive]);

  if (!isActive) {
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-50 border border-slate-200">
        <Pause className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-xs text-slate-500 font-medium">Hunter en pause</span>
      </div>
    );
  }

  // Intervalles par tier (alignés avec index.ts du slot-hunter)
  const TIER_INTERVALS: Record<string, { min: number; max: number }> = {
    tres_urgent:  { min:  3 * 60_000, max:  5 * 60_000 },
    urgent:       { min: 15 * 60_000, max: 20 * 60_000 },
    prioritaire:  { min: 25 * 60_000, max: 35 * 60_000 },
    standard:     { min: 45 * 60_000, max: 60 * 60_000 },
  };

  const interval = TIER_INTERVALS[urgencyTier] ?? TIER_INTERVALS.standard;
  const avgInterval = (interval.min + interval.max) / 2;
  const endedAtMs = new Date(endedAt).getTime();
  const nextSessionAt = endedAtMs + avgInterval;
  const remaining = nextSessionAt - now;

  if (remaining <= 0) {
    return (
      <div className="mt-2 flex items-center gap-2 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 animate-pulse">
        <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin" />
        <span className="text-xs text-blue-700 font-medium">Prochaine session imminente…</span>
      </div>
    );
  }

  const mins = Math.floor(remaining / 60_000);
  const secs = Math.floor((remaining % 60_000) / 1000);
  const display = mins > 0 ? `${mins}m ${secs.toString().padStart(2, "0")}s` : `${secs}s`;
  const progress = Math.max(0, Math.min(100, ((avgInterval - remaining) / avgInterval) * 100));

  return (
    <div className="mt-2 px-3 py-2 rounded-lg bg-indigo-50 border border-indigo-200">
      <div className="flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-indigo-600" />
        <span className="text-xs text-indigo-700 font-semibold">Prochaine session dans {display}</span>
        <span className="text-[10px] text-indigo-400 ml-auto">{urgencyTier}</span>
      </div>
      <div className="mt-1.5 h-1 bg-indigo-100 rounded-full overflow-hidden">
        <div className="h-full bg-indigo-500 rounded-full transition-all duration-1000" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

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

  const [logStepFilter, setLogStepFilter] = useState("");
  const [logStatusFilter, setLogStatusFilter] = useState<"" | "ok" | "warn" | "fail">("");
  const [logPage, setLogPage] = useState(0);
  const [logExpanded, setLogExpanded] = useState<Set<string>>(new Set());
  const [logCopied, setLogCopied] = useState<string | null>(null);
  const [logClearing, setLogClearing] = useState(false);
  const LOG_PAGE_SIZE = 12;

  const clearLogsByApp = useMutation(api.botLogs.clearByApplication);

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const proofUrls = useQuery(api.documents.getPaymentProofUrls, appId ? { applicationId: appId } : "skip");
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const botLogs = useQuery(api.botLogs.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];

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
  const updateSlotUrgencyTier = useMutation(api.admin.updateSlotUrgencyTier);
  const setHunterConfig = useMutation(api.hunter.setHunterConfig);
  const resetHunterConfig = useMutation(api.hunter.resetHunterConfig);
  const checkCaptchaBalance = useAction(api.hunter.checkTwoCaptchaBalance);
  const [hunterUsername, setHunterUsername] = useState("");
  const [hunterPassword, setHunterPassword] = useState("");
  const [hunterTwoCaptchaKey, setHunterTwoCaptchaKey] = useState("");
  const [hunterSlotDateFrom, setHunterSlotDateFrom] = useState("");
  const [hunterSlotDateDeadline, setHunterSlotDateDeadline] = useState("");
  const [hunterActive, setHunterActive] = useState(false);
  const [hunterVowintAppId, setHunterVowintAppId] = useState("");
  const [hunterCevCountry, setHunterCevCountry] = useState("");
  const [hunterScheduleUrl, setHunterScheduleUrl] = useState("");
  const [hunterRescheduleMode, setHunterRescheduleMode] = useState(false);
  const [hunterRescheduleExistingDate, setHunterRescheduleExistingDate] = useState("");
  const [hunterUseProxy, setHunterUseProxy] = useState(false);
  const [hunterSaving, setHunterSaving] = useState(false);
  const [captchaBalance, setCaptchaBalance] = useState<number | null>(null);
  const [captchaBalanceChecking, setCaptchaBalanceChecking] = useState(false);
  const [captchaBalanceError, setCaptchaBalanceError] = useState<string | null>(null);
  const [showHunterPassword, setShowHunterPassword] = useState(false);
  const [showTwoCaptchaKey, setShowTwoCaptchaKey] = useState(false);
  const [noteSaving, setNoteSaving] = useState(false);
  const [visaUploading, setVisaUploading] = useState(false);
  const [showAdjustFee, setShowAdjustFee] = useState(false);
  const [showChangeTier, setShowChangeTier] = useState(false);
  const [newTierValue, setNewTierValue] = useState<SlotUrgencyTier | "">("");
  const [changeTierReason, setChangeTierReason] = useState("");
  const [changeTierSaving, setChangeTierSaving] = useState(false);
  const [trackingLinkCopied, setTrackingLinkCopied] = useState(false);
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
      const hc = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; twoCaptchaApiKey?: string; slotDateFrom?: string; slotDateDeadline?: string; vowintAppId?: string; cevCountry?: string; scheduleUrl?: string; rescheduleMode?: boolean; rescheduleExistingDate?: string } }).hunterConfig;
      if (hc) {
        setHunterUsername(hc.embassyUsername);
        setHunterPassword(hc.embassyPassword);
        setHunterActive(hc.isActive);
        setHunterTwoCaptchaKey(hc.twoCaptchaApiKey ?? "");
        setHunterSlotDateFrom(hc.slotDateFrom ?? "");
        setHunterSlotDateDeadline(hc.slotDateDeadline ?? "");
        setHunterVowintAppId(hc.vowintAppId ?? "");
        setHunterCevCountry(hc.cevCountry ?? "");
        setHunterScheduleUrl(hc.scheduleUrl ?? "");
        setHunterRescheduleMode(hc.rescheduleMode ?? false);
        setHunterRescheduleExistingDate(hc.rescheduleExistingDate ?? "");
        setHunterUseProxy((hc as { useResidentialProxy?: boolean }).useResidentialProxy ?? false);
      } else {
        setHunterUsername("");
        setHunterPassword("");
        setHunterActive(false);
        setHunterTwoCaptchaKey("");
        setHunterSlotDateFrom("");
        setHunterSlotDateDeadline("");
        setHunterVowintAppId("");
        setHunterCevCountry("");
        setHunterScheduleUrl("");
        setHunterRescheduleMode(false);
        setHunterRescheduleExistingDate("");
        setHunterUseProxy(false);
      }
    }
  }, [app?._id]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!msgText.trim() || !appId) return;
    setIsSending(true);
    try {
      await sendMessage({ applicationId: appId, content: msgText });
      setMsgText("");
    } catch (err: unknown) {
      toast({
        variant: "destructive",
        title: "Erreur d'envoi",
        description: err instanceof Error ? err.message : "Le message n'a pas pu être envoyé.",
      });
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

  const handleChangeTier = async () => {
    if (!appId || !newTierValue) return;
    setChangeTierSaving(true);
    try {
      await updateSlotUrgencyTier({
        applicationId: appId,
        newTier: newTierValue,
        reason: changeTierReason.trim() || undefined,
      });
      const label = SLOT_URGENCY_TIERS[newTierValue].label;
      toast({ title: "Tier mis à jour", description: `Nouveau tier : ${label}. L'intervalle de scan sera modifié au prochain cycle.` });
      setShowChangeTier(false);
      setNewTierValue("");
      setChangeTierReason("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erreur lors du changement de tier";
      toast({ variant: "destructive", title: "Erreur", description: msg });
    } finally {
      setChangeTierSaving(false);
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

  const docsByKey = Object.fromEntries(
    docs
      .filter((d: Doc<"documents"> & { url?: string | null }) => !d.isAdminUpload)
      .map((d: Doc<"documents"> & { url?: string | null }) => [d.docKey, { 
        _id: d._id, 
        url: d.url ?? null, 
        verifiedByAdmin: d.verifiedByAdmin, 
        isAdminUpload: d.isAdminUpload 
      }])
  );

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
              {(app as { trackingToken?: string }).trackingToken && (
                <button
                  onClick={() => {
                    const token = (app as { trackingToken?: string }).trackingToken!;
                    navigator.clipboard.writeText(`https://joventy.cd/suivi/${token}`);
                    setTrackingLinkCopied(true);
                    setTimeout(() => setTrackingLinkCopied(false), 2000);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                >
                  {trackingLinkCopied
                    ? <><Check className="w-3 h-3 text-green-600" /><span className="text-green-600">Lien copié !</span></>
                    : <><Link className="w-3 h-3" />Lien de suivi</>
                  }
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
            <div className="flex items-start gap-2">
              <User className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-semibold text-primary">{app.userFirstName} {app.userLastName}</p>
                {app.userEmail && <p className="text-xs text-muted-foreground">{app.userEmail}</p>}
                {app.userPhone && <p className="text-xs text-muted-foreground">{app.userPhone}</p>}
                {(app as { userWhatsapp?: string }).userWhatsapp && (
                  <a
                    href={`https://wa.me/${(app as { userWhatsapp?: string }).userWhatsapp!.replace(/[^\d+]/g, "")}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-green-600 hover:underline flex items-center gap-1"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.119.553 4.107 1.521 5.831L0 24l6.335-1.521A11.93 11.93 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.013-1.374l-.36-.214-3.728.977.994-3.637-.234-.374A9.818 9.818 0 1112 21.818z"/></svg>
                    {(app as { userWhatsapp?: string }).userWhatsapp}
                  </a>
                )}
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

          {/* CEV metadata — Schengen only */}
          {app.destination === "schengen" && (() => {
            const cev = app as { cevVisaClass?: string; cevApplicantAgeCategory?: string; cevTargetCountry?: string };
            const ageCatLabel: Record<string, string> = {
              adult: "Adulte (≥ 12 ans)",
              child_6_12: "Enfant 6-12 ans",
              child_under_6: "Enfant < 6 ans",
            };
            const rows = [
              { label: "Classe visa CEV", value: cev.cevVisaClass ? `Visa ${cev.cevVisaClass}` : undefined },
              { label: "Catégorie âge", value: cev.cevApplicantAgeCategory ? ageCatLabel[cev.cevApplicantAgeCategory] : undefined },
              { label: "Pays Schengen cible", value: cev.cevTargetCountry },
            ].filter((r) => r.value);
            if (rows.length === 0) return null;
            return (
              <div className="mt-4 border border-indigo-200 bg-indigo-50/60 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-sm">🇪🇺</span>
                  <span className="text-sm font-bold text-primary">Informations CEV</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {rows.map((r) => (
                    <div key={r.label} className="bg-white rounded-lg px-3 py-2 border border-indigo-100">
                      <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide mb-0.5">{r.label}</p>
                      <p className="text-sm font-semibold text-primary">{r.value}</p>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

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
              { label: "URL page RDV VOWINT", value: refs.vowintAppId, hint: "CEV Schengen" },
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

            {/* Change urgency tier — slot_only only, admin can upgrade/downgrade */}
            {canAdjustFee && urgencyTierKey && (
              <div className="border border-blue-200 bg-blue-50 rounded-xl p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-semibold text-blue-800">
                    <Pencil className="w-4 h-4" />
                    Changer le tier d'urgence
                    <span className="text-xs font-normal text-blue-600 ml-1">
                      — actuel : {urgencyTier?.label ?? urgencyTierKey}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-blue-300 text-blue-800 hover:bg-blue-100"
                    onClick={() => {
                      setShowChangeTier((v) => !v);
                      if (!showChangeTier) setNewTierValue("");
                    }}
                  >
                    {showChangeTier ? "Annuler" : "Modifier"}
                  </Button>
                </div>
                {showChangeTier && (
                  <div className="mt-3 space-y-2">
                    <p className="text-xs text-blue-700">
                      Le nouveau tier prendra effet au prochain cycle de scan (pas besoin de redemarrer le bot).
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      <select
                        className="h-8 text-sm rounded-md border border-blue-200 px-2 bg-white"
                        value={newTierValue}
                        onChange={(e) => setNewTierValue(e.target.value as SlotUrgencyTier)}
                      >
                        <option value="">-- Choisir --</option>
                        {(Object.keys(SLOT_URGENCY_TIERS) as SlotUrgencyTier[])
                          .filter((k) => k !== urgencyTierKey)
                          .map((k) => (
                            <option key={k} value={k}>
                              {SLOT_URGENCY_TIERS[k].label} ({SLOT_URGENCY_TIERS[k].tagline})
                            </option>
                          ))}
                      </select>
                      <Input
                        type="text"
                        placeholder="Motif (optionnel)"
                        className="h-8 text-sm flex-1 min-w-[150px]"
                        value={changeTierReason}
                        onChange={(e) => setChangeTierReason(e.target.value)}
                      />
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-blue-600 hover:bg-blue-700 text-white px-4"
                        onClick={handleChangeTier}
                        disabled={changeTierSaving || !newTierValue}
                      >
                        {changeTierSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Confirmer"}
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

        {/* ===== JOVENTY HUNTER CONFIG ===== */}
        {isSlotOnly && isSlotHunting && (() => {
          const hc = (app as { hunterConfig?: { embassyUsername: string; embassyPassword: string; isActive: boolean; lastCheckAt?: number; checkCount?: number; lastResult?: string } }).hunterConfig;
          const handleCheckCaptchaBalance = async () => {
            if (!appId) return;
            setCaptchaBalanceChecking(true);
            setCaptchaBalanceError(null);
            setCaptchaBalance(null);
            try {
              const result = await checkCaptchaBalance({ applicationId: appId });
              setCaptchaBalance(result.balance);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              if ((result as any).keySource === "global") {
                console.info("[2captcha] Solde vérifié via clé globale Railway (TWOCAPTCHA_API_KEY)");
              }
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Erreur inconnue";
              setCaptchaBalanceError(msg);
            } finally {
              setCaptchaBalanceChecking(false);
            }
          };
          const handleSaveHunter = async () => {
            if (!appId) return;
            if (!hunterUsername.trim() || !hunterPassword.trim()) {
              toast({ variant: "destructive", title: "Champs requis", description: "Identifiant et mot de passe USTravelDocs sont obligatoires." });
              return;
            }
            setHunterSaving(true);
            try {
              await setHunterConfig({ applicationId: appId, embassyUsername: hunterUsername, embassyPassword: hunterPassword, isActive: hunterActive, twoCaptchaApiKey: hunterTwoCaptchaKey || undefined, slotDateFrom: hunterSlotDateFrom || undefined, slotDateDeadline: hunterSlotDateDeadline || undefined, vowintAppId: hunterVowintAppId || undefined, cevCountry: hunterCevCountry || undefined, scheduleUrl: hunterScheduleUrl || undefined, rescheduleMode: hunterRescheduleMode || undefined, rescheduleExistingDate: hunterRescheduleExistingDate || undefined, useResidentialProxy: hunterUseProxy || undefined });
              toast({ title: "Joventy Hunter mis à jour", description: hunterActive ? "Le robot est maintenant actif." : "Robot en pause." });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Erreur";
              toast({ variant: "destructive", title: "Erreur", description: msg });
            } finally {
              setHunterSaving(false);
            }
          };
          const handleResetHunter = async () => {
            if (!appId) return;
            setHunterSaving(true);
            try {
              await resetHunterConfig({ applicationId: appId });
              setHunterUsername(""); setHunterPassword(""); setHunterTwoCaptchaKey(""); setHunterActive(false); setHunterScheduleUrl(""); setHunterRescheduleMode(false); setHunterRescheduleExistingDate("");
              toast({ title: "Config Hunter supprimée", description: "Les identifiants ont été effacés." });
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : "Erreur";
              toast({ variant: "destructive", title: "Erreur", description: msg });
            } finally {
              setHunterSaving(false);
            }
          };
          const lastResultLabel: Record<string, string> = {
            not_found: "Aucun créneau disponible",
            captcha: "Bloqué par CAPTCHA",
            error: "Erreur technique",
            slot_captured: "Créneau capturé !",
            payment_required: "💳 Paiement MRV requis",
          };
          return (
            <div className="bg-white rounded-2xl border border-purple-200 shadow-sm overflow-hidden">
              <div className="p-5 border-b border-purple-100 bg-purple-50 flex items-center gap-2">
                <Bot className="w-4 h-4 text-purple-600" />
                <h2 className="font-bold text-purple-800 text-base">Joventy Hunter</h2>
                <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full font-medium"
                  style={{ background: hc?.isActive ? "#dcfce7" : "#f1f5f9", color: hc?.isActive ? "#166534" : "#64748b" }}>
                  {hc?.isActive ? "Actif" : hc ? "En pause" : "Non configuré"}
                </span>
              </div>
              <div className="p-6 space-y-5">
                {/* Portail cible */}
                {(pricing as { portalUrl?: string; portalName?: string } | undefined)?.portalUrl && (
                  <div className="space-y-1.5 bg-slate-50 rounded-lg px-4 py-3 border border-slate-200">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide shrink-0">Login :</span>
                      <a
                        href={(pricing as { portalUrl?: string }).portalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-primary font-semibold underline underline-offset-2 truncate"
                      >
                        {(pricing as { portalName?: string; portalUrl?: string }).portalName ?? (pricing as { portalUrl?: string }).portalUrl}
                      </a>
                    </div>
                    {(pricing as { portalAppointmentUrl?: string } | undefined)?.portalAppointmentUrl && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground font-medium uppercase tracking-wide shrink-0">Créneaux :</span>
                        <a
                          href={(pricing as { portalAppointmentUrl?: string }).portalAppointmentUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary font-semibold underline underline-offset-2 truncate"
                        >
                          {(pricing as { portalAppointmentUrl?: string }).portalAppointmentUrl}
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <p className="text-sm text-slate-600">
                  Configurez les identifiants du portail visa du client. Le robot recherchera automatiquement un créneau et vous notifiera dès qu'un slot est capturé.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase">Identifiant portail (email)</label>
                    <Input
                      value={hunterUsername}
                      onChange={(e) => setHunterUsername(e.target.value)}
                      placeholder="email@exemple.com"
                      className="h-10 bg-slate-50"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase">Mot de passe portail</label>
                    <div className="relative">
                      <Input
                        type={showHunterPassword ? "text" : "password"}
                        value={hunterPassword}
                        onChange={(e) => setHunterPassword(e.target.value)}
                        placeholder="••••••••"
                        className="h-10 bg-slate-50 pr-10"
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
                        onClick={() => setShowHunterPassword((v) => !v)}
                      >
                        <Eye className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                  <div className="sm:col-span-2 space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground uppercase flex items-center gap-1.5">
                      Clé API 2captcha
                      <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-normal normal-case">Résolution auto CAPTCHA</span>
                    </label>
                    <div className="flex gap-2 items-center">
                      <div className="relative flex-1">
                        <Input
                          type={showTwoCaptchaKey ? "text" : "password"}
                          value={hunterTwoCaptchaKey}
                          onChange={(e) => { setHunterTwoCaptchaKey(e.target.value); setCaptchaBalance(null); setCaptchaBalanceError(null); }}
                          placeholder="Clé 2captcha.com (optionnel)"
                          className="h-10 bg-slate-50 pr-10 font-mono text-sm"
                        />
                        <button
                          type="button"
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-primary"
                          onClick={() => setShowTwoCaptchaKey((v) => !v)}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                      </div>
                      <button
                        type="button"
                        disabled={captchaBalanceChecking}
                        onClick={handleCheckCaptchaBalance}
                        className="shrink-0 h-10 px-3 text-xs font-medium rounded-lg border border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors"
                      >
                        {captchaBalanceChecking
                          ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Vérification...</>
                          : "Vérifier solde"}
                      </button>
                    </div>
                    {/* Balance result */}
                    {captchaBalance !== null && (
                      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border ${
                        captchaBalance >= 5
                          ? "bg-green-50 border-green-200 text-green-700"
                          : captchaBalance >= 1
                          ? "bg-amber-50 border-amber-200 text-amber-700"
                          : "bg-red-50 border-red-200 text-red-700"
                      }`}>
                        <span className="text-base">{captchaBalance >= 5 ? "✅" : captchaBalance >= 1 ? "⚠️" : "🔴"}</span>
                        <span>
                          Solde 2captcha : <strong>${captchaBalance.toFixed(2)}</strong>
                          {captchaBalance >= 5
                            ? " — Bon niveau, le robot peut tourner plusieurs semaines"
                            : captchaBalance >= 1
                            ? " — À surveiller, pensez à recharger"
                            : " — Solde critique ! Rechargez maintenant sur 2captcha.com"}
                        </span>
                      </div>
                    )}
                    {captchaBalanceError && (
                      <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border bg-red-50 border-red-200 text-red-600">
                        <span>⚠️</span>
                        <span>{captchaBalanceError}</span>
                      </div>
                    )}
                    <p className="text-[11px] text-slate-400">
                      Si fournie, le robot soumettra automatiquement les CAPTCHAs à 2captcha.com pour les résoudre. Coût : ~$0,003 / CAPTCHA · Budget $10 = +3 000 résolutions.
                    </p>
                  </div>
                </div>

                {/* CEV / Schengen — config VOWINT */}
                {app.destination === "schengen" && (
                  <div className="space-y-3 border border-indigo-200 bg-indigo-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-indigo-800 uppercase tracking-wide flex items-center gap-1.5">
                      🇪🇺 Configuration VOWINT (CEV Schengen)
                    </p>
                    <p className="text-[11px] text-indigo-600">
                      Les identifiants portail ci-dessus sont les accès VOWINT (<strong>visaonweb.diplomatie.be</strong>) du client.
                      Collez l'URL complète de la page de demande sur VOWINT et renseignez le pays Schengen cible.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-indigo-700 uppercase">URL page RDV VOWINT</label>
                        <Input
                          value={hunterVowintAppId}
                          onChange={(e) => setHunterVowintAppId(e.target.value)}
                          placeholder="https://visaonweb.diplomatie.be/Application/Detail/12345"
                          className="h-9 bg-white text-sm font-mono"
                        />
                        <p className="text-[10px] text-indigo-400">URL complète de la page avec le bouton "Prendre rendez-vous" sur VOWINT</p>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-indigo-700 uppercase">Pays Schengen cible</label>
                        <Input
                          value={hunterCevCountry}
                          onChange={(e) => setHunterCevCountry(e.target.value)}
                          placeholder="France, Belgique, Allemagne..."
                          className="h-9 bg-white text-sm"
                        />
                        <p className="text-[10px] text-indigo-400">Pays de l'ambassade/consulat demandé</p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Espagne — URL Bookitit */}
                {app.destination === "spain" && (
                  <div className="space-y-3 border border-red-200 bg-red-50 rounded-xl p-4">
                    <p className="text-xs font-semibold text-red-800 uppercase tracking-wide flex items-center gap-1.5">
                      🇪🇸 Configuration Bookitit (citaconsular.es)
                    </p>
                    <p className="text-[11px] text-red-600">
                      Le client doit d'abord s'inscrire par email à <strong>emb.kinshasa.citasvis@maec.es</strong> (objet : <em>RENDEZ-VOUS VISA EST</em>) avec photo+passeport, formulaire, réservation vol et assurance santé. L'ambassade renvoie un identifiant et mot de passe — renseignez-les dans les champs ci-dessus. Le bot prend ensuite le rendez-vous sur l'URL Bookitit ci-dessous.
                    </p>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-red-700 uppercase">URL Bookitit de réservation</label>
                      <Input
                        value={hunterScheduleUrl}
                        onChange={(e) => setHunterScheduleUrl(e.target.value)}
                        placeholder="https://www.citaconsular.es/es/hosteds/widgetdefault/25028fcd7126544630b8da0c6e60722b5"
                        className="h-9 bg-white text-sm font-mono"
                      />
                      <p className="text-[10px] text-red-400">
                        URL officielle Ambassade d'Espagne Kinshasa. Pré-remplie automatiquement si laissée vide — modifiez uniquement si l'ambassade change d'URL.
                      </p>
                    </div>
                    {hunterScheduleUrl && (
                      <a
                        href={hunterScheduleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-red-700 underline underline-offset-2 font-medium"
                      >
                        <Link className="w-3 h-3" />
                        Vérifier l'URL dans un nouvel onglet
                      </a>
                    )}
                  </div>
                )}

                {/* Proxy résidentiel USA */}
                {app.destination === "usa" && (
                  <div className="space-y-3 border border-teal-200 bg-teal-50 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-teal-800 uppercase tracking-wide flex items-center gap-1.5">
                        🌐 Proxy Résidentiel (USA)
                      </p>
                      <button
                        type="button"
                        onClick={() => setHunterUseProxy((v) => !v)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${hunterUseProxy ? "bg-teal-500" : "bg-slate-300"}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${hunterUseProxy ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                    <p className="text-[11px] text-teal-700">
                      Active un proxy résidentiel sticky (60 min) via iProyal pour masquer l'IP datacenter Railway.
                      <strong> Attention :</strong> le portail USA lie le JWT à l'IP du login — si le proxy change mid-session, les requêtes échoueront (401).
                      Ne l'activer que si Railway est bloqué ou si vous constatez des restrictions liées à l'IP.
                    </p>
                  </div>
                )}

                {/* Plage de dates de recherche */}
                <div className="space-y-2 border border-blue-100 bg-blue-50 rounded-xl p-4">
                  <p className="text-xs font-semibold text-blue-800 uppercase tracking-wide">Fenêtre de réservation</p>
                  <p className="text-[11px] text-blue-600">
                    Laissez vide pour prendre le premier créneau disponible. Renseignez une ou les deux dates pour limiter la recherche.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">Date minimum (ne pas réserver avant)</label>
                      <Input
                        type="date"
                        value={hunterSlotDateFrom}
                        onChange={(e) => setHunterSlotDateFrom(e.target.value)}
                        className="h-9 bg-white text-sm"
                      />
                      <p className="text-[10px] text-slate-400">Ex : laisser 4 semaines pour préparer les documents</p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">Date limite absolue (ne pas dépasser)</label>
                      <Input
                        type="date"
                        value={hunterSlotDateDeadline}
                        onChange={(e) => setHunterSlotDateDeadline(e.target.value)}
                        className="h-9 bg-white text-sm"
                      />
                      <p className="text-[10px] text-slate-400">Ex : 2 semaines avant la date de voyage</p>
                    </div>
                  </div>
                  {hunterSlotDateDeadline && (
                    <p className="text-[11px] text-blue-700 font-medium pt-1">
                      ✓ Seuls les créneaux jusqu'au <strong>{new Date(hunterSlotDateDeadline + "T12:00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</strong> seront acceptés.
                    </p>
                  )}
                </div>

                {/* Mode reporter — USA uniquement */}
                {app.destination === "usa" && (
                  <div className="space-y-3 border border-orange-200 bg-orange-50 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-orange-800 uppercase tracking-wide flex items-center gap-1.5">
                        🔄 Mode Reporter (Reschedule)
                      </p>
                      <button
                        type="button"
                        onClick={() => setHunterRescheduleMode((v) => !v)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${hunterRescheduleMode ? "bg-orange-500" : "bg-slate-300"}`}
                      >
                        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${hunterRescheduleMode ? "translate-x-4" : "translate-x-0.5"}`} />
                      </button>
                    </div>
                    <p className="text-[11px] text-orange-700">
                      Le client a déjà un RDV mais souhaite en obtenir un <strong>plus tôt</strong>. Activez ce mode et indiquez la date du RDV existant — le robot ne prendra que des créneaux antérieurs à cette date.
                    </p>
                    {hunterRescheduleMode && (
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-orange-700 uppercase">Date du RDV existant</label>
                        <Input
                          type="date"
                          value={hunterRescheduleExistingDate}
                          onChange={(e) => setHunterRescheduleExistingDate(e.target.value)}
                          className="h-9 bg-white text-sm"
                        />
                        <p className="text-[10px] text-orange-500">Le robot cherchera uniquement des créneaux avant cette date (deadline = veille).</p>
                        {hunterRescheduleExistingDate && (
                          <p className="text-[11px] text-orange-800 font-medium pt-1">
                            ✓ Deadline automatique : <strong>{new Date(new Date(hunterRescheduleExistingDate + "T12:00:00").getTime() - 86400000).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</strong>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setHunterActive((v) => !v)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hunterActive ? "bg-purple-600" : "bg-slate-300"}`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${hunterActive ? "translate-x-6" : "translate-x-1"}`} />
                  </button>
                  <span className="text-sm font-medium text-slate-700">
                    {hunterActive ? "Surveillance active — recherche en cours" : "Surveillance en pause"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-3">
                  <Button
                    onClick={handleSaveHunter}
                    disabled={hunterSaving}
                    className="gap-2 bg-purple-600 hover:bg-purple-700 text-white"
                  >
                    {hunterSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : (hunterActive ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />)}
                    {hunterSaving ? "Sauvegarde..." : "Sauvegarder la configuration"}
                  </Button>
                  {hc && (
                    <Button
                      variant="outline"
                      onClick={handleResetHunter}
                      disabled={hunterSaving}
                      className="gap-2 border-red-200 text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-4 h-4" />
                      Effacer les identifiants
                    </Button>
                  )}
                </div>

                {hc && (
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Dernier passage</p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <p className="text-xs text-muted-foreground">Horodatage</p>
                        <p className="text-sm font-medium text-slate-800">
                          {hc.lastCheckAt ? formatDate(hc.lastCheckAt) : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Résultat</p>
                        <p className="text-sm font-medium text-slate-800">
                          {hc.lastResult ? (lastResultLabel[hc.lastResult] ?? hc.lastResult) : "—"}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Tentatives totales</p>
                        <p className="text-sm font-bold text-purple-700">{hc.checkCount ?? 0}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })()}

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
                {docs.filter((d: Doc<"documents">) => !d.isAdminUpload).length}/{getUploadDocs(app.destination, app.visaType).length} fourni(s)
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
                  {getUploadDocs(app.destination, app.visaType).map((doc) => (
                    <DocUploadRow
                      key={doc.key}
                      appId={appId!}
                      docKey={doc.key}
                      label={doc.label}
                      required={servicePackage === "slot_only" ? false : doc.required}
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
                  {docs.filter((d: Doc<"documents"> & { url?: string | null }) => d.isAdminUpload).map((doc: Doc<"documents"> & { url?: string | null }) => (
                    <DocUploadRow
                      key={`admin-${doc._id}`}
                      appId={appId!}
                      docKey={doc.docKey}
                      label={doc.label}
                      required={false}
                      existingDoc={{ 
                        _id: doc._id, 
                        url: doc.url ?? null, 
                        verifiedByAdmin: doc.verifiedByAdmin, 
                        isAdminUpload: doc.isAdminUpload 
                      }}
                      isAdminContext={true}
                    />
                  ))}
                  {docs.filter((d: Doc<"documents">) => d.isAdminUpload).length === 0 && (
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

        {/* ===== BOT LOG TIMELINE ===== */}
        {botLogs.length > 0 && (() => {
          const stepLabels: Record<string, string> = {
            login: "Connexion au portail",
            ofc_list: "Bureaux consulaires",
            scan: "Scan en cours",
            slots_found: "Créneau détecté",
            booking_attempt: "Tentative de réservation",
            booking_success: "Réservation confirmée",
            booking_fail: "Réservation échouée",
            confirmation_letter: "Lettre de confirmation",
            not_found: "Aucun créneau disponible",
            rate_limit: "Rate limit (429)",
            blocked: "Compte potentiellement bloqué",
            restricted: "Compte restreint",
            error: "Erreur",
            session_end: "Fin de session",
            session_start: "Début de session",
            human_behavior: "Comportement humain",
            appointment_status: "Statut demande",
            anti_detection: "Anti-détection",
          };
          const stepIcons: Record<string, string> = {
            login: "🔑", ofc_list: "🏛️", scan: "🔄",
            slots_found: "📅", booking_attempt: "📝", booking_success: "✅",
            booking_fail: "❌", confirmation_letter: "📄", not_found: "🔍",
            rate_limit: "⛔", blocked: "🚫", restricted: "🔒", error: "⚠️",
            session_end: "🏁", session_start: "🚀", human_behavior: "🤖",
            appointment_status: "📋", anti_detection: "🛡️",
          };
          const dotColors: Record<string, string> = { ok: "bg-green-500", warn: "bg-amber-400", fail: "bg-red-500" };
          const badgeColors: Record<string, string> = {
            ok: "bg-green-50 text-green-700 border-green-200",
            warn: "bg-amber-50 text-amber-700 border-amber-200",
            fail: "bg-red-50 text-red-700 border-red-200",
          };
          const badgeLabels: Record<string, string> = { ok: "OK", warn: "Attention", fail: "Erreur" };

          const allSteps: string[] = Array.from(new Set<string>(botLogs.map((l: Doc<"botLogs">) => l.step))).sort();

          const filtered = botLogs.filter((log: Doc<"botLogs">) => {
            const matchStep = logStepFilter === "" || log.step.toLowerCase().includes(logStepFilter.toLowerCase());
            const matchStatus = logStatusFilter === "" || log.status === logStatusFilter;
            return matchStep && matchStatus;
          });

          const totalPages = Math.ceil(filtered.length / LOG_PAGE_SIZE);
          const safePage = Math.min(logPage, Math.max(0, totalPages - 1));
          const pageSlice = filtered.slice(safePage * LOG_PAGE_SIZE, (safePage + 1) * LOG_PAGE_SIZE);

          const toggleExpand = (id: string) => {
            setLogExpanded(prev => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            });
          };

          const copyData = (id: string, text: string) => {
            void navigator.clipboard.writeText(text);
            setLogCopied(id);
            setTimeout(() => setLogCopied(prev => prev === id ? null : prev), 1500);
          };

          return (
            <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
              {/* Header */}
              <div className="flex items-center gap-2 mb-4 flex-wrap">
                <Bot className="w-4 h-4 text-purple-600" />
                <h2 className="font-bold text-primary text-base">Journal du Bot</h2>
                <span className="text-xs text-muted-foreground">
                  {filtered.length}/{botLogs.length} événement{botLogs.length > 1 ? "s" : ""}
                </span>
                {(logStepFilter || logStatusFilter) && (
                  <button
                    onClick={() => { setLogStepFilter(""); setLogStatusFilter(""); setLogPage(0); }}
                    className="ml-auto text-xs text-purple-600 hover:text-purple-800 underline underline-offset-2"
                  >
                    Effacer filtres
                  </button>
                )}
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      disabled={logClearing}
                      className={`${logStepFilter || logStatusFilter ? "" : "ml-auto "}px-2.5 py-1 text-xs rounded-lg border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 font-medium transition-colors disabled:opacity-50`}
                    >
                      {logClearing ? "Suppression…" : "Vider"}
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Supprimer tous les logs</AlertDialogTitle>
                      <AlertDialogDescription>
                        Êtes-vous sûr de vouloir supprimer tous les logs de ce dossier ? Cette action est irréversible.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={async () => {
                          if (!appId) return;
                          setLogClearing(true);
                          try {
                            await clearLogsByApp({ applicationId: appId });
                          } catch (err) {
                            console.error("[admin] Erreur suppression logs:", err);
                          } finally {
                            setLogClearing(false);
                          }
                        }}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        Supprimer
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-2 mb-4">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    placeholder="Filtrer par step (ex: cev_calendar, net_response…)"
                    value={logStepFilter}
                    onChange={e => { setLogStepFilter(e.target.value); setLogPage(0); }}
                    list="bot-steps-list"
                    className="w-full pl-8 pr-3 py-1.5 text-xs border border-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-purple-300"
                  />
                  <datalist id="bot-steps-list">
                    {allSteps.map(s => <option key={s} value={s} />)}
                  </datalist>
                </div>
                <div className="flex gap-1">
                  {(["", "ok", "warn", "fail"] as const).map(s => (
                    <button
                      key={s}
                      onClick={() => { setLogStatusFilter(s); setLogPage(0); }}
                      className={`px-2.5 py-1.5 text-xs rounded-lg border font-medium transition-colors ${
                        logStatusFilter === s
                          ? s === "" ? "bg-slate-700 text-white border-slate-700"
                            : s === "ok" ? "bg-green-600 text-white border-green-600"
                            : s === "warn" ? "bg-amber-500 text-white border-amber-500"
                            : "bg-red-600 text-white border-red-600"
                          : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"
                      }`}
                    >
                      {s === "" ? "Tous" : s === "ok" ? "✓ OK" : s === "warn" ? "⚠ Warn" : "✕ Fail"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Timeline */}
              {pageSlice.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-6">Aucun événement correspondant aux filtres</p>
              ) : (
                <div className="relative border-l-2 border-slate-100 ml-3 space-y-4 pb-2">
                  {pageSlice.map((log: Doc<"botLogs">) => {
                    let parsedData: Record<string, unknown> | null = null;
                    try {
                      if (log.data) parsedData = JSON.parse(log.data) as Record<string, unknown>;
                    } catch { /* ignore */ }

                    const isExpanded = logExpanded.has(log._id);
                    const rawStr = log.data ?? "";
                    const isBig = rawStr.length > 300;

                    return (
                      <div key={log._id} className="relative pl-6">
                        <div className={`absolute -left-[7px] top-1.5 w-3 h-3 rounded-full ${dotColors[log.status] ?? "bg-slate-400"} border-2 border-white`} />

                        <div className="flex items-start gap-2 flex-wrap">
                          <span className="text-sm font-medium text-slate-800">
                            {stepIcons[log.step] ?? "•"} {stepLabels[log.step] ?? log.step}
                          </span>
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${badgeColors[log.status] ?? ""}`}>
                            {badgeLabels[log.status] ?? log.status}
                          </span>
                          {isBig && (
                            <button
                              onClick={() => toggleExpand(log._id)}
                              className="text-[10px] text-purple-600 hover:text-purple-800 underline underline-offset-2 ml-1"
                            >
                              {isExpanded ? "Réduire" : `Voir tout (${rawStr.length} cars)`}
                            </button>
                          )}
                          {log.data && (
                            <button
                              onClick={() => copyData(log._id, rawStr)}
                              className="ml-auto text-[10px] text-slate-400 hover:text-slate-700 flex items-center gap-1"
                              title="Copier les données brutes"
                            >
                              {logCopied === log._id ? <><Check className="w-3 h-3 text-green-500" /> Copié</> : <><Copy className="w-3 h-3" /> Copier</>}
                            </button>
                          )}
                        </div>

                        {/* Countdown to next session — affiché uniquement pour le PREMIER session_end (le plus récent) */}
                        {log.step === "session_end" && log._id === (pageSlice.find((l: Doc<"botLogs">) => l.step === "session_end")?._id) && (
                          <NextSessionCountdown
                            endedAt={parsedData?.endedAt as string | undefined ?? new Date(log.ts).toISOString()}
                            urgencyTier={(app as unknown as { slotUrgencyTier?: string })?.slotUrgencyTier ?? "standard"}
                            isActive={(app as unknown as { hunterConfig?: { isActive?: boolean } })?.hunterConfig?.isActive ?? false}
                          />
                        )}

                        {parsedData && (
                          <div className="mt-1.5 text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2 space-y-0.5 border border-slate-100">
                            {Object.entries(parsedData).map(([k, val]) => {
                              const strVal = Array.isArray(val)
                                ? (val as unknown[]).join(", ")
                                : typeof val === "object" && val !== null
                                ? JSON.stringify(val)
                                : String(val);
                              const isLong = strVal.length > 200;
                              const display = isLong && !isExpanded ? strVal.slice(0, 200) + "…" : strVal;
                              return (
                                <div key={k} className="flex gap-1.5 flex-wrap">
                                  <span className="text-slate-400 font-medium shrink-0">{k}:</span>
                                  <span className="text-slate-700 break-all font-mono text-[10px] leading-relaxed">{display}</span>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {!parsedData && log.data && (
                          <div className="mt-1.5 text-[10px] font-mono text-slate-600 bg-slate-50 rounded-lg px-3 py-2 border border-slate-100 break-all leading-relaxed">
                            {isBig && !isExpanded ? log.data.slice(0, 300) + "…" : log.data}
                          </div>
                        )}

                        <p className="text-xs text-muted-foreground mt-1">{formatDate(log.ts)}</p>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100">
                  <button
                    onClick={() => setLogPage(p => Math.max(0, p - 1))}
                    disabled={safePage === 0}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Précédent
                  </button>
                  <span className="text-xs text-muted-foreground">
                    Page {safePage + 1} / {totalPages}
                    <span className="ml-2 text-slate-400">({safePage * LOG_PAGE_SIZE + 1}–{Math.min((safePage + 1) * LOG_PAGE_SIZE, filtered.length)} sur {filtered.length})</span>
                  </span>
                  <button
                    onClick={() => setLogPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={safePage >= totalPages - 1}
                    className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:border-slate-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Suivant →
                  </button>
                </div>
              )}
            </div>
          );
        })()}
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
          {messages.map((msg: Doc<"messages">) => {
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
