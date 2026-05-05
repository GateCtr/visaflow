import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Doc } from "@convex/_generated/dataModel";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING, SERVICE_PACKAGES } from "@convex/constants";
import { getUploadDocs } from "@convex/visaDocuments";
import { DocumentChecklist } from "@/components/DocumentChecklist";
import { StatusBadge } from "@/components/StatusBadge";
import { formatDate, formatDateOnly, formatCurrency } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ReviewModal } from "@/components/ReviewModal";
import {
  Send, Calendar, Plane, CreditCard, ShieldCheck,
  CheckCircle2, Clock, Star, Download, ArrowRight,
  FileText, Search, Lock, XCircle, Upload, Loader2, Eye,
  Sparkles, ClipboardCheck, Stamp, MessageSquareHeart, ChevronDown,
  KeyRound, Mail, Phone, Trash2, AlertTriangle, ShieldOff, Info
} from "lucide-react";

type Application = Doc<"applications">;
type LogEntry = NonNullable<Application["logs"]>[number];

function SpainOtpConfigCard({ appId }: { appId: Id<"applications"> }) {
  const { toast } = useToast();
  const otpConfig = useQuery(api.spainOtp.getOtpConfig, { applicationId: appId });
  const saveConfig = useMutation(api.spainOtp.saveOtpConfig);
  const removeConfig = useMutation(api.spainOtp.removeOtpConfig);

  const [channel, setChannel] = useState<"email" | "sms" | "manual">("email");
  const [email, setEmail] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [showImapPwd, setShowImapPwd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  const isConfigured = !!otpConfig;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (channel === "email" && (!email.includes("@") || !imapPassword)) {
      toast({ variant: "destructive", title: "Champs manquants", description: "Email et mot de passe d'application requis." });
      return;
    }
    if (channel === "sms" && !phone) {
      toast({ variant: "destructive", title: "Champs manquants", description: "Numéro de téléphone requis." });
      return;
    }
    setSaving(true);
    try {
      await saveConfig({
        applicationId: appId,
        channel,
        email: channel === "email" ? email : undefined,
        imapPassword: channel === "email" ? imapPassword : undefined,
        phone: channel === "sms" ? phone : undefined,
      });
      toast({ title: "Configuration enregistrée", description: "Vous recevrez un email de confirmation." });
      setShowForm(false);
      setImapPassword("");
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible de sauvegarder. Réessayez." });
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      await removeConfig({ applicationId: appId });
      toast({ title: "Identifiants supprimés", description: "Vos données OTP ont été effacées de nos serveurs." });
      setConfirmRemove(false);
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible de supprimer. Réessayez." });
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="rounded-2xl border-2 border-red-200 bg-white shadow-sm overflow-hidden">
      <div className="bg-red-50 px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-100 flex items-center justify-center flex-shrink-0">
            <KeyRound className="w-5 h-5 text-red-600" />
          </div>
          <div>
            <h3 className="font-bold text-red-900 flex items-center gap-2">
              OTP automatique — Portail Espagne
              {isConfigured && (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200 px-2 py-0.5 rounded-full">
                  <CheckCircle2 className="w-3 h-3" /> Configuré
                </span>
              )}
            </h3>
            <p className="text-xs text-red-700 mt-0.5">
              Permet au bot de saisir automatiquement les codes de vérification du portail citaconsular.es
            </p>
          </div>
        </div>
        {!showForm && (
          <Button
            onClick={() => setShowForm(true)}
            size="sm"
            className="bg-red-600 hover:bg-red-700 text-white gap-2 flex-shrink-0"
          >
            <KeyRound className="w-3.5 h-3.5" />
            {isConfigured ? "Modifier" : "Configurer"}
          </Button>
        )}
      </div>

      <div className="px-6 py-4 space-y-4">
        {isConfigured && !showForm && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Canal</p>
                <p className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
                  {otpConfig.channel === "email" ? <><Mail className="w-3.5 h-3.5 text-blue-500" /> Email IMAP</> :
                   otpConfig.channel === "sms" ? <><Phone className="w-3.5 h-3.5 text-green-500" /> SMS</> :
                   <><Info className="w-3.5 h-3.5 text-slate-500" /> Manuel</>}
                </p>
              </div>
              {otpConfig.email && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Email configuré</p>
                  <p className="text-sm font-mono text-slate-700 truncate">{otpConfig.email}</p>
                </div>
              )}
              {otpConfig.phone && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Téléphone</p>
                  <p className="text-sm font-mono text-slate-700">{otpConfig.phone}</p>
                </div>
              )}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <p className="text-[10px] text-slate-500 uppercase font-semibold mb-1">Configuré le</p>
                <p className="text-sm text-slate-700">
                  {new Date(otpConfig.configuredAt).toLocaleDateString("fr-FR")}
                </p>
              </div>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800 leading-relaxed">
                <strong>Supprimez vos identifiants une fois le rendez-vous obtenu.</strong>{" "}
                Vos données sont uniquement utilisées pendant les sessions de réservation et ne sont jamais partagées.
                Utilisez le bouton ci-dessous pour les effacer définitivement de nos serveurs.
              </div>
            </div>

            {!confirmRemove ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-2 border-red-300 text-red-600 hover:bg-red-50 hover:border-red-400"
                onClick={() => setConfirmRemove(true)}
              >
                <Trash2 className="w-3.5 h-3.5" /> Supprimer mes identifiants
              </Button>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                <p className="text-sm text-red-700 font-medium">
                  Confirmer la suppression définitive ?
                </p>
                <Button
                  size="sm"
                  className="bg-red-600 hover:bg-red-700 text-white gap-2"
                  disabled={removing}
                  onClick={handleRemove}
                >
                  {removing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldOff className="w-3.5 h-3.5" />}
                  Oui, supprimer
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmRemove(false)}
                >
                  Annuler
                </Button>
              </div>
            )}
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">
                Canal d'interception OTP
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(["email", "sms", "manual"] as const).map((ch) => (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => setChannel(ch)}
                    className={`flex items-center gap-2.5 px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all text-left ${
                      channel === ch
                        ? "border-red-500 bg-red-50 text-red-800"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                    }`}
                  >
                    {ch === "email" && <Mail className="w-4 h-4 flex-shrink-0" />}
                    {ch === "sms" && <Phone className="w-4 h-4 flex-shrink-0" />}
                    {ch === "manual" && <Info className="w-4 h-4 flex-shrink-0" />}
                    <span>
                      {ch === "email" ? "Email IMAP" : ch === "sms" ? "SMS" : "Manuel"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {channel === "email" && "Le bot lira les codes OTP directement dans votre boîte email via IMAP — entièrement automatique."}
                {channel === "sms" && "Vous serez notifié par Joventy dès qu'un code SMS est requis pour le saisir manuellement."}
                {channel === "manual" && "Vous recevrez une alerte dans votre dashboard et par email dès qu'un code OTP est demandé."}
              </div>
            </div>

            {channel === "email" && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    Adresse email (celle enregistrée sur citaconsular.es)
                  </label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="votre.email@gmail.com"
                    className="h-10"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5 flex items-center gap-1">
                    Mot de passe d'application{" "}
                    <button
                      type="button"
                      onClick={() => setShowGuide((v) => !v)}
                      className="text-primary underline"
                    >
                      (c'est quoi ?)
                    </button>
                  </label>
                  <div className="relative">
                    <Input
                      type={showImapPwd ? "text" : "password"}
                      value={imapPassword}
                      onChange={(e) => setImapPassword(e.target.value)}
                      placeholder="••••••••••••••••"
                      className="h-10 pr-10 font-mono"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowImapPwd((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                  </div>
                  {showGuide && (
                    <div className="mt-2 bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800 leading-relaxed space-y-1">
                      <p className="font-semibold">Comment créer un mot de passe d'application :</p>
                      <p><strong>Gmail :</strong> Mon compte → Sécurité → Validation en 2 étapes → Mots de passe des applications</p>
                      <p><strong>Outlook :</strong> Compte Microsoft → Sécurité → Options de sécurité avancées → Mots de passe des applications</p>
                      <p><strong>Yahoo :</strong> Sécurité du compte → Générer le mot de passe d'application</p>
                      <p className="text-blue-600 mt-1">Ce mot de passe est différent de votre mot de passe habituel et peut être révoqué à tout moment.</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {channel === "sms" && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Numéro de téléphone (avec indicatif, ex: +243...)
                </label>
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+243 8XX XXX XXX"
                  className="h-10"
                  required
                />
              </div>
            )}

            {channel === "manual" && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs text-slate-600 leading-relaxed">
                En mode manuel, dès qu'un code OTP est requis par le portail, vous recevrez une notification
                dans votre dashboard <strong>et</strong> par email. Vous aurez alors quelques minutes pour
                saisir le code dans votre espace client. Aucun identifiant supplémentaire n'est requis.
              </div>
            )}

            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2 text-xs text-amber-800">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-amber-600" />
              <span>
                <strong>Suppression obligatoire après opération :</strong> Une fois votre créneau réservé,
                supprimez ces identifiants depuis cette carte. Vous recevrez un rappel par email.
              </span>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <Button
                type="submit"
                disabled={saving}
                className="bg-red-600 hover:bg-red-700 text-white gap-2"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                Enregistrer la configuration
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => { setShowForm(false); setImapPassword(""); }}
              >
                Annuler
              </Button>
            </div>
          </form>
        )}

        {!isConfigured && !showForm && (
          <div className="flex items-start gap-3 text-xs text-slate-500 bg-slate-50 rounded-xl p-3 border border-slate-200">
            <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-slate-400" />
            <span>
              Non configuré — le bot demandera le code OTP manuellement lors des sessions de réservation.
              Configurez cette section pour rendre le processus entièrement automatique.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function getSteps(isEvisaModel: boolean, isDossierOnly: boolean, isSlotOnly: boolean) {
  if (isDossierOnly) {
    return [
      { key: "awaiting_engagement_payment", label: "Paiement d'engagement", icon: CreditCard },
      { key: "documents_pending", label: "Documents requis", icon: FileText },
      { key: "in_review_slot_hunting", label: "Vérification & Formulaires", icon: Search },
      { key: "completed", label: "Formulaires complétés", icon: CheckCircle2 },
    ];
  }
  if (isSlotOnly) {
    return [
      { key: "awaiting_engagement_payment", label: "Paiement d'engagement", icon: CreditCard },
      { key: "in_review_slot_hunting", label: "Traitement & Recherche créneau", icon: Search },
      { key: "slot_found_awaiting_success_fee", label: "Créneau trouvé !", icon: Star },
      { key: "completed", label: "Dossier complété", icon: CheckCircle2 },
    ];
  }
  return [
    { key: "awaiting_engagement_payment", label: "Paiement d'engagement", icon: CreditCard },
    { key: "documents_pending", label: "Documents requis", icon: FileText },
    { key: "in_review_slot_hunting", label: isEvisaModel ? "Traitement & Obtention visa" : "Traitement & Recherche créneau", icon: Search },
    { key: "slot_found_awaiting_success_fee", label: isEvisaModel ? "Visa obtenu !" : "Créneau trouvé !", icon: Star },
    { key: "completed", label: "Dossier complété", icon: CheckCircle2 },
  ];
}

function getStepIndexDossierOnly(status: string): number {
  if (status === "awaiting_engagement_payment") return 0;
  if (status === "documents_pending") return 1;
  if (status === "in_review" || status === "slot_hunting") return 2;
  if (status === "completed") return 3;
  return -1;
}

function getStepIndexSlotOnly(status: string): number {
  if (status === "awaiting_engagement_payment" || status === "documents_pending") return 0;
  if (status === "in_review" || status === "slot_hunting") return 1;
  if (status === "slot_found_awaiting_success_fee") return 2;
  if (status === "completed") return 3;
  return -1;
}

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

function printKitOnly() {
  const el = document.getElementById("interview-kit");
  if (!el) return;
  const styleSheets = Array.from(document.querySelectorAll<HTMLElement>("style, link[rel='stylesheet']"))
    .map((n) => n.outerHTML)
    .join("\n");
  const base = `<base href="${window.location.origin}/">`;
  const w = window.open("", "_blank", "width=820,height=960");
  if (!w) { window.print(); return; }
  w.document.write(
    `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">${base}` +
    `<title>Kit d'Entretien Consulaire — Joventy</title>${styleSheets}</head>` +
    `<body class="bg-white p-8">${el.outerHTML}</body></html>`
  );
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 800);
}

type KitDoc = { _id: string; docKey: string; label: string; url: string | null; verifiedByAdmin: boolean; isAdminUpload?: boolean };

function InterviewKit({ app, confirmationLetterUrl, docs }: {
  app: Application;
  confirmationLetterUrl?: string | null;
  docs: KitDoc[];
}) {
  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];
  const details = app.appointmentDetails;
  const uploadDocs = getUploadDocs(app.destination, app.visaType);

  const clientDocByKey: Record<string, KitDoc> = {};
  docs.filter(d => !d.isAdminUpload).forEach(d => { clientDocByKey[d.docKey] = d; });
  const adminDocs = docs.filter(d => d.isAdminUpload);

  return (
    <div className="bg-white rounded-2xl border-2 border-green-300 shadow-sm p-6 sm:p-8 space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <h2 className="text-xl font-bold text-primary flex items-center gap-2">
          <Download className="w-5 h-5 text-secondary" /> Kit d'Entretien Consulaire
        </h2>
        <div className="flex items-center gap-2 print:hidden flex-wrap">
          {confirmationLetterUrl && (
            <a href={confirmationLetterUrl} target="_blank" rel="noopener noreferrer" download="lettre_confirmation_ambassade.pdf">
              <Button variant="default" size="sm" className="gap-2 bg-green-700 hover:bg-green-800">
                <Download className="w-4 h-4" /> Lettre de convocation
              </Button>
            </a>
          )}
          <Button onClick={printKitOnly} variant="outline" size="sm" className="gap-2">
            <Download className="w-4 h-4" /> Imprimer / PDF
          </Button>
        </div>
      </div>

      <div id="interview-kit" className="border border-slate-200 rounded-xl p-6 text-sm space-y-5 print:border-0">

        {/* Header with logo */}
        <div className="text-center border-b border-slate-200 pb-5">
          <img src="/icon.png" alt="Joventy" className="h-12 mx-auto mb-3" />
          <h3 className="text-xl font-bold text-primary">Kit d'Entretien Consulaire</h3>
          <p className="text-muted-foreground text-xs mt-1">
            Réf : JOV-{app._id.slice(-6).toUpperCase()} · Généré le {new Date().toLocaleDateString("fr-FR")}
          </p>
        </div>

        {/* Appointment info grid */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Demandeur</p>
            <p className="font-bold text-sm">{app.applicantName}</p>
            <p className="text-xs text-slate-500">N° passeport : {app.passportNumber || "—"}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Visa demandé</p>
            <p className="font-bold text-sm">{app.destination.toUpperCase()}</p>
            <p className="text-xs text-slate-500">{app.visaType}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Date du rendez-vous</p>
            <p className="font-bold text-sm">{details?.date ? formatDateOnly(details.date) : "À confirmer"}</p>
            {details?.time && <p className="text-xs text-slate-500">{details.time}</p>}
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-0.5">Lieu</p>
            <p className="font-bold text-xs leading-snug">{details?.location ?? pricing?.embassyAddress ?? "À confirmer"}</p>
            {details?.confirmationCode && (
              <p className="text-xs font-mono text-primary mt-0.5">Code : {details.confirmationCode}</p>
            )}
          </div>
        </div>

        {/* Documents du client */}
        <div>
          <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-2 border-b border-slate-100 pb-1">
            Mes documents uploadés
          </p>
          <div className="divide-y divide-slate-100">
            {uploadDocs.map((doc) => {
              const uploaded = clientDocByKey[doc.key];
              return (
                <div key={doc.key} className="flex items-center justify-between py-2 gap-3">
                  <div className="flex items-start gap-2 min-w-0">
                    {uploaded?.url
                      ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0 mt-0.5" />
                      : <XCircle className="w-3.5 h-3.5 text-slate-300 flex-shrink-0 mt-0.5" />
                    }
                    <span className={`text-xs leading-snug ${!uploaded?.url ? "text-slate-400" : ""}`}>
                      {doc.label}{!doc.required && <span className="text-slate-400"> (optionnel)</span>}
                    </span>
                  </div>
                  {uploaded?.url ? (
                    <a
                      href={uploaded.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="print:hidden shrink-0 text-[11px] text-blue-600 hover:underline flex items-center gap-1 font-medium"
                    >
                      <Download className="w-3 h-3" /> Télécharger
                    </a>
                  ) : (
                    <span className="print:hidden shrink-0 text-[11px] text-slate-400">Non fourni</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Documents officiels Joventy */}
        {(confirmationLetterUrl || adminDocs.length > 0) && (
          <div>
            <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-2 border-b border-slate-100 pb-1">
              Documents officiels &amp; Joventy
            </p>
            <div className="divide-y divide-slate-100">
              {confirmationLetterUrl && (
                <div className="flex items-center justify-between py-2 gap-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                    <span className="text-xs font-semibold">Lettre de confirmation de rendez-vous (Ambassade)</span>
                  </div>
                  <a
                    href={confirmationLetterUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    download="lettre_confirmation.pdf"
                    className="print:hidden shrink-0 text-[11px] text-blue-600 hover:underline flex items-center gap-1 font-medium"
                  >
                    <Download className="w-3 h-3" /> Télécharger
                  </a>
                </div>
              )}
              {adminDocs.map((doc) => (
                <div key={doc._id} className="flex items-center justify-between py-2 gap-3">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                    <span className="text-xs">{doc.label || doc.docKey}</span>
                  </div>
                  {doc.url && (
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="print:hidden shrink-0 text-[11px] text-blue-600 hover:underline flex items-center gap-1 font-medium"
                    >
                      <Download className="w-3 h-3" /> Télécharger
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Notes */}
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

        <div className="border-t border-slate-200 pt-4 text-[10px] text-slate-400 text-center">
          Généré par Joventy · joventy.cd · Assistance visa premium pour la RDC · Document confidentiel
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
            <img
              src={existingDoc.url}
              alt={label}
              className="w-full max-h-[70vh] object-contain"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
                (e.currentTarget.nextElementSibling as HTMLElement).style.display = "block";
              }}
            />
            <p className="hidden p-6 text-center text-sm text-muted-foreground">
              Aperçu non disponible pour ce format.{" "}
              <a href={existingDoc.url} target="_blank" rel="noreferrer" className="text-primary underline">
                Ouvrir dans un nouvel onglet
              </a>
            </p>
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
  const { toast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [msgText, setMsgText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [showDocGuide, setShowDocGuide] = useState(false);

  const app = useQuery(api.applications.get, appId ? { id: appId } : "skip");
  const messages = useQuery(api.messages.list, appId ? { applicationId: appId } : "skip") ?? [];
  const docs = useQuery(api.documents.listByApplication, appId ? { applicationId: appId } : "skip") ?? [];
  const sendMessage = useMutation(api.messages.send);
  const markAsRead = useMutation(api.messages.markAsRead);
  const visaDocUrl = useQuery(
    api.admin.getVisaDocumentUrl,
    appId ? { applicationId: appId } : "skip"
  );
  const confirmationLetterUrl = useQuery(
    api.documents.getConfirmationLetterUrl,
    appId ? { applicationId: appId } : "skip"
  );

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
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible d'envoyer le message. Réessayez." });
    } finally {
      setIsSending(false);
    }
  };

  if (app === undefined) return <div className="p-12 text-center text-muted-foreground">Chargement des détails...</div>;
  if (!app) return <div className="p-12 text-center text-red-500">Dossier introuvable</div>;

  const isRejected = app.status === "rejected";
  const isCompleted = app.status === "completed";
  const isSlotFound = app.status === "slot_found_awaiting_success_fee";
  const isAwaitingEngagement = app.status === "awaiting_engagement_payment";
  const pricing = VISA_PRICING[app.destination as keyof typeof VISA_PRICING];

  const isEngagementPaid = app.priceDetails?.isEngagementPaid ?? false;
  const isSuccessFeePaid = app.priceDetails?.isSuccessFeePaid ?? false;

  const hasEngagementProofPending = !!app.paymentProofUrl && !isEngagementPaid;
  const hasSuccessProofPending = !!app.successFeeProofUrl && !isSuccessFeePaid;

  const successModel = (app as { successModel?: string }).successModel ?? pricing?.successModel ?? "appointment";
  const isEvisaModel = successModel === "evisa";
  const servicePackage = (app as { servicePackage?: string }).servicePackage ?? "full_service";
  const isDossierOnly = servicePackage === "dossier_only";
  const isSlotOnly = servicePackage === "slot_only";
  const successCopy = pricing?.successCopy;
  const STEPS = getSteps(isEvisaModel, isDossierOnly, isSlotOnly);
  const stepIndex = isDossierOnly
    ? getStepIndexDossierOnly(app.status)
    : isSlotOnly
      ? getStepIndexSlotOnly(app.status)
      : getStepIndex(app.status);

  // Appointment details are only shown AFTER success fee is paid (completed state), for appointment model
  const showAppointmentDetails = isCompleted && isSuccessFeePaid && !isEvisaModel;

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
        <div className="flex flex-col items-end gap-2">
          <StatusBadge status={app.status} />
          <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full ${
            isDossierOnly
              ? "bg-blue-100 text-blue-700"
              : servicePackage === "slot_only"
                ? "bg-purple-100 text-purple-700"
                : "bg-orange-100 text-orange-700"
          }`}>
            {isDossierOnly
              ? <ClipboardCheck className="w-3 h-3" />
              : servicePackage === "slot_only"
                ? <Calendar className="w-3 h-3" />
                : <Star className="w-3 h-3" />}
            {SERVICE_PACKAGES[servicePackage as keyof typeof SERVICE_PACKAGES]?.label ?? "Service Complet"}
          </span>
        </div>
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

      {/* ---- Avis client (dossier complété) ---- */}
      {isCompleted && appId && (
        <div className="bg-green-50 border-2 border-green-300 rounded-2xl p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-green-100 flex items-center justify-center flex-shrink-0">
              <MessageSquareHeart className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <h3 className="font-bold text-green-900">Félicitations pour votre dossier !</h3>
              <p className="text-sm text-green-700 mt-0.5">
                Votre expérience peut aider d'autres voyageurs congolais. Partagez votre avis ?
              </p>
            </div>
          </div>
          <Button
            onClick={() => setShowReviewModal(true)}
            className="bg-green-600 hover:bg-green-700 text-white font-semibold px-5 h-10 flex-shrink-0 gap-2"
          >
            <Star className="w-4 h-4" />
            Donner mon avis
          </Button>
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
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
              <Sparkles className="w-6 h-6 text-green-600" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-green-700 mb-1">
                {successCopy?.clientCtaTitle ?? "Résultat obtenu !"}
              </h3>
              <p className="text-sm text-slate-600 mb-1">
                {successCopy?.clientCtaBody
                  ? successCopy.clientCtaBody.replace("{{amount}}", formatCurrency(app.priceDetails?.successFee) ?? "")
                  : <>Joventy a capturé un résultat. Réglez la prime de succès de{" "}
                      <strong className="text-primary">{formatCurrency(app.priceDetails?.successFee)}</strong>{" "}
                      pour y accéder.</>}
              </p>
              {!isEvisaModel && app.slotExpiresAt && (
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
            <strong>Reçu de prime de succès reçu !</strong> Validation en cours —{" "}
            {isEvisaModel
              ? "votre visa sera débloqué sous 24h."
              : "vos détails de RDV seront débloqués sous 24h."}
          </p>
        </div>
      )}

      {/* Spain OTP config card — shown when engagement paid, not completed/rejected */}
      {app.destination === "spain" && isEngagementPaid && !isCompleted && !isRejected && appId && (
        <SpainOtpConfigCard appId={appId} />
      )}

      {/* Dossier only — completed card */}
      {isCompleted && isDossierOnly && (
        <div className="bg-blue-50 border-2 border-blue-400 rounded-2xl p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
              <ClipboardCheck className="w-6 h-6 text-blue-600" />
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-blue-700 mb-1">
                Votre dossier est prêt !
              </h3>
              <p className="text-sm text-slate-600 mb-2">
                Joventy a constitué et vérifié l'intégralité de votre dossier de demande de visa. Tous les documents sont conformes aux exigences du consulat.
              </p>
              <p className="text-xs text-slate-500">
                Prenez rendez-vous directement au consulat ou ambassade avec votre dossier complet.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Interview kit — only when completed, appointment model, not dossier_only */}
      {isCompleted && !isEvisaModel && !isDossierOnly && <InterviewKit app={app} confirmationLetterUrl={confirmationLetterUrl} docs={docs as KitDoc[]} />}

      {/* Visa PDF delivery — evisa model */}
      {isCompleted && isEvisaModel && !isDossierOnly && (
        <div className="bg-green-50 border-2 border-green-400 rounded-2xl p-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
              <Stamp className="w-6 h-6 text-green-600" />
            </div>
            <div className="flex-1">
              <h3 className="text-xl font-bold text-green-700 mb-1">
                {successCopy?.completedNote ?? "Votre visa est disponible !"}
              </h3>
              <p className="text-sm text-slate-600 mb-4">
                Félicitations ! Votre visa a été accordé. Téléchargez votre document officiel ci-dessous.
              </p>
              <div className="flex flex-wrap gap-3 items-center">
                {visaDocUrl ? (
                  <Button asChild className="bg-primary hover:bg-primary/90 text-white font-bold gap-2 h-11">
                    <a href={visaDocUrl} target="_blank" rel="noopener noreferrer" download>
                      <Download className="w-4 h-4" /> Télécharger mon visa
                    </a>
                  </Button>
                ) : (
                  <div className="flex items-center gap-2 text-amber-700 text-sm">
                    <Clock className="w-4 h-4" /> Document en cours de préparation...
                  </div>
                )}
                {confirmationLetterUrl && (
                  <Button asChild variant="outline" size="sm" className="gap-2 border-green-600 text-green-700 hover:bg-green-50">
                    <a href={confirmationLetterUrl} target="_blank" rel="noopener noreferrer" download="confirmation_soumission_evisa.pdf">
                      <FileText className="w-4 h-4" /> Confirmation de soumission
                    </a>
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

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
                  {isDossierOnly ? (
                    <p className="text-sm flex items-center gap-1 text-slate-400 line-through">
                      <Lock className="w-3.5 h-3.5" />
                      Prime de succès : <span>Non applicable</span>
                    </p>
                  ) : (
                    <p className="text-sm flex items-center gap-1">
                      {isSuccessFeePaid ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600" /> : <Lock className="w-3.5 h-3.5 text-slate-400" />}
                      Prime de succès : <span className={isSuccessFeePaid ? "text-green-700 font-semibold" : "text-slate-500"}>
                        {formatCurrency(app.priceDetails?.successFee)}{isSuccessFeePaid ? " ✓" : ""}
                      </span>
                    </p>
                  )}
                </div>
              </div>
              {!isEvisaModel && (
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
              )}
              {isEvisaModel && (
                <div>
                  <p className="text-xs text-muted-foreground font-medium uppercase mb-1">Statut Visa</p>
                  {isCompleted && visaDocUrl ? (
                    <p className="text-sm text-green-700 font-semibold flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" /> Visa accordé — prêt au téléchargement
                    </p>
                  ) : isSlotFound ? (
                    <div className="flex items-center gap-2 text-slate-500">
                      <Lock className="w-4 h-4 text-amber-500" />
                      <p className="text-sm italic">Débloqué après paiement de la prime de succès</p>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500 flex items-center gap-2">
                      <Search className="w-4 h-4 text-slate-300" />
                      En cours d'obtention
                    </p>
                  )}
                </div>
              )}
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
                  {docs.filter((d) => !d.isAdminUpload).length}/{getUploadDocs(app.destination, app.visaType).length} fourni(s)
                </span>
              </div>

              {/* Guide des documents rétractable */}
              <div className="mb-5 rounded-xl border border-blue-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowDocGuide((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-blue-50 hover:bg-blue-100 transition-colors text-left"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-blue-800">
                    <FileText className="w-4 h-4 text-blue-600" />
                    📋 Guide complet des documents requis — {app.visaType}
                  </span>
                  <ChevronDown className={`w-4 h-4 text-blue-500 transition-transform ${showDocGuide ? "rotate-180" : ""}`} />
                </button>
                {showDocGuide && (
                  <div className="p-4 bg-white">
                    <p className="text-xs text-muted-foreground mb-4">
                      Ce guide liste tous les documents par catégorie : ce que vous devez uploader ici, ce que Joventy prépare, et les frais que vous réglez directement.
                    </p>
                    <DocumentChecklist destination={app.destination} visaType={app.visaType} servicePackage={servicePackage} />
                  </div>
                )}
              </div>

              {/* slot_only notice */}
              {servicePackage === "slot_only" && (
                <div className="flex items-start gap-3 bg-purple-50 border border-purple-200 rounded-xl p-4 text-sm text-purple-800 mb-4">
                  <Calendar className="w-4 h-4 mt-0.5 flex-shrink-0 text-purple-500" />
                  <p>
                    <strong>Package Créneau Uniquement :</strong> Vous avez indiqué que votre dossier est déjà constitué.
                    Les documents ci-dessous sont <strong>optionnels</strong> — vous pouvez les soumettre directement au consulat.
                  </p>
                </div>
              )}

              <div>
                {getUploadDocs(app.destination, app.visaType).map((doc) => {
                  const uploaded = docs.find((d) => d.docKey === doc.key && !d.isAdminUpload);
                  return (
                    <ClientDocRow
                      key={doc.key}
                      appId={appId!}
                      docKey={doc.key}
                      label={doc.label}
                      required={servicePackage === "slot_only" ? false : doc.required}
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

          {/* Guide complet des documents (avant paiement et toujours accessible) */}
          {!isEngagementPaid && (
            <div className="bg-white p-6 rounded-2xl border border-border shadow-sm">
              <h2 className="text-lg font-bold text-primary mb-1 flex items-center gap-2">
                <FileText className="w-4 h-4 text-secondary" /> Guide des documents — {app.visaType}
              </h2>
              <p className="text-sm text-muted-foreground mb-5">
                Voici l'ensemble des documents nécessaires pour votre dossier, classés par catégorie.
              </p>
              <DocumentChecklist destination={app.destination} visaType={app.visaType} servicePackage={servicePackage} />
            </div>
          )}

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

      {showReviewModal && appId && (
        <ReviewModal
          applicationId={appId}
          destination={`${pricing?.flag ?? ""} ${app.visaType}`}
          onClose={() => setShowReviewModal(false)}
        />
      )}
    </div>
  );
}
