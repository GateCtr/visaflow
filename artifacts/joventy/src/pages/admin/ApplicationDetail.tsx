import { useState, useRef, useEffect } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { StatusBadge, statusOptions } from "@/components/StatusBadge";
import { formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, User, Calendar, CreditCard, ShieldCheck, Save } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useForm } from "react-hook-form";

type UpdateFields = {
  status: string;
  adminNotes: string;
  price: string;
  isPaid: boolean;
  appointmentDate: string;
};

export default function AdminApplicationDetail() {
  const [, params] = useRoute("/admin/applications/:id");
  const appId = params?.id as Id<"applications"> | undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [msgText, setMsgText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { toast } = useToast();

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const sendMessage = useMutation(api.messages.send);
  const markAsRead = useMutation(api.messages.markAsRead);
  const updateApplication = useMutation(api.applications.update);

  useEffect(() => {
    if (appId && messages.length > 0) {
      markAsRead({ applicationId: appId });
    }
  }, [appId, messages.length]);

  const form = useForm<UpdateFields>({
    defaultValues: {
      status: "",
      adminNotes: "",
      price: "",
      isPaid: false,
      appointmentDate: "",
    },
  });

  useEffect(() => {
    if (app) {
      form.reset({
        status: app.status,
        adminNotes: app.adminNotes || "",
        price: app.price?.toString() || "",
        isPaid: app.isPaid || false,
        appointmentDate: app.appointmentDate || "",
      });
    }
  }, [app?._id]);

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

  const handleSave = async () => {
    if (!appId) return;
    setIsSaving(true);
    try {
      const values = form.getValues();
      await updateApplication({
        id: appId,
        status: values.status as any,
        adminNotes: values.adminNotes || undefined,
        price: values.price ? parseFloat(values.price) : undefined,
        isPaid: values.isPaid,
        appointmentDate: values.appointmentDate || undefined,
      });
      toast({ title: "Dossier mis à jour", description: "Les modifications ont été enregistrées." });
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible de mettre à jour le dossier." });
    } finally {
      setIsSaving(false);
    }
  };

  if (app === undefined) return <div className="p-12 text-center text-muted-foreground">Chargement...</div>;
  if (!app) return <div className="p-12 text-center text-red-500">Dossier introuvable</div>;

  return (
    <div className="h-full flex flex-col xl:flex-row gap-6">
      <div className="w-full xl:w-2/3 space-y-6">
        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
          <div className="flex items-start justify-between mb-6 gap-4">
            <div>
              <h1 className="text-2xl font-serif font-bold text-primary">
                Dossier : {app.applicantName}
              </h1>
              <p className="text-muted-foreground">
                {app.destination.toUpperCase()} — {app.visaType} | Ref: JOV-{app._id.slice(-5).toUpperCase()}
              </p>
            </div>
            <StatusBadge status={app.status} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 bg-slate-50 rounded-xl border border-slate-100 text-sm">
            <div>
              <User className="w-4 h-4 text-slate-400 inline mr-2" />
              <strong>Client :</strong>{" "}
              {app.userFirstName} {app.userLastName}
              {app.userEmail && (
                <span className="block text-xs ml-6 text-muted-foreground">{app.userEmail}</span>
              )}
            </div>
            <div>
              <strong>Passeport :</strong> {app.passportNumber || "Non renseigné"}
            </div>
            <div>
              <Calendar className="w-4 h-4 text-slate-400 inline mr-2" />
              <strong>Voyage :</strong> {app.travelDate || "Non renseigné"}
            </div>
            <div>
              <strong>Retour :</strong> {app.returnDate || "Non renseigné"}
            </div>
            <div className="sm:col-span-2">
              <strong>Motif :</strong> {app.purpose}
            </div>
            {app.notes && (
              <div className="sm:col-span-2">
                <strong>Notes client :</strong> {app.notes}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white p-6 sm:p-8 rounded-2xl border border-border shadow-sm">
          <h2 className="text-xl font-bold text-primary mb-6">Gestion du Dossier</h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-medium text-primary">Statut</label>
              <Select
                value={form.watch("status")}
                onValueChange={(v) => form.setValue("status", v)}
              >
                <SelectTrigger className="h-12">
                  <SelectValue placeholder="Choisir un statut" />
                </SelectTrigger>
                <SelectContent>
                  {statusOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-primary flex items-center gap-2">
                <CreditCard className="w-4 h-4" /> Prix (USD)
              </label>
              <Input
                {...form.register("price")}
                type="number"
                placeholder="Ex: 350"
                className="h-12 bg-slate-50"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-primary flex items-center gap-2">
                <Calendar className="w-4 h-4" /> Date de RDV consulaire
              </label>
              <Input
                {...form.register("appointmentDate")}
                type="date"
                className="h-12 bg-slate-50"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-primary">Paiement</label>
              <div className="h-12 flex items-center gap-3">
                <input
                  type="checkbox"
                  id="isPaid"
                  {...form.register("isPaid")}
                  className="h-4 w-4 rounded"
                />
                <label htmlFor="isPaid" className="text-sm cursor-pointer">
                  Paiement confirmé
                </label>
              </div>
            </div>

            <div className="sm:col-span-2 space-y-2">
              <label className="text-sm font-medium text-primary">Notes internes (admin)</label>
              <Textarea
                {...form.register("adminNotes")}
                placeholder="Ajouter des notes internes sur ce dossier..."
                rows={3}
                className="bg-slate-50"
              />
            </div>
          </div>

          <div className="mt-6 flex justify-end">
            <Button
              onClick={handleSave}
              disabled={isSaving}
              className="bg-secondary text-primary hover:bg-yellow-500 font-bold gap-2 h-12 px-8"
            >
              <Save className="w-4 h-4" />
              {isSaving ? "Enregistrement..." : "Sauvegarder les modifications"}
            </Button>
          </div>
        </div>
      </div>

      {/* Chat panel */}
      <div className="w-full xl:w-1/3 bg-white rounded-2xl border border-border shadow-sm flex flex-col h-[600px] xl:h-[calc(100vh-120px)] xl:sticky xl:top-24">
        <div className="p-4 border-b border-border bg-slate-50 rounded-t-2xl flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-secondary" />
          <div>
            <h3 className="font-bold text-primary">Messagerie Client</h3>
            <p className="text-xs text-muted-foreground">Communication sécurisée</p>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-center text-xs text-muted-foreground mb-6">Début de la conversation</div>
          {messages.map((msg) => {
            const isAdmin = msg.isFromAdmin;
            return (
              <div key={msg._id} className={`flex flex-col ${isAdmin ? "items-end" : "items-start"}`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-500">{msg.senderName}</span>
                  <span className="text-[10px] text-slate-400">{formatDate(msg._creationTime)}</span>
                </div>
                <div className={`px-4 py-2.5 rounded-2xl max-w-[85%] text-sm ${isAdmin ? "bg-primary text-white rounded-br-none" : "bg-slate-100 text-slate-800 rounded-bl-none border border-slate-200"}`}>
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
              className="absolute right-1.5 top-1.5 h-9 w-9 bg-secondary hover:bg-yellow-500 text-primary"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
