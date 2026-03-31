import React, { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { VISA_PRICING, SERVICE_PACKAGES, getAvailablePackages, type ServicePackage } from "@convex/constants";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, ArrowRight, CheckCircle2, Plane, MapPin, CreditCard, FileText, Package, Star, Calendar, ClipboardList } from "lucide-react";

const schema = z.object({
  destination: z.enum(["usa", "dubai", "turkey", "india"]),
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
  { id: "usa",    name: "États-Unis", desc: "Rendez-vous consulaire — ambassade américaine", processType: "appointment" as const },
  { id: "dubai",  name: "Dubaï",      desc: "E-Visa 100 % en ligne — résultat en 48-72 h", processType: "evisa" as const },
  { id: "turkey", name: "Turquie",    desc: "E-Visa en ligne ou Visa Sticker via VFS Global", processType: "hybrid" as const },
  { id: "india",  name: "Inde",       desc: "E-Visa électronique ou visa régulier (études)", processType: "evisa" as const },
];

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
        slotNote: "Prérequis : DS-160 soumis + frais MRV (185 $) payés.",
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
  const [isPending, setIsPending] = useState(false);

  useEffect(() => {
    if (isTurkeyEvisa && selectedPackage === "slot_only") {
      setSelectedPackage("full_service");
    }
  }, [isTurkeyEvisa, selectedPackage]);

  const effectiveSuccessFee = isDossierOnly ? 0 : (pricing?.successFee ?? 0);
  const effectiveTotal = isDossierOnly ? (pricing?.engagementFee ?? 0) : (pricing?.total ?? 0);

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
                              <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                <span className="text-slate-500">Engagement : </span>
                                <span className="font-bold text-primary">{formatCurrency(pricing.engagementFee)}</span>
                              </div>
                              {pkgKey !== "dossier_only" ? (
                                <div className="text-xs bg-slate-100 rounded-lg px-3 py-1.5">
                                  <span className="text-slate-500">Prime de succès : </span>
                                  <span className="font-bold text-primary">{formatCurrency(pricing.successFee)}</span>
                                </div>
                              ) : (
                                <div className="text-xs bg-green-100 text-green-700 rounded-lg px-3 py-1.5 font-semibold">
                                  Pas de prime de succès — tarif fixe
                                </div>
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
                  <p className="text-secondary text-xs uppercase font-semibold tracking-wide mb-3">Structure tarifaire Joventy</p>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center pb-3 border-b border-white/10">
                      <div>
                        <p className="font-semibold">Frais d'engagement</p>
                        <p className="text-xs text-slate-300">À payer maintenant pour activer le dossier</p>
                      </div>
                      <span className="text-xl font-bold text-secondary">{formatCurrency(pricing.engagementFee)}</span>
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
                          <p className="font-semibold">Prime de succès</p>
                          <p className="text-xs text-slate-300">
                            {pricing.successModel === "evisa"
                              ? "Due uniquement si votre visa est obtenu"
                              : "Due uniquement si votre créneau de RDV est obtenu"}
                          </p>
                        </div>
                        <span className="text-xl font-bold text-white">{formatCurrency(effectiveSuccessFee)}</span>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-3 border-t border-white/10">
                      <p className="font-bold text-lg">{isDossierOnly ? "Total (tarif fixe)" : "Total programme"}</p>
                      <span className="text-2xl font-bold text-secondary">{formatCurrency(effectiveTotal)}</span>
                    </div>
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
