import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly, formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Send, Calendar, Plane, CreditCard, ShieldCheck,
  CheckCircle2, Clock, AlertCircle, Star, Download, ArrowRight,
  FileText, Search
} from "lucide-react";

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

  const h = Math.floor(remaining / 3600000);
  const m = Math.floor((remaining % 3600000) / 60000);
  const s = Math.floor((remaining % 60000) / 1000);
  const expired = remaining === 0;

  if (expired) return <span className="text-red-600 font-bold">Créneau expiré</span>;

  return (
    <span className="font-mono font-bold text-primary">
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}
    </span>
  );
}

function InterviewKit({ app }: { app: any }) {
  const handlePrint = () => window.print();
  const dest = app.destination?.toUpperCase();
  const pricing = app.priceDetails;

  return (
    <div className="bg-white rounded-2xl border border-border shadow-sm p-6 sm:p-8 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-bold text-primary flex items-center gap-2">
          <Download className="w-5 h-5 text-secondary" /> Kit d'Entretien
        </h2>
        <Button onClick={handlePrint} variant="outline" size="sm" className="print:hidden">
          <Download className="w-4 h-4 mr-2" /> Télécharger PDF
        </Button>
      </div>

      <div id="interview-kit" className="border border-slate-200 rounded-xl p-6 text-sm space-y-4 print:border-0">
        <div className="text-center border-b border-slate-200 pb-4 mb-4">
          <h3 className="text-2xl font-bold text-primary">JOVENTY — Kit d'Entretien Consulaire</h3>
          <p className="text-muted-foreground text-xs mt-1">Document confidentiel — Ref : JOV-{app._id?.slice(-5).toUpperCase()}</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Demandeur</p>
            <p className="font-bold">{app.applicantName}</p>
            <p className="text-xs text-slate-500">Passeport : {app.passportNumber || "—"}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Destination</p>
            <p className="font-bold">{dest}</p>
            <p className="text-xs text-slate-500">{app.visaType}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Rendez-vous</p>
            <p className="font-bold">{app.appointmentDetails?.date ? formatDateOnly(app.appointmentDetails.date) : formatDateOnly(app.appointmentDate) || "À confirmer"}</p>
            <p className="text-xs text-slate-500">{app.appointmentDetails?.time ?? ""}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground uppercase font-semibold mb-1">Lieu</p>
            <p className="font-bold text-xs">{app.appointmentDetails?.location ?? "Ambassade / Consulat"}</p>
          </div>
        </div>
        {app.appointmentDetails?.notes && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900">
            <strong>Notes importantes :</strong> {app.appointmentDetails.notes}
          </div>
        )}
        <div className="border-t border-slate-200 pt-4 text-xs text-slate-500 text-center">
          Généré par Joventy · joventy.cd · Assistance visa premium pour la RDC
        </div>
      </div>
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
  const hasProofPending = !!app.paymentProofUrl && !app.priceDetails?.isEngagementPaid;
  const hasSuccessProofPending = !!app.successFeeProofUrl && !app.priceDetails?.isSuccessFeePaid;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
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
                const isPast = stepIndex > i;
                const isCurrent = stepIndex === i && !isCompleted;
                const isActive = isCompleted || isPast;

                return (
                  <div key={step.key} className="flex flex-col items-center gap-2 max-w-[80px] sm:max-w-[120px]">
                    <div
                      className={`w-10 h-10 rounded-full border-2 flex items-center justify-center transition-all z-10 bg-white ${
                        isCompleted && i === STEPS.length - 1
                          ? "border-green-500 bg-green-50"
                          : isCurrent
                          ? "border-secondary bg-orange-50"
                          : isActive
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
                            : isActive
                            ? "text-white"
                            : "text-slate-300"
                        }`}
                      />
                    </div>
                    <p
                      className={`text-[10px] sm:text-xs text-center font-medium leading-tight ${
                        isCurrent ? "text-secondary" : isActive ? "text-primary" : "text-slate-400"
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
          <AlertCircle className="w-6 h-6 text-red-500 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-bold text-red-700 mb-1">Dossier rejeté</h3>
            <p className="text-sm text-red-600">
              Votre dossier n'a pas pu être traité. Contactez notre équipe via le chat pour en savoir plus.
            </p>
          </div>
        </div>
      )}

      {/* Action CTA banners */}
      {isAwaitingEngagement && !hasProofPending && (
        <div className="bg-orange-50 border-2 border-secondary rounded-2xl p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-secondary/20 flex items-center justify-center flex-shrink-0">
              <CreditCard className="w-6 h-6 text-secondary" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-primary mb-1">Activez votre dossier</h3>
              <p className="text-sm text-slate-600">
                Réglez les frais d'engagement de{" "}
                <strong className="text-primary">{formatCurrency(app.priceDetails?.engagementFee)}</strong> pour démarrer
                le traitement.
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

      {hasProofPending && !app.priceDetails?.isEngagementPaid && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800">
            <strong>Reçu reçu !</strong> Notre équipe est en train de valider votre paiement d'engagement. Sous 24h.
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
                Joventy a capturé un rendez-vous consulaire pour vous. Réglez la prime de succès de{" "}
                <strong className="text-primary">{formatCurrency(app.priceDetails?.successFee)}</strong> pour le confirmer.
              </p>
              {app.slotExpiresAt && (
                <p className="text-xs text-red-600 font-medium flex items-center gap-1">
                  <Clock className="w-3 h-3" /> Ce créneau expire dans :{" "}
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
            <strong>Reçu de prime de succès reçu !</strong> Notre équipe valide votre paiement et confirmera le rendez-vous.
          </p>
        </div>
      )}

      {/* Interview kit for completed */}
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
                <p className="text-sm text-slate-600">Passeport: {app.passportNumber || "Non renseigné"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Dates prévues</p>
                <p className="font-semibold text-primary">{formatDateOnly(app.travelDate)}</p>
                <p className="text-sm text-slate-600">Retour: {app.returnDate ? formatDateOnly(app.returnDate) : "Non prévu"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Facturation</p>
                <div className="space-y-1">
                  <p className="text-sm">
                    Engagement :{" "}
                    <span className={app.priceDetails?.isEngagementPaid ? "text-green-700 font-semibold" : "text-slate-600"}>
                      {formatCurrency(app.priceDetails?.engagementFee)}{" "}
                      {app.priceDetails?.isEngagementPaid ? "✓ Payé" : ""}
                    </span>
                  </p>
                  <p className="text-sm">
                    Prime de succès :{" "}
                    <span className={app.priceDetails?.isSuccessFeePaid ? "text-green-700 font-semibold" : "text-slate-600"}>
                      {formatCurrency(app.priceDetails?.successFee)}{" "}
                      {app.priceDetails?.isSuccessFeePaid ? "✓ Payée" : ""}
                    </span>
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Rendez-vous Consulaire</p>
                <p className="font-semibold text-primary flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-secondary" />
                  {app.appointmentDetails?.date
                    ? formatDateOnly(app.appointmentDetails.date)
                    : app.appointmentDate
                    ? formatDate(app.appointmentDate)
                    : "Pas encore programmé"}
                </p>
                {app.appointmentDetails?.location && (
                  <p className="text-xs text-slate-500 mt-0.5">{app.appointmentDetails.location}</p>
                )}
              </div>
            </div>
          </div>

          {/* Activity log */}
          {app.logs && app.logs.length > 0 && (
            <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
              <h2 className="text-lg font-bold text-primary mb-4">Journal d'activité</h2>
              <div className="relative border-l-2 border-slate-100 ml-3 space-y-6 pb-2">
                {[...app.logs].reverse().map((log: any, idx: number) => (
                  <div key={idx} className="relative pl-6">
                    <div className="absolute -left-[7px] top-1 w-3 h-3 rounded-full bg-primary border-2 border-white" />
                    <p className="text-sm text-slate-700">{log.msg}</p>
                    <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {formatDate(log.time)} · {log.author}
                    </p>
                  </div>
                ))}
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
