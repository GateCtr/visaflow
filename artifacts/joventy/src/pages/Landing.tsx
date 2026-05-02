import { Link } from "wouter";
import { useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Helmet } from "react-helmet-async";
import { Navbar } from "@/components/layout/Navbar";
import { Button } from "@/components/ui/button";
import { JoventyLogo } from "@/components/JoventyLogo";
import {
  ArrowRight, Star, ShieldCheck, Clock, FileText, CheckCircle2,
  MessageCircle, Phone, Mail, Zap, Award, Users, TrendingUp,
  Calendar, ClipboardList, ChevronRight, XCircle, HelpCircle,
  Landmark, CreditCard, BadgeCheck,
} from "lucide-react";

const FLAG_SIZES = [20, 40, 80, 160, 320, 640];
function snapFlagSize(n: number) {
  return FLAG_SIZES.find((s) => s >= n) ?? 80;
}

function FlagImg({ code, size = 32, className = "" }: { code: string; size?: number; className?: string }) {
  const snapped = snapFlagSize(size);
  const snapped2x = snapFlagSize(size * 2);
  return (
    <img
      src={`https://flagcdn.com/w${snapped}/${code.toLowerCase()}.png`}
      srcSet={`https://flagcdn.com/w${snapped2x}/${code.toLowerCase()}.png 2x`}
      width={snapped}
      alt={code}
      className={`rounded-sm object-cover flex-shrink-0 ${className}`}
    />
  );
}

const DESTINATIONS = [
  {
    code: "us",
    name: "États-Unis",
    visaTypes: ["B1/B2 Tourisme", "F1 Étudiant", "K1 Fiancé(e)", "H1B Travail"],
    engagement: 250,
    success: 750,
    model: "appointment",
    note: "Frais MRV 265$ non inclus",
    badge: null,
  },
  {
    code: "eu",
    name: "Europe Schengen",
    visaTypes: ["Visa C Tourisme / Affaires", "Visa C Études (gratuit*)", "Visa D Long Séjour"],
    engagement: 150,
    success: 450,
    model: "appointment",
    note: "Frais consulaires CEV 90€/adulte non inclus",
    badge: "Nouveau",
  },
  {
    code: "ae",
    name: "Dubaï (EAU)",
    visaTypes: ["Touriste 30j", "Touriste 60j", "Affaires", "Résidence"],
    engagement: 80,
    success: 120,
    model: "evisa",
    note: "Frais e-Visa EAU (~90$) non inclus",
    badge: null,
  },
  {
    code: "tr",
    name: "Turquie",
    visaTypes: ["E-Visa en ligne", "Visa Sticker VFS", "Transit"],
    engagement: 80,
    success: 120,
    model: "hybrid",
    note: "Frais consulaires VFS (100-300$) non inclus",
    badge: null,
  },
  {
    code: "in",
    name: "Inde",
    visaTypes: ["E-Visa Tourisme", "Médical", "Affaires", "Études"],
    engagement: 100,
    success: 150,
    model: "evisa",
    note: "Frais e-Visa gouvernement (~25-80$) non inclus",
    badge: null,
  },
];

const STEPS = [
  {
    num: "01",
    title: "Créez votre dossier",
    desc: "Choisissez votre destination, le type de visa et le package adapté à votre situation. 5 minutes suffisent.",
    icon: FileText,
  },
  {
    num: "02",
    title: "Payez par Mobile Money",
    desc: "Réglez les frais d'engagement via M-Pesa, Airtel Money ou Orange Money. Aucun virement bancaire, aucune carte étrangère requise.",
    icon: Phone,
  },
  {
    num: "03",
    title: "Joventy traite votre dossier",
    desc: "Notre équipe remplit vos formulaires, vérifie vos pièces et cherche activement votre créneau consulaire ou soumet votre e-Visa.",
    icon: Zap,
  },
  {
    num: "04",
    title: "Résultat garanti ou vous ne payez pas",
    desc: "La prime de succès n'est due qu'une fois le résultat obtenu : créneau verrouillé ou visa électronique accordé. Zéro risque.",
    icon: CheckCircle2,
  },
];

const PACKAGES = [
  {
    key: "full_service",
    icon: Star,
    label: "Service Complet",
    tagline: "Recommandé — Clé en main",
    desc: "Joventy gère tout : formulaires officiels, vérification de votre dossier, et recherche active de créneau consulaire ou dépôt e-Visa en votre nom. Vous n'avez qu'à vous présenter le jour J.",
    highlight: true,
    features: [
      "Formulaires DS-160, MRV, VFS ou e-Visa",
      "Vérification complète des pièces justificatives",
      "Recherche active de créneau consulaire",
      "Chat dédié avec un conseiller Joventy",
      "Prime de succès due uniquement si résultat",
    ],
  },
  {
    key: "slot_only",
    icon: Calendar,
    label: "Créneau Uniquement",
    tagline: "Dossier déjà prêt",
    desc: "Vos formulaires sont remplis, vos frais MRV payés ? Joventy se concentre uniquement sur la capture d'un créneau disponible à l'ambassade (USA) ou au centre VFS (Turquie).",
    highlight: false,
    features: [
      "Surveillance continue du portail consulaire",
      "Alerte immédiate à la capture",
      "Disponible USA & Turquie VFS",
      "Niveaux d'urgence : Standard → Très urgent",
      "Prime due uniquement si créneau obtenu",
    ],
  },
  {
    key: "dossier_only",
    icon: ClipboardList,
    label: "Formulaires & Vérification",
    tagline: "Tarif fixe",
    desc: "Joventy remplit vos formulaires officiels et vérifie vos pièces. Vous gérez ensuite vous-même la soumission ou le rendez-vous. Aucune prime de succès.",
    highlight: false,
    features: [
      "Remplissage des formulaires officiels",
      "Vérification complète de votre dossier",
      "Tarif fixe — aucune surprise",
      "Disponible pour toutes les destinations",
      "Idéal si vous avez déjà un créneau",
    ],
  },
];

function destToFlagCode(dest: string): string {
  // Priority 1: extract country code directly from flag emoji characters
  const flagMatch = dest.match(/[\u{1F1E0}-\u{1F1FF}]{2}/u);
  if (flagMatch) {
    const [a, b] = [...flagMatch[0]].map((c) => c.codePointAt(0)! - 0x1F1E6 + 65);
    return String.fromCharCode(a, b).toLowerCase();
  }
  // Priority 2: text-based fallback for destinations stored without emoji
  const d = dest.toLowerCase();
  if (d.includes("états-unis") || d.includes("etats-unis") || d.includes("usa") || d.includes("b2") || d.includes("b1/") || d.includes("k1") || d.includes("f1") || d.includes("h1b")) return "us";
  if (d.includes("dubaï") || d.includes("dubai") || d.includes("eau") || d.includes("émirats") || d.includes("emirats")) return "ae";
  if (d.includes("turquie") || d.includes("turkey")) return "tr";
  if (d.includes("inde") || d.includes("india")) return "in";
  if (d.includes("schengen") || d.includes("europe") || d.includes("cev") || d.includes("belgi") || d.includes("france")) return "eu";
  return "cd";
}

const TESTIMONIALS = [
  {
    name: "Christophe M.",
    city: "Kinshasa",
    dest: "Visa B2 États-Unis",
    code: "us",
    text: "J'avais essayé d'avoir un créneau à l'ambassade américaine pendant 4 mois sans succès. Joventy a trouvé une date en moins de 3 semaines. Incroyable.",
    stars: 5,
  },
  {
    name: "Nathalie K.",
    city: "Lubumbashi",
    dest: "E-Visa Dubaï",
    code: "ae",
    text: "Processus ultra simple. J'ai uploadé mes documents le lundi, mon e-Visa était prêt le mercredi. Paiement M-Pesa sans complication.",
    stars: 5,
  },
  {
    name: "Patrick B.",
    city: "Goma",
    dest: "Visa Sticker VFS Turquie",
    code: "tr",
    text: "Le suivi en temps réel dans l'application est rassurant. Mon conseiller répondait dans la journée. Je recommande vivement.",
    stars: 5,
  },
];

const GUARANTEES = [
  {
    icon: ShieldCheck,
    title: "Paiement au résultat",
    desc: "La prime de succès n'est due que lorsque votre créneau est verrouillé ou votre visa accordé. Aucun résultat = aucun solde.",
  },
  {
    icon: Award,
    title: "Confidentialité bancaire",
    desc: "Vos données personnelles et pièces d'identité sont traitées avec le niveau de confidentialité d'une institution financière.",
  },
  {
    icon: Phone,
    title: "Mobile Money uniquement",
    desc: "Pas de virement international, pas de carte étrangère. Payez via M-Pesa, Airtel Money ou Orange Money depuis votre téléphone.",
  },
  {
    icon: MessageCircle,
    title: "Chat dédié inclus",
    desc: "Un conseiller Joventy vous accompagne à chaque étape via la messagerie intégrée à votre espace client.",
  },
];

export default function Landing() {
  const liveReviews = useQuery(api.reviews.listApproved);

  const testimonialsToShow = liveReviews && liveReviews.length > 0
    ? liveReviews.map((r) => ({
        name: r.displayName,
        city: r.city,
        dest: r.destination,
        code: destToFlagCode(r.destination),
        text: r.comment,
        stars: r.rating,
      }))
    : TESTIMONIALS;

  return (
    <div className="min-h-screen bg-background">
      <Helmet>
        <title>Joventy — Visa USA, Dubaï, Turquie, Inde depuis Kinshasa (RDC)</title>
        <meta name="description" content="Assistance visa USA, Dubaï, Turquie et Inde depuis Kinshasa. Joventy remplit vos formulaires, trouve vos créneaux et soumet vos e-Visas. Paiement M-Pesa." />
        <link rel="canonical" href="https://www.joventy.cd/" />
        <meta property="og:title" content="Joventy — Visa USA, Dubaï, Turquie, Inde depuis Kinshasa (RDC)" />
        <meta property="og:description" content="Assistance visa USA, Dubaï, Turquie et Inde depuis Kinshasa. Joventy remplit vos formulaires, trouve vos créneaux et soumet vos e-Visas. Paiement M-Pesa." />
        <meta property="og:url" content="https://www.joventy.cd/" />
        <meta property="og:type" content="website" />
      </Helmet>

      <Navbar />

      {/* ═══ HERO ═══ */}
      <section className="relative pt-32 pb-24 lg:pt-48 lg:pb-36 overflow-hidden">
        <div className="absolute inset-0 z-0">
          <img
            src={`${import.meta.env.BASE_URL}images/hero-bg.png`}
            alt="Skyline de Kinshasa, République Démocratique du Congo — Assistance visa premium Joventy"
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-b from-primary/60 via-primary/75 to-background" />
        </div>

        <div className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white text-sm font-semibold mb-8">
            <Star className="w-4 h-4 text-secondary fill-secondary" />
            <span>Assistance visa premium · Kinshasa, RDC</span>
          </div>

          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-serif font-bold text-white tracking-tight leading-tight mb-6">
            Votre visa, géré par des experts.{" "}
            <span className="text-secondary drop-shadow-md">Vous payez si ça marche.</span>
          </h1>

          <p className="text-lg md:text-xl text-white/75 max-w-2xl mx-auto mb-10 leading-relaxed">
            Joventy remplit vos formulaires, cherche vos créneaux consulaires et soumet vos e-Visas pour l'USA, Dubaï, la Turquie et l'Inde. Paiement via M-Pesa, Airtel Money ou Orange Money, résultat garanti.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-14">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto h-14 px-8 text-lg bg-secondary hover:bg-orange-500 text-primary font-bold shadow-xl shadow-secondary/30 rounded-xl transition-all hover:scale-105">
                Démarrer mon dossier
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto h-14 px-8 text-lg border-white/30 text-white hover:bg-white/10 hover:text-white backdrop-blur-md rounded-xl">
                Espace Client
              </Button>
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 max-w-lg mx-auto">
            {[
              { val: "150+", label: "Dossiers traités" },
              { val: "98%", label: "Satisfaction client" },
              { val: "72h", label: "Délai moyen e-Visa" },
            ].map((s) => (
              <div key={s.label} className="bg-white/10 backdrop-blur-md rounded-2xl px-3 py-4 border border-white/15">
                <div className="text-2xl sm:text-3xl font-bold text-secondary">{s.val}</div>
                <div className="text-[11px] sm:text-xs text-white/65 mt-0.5 leading-tight">{s.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ TRUST BAR ═══ */}
      <div className="bg-white border-y border-border py-5">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground font-medium">
            {[
              { icon: ShieldCheck, label: "Paiement au résultat" },
              { icon: Phone, label: "M-Pesa, Airtel & Orange Money" },
              { icon: Clock, label: "Suivi en temps réel" },
              { icon: MessageCircle, label: "Chat conseiller inclus" },
              { icon: Award, label: "Données 100% confidentielles" },
            ].map((t) => (
              <div key={t.label} className="flex items-center gap-2">
                <t.icon className="w-4 h-4 text-secondary flex-shrink-0" />
                <span>{t.label}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ═══ CE QUE FAIT JOVENTY ═══ */}
      <section className="py-20 bg-white border-b border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Transparence totale</p>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">
              Joventy, c'est quoi exactement ?
            </h2>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Nous sommes une <strong>agence d'assistance visa</strong> basée à Kinshasa — pas un consulat, pas une ambassade.
              Notre rôle est de vous accompagner dans votre démarche, pas de vous délivrer un visa.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
            {/* Ce que Joventy fait */}
            <div className="bg-green-50 border border-green-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-green-600 flex items-center justify-center flex-shrink-0">
                  <BadgeCheck className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-green-900">Ce que Joventy fait pour vous</h3>
              </div>
              <ul className="space-y-3">
                {[
                  "Remplit vos formulaires officiels (DS-160, VFS, portails e-Visa)",
                  "Vérifie que vos pièces justificatives sont conformes aux exigences consulaires",
                  "Recherche activement un créneau de rendez-vous consulaire (USA, Turquie)",
                  "Soumet votre dossier e-Visa auprès du gouvernement (Dubaï, Inde)",
                  "Vous accompagne par chat dédié à chaque étape du dossier",
                  "Vous transmet le résultat dès obtention (convocation ou e-Visa PDF)",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-green-800">
                    <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0 mt-0.5" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            {/* Ce que Joventy ne fait pas */}
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-7">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-slate-600 flex items-center justify-center flex-shrink-0">
                  <Landmark className="w-5 h-5 text-white" />
                </div>
                <h3 className="text-lg font-bold text-slate-800">Ce que Joventy ne fait pas</h3>
              </div>
              <ul className="space-y-3">
                {[
                  { text: "Joventy n'est pas un consulat et ne délivre pas de visas", note: "La décision d'accord ou de refus appartient exclusivement à l'ambassade ou au gouvernement étranger." },
                  { text: "Joventy ne garantit pas l'approbation finale du visa", note: "Nous garantissons uniquement le service : si nous ne trouvons pas de créneau ou si l'e-Visa est refusé, vous ne payez pas la prime de succès." },
                  { text: "Les frais consulaires et annexes ne sont pas inclus dans nos tarifs", note: "MRV USA (265$), frais VFS Turquie (100-300$), e-Visa EAU (~90$), e-Visa Inde (~25-80$), assurance voyage, réservations d'hôtel et de billets d'avion restent à la charge du client et sont payés directement aux organismes concernés." },
                ].map((item) => (
                  <li key={item.text} className="flex items-start gap-3">
                    <XCircle className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-semibold text-slate-700">{item.text}</p>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.note}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Modèle de frais */}
          <div className="bg-primary rounded-2xl p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-6">
              <CreditCard className="w-5 h-5 text-secondary" />
              <h3 className="text-lg font-bold text-white">Comment fonctionne le paiement ?</h3>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  num: "1",
                  title: "Frais d'engagement",
                  desc: "Payés à la création du dossier. Couvrent l'analyse, la vérification de vos pièces et le démarrage du service.",
                  color: "bg-white/10 border-white/20",
                },
                {
                  num: "2",
                  title: "Prime de succès",
                  desc: "Due uniquement si Joventy obtient un résultat (créneau ou e-Visa). Si échec : vous ne payez rien de plus.",
                  color: "bg-secondary/20 border-secondary/30",
                  highlight: true,
                },
                {
                  num: "3",
                  title: "Frais consulaires",
                  desc: "Payés directement par vous au consulat/gouvernement étranger. Non collectés par Joventy. Montants variables selon la destination.",
                  color: "bg-white/10 border-white/20",
                },
              ].map((item) => (
                <div key={item.num} className={`rounded-xl border p-5 ${item.color}`}>
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold mb-3 ${item.highlight ? "bg-secondary text-primary" : "bg-white/20 text-white"}`}>
                    {item.num}
                  </div>
                  <h4 className={`font-bold text-sm mb-2 ${item.highlight ? "text-secondary" : "text-white"}`}>{item.title}</h4>
                  <p className="text-xs text-white/65 leading-relaxed">{item.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ═══ COMMENT ÇA MARCHE ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Simple & transparent</p>
            <h2 className="text-3xl md:text-4xl font-bold text-primary mb-4">Comment ça marche</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Quatre étapes pour obtenir votre visa, sans vous déplacer en agence.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8">
            {STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <div key={i} className="relative">
                  {i < STEPS.length - 1 && (
                    <div className="hidden lg:block absolute top-10 left-full w-8 z-10 -translate-x-4">
                      <ChevronRight className="w-5 h-5 text-border mx-auto" />
                    </div>
                  )}
                  <div className="bg-white rounded-2xl p-7 border border-border shadow-sm h-full flex flex-col">
                    <div className="flex items-start gap-4 mb-4">
                      <span className="text-4xl font-bold text-muted-foreground/30 leading-none select-none">{step.num}</span>
                      <div className="w-10 h-10 rounded-xl bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-1">
                        <Icon className="w-5 h-5 text-secondary" />
                      </div>
                    </div>
                    <h3 className="text-lg font-bold text-primary mb-2">{step.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed flex-1">{step.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ PACKAGES ═══ */}
      <section id="services" className="py-24 bg-primary text-white relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,152,0,0.08),transparent_60%)]" />
        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Nos formules</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-white mb-4">Choisissez votre niveau de service</h2>
            <p className="text-white/70 text-lg max-w-xl mx-auto">Que vous ayez juste besoin d'un créneau ou d'un accompagnement complet, nous avons la formule adaptée.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
            {PACKAGES.map((pkg) => {
              const Icon = pkg.icon;
              return (
                <div
                  key={pkg.key}
                  className={`relative rounded-2xl p-7 flex flex-col ${
                    pkg.highlight
                      ? "bg-secondary text-primary ring-4 ring-secondary/30"
                      : "bg-white/5 border border-white/10 backdrop-blur-sm text-white"
                  }`}
                >
                  {pkg.highlight && (
                    <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 bg-white text-primary text-xs font-bold px-3 py-1 rounded-full shadow-lg">
                      ⭐ Recommandé
                    </span>
                  )}
                  <div className="flex items-center gap-3 mb-4">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${pkg.highlight ? "bg-primary/10" : "bg-white/10"}`}>
                      <Icon className={`w-5 h-5 ${pkg.highlight ? "text-primary" : "text-secondary"}`} />
                    </div>
                    <div>
                      <p className={`text-xs font-semibold uppercase tracking-wide ${pkg.highlight ? "text-primary/60" : "text-white/55"}`}>{pkg.tagline}</p>
                      <h3 className={`font-bold text-lg ${pkg.highlight ? "text-primary" : "text-white"}`}>{pkg.label}</h3>
                    </div>
                  </div>

                  <p className={`text-sm mb-5 leading-relaxed ${pkg.highlight ? "text-primary/80" : "text-white/70"}`}>{pkg.desc}</p>

                  <ul className="space-y-2.5 flex-1 mb-6">
                    {pkg.features.map((f) => (
                      <li key={f} className={`flex items-start gap-2.5 text-sm ${pkg.highlight ? "text-primary" : "text-white/85"}`}>
                        <CheckCircle2 className={`w-4 h-4 flex-shrink-0 mt-0.5 ${pkg.highlight ? "text-primary" : "text-secondary"}`} />
                        {f}
                      </li>
                    ))}
                  </ul>

                  <Link href="/register">
                    <Button
                      className={`w-full font-bold ${
                        pkg.highlight
                          ? "bg-primary hover:bg-primary/90 text-white"
                          : "bg-secondary hover:bg-orange-500 text-primary"
                      }`}
                    >
                      Choisir cette formule <ArrowRight className="w-4 h-4 ml-1" />
                    </Button>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ DESTINATIONS ═══ */}
      <section id="destinations" className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Tarifs transparents</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Destinations & Tarifs</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Tout est affiché. Pas de frais cachés — vous connaissez exactement le coût avant de commencer.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {DESTINATIONS.map((dest) => (
              <div key={dest.name} className="bg-white border border-border rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-1 transition-all duration-200 flex flex-col">
                <div className="bg-muted px-6 py-5 border-b border-border relative">
                  {dest.badge && (
                    <span className="absolute top-3 right-3 bg-secondary text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide">
                      {dest.badge}
                    </span>
                  )}
                  <div className="flex items-center gap-3 mb-3">
                    <FlagImg code={dest.code} size={40} className="shadow-sm" />
                    <h3 className="text-xl font-bold text-primary leading-tight">{dest.name}</h3>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {dest.visaTypes.slice(0, 3).map((v) => (
                      <span key={v} className="text-[10px] bg-primary/5 text-primary/70 px-2 py-0.5 rounded-full font-medium">{v}</span>
                    ))}
                    {dest.visaTypes.length > 3 && (
                      <span className="text-[10px] text-muted-foreground px-2 py-0.5">+{dest.visaTypes.length - 3}</span>
                    )}
                  </div>
                </div>

                <div className="px-6 py-5 flex-1 flex flex-col">
                  <div className="space-y-2.5 flex-1 mb-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Frais d'engagement</span>
                      <span className="font-bold text-primary">{dest.engagement} $</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Prime de succès</span>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-green-700 font-semibold">si résultat</span>
                        <span className="font-bold text-primary">{dest.success} $</span>
                      </div>
                    </div>
                    <div className="pt-2 border-t border-border flex items-center justify-between">
                      <span className="text-xs font-semibold text-muted-foreground">Total max</span>
                      <span className="font-bold text-lg text-primary">{dest.engagement + dest.success} $</span>
                    </div>
                  </div>

                  <div className="text-[10px] text-muted-foreground italic mb-4">{dest.note}</div>

                  <Link href="/register">
                    <Button size="sm" className="w-full bg-primary hover:bg-primary/90 text-white font-semibold gap-1">
                      Commencer <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ GARANTIES ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Notre engagement</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Pourquoi choisir Joventy</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {GUARANTEES.map((g) => {
              const Icon = g.icon;
              return (
                <div key={g.title} className="bg-white rounded-2xl p-7 border border-border shadow-sm text-center flex flex-col items-center">
                  <div className="w-14 h-14 rounded-2xl bg-secondary/10 flex items-center justify-center mb-5">
                    <Icon className="w-7 h-7 text-secondary" />
                  </div>
                  <h3 className="font-bold text-primary text-base mb-2">{g.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{g.desc}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ TÉMOIGNAGES ═══ */}
      <section className="py-24 bg-white">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">Ce qu'ils disent</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Clients satisfaits</h2>
            <div className="flex items-center justify-center gap-1 mt-4">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="w-5 h-5 text-secondary fill-secondary" />
              ))}
              <span className="ml-2 text-sm text-muted-foreground font-medium">4.9/5 · 120+ avis</span>
            </div>
          </div>

          {liveReviews && liveReviews.length === 0 && (
            <p className="text-center text-xs text-muted-foreground mb-4 italic">Exemples d'avis · Les vôtres apparaîtront ici après validation</p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {testimonialsToShow.map((t) => (
              <div key={t.name} className="bg-muted rounded-2xl p-7 border border-border flex flex-col">
                <div className="flex items-center gap-1 mb-4">
                  {[...Array(t.stars)].map((_, i) => (
                    <Star key={i} className="w-4 h-4 text-secondary fill-secondary" />
                  ))}
                </div>
                <blockquote className="text-foreground text-sm leading-relaxed flex-1 mb-5 italic">
                  "{t.text}"
                </blockquote>
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-white border border-border shadow-sm flex items-center justify-center overflow-hidden flex-shrink-0">
                    <FlagImg code={t.code ?? destToFlagCode(t.dest)} size={40} className="w-full h-full object-cover rounded-none" />
                  </div>
                  <div>
                    <p className="font-bold text-primary text-sm">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.city} · {t.dest}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ FAQ ═══ */}
      <section className="py-24 bg-muted">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <div className="inline-flex items-center gap-2 mb-3">
              <HelpCircle className="w-5 h-5 text-secondary" />
              <p className="text-secondary font-semibold text-sm uppercase tracking-widest">Questions fréquentes</p>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-primary">Ce que vous devez savoir</h2>
          </div>

          <div className="space-y-4">
            {[
              {
                q: "Joventy garantit-il l'obtention du visa ?",
                a: "Non. Joventy garantit le service, pas le visa. La décision finale appartient exclusivement à l'ambassade ou au gouvernement étranger. En revanche, si nous n'obtenons pas de résultat (créneau de rendez-vous ou e-Visa), vous ne payez pas la prime de succès — seuls les frais d'engagement restent dus.",
              },
              {
                q: "Que se passe-t-il si mon visa est refusé après un rendez-vous ?",
                a: "Si vous avez obtenu un créneau de rendez-vous (USA, Turquie), Joventy a rempli sa mission et la prime de succès est due. Le refus consulaire lors de l'entretien est une décision souveraine de l'ambassade, indépendante du service Joventy. Nous vous accompagnons cependant pour préparer au mieux votre dossier.",
              },
              {
                q: "Les frais consulaires, assurances et réservations sont-ils inclus dans vos tarifs ?",
                a: "Non. Les frais consulaires sont payés directement par vous au gouvernement ou à l'organisme concerné (banque pour le MRV USA, centre VFS pour la Turquie, portail officiel pour Dubaï et l'Inde). De même, l'assurance voyage, les réservations d'hôtel et les billets d'avion — souvent exigés par le consulat comme pièces justificatives — sont entièrement à votre charge. Joventy vous indique ce qu'il faut préparer, mais ne règle pas ces frais à votre place.",
              },
              {
                q: "Mes documents et informations personnelles sont-ils en sécurité ?",
                a: "Oui. Vos données sont stockées de manière chiffrée et ne sont jamais partagées à des tiers. Elles sont utilisées uniquement pour constituer votre dossier de visa. Nous traitons vos informations avec le même niveau de confidentialité qu'une institution financière.",
              },
              {
                q: "Combien de temps prend le traitement d'un dossier ?",
                a: "Pour les e-Visas (Dubaï, Inde) : résultat en 48 à 72 heures ouvrables en général. Pour les créneaux consulaires (USA, Turquie) : le délai dépend de la disponibilité sur le portail, qui varie selon la période. Joventy surveille en continu et vous notifie dès qu'un créneau est capturé.",
              },
            ].map((item) => (
              <div key={item.q} className="bg-white rounded-2xl border border-border p-6 shadow-sm">
                <h3 className="font-bold text-primary mb-3 flex items-start gap-3">
                  <span className="w-6 h-6 rounded-full bg-secondary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-secondary text-xs font-bold">?</span>
                  </span>
                  {item.q}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed pl-9">{item.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══ CTA FINAL ═══ */}
      <section className="py-20 bg-primary relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_bottom_left,_rgba(255,152,0,0.12),transparent_55%)]" />
        <div className="relative z-10 max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <div className="flex items-center justify-center gap-2 mb-6">
            <Users className="w-5 h-5 text-secondary" />
            <span className="text-white/70 text-sm font-medium">150+ Congolais ont déjà obtenu leur visa avec Joventy</span>
          </div>
          <h2 className="text-3xl md:text-5xl font-serif font-bold text-white mb-6 leading-tight">
            Prêt à voyager ?<br />
            <span className="text-secondary">Créez votre dossier en 5 minutes.</span>
          </h2>
          <p className="text-white/70 text-lg mb-10">
            Rejoignez les voyageurs congolais qui font confiance à Joventy. Paiement via M-Pesa, Airtel Money ou Orange Money, sans paperasse, résultat garanti.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link href="/register">
              <Button size="lg" className="w-full sm:w-auto h-14 px-10 text-lg bg-secondary hover:bg-orange-500 text-primary font-bold shadow-2xl shadow-secondary/20 rounded-xl transition-all hover:scale-105">
                Démarrer mon dossier
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="outline" className="w-full sm:w-auto h-14 px-8 text-lg border-white/30 text-white hover:bg-white/10 hover:text-white rounded-xl">
                J'ai déjà un compte
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* ═══ CONTACT ═══ */}
      <section id="contact" className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <p className="text-secondary font-semibold text-sm uppercase tracking-widest mb-3">On est là</p>
            <h2 className="text-3xl md:text-4xl font-serif font-bold text-primary mb-4">Contactez-nous</h2>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">Une question avant de commencer ? Notre équipe vous répond rapidement.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              {
                icon: MessageCircle,
                label: "WhatsApp",
                value: "+243 840 808 122",
                sub: "Réponse en moins de 2h",
                href: "https://wa.me/243840808122",
                cta: "Écrire sur WhatsApp",
                color: "bg-green-500",
              },
              {
                icon: Mail,
                label: "Email",
                value: "contact@joventy.cd",
                sub: "Réponse en 24h ouvrables",
                href: "mailto:contact@joventy.cd",
                cta: "Envoyer un email",
                color: "bg-primary",
              },
              {
                icon: TrendingUp,
                label: "Espace Client",
                value: "Chat intégré",
                sub: "Suivi de votre dossier en temps réel",
                href: "/login",
                cta: "Accéder à mon espace",
                color: "bg-secondary",
              },
            ].map((c) => {
              const Icon = c.icon;
              const isExternal = c.href.startsWith("http") || c.href.startsWith("mailto");
              const Inner = (
                <div className="bg-muted border border-border rounded-2xl p-7 flex flex-col items-center text-center h-full hover:shadow-md hover:-translate-y-1 transition-all duration-200">
                  <div className={`w-12 h-12 rounded-xl ${c.color} flex items-center justify-center mb-4`}>
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-1">{c.label}</p>
                  <p className="font-bold text-primary text-sm mb-1">{c.value}</p>
                  <p className="text-xs text-muted-foreground mb-5">{c.sub}</p>
                  <span className="mt-auto text-sm font-semibold text-primary underline underline-offset-4">{c.cta} →</span>
                </div>
              );
              return isExternal ? (
                <a key={c.label} href={c.href} target="_blank" rel="noopener noreferrer" className="flex flex-col">
                  {Inner}
                </a>
              ) : (
                <Link key={c.label} href={c.href} className="flex flex-col">
                  {Inner}
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      {/* ═══ FOOTER ═══ */}
      <footer className="bg-primary text-white py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-10">
            <div className="md:col-span-1">
              <JoventyLogo variant="dark" size="md" />
              <p className="mt-4 text-white/55 text-sm leading-relaxed max-w-xs">
                Assistance visa premium pour les voyageurs congolais. Formulaires, créneaux, e-Visas — nous gérons tout.
              </p>
              <div className="mt-5 flex flex-col gap-1.5 text-xs text-white/40">
                <a href="mailto:contact@joventy.cd" className="hover:text-white transition-colors">✉ contact@joventy.cd</a>
                <a href="https://wa.me/243840808122" className="hover:text-white transition-colors">📱 +243 840 808 122</a>
              </div>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Destinations</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {([
                  { code: "us", label: "Visa États-Unis" },
                  { code: "eu", label: "Visa Schengen" },
                  { code: "ae", label: "E-Visa Dubaï" },
                  { code: "tr", label: "Visa Turquie" },
                  { code: "in", label: "E-Visa Inde" },
                ] as { code: string; label: string }[]).map((d) => (
                  <li key={d.code}>
                    <Link href="/register" className="hover:text-white transition-colors flex items-center gap-2">
                      <FlagImg code={d.code} size={20} className="opacity-90" />
                      {d.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Liens utiles</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {[
                  { label: "Nos Services", href: "/#services" },
                  { label: "Tarifs", href: "/#destinations" },
                  { label: "Contact", href: "/#contact" },
                  { label: "Espace Client", href: "/login" },
                  { label: "Créer un compte", href: "/register" },
                ].map((l) => (
                  <li key={l.label}><Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link></li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="font-bold text-sm uppercase tracking-wider text-white/65 mb-4">Légal</h4>
              <ul className="space-y-2 text-sm text-white/50">
                {[
                  { label: "Mentions légales", href: "/mentions-legales" },
                  { label: "Politique de confidentialité", href: "/confidentialite" },
                  { label: "Conditions d'utilisation", href: "/conditions" },
                  { label: "Politique de remboursement", href: "/remboursement" },
                ].map((l) => (
                  <li key={l.label}><Link href={l.href} className="hover:text-white transition-colors">{l.label}</Link></li>
                ))}
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-white/10 flex flex-col sm:flex-row justify-between items-center gap-4 text-xs text-white/35">
            <p>© {new Date().getFullYear()} Joventy · Un service <a href="https://akollad.com" target="_blank" rel="noreferrer" className="hover:text-white/60 underline underline-offset-2">Akollad Groupe</a> · Kinshasa, RDC</p>
            <p>Paiement via M-Pesa, Airtel Money & Orange Money 🇨🇩</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
