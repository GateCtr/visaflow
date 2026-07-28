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
  Clock,
  Users,
  Smartphone,
  ChevronRight,
  Zap,
  Lock,
  RefreshCw,
  AlertTriangle,
  MessageCircle,
  Star,
  ArrowDown,
} from "lucide-react";

const MPESA_NUMBER = "0820 344 541";
const AIRTEL_NUMBER = "0990 775 880";
const ORANGE_NUMBER = "+243 840 808 122";
const PRICE_USD = 10;

const BENEFITS = [
  {
    icon: Clock,
    emoji: "🎯",
    title: "Sachez exactement quand chercher — pas en aveugle",
    desc: "Le groupe publie la plage horaire précise dès qu'un créneau est repéré : « demain mardi, surveillez de 10h00 à 10h30 ». Plus de journées entières à rafraîchir un écran pour rien.",
    proof: "Les créneaux sur citaconsular.es durent en moyenne 40 à 90 secondes avant d'être pris.",
  },
  {
    icon: Zap,
    emoji: "⚡",
    title: "La technique exacte pour saisir un créneau en moins de 20 secondes",
    desc: "Checklist pré-recherche, raccourcis de navigation, ordre des clics — nos membres ont testé et affiné chaque étape. La différence entre rater et réussir se joue souvent à 3 clics.",
    proof: "Membres ayant obtenu leur créneau en suivant la méthode du groupe : délai moyen de prise < 25 sec.",
  },
  {
    icon: Users,
    emoji: "🤝",
    title: "Quand un membre rate, il publie — les autres peuvent prendre",
    desc: "Les créneaux manqués sont partagés immédiatement dans le groupe. Si quelqu'un n'a pas pu prendre à temps, il alerte les autres. C'est de l'entraide réelle, pas juste des notifications automatiques.",
    proof: "Une alerte ratée par un membre = une seconde chance pour les autres présents dans le groupe.",
  },
  {
    icon: Lock,
    emoji: "♾️",
    title: "10 USD une seule fois — valable pour vous, vos enfants, votre famille",
    desc: "Pas d'abonnement mensuel, pas de renouvellement, pas de frais cachés. Un seul paiement et vous restez dans le groupe pour ce visa, les suivants, et ceux de votre famille.",
    proof: "Coût ramené sur 2 demandes de visa = 5 USD par rendez-vous. Sur 5 demandes = 2 USD chacune.",
  },
];

const TESTIMONIALS = [
  {
    name: "Marie K.",
    detail: "Visa tourisme · Kinshasa, Gombe",
    stars: 5,
    text: "J'avais passé 3 semaines à rafraîchir citaconsular.es sans rien trouver. Le 4ème jour après avoir rejoint le groupe, une alerte est arrivée à 10h22. J'ai suivi les étapes exactement comme expliqué et le créneau était confirmé en 21 secondes. Je n'aurais jamais réussi seule.",
  },
  {
    name: "Patrick M.",
    detail: "Visa famille · Kinshasa, Lingwala",
    stars: 5,
    text: "La vraie valeur c'est la méthode, pas juste les alertes. Avant je cliquais dans tous les sens et je ratais. Maintenant je sais exactement dans quel ordre aller, ce qu'il faut préparer avant que l'alerte arrive. 10 USD les mieux dépensés de toute ma démarche visa.",
  },
  {
    name: "Suzanne L.",
    detail: "Regroupement familial · Kinshasa, Kalamu",
    stars: 5,
    text: "Mon visa pour rejoindre mon mari en Espagne. Sans ce groupe j'attendrais encore. L'alerte est arrivée à 7h51 du matin, j'ai eu le créneau avant d'arriver au bureau. Le groupe est sérieux, les alertes sont précises, l'admin répond rapidement.",
  },
];

const OBJECTIONS = [
  {
    q: "Et si je n'arrive toujours pas à prendre le créneau ?",
    a: "La méthode du groupe maximise vos chances — elle ne les garantit pas à 100%, personne ne peut le faire. Ce que le groupe garantit : vous serez alerté AVANT les gens qui cherchent seuls, et vous saurez exactement comment agir vite. Le reste dépend de votre disponibilité au moment de l'alerte.",
  },
  {
    q: "10 USD c'est cher pour un groupe WhatsApp ?",
    a: "Un café à Bruxelles coûte 4 EUR. 10 USD vous donne un accès à vie à des alertes précises, une méthode testée, et une communauté active. Comparé aux 150 USD des frais Joventy pour la gestion complète, ou au coût d'une journée de travail perdue à surveiller un écran — c'est la meilleure valeur disponible pour ceux qui veulent le faire eux-mêmes.",
  },
  {
    q: "Comment je sais que le groupe est vraiment actif ?",
    a: "Le groupe existe depuis plusieurs mois et compte des membres actifs de Kinshasa. Les alertes sont publiées manuellement par des personnes qui surveillent réellement le portail — pas des bots. L'admin répond personnellement dans les heures qui suivent votre intégration.",
  },
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
  const [openFaq, setOpenFaq] = useState<number | null>(null);
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
    if (f.type.startsWith("image/")) setPreview(URL.createObjectURL(f));
    else setPreview(null);
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
      const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!res.ok) throw new Error(`Upload échoué (${res.status})`);
      const { storageId } = await res.json();
      await submitOrder({ name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, proofStorageId: storageId as string });
      setDone(true);
    } catch {
      toast({ variant: "destructive", title: "Erreur", description: "Impossible d'envoyer. Réessayez." });
    } finally {
      setIsSubmitting(false);
    }
  };

  const scrollToForm = () => {
    document.getElementById("payer")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="min-h-screen bg-white">
      <Navbar />

      {/* ═══════════════════════════════════════════════════════ HERO ═══ */}
      <section className="relative bg-gradient-to-br from-[#0a1f44] via-[#1d3a6b] to-[#0f2d5c] pt-36 pb-28 px-4 overflow-hidden">
        {/* Subtle texture */}
        <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        {/* Glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] bg-secondary/20 rounded-full blur-3xl" />

        <div className="relative max-w-3xl mx-auto text-center">
          {/* Live badge */}
          <div className="inline-flex items-center gap-2 bg-green-500/20 border border-green-400/30 text-green-300 text-xs font-bold px-4 py-2 rounded-full mb-6 uppercase tracking-widest">
            <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
            Groupe actif · Alertes en cours
          </div>

          <h1 className="text-4xl md:text-5xl lg:text-6xl font-black text-white leading-[1.1] tracking-tight mb-6">
            Arrêtez de surveiller<br />
            <span className="text-secondary">citaconsular.es</span><br />
            toute la journée.
          </h1>

          <p className="text-xl text-blue-200 leading-relaxed mb-4 max-w-2xl mx-auto">
            Pendant que vous rafraîchissez l'écran, quelqu'un dans notre groupe reçoit l'alerte — et prend le créneau en 20 secondes. Pour <strong className="text-white">10 USD une seule fois</strong>, ce quelqu'un peut être vous.
          </p>

          {/* Urgency nudge */}
          <div className="inline-flex items-center gap-2 bg-amber-500/15 border border-amber-400/30 text-amber-200 text-sm px-4 py-2 rounded-full mb-10">
            <AlertTriangle className="w-4 h-4" />
            Les créneaux durent moins de 90 secondes — chaque seconde compte
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button
              onClick={scrollToForm}
              className="inline-flex items-center gap-3 bg-secondary hover:bg-secondary/90 text-white font-black text-lg px-10 py-4 rounded-2xl shadow-2xl shadow-secondary/30 transition-all hover:scale-105 active:scale-100"
            >
              Rejoindre le groupe · {PRICE_USD} USD
              <ChevronRight className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-white/50 text-sm">
              <CheckCircle2 className="w-4 h-4 text-green-400" />
              Accès à vie · Paiement Mobile Money
            </div>
          </div>

          <div className="mt-10 flex justify-center">
            <ArrowDown className="w-5 h-5 text-white/30 animate-bounce" />
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════ SOCIAL PROOF STRIP ═══ */}
      <section className="bg-slate-900 py-5 px-4 border-b border-white/10">
        <div className="max-w-4xl mx-auto flex flex-wrap items-center justify-center gap-6 sm:gap-12">
          {[
            { n: "10 USD", label: "accès à vie, sans abonnement" },
            { n: "< 90 sec", label: "durée moyenne d'un créneau disponible" },
            { n: "20 sec", label: "pour saisir un créneau avec la méthode" },
            { n: "0 USD", label: "de frais supplémentaires après adhésion" },
          ].map((s) => (
            <div key={s.n} className="text-center">
              <p className="text-secondary font-black text-2xl">{s.n}</p>
              <p className="text-white/40 text-xs mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════ PAIN ═══ */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="bg-slate-50 border-l-4 border-red-400 rounded-2xl p-8 sm:p-10">
            <p className="text-red-500 font-bold text-xs uppercase tracking-widest mb-4">Ce que vous vivez en ce moment</p>
            <p className="text-2xl sm:text-3xl font-black text-primary leading-snug mb-6">
              Il est 10h17.<br />
              Un créneau vient d'apparaître sur citaconsular.es.<br />
              <span className="text-red-500">Vous ne le voyez pas.</span>
            </p>
            <p className="text-slate-600 text-base leading-relaxed mb-4">
              Quelqu'un dans notre groupe, lui, a reçu l'alerte. Il avait déjà son navigateur ouvert, il savait exactement où cliquer. En 23 secondes, le créneau est pris. Vous continuez à attendre.
            </p>
            <p className="text-slate-500 text-sm leading-relaxed">
              Ce scénario se répète chaque semaine pour des centaines de personnes qui cherchent seules — sans savoir <em>quand</em> regarder, ni <em>comment</em> agir assez vite quand le moment arrive.
            </p>
          </div>
        </div>
      </section>

      {/* ═══════════════════════════════════════════════ BENEFITS ═══ */}
      <section className="py-20 px-4 bg-slate-50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-4">
            <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Ce que vous obtenez pour 10 USD</p>
            <h2 className="text-3xl sm:text-4xl font-black text-primary">Pas juste des alertes.<br />Un avantage concret.</h2>
          </div>
          <p className="text-center text-muted-foreground mb-14 max-w-xl mx-auto">
            Les membres du groupe ne sont pas plus rapides que vous. Ils ont juste les bonnes informations au bon moment — et ils savent quoi faire ensuite.
          </p>
          <div className="grid sm:grid-cols-2 gap-6">
            {BENEFITS.map((b) => (
              <div key={b.title} className="bg-white rounded-2xl border border-border p-7 shadow-sm hover:shadow-lg hover:-translate-y-0.5 transition-all">
                <div className="text-3xl mb-4">{b.emoji}</div>
                <h3 className="font-black text-primary text-lg leading-snug mb-3">{b.title}</h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-4">{b.desc}</p>
                <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-xl p-3">
                  <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-green-700 font-medium leading-relaxed">{b.proof}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ HOW IT WORKS ═══ */}
      <section className="py-20 px-4">
        <div className="max-w-2xl mx-auto text-center">
          <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Processus en 3 étapes</p>
          <h2 className="text-3xl font-black text-primary mb-12">Vous êtes dans le groupe dans les 24h</h2>
          <div className="space-y-5 text-left">
            {[
              { n: "1", icon: "💳", title: "Payez 10 USD via Mobile Money", sub: "M-Pesa, Airtel Money ou Orange Money. Prenez une capture d'écran de la confirmation." },
              { n: "2", icon: "📸", title: "Uploadez votre capture ci-dessous", sub: "Remplissez le formulaire en bas de page avec votre nom, email et la capture de paiement. 2 minutes max." },
              { n: "3", icon: "✅", title: "L'admin confirme — vous recevez le lien", sub: "Sous 24h, vous recevez par email le lien du groupe WhatsApp + les instructions pour que votre accès soit approuvé." },
            ].map((step) => (
              <div key={step.n} className="flex gap-5 items-start">
                <div className="w-12 h-12 rounded-2xl bg-primary text-white font-black text-xl flex items-center justify-center flex-shrink-0 shadow-lg shadow-primary/30">
                  {step.n}
                </div>
                <div className="pt-1">
                  <p className="font-bold text-primary text-base">{step.icon} {step.title}</p>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{step.sub}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-10">
            <button
              onClick={scrollToForm}
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary/90 text-white font-bold px-8 py-4 rounded-xl shadow-lg shadow-primary/25 transition-all"
            >
              Payer 10 USD et rejoindre <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ TESTIMONIALS ═══ */}
      <section className="py-20 px-4 bg-gradient-to-br from-primary/5 to-slate-50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Ce que disent nos membres</p>
            <h2 className="text-3xl font-black text-primary">Ils ont obtenu leur créneau.<br />Voici comment.</h2>
          </div>
          <div className="grid sm:grid-cols-3 gap-6">
            {TESTIMONIALS.map((t) => (
              <div key={t.name} className="bg-white rounded-2xl border border-border p-6 shadow-sm flex flex-col">
                <div className="flex gap-0.5 mb-4">
                  {Array.from({ length: t.stars }).map((_, i) => (
                    <Star key={i} className="w-4 h-4 text-amber-400 fill-amber-400" />
                  ))}
                </div>
                <p className="text-slate-700 text-sm leading-relaxed flex-1 italic mb-5">"{t.text}"</p>
                <div className="flex items-center gap-3 pt-4 border-t border-border">
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-black text-primary text-lg flex-shrink-0">
                    {t.name[0]}
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.detail}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════ OFFER RECAP ═══ */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="bg-primary rounded-3xl p-8 sm:p-12 text-white text-center">
            <div className="text-5xl mb-6">🇪🇸</div>
            <h2 className="text-3xl sm:text-4xl font-black mb-4">Tout ça pour 10 USD.<br />Une seule fois.</h2>
            <p className="text-white/70 text-base mb-8 max-w-xl mx-auto leading-relaxed">
              D'autres paient 150 USD pour qu'on gère leur rendez-vous. Vous préférez le faire vous-même — c'est tout à fait possible. Ce groupe vous donne les outils pour y arriver. 10 USD, accès à vie, aucun abonnement.
            </p>
            <ul className="text-left max-w-sm mx-auto space-y-3 mb-10">
              {[
                "Alertes avec jour + plage horaire précise",
                "Méthode pour capturer un créneau en < 20 sec",
                "Partage de créneaux manqués entre membres",
                "Valable pour tous vos rendez-vous futurs",
                "Famille et enfants inclus dans votre accès",
              ].map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm text-white/90">
                  <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
            <button
              onClick={scrollToForm}
              className="inline-flex items-center gap-3 bg-secondary hover:bg-secondary/90 text-white font-black text-lg px-10 py-4 rounded-2xl shadow-xl shadow-black/20 transition-all hover:scale-105 active:scale-100"
            >
              Oui, je rejoins le groupe · 10 USD <ChevronRight className="w-5 h-5" />
            </button>
            <p className="text-white/40 text-xs mt-4">Paiement via M-Pesa · Airtel Money · Orange Money</p>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════ OBJECTIONS ═══ */}
      <section className="py-20 px-4 bg-slate-50">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-10">
            <p className="text-secondary font-bold text-xs uppercase tracking-widest mb-2">Questions fréquentes</p>
            <h2 className="text-3xl font-black text-primary">Vous avez des doutes. C'est normal.</h2>
          </div>
          <div className="space-y-3">
            {OBJECTIONS.map((obj, i) => (
              <div key={i} className="bg-white rounded-2xl border border-border overflow-hidden">
                <button
                  className="w-full flex items-center justify-between gap-4 p-6 text-left"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                >
                  <p className="font-bold text-primary">{obj.q}</p>
                  <div className={`w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 transition-transform ${openFaq === i ? "rotate-180" : ""}`}>
                    <ChevronRight className="w-4 h-4 text-primary rotate-90" />
                  </div>
                </button>
                {openFaq === i && (
                  <div className="px-6 pb-6">
                    <p className="text-sm text-slate-600 leading-relaxed border-t border-border pt-4">{obj.a}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ════════════════════════════════════════ URGENCY + FORM ═══ */}
      <section id="payer" className="py-20 px-4">
        <div className="max-w-xl mx-auto">
          {/* Urgency banner */}
          <div className="bg-amber-50 border border-amber-300 rounded-2xl p-4 flex items-start gap-3 mb-8">
            <RefreshCw className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-bold text-amber-800 text-sm">Pendant que vous lisez cette page…</p>
              <p className="text-amber-700 text-sm mt-0.5">Des créneaux apparaissent et disparaissent sur citaconsular.es. Les membres du groupe sont déjà alertés. Rejoignez-les maintenant.</p>
            </div>
          </div>

          <div className="text-center mb-8">
            <h2 className="text-3xl font-black text-primary mb-2">Rejoindre le groupe maintenant</h2>
            <p className="text-muted-foreground">3 étapes · 2 minutes · Accès sous 24h</p>
          </div>

          {done ? (
            <div className="bg-white rounded-2xl border border-border shadow-sm p-10 text-center animate-in fade-in duration-500">
              <div className="w-20 h-20 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-10 h-10 text-green-600" />
              </div>
              <h3 className="text-2xl font-bold text-primary mb-3">Demande envoyée ✅</h3>
              <p className="text-slate-600 leading-relaxed mb-4">
                Votre paiement est en cours de vérification. Vous recevrez le lien du groupe WhatsApp par email <strong>dans les 24 heures</strong>. Vérifiez aussi vos spams.
              </p>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
                <strong>Prochain rendez-vous :</strong> dès que vous recevez le lien, rejoignez le groupe et envoyez immédiatement le message de confirmation à l'admin — c'est la seule façon d'être approuvé.
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="bg-white rounded-2xl border border-border shadow-lg overflow-hidden">

              {/* STEP 1 */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center flex-shrink-0">1</div>
                  <h3 className="font-bold text-primary">Choisissez votre opérateur et payez 10 USD</h3>
                </div>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  {(["mpesa", "airtel", "orange"] as const).map((m) => (
                    <button key={m} type="button" onClick={() => setSelectedMethod(m)}
                      className={`py-3 rounded-xl border-2 font-semibold text-sm transition-all ${
                        selectedMethod === m ? "border-primary bg-primary/5 text-primary" : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {m === "mpesa" ? "M-Pesa" : m === "airtel" ? "Airtel Money" : "Orange Money"}
                    </button>
                  ))}
                </div>
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-sm text-blue-700 mb-1.5 font-medium">Envoyez <strong>10 USD</strong> à ce numéro :</p>
                  <div className="flex items-center justify-between">
                    <span className="text-2xl font-black text-primary">{paymentNumber}</span>
                    <button type="button" onClick={() => handleCopy(paymentNumber)}
                      className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-primary transition-colors bg-white border border-blue-200 px-3 py-1.5 rounded-lg"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copier
                    </button>
                  </div>
                  <p className="text-xs text-blue-600 mt-2">Motif du paiement : <strong>ALERTE ESPAGNE</strong></p>
                </div>
              </div>

              {/* STEP 2 */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center flex-shrink-0">2</div>
                  <h3 className="font-bold text-primary">Vos coordonnées</h3>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Nom complet <span className="text-red-500">*</span></label>
                    <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex : Jean Mukendi" required
                      className="w-full border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">Email <span className="text-red-500">*</span></label>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="votre@email.com" required
                      className="w-full border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all" />
                    <p className="text-xs text-muted-foreground mt-1">Le lien du groupe sera envoyé ici. Vérifiez aussi vos spams.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">WhatsApp <span className="text-muted-foreground text-xs font-normal">(optionnel)</span></label>
                    <div className="relative">
                      <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+243 8XX XXX XXX"
                        className="w-full border border-border rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary transition-all" />
                    </div>
                  </div>
                </div>
              </div>

              {/* STEP 3 */}
              <div className="p-6 border-b border-border">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-7 h-7 rounded-full bg-primary text-white font-bold text-sm flex items-center justify-center flex-shrink-0">3</div>
                  <h3 className="font-bold text-primary">Capture d'écran du paiement</h3>
                </div>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" className="hidden" onChange={handleFileChange} />
                {file ? (
                  <div className="space-y-3">
                    {preview && <img src={preview} alt="Aperçu" className="w-full max-h-48 object-contain rounded-xl border border-border" />}
                    <div className="flex items-center justify-between bg-green-50 border border-green-200 rounded-xl p-3">
                      <div className="flex items-center gap-2 text-sm text-green-700 font-medium">
                        <CheckCircle2 className="w-4 h-4" />
                        <span className="truncate max-w-[200px]">{file.name}</span>
                      </div>
                      <button type="button" onClick={() => { setFile(null); setPreview(null); if (fileRef.current) fileRef.current.value = ""; }}
                        className="text-xs text-slate-500 hover:text-red-500 transition-colors">Changer</button>
                    </div>
                  </div>
                ) : (
                  <button type="button" onClick={() => fileRef.current?.click()}
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

              {/* CTA */}
              <div className="p-6 bg-slate-50">
                <Button type="submit" disabled={isSubmitting || !file || !name.trim() || !email.trim()}
                  className="w-full py-4 text-base font-black bg-secondary hover:bg-secondary/90 text-white shadow-xl shadow-secondary/25 rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <span className="flex items-center gap-2"><RefreshCw className="w-4 h-4 animate-spin" /> Envoi en cours...</span>
                  ) : (
                    <span className="flex items-center gap-2">Oui, je rejoins le groupe — 10 USD <ChevronRight className="w-4 h-4" /></span>
                  )}
                </Button>
                <div className="flex items-center justify-center gap-4 mt-4">
                  {[
                    { icon: CheckCircle2, text: "Accès sous 24h" },
                    { icon: Lock, text: "Paiement vérifiable" },
                    { icon: MessageCircle, text: "Admin disponible" },
                  ].map((t) => (
                    <div key={t.text} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <t.icon className="w-3.5 h-3.5 text-green-500" />
                      {t.text}
                    </div>
                  ))}
                </div>
              </div>
            </form>
          )}
        </div>
      </section>

      {/* ══════════════════════════════════════════════════ FOOTER ═══ */}
      <footer className="py-8 px-4 bg-slate-900 text-center border-t border-white/10">
        <div className="max-w-3xl mx-auto">
          <p className="text-slate-500 text-xs">
            © {new Date().getFullYear()} Joventy · Akollad Groupe · RCCM CD/KNG/RCCM/25-A-07960 ·{" "}
            <a href="/confidentialite" className="hover:text-slate-300 transition-colors">Confidentialité</a>{" · "}
            <a href="/conditions" className="hover:text-slate-300 transition-colors">CGU</a>
          </p>
          <p className="text-slate-600 text-xs mt-2">
            Joventy facilite l'accès à l'information. Les rendez-vous sont pris directement auprès de l'ambassade via le portail officiel citaconsular.es. Joventy n'est pas affilié à l'Ambassade d'Espagne.
          </p>
        </div>
      </footer>
    </div>
  );
}
