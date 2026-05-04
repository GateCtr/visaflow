import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { VISA_PRICING, SERVICE_PACKAGES, SLOT_URGENCY_TIERS, getAvailablePackages, type ServicePackage, type SlotUrgencyTier } from "@convex/constants";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, ArrowRight, CheckCircle2, Plane, MapPin, CreditCard, FileText, Package, Star, Calendar, ClipboardList } from "lucide-react";

const schema = z.object({
  destination: z.enum(["usa", "dubai", "turkey", "india", "schengen", "spain"]),
  visaType: z.string().min(1, "Type de visa requis"),
  applicantName: z.string().min(2, "Nom du demandeur requis"),
  passportNumber: z.string().min(5, "Numéro de passeport requis"),
  travelDate: z.string().min(1, "Date de voyage requise"),
  returnDate: z.string().optional(),
  purpose: z.string().min(10, "Veuillez détailler le motif de votre voyage"),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

const DESTINATIONS = [
  { id: "usa",      name: "États-Unis",        desc: "Rendez-vous consulaire — ambassade américaine",                    processType: "appointment" as const },
  { id: "schengen", name: "Europe Schengen 🇪🇺", desc: "Rendez-vous CEV — 17 pays Schengen depuis Kinshasa",              processType: "appointment" as const },
  { id: "spain",    name: "Espagne 🇪🇸",         desc: "Rendez-vous consulaire — ambassade d'Espagne (citaconsular.es)", processType: "appointment" as const },
  { id: "dubai",    name: "Dubaï (EAU)",        desc: "E-Visa 100 % en ligne — résultat en 48-72 h",                    processType: "evisa" as const },
  { id: "turkey",   name: "Turquie",            desc: "E-Visa en ligne ou Visa Sticker via VFS Global",                 processType: "hybrid" as const },
  { id: "india",    name: "Inde",               desc: "E-Visa électronique ou visa régulier (études)",                  processType: "evisa" as const },
];

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
  { code: "CZ", label: "🇨🇿 République tchèque" },
  { code: "SK", label: "🇸🇰 Slovaquie" },
];

function getCevConsulaireFee(visaType: string, ageCategory: string): string {
  if (visaType.includes("Long Séjour") || visaType.includes("Visa D")) {
    return "180 € + redevance OE (variable)";
  }
  if (ageCategory === "child_under_6") return "Gratuit";
  if (ageCategory === "child_6_12") return "45 €";
  if (visaType.includes("Études")) return "Gratuit (court séjour éducatif)";
  return "90 €";
}

const PACKAGE_ICONS: Record<string, React.ElementType> = {
  full_service: Star,
  slot_only: Calendar,
  dossier_only: ClipboardList,
};

type PkgInfo = { label: string; tagline: string; description: string; slotNote?: string };

function getPackageInfo(
  pkgKey: ServicePackage,
  destination: string | undefined,
  visaType: string,
  pricing: (typeof VISA_PRICING)[keyof typeof VISA_PRICING] | null,
): PkgInfo {
  const base = SERVICE_PACKAGES[pkgKey];
  if (!destination || !pricing) {
    return { label: base.label, tagline: base.tagline, description: base.description };
  }

  const isTurkeyEvisa = destination === "turkey" && visaType.toLowerCase().includes("e-visa");
  const isEvisa = pricing.successModel === "evisa" || isTurkeyEvisa;

  if (pkgKey === "full_service") {
    if (isEvisa) {
      const name =
        destination === "turkey" ? "e-Visa Turquie" :
        destination === "dubai"  ? "visa électronique EAU (GDRFA)" :
                                   "e-Visa Inde";
      return {
        label: base.label,
        tagline: "Clé en main",
        description: `Joventy remplit les formulaires officiels, vérifie les pièces que vous fournissez et soumet votre demande de ${name} en ligne. Aucun rendez-vous nécessaire.`,
      };
    }
    const creneauLabel =
      destination === "usa"
        ? "créneau à l'ambassade américaine de Kinshasa"
        : destination === "schengen"
        ? "créneau au Centre Européen des Visas (CEV) Kinshasa"
        : destination === "spain"
        ? "créneau à l'ambassade d'Espagne à Kinshasa (portail citaconsular.es)"
        : "créneau de dépôt au centre VFS Global Kinshasa";
    return {
      label: base.label,
      tagline: "Clé en main",
      description: `Joventy remplit les formulaires, vérifie les pièces que vous fournissez et recherche activement un ${creneauLabel}. Vous n'avez qu'à vous présenter le jour J.`,
    };
  }

  if (pkgKey === "slot_only") {
    if (destination === "usa") {
      return {
        label: "Créneau Ambassade",
        tagline: "Rendez-vous uniquement",
        description: "Vos formulaires sont remplis et vos frais MRV acquittés ? Joventy se concentre uniquement sur la capture d'un créneau disponible à l'ambassade américaine.",
        slotNote: "Prérequis : DS-160 soumis. Frais MRV (265 $) requis — le reçu peut être fourni ultérieurement.",
      };
    }
    if (destination === "turkey") {
      return {
        label: "Créneau VFS",
        tagline: "Dépôt uniquement",
        description: "Vos formulaires sont remplis et votre dossier prêt ? Joventy réserve votre créneau de dépôt au centre VFS Global Kinshasa pour votre Visa Sticker Turquie.",
        slotNote: "Pour le Visa Sticker (VFS) uniquement — pas applicable à l'e-Visa.",
      };
    }
    if (destination === "schengen") {
      return {
        label: "Créneau CEV",
        tagline: "Rendez-vous uniquement",
        description: "Vous avez déjà un dossier VOWINT en cours ? Joventy surveille activement le Centre Européen des Visas et capture un créneau dès qu'une place est disponible pour votre pays cible.",
        slotNote: "Prérequis : dossier VOWINT déjà créé avec vos pièces. Frais consulaires CEV (90 €/adulte) payés au guichet — non inclus.",
      };
    }
    if (destination === "spain") {
      return {
        label: "Créneau Ambassade",
        tagline: "Rendez-vous uniquement",
        description: "Vous avez reçu vos identifiants citaconsular.es de l'ambassade ? Joventy surveille le portail Bookitit et verrouille votre créneau dès qu'une place se libère.",
        slotNote: "Prérequis : inscription préalable par email à emb.kinshasa.citasvis@maec.es (objet : RENDEZ-VOUS VISA EST) pour obtenir vos identifiants. Frais consulaires espagnols (90 €/adulte) payés à l'ambassade — non inclus.",
      };
    }
    return { label: base.label, tagline: base.tagline, description: base.description };
  }

  if (pkgKey === "dossier_only") {
    if (isEvisa) {
      const portal =
        destination === "dubai"  ? "portail officiel GDRFA / ICP" :
        destination === "india"  ? "portail e-Visa indien" :
                                   "portail e-Visa Turquie";
      return {
        label: base.label,
        tagline: base.tagline,
        description: `Joventy remplit les formulaires officiels et vérifie les pièces que vous fournissez. Vous soumettez ensuite vous-même sur le ${portal}. Tarif fixe — aucune prime de succès.`,
      };
    }
    const rdv =
      destination === "usa"
        ? "à l'ambassade américaine"
        : destination === "spain"
        ? "à l'ambassade d'Espagne"
        : destination === "schengen"
        ? "au Centre Européen des Visas (CEV)"
        : "au centre VFS Global";
    return {
      label: base.label,
      tagline: base.tagline,
      description: `Joventy remplit les formulaires requis et vérifie les pièces que vous fournissez pour votre visa ${pricing.label}. Vous gérez ensuite votre rendez-vous ${rdv} de façon autonome. Tarif fixe — aucune prime de succès.`,
    };
  }

  return { label: base.label, tagline: base.tagline, description: base.description };
}

export default function NewApplication() {
  const [step, setStep] = useState(1);
  const [selectedPackage, setSelectedPackage] = useState<ServicePackage>("full_service");
  const [selectedUrgencyTier, setSelectedUrgencyTier] = useState<SlotUrgencyTier>("standard");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const createApplication = useMutation(api.applications.create);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      destination: undefined,
      visaType: "",
      applicantName: "",
      passportNumber: "",
      travelDate: "",
      returnDate: "",
      purpose: "",
      notes: "",
    },
  });

  const selectedDest = form.watch("destination");
  const selectedVisaType = form.watch("visaType");
  const pricing = selectedDest ? VISA_PRICING[selectedDest] : null;
  const isTurkeyEvisa = selectedDest === "turkey" && selectedVisaType.toLowerCase().includes("e-visa");
  const isEvisaFlow = (pricing?.successModel === "evisa") || isTurkeyEvisa;
  const basePackages = selectedDest ? getAvailablePackages(selectedDest) : (["full_service", "dossier_only"] as ServicePackage[]);
  const availablePackages = basePackages.filter((p) => !(p === "slot_only" && isTurkeyEvisa));
  const isDossierOnly = selectedPackage === "dossier_only";
  const isSlotOnly = selectedPackage === "slot_only";
  const activeTier = SLOT_URGENCY_TIERS[selectedUrgencyTier];
  const [isPending, setIsPending] = useState(false);

  const [userWhatsapp, setUserWhatsapp] = useState("");

  const [slotRefs, setSlotRefs] = useState({
    ds160Confirmation: "",
    mrvReceiptNumber: "",
    sevisId: "",
    petitionReceiptNumber: "",
    petitionerName: "",
    vfsRefNumber: "",
    vowintAppId: "",
  });
  const [cevApplicantAgeCategory, setCevApplicantAgeCategory] = useState<"adult" | "child_6_12" | "child_under_6">("adult");
  const [cevTargetCountry, setCevTargetCountry] = useState("BE");

  const isPetitionBased = /k-?1|k-?3|h-?1b?|h-?2|h-?3|l-?1a?|l-?1b?|o-?1|o-?2|p-?[123]|r-?1/i.test(selectedVisaType);
  const isStudentExchange = /f-?1|m-?1|j-?1/i.test(selectedVisaType);
  const showSlotRefsUSA = isSlotOnly && selectedDest === "usa";
  const showSlotRefsTurkey = isSlotOnly && selectedDest === "turkey";
  const showSlotRefsSchengen = isSlotOnly && selectedDest === "schengen";
  const isSchengen = selectedDest === "schengen";
  const cevVisaClass = selectedVisaType.includes("Long Séjour") || selectedVisaType.includes("Visa D") ? "D" : "C" as "C" | "D";
  const cevConsulaireFee = isSchengen ? getCevConsulaireFee(selectedVisaType, cevApplicantAgeCategory) : null;

  const updateRef = (key: keyof typeof slotRefs, val: string) =>
    setSlotRefs((prev) => ({ ...prev, [key]: val }));

  useEffect(() => {
    if (isTurkeyEvisa && selectedPackage === "slot_only") {
      setSelectedPackage("full_service");
    }
  }, [isTurkeyEvisa, selectedPackage]);

  const effectiveEngagementFee = isSlotOnly ? activeTier.depositAmount : (pricing?.engagementFee ?? 0);
  const effectiveSuccessFee = isSlotOnly ? activeTier.successAmount : isDossierOnly ? 0 : (pricing?.successFee ?? 0);
  const effectiveTotal = isSlotOnly ? activeTier.total : isDossierOnly ? (pricing?.engagementFee ?? 0) : (pricing?.total ?? 0);

  const onSubmit = async (data: FormValues) => {
    setIsPending(true);
    try {
      const id = await createApplication({
        destination: data.destination,
        visaType: data.visaType,
        applicantName: data.applicantName,
        passportNumber: data.passportNumber,
        travelDate: data.travelDate,
        returnDate: data.returnDate || undefined,
        purpose: data.purpose,
        notes: data.notes || undefined,
        servicePackage: selectedPackage,
        slotUrgencyTier: isSlotOnly ? selectedUrgencyTier : undefined,
        slotBookingRefs: isSlotOnly ? {
          ds160Confirmation: slotRefs.ds160Confirmation.trim() || undefined,
          mrvReceiptNumber: slotRefs.mrvReceiptNumber.trim() || undefined,
          sevisId: slotRefs.sevisId.trim() || undefined,
          petitionReceiptNumber: slotRefs.petitionReceiptNumber.trim() || undefined,
          petitionerName: slotRefs.petitionerName.trim() || undefined,
          vfsRefNumber: slotRefs.vfsRefNumber.trim() || undefined,
          vowintAppId: slotRefs.vowintAppId.trim() || undefined,
        } : undefined,
        cevVisaClass: isSchengen ? cevVisaClass : undefined,
        cevApplicantAgeCategory: isSchengen ? cevApplicantAgeCategory : undefined,
        cevTargetCountry: isSchengen ? cevTargetCountry : undefined,
        userWhatsapp: userWhatsapp.trim() || undefined,
      });
      toast({ title: "Dossier créé !", description: "Réglez les frais d'engagement pour démarrer le traitement." });
      setLocation(`/dashboard/applications/${id}/payment`);
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible de créer le dossier." });
    } finally {
      setIsPending(false);
    }
  };

  const nextStep = async () => {
    let fieldsToValidate: (keyof FormValues)[] = [];
    if (step === 1) fieldsToValidate = ["destination", "visaType"];
    if (step === 3) fieldsToValidate = ["applicantName", "passportNumber", "travelDate", "purpose"];
    const isValid = await form.trigger(fieldsToValidate);
    if (isValid) setStep(step + 1);
  };

  const STEP_LABELS = [
    { label: "Destination & Visa", icon: MapPin },
    { label: "Package de service", icon: Package },
    { label: "Voyageur", icon: Plane },
    { label: "Tarif & Confirmation", icon: CreditCard },
  ];

  const TOTAL_STEPS = 4;

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Nouveau Dossier</h1>
        <p className="text-muted-foreground mt-1">Étape {step} sur {TOTAL_STEPS}</p>
      </div>

      <div className="flex gap-2">
        {STEP_LABELS.map((s, i) => {
          const Icon = s.icon;
          const active = i + 1 === step;
          const done = i + 1 < step;
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1.5">
              <div
                className={`w-full h-1.5 rounded-full transition-colors ${done || active ? "bg-secondary" : "bg-slate-200"}`}
              />
              <div className="hidden sm:flex items-center gap-1 text-xs font-medium">
                <Icon className={`w-3 h-3 ${active ? "text-secondary" : done ? "text-primary" : "text-slate-400"}`} />
                <span className={active ? "text-secondary" : done ? "text-primary" : "text-slate-400"}>{s.label}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-2xl border border-border shadow-sm p-6 sm:p-8">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">

            {/* STEP 1 — Destination */}
            <div className={step === 1 ? "block space-y-6" : "hidden"}>
              <h2 className="text-xl font-bold text-primary mb-4 flex items-center gap-2">
                <MapPin className="w-5 h-5 text-secondary" /> Choix de la destination
              </h2>
              <FormField
                control={form.control}
                name="destination"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Où souhaitez-vous aller ?</FormLabel>
                    <FormControl>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-2">
                        {DESTINATIONS.map((dest) => (
                          <div
                            key={dest.id}
                            onClick={() => {
                              field.onChange(dest.id);
                              form.setValue("visaType", "");
                              const pkgs = getAvailablePackages(dest.id);
                              if (!pkgs.includes(selectedPackage)) setSelectedPackage("full_service");
                            }}
                            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                              field.value === dest.id
                                ? "border-secondary bg-orange-50/50"
                                : "border-border hover:border-primary/20"
                            }`}
                          >
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-primary">{dest.name}</span>
                              {dest.processType === "evisa" && (
                                <span className="text-[10px] bg-green-100 text-green-700 font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide">E-Visa</span>
                              )}
                              {dest.processType === "appointment" && (
                                <span className="text-[10px] bg-blue-100 text-blue-700 font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide">Consulaire</span>
                              )}
                              {dest.processType === "hybrid" && (
                                <span className="text-[10px] bg-amber-100 text-amber-700 font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide">E-Visa / VFS</span>
                              )}
                            </div>
                            <div className="text-sm text-muted-foreground mt-1">{dest.desc}</div>
                            {VISA_PRICING[dest.id as keyof typeof VISA_PRICING] && (
                              <div className="mt-2 text-xs text-primary/70 font-medium">
                                Engagement :{" "}
                                {formatCurrency(VISA_PRICING[dest.id as keyof typeof VISA_PRICING].engagementFee)}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {selectedDest && (
                <FormField
                  control={form.control}
                  name="visaType"
                  render={({ field }) => (
                    <FormItem className="animate-in fade-in slide-in-from-top-4">
                      <FormLabel>Type de Visa</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="h-12">
                            <SelectValue placeholder="Sélectionnez le type de visa..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(VISA_PRICING[selectedDest]?.visaTypes as readonly string[] ?? []).map((type) => (
                            <SelectItem key={type} value={type}>{type}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {/* CEV / Schengen — Sélecteurs pays cible + tranche d'âge + info frais consulaires */}
              {isSchengen && selectedVisaType && (
                <div className="animate-in fade-in slide-in-from-top-4 space-y-4 bg-blue-50 border border-blue-200 rounded-xl p-5">
                  <div>
                    <h3 className="text-sm font-bold text-primary flex items-center gap-2 mb-1">
                      🇪🇺 Informations Schengen / CEV
                    </h3>
                    <p className="text-xs text-muted-foreground">Ces informations permettent de calculer les frais consulaires CEV que vous paierez au guichet le jour du rendez-vous.</p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-primary">Pays de destination Schengen</label>
                      <select
                        value={cevTargetCountry}
                        onChange={(e) => setCevTargetCountry(e.target.value)}
                        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        {CEV_COUNTRIES.map((c) => (
                          <option key={c.code} value={c.code}>{c.label}</option>
                        ))}
                      </select>
                      <p className="text-[10px] text-muted-foreground">Le CEV Kinshasa traite 17 pays Schengen depuis un guichet unique</p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-primary">Tranche d'âge du demandeur</label>
                      <select
                        value={cevApplicantAgeCategory}
                        onChange={(e) => setCevApplicantAgeCategory(e.target.value as typeof cevApplicantAgeCategory)}
                        className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                      >
                        <option value="adult">Adulte (12 ans et plus)</option>
                        <option value="child_6_12">Enfant (6 à 12 ans) — 45 €</option>
                        <option value="child_under_6">Enfant de moins de 6 ans — Gratuit</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center justify-between bg-white rounded-lg px-4 py-3 border border-blue-100">
                    <div>
                      <p className="text-xs font-semibold text-primary">Frais consulaires CEV estimés</p>
                      <p className="text-[10px] text-muted-foreground">Payés en € par carte bancaire directement au guichet CEV (non inclus dans les frais Joventy)</p>
                    </div>
                    <span className="text-lg font-bold text-blue-700">{cevConsulaireFee}</span>
                  </div>
                  {cevVisaClass === "D" && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5 text-xs text-amber-800">
                      <span className="font-bold">Visa D :</span>
                      <span>En plus des 180 €, une redevance de l'Office des Étrangers belge doit être payée sur un compte en Belgique <strong>avant</strong> le RDV. Joventy peut vous assister dans cette démarche.</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* STEP 2 — Package de service */}
            <div className={step === 2 ? "block space-y-6" : "hidden"}>
              <h2 className="text-xl font-bold text-primary mb-1 flex items-center gap-2">
                <Package className="w-5 h-5 text-secondary" /> Choisissez votre package
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Sélectionnez le niveau de service qui correspond à votre situation.
              </p>
              {isTurkeyEvisa && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                  <span className="font-semibold">e-Visa Turquie :</span>
                  <span>Ce visa est traité entièrement en ligne — le package "Créneau VFS" n'est pas applicable.</span>
                </div>
              )}
              <div className="space-y-4">
                {availablePackages.map((pkgKey) => {
                  const pkgInfo = getPackageInfo(pkgKey, selectedDest, selectedVisaType, pricing);
                  const isSelected = selectedPackage === pkgKey;
                  const isRecommended = pkgKey === "full_service";
                  return (
                    <div
                      key={pkgKey}
                      onClick={() => setSelectedPackage(pkgKey)}
                      className={`relative p-5 rounded-xl border-2 cursor-pointer transition-all ${
                        isSelected
                          ? "border-secondary bg-orange-50/60 shadow-sm"
                          : "border-border hover:border-primary/30 bg-white"
                      }`}
                    >
                      {isRecommended && (
                        <span className="absolute -top-3 left-4 bg-secondary text-primary text-[10px] font-bold uppercase px-2.5 py-0.5 rounded-full tracking-wide">
                          Recommandé
                        </span>
                      )}
                      <div className="flex items-start gap-4">
                        {(() => { const Icon = PACKAGE_ICONS[pkgKey] ?? Star; return <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-primary/10"><Icon className="w-5 h-5 text-primary" /></div>; })()}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-bold text-primary text-base">{pkgInfo.label}</p>
                            {pkgKey === "slot_only" && (
                              <span className="text-[10px] bg-purple-100 text-purple-700 font-semibold px-2 py-0.5 rounded-full uppercase">
                                {pkgInfo.tagline}
                              </span>
                            )}
                            {pkgKey === "dossier_only" && (
                              <span className="text-[10px] bg-blue-100 text-blue-700 font-semibold px-2 py-0.5 rounded-full uppercase">
                                {pkgInfo.tagline}
                              </span>
                            )}
                            {isEvisaFlow && pkgKey === "full_service" && (
                              <span className="text-[10px] bg-green-100 text-green-700 font-semibold px-2 py-0.5 rounded-full uppercase">
                                100 % en ligne
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground leading-relaxed">{pkgInfo.description}</p>
                          {pkgInfo.slotNote && (
                            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-2 font-medium">
                              {pkgInfo.slotNote}
                            </p>
                          )}
                          {pricing && (
                            <div className="mt-3 flex flex-wrap gap-3">
                              {pkgKey === "slot_only" ? (
                                <>
                                  <div className="text-xs bg-purple-100 text-purple-700 rounded-lg px-3 py-1.5 font-semibold">
                                    Dépôt de {formatCurrency(SLOT_URGENCY_TIERS.standard.depositAmount)} à {formatCurrency(SLOT_URGENCY_TIERS.tres_urgent.depositAmount)}
                                  </div>
                                  <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                    <span className="text-slate-500">Total : </span>
                                    <span className="font-bold text-primary">{formatCurrency(SLOT_URGENCY_TIERS.standard.total)} – {formatCurrency(SLOT_URGENCY_TIERS.tres_urgent.total)}+</span>
                                  </div>
                                </>
                              ) : pkgKey === "dossier_only" ? (
                                <>
                                  <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                    <span className="text-slate-500">Tarif fixe : </span>
                                    <span className="font-bold text-primary">{formatCurrency(pricing.engagementFee)}</span>
                                  </div>
                                  <div className="text-xs bg-green-100 text-green-700 rounded-lg px-3 py-1.5 font-semibold">
                                    Pas de prime de succès
                                  </div>
                                </>
                              ) : (
                                <>
                                  <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                    <span className="text-slate-500">Engagement : </span>
                                    <span className="font-bold text-primary">{formatCurrency(pricing.engagementFee)}</span>
                                  </div>
                                  <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                    <span className="text-slate-500">Prime de succès : </span>
                                    <span className="font-bold text-primary">{formatCurrency(pricing.successFee)}</span>
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                        <div
                          className={`w-5 h-5 rounded-full border-2 flex-shrink-0 mt-1 transition-all ${
                            isSelected ? "border-secondary bg-secondary" : "border-slate-300"
                          }`}
                        >
                          {isSelected && (
                            <div className="w-full h-full flex items-center justify-center">
                              <div className="w-2 h-2 rounded-full bg-white" />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Urgency tier selector — slot_only only */}
              {isSlotOnly && (
                <div className="mt-6 animate-in fade-in slide-in-from-top-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Calendar className="w-4 h-4 text-secondary" />
                    <h3 className="text-sm font-bold text-primary">Urgence du rendez-vous souhaité</h3>
                  </div>
                  <p className="text-xs text-muted-foreground mb-4">
                    La prime varie selon la rapidité requise : plus la date est proche, plus elle est élevée.
                    Elle est divisée en deux versements — un dépôt maintenant, le solde lorsque le créneau est obtenu.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {(Object.keys(SLOT_URGENCY_TIERS) as SlotUrgencyTier[]).map((tierKey) => {
                      const tier = SLOT_URGENCY_TIERS[tierKey];
                      const isSelected = selectedUrgencyTier === tierKey;
                      return (
                        <div
                          key={tierKey}
                          onClick={() => setSelectedUrgencyTier(tierKey)}
                          className={`relative p-4 rounded-xl border-2 cursor-pointer transition-all ${
                            isSelected
                              ? "border-secondary bg-orange-50/60 shadow-sm"
                              : "border-border hover:border-primary/20 bg-white"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-bold text-primary text-sm">{tier.label}</span>
                                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full uppercase tracking-wide ${
                                  tierKey === "tres_urgent" ? "bg-red-100 text-red-700" :
                                  tierKey === "urgent" ? "bg-orange-100 text-orange-700" :
                                  tierKey === "prioritaire" ? "bg-amber-100 text-amber-700" :
                                  "bg-slate-100 text-slate-600"
                                }`}>{tier.tagline}</span>
                              </div>
                              <p className="text-xs text-muted-foreground mb-2">{tier.desc}</p>
                              <div className="flex flex-wrap gap-2">
                                <span className="text-xs bg-slate-100 rounded-lg px-2.5 py-1">
                                  <span className="text-slate-500">Dépôt : </span>
                                  <span className="font-bold text-primary">{formatCurrency(tier.depositAmount)}</span>
                                </span>
                                <span className="text-xs bg-slate-100 rounded-lg px-2.5 py-1">
                                  <span className="text-slate-500">Solde : </span>
                                  <span className="font-bold text-primary">{formatCurrency(tier.successAmount)}</span>
                                </span>
                                <span className="text-xs bg-primary/10 text-primary rounded-lg px-2.5 py-1 font-semibold">
                                  Total : {formatCurrency(tier.total)}
                                  {tierKey === "tres_urgent" && "+"}
                                </span>
                              </div>
                            </div>
                            <div className={`w-4 h-4 rounded-full border-2 flex-shrink-0 mt-1 transition-all ${
                              isSelected ? "border-secondary bg-secondary" : "border-slate-300"
                            }`}>
                              {isSelected && <div className="w-full h-full flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-white" /></div>}
                            </div>
                          </div>
                          {tier.variableNote && (
                            <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-2 py-1 mt-2">{tier.variableNote}</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* STEP 3 — Traveller info */}
            <div className={step === 3 ? "block space-y-6" : "hidden"}>
              <h2 className="text-xl font-bold text-primary mb-4 flex items-center gap-2">
                <Plane className="w-5 h-5 text-secondary" /> Informations du voyageur
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <FormField control={form.control} name="applicantName" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nom complet (comme sur le passeport)</FormLabel>
                    <FormControl><Input placeholder="Jean Dupont" {...field} className="h-12" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="passportNumber" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Numéro de passeport</FormLabel>
                    <FormControl><Input placeholder="OBXXXXXX" {...field} className="h-12" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="travelDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date de départ prévue</FormLabel>
                    <FormControl><Input type="date" {...field} className="h-12" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
                <FormField control={form.control} name="returnDate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date de retour (Optionnel)</FormLabel>
                    <FormControl><Input type="date" {...field} className="h-12" /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>
              <FormField control={form.control} name="purpose" render={({ field }) => (
                <FormItem>
                  <FormLabel>Motif détaillé du voyage</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Expliquez brièvement pourquoi vous souhaitez voyager..." {...field} rows={4} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />

              {/* WhatsApp */}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium leading-none flex items-center gap-2">
                  <svg className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.119.553 4.107 1.521 5.831L0 24l6.335-1.521A11.93 11.93 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.013-1.374l-.36-.214-3.728.977.994-3.637-.234-.374A9.818 9.818 0 1112 21.818z"/></svg>
                  Numéro WhatsApp <span className="text-muted-foreground font-normal">(Optionnel)</span>
                </label>
                <Input
                  placeholder="+243 8X XXX XXXX"
                  value={userWhatsapp}
                  onChange={(e) => setUserWhatsapp(e.target.value)}
                  className="h-12"
                />
                <p className="text-[11px] text-muted-foreground">
                  Si renseigné, vous recevrez une alerte WhatsApp immédiate dès qu'un créneau est capturé.
                </p>
              </div>

              {/* Booking refs — USA slot_only */}
              {showSlotRefsUSA && (
                <div className="mt-2 space-y-4 border border-blue-200 bg-blue-50/60 rounded-xl p-5 animate-in fade-in">
                  <div>
                    <h3 className="text-sm font-bold text-primary flex items-center gap-2 mb-0.5">
                      <FileText className="w-4 h-4 text-secondary" /> Références USTravelDocs (USA)
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Vous devez avoir complété le DS-160 avant de soumettre.
                      Ces références permettent à Joventy de réserver le créneau en votre nom.
                      Le reçu MRV peut être renseigné plus tard par vous ou par notre équipe.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-primary">
                        N° de confirmation DS-160 <span className="text-red-500">*</span>
                      </label>
                      <Input
                        placeholder="Ex : AA00XXXXX"
                        className="h-10 text-sm"
                        value={slotRefs.ds160Confirmation}
                        onChange={(e) => updateRef("ds160Confirmation", e.target.value)}
                      />
                      <p className="text-[10px] text-muted-foreground">Le code barcode imprimé sur la page de confirmation DS-160 (ceac.state.gov)</p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-primary">
                        N° de reçu MRV (frais visa)
                        <span className="ml-1 text-xs font-normal text-muted-foreground">(optionnel)</span>
                      </label>
                      <Input
                        placeholder="Ex : CGCD25XXXXXXXXXX"
                        className="h-10 text-sm"
                        value={slotRefs.mrvReceiptNumber}
                        onChange={(e) => updateRef("mrvReceiptNumber", e.target.value)}
                      />
                      <p className="text-[10px] text-muted-foreground">Reçu généré après paiement des frais MRV (265 $). Si non disponible, notre équipe peut le compléter ultérieurement.</p>
                    </div>
                    {isStudentExchange && (
                      <div className="space-y-1.5 sm:col-span-2">
                        <label className="text-xs font-semibold text-primary">
                          SEVIS ID <span className="text-red-500">*</span>
                          <span className="ml-1 text-xs font-normal text-muted-foreground">(Visa F-1 / J-1 / M-1)</span>
                        </label>
                        <Input
                          placeholder="Ex : N0000000000"
                          className="h-10 text-sm"
                          value={slotRefs.sevisId}
                          onChange={(e) => updateRef("sevisId", e.target.value)}
                        />
                        <p className="text-[10px] text-muted-foreground">Numéro imprimé sur votre I-20 (F/M) ou DS-2019 (J), format N + 10 chiffres</p>
                      </div>
                    )}
                    {isPetitionBased && (
                      <>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-primary">
                            N° de reçu USCIS (I-797) <span className="text-red-500">*</span>
                            <span className="ml-1 text-xs font-normal text-muted-foreground">(K-1 / H-1B / L-1 / O / P / R)</span>
                          </label>
                          <Input
                            placeholder="Ex : IOE0000000000 ou WAC2500000000"
                            className="h-10 text-sm"
                            value={slotRefs.petitionReceiptNumber}
                            onChange={(e) => updateRef("petitionReceiptNumber", e.target.value)}
                          />
                          <p className="text-[10px] text-muted-foreground">13 caractères — sur l'avis d'approbation I-797 du pétitionnaire</p>
                        </div>
                        <div className="space-y-1.5">
                          <label className="text-xs font-semibold text-primary">
                            Nom du pétitionnaire <span className="text-red-500">*</span>
                          </label>
                          <Input
                            placeholder="Nom de l'employeur ou du partenaire US"
                            className="h-10 text-sm"
                            value={slotRefs.petitionerName}
                            onChange={(e) => updateRef("petitionerName", e.target.value)}
                          />
                          <p className="text-[10px] text-muted-foreground">Exactement comme sur l'avis I-797</p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}

              {/* Booking refs — Turkey slot_only */}
              {showSlotRefsTurkey && (
                <div className="mt-2 space-y-3 border border-red-200 bg-red-50/40 rounded-xl p-5 animate-in fade-in">
                  <div>
                    <h3 className="text-sm font-bold text-primary flex items-center gap-2 mb-0.5">
                      <FileText className="w-4 h-4 text-secondary" /> Références VFS Global Turquie
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Le centre VFS Global Kinshasa utilise vos informations de passeport (déjà renseignées ci-dessus).
                      Si vous avez déjà un numéro de référence VFS, indiquez-le ci-dessous.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-primary">
                      N° de référence VFS (optionnel)
                    </label>
                    <Input
                      placeholder="Ex : VFS-CD-XXXXXXX"
                      className="h-10 text-sm"
                      value={slotRefs.vfsRefNumber}
                      onChange={(e) => updateRef("vfsRefNumber", e.target.value)}
                    />
                    <p className="text-[10px] text-muted-foreground">Si vous avez déjà créé un compte VFS Global, indiquez votre référence</p>
                  </div>
                </div>
              )}

              {/* Booking refs — Schengen slot_only */}
              {showSlotRefsSchengen && (
                <div className="mt-2 space-y-4 border border-blue-200 bg-blue-50/60 rounded-xl p-5 animate-in fade-in">
                  <div>
                    <h3 className="text-sm font-bold text-primary flex items-center gap-2 mb-0.5">
                      <FileText className="w-4 h-4 text-secondary" /> Référence VOWINT (CEV Schengen)
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      Si vous avez déjà un dossier ouvert sur le portail VOWINT (vowint.eu), indiquez votre numéro de dossier.
                      Notre équipe utilisera ces informations pour surveiller et capturer votre créneau CEV.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-primary">
                      N° de dossier VOWINT <span className="ml-1 text-xs font-normal text-muted-foreground">(optionnel)</span>
                    </label>
                    <Input
                      placeholder="Ex : APP-2024-001234"
                      className="h-10 text-sm"
                      value={slotRefs.vowintAppId}
                      onChange={(e) => updateRef("vowintAppId", e.target.value)}
                    />
                    <p className="text-[10px] text-muted-foreground">Numéro visible sur votre confirmation VOWINT. Si vous n'avez pas encore de dossier, Joventy vous guidera pour le créer.</p>
                  </div>
                </div>
              )}
            </div>

            {/* STEP 4 — Pricing + Confirmation */}
            <div className={step === 4 ? "block space-y-6" : "hidden"}>
              <h2 className="text-xl font-bold text-primary mb-4 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-secondary" /> Tarif & Confirmation
              </h2>

              {/* Package reminder badge */}
              {pricing && (() => {
                const info = getPackageInfo(selectedPackage, selectedDest, selectedVisaType, pricing);
                return (
                  <div className="flex items-start gap-3 bg-orange-50 border border-orange-200 rounded-xl px-4 py-3 mb-2">
                    {(() => { const Icon = PACKAGE_ICONS[selectedPackage] ?? Star; return <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-primary/10"><Icon className="w-4 h-4 text-primary" /></div>; })()}
                    <div>
                      <p className="text-sm font-bold text-primary">{info.label}</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">{info.description}</p>
                    </div>
                  </div>
                );
              })()}

              {/* Pricing table */}
              {pricing && (
                <div className="bg-primary rounded-xl p-6 text-white mb-2">
                  <p className="text-secondary text-xs uppercase font-semibold tracking-wide mb-3">
                    {isSlotOnly ? `Structure tarifaire — ${activeTier.label}` : "Structure tarifaire Joventy"}
                  </p>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center pb-3 border-b border-white/10">
                      <div>
                        <p className="font-semibold">
                          {isSlotOnly ? "Versement de réservation (dépôt)" : "Frais d'engagement"}
                        </p>
                        <p className="text-xs text-slate-300">
                          {isSlotOnly
                            ? "À payer maintenant pour confirmer votre demande"
                            : "À payer maintenant pour activer le dossier"}
                        </p>
                      </div>
                      <span className="text-xl font-bold text-secondary">{formatCurrency(effectiveEngagementFee)}</span>
                    </div>
                    {isDossierOnly ? (
                      <div className="flex justify-between items-center text-green-300">
                        <div>
                          <p className="font-semibold">Prime de succès</p>
                          <p className="text-xs text-green-400">Non applicable — tarif fixe pour ce package</p>
                        </div>
                        <span className="text-xl font-bold line-through opacity-50">{formatCurrency(pricing.successFee)}</span>
                      </div>
                    ) : (
                      <div className="flex justify-between items-center">
                        <div>
                          <p className="font-semibold">
                            {isSlotOnly ? "Solde de la prime (créneau obtenu)" : "Prime de succès"}
                          </p>
                          <p className="text-xs text-slate-300">
                            {isSlotOnly
                              ? "À régler uniquement si Joventy obtient votre créneau"
                              : pricing.successModel === "evisa"
                                ? "Due uniquement si votre visa est obtenu"
                                : "Due uniquement si votre créneau de RDV est obtenu"}
                          </p>
                        </div>
                        <span className="text-xl font-bold text-white">{formatCurrency(effectiveSuccessFee)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-3 border-t border-white/10">
                      <p className="font-bold text-lg">
                        {isDossierOnly ? "Total (tarif fixe)" : isSlotOnly ? "Prime totale" : "Total programme"}
                      </p>
                      <span className="text-2xl font-bold text-secondary">
                        {formatCurrency(effectiveTotal)}{activeTier.variableNote && isSlotOnly ? "+" : ""}
                      </span>
                    </div>
                    {isSlotOnly && activeTier.variableNote && (
                      <p className="text-xs text-amber-300 bg-white/5 rounded-lg px-3 py-2">{activeTier.variableNote}</p>
                    )}
                  </div>
                </div>
              )}

              {/* CEV — frais consulaires séparés (informatif, Step 4) */}
              {isSchengen && cevConsulaireFee && (
                <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
                  <span className="text-xl mt-0.5">🇪🇺</span>
                  <div className="flex-1">
                    <p className="text-sm font-bold text-primary">Frais consulaires CEV non inclus</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      En plus des frais Joventy ci-dessus, vous paierez <strong className="text-blue-700">{cevConsulaireFee}</strong> directement au guichet CEV le jour de votre rendez-vous, par carte bancaire.
                    </p>
                    {cevVisaClass === "D" && (
                      <p className="text-xs text-amber-700 mt-1 font-medium">
                        Visa D : une redevance supplémentaire de l'Office des Étrangers est également requise avant le RDV (montant variable, payable sur un compte belge).
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Documents needed */}
              {pricing && (
                <div className="bg-slate-50 border border-border rounded-xl p-4">
                  <h3 className="text-sm font-bold text-primary mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4 text-secondary" /> Documents requis pour {pricing.label}
                  </h3>
                  <ul className="space-y-1">
                    {pricing.requiredDocuments.map((doc) => (
                      <li key={doc.key} className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className={`w-3.5 h-3.5 ${doc.required ? "text-primary" : "text-slate-400"}`} />
                        <span className={doc.required ? "text-slate-700" : "text-slate-500"}>
                          {doc.label}{!doc.required && " (optionnel)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Summary recap */}
              <div className="bg-slate-50 p-4 rounded-xl border border-border text-sm space-y-1">
                <p><strong>Destination :</strong> {selectedDest?.toUpperCase()}</p>
                <p><strong>Visa :</strong> {form.watch("visaType")}</p>
                <p><strong>Package :</strong> {SERVICE_PACKAGES[selectedPackage].label}</p>
                {isSlotOnly && (
                  <p><strong>Urgence :</strong> {activeTier.label} — {activeTier.tagline}</p>
                )}
                <p><strong>Demandeur :</strong> {form.watch("applicantName")}</p>
                <p><strong>Passeport :</strong> {form.watch("passportNumber")}</p>
              </div>

              <FormField control={form.control} name="notes" render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes supplémentaires (Optionnel)</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Des détails importants à nous communiquer ?" {...field} rows={3} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )} />
            </div>

            <div className="flex items-center justify-between pt-6 border-t border-border">
              {step > 1 ? (
                <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                  <ArrowLeft className="w-4 h-4 mr-2" /> Retour
                </Button>
              ) : <div />}

              {step < TOTAL_STEPS ? (
                <Button type="button" onClick={nextStep} className="bg-primary px-8">
                  Suivant <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button type="submit" disabled={isPending} className="bg-secondary text-primary hover:bg-orange-500 font-bold px-8">
                  {isPending ? "Création..." : "Créer le dossier et payer"}
                </Button>
              )}
            </div>
          </form>
        </Form>
      </div>
    </div>
  );
}
