import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly, formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Send, Calendar, Plane, CreditCard, ShieldCheck } from "lucide-react";

export default function ClientApplicationDetail() {
  const [, params] = useRoute("/dashboard/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;
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

  const timelineSteps = [
    { key: "draft", label: "Création" },
    { key: "submitted", label: "Soumis pour analyse" },
    { key: "in_review", label: "Traitement en cours" },
    { key: "appointment_scheduled", label: "Rendez-vous" },
    { key: "approved", label: "Approbation / Clôture" },
  ];

  const currentStepIndex = timelineSteps.findIndex((s) => s.key === app.status);

  return (
    <div className="h-full flex flex-col xl:flex-row gap-6">
      <div className="w-full xl:w-2/3 space-y-6 flex flex-col">
        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
            <div>
              <h1 className="text-2xl font-serif font-bold text-primary flex items-center gap-3">
                <Plane className="w-6 h-6 text-secondary" />
                Dossier {app.destination.toUpperCase()} - {app.visaType}
              </h1>
              <p className="text-muted-foreground mt-1">
                Ref: JOV-{app._id.slice(-5).toUpperCase()}
              </p>
            </div>
            <StatusBadge status={app.status} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 p-4 bg-slate-50 rounded-xl border border-slate-100">
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
              <p className="font-semibold text-primary flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-slate-400" />
                {formatCurrency(app.price)}
              </p>
              <span className={`text-xs px-2 py-0.5 rounded-full mt-1 inline-block ${app.isPaid ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                {app.isPaid ? "Payé" : "En attente de paiement"}
              </span>
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Rendez-vous Consulaire</p>
              <p className="font-semibold text-primary flex items-center gap-2">
                <Calendar className="w-4 h-4 text-secondary" />
                {app.appointmentDate ? formatDate(app.appointmentDate) : "Pas encore programmé"}
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
          <h2 className="text-xl font-bold text-primary mb-6">Suivi d'avancement</h2>
          <div className="relative border-l-2 border-slate-100 ml-4 space-y-8 pb-4">
            {timelineSteps.map((step, idx) => {
              const isPast = app.status === "approved" || app.status === "rejected" || currentStepIndex >= idx;
              const isCurrent = app.status !== "approved" && app.status !== "rejected" && currentStepIndex === idx;
              const isError = app.status === "rejected" && step.key === "approved";
              return (
                <div key={step.key} className="relative pl-8">
                  <div className={`absolute -left-[9px] top-0 w-4 h-4 rounded-full border-2 bg-white ${isError ? "border-red-500 bg-red-100" : isCurrent ? "border-secondary bg-yellow-100" : isPast ? "border-primary bg-primary" : "border-slate-300"}`} />
                  <p className={`font-semibold ${isError ? "text-red-600" : isCurrent ? "text-secondary" : isPast ? "text-primary" : "text-slate-400"}`}>
                    {isError ? "Dossier refusé" : step.label}
                  </p>
                  {isCurrent && <p className="text-sm text-muted-foreground mt-1">Étape actuelle du traitement</p>}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Chat */}
      <div className="w-full xl:w-1/3 bg-white rounded-2xl border border-border shadow-sm flex flex-col h-[600px] xl:h-[calc(100vh-120px)] xl:sticky xl:top-24">
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
                <div className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm ${isMe ? "bg-primary text-white rounded-br-none" : "bg-slate-100 text-slate-800 rounded-bl-none border border-slate-200"}`}>
                  {msg.content}
                </div>
              </div>
            );
          })}
        </div>

        <form onSubmit={handleSend} className="p-4 border-t border-border bg-white rounded-b-2xl">
          <div className="relative">
            <Input value={msgText} onChange={(e) => setMsgText(e.target.value)} placeholder="Écrivez votre message..." className="pr-12 h-12 rounded-xl bg-slate-50" />
            <Button type="submit" size="icon" disabled={isSending || !msgText.trim()} className="absolute right-1.5 top-1.5 h-9 w-9 bg-secondary hover:bg-yellow-500 text-primary">
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
