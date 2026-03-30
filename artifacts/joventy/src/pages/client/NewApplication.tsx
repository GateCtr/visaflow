import { useState } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { VISA_PRICING } from "@convex/constants";
import { formatCurrency } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, ArrowRight, CheckCircle2, Plane, MapPin, CreditCard, FileText } from "lucide-react";

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
  { id: "usa", name: "États-Unis 🇺🇸", desc: "Visas non-immigrants et immigrants" },
  { id: "dubai", name: "Dubaï 🇦🇪", desc: "Visas touristiques et résidents" },
  { id: "turkey", name: "Turquie 🇹🇷", desc: "E-Visa et consulaire" },
  { id: "india", name: "Inde 🇮🇳", desc: "Visas électroniques et standards" },
];

export default function NewApplication() {
  const [step, setStep] = useState(1);
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
  const pricing = selectedDest ? VISA_PRICING[selectedDest] : null;
  const [isPending, setIsPending] = useState(false);

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
    if (step === 2) fieldsToValidate = ["applicantName", "passportNumber", "travelDate", "purpose"];
    const isValid = await form.trigger(fieldsToValidate);
    if (isValid) setStep(step + 1);
  };

  const STEP_LABELS = [
    { label: "Destination & Visa", icon: MapPin },
    { label: "Voyageur", icon: Plane },
    { label: "Tarif & Confirmation", icon: CreditCard },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-serif font-bold text-primary">Nouveau Dossier</h1>
        <p className="text-muted-foreground mt-1">Étape {step} sur 3</p>
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
                            onClick={() => { field.onChange(dest.id); form.setValue("visaType", ""); }}
                            className={`p-4 rounded-xl border-2 cursor-pointer transition-all ${
                              field.value === dest.id
                                ? "border-secondary bg-orange-50/50"
                                : "border-border hover:border-primary/20"
                            }`}
                          >
                            <div className="font-bold text-primary">{dest.name}</div>
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

            {/* STEP 2 — Traveller info */}
            <div className={step === 2 ? "block space-y-6" : "hidden"}>
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

            {/* STEP 3 — Pricing + Confirmation */}
            <div className={step === 3 ? "block space-y-6" : "hidden"}>
              <h2 className="text-xl font-bold text-primary mb-4 flex items-center gap-2">
                <CreditCard className="w-5 h-5 text-secondary" /> Tarif & Confirmation
              </h2>

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
                    <div className="flex justify-between items-center">
                      <div>
                        <p className="font-semibold">Prime de succès</p>
                        <p className="text-xs text-slate-300">Due uniquement si votre visa est obtenu</p>
                      </div>
                      <span className="text-xl font-bold text-white">{formatCurrency(pricing.successFee)}</span>
                    </div>
                    <div className="flex justify-between items-center pt-3 border-t border-white/10">
                      <p className="font-bold text-lg">Total programme</p>
                      <span className="text-2xl font-bold text-secondary">{formatCurrency(pricing.total)}</span>
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

              {step < 3 ? (
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
