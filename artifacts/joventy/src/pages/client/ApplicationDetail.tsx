import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING } from "@convex/constants";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly, formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  Send, Calendar, Plane, CreditCard, ShieldCheck,
  CheckCircle2, Clock, Star, Download, ArrowRight,
  FileText, Search, Lock, XCircle, Upload, Loader2, Eye
} from "lucide-react";

type Application = Doc<"applications">;
type LogEntry = NonNullable<Application["logs"]>[number];

const STEPS = [
  { key: "awaiting_engagement_payment", label: "Paiement d'engagement", icon: CreditCard },
  { key: "documents_pending", label: "Documents requis", icon: FileText },
  { key: "in_review_slot_hunting", label: "Traitement & Recherche créneau", icon: Search },
  { key: "slot_found_awaiting_success_fee", label: "Créneau trouvé !", icon: Star },
  { key: "completed", label: "Dossier complété", icon: CheckCircle2 },
];

function getStepIndex(status: string): number {
  if (status === "awaiting_engagement_payment") return 0;
  if (status === "documents_pending") return 1;
  if (status === "in_review" || status === "slot_hunting") return 2;
  if (status === "slot_found_awaiting_success_fee") return 3;
  if (status === "completed") return 4;
  return -1;
}

function Countdown({ targetTs }: { targetTs: number }) {
  const [remaining, setRemaining] = useState(Math.max(0, targetTs - Date.now()));

  useEffect(() => {
    const id = setInterval(() => setRemaining(Math.max(0, targetTs - Date.now())), 1000);
    return () => clearInterval(id);
  }, [targetTs]);

  if (remaining === 0) return <span className="text-red-600 font-bold">Créneau expiré</span>;

  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}j`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${String(minutes).padStart(2, "0")}min`);

  return <span className="font-mono font-bold text-red-700">{parts.join(" ")}</span>;
}

function InterviewKit({ app }: { app: Application }) {
  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
  const details = app.appointmentDetails;

  return (
    <div className="bg-white rounded-2xl border-2 border-green-300 shadow-sm p-6 sm:p-8 space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h2 className="text-xl font-bold text-primary flex items-center gap-2">
          <Download className="w-5 h-5 text-secondary" /> Kit d'Entretien Consulaire
        </h2>
        <Button onClick={() => window.print()} variant="outline" size="sm" className="print:hidden gap-2">
          <Download className="w-4 h-4" /> Télécharger PDF
        </Button>
      </div>

      <div id="interview-kit" className="border border-slate-200 rounded-xl p-6 text-sm space-y-5 print:border-0">
        <div className="text-center border-b border-slate-200 pb-4">
          <h3 className="text-xl font-bold text-primary">JOVENTY — Kit d'Entretien Consulaire</h3>
          <p className="text-muted-foreground text-xs mt-1">Document confidentiel · Ref : JOV-{app._id.slice(-5).toUpperCase()}</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Demandeur</p>
            <p className="font-bold">{app.applicantName}</p>
            <p className="text-xs text-slate-500">Passeport : {app.passportNumber || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Destination</p>
            <p className="font-bold">{app.destination.toUpperCase()}</p>
            <p className="text-xs text-slate-500">{app.visaType}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Date du rendez-vous</p>
            <p className="font-bold">{details?.date ? formatDateOnly(details.date) : "—"}</p>
            <p className="text-xs text-slate-500">{details?.time ?? ""}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Lieu</p>
            <p className="font-bold text-xs">{details?.location ?? (pricing?.embassyAddress ?? "À confirmer")}</p>
            {details?.confirmationCode && (
              <p className="text-xs font-mono text-primary mt-0.5">Code : {details.confirmationCode}</p>
            )}
          </div>
        </div>

        {/* Required documents */}
        {pricing && (
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-2">Documents à apporter</p>
            <ul className="space-y-1">
              {pricing.requiredDocuments.map((doc) => (
                <li key={doc.key} className="flex items-center gap-2 text-xs">
                  <CheckCircle2 className={`w-3.5 h-3.5 flex-shrink-0 ${doc.required ? "text-green-600" : "text-slate-400"}`} />
                  <span>{doc.label}{!doc.required && " (optionnel)"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {details?.notes && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            <strong>Notes importantes :</strong> {details.notes}
          </div>
        )}

        {pricing?.notes && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900">
            <strong>Informations consulaires :</strong> {pricing.notes}
          </div>
        )}

        <div className="border-t border-slate-200 pt-4 text-xs text-slate-400 text-center">
          Généré par Joventy · joventy.cd · Assistance visa premium pour la RDC
        </div>
      </div>
    </div>
  );
}

function RequiredDocsList({ destination }: { destination: string }) {
  const pricing = VISA_PRICING[destination as keyof typeof VISA_PRICING];
  if (!pricing) return null;

  return (
    <div className="bg-white p-6 rounded-2xl border border-border shadow-sm">
      <h2 className="text-lg font-bold text-primary mb-3 flex items-center gap-2">
        <FileText className="w-4 h-4 text-secondary" /> Documents requis pour {pricing.label}
      </h2>
      <ul className="space-y-2">
        {pricing.requiredDocuments.map((doc) => (
          <li key={doc.key} className="flex items-start gap-2 text-sm">
            <CheckCircle2 className={`w-4 h-4 mt-0.5 flex-shrink-0 ${doc.required ? "text-primary" : "text-slate-400"}`} />
            <span className={doc.required ? "text-slate-700" : "text-slate-500"}>
              {doc.label}
              {!doc.required && <span className="text-xs text-slate-400 ml-1">(optionnel)</span>}
            </span>
          </li>
        ))}
      </ul>
      {pricing.notes && (
        <p className="mt-3 text-xs text-muted-foreground bg-slate-50 p-2 rounded-lg border border-border">{pricing.notes}</p>
      )}
    </div>
  );
}

function ClientDocRow({
  appId,
  docKey,
  label,
  required,
  existingDoc,
}: {
  appId: Id<"applications">;
  docKey: string;
  label: string;
  required: boolean;
  existingDoc?: { _id: Id<"documents">; url: string | null; verifiedByAdmin: boolean };
}) {
  const { toast } = useToast();
  const generateUrl = useMutation(api.documents.generateUploadUrl);
  const addDocument = useMutation(api.documents.uploadDocument);
  const [uploading, setUploading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const isVerified = existingDoc?.verifiedByAdmin ?? false;
  const hasDoc = !!existingDoc;

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
      await addDocument({ applicationId: appId, docKey, label, storageId });
      toast({ title: "Document envoyé", description: `${label} a été uploadé avec succès.` });
    } catch {
      toast({ variant: "destructive", title: "Erreur upload", description: "Veuillez réessayer." });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="flex items-center gap-3 py-3 border-b border-slate-100 last:border-0">
      <div className="flex-shrink-0">
        {hasDoc ? (
          isVerified ? (
            <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-green-600" />
            </div>
          ) : (
            <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center">
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
          )
        ) : (
          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
            <Upload className="w-4 h-4 text-slate-400" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-700 truncate">
          {label}
          {!required && <span className="text-[10px] text-slate-400 ml-1.5 font-normal">(optionnel)</span>}
        </p>
        <p className={`text-xs ${isVerified ? "text-green-700 font-medium" : hasDoc ? "text-amber-600" : "text-slate-400"}`}>
          {isVerified ? "✓ Vérifié par Joventy" : hasDoc ? "En attente de vérification..." : "Non fourni"}
        </p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {hasDoc && existingDoc?.url && (
          <button
            onClick={() => setPreviewOpen(true)}
            className="text-[11px] text-primary underline flex items-center gap-1"
          >
            <Eye className="w-3 h-3" /> Voir
          </button>
        )}
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
          variant={hasDoc ? "outline" : "default"}
          disabled={uploading}
          className={`h-8 text-xs gap-1 ${!hasDoc ? "bg-primary text-white hover:bg-primary/90" : ""}`}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
          {hasDoc ? "Remplacer" : "Uploader"}
        </Button>
      </div>
      {previewOpen && existingDoc?.url && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="relative max-w-2xl w-full bg-white rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b flex justify-between items-center">
              <span className="text-sm font-semibold">{label}</span>
              <button onClick={() => setPreviewOpen(false)} className="text-muted-foreground text-lg leading-none">✕</button>
            </div>
            <img src={existingDoc.url} alt={label} className="w-full max-h-[70vh] object-contain" />
            <div className="p-3 border-t flex justify-end">
              <a href={existingDoc.url} target="_blank" rel="noreferrer" className="text-xs text-primary underline">
                Ouvrir dans un nouvel onglet
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ClientApplicationDetail() {
  const [, params] = useRoute("/dashboard/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;
  const [, setLocation] = useLocation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [msgText, setMsgText] = useState("");
  const [isSending, setIsSending] = useState(false);

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const sendMessage = useMutation(api.messages.send);
  const markAsRead = useMutation(api.messages.markAsRead);

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

  if (app === undefined) return <div className="p-12 text-center text-muted-foreground">Chargement des détails...</div>;
  if (!app) return <div className="p-12 text-center text-red-500">Dossier introuvable</div>;

  const stepIndex = getStepIndex(app.status);
  const isRejected = app.status === "rejected";
  const isCompleted = app.status === "completed";
  const isSlotFound = app.status === "slot_found_awaiting_success_fee";
  const isAwaitingEngagement = app.status === "awaiting_engagement_payment";
  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];

  const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
  const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;

  const hasEngagementProofPending = !!app.paymentProofUrl && !isEngagementPaid;
  const hasSuccessProofPending = !!app.successFeeProofUrl && !isSuccessFeePaid;

  // Appointment details are only shown AFTER success fee is paid (completed state)
  const showAppointmentDetails = isCompleted && isSuccessFeePaid;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-serif font-bold text-primary flex items-center gap-3">
            <Plane className="w-6 h-6 text-secondary" />
            {app.destination.toUpperCase()} — {app.visaType}
          </h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Ref : JOV-{app._id.slice(-5).toUpperCase()} · Demandeur : {app.applicantName}
          </p>
        </div>
        <StatusBadge status={app.status} />
      </div>

      {/* Progress bar */}
      {!isRejected && (
        <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-4">Avancement du dossier</h2>
          <div className="relative">
            <div className="absolute top-5 left-0 right-0 h-0.5 bg-slate-100" />
            <div
              className="absolute top-5 left-0 h-0.5 bg-secondary transition-all duration-700"
              style={{ width: `${isCompleted ? 100 : Math.max(0, (stepIndex / (STEPS.length - 1)) * 100)}%` }}
            />
            <div className="relative flex justify-between">
              {STEPS.map((step, i) => {
                const Icon = step.icon;
                const isPast = isCompleted || stepIndex > i;
                const isCurrent = !isCompleted && stepIndex === i;

                return (
                  <div key={step.key} className="flex flex-col items-center gap-2 max-w-[80px] sm:max-w-[120px]">
                    <div
                      className={`w-10 h-10 rounded-full border-2 flex items-center justify-center transition-all z-10 bg-white ${
                        isCompleted && i === STEPS.length - 1
                          ? "border-green-500 bg-green-50"
                          : isCurrent
                          ? "border-secondary bg-orange-50"
                          : isPast
                          ? "border-primary bg-primary"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <Icon
                        className={`w-4 h-4 ${
                          isCompleted && i === STEPS.length - 1
                            ? "text-green-600"
                            : isCurrent
                            ? "text-secondary"
                            : isPast
                            ? "text-white"
                            : "text-slate-300"
                        }`}
                      />
                    </div>
                    <p
                      className={`text-[10px] sm:text-xs text-center font-medium leading-tight ${
                        isCurrent ? "text-secondary" : isPast ? "text-primary" : "text-slate-400"
                      }`}
                    >
                      {step.label}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Rejected banner */}
      {isRejected && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-6 flex items-start gap-4">
          <XCircle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-bold text-red-700 mb-1">Dossier rejeté</h3>
            {app.rejectionReason && <p className="text-sm text-red-600 mb-1">{app.rejectionReason}</p>}
            <p className="text-sm text-red-500">Contactez notre équipe via le chat pour plus d'informations.</p>
          </div>
        </div>
      )}

      {/* ---- Action CTA banners ---- */}
      {isAwaitingEngagement && !hasEngagementProofPending && (
        <div className="bg-orange-50 border-2 border-secondary rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-secondary/20 flex items-center justify-center flex-shrink-0">
              <CreditCard className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-primary mb-1">Activez votre dossier</h3>
              <p className="text-sm text-slate-600">
                Frais d'engagement :{" "}
                <strong className="text-primary">{formatCurrency(app.priceDetails?.engagementFee)}</strong>
              </p>
            </div>
          </div>
          <Button
            onClick={() => setLocation(`/dashboard/applications/${appId}/payment`)}
            className="bg-secondary text-primary hover:bg-orange-500 font-bold px-6 h-11 flex-shrink-0"
          >
            Payer maintenant <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}

      {hasEngagementProofPending && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800">
            <strong>Reçu reçu !</strong> Notre équipe valide votre paiement d'engagement. Délai : 24h ouvrables.
          </p>
        </div>
      )}

      {isSlotFound && !hasSuccessProofPending && (
        <div className="bg-green-50 border-2 border-green-400 rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="text-4xl">🎉</div>
            <div>
              <h3 className="text-xl font-bold text-green-700 mb-1">Créneau trouvé !</h3>
              <p className="text-sm text-slate-600 mb-1">
                Joventy a capturé un rendez-vous. Réglez la prime de succès de{" "}
                <strong className="text-primary">{formatCurrency(app.priceDetails?.successFee)}</strong>{" "}
                pour accéder aux détails du rendez-vous.
              </p>
              {app.slotExpiresAt && (
                <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Réservation expire dans :{" "}
                  <Countdown targetTs={app.slotExpiresAt} />
                </p>
              )}
            </div>
          </div>
          <Button
            onClick={() => setLocation(`/dashboard/applications/${appId}/payment`)}
            className="bg-green-600 text-white hover:bg-green-700 font-bold px-6 h-11 flex-shrink-0"
          >
            Régler la prime <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      )}

      {hasSuccessProofPending && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800">
            <strong>Reçu de prime de succès reçu !</strong> Validation en cours — vos détails de RDV seront débloqués sous 24h.
          </p>
        </div>
      )}

      {/* Interview kit — only when completed */}
      {isCompleted && <InterviewKit app={app} />}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <div className="xl:col-span-3 space-y-6">
          {/* Info card */}
          <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
            <h2 className="text-lg font-bold text-primary mb-4">Détails du dossier</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Demandeur</p>
                <p className="font-semibold text-primary">{app.applicantName}</p>
                <p className="text-sm text-slate-600">Passeport : {app.passportNumber || "Non renseigné"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Dates prévues</p>
                <p className="font-semibold text-primary">{formatDateOnly(app.travelDate)}</p>
                <p className="text-sm text-slate-600">Retour : {app.returnDate ? formatDateOnly(app.returnDate) : "Non prévu"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Facturation</p>
                <div className="space-y-1">
                  <p className="text-sm flex items-center gap-1">
                    {isEngagementPaid ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Clock className="w-3.5 h-3.5 text-amber-500" />}
                    Engagement : <span className={isEngagementPaid ? "text-green-700 font-semibold" : "text-slate-600"}>
                      {formatCurrency(app.priceDetails?.engagementFee)}{isEngagementPaid ? " ✓" : ""}
                    </span>
                  </p>
                  <p className="text-sm flex items-center gap-1">
                    {isSuccessFeePaid ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Lock className="w-3.5 h-3.5 text-slate-400" />}
                    Prime de succès : <span className={isSuccessFeePaid ? "text-green-700 font-semibold" : "text-slate-500"}>
                      {formatCurrency(app.priceDetails?.successFee)}{isSuccessFeePaid ? " ✓" : ""}
                    </span>
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Rendez-vous Consulaire</p>
                {showAppointmentDetails ? (
                  <div>
                    <p className="font-semibold text-primary flex items-center gap-2">
                      <Calendar className="w-4 h-4 text-secondary" />
                      {app.appointmentDetails?.date ? formatDateOnly(app.appointmentDetails.date) : "—"}
                    </p>
                    {app.appointmentDetails?.time && (
                      <p className="text-sm text-slate-600">{app.appointmentDetails.time}</p>
                    )}
                    {app.appointmentDetails?.location && (
                      <p className="text-xs text-slate-500 mt-0.5">{app.appointmentDetails.location}</p>
                    )}
                    {app.appointmentDetails?.confirmationCode && (
                      <p className="text-xs font-mono bg-green-50 text-green-700 border border-green-200 rounded px-2 py-0.5 mt-1 inline-block">
                        Code : {app.appointmentDetails.confirmationCode}
                      </p>
                    )}
                  </div>
                ) : isSlotFound ? (
                  <div className="flex items-center gap-2 text-slate-500">
                    <Lock className="w-4 h-4 text-amber-500" />
                    <p className="text-sm italic">Débloqué après règlement de la prime de succès</p>
                  </div>
                ) : (
                  <p className="text-sm text-slate-500 flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-slate-300" />
                    Pas encore programmé
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Documents vault */}
          {pricing && isEngagementPaid && (
            <div className="bg-white p-6 rounded-2xl border border-border shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-primary flex items-center gap-2">
                  <FileText className="w-4 h-4 text-secondary" /> Mes Documents
                </h2>
                <span className="text-xs text-muted-foreground">
                  {docs.filter((d) => !d.isAdminUpload).length}/{pricing.requiredDocuments.length} fourni(s)
                </span>
              </div>
              <div>
                {pricing.requiredDocuments.map((doc) => {
                  const uploaded = docs.find((d) => d.docKey === doc.key && !d.isAdminUpload);
                  return (
                    <ClientDocRow
                      key={doc.key}
                      appId={appId!}
                      docKey={doc.key}
                      label={doc.label}
                      required={doc.required}
                      existingDoc={uploaded}
                    />
                  );
                })}
              </div>
              {pricing.notes && (
                <p className="mt-4 text-xs text-muted-foreground bg-slate-50 p-3 rounded-lg border border-border">
                  {pricing.notes}
                </p>
              )}
            </div>
          )}

          {/* Required documents checklist (when not yet paying or no pricing) */}
          {(!isEngagementPaid) && <RequiredDocsList destination={app.destination} />}

          {/* Activity log */}
          {app.logs && app.logs.length > 0 && (
            <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
              <h2 className="text-lg font-bold text-primary mb-4">Journal d'activité</h2>
              <div className="relative border-l-2 border-slate-100 ml-3 space-y-6 pb-2">
                {[...app.logs].reverse().map((log: LogEntry, idx: number) => {
                  // Redact any log that might contain appointment specifics before the paywall is cleared
                  const isSensitive =
                    !isSuccessFeePaid &&
                    (isSlotFound || isCompleted) &&
                    /rendez-vous le \d|à \d{2}:\d{2}|location|date :/i.test(log.msg);

                  const displayMsg = isSensitive
                    ? "🔒 Détails du rendez-vous masqués — réglez la prime de succès pour les débloquer."
                    : log.msg;

                  const m = displayMsg.toLowerCase();
                  let Icon = Clock;
                  let dotColor = "bg-primary";
                  if (m.includes("créé") || m.includes("nouveau")) { Icon = FileText; dotColor = "bg-blue-500"; }
                  else if (m.includes("payé") || m.includes("validé") || m.includes("paiement")) { Icon = CheckCircle2; dotColor = "bg-green-500"; }
                  else if (m.includes("créneau") || m.includes("rendez-vous")) { Icon = Star; dotColor = "bg-secondary"; }
                  else if (m.includes("refusé") || m.includes("rejeté")) { Icon = XCircle; dotColor = "bg-red-500"; }
                  else if (m.includes("reçu") || m.includes("uploadé")) { Icon = Upload; dotColor = "bg-violet-500"; }
                  else if (m.includes("traitement") || m.includes("analyse") || m.includes("revision")) { Icon = Search; dotColor = "bg-indigo-500"; }

                  return (
                    <div key={idx} className="relative pl-6">
                      <div className={`absolute -left-[7px] top-1 w-3.5 h-3.5 rounded-full ${dotColor} border-2 border-white flex items-center justify-center`}>
                        <Icon className="w-2 h-2 text-white" />
                      </div>
                      <p className={`text-sm ${isSensitive ? "text-slate-400 italic" : "text-slate-700"}`}>{displayMsg}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {formatDate(log.time)} · {log.author ?? "système"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Chat */}
        <div className="xl:col-span-2 bg-white rounded-2xl border border-border shadow-sm flex flex-col h-[500px] xl:h-[calc(100vh-200px)] xl:sticky xl:top-24">
          <div className="p-4 border-b border-border bg-slate-50 rounded-t-2xl flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-secondary" />
            <div>
              <h3 className="font-bold text-primary">Assistance Joventy</h3>
              <p className="text-xs text-muted-foreground">Conseiller dédié</p>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="text-center text-xs text-muted-foreground mb-6">Début de la conversation sécurisée</div>
            {messages.map((msg) => {
              const isMe = !msg.isFromAdmin;
              return (
                <div key={msg._id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-slate-500">{msg.senderName}</span>
                    <span className="text-[10px] text-slate-400">{formatDate(msg._creationTime)}</span>
                  </div>
                  <div
                    className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm ${
                      isMe
                        ? "bg-primary text-white rounded-br-none"
                        : "bg-slate-100 text-slate-800 rounded-bl-none border border-slate-200"
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              );
            })}
          </div>

          <form onSubmit={handleSend} className="p-4 border-t border-border bg-white rounded-b-2xl">
            <div className="relative">
              <Input
                value={msgText}
                onChange={(e) => setMsgText(e.target.value)}
                placeholder="Écrivez votre message..."
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
      </div>
    </div>
  );
}
