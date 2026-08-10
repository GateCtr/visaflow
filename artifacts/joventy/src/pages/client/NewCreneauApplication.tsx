import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import { VISA_PRICING, CRENEAU_PROMO_PRICING, SERVICE_PACKAGES } from "@convex/constants";

// Destinations disponibles pour slot_only — dérivées directement de la config backend.
// Ne pas modifier manuellement : modifiez SERVICE_PACKAGES.slot_only.availableFor dans constants.ts.
const SLOT_ONLY_SUPPORTED = new Set(
  SERVICE_PACKAGES.slot_only.availableFor as readonly string[]
);
import { formatCurrency } from "@/lib/format";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ArrowLeft, ArrowRight, MapPin, Plane, CreditCard, Upload, CheckCircle2,
  Clock, ExternalLink, Info, FileText, Camera, Ticket, Hotel,
  Shield, Mail, MessageCircle,
} from "lucide-react";

// ─── Destinations créneau uniquement ────────────────────────────────────────
// Note: le bot est configuré par notre équipe après validation du paiement.
// Aucune destination n'est activée automatiquement à la création du dossier.
const CRENEAU_DESTINATIONS = [
  {
    id: "usa",
    name: "États-Unis",
    flag: "🇺🇸",
    desc: "Ambassade américaine de Kinshasa",
    visaTypes: VISA_PRICING.usa.visaTypes,
  },
  {
    id: "canada",
    name: "Canada",
    flag: "🇨🇦",
    desc: "Centre VFS IRCC — biométrie & dépôt",
    visaTypes: VISA_PRICING.canada.visaTypes,
  },
  {
    id: "uk",
    name: "Royaume-Uni",
    flag: "🇬🇧",
    desc: "Centre VFS UKVI — Kinshasa",
    visaTypes: VISA_PRICING.uk.visaTypes,
  },
  {
    id: "schengen",
    name: "Europe Schengen",
    flag: "🇪🇺",
    desc: "Centre Européen des Visas (CEV) — 17 pays",
    visaTypes: ["Visa C — Tourisme / Affaires", "Visa C — Études court séjour"],
  },
  {
    id: "spain",
    name: "Espagne",
    flag: "🇪🇸",
    desc: "Ambassade d'Espagne — portail citaconsular.es",
    visaTypes: VISA_PRICING.spain.visaTypes,
  },
  {
    id: "germany",
    name: "Allemagne",
    flag: "🇩🇪",
    desc: "Ambassade d'Allemagne — portail RK-Termin",
    visaTypes: VISA_PRICING.germany.visaTypes,
  },
  {
    id: "switzerland",
    name: "Suisse",
    flag: "🇨🇭",
    desc: "Centre VFS Global Suisse — Kinshasa",
    visaTypes: ["Visa C — Tourisme / Affaires (Schengen)", "Visa C — Études court séjour"],
  },
  {
    id: "turkey",
    name: "Turquie",
    flag: "🇹🇷",
    desc: "Centre VFS Global Turquie — Kinshasa",
    visaTypes: VISA_PRICING.turkey.visaTypes,
  },
  {
    id: "brazil",
    name: "Brésil",
    flag: "🇧🇷",
    desc: "Ambassade du Brésil — Kinshasa",
    visaTypes: ["Visa Tourisme", "Visa Affaires", "Visa Études"],
  },
] as const;

type CreneauDest = (typeof CRENEAU_DESTINATIONS)[number]["id"];

const CEV_COUNTRIES = [
  { code: "BE", label: "🇧🇪 Belgique" },
  { code: "FR", label: "🇫🇷 France" },
  { code: "DE", label: "🇩🇪 Allemagne" },
  { code: "NL", label: "🇳🇱 Pays-Bas" },
  { code: "ES", label: "🇪🇸 Espagne" },
  { code: "IT", label: "🇮🇹 Italie" },
  { code: "CH", label: "🇨🇭 Suisse" },
  { code: "PT", label: "🇵🇹 Portugal" },
  { code: "AT", label: "🇦🇹 Autriche" },
  { code: "SE", label: "🇸🇪 Suède" },
  { code: "NO", label: "🇳🇴 Norvège" },
  { code: "DK", label: "🇩🇰 Danemark" },
  { code: "FI", label: "🇫🇮 Finlande" },
  { code: "GR", label: "🇬🇷 Grèce" },
  { code: "PL", label: "🇵🇱 Pologne" },
];

// Tous les uploads Espagne sont optionnels ici — ils peuvent être ajoutés
// depuis la fiche dossier après paiement. La validation obligatoire est
// effectuée par notre équipe avant l'activation du bot.
const SPAIN_UPLOADS = [
  { key: "passport_scan", label: "Scan du passeport", desc: "Pages biométriques recto-verso, haute résolution", icon: FileText },
  { key: "photo_passport", label: "Photo du passeport", desc: "Photo de la page biométrique ouverte, lisible", icon: Camera },
  { key: "selfie_passport", label: "Selfie avec le passeport", desc: "Vous tenant votre passeport ouvert (visage + passeport lisibles)", icon: Camera },
  { key: "flight_booking", label: "Réservation de billet", desc: "Confirmation de vol aller-retour", icon: Ticket },
  { key: "hotel_booking", label: "Réservation hôtel", desc: "Confirmation de séjour ou attestation d'hébergement", icon: Hotel },
  { key: "health_insurance", label: "Assurance maladie", desc: "Assurance santé voyage Schengen (min. 30 000 €)", icon: Shield },
] as const;

type WizardStep = "destination" | "info" | "spain-uploads" | "recap";

// ─── Composant FileUploadSlot ────────────────────────────────────────────────
function FileUploadSlot({
  label,
  desc,
  icon: Icon,
  file,
  onChange,
}: {
  label: string;
  desc: string;
  icon: React.ElementType;
  file: File | null;
  onChange: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      className={`flex items-center gap-4 p-4 rounded-xl border-2 cursor-pointer transition-all ${file ? "border-emerald-400 bg-emerald-50/50" : "border-border hover:border-primary/30"}`}
      onClick={() => ref.current?.click()}
    >
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${file ? "bg-emerald-100" : "bg-slate-100"}`}>
        {file ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <Icon className="w-5 h-5 text-slate-400" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold text-sm text-primary">{label} <span className="text-xs font-normal text-slate-400">(optionnel)</span></p>
        <p className="text-xs text-muted-foreground mt-0.5">{file ? <span className="text-emerald-700 font-medium">{file.name}</span> : desc}</p>
      </div>
      <Upload className={`w-4 h-4 flex-shrink-0 ${file ? "text-emerald-500" : "text-slate-300"}`} />
      <input ref={ref} type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
    </div>
  );
}

// ─── Page principale ─────────────────────────────────────────────────────────
export default function NewCreneauApplication() {
  const [step, setStep] = useState<WizardStep>("destination");
  const [dest, setDest] = useState<CreneauDest | "">("");
  const [visaType, setVisaType] = useState("");
  const [applicantName, setApplicantName] = useState("");
  const [passportNumber, setPassportNumber] = useState("");
  const [travelDate, setTravelDate] = useState("");
  const [returnDate, setReturnDate] = useState("");
  const [nationality, setNationality] = useState("Congolaise (RDC)");
  // Spain-specific
  const [emailSentToEmbassy, setEmailSentToEmbassy] = useState(false);
  const [spainFiles, setSpainFiles] = useState<Record<string, File | null>>({
    passport_scan: null, photo_passport: null, selfie_passport: null,
    flight_booking: null, hotel_booking: null, health_insurance: null,
  });
  // Schengen-specific
  const [cevTargetCountry, setCevTargetCountry] = useState("BE");
  const [cevAgeCategory, setCevAgeCategory] = useState<"adult" | "child_6_12" | "child_under_6">("adult");
  const [cevForm, setCevForm] = useState<File | null>(null);
  const cevFormRef = useRef<HTMLInputElement>(null);
  // Shared
  const [userWhatsapp, setUserWhatsapp] = useState("");
  const [isPending, setIsPending] = useState(false);
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const createApplication = useMutation(api.applications.create);
  const generateUploadUrl = useMutation(api.documents.generateUploadUrl);
  const uploadDocument = useMutation(api.documents.uploadDocument);
  const markConvinced = useMutation(api.victor.markConvinced);

  const selectedDest = CRENEAU_DESTINATIONS.find((d) => d.id === dest);
  const { normalPrice, promoPrice, depositAmount, successAmount, processingWeeksMin } = CRENEAU_PROMO_PRICING;

  // ── Navigation ──────────────────────────────────────────────────────────────
  const goNext = () => {
    if (step === "destination") {
      if (!dest) return;
      setStep("info");
    } else if (step === "info") {
      if (!validateInfo()) return;
      if (dest === "spain" && !emailSentToEmbassy) {
        setStep("spain-uploads");
      } else {
        setStep("recap");
      }
    } else if (step === "spain-uploads") {
      setStep("recap");
    }
  };

  const goBack = () => {
    if (step === "recap") {
      setStep(dest === "spain" && !emailSentToEmbassy ? "spain-uploads" : "info");
    } else if (step === "spain-uploads") {
      setStep("info");
    } else if (step === "info") {
      setStep("destination");
    }
  };

  const validateInfo = (): boolean => {
    if (!applicantName.trim()) { toast({ variant: "destructive", title: "Champ requis", description: "Veuillez renseigner le nom du demandeur." }); return false; }
    if (!visaType && dest !== "schengen") { toast({ variant: "destructive", title: "Champ requis", description: "Veuillez choisir le type de visa." }); return false; }
    if (dest !== "schengen" && !passportNumber.trim()) { toast({ variant: "destructive", title: "Champ requis", description: "Veuillez renseigner le numéro de passeport." }); return false; }
    if (!travelDate && dest !== "schengen") { toast({ variant: "destructive", title: "Champ requis", description: "Veuillez indiquer la date de voyage." }); return false; }
    return true;
  };

  // ── Upload helper ───────────────────────────────────────────────────────────
  // Retourne true si l'upload a réussi, false sinon. Les erreurs sont loguées
  // mais non bloquantes — les documents peuvent être ajoutés depuis la fiche dossier.
  async function uploadFile(file: File, applicationId: Id<"applications">, docKey: string, label: string): Promise<boolean> {
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { storageId } = await res.json();
      await uploadDocument({ applicationId, docKey, label, storageId });
      return true;
    } catch (err) {
      console.warn(`[NewCreneau] upload failed for ${docKey}:`, err);
      return false;
    }
  }

  // ── Soumission ──────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    // Vérification de sécurité : la destination doit être supportée par slot_only côté backend
    if (!dest || !SLOT_ONLY_SUPPORTED.has(dest)) {
      toast({ variant: "destructive", title: "Destination non supportée", description: "Veuillez sélectionner une destination valide." });
      return;
    }
    setIsPending(true);
    try {
      const finalVisaType = dest === "schengen" ? "Visa C — Tourisme / Affaires" : visaType;
      const finalTravelDate = dest === "schengen" ? (travelDate || new Date(Date.now() + 90 * 864e5).toISOString().split("T")[0]) : travelDate;

      const id = await createApplication({
        destination: dest as string,
        visaType: finalVisaType,
        applicantName: applicantName.trim(),
        passportNumber: passportNumber.trim() || undefined,
        travelDate: finalTravelDate,
        returnDate: returnDate || undefined,
        purpose: "Demande de créneau consulaire via Joventy",
        servicePackage: "slot_only",
        slotUrgencyTier: "standard",
        cevVisaClass: dest === "schengen" ? "C" : undefined,
        cevApplicantAgeCategory: dest === "schengen" ? cevAgeCategory : undefined,
        cevTargetCountry: dest === "schengen" ? cevTargetCountry : undefined,
        slotBookingRefs: undefined,
        userWhatsapp: userWhatsapp.trim() || undefined,
      });

      // Upload des documents (optionnels) — les résultats sont collectés pour informer l'utilisateur
      const uploadTasks: { label: string; promise: Promise<boolean> }[] = [];
      if (dest === "spain") {
        for (const u of SPAIN_UPLOADS) {
          const file = spainFiles[u.key];
          if (file) uploadTasks.push({ label: u.label, promise: uploadFile(file, id, u.key, u.label) });
        }
      }
      if (dest === "schengen" && cevForm) {
        uploadTasks.push({ label: "Formulaire CEV", promise: uploadFile(cevForm, id, "cev_form", "Formulaire CEV") });
      }
      const uploadResults = await Promise.all(uploadTasks.map((t) => t.promise));
      const failedUploads = uploadTasks.filter((_, i) => !uploadResults[i]);

      try {
        const victorSessionId = localStorage.getItem("victor_session_id");
        if (victorSessionId) await markConvinced({ sessionId: victorSessionId, action: "dossier_created" });
      } catch { /* non bloquant */ }

      if (failedUploads.length > 0) {
        toast({
          title: "Dossier créé — certains documents non uploadés",
          description: `${failedUploads.map((f) => f.label).join(", ")} n'ont pas pu être uploadés. Vous pouvez les ajouter depuis votre fiche dossier.`,
        });
      } else {
        toast({ title: "Dossier créé !", description: "Réglez l'acompte pour démarrer la recherche de créneau." });
      }
      setLocation(`/dashboard/applications/${id}/payment`);
    } catch (e) {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible de créer le dossier. Réessayez." });
    } finally {
      setIsPending(false);
    }
  };

  // ── Rendu des étapes ─────────────────────────────────────────────────────────
  const STEP_LABELS: { key: WizardStep; label: string }[] = [
    { key: "destination", label: "Destination" },
    { key: "info", label: "Vos informations" },
    ...(dest === "spain" && !emailSentToEmbassy ? [{ key: "spain-uploads" as WizardStep, label: "Documents" }] : []),
    { key: "recap", label: "Confirmation" },
  ];
  const stepIdx = STEP_LABELS.findIndex((s) => s.key === step);

  return (
    <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500">
      {/* En-tête */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <button onClick={() => setLocation("/dashboard")} className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Retour
          </button>
        </div>
        <h1 className="text-3xl font-serif font-bold text-primary">Demande de créneau</h1>
        <p className="text-muted-foreground mt-1">Joventy surveille le portail consulaire et capture votre rendez-vous dès qu'une place se libère.</p>
      </div>

      {/* Barre de progression */}
      <div className="flex gap-2">
        {STEP_LABELS.map((s, i) => {
          const done = i < stepIdx;
          const active = i === stepIdx;
          return (
            <div key={s.key} className="flex-1 flex flex-col items-center gap-1.5">
              <div className={`w-full h-1.5 rounded-full transition-colors ${done || active ? "bg-secondary" : "bg-slate-200"}`} />
              <span className={`hidden sm:block text-xs font-medium ${active ? "text-secondary" : done ? "text-primary" : "text-slate-400"}`}>{s.label}</span>
            </div>
          );
        })}
      </div>

      {/* Bannière tarif */}
      <div className="bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-3">
          <Clock className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <div>
            <p className="font-bold text-amber-900 text-sm">Délai minimum : {processingWeeksMin} semaines</p>
            <p className="text-xs text-amber-700 mt-0.5">Joventy surveille les portails 24h/24 et capture votre créneau dès qu'une place apparaît.</p>
          </div>
        </div>
        <div className="sm:ml-auto text-right flex-shrink-0">
          <p className="text-xs text-slate-500 line-through">{formatCurrency(normalPrice)}</p>
          <p className="text-xl font-bold text-secondary">{formatCurrency(promoPrice)} <span className="text-xs font-normal text-slate-500">promo</span></p>
          <p className="text-xs text-slate-600">Acompte : <strong>{formatCurrency(depositAmount)}</strong> maintenant</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-border shadow-sm p-6 sm:p-8">

        {/* ── ÉTAPE 1 : Destination ─────────────────────────────────────────── */}
        {step === "destination" && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <MapPin className="w-5 h-5 text-secondary" /> Choisissez votre destination
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {CRENEAU_DESTINATIONS.map((d) => (
                <button
                  key={d.id}
                  onClick={() => { setDest(d.id); setVisaType(""); }}
                  className={`p-4 rounded-xl border-2 text-left transition-all ${dest === d.id ? "border-secondary bg-orange-50/50" : "border-border hover:border-primary/20"}`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xl">{d.flag}</span>
                    <span className="font-bold text-primary">{d.name}</span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{d.desc}</p>
                </button>
              ))}
            </div>
            <Button onClick={goNext} disabled={!dest} className="w-full h-12 bg-secondary text-primary hover:bg-orange-500 font-bold">
              Continuer <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>
        )}

        {/* ── ÉTAPE 2 : Info destination-specific ─────────────────────────── */}
        {step === "info" && selectedDest && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <span className="text-2xl">{selectedDest.flag}</span> {selectedDest.name} — Vos informations
            </h2>

            {/* Nom du demandeur — commun à tous */}
            <div>
              <label className="block text-sm font-semibold text-primary mb-1.5">Nom complet du demandeur <span className="text-red-500">*</span></label>
              <Input value={applicantName} onChange={(e) => setApplicantName(e.target.value)} placeholder="Prénom Nom (tel qu'il apparaît sur le passeport)" className="h-11" />
            </div>

            {/* Champs Allemagne */}
            {dest === "germany" && (
              <div>
                <label className="block text-sm font-semibold text-primary mb-1.5">Nationalité <span className="text-red-500">*</span></label>
                <Input value={nationality} onChange={(e) => setNationality(e.target.value)} placeholder="Ex : Congolaise (RDC)" className="h-11" />
              </div>
            )}

            {/* Numéro de passeport — sauf Schengen (géré via VOWINT) */}
            {dest !== "schengen" && (
              <div>
                <label className="block text-sm font-semibold text-primary mb-1.5">Numéro de passeport <span className="text-red-500">*</span></label>
                <Input value={passportNumber} onChange={(e) => setPassportNumber(e.target.value)} placeholder="Ex : AB1234567" className="h-11" />
              </div>
            )}

            {/* Type de visa */}
            {dest !== "schengen" && (
              <div>
                <label className="block text-sm font-semibold text-primary mb-1.5">Type de visa <span className="text-red-500">*</span></label>
                <Select value={visaType} onValueChange={setVisaType}>
                  <SelectTrigger className="h-11"><SelectValue placeholder="Sélectionnez le type de visa" /></SelectTrigger>
                  <SelectContent>
                    {selectedDest.visaTypes.map((vt) => (
                      <SelectItem key={vt} value={vt}>{vt}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Champs Schengen/CEV */}
            {dest === "schengen" && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-primary mb-1.5">Pays de destination Schengen <span className="text-red-500">*</span></label>
                  <Select value={cevTargetCountry} onValueChange={setCevTargetCountry}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CEV_COUNTRIES.map((c) => <SelectItem key={c.code} value={c.code}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-primary mb-1.5">Catégorie d'âge</label>
                  <Select value={cevAgeCategory} onValueChange={(v) => setCevAgeCategory(v as typeof cevAgeCategory)}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="adult">Adulte (≥ 12 ans) — 90 €</SelectItem>
                      <SelectItem value="child_6_12">Enfant 6-12 ans — 45 €</SelectItem>
                      <SelectItem value="child_under_6">Enfant moins de 6 ans — Gratuit</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="block text-sm font-semibold text-primary mb-1.5">Formulaire CEV <span className="text-slate-400 font-normal">(optionnel — peut être uploadé depuis le dossier)</span></label>
                  <div
                    className={`flex items-center gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all ${cevForm ? "border-emerald-400 bg-emerald-50/50" : "border-dashed border-border hover:border-primary/30"}`}
                    onClick={() => cevFormRef.current?.click()}
                  >
                    {cevForm ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <Upload className="w-5 h-5 text-slate-400" />}
                    <span className="text-sm text-muted-foreground">{cevForm ? <span className="text-emerald-700 font-medium">{cevForm.name}</span> : "Cliquez pour uploader le formulaire CEV"}</span>
                  </div>
                  <input ref={cevFormRef} type="file" className="hidden" accept="image/*,application/pdf" onChange={(e) => setCevForm(e.target.files?.[0] ?? null)} />
                </div>
              </div>
            )}

            {/* Champs Espagne — instruction credentials via messagerie sécurisée */}
            {dest === "spain" && (
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-800 flex items-start gap-3">
                  <Info className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-600" />
                  <div>
                    <p className="font-semibold mb-1">Identifiants portail Espagne — partagés en toute sécurité</p>
                    <p>L'ambassade vous envoie un identifiant + mot de passe par email. Après création du dossier, partagez-les avec notre équipe via la <strong>messagerie sécurisée</strong> de votre espace client. Vos identifiants ne sont jamais stockés dans votre dossier public.</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
                  <MessageCircle className="w-4 h-4 mt-0.5 flex-shrink-0 text-emerald-600" />
                  <p className="text-xs text-emerald-800">
                    <strong>Après paiement :</strong> rendez-vous dans "Messagerie" → votre dossier → envoyez votre n° de passeport + mot de passe portail à notre équipe.
                  </p>
                </div>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={emailSentToEmbassy}
                    onChange={(e) => setEmailSentToEmbassy(e.target.checked)}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-secondary focus:ring-secondary"
                  />
                  <span className="text-sm text-primary group-hover:text-primary/80">
                    J'ai déjà envoyé mon mail à l'ambassade et reçu mes identifiants
                  </span>
                </label>
              </div>
            )}

            {/* Date de voyage — sauf Schengen */}
            {dest !== "schengen" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-primary mb-1.5">Date de voyage souhaitée <span className="text-red-500">*</span></label>
                  <Input type="date" value={travelDate} onChange={(e) => setTravelDate(e.target.value)} className="h-11" min={new Date().toISOString().split("T")[0]} />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-primary mb-1.5">Date de retour <span className="text-slate-400 font-normal">(optionnel)</span></label>
                  <Input type="date" value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="h-11" min={travelDate || new Date().toISOString().split("T")[0]} />
                </div>
              </div>
            )}

            {/* WhatsApp */}
            <div>
              <label className="block text-sm font-semibold text-primary mb-1.5">WhatsApp <span className="text-slate-400 font-normal">(pour les notifications urgentes)</span></label>
              <Input value={userWhatsapp} onChange={(e) => setUserWhatsapp(e.target.value)} placeholder="+243 xxx xxx xxx" className="h-11" />
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} className="h-12 px-6">
                <ArrowLeft className="w-4 h-4 mr-2" /> Retour
              </Button>
              <Button onClick={goNext} className="flex-1 h-12 bg-secondary text-primary hover:bg-orange-500 font-bold">
                Continuer <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* ── ÉTAPE 3 : Documents Espagne ───────────────────────────────────── */}
        {step === "spain-uploads" && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <span className="text-2xl">🇪🇸</span> Documents pour l'ambassade
            </h2>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-900 flex items-start gap-3">
              <Mail className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-700" />
              <div>
                <p className="font-semibold mb-1">Envoyez votre mail à l'ambassade d'abord</p>
                <p className="mb-2">Pour obtenir vos identifiants de connexion, envoyez un email à <strong>emb.kinshasa.citasvis@maec.es</strong> avec l'objet <strong>"RENDEZ-VOUS VISA EST"</strong> et les documents ci-dessous en pièces jointes.</p>
                <a href="https://www.joventy.cd/guides/espagne-mail-ambassade" target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-amber-700 hover:text-amber-900 font-semibold underline">
                  Voir le guide complet <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>

            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-800">
              Tous les uploads sont <strong>optionnels ici</strong> — vous pouvez les ajouter depuis votre fiche dossier après paiement. Notre équipe vérifie et valide chaque document avant le démarrage de la recherche de créneau.
            </div>

            <div className="space-y-3">
              {SPAIN_UPLOADS.map((u) => (
                <FileUploadSlot
                  key={u.key}
                  label={u.label}
                  desc={u.desc}
                  icon={u.icon}
                  file={spainFiles[u.key]}
                  onChange={(f) => setSpainFiles((prev) => ({ ...prev, [u.key]: f }))}
                />
              ))}
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} className="h-12 px-6">
                <ArrowLeft className="w-4 h-4 mr-2" /> Retour
              </Button>
              <Button onClick={goNext} className="flex-1 h-12 bg-secondary text-primary hover:bg-orange-500 font-bold">
                Continuer <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}

        {/* ── ÉTAPE 4 : Récap & confirmation ───────────────────────────────── */}
        {step === "recap" && selectedDest && (
          <div className="space-y-6">
            <h2 className="text-xl font-bold text-primary flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-secondary" /> Récapitulatif & paiement
            </h2>

            {/* Résumé dossier */}
            <div className="bg-slate-50 rounded-xl border border-border p-5 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Destination</span>
                <span className="font-semibold text-primary">{selectedDest.flag} {selectedDest.name}</span>
              </div>
              {visaType && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Type de visa</span>
                  <span className="font-semibold text-primary">{visaType}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Demandeur</span>
                <span className="font-semibold text-primary">{applicantName}</span>
              </div>
              {passportNumber && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">N° passeport</span>
                  <span className="font-semibold text-primary">{passportNumber}</span>
                </div>
              )}
              {travelDate && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Date souhaitée</span>
                  <span className="font-semibold text-primary">{new Date(travelDate).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" })}</span>
                </div>
              )}
              {dest === "schengen" && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Pays cible CEV</span>
                  <span className="font-semibold text-primary">{CEV_COUNTRIES.find((c) => c.code === cevTargetCountry)?.label ?? cevTargetCountry}</span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Délai minimum</span>
                <span className="font-semibold text-amber-700">{processingWeeksMin} semaines</span>
              </div>
            </div>

            {/* Tarif */}
            <div className="bg-primary rounded-2xl p-6 text-white">
              <div className="flex items-baseline gap-3 mb-4">
                <span className="text-slate-400 text-lg line-through">{formatCurrency(normalPrice)}</span>
                <span className="text-3xl font-bold text-secondary">{formatCurrency(promoPrice)}</span>
                <span className="text-xs bg-secondary/20 text-secondary px-2 py-1 rounded-full font-semibold">PROMO</span>
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-300">Acompte à payer maintenant</span>
                  <span className="font-bold text-secondary">{formatCurrency(depositAmount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-300">Solde (créneau obtenu)</span>
                  <span className="font-semibold text-white">{formatCurrency(successAmount)}</span>
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-3 pt-3 border-t border-white/10">
                Le solde n'est dû qu'une fois votre créneau consulaire obtenu. Si aucun créneau n'est disponible, rien de plus ne vous est facturé.
              </p>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={goBack} className="h-12 px-6">
                <ArrowLeft className="w-4 h-4 mr-2" /> Retour
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={isPending}
                className="flex-1 h-12 bg-secondary text-primary hover:bg-orange-500 font-bold text-base"
              >
                {isPending ? "Création en cours..." : `Créer mon dossier & payer ${formatCurrency(depositAmount)}`}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
