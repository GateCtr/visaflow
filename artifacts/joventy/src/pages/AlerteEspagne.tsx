import { useState, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Navbar } from "@/components/layout/Navbar";
import {
  CheckCircle2,
  Upload,
  Copy,
  Bell,
  Clock,
  Users,
  Lightbulb,
  ShieldCheck,
  Smartphone,
  ChevronRight,
  Star,
} from "lucide-react";

const MPESA_NUMBER = "0820 344 541";
const AIRTEL_NUMBER = "0990 775 880";
const ORANGE_NUMBER = "+243 840 808 122";
const PRICE_USD = 10;

const BENEFITS = [
  {
    icon: Bell,
    title: "Alertes en temps réel",
    desc: "Jour J et plage horaire exacte publiés dès qu'un créneau apparaît (ex : demain 10h00–10h30).",
  },
  {
    icon: Lightbulb,
    title: "Conseils d'experts",
    desc: "Techniques testées pour capturer un créneau sur citaconsular.es en moins de 30 secondes.",
  },
  {
    icon: Clock,
    title: "Accès à vie",
    desc: "Un seul paiement de 10 USD, aucun abonnement. Vous restez dans le groupe pour tous vos futurs rendez-vous.",
  },
  {
    icon: Users,
    title: "Communauté active",
    desc: "Rejoignez des centaines de membres de Kinshasa qui s'entraident pour décrocher leurs créneaux Espagne.",
  },
];

const STEPS = [
  { n: "1", label: "Effectuez le paiement de 10 USD via Mobile Money" },
  { n: "2", label: "Prenez une capture d'écran de la confirmation de paiement" },
  { n: "3", label: "Remplissez le formulaire et uploadez votre capture" },
  { n: "4", label: "L'admin confirme votre paiement (sous 24h)" },
  { n: "5", label: "Vous recevez le lien du groupe + instructions par email" },
];

export default function AlerteEspagne() {
  const { toast } = useToast();
  const generateUploadUrl = useMutation(api.spainAlert.generateUploadUrl);
  const submitOrder = useMutation(api.spainAlert.submitOrder);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<"mpesa" | "airtel" | "orange">("mpesa");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const paymentNumber =
    selectedMethod === "mpesa" ? MPESA_NUMBER
    : selectedMethod === "airtel" ? AIRTEL_NUMBER
    : ORANGE_NUMBER;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "Copié !", description: text });
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f);
    if (f.type.startsWith("image/")) {
      setPreview(URL.createObjectURL(f));
    } else {
      setPreview(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !name.trim() || !email.trim()) {
      toast({ variant: "destructive", title: "Champs requis", description: "Remplissez votre nom, email et uploadez votre capture." });
      return;
    }
    setIsSubmitting(true);
    try {
      const uploadUrl = await generateUploadUrl();
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error(`Upload échoué (${res.status})`);
      const { storageId } = await res.json();
      await submitOrder({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        proofStorageId: storageId as string,
      });
      setDone(true);
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible d'envoyer. Réessayez." });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <Navbar />

      {/* HERO */}
      <section className="relative bg-gradient-to-br from-primary via-blue-800 to-primary/90 pt-36 pb-24 px-4 overflow-hidden">
        <div className="absolute inset-0 opacity-10" style={{
          backgroundImage: "url(\"data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.4'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E\")",
        }} />
        <div className="relative max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 bg-white/10 backdrop-blur border border-white/20 text-white text-sm font-semibold px-4 py-2 rounded-full mb-6">
            <Star className="w-4 h-4 text-yellow-300 fill-yellow-300" />
            Accès à vie · Paiement unique
          </div>
          <h1 className="text-4xl md:text-5xl font-black text-white leading-tight tracking-tight mb-6">
            🇪🇸 Alertes Créneaux<br />
            <span className="text-secondary">Rendez-vous Espagne</span>
          </h1>
          <p className="text-xl text-blue-100 leading-relaxed mb-8 max-w-2xl mx-auto">
            Vous voulez prendre vous-même votre rendez-vous à l'ambassade d'Espagne&nbsp;?
            Rejoignez notre groupe privé et soyez <strong className="text-white">alerté dès qu'un créneau apparaît</strong> sur citaconsular.es — avant tout le monde.
          </p>
          <div className="inline-flex items-baseline gap-3 bg-white/10 backdrop-blur border border-white/20 px-8 py-4 rounded-2xl">
            <span className="text-5xl font-black text-white">{PRICE_USD} USD</span>
            <span className="text-blue-200 text-lg">/ accès à vie</span>
          </div>
        </div>
      </section>

      {/* BENEFITS */}
      <section className="py-20 px-4 bg-slate-50">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-black text-primary text-center mb-3">Ce que vous obtenez</h2>
          <p className="text-center text-muted-foreground mb-12">Dans ce groupe WhatsApp privé, vous recevrez :</p>
          <div className="grid sm:grid-cols-2 gap-6">
            {BENEFITS.map((b) => (
              <div key={b.title} className="bg-white rounded-2xl border border-border p-6 flex gap-4 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <b.icon className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-bold text-primary mb-1">{b.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{b.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="py-20 px-4">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-3xl font-black text-primary text-center mb-3">Comment ça marche ?</h2>
          <p className="text-center text-muted-foreground mb-12">5 étapes simples pour rejoindre le groupe.</p>
          <div className="space-y-4">
            {STEPS.map((step) => (
              <div key={step.n} className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary text-white font-black text-lg flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary/30">
                  {step.n}
                </div>
                <p className="text-slate-700 font-medium">{step.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PAYMENT + FORM */}
      <section id="payer" className="py-20 px-4 bg-slate-50">
        <div className="max-w-xl mx-auto">
          <h2 className="text-3xl font-black text-primary text-center mb-3">Rejoindre le groupe</h2>
          <p className="text-center text-muted-foreground mb-10">Payez 10 USD via Mobile Money, uploadez votre reçu.</p>

          {done ? (
            <div className="bg-white rounded-2xl border border-border shadow-sm p-10 text-center animate-in fade-in duration-500">
              <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-10 h-10 text-green-600" />
              </div>
              <h3 className="text-2xl font-bold text-primary mb-3">Reçu envoyé !</h3>
              <p className="text-muted-foreground leading-relaxed mb-4">
                Votre demande est en cours de traitement. Notre équipe vérifie votre paiement et vous enverra le lien du groupe WhatsApp par email <strong>dans les 24 heures</strong>.
              </p>
              <div className="flex items-center gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-3">
                <Clock className="w-4 h-4 flex-shrink-0" />
                Vérifiez votre boîte email (y compris les spams).
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
              {/* STEP 1: Choose payment method */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">1</div>
                  <h3 className="font-bold text-primary">Choisissez votre opérateur Mobile Money</h3>
                </div>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  {(["mpesa", "airtel", "orange"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setSelectedMethod(m)}
                      className={`py-3 rounded-xl border-2 font-semibold text-sm transition-all ${
                        selectedMethod === m
                          ? "border-primary bg-primary/5 text-primary"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {m === "mpesa" ? "M-Pesa" : m === "airtel" ? "Airtel Money" : "Orange Money"}
                    </button>
                  ))}
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-sm text-blue-700 mb-1 font-medium">
                    Envoyez <strong>10 USD</strong> au numéro suivant :
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xl font-black text-primary">{paymentNumber}</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(paymentNumber)}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-primary transition-colors"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copier
                    </button>
                  </div>
                  <p className="text-xs text-blue-600 mt-1">Référence/motif : <strong>ALERTE ESPAGNE</strong></p>
                </div>
              </div>

              {/* STEP 2: Personal info */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">2</div>
                  <h3 className="font-bold text-primary">Vos informations</h3>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Nom complet <span className="text-red-500">*</span></label>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Ex : Jean Mukendi"
                      required
                      className="w-full border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Adresse email <span className="text-red-500">*</span></label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="votre@email.com"
                      required
                      className="w-full border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                    />
                    <p className="text-xs text-muted-foreground mt-1">Le lien du groupe vous sera envoyé à cet email.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Téléphone WhatsApp <span className="text-muted-foreground text-xs">(optionnel)</span></label>
                    <div className="relative">
                      <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input
                        type="tel"
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+243 8XX XXX XXX"
                        className="w-full border border-border rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* STEP 3: Upload proof */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center">3</div>
                  <h3 className="font-bold text-primary">Uploadez votre capture de paiement</h3>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*,application/pdf"
                  className="hidden"
                  onChange={handleFileChange}
                />
                {file ? (
                  <div className="space-y-3">
                    {preview && (
                      <img src={preview} alt="Aperçu" className="w-full max-h-48 object-contain rounded-xl border border-border" />
                    )}
                    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl p-3">
                      <div className="flex items-center gap-2 text-sm text-green-700">
                        <CheckCircle2 className="w-4 h-4" />
                        <span className="font-medium truncate max-w-[200px]">{file.name}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => { setFile(null); setPreview(null); if (fileRef.current) fileRef.current.value = ""; }}
                        className="text-xs text-slate-500 hover:text-red-500 transition-colors"
                      >
                        Changer
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="w-full border-2 border-dashed border-border rounded-xl p-8 flex flex-col items-center gap-3 hover:border-primary/50 hover:bg-primary/5 transition-all group"
                  >
                    <Upload className="w-8 h-8 text-muted-foreground group-hover:text-primary transition-colors" />
                    <div className="text-center">
                      <p className="font-semibold text-slate-700 group-hover:text-primary transition-colors">Choisir une image</p>
                      <p className="text-xs text-muted-foreground mt-1">PNG, JPG ou PDF · Max 10 Mo</p>
                    </div>
                  </button>
                )}
              </div>

              {/* SUBMIT */}
              <div className="p-6">
                <Button
                  type="submit"
                  disabled={isSubmitting || !file || !name.trim() || !email.trim()}
                  className="w-full h-13 text-base font-bold bg-primary hover:bg-primary/90 text-white shadow-lg shadow-primary/25"
                >
                  {isSubmitting ? (
                    <span className="flex items-center gap-2"><span className="animate-spin">⏳</span> Envoi en cours...</span>
                  ) : (
                    <span className="flex items-center gap-2">Envoyer ma demande <ChevronRight className="w-4 h-4" /></span>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground text-center mt-3">
                  Votre paiement sera vérifié manuellement. Vous recevrez le lien du groupe par email sous 24h.
                </p>
              </div>
            </form>
          )}
        </div>
      </section>

      {/* TRUST */}
      <section className="py-16 px-4 border-t border-border">
        <div className="max-w-3xl mx-auto">
          <div className="grid sm:grid-cols-3 gap-8 text-center">
            {[
              { icon: ShieldCheck, label: "Paiement sécurisé", sub: "Mobile Money vérifiable" },
              { icon: Clock, label: "Réponse sous 24h", sub: "Validation manuelle garantie" },
              { icon: Users, label: "Groupe modéré", sub: "Seuls les membres payants y accèdent" },
            ].map((t) => (
              <div key={t.label} className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                  <t.icon className="w-6 h-6 text-primary" />
                </div>
                <div>
                  <p className="font-bold text-primary">{t.label}</p>
                  <p className="text-sm text-muted-foreground">{t.sub}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <footer className="py-8 px-4 bg-slate-900 text-center">
        <p className="text-slate-400 text-sm">© {new Date().getFullYear()} Joventy · Akollad Groupe · <a href="/confidentialite" className="hover:text-white transition-colors">Confidentialité</a></p>
      </footer>
    </div>
  );
}
